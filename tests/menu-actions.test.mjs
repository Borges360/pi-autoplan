import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import extension from "../dist/extension.js";
import { localBus } from "../dist/common/cli.js";
import { Planner } from "../dist/plan.js";

const makeContext = async (t, expectedGroup, expectedAction, inputTitle) => {
  const testRoot = process.env.CT56_MENU_TEST_ROOT;
  assert.ok(testRoot, "isolated CT56 test root must be provided");
  const root = join(testRoot, `case-${expectedAction}`);
  const cwd = join(root, "project");
  const stateRoot = join(root, "state");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "pi-autoplan.locale.json"),
    JSON.stringify({ schemaVersion: 1, locale: "pt-BR" }),
  );
  if (expectedAction === "Validar") {
    await writeFile(
      join(cwd, "plan.json"),
      JSON.stringify({
        objective: "Validate a bounded plan",
        tasks: [
          {
            id: "one",
            objective: "Complete one bounded task",
            dependsOn: [],
            acceptance: ["The local validation command succeeds"],
          },
        ],
      }),
    );
  }

  const previousStateRoot = process.env.PI_ECOSYSTEM_STATE_ROOT;
  process.env.PI_ECOSYSTEM_STATE_ROOT = stateRoot;
  const commands = new Map();
  const handlers = new Map();
  const messages = [];
  const pi = {
    events: localBus(),
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool() {},
    sendMessage(message) {
      messages.push(message);
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools() {},
    registerMcpServer() {},
    unregisterMcpServer() {},
  };
  extension(pi);
  const command = commands.get("autoplan");
  assert.ok(command, "autoplan command is registered");
  let selection = 0;
  const ui = {
    async select(_title, options) {
      if (selection++ === 0) {
        assert.ok(options.includes(expectedGroup), `menu includes ${expectedGroup}`);
        return expectedGroup;
      }
      if (selection === 2) {
        assert.ok(options.includes(expectedAction), `group includes ${expectedAction}`);
        return expectedAction;
      }
      return undefined;
    },
    async input(title) {
      assert.equal(title, inputTitle);
      return "plan.json";
    },
  };
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    ui,
    isProjectTrusted: () => true,
    signal: undefined,
  };
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previousStateRoot === undefined) delete process.env.PI_ECOSYSTEM_STATE_ROOT;
    else process.env.PI_ECOSYSTEM_STATE_ROOT = previousStateRoot;
    await rm(root, { recursive: true, force: true });
  });
  return { command, ctx, messages };
};

test("Plan menu exposes validate and collects a localized project-relative JSON path", async (t) => {
  const planner = new Planner({});
  assert.ok(planner.menuGroups.Plan.includes("validate"));
  assert.ok(planner.menu.includes("validate"));
  assert.equal(planner.menuInputs.validate, "Validate plan: project-relative JSON file (Esc cancels)");
  const { command, ctx, messages } = await makeContext(
    t,
    "Plano",
    "Validar",
    "Arquivo JSON do plano relativo ao projeto",
  );
  await command.handler("", ctx);
  assert.deepEqual(JSON.parse(messages.at(-1).content), { valid: true });
});

test("History menu exposes explain and runs the local explanation command", async (t) => {
  const planner = new Planner({});
  assert.ok(planner.menuGroups.History.includes("explain"));
  assert.ok(planner.menu.includes("explain"));
  const { command, ctx, messages } = await makeContext(
    t,
    "Histórico",
    "Explicar",
    undefined,
  );
  await command.handler("", ctx);
  assert.deepEqual(JSON.parse(messages.at(-1).content), {
    reason: "no-assessment-yet",
  });
});
