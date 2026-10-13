import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decidePlanMode,
  validatePlan,
  shouldReplan,
  createService,
} from "../dist/plan.js";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
const tasks = [
  {
    id: "a",
    objective: "Implement",
    dependsOn: [],
    acceptance: ["Unit checks pass"],
  },
  {
    id: "b",
    objective: "Validate",
    dependsOn: ["a"],
    acceptance: ["Integration passes"],
  },
];
test("all difficulty/risk boundaries produce the required modes", () => {
  for (const [difficulty, mode] of [
    ["trivial", "none"],
    ["simple", "none"],
    ["moderate", "micro"],
    ["complex", "full"],
    ["critical", "full"],
  ]) {
    assert.equal(
      decidePlanMode({ difficulty, risks: [], confidence: 1 }).mode,
      mode,
    );
    assert.equal(
      decidePlanMode({ difficulty, risks: ["security"], confidence: 1 }).mode,
      "full",
    );
  }
  assert.equal(
    decidePlanMode({ difficulty: "simple", risks: [], confidence: 1 }, 3).mode,
    "full",
  );
});
test("DAG rejects missing dependencies, cycles, duplicate IDs, no acceptance and excessive depth", () => {
  validatePlan(tasks);
  assert.throws(() => validatePlan([...tasks, { ...tasks[0] }]), /duplicate/);
  assert.throws(
    () => validatePlan([{ ...tasks[0], dependsOn: ["a"] }]),
    /cycle/,
  );
  assert.throws(
    () => validatePlan([{ ...tasks[0], dependsOn: ["absent"] }]),
    /missing/,
  );
  assert.throws(
    () => validatePlan([{ ...tasks[0], acceptance: [] }]),
    /invalid/,
  );
  assert.throws(() => validatePlan(tasks, 1), /count/);
  assert.throws(() => validatePlan(tasks, 12, 1), /depth/);
});
test("only verified material evidence can request replan", () => {
  const e = {
    schemaVersion: 1,
    type: "verified-gate-failure",
    verified: true,
    evidenceRef: "gate-1",
  };
  assert.equal(shouldReplan(e), true);
  for (const v of [
    { ...e, type: "model-preference" },
    { ...e, verified: false },
    { ...e, evidenceRef: "" },
    { ...e, schemaVersion: 2 },
  ])
    assert.equal(shouldReplan(v), false);
});
test("revisions persist; invalid updates retain the last valid plan and replans stop at two", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const host = new Host("pi-autoplan", createService, root, localBus());
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  const planner = host.service;
  const first = await planner.update({
    objective: "Implement bounded feature",
    tasks,
  });
  await assert.rejects(
    planner.update({ objective: "Change", tasks }),
    /evidence/,
  );
  assert.equal((await planner.current()).revision, 1);
  const e = {
    schemaVersion: 1,
    type: "constraint-changed",
    verified: true,
    evidenceRef: "user-input",
  };
  await planner.update({ objective: "Change", tasks }, e);
  await planner.update({ objective: "Change again", tasks }, e);
  await assert.rejects(
    planner.update({ objective: "Churn", tasks }, e),
    /manual-review/,
  );
  await host.close();
  await host.start();
  assert.equal((await host.service.current()).id, first.id);
  assert.equal((await host.service.current()).revision, 3);
});
