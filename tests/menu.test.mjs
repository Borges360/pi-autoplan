import test from "node:test";
import assert from "node:assert/strict";
import { Planner } from "../dist/plan.js";

test("the settings menu exposes storage diagnostics", () => {
  const planner = new Planner({});
  assert.ok(planner.menuGroups.Settings.includes("storage status"));
});

test("missing-plan status tells the user how to create one", async () => {
  const planner = new Planner({});
  planner.current = async () => undefined;
  const result = await planner.command("status", [], { cwd: process.cwd() });
  assert.match(result.next, /autoplan_update|\/plan create/);
});

test("replan status explains that a request does not mutate the current plan", async () => {
  const planner = new Planner({});
  planner.requestReplan = async () => ({ requested: true, requestId: "RQ-test" });
  const result = await planner.command("replan", [], { cwd: process.cwd() });
  assert.match(result.next, /existing plan is unchanged/);
  assert.equal(result.requestId, "RQ-test");
});
