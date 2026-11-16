import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Interop, envelope } from "../dist/common/contracts.js";
import { localBus } from "../dist/common/cli.js";
import { defaults, validateConfig } from "../dist/common/config.js";
import extension from "../dist/extension.js";
const name = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(new URL("../package.json", import.meta.url), "utf8"),
)
  .name.split("/")
  .at(-1);
const displayName =
  {
    "pi-autoskills": "AutoSkills",
    "pi-autoplan": "Plan",
    "pi-subagent-router": "Subagent Router",
    "pi-mcp-router": "MCP Router",
  }[name] ?? name;
test("event bus ignores duplicates, future schemas, old events and isolates consumer failures", async () => {
  const bus = localBus();
  const a = new Interop("a", bus, "project");
  let count = 0;
  a.listen("test.v1", () => {
    count++;
  });
  const e = envelope("b", "test.v1", {}, { projectKey: "project" });
  bus.emit("test.v1", e);
  bus.emit("test.v1", e);
  bus.emit("test.v1", { ...e, eventId: "future", schemaVersion: 2 });
  bus.emit("test.v1", {
    ...e,
    eventId: "old",
    emittedAt: "2000-01-01T00:00:00Z",
  });
  assert.equal(count, 1);
  a.listen("failure.v1", async () => {
    throw new Error("offline");
  });
  bus.emit(
    "failure.v1",
    envelope("b", "failure.v1", {}, { projectKey: "project" }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(a.failures, 1);
  a.close();
});
test("capability discovery works regardless of startup order and removal", () => {
  const bus = localBus();
  const a = new Interop("a", bus, "p"),
    b = new Interop("b", bus, "p");
  a.start(["one"]);
  b.start(["two"]);
  assert.equal(a.healthy("b", "two"), true);
  assert.equal(b.healthy("a", "one"), true);
  b.close();
  a.close();
});
test("safe configuration rejects model escalation and malformed numeric values", () => {
  const c = defaults(name);
  assert.equal(c.storage.backend, "files");
  assert.throws(() => validateConfig({ ...c, assistantClaims: true }));
  assert.throws(() => validateConfig({ ...c, requireApproval: false }));
  assert.throws(() => validateConfig({ ...c, mode: "invalid" }));
  assert.throws(() => validateConfig({ ...c, maxParallel: Infinity }));
  assert.throws(() =>
    validateConfig({ ...c, compactAtRatio: 0.9, handoffAtRatio: 0.7 }),
  );
});
test("extension loads independently and all discovery commands work without TUI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-extension-test-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  await mkdir(join(root, "cwd"));
  const cwd = join(root, "cwd");
  const handlers = new Map(),
    commands = new Map(),
    tools = new Map(),
    messages = [];
  let active = ["read", "write", "mcp__untrusted__drop"];
  const pi = {
    events: localBus(),
    on: (n, f) => {
      handlers.set(n, f);
      return () => handlers.delete(n);
    },
    registerCommand: (n, d) => commands.set(n, d),
    registerTool: (t) => {
      tools.set(t.name, t);
    },
    sendMessage: (m) => messages.push(m),
    getAllTools: () => [
      { name: "read" },
      { name: "write" },
      {
        name: "mcp__untrusted__drop",
        namespace: { name: "mcp__untrusted" },
        annotations: { readOnlyHint: true },
      },
    ],
    getActiveTools: () => active,
    setActiveTools: (tools) => {
      active = tools;
    },
    registerMcpServer: () => {},
    unregisterMcpServer: () => {},
  };
  extension(pi);
  assert.equal(commands.size, name === "pi-autoplan" ? 2 : 1);
  if (name === "pi-autoplan") {
    assert.ok(commands.has("plan"));
    assert.ok(commands.has("autoplan"));
    assert.equal(
      commands.get("plan").handler,
      commands.get("autoplan").handler,
    );
  }
  assert.ok(tools.size >= 1);
  assert.equal(messages.length, 0);
  const ctx = {
    cwd,
    mode: "print",
    hasUI: false,
    ui: new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("TUI accessed headlessly");
        },
      },
    ),
    isProjectTrusted: () => false,
    getContextUsage: () => undefined,
    compact: () => {},
    signal: undefined,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => {},
    shutdown: () => {},
    getSystemPrompt: () => "",
    sessionManager: {},
    modelRegistry: {},
    model: undefined,
  };
  await handlers.get("session_start")?.({}, ctx);
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  const command = [...commands.values()][0];
  for (const action of ["status", "explain", "config", "doctor", "off", "auto"])
    await command.handler(action, ctx);
  assert.ok(messages.length >= 6);
  assert.equal(JSON.parse(messages.at(-1).content).enabled, true);
  await handlers.get("before_agent_start")?.(
    { messageType: "user", prompt: "Explain a small function" },
    ctx,
  );
  const keybindings = {
    getKeys: (binding) =>
      ({
        "tui.select.confirm": ["enter"],
        "tui.select.cancel": ["escape"],
        "tui.select.up": ["up"],
        "tui.select.down": ["down"],
      })[binding] ?? [],
    matches: (data, binding) =>
      ({
        "tui.select.confirm": "enter",
        "tui.select.cancel": "escape",
        "tui.select.up": "up",
        "tui.select.down": "down",
      })[binding] === data,
  };
  const theme = {
    fg: (_color, value) => value,
    bg: (_color, value) => value,
    bold: (value) => value,
  };
  const interactions = [];
  const inputValues = [];
  let closedPanels = 0;
  let renderRequests = 0;
  const tui = { ...ctx, mode: "tui", hasUI: true, ui: {} };
  const dashboardTui = {
    ...tui,
    ui: {
      input: async () => inputValues.shift(),
      custom: async (factory, options) => {
        assert.equal(options.overlay, true);
        const interact = interactions.shift();
        assert.equal(typeof interact, "function", "unexpected dashboard panel");
        let complete;
        const finished = new Promise((resolve) => {
          complete = resolve;
        });
        const panel = await factory(
          { requestRender: () => renderRequests++ },
          theme,
          keybindings,
          (value) => {
            closedPanels++;
            complete(value);
          },
        );
        const render = (width = 80) => panel.render(width).join("\n");
        await interact({ panel, render });
        return await finished;
      },
    },
  };
  const cellWidth = (value) => {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    return Array.from(segmenter.segment(value), ({ segment }) => {
      const points = Array.from(segment, (character) =>
        character.codePointAt(0) ?? 0,
      );
      if (
        points.some(
          (point) =>
            point === 0x200d ||
            point === 0xfe0f ||
            (point >= 0x1f1e6 && point <= 0x1f1ff) ||
            (point >= 0x1f000 && point <= 0x1faff),
        )
      )
        return 2;
      let width = 0;
      for (const point of points) {
        const character = String.fromCodePoint(point);
        if (/\p{Mark}/u.test(character) || point === 0x200d) continue;
        const wide =
          point >= 0x1100 &&
          (point <= 0x115f ||
            point === 0x2329 ||
            point === 0x232a ||
            (point >= 0x2e80 && point <= 0xa4cf) ||
            (point >= 0xac00 && point <= 0xd7a3) ||
            (point >= 0xf900 && point <= 0xfaff) ||
            (point >= 0xfe10 && point <= 0xfe19) ||
            (point >= 0xfe30 && point <= 0xfe6f) ||
            (point >= 0xff00 && point <= 0xff60) ||
            (point >= 0xffe0 && point <= 0xffe6) ||
            (point >= 0x20000 && point <= 0x3fffd));
        width = Math.max(width, wide ? 2 : 1);
      }
      return width;
    }).reduce((total, width) => total + width, 0);
  };
  const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(message);
  };
  const configPath = join(defaults(name).storage.root, "config.json");

  interactions.push(async ({ panel, render }) => {
    for (const width of [40, 80, 120]) {
      const lines = panel.render(width);
      assert.ok(lines.every((line) => cellWidth(line) === width));
    }
    assert.match(render(), new RegExp(displayName));
    assert.match(render(), /Current mode: Automatic/);
    assert.match(render(), /Groups/);
    assert.match(render(), /› Plan/);

    await panel.handleInput("enter");
    assert.match(render(), /status/i);
    assert.match(render(), /show/i);
    assert.match(render(), /create/i);
    assert.match(render(), /replan/i);
    await panel.handleInput("escape");

    await panel.handleInput("down");
    await panel.handleInput("enter");
    assert.match(render(), /history/i);
    await panel.handleInput("escape");

    await panel.handleInput("down");
    await panel.handleInput("enter");
    assert.match(render(), /mode/i);
    assert.match(render(), /doctor/i);
    await panel.handleInput("enter");
    assert.match(render(), /Current mode: Automatic/);
    assert.match(render(), /Draft mode: Automatic/);
    await panel.handleInput("down");
    await panel.handleInput("enter");
    assert.match(render(), /Draft mode: Observe/);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).mode, "auto");

    await panel.handleInput("escape");
    assert.match(render(), /Press Esc again to discard/);
    await panel.handleInput("escape");
    assert.match(render(), /Draft discarded/);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).mode, "auto");
    await panel.handleInput("escape");
    await panel.handleInput("escape");
  });
  await command.handler("", dashboardTui);

  interactions.push(async ({ panel, render }) => {
    await panel.handleInput("down");
    await panel.handleInput("down");
    await panel.handleInput("enter");
    await panel.handleInput("enter");
    await panel.handleInput("down");
    await panel.handleInput("enter");
    assert.match(render(), /Draft mode: Observe/);
    const savedBefore = await readFile(configPath, "utf8");
    assert.equal(JSON.parse(savedBefore).mode, "auto");

    await rm(configPath, { force: true });
    await mkdir(configPath);
    await panel.handleInput("\u0013");
    await waitFor(
      () => render().includes("Could not save the mode"),
      "mode save failure should be shown without losing the draft",
    );
    assert.match(render(), /Current mode: Automatic/);
    assert.match(render(), /Draft mode: Observe/);

    await rm(configPath, { recursive: true, force: true });
    await writeFile(configPath, savedBefore);
    await panel.handleInput("\u0013");
    await waitFor(
      () => render().includes("Saved mode: Observe"),
      "Ctrl+S should persist a valid mode draft",
    );
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.mode, "observe");
    assert.equal(saved.enabled, true);
    await panel.handleInput("escape");
    await panel.handleInput("escape");
    await panel.handleInput("escape");
  });
  await command.handler("", dashboardTui);

  inputValues.push("计划-🙂.json");
  interactions.push(async ({ panel }) => {
    await panel.handleInput("enter");
    await panel.handleInput("down");
    await panel.handleInput("down");
    await panel.handleInput("down");
    await panel.handleInput("enter");
  });
  interactions.push(async ({ panel, render }) => {
    assert.match(render(), /Running create 计划-🙂\.json/i);
    for (const width of [40, 80, 120]) {
      const lines = panel.render(width);
      assert.ok(lines.every((line) => cellWidth(line) === width));
    }
    const activation = panel.handleInput("enter");
    await panel.handleInput("escape");
    await activation;
    await waitFor(
      () => render().includes("Cancelled. The menu is ready."),
      "Esc should cancel the pending action and leave the menu usable",
    );
    await panel.handleInput("escape");
    await panel.handleInput("escape");
  });
  const messagesBeforeCancelledAction = messages.length;
  await command.handler("", dashboardTui);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, messagesBeforeCancelledAction);

  inputValues.push("missing-plan.json");
  interactions.push(async ({ panel }) => {
    await panel.handleInput("enter");
    await panel.handleInput("down");
    await panel.handleInput("down");
    await panel.handleInput("down");
    await panel.handleInput("enter");
  });
  interactions.push(async ({ panel, render }) => {
    await waitFor(
      () => render().includes("Plan file not found"),
      "a missing plan should explain the cause and leave the menu usable",
    );
    assert.match(render(), /Create/);
    assert.match(render(), /project-relative path/);
    await panel.handleInput("escape");
    await panel.handleInput("escape");
  });
  const messagesBeforeMissingPlan = messages.length;
  await command.handler("", dashboardTui);
  assert.equal(messages.length, messagesBeforeMissingPlan);

  const lateAbort = new AbortController();
  inputValues.push("late-遅延-🙂.json");
  interactions.push(async ({ panel }) => {
    await panel.handleInput("enter");
    await panel.handleInput("down");
    await panel.handleInput("down");
    await panel.handleInput("down");
    await panel.handleInput("enter");
  });
  interactions.push(async ({ render }) => {
    assert.match(render(), /Running create late-遅延-🙂\.json/i);
    lateAbort.abort();
  });
  const messagesBeforeLateCallback = messages.length;
  await command.handler("", { ...dashboardTui, signal: lateAbort.signal });
  for (let attempt = 0; attempt < 100; attempt++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, messagesBeforeLateCallback);

  if (name === "pi-autoplan") {
    await command.handler("auto", ctx);
    const localeTui = { ...dashboardTui, isProjectTrusted: () => true };
    const projectLocalePath = join(cwd, ".pi", "pi-autoplan.locale.json");
    interactions.push(async ({ panel, render }) => {
      assert.match(render(), /Current mode: Automatic/);
      assert.match(render(), /Groups/);
      for (const width of [40, 80, 120])
        assert.ok(panel.render(width).every((line) => cellWidth(line) === width));
      await panel.handleInput("down");
      await panel.handleInput("down");
      await panel.handleInput("enter");
      assert.match(render(), /Language/);
      assert.match(render(), /Doctor/);
      await panel.handleInput("down");
      await panel.handleInput("down");
      await panel.handleInput("down");
      await panel.handleInput("enter");
      assert.match(render(), /Current language: English/);
      assert.match(render(), /Português \(Brasil\)/);
      await panel.handleInput("down");
      await panel.handleInput("enter");
      assert.match(render(), /Idioma atual: Inglês/);
      assert.match(render(), /Rascunho do idioma: Português \(Brasil\)/);
      assert.equal(await readFile(projectLocalePath, "utf8").catch(() => null), null);
      for (const width of [40, 80, 120])
        assert.ok(panel.render(width).every((line) => cellWidth(line) === width));
      await panel.handleInput("ctrl+s");
      await waitFor(() => render().includes("Idioma salvo."), "Ctrl+S saves the trusted project language");
      assert.deepEqual(JSON.parse(await readFile(projectLocalePath, "utf8")), {
        locale: "pt-BR",
        schemaVersion: 1,
      });
      await panel.handleInput("escape");
      assert.match(render(), /Diagnóstico/);
      assert.match(render(), /Idioma/);
      await panel.handleInput("up");
      await panel.handleInput("up");
      await panel.handleInput("up");
      await panel.handleInput("enter");
      assert.match(render(), /Modo atual: Automático/);
      assert.match(render(), /Observar/);
      assert.match(render(), /Desativado/);
      assert.doesNotMatch(render(), /Current mode:|Automatic/);
      await panel.handleInput("escape");
      await panel.handleInput("escape");
      await panel.handleInput("escape");
    });
    await command.handler("", localeTui);

    await writeFile(join(cwd, "broken-plan.json"), "{ invalid json", "utf8");
    inputValues.push("broken-plan.json");
    interactions.push(async ({ panel }) => {
      await panel.handleInput("enter");
      await panel.handleInput("down");
      await panel.handleInput("down");
      await panel.handleInput("down");
      await panel.handleInput("enter");
    });
    interactions.push(async ({ panel, render }) => {
      await waitFor(
        () => render().includes("O arquivo do plano não é um JSON válido"),
        "an invalid plan should show a localized safe error and leave the menu usable",
      );
      assert.match(render(), /Criar/);
      assert.doesNotMatch(render(), /SyntaxError|broken-plan\.json/);
      await panel.handleInput("escape");
      await panel.handleInput("escape");
    });
    const messagesBeforeInvalidPlan = messages.length;
    await command.handler("", localeTui);
    assert.equal(messages.length, messagesBeforeInvalidPlan);

    interactions.push(async ({ panel, render }) => {
      assert.match(render(), /Modo atual: Automático/);
      assert.match(render(), /Grupos/);
      assert.match(render(), /Plano/);
      await panel.handleInput("down");
      await panel.handleInput("down");
      await panel.handleInput("enter");
      await panel.handleInput("down");
      await panel.handleInput("down");
      await panel.handleInput("down");
      await panel.handleInput("enter");
      assert.match(render(), /Idioma atual: Português \(Brasil\)/);
      await panel.handleInput("up");
      await panel.handleInput("enter");
      assert.match(render(), /Current language: Português \(Brasil\)/);
      assert.match(render(), /Draft language: English/);
      await panel.handleInput("escape");
      assert.match(render(), /Unsaved draft/);
      await panel.handleInput("escape");
      assert.match(render(), /Idioma/);
      assert.deepEqual(JSON.parse(await readFile(projectLocalePath, "utf8")), {
        locale: "pt-BR",
        schemaVersion: 1,
      });
      await panel.handleInput("escape");
      await panel.handleInput("escape");
    });
    await command.handler("", localeTui);
  }

  assert.ok(closedPanels >= 4);
  assert.ok(renderRequests > 0);
  const priorMessages = messages.length;
  await command.handler("", { ...tui, ui: { select: async () => undefined } });
  assert.equal(messages.length, priorMessages);
});
