import { Type } from "typebox";
import { register, toolResult } from "./common/runtime.js";
import { createService, PlanInputSchema, } from "./plan.js";
export default function (pi) {
    const runtime = register(pi, "pi-autoplan", "autoplan", createService);
    pi.registerTool({
        name: "autoplan_update",
        label: "Update plan",
        description: "Create a valid bounded DAG; revisions require previously recorded material evidence.",
        parameters: Type.Object({
            plan: PlanInputSchema,
            evidenceId: Type.Optional(Type.String()),
        }),
        execute: async (_id, input, _signal, _update, ctx) => {
            const h = await runtime.get(ctx);
            return h.serial(async () => {
                const evidence = input.evidenceId
                    ? await h.store.getRecord("replan-requests", input.evidenceId)
                    : null;
                return toolResult(await h.service.update(input.plan, evidence?.evidence));
            });
        },
    });
}
