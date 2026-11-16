import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../dist/extension.js";
import { localBus } from "../dist/common/cli.js";

test("a rejected fallback-menu action reports the error and leaves the menu usable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "autoplan-fallback-error-"));
  const previousState = process.env.PI_ECOSYSTEM_STATE_ROOT;
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const handlers = new Map();
  const commands = new Map();
  const messages = [];
  const notices = [];
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
  };
  extension(pi);
  const selected = [];
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    signal: undefined,
    ui: {
      async select(_title, options) {
        selected.push([...options]);
        if (selected.length === 1)
          return options.find((value) => value === "Plan" || value === "Plano");
        if (selected.length === 2)
          return options.find((value) => /^(create|criar)$/i.test(value));
        return undefined;
      },
      async input() {
        return "missing-plan.json";
      },
      notify(message) {
        notices.push(message);
      },
    },
  };
  t.after(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previousState === undefined) delete process.env.PI_ECOSYSTEM_STATE_ROOT;
    else process.env.PI_ECOSYSTEM_STATE_ROOT = previousState;
    await rm(root, { recursive: true, force: true });
  });

  await commands.get("autoplan").handler("", ctx);

  assert.equal(selected.length, 4, "the menu was shown again after the rejected action");
  assert.equal(messages.length, 1);
  const result = JSON.parse(messages[0].content);
  assert.match(result.error, /Plan file not found/i);
  assert.doesNotMatch(result.error, /ENOENT|missing-plan\.json/i);
  assert.match(result.next, /menu is ready/i);
  assert.match(notices[0], /Plan file not found/i);
});
