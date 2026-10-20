import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { assess, } from "./common/contracts.js";
import { put, append } from "./common/storage.js";
import { id, now, digest, contained } from "./common/security.js";
export const PlanInputSchema = Type.Object({
    objective: Type.String({ minLength: 1, maxLength: 12000 }),
    tasks: Type.Array(Type.Object({
        id: Type.String(),
        objective: Type.String({ minLength: 1 }),
        dependsOn: Type.Array(Type.String()),
        acceptance: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        scope: Type.Optional(Type.Array(Type.String())),
    }), { minItems: 1, maxItems: 30 }),
});
export function decidePlanMode(s, dependencies = 0, multiSubsystem = false) {
    const mode = s.risks.length ||
        ["critical", "complex"].includes(s.difficulty) ||
        dependencies > 2 ||
        multiSubsystem
        ? "full"
        : s.difficulty === "moderate"
            ? "micro"
            : "none";
    return {
        schemaVersion: 1,
        mode,
        reasons: [
            s.risks.length ? "risk-floor" : s.difficulty,
            ...(dependencies > 2 ? ["dependency-count"] : []),
        ],
        source: "rules",
    };
}
export function validatePlan(tasks, maxTasks = 12, maxDepth = 6) {
    if (!tasks.length || tasks.length > maxTasks)
        throw new Error("task-count-limit");
    const byId = new Map(tasks.map((t) => [t.id, t]));
    if (byId.size !== tasks.length)
        throw new Error("duplicate-task-id");
    for (const task of tasks) {
        if (!/^[a-zA-Z0-9_-]+$/.test(task.id) ||
            !task.objective?.trim() ||
            !Array.isArray(task.acceptance) ||
            !task.acceptance.length ||
            task.acceptance.some((a) => typeof a !== "string" || !a.trim()) ||
            !Array.isArray(task.dependsOn))
            throw new Error("invalid-task");
        if (new Set(task.dependsOn).size !== task.dependsOn.length)
            throw new Error("duplicate-dependency");
        for (const dep of task.dependsOn)
            if (!byId.has(dep))
                throw new Error("missing-dependency");
    }
    const visiting = new Set();
    const depth = new Map();
    function visit(key) {
        if (visiting.has(key))
            throw new Error("dependency-cycle");
        if (depth.has(key))
            return depth.get(key);
        visiting.add(key);
        const value = 1 + Math.max(0, ...byId.get(key).dependsOn.map(visit));
        visiting.delete(key);
        if (value > maxDepth)
            throw new Error("dependency-depth-limit");
        depth.set(key, value);
        return value;
    }
    for (const task of tasks)
        visit(task.id);
}
export function shouldReplan(e) {
    return (e.schemaVersion === 1 &&
        e.verified === true &&
        !!e.evidenceRef &&
        [
            "verified-gate-failure",
            "dependency-missing",
            "scope-expanded",
            "constraint-changed",
            "goal-changed",
            "task-blocked",
        ].includes(e.type));
}
export class Planner {
    host;
    modeDescriptions = {
        auto: "Create bounded plans for eligible tasks.",
        observe: "Show planning decisions without applying a plan.",
        off: "Disable automatic planning.",
    };
    menuGroups = {
        Plan: ["status", "show", "create", "validate", "replan"],
        History: ["history", "explain"],
        Settings: ["config", "doctor", "storage status"],
    };
    menuInputs = {
        create: "Create plan: project-relative JSON file (Esc cancels)",
        validate: "Validate plan: project-relative JSON file (Esc cancels)",
    };
    capabilities = ["plan.adaptive.v1", "plan.dag.v1"];
    menu = ["status", "show", "history", "create", "replan", "explain"];
    decision;
    constructor(host) {
        this.host = host;
    }
    async start() {
        this.host.interop.listen("pi.gate.result.v1", async (e) => {
            const p = e.payload;
            if (p.evaluated === true &&
                p.rejected === true &&
                typeof p.evidenceRef === "string")
                await this.requestReplan({
                    schemaVersion: 1,
                    type: "verified-gate-failure",
                    verified: true,
                    evidenceRef: p.evidenceRef,
                });
        });
    }
    async current() {
        const ref = await this.host.store.getRecord("current", "plan");
        return ref
            ? this.host.store.getRecord("plans", ref.id)
            : null;
    }
    async update(input, evidence) {
        validatePlan(input.tasks, this.host.config.maxInitialTasks, this.host.config.maxDependencyDepth);
        const current = await this.current();
        if (current) {
            if (!evidence || !shouldReplan(evidence))
                throw new Error("material-evidence-required");
            if (current.replans >= this.host.config.maxReplans)
                throw new Error("manual-review-required");
        }
        const decision = this.decision ?? decidePlanMode(assess(input.objective));
        const plan = {
            schemaVersion: 1,
            id: current?.id ?? id(),
            objective: input.objective,
            revision: (current?.revision ?? 0) + 1,
            tasks: input.tasks,
            createdAt: current?.createdAt ?? now(),
            updatedAt: now(),
            replans: (current?.replans ?? -1) + 1,
            status: "active",
            decision,
        };
        await this.host.store.transact((s) => {
            const actual = s.records.plans?.[plan.id]?.value;
            if ((actual?.revision ?? 0) !== (current?.revision ?? 0))
                throw new Error("plan-revision-conflict");
            if (evidence?.requestId) {
                const request = s.records["replan-requests"]?.[evidence.requestId]
                    ?.value;
                if (!request ||
                    request.planId !== plan.id ||
                    request.revision !== current?.revision ||
                    request.consumed)
                    throw new Error("stale-replan-evidence");
                put(s, "replan-requests", evidence.requestId, {
                    ...request,
                    consumed: true,
                });
            }
            put(s, "plans", plan.id, plan);
            put(s, "revisions", plan.id + "-" + plan.revision, plan);
            put(s, "current", "plan", { id: plan.id });
            append(s, {
                schemaVersion: 1,
                eventId: id(),
                eventType: "plan.updated",
                emittedAt: now(),
                payload: { planId: plan.id, revision: plan.revision, evidence },
            });
        });
        this.host.interop.emit("pi.plan.updated.v1", { planId: plan.id, revision: plan.revision, tasks: plan.tasks, evidence }, { correlationId: plan.id });
        return plan;
    }
    async requestReplan(evidence) {
        if (!shouldReplan(evidence))
            throw new Error("invalid-replan-evidence");
        const plan = await this.current();
        if (!plan)
            return { requested: false, reason: "no-plan" };
        if (plan.replans >= this.host.config.maxReplans)
            return { requested: false, reason: "manual-review-required" };
        const requestId = id();
        const recorded = { ...evidence, requestId };
        await this.host.store.putRecord("replan-requests", requestId, {
            planId: plan.id,
            revision: plan.revision,
            consumed: false,
            evidence: recorded,
            createdAt: now(),
        });
        return { requested: true, requestId, evidence: recorded };
    }
    async prompt(prompt) {
        const local = assess(prompt);
        const cached = this.host.interop.assessments.get(digest(prompt));
        const assessment = cached
            ? { ...cached, risks: [...new Set([...cached.risks, ...local.risks])] }
            : local;
        this.decision = decidePlanMode(assessment);
        if (cached)
            this.decision.source = "assessment";
        const current = await this.current();
        const requests = current
            ? (await this.host.store.listRecords("replan-requests")).filter((request) => request.planId === current.id &&
                request.revision === current.revision &&
                !request.consumed)
            : [];
        await this.host.store.putRecord("decisions", id(), {
            ...this.decision,
            createdAt: now(),
        });
        if (this.decision.mode === "none")
            return undefined;
        return this.decision.mode === "micro"
            ? {
                planning: "micro",
                instruction: "Use a short checklist with objective acceptance checks; do not create a workflow engine.",
            }
            : {
                planning: "full",
                current: current
                    ? {
                        id: current.id,
                        revision: current.revision,
                        tasks: current.tasks,
                    }
                    : null,
                instruction: "Create a bounded execution DAG with autoplan_update before substantial implementation.",
                maxTasks: this.host.config.maxInitialTasks,
                replanRequests: requests.map((request) => request.evidence),
            };
    }
    async command(action, args, context) {
        if (action === "status" || action === "show") {
            const plan = await this.current();
            return {
                decision: this.decision,
                plan,
                ...(!plan
                    ? {
                        next: "No plan yet. Use autoplan_update or /autoplan create <plan.json>.",
                    }
                    : {}),
            };
        }
        if (action === "explain")
            return this.decision ?? { reason: "no-assessment-yet" };
        if (action === "history")
            return this.host.store.listRecords("revisions");
        if (action === "validate") {
            if (!args[0])
                throw new Error("plan-file-required");
            const input = JSON.parse(await readFile(await contained(context.cwd, args[0]), "utf8"));
            validatePlan(input.tasks, this.host.config.maxInitialTasks, this.host.config.maxDependencyDepth);
            return { valid: true };
        }
        if (action === "create") {
            if (!args[0])
                return { instruction: "Use autoplan_update or create <plan.json>" };
            const input = JSON.parse(await readFile(await contained(context.cwd, args[0]), "utf8"));
            return this.update(input);
        }
        if (action === "replan") {
            const evidence = {
                schemaVersion: 1,
                type: "goal-changed",
                verified: true,
                evidenceRef: "user-" + id(),
            };
            if (!args.length) {
                const request = await this.requestReplan(evidence);
                return {
                    ...request,
                    next: request.requested
                        ? "Replan request recorded. The current Pi model can apply a revision with autoplan_update and this requestId; the existing plan is unchanged until then."
                        : "Create a plan first, or review the replan limit shown in reason.",
                };
            }
            const input = JSON.parse(await readFile(await contained(context.cwd, args[0]), "utf8"));
            return this.update(input, evidence);
        }
        throw new Error("unknown-command:" + action);
    }
}
export const createService = (host) => new Planner(host);
