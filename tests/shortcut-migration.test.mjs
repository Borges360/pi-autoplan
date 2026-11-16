import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyShortcutMigration,
  freeThinkingShortcuts,
  planShortcutIsFree,
  readShortcutMigration,
  restoreShortcutMigration,
} from "../dist/common/shortcut-migration.js";
import { Planner } from "../dist/plan.js";

async function withAgentDir(t, fn) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-autoplan-shortcut-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  return fn(agentDir);
}

test("candidate shortcuts exclude effective Pi bindings and configured extension bindings", () => {
  const effective = {
    "app.thinking.cycle": "shift+tab",
    "app.model.cycleForward": "ctrl+alt+shift+p",
    "custom.extension.shortcut": "ctrl+alt+shift+g",
  };
  const free = freeThinkingShortcuts(effective, {
    "custom.from.config": ["ctrl+alt+shift+t"],
  });
  assert.deepEqual(free, [
    "ctrl+alt+shift+m",
    "ctrl+alt+shift+r",
    "ctrl+alt+shift+1",
    "ctrl+alt+shift+2",
    "ctrl+alt+shift+3",
  ]);
});

test("setup previews can be cancelled without changing the Pi config", async (t) => {
  await withAgentDir(t, async (agentDir) => {
    const file = join(agentDir, "keybindings.json");
    const initial = JSON.stringify({ "app.thinking.cycle": "shift+tab" }, null, 2);
    await writeFile(file, initial);
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    });
    const effectiveBindings = {
      "app.thinking.cycle": "shift+tab",
      "app.model.cycleForward": "ctrl+p",
    };
    let preview = "";
    const ui = {
      custom: async (factory) => {
        let finish;
        const result = new Promise((resolve) => (finish = resolve));
        const component = factory(
          { requestRender() {} },
          { fg: (_color, value) => value, bold: (value) => value },
          { getEffectiveConfig: () => effectiveBindings },
          finish,
        );
        component.handleInput("\r");
        return result;
      },
      confirm: async (_title, message) => {
        preview = message;
        return false;
      },
      notify() {},
    };
    const planner = new Planner({});
    const result = await planner.command("shortcut", [], {
      cwd: agentDir,
      trusted: false,
      locale: "en",
      hostContext: {
        hasUI: true,
        mode: "tui",
        signal: new AbortController().signal,
        ui,
      },
    });
    assert.equal(result.reason, "cancelled");
    assert.match(preview, /Current thinking shortcut: shift\+tab/);
    assert.match(preview, /New thinking shortcut:/);
    assert.match(preview, /SHIFT\+TAB will toggle Plan mode/);
    assert.equal(await readFile(file, "utf8"), initial);
    assert.equal(await readShortcutMigration(agentDir), undefined);
  });
});

test("setup writes only the thinking binding and restore preserves later unrelated edits", async (t) => {
  await withAgentDir(t, async (agentDir) => {
    const file = join(agentDir, "keybindings.json");
    const initial = {
      "app.thinking.cycle": ["shift+tab", "alt+p"],
      "app.model.cycleForward": "ctrl+p",
      "custom.extension.action": "ctrl+alt+shift+g",
    };
    const raw = JSON.stringify(initial, null, 2);
    await writeFile(file, raw);
    const migration = await applyShortcutMigration({
      agentDir,
      shortcut: "ctrl+alt+shift+t",
      effectiveBindings: {
        ...initial,
        "app.select.confirm": "enter",
      },
      expectedRaw: raw,
    });
    assert.equal(migration.status, "active");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      ...initial,
      "app.thinking.cycle": "ctrl+alt+shift+t",
    });
    assert.equal((await readShortcutMigration(agentDir)).written, "ctrl+alt+shift+t");

    const later = JSON.parse(await readFile(file, "utf8"));
    later["custom.added.later"] = "ctrl+k";
    await writeFile(file, JSON.stringify(later, null, 2));
    assert.deepEqual(await restoreShortcutMigration(agentDir), { restored: true });
    const restored = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(restored["app.thinking.cycle"], initial["app.thinking.cycle"]);
    assert.equal(restored["custom.added.later"], "ctrl+k");
    assert.equal(await readShortcutMigration(agentDir), undefined);
  });
});

test("restore leaves a thinking binding changed after setup untouched", async (t) => {
  await withAgentDir(t, async (agentDir) => {
    const file = join(agentDir, "keybindings.json");
    const raw = JSON.stringify({ "app.thinking.cycle": "shift+tab" });
    await writeFile(file, raw);
    await applyShortcutMigration({
      agentDir,
      shortcut: "ctrl+alt+shift+p",
      effectiveBindings: {
        "app.thinking.cycle": "shift+tab",
        "app.model.cycleForward": "ctrl+p",
      },
      expectedRaw: raw,
    });
    const userEdit = {
      "app.thinking.cycle": "alt+enter",
      "app.model.cycleForward": "ctrl+p",
    };
    await writeFile(file, JSON.stringify(userEdit, null, 2));
    assert.deepEqual(await restoreShortcutMigration(agentDir), {
      restored: false,
      reason: "pi-thinking-binding-changed",
    });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), userEdit);
    assert.ok(await readShortcutMigration(agentDir));
  });
});

test("restore removes a keybindings file that the migration created from scratch", async (t) => {
  await withAgentDir(t, async (agentDir) => {
    const file = join(agentDir, "keybindings.json");
    await applyShortcutMigration({
      agentDir,
      shortcut: "ctrl+alt+shift+p",
      effectiveBindings: { "app.thinking.cycle": "shift+tab" },
      expectedRaw: null,
    });
    assert.equal(planShortcutIsFree(agentDir), true);
    assert.deepEqual(await restoreShortcutMigration(agentDir), { restored: true });
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.equal(planShortcutIsFree(agentDir), false);
  });
});

test("Shift+Tab only registers when the current thinking binding has released it", async (t) => {
  await withAgentDir(t, async (agentDir) => {
    assert.equal(planShortcutIsFree(agentDir), false);
    const file = join(agentDir, "keybindings.json");
    await writeFile(file, JSON.stringify({ "app.thinking.cycle": "ctrl+alt+shift+p" }));
    assert.equal(planShortcutIsFree(agentDir), true);
    await writeFile(file, JSON.stringify({ "app.thinking.cycle": ["shift+tab", "ctrl+alt+shift+p"] }));
    assert.equal(planShortcutIsFree(agentDir), false);
    await writeFile(file, "not json");
    assert.equal(planShortcutIsFree(agentDir), false);
  });
});
