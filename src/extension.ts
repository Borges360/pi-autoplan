import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { register, toolResult } from "./common/runtime.js";
import {
  createService,
  PlanInputSchema,
  Planner,
  type ReplanEvidence,
} from "./plan.js";
import { planShortcutIsFree } from "./common/shortcut-migration.js";
export default function (pi: ExtensionAPI) {
  const runtime = register(
    pi,
    "pi-autoplan",
    "plan",
    createService,
    [],
    ["autoplan"],
  );
  pi.registerTool({
    name: "autoplan_update",
    label: "Update plan",
    description:
      "Create a valid bounded DAG; revisions require previously recorded material evidence.",
    parameters: Type.Object({
      plan: PlanInputSchema,
      evidenceId: Type.Optional(Type.String()),
    }),
    execute: async (_id, input, _signal, _update, ctx) => {
      const h = await runtime.get(ctx);
      return h.serial(async () => {
        const evidence = input.evidenceId
          ? await h.store.getRecord<{ evidence: ReplanEvidence }>(
              "replan-requests",
              input.evidenceId,
            )
          : null;
        return toolResult(
          await (h.service as Planner).update(input.plan, evidence?.evidence),
        );
      });
    },
  });

  // Shift+Tab is reserved by Pi for app.thinking.cycle. Only claim it after
  // the user has moved that binding in keybindings.json and restarted Pi.
  if (planShortcutIsFree(getAgentDir())) {
    pi.registerShortcut("shift+tab", {
      description: "Toggle Normal and Plan mode",
      handler: async (ctx) => {
        const h = await runtime.get(ctx);
        await h.serial(() =>
          h.command("plan-mode", [], {
            cwd: ctx.cwd,
            trusted: ctx.isProjectTrusted(),
            hostContext: ctx,
            signal: ctx.signal,
          }),
        );
      },
    });
  }
}
