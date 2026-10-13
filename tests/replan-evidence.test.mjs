import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Host } from "../dist/common/runtime.js";
import { localBus } from "../dist/common/cli.js";
import { createService } from "../dist/plan.js";
import { digest } from "../dist/common/security.js";
test("material replan evidence is discoverable, revision-scoped and consumed once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-replan-proof-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const host = new Host("pi-autoplan", createService, root, localBus());
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  const input = {
    objective: "Implement bounded plan",
    tasks: [
      {
        id: "one",
        objective: "Implement",
        dependsOn: [],
        acceptance: ["Oracle passes"],
      },
    ],
  };
  await host.service.update(input);
  const request = await host.service.requestReplan({
    schemaVersion: 1,
    type: "constraint-changed",
    verified: true,
    evidenceRef: "user-change",
  });
  assert.ok(request.requestId);
  const prompt = await host.service.prompt("Implement a database migration");
  assert.equal(prompt.replanRequests[0].requestId, request.requestId);
  await host.service.update(input, request.evidence);
  await assert.rejects(
    host.service.update(input, request.evidence),
    /stale-replan/,
  );
  assert.equal((await host.service.current()).revision, 2);
});
test("optional classification cannot remove locally detected risk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plan-risk-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  const host = new Host("pi-autoplan", createService, root, localBus());
  await host.start();
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  const text = "Change production database security";
  host.interop.assessments.set(digest(text), {
    difficulty: "trivial",
    risks: [],
    confidence: 1,
  });
  assert.equal((await host.service.prompt(text)).planning, "full");
});
