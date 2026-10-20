import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../dist/extension.js";
import { localBus } from "../dist/common/cli.js";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";

test("every menu action shows a focused result; errors, empty state, cancellation and back navigation remain usable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autoplan-menu-"));
  const previous = process.env.PI_ECOSYSTEM_STATE_ROOT;
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const handlers = new Map(),
    commands = new Map(),
    messages = [],
    panels = [];
  extension({
    events: localBus(),
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, spec) => commands.set(name, spec),
    registerTool() {},
    sendMessage: (value) => messages.push(value),
  });
  t.after(async () => {
    await handlers.get("session_shutdown")({}, ctx);
    if (previous === undefined) delete process.env.PI_ECOSYSTEM_STATE_ROOT;
    else process.env.PI_ECOSYSTEM_STATE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    join(root, "valid plan.json"),
    JSON.stringify({
      objective: "Fix menu 中文 🐱",
      tasks: [
        {
          id: "fix",
          objective: "Fix menu",
          dependsOn: [],
          acceptance: ["Result remains visible"],
        },
      ],
    }),
  );
  await writeFile(join(root, "broken.json"), "{invalid json");
  const choices = [
    "Plan",
    "status",
    "show",
    "replan",
    "create",
    "create",
    "create",
    "validate",
    "validate",
    "show",
    "replan",
    undefined,
    "History",
    "history",
    "explain",
    undefined,
    "Settings",
    "doctor",
    "storage status",
    undefined,
    undefined,
  ];
  const inputs = [
    undefined,
    "broken.json",
    "valid plan.json",
    "missing.json",
    "valid plan.json",
  ];
  let open = false;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      select: async (_title, options) => {
        assert.equal(open, false, "next selector cannot cover the result");
        assert.ok(choices.length, "unexpected selector");
        const choice = choices.shift();
        if (choice) assert.ok(options.includes(choice));
        return choice;
      },
      input: async () => {
        assert.ok(inputs.length);
        return inputs.shift();
      },
      custom: async (factory) => {
        open = true;
        let closed = false;
        const component = await factory(
          { terminal: { rows: 16 }, requestRender() {} },
          { fg: (_, s) => s },
          keys,
          () => {
            closed = true;
          },
        );
        const render = () => {
          const lines = component.render(64);
          assert.ok(
            lines.every((line) => visibleWidth(line) <= 64),
            "Unicode fits terminal columns",
          );
          return lines.join("\n");
        };
        const first = render();
        assert.match(first, /AutoPlan \/ /);
        assert.match(first, /Enter \/ Esc Back/);
        await component.handleInput("\x1b[B");
        render();
        await component.handleInput("\x1b[A");
        assert.equal(render(), first);
        for (let i = 0; i < 100; i++) await component.handleInput("\x1b[B");
        assert.match(render(), /Back/);
        await component.handleInput(panels.length % 2 ? "\x1b" : "\r");
        assert.equal(closed, true);
        panels.push(first);
        open = false;
      },
    },
  };
  await commands.get("autoplan").handler("", ctx);
  assert.equal(choices.length, 0);
  assert.equal(inputs.length, 0);
  const results = messages.map((m) => JSON.parse(m.content));
  assert.equal(results.length, 13);
  assert.match(results[0].next, /No plan yet/);
  assert.equal(results[2].reason, "no-plan");
  assert.ok(
    results[3].error,
    "malformed file is a visible error and menu continues",
  );
  assert.equal(results[4].revision, 1);
  assert.match(results[5].error, /ENOENT/);
  assert.equal(results[6].valid, true);
  assert.equal(results[7].plan.revision, 1, "bad input kept the valid plan");
  assert.equal(results[8].requested, true);
  assert.equal(results[9].length, 1, "history contains creation");
  assert.equal(results[11].standalone, true);
  assert.equal(results[12].backend, "FileStorage");
  assert.equal(panels.length, results.length);
});
