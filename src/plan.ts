import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import type {
  ExtensionContext,
  InputEvent,
  InputEventResult,
  MessageEndEvent,
  MessageEndEventResult,
  ModelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getAgentDir,
  getMarkdownTheme,
  getSelectListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Markdown,
  SelectList,
  Text,
  matchesKey,
} from "@earendil-works/pi-tui";
import {
  assess,
  type Assessment,
  type PiExtensionEventV1,
} from "./common/contracts.js";
import type {
  Host,
  Service,
  CommandContext,
} from "./common/runtime.js";
import { translate, type Locale } from "./common/i18n.js";
import { put, append } from "./common/storage.js";
import { id, now, digest, contained, bound } from "./common/security.js";
import {
  applyShortcutMigration,
  effectiveThinkingBinding,
  freeThinkingShortcuts,
  keybindingKeys,
  keybindingLabel,
  planShortcutIsFree,
  readKeybindingsDocument,
  readShortcutMigration,
  restoreShortcutMigration,
  shortcutMigrationPreview,
  type Keybindings,
} from "./common/shortcut-migration.js";
export type PlanMode = "none" | "micro" | "full";
export interface PlanDecision {
  schemaVersion: 1;
  mode: PlanMode;
  reasons: string[];
  source: "rules" | "assessment" | "manual";
}
export interface PlanTask {
  id: string;
  objective: string;
  dependsOn: string[];
  acceptance: string[];
  scope?: string[];
}
export interface PlanProposalCriterion {
  behavior: string;
  verification: string;
  responsible: "automated" | "human" | "user" | "mixed" | "unknown";
  status: "proposed";
}
export interface PlanProposalDecision {
  topic: string;
  choice: string;
  origin: "user" | "suggested";
}
export interface PlanProposalDraft {
  schemaVersion: 1;
  title: string;
  objective: string;
  scope: string[];
  outOfScope: string[];
  decisions: PlanProposalDecision[];
  assumptions: string[];
  acceptance: PlanProposalCriterion[];
  tasks: PlanTask[];
}
interface StoredPlanProposal {
  id: string;
  proposal: PlanProposalDraft;
  createdAt: string;
  savedAt?: string;
  startedAt?: string;
  startedPlanId?: string;
  status: "draft";
}
type ProposalEditTarget =
  | { kind: "text"; field: "title" | "objective" }
  | { kind: "list"; field: "scope" | "outOfScope" | "assumptions" }
  | { kind: "decision"; index: number; field: "topic" | "choice" }
  | { kind: "acceptance"; index: number; field: "behavior" | "verification" }
  | { kind: "task"; index: number };
export interface AdaptivePlan {
  schemaVersion: 1;
  id: string;
  objective: string;
  revision: number;
  tasks: PlanTask[];
  createdAt: string;
  updatedAt: string;
  replans: number;
  status: "active" | "completed";
  decision: PlanDecision;
  sourceProposalId?: string;
}
export interface ReplanEvidence {
  schemaVersion: 1;
  type:
    | "verified-gate-failure"
    | "dependency-missing"
    | "scope-expanded"
    | "constraint-changed"
    | "goal-changed"
    | "task-blocked";
  evidenceRef: string;
  verified: boolean;
  requestId?: string;
}
export const PlanInputSchema = Type.Object({
  objective: Type.String({ minLength: 1, maxLength: 12000 }),
  tasks: Type.Array(
    Type.Object({
      id: Type.String(),
      objective: Type.String({ minLength: 1 }),
      dependsOn: Type.Array(Type.String()),
      acceptance: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      scope: Type.Optional(Type.Array(Type.String())),
    }),
    { minItems: 1, maxItems: 30 },
  ),
});
export function decidePlanMode(
  s: Assessment,
  dependencies = 0,
  multiSubsystem = false,
): PlanDecision {
  const mode =
    s.risks.length ||
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
export function validatePlan(
  tasks: PlanTask[],
  maxTasks = 12,
  maxDepth = 6,
): void {
  if (!tasks.length || tasks.length > maxTasks)
    throw new Error("task-count-limit");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length) throw new Error("duplicate-task-id");
  for (const task of tasks) {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(task.id) ||
      !task.objective?.trim() ||
      !Array.isArray(task.acceptance) ||
      !task.acceptance.length ||
      task.acceptance.some((a) => typeof a !== "string" || !a.trim()) ||
      !Array.isArray(task.dependsOn)
    )
      throw new Error("invalid-task");
    if (new Set(task.dependsOn).size !== task.dependsOn.length)
      throw new Error("duplicate-dependency");
    for (const dep of task.dependsOn)
      if (!byId.has(dep)) throw new Error("missing-dependency");
  }
  const visiting = new Set<string>();
  const depth = new Map<string, number>();
  function visit(key: string): number {
    if (visiting.has(key)) throw new Error("dependency-cycle");
    if (depth.has(key)) return depth.get(key)!;
    visiting.add(key);
    const value = 1 + Math.max(0, ...byId.get(key)!.dependsOn.map(visit));
    visiting.delete(key);
    if (value > maxDepth) throw new Error("dependency-depth-limit");
    depth.set(key, value);
    return value;
  }
  for (const task of tasks) visit(task.id);
}
function proposalText(value: unknown, field: string, maxLength = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength)
    throw new Error(`invalid-proposal-${field}`);
  return value.trim();
}
function proposalTextList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40)
    throw new Error(`invalid-proposal-${field}`);
  return value.map((item, index) =>
    proposalText(item, `${field}-${index}`, 2000),
  );
}
export function parsePlanProposalBlock(
  content: string,
  options: { maxTasks?: number; maxDepth?: number } = {},
): { proposal: PlanProposalDraft; block: string } | undefined {
  const matches = [...content.matchAll(/```pi-autoplan-proposal[ \t]*\r?\n([\s\S]*?)\r?\n```/gi)];
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw new Error("multiple-proposal-blocks");
  const match = matches[0]!;
  const raw = match[1]!;
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024)
    throw new Error("proposal-size-limit");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || value.schemaVersion !== 1)
    throw new Error("invalid-proposal-version");
  const title = proposalText(value.title, "title", 240);
  const objective = proposalText(value.objective, "objective", 12000);
  const tasks = value.tasks as PlanTask[];
  if (!Array.isArray(tasks)) throw new Error("invalid-proposal-tasks");
  validatePlan(tasks, options.maxTasks, options.maxDepth);
  if (
    !Array.isArray(value.acceptance) ||
    !value.acceptance.length ||
    value.acceptance.length > 60
  )
    throw new Error("invalid-proposal-acceptance");
  const responsibleValues = ["automated", "human", "user", "mixed", "unknown"];
  const acceptance = value.acceptance.map((item, index) => {
    if (!item || typeof item !== "object")
      throw new Error(`invalid-proposal-acceptance-${index}`);
    const criterion = item as Record<string, unknown>;
    if (
      !responsibleValues.includes(String(criterion.responsible)) ||
      criterion.status !== "proposed"
    )
      throw new Error(`invalid-proposal-acceptance-${index}`);
    return {
      behavior: proposalText(criterion.behavior, `acceptance-${index}-behavior`),
      verification: proposalText(
        criterion.verification,
        `acceptance-${index}-verification`,
      ),
      responsible: criterion.responsible as PlanProposalCriterion["responsible"],
      status: "proposed" as const,
    };
  });
  const decisionsValue = value.decisions ?? [];
  if (!Array.isArray(decisionsValue) || decisionsValue.length > 40)
    throw new Error("invalid-proposal-decisions");
  const decisions = decisionsValue.map((item, index) => {
    if (!item || typeof item !== "object")
      throw new Error(`invalid-proposal-decision-${index}`);
    const decision = item as Record<string, unknown>;
    if (decision.origin !== "user" && decision.origin !== "suggested")
      throw new Error(`invalid-proposal-decision-${index}`);
    return {
      topic: proposalText(decision.topic, `decision-${index}-topic`, 500),
      choice: proposalText(decision.choice, `decision-${index}-choice`, 1000),
      origin: decision.origin as PlanProposalDecision["origin"],
    };
  });
  return {
    proposal: {
      schemaVersion: 1,
      title,
      objective,
      scope: proposalTextList(value.scope, "scope"),
      outOfScope: proposalTextList(value.outOfScope, "out-of-scope"),
      decisions,
      assumptions: proposalTextList(value.assumptions, "assumptions"),
      acceptance,
      tasks,
    },
    block: match[0],
  };
}
function formatPlanProposal(proposal: PlanProposalDraft, locale: Locale): string {
  const t = (key: string) => translate(locale, key);
  const section = (title: string, items: string[]) =>
    items.length ? [`\n### ${title}`, ...items.map((item) => `- ${item}`)] : [];
  return [
    `## ${proposal.title}`,
    proposal.objective,
    ...section(t("plan.proposal.scope"), proposal.scope),
    ...section(t("plan.proposal.outOfScope"), proposal.outOfScope),
    ...section(
      t("plan.proposal.decisions"),
      proposal.decisions.map(
        (decision) =>
          `${decision.topic}: ${decision.choice} (${decision.origin})`,
      ),
    ),
    ...section(t("plan.proposal.assumptions"), proposal.assumptions),
    `\n### ${t("plan.proposal.acceptance")}`,
    ...proposal.acceptance.map(
      (criterion) =>
        `- ${criterion.behavior} — ${criterion.verification} (${criterion.responsible}; ${criterion.status})`,
    ),
    `\n### ${t("plan.proposal.tasks")}`,
    ...proposal.tasks.map(
      (task) =>
        `- ${task.id}: ${task.objective}${task.dependsOn.length ? ` (depends on ${task.dependsOn.join(", ")})` : ""}`,
    ),
  ].join("\n");
}
export function shouldReplan(e: ReplanEvidence): boolean {
  return (
    e.schemaVersion === 1 &&
    e.verified === true &&
    !!e.evidenceRef &&
    [
      "verified-gate-failure",
      "dependency-missing",
      "scope-expanded",
      "constraint-changed",
      "goal-changed",
      "task-blocked",
    ].includes(e.type)
  );
}
export class Planner implements Service {
  private workMode: "normal" | "plan" = "normal";
  private discoveryStyle: "propose" | "essential" | "stepwise" = "essential";
  private awaitingDiscoveryChoice = false;
  private pendingFirstInput?: {
    text: string;
    images?: InputEvent["images"];
  };
  private proposalDraft?: StoredPlanProposal;
  private workModeLocale: Locale = "en";
  modeDescriptions = {
    auto: "Create bounded plans for eligible tasks.",
    observe: "Show planning decisions without applying a plan.",
    off: "Disable automatic planning.",
  };
  menuGroups = {
    Plan: ["status", "show", "review", "create", "validate", "replan", "plan-mode"],
    History: ["history", "explain"],
    Settings: ["config", "doctor", "storage status", "shortcut"],
  };
  menuInputs = {
    create: "Create plan: project-relative JSON file (Esc cancels)",
    validate: "Validate plan: project-relative JSON file (Esc cancels)",
  };
  capabilities = ["plan.adaptive.v1", "plan.dag.v1"];
  menu = [
    "status",
    "show",
    "review",
    "history",
    "create",
    "validate",
    "replan",
    "explain",
    "plan-mode",
    "shortcut",
  ];
  private decision?: PlanDecision;
  constructor(readonly host: Host) {}
  private isStoredProposal(value: unknown): value is StoredPlanProposal {
    if (!value || typeof value !== "object") return false;
    const stored = value as Partial<StoredPlanProposal>;
    if (
      stored.status !== "draft" ||
      typeof stored.id !== "string" ||
      typeof stored.createdAt !== "string" ||
      typeof stored.savedAt !== "string" ||
      (stored.startedAt !== undefined && typeof stored.startedAt !== "string") ||
      (stored.startedPlanId !== undefined && typeof stored.startedPlanId !== "string") ||
      !stored.proposal ||
      typeof stored.proposal !== "object"
    )
      return false;
    try {
      validatePlan(
        stored.proposal.tasks,
        this.host.config.maxInitialTasks,
        this.host.config.maxDependencyDepth,
      );
    } catch {
      return false;
    }
    return (
      typeof stored.proposal.title === "string" &&
      typeof stored.proposal.objective === "string" &&
      Array.isArray(stored.proposal.acceptance) &&
      stored.proposal.acceptance.length > 0
    );
  }
  async sessionStart(context: ExtensionContext) {
    this.workMode = "normal";
    this.discoveryStyle = "essential";
    this.awaitingDiscoveryChoice = false;
    this.pendingFirstInput = undefined;
    try {
      const saved = await this.host.store.listRecords<unknown>("proposals");
      this.proposalDraft = saved
        .filter((proposal): proposal is StoredPlanProposal =>
          this.isStoredProposal(proposal),
        )
        .sort((a, b) => b.savedAt!.localeCompare(a.savedAt!))[0];
    } catch {
      this.proposalDraft = undefined;
    }
    this.workModeLocale = "en";
    if (context.hasUI)
      context.ui.setStatus("pi-autoplan-work-mode", undefined);
  }
  async modelSelect(event: ModelSelectEvent, context: ExtensionContext) {
    if (
      this.pendingFirstInput &&
      !this.noModelSelected(event.model) &&
      context.hasUI
    )
      context.ui.setEditorText(this.pendingFirstInput.text);
  }
  private noModelSelected(model: ExtensionContext["model"]): boolean {
    return (
      !model ||
      (String(model.provider) === "unknown" &&
        String(model.id) === "unknown" &&
        String(model.api) === "unknown")
    );
  }
  private consumePendingInput(event: InputEvent): InputEventResult {
    const pending = this.pendingFirstInput;
    if (!pending || pending.text !== event.text) return { action: "continue" };
    this.pendingFirstInput = undefined;
    if (!event.images?.length && pending.images?.length)
      return { action: "transform", text: event.text, images: pending.images };
    return { action: "continue" };
  }
  private async selectDiscoveryStyle(
    context: ExtensionContext,
    choices: ReadonlyArray<{ value: string; label: string }>,
  ): Promise<string | undefined> {
    const title = translate(this.workModeLocale, "plan.discovery.title");
    if (context.mode !== "tui" || typeof context.ui.custom !== "function")
      return context.ui.select(
        title,
        choices.map((choice) => choice.label),
        { signal: context.signal },
      );
    return context.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
      const container = new Container();
      const border = new DynamicBorder((text) => theme.fg("accent", text));
      const list = new SelectList(
        choices.map((choice) => ({ value: choice.value, label: choice.label })),
        choices.length,
        getSelectListTheme(),
      );
      list.setSelectedIndex(1);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      container.addChild(border);
      container.addChild(
        new Text(theme.fg("accent", theme.bold(title)), 1, 0),
      );
      container.addChild(list);
      container.addChild(
        new Text(
          theme.fg("dim", translate(this.workModeLocale, "plan.discovery.keys")),
          1,
          0,
        ),
      );
      container.addChild(border);
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput(data),
        handleMouse: (event: Parameters<typeof list.handleMouse>[0]) =>
          list.handleMouse(event),
        dispose: () => container.invalidate(),
      };
    });
  }
  async input(
    event: InputEvent,
    context: ExtensionContext,
  ): Promise<InputEventResult | undefined> {
    if (event.source === "extension") return undefined;
    const trimmed = event.text.trimStart();
    if (trimmed.startsWith("/")) {
      if (!/^\/model(?:\s|$)/i.test(trimmed))
        this.pendingFirstInput = undefined;
      return undefined;
    }
    if (this.pendingFirstInput?.text !== event.text)
      this.pendingFirstInput = undefined;
    if (event.streamingBehavior || (!event.text.trim() && !event.images?.length))
      return undefined;
    if (this.workMode !== "plan" || !this.awaitingDiscoveryChoice)
      return this.consumePendingInput(event);

    const locale = this.workModeLocale;
    const t = (key: string) => translate(locale, key);
    const existingPending =
      this.pendingFirstInput?.text === event.text
        ? this.pendingFirstInput
        : undefined;
    if (this.noModelSelected(context.model)) {
      this.pendingFirstInput = {
        text: event.text,
        images: event.images?.length ? event.images : existingPending?.images,
      };
      if (context.hasUI) context.ui.setEditorText(event.text);
      context.ui.notify(t("plan.mode.modelRequired"), "warning");
      return { action: "handled" };
    }

    const choices = [
      { value: "propose", label: t("plan.discovery.propose") },
      { value: "essential", label: t("plan.discovery.essential") },
      { value: "stepwise", label: t("plan.discovery.stepwise") },
    ] as const;
    let selected: string | undefined;
    try {
      selected = await this.selectDiscoveryStyle(context, choices);
    } catch {
      this.pendingFirstInput = {
        text: event.text,
        images: event.images?.length ? event.images : existingPending?.images,
      };
      if (context.hasUI) context.ui.setEditorText(event.text);
      context.ui.notify(t("plan.mode.unchanged"), "warning");
      return { action: "handled" };
    }
    const choice = choices.find(
      (candidate) => candidate.value === selected || candidate.label === selected,
    );
    if (
      !choice ||
      !context.isIdle() ||
      context.hasPendingMessages() ||
      context.signal?.aborted
    ) {
      this.pendingFirstInput = {
        text: event.text,
        images: event.images?.length ? event.images : existingPending?.images,
      };
      if (context.hasUI) context.ui.setEditorText(event.text);
      context.ui.notify(t("plan.mode.unchanged"), "info");
      return { action: "handled" };
    }

    this.discoveryStyle = choice.value;
    this.awaitingDiscoveryChoice = false;
    const statusLabel = `${t("action.plan-mode")}: ${choice.label}`;
    context.ui.setStatus(
      "pi-autoplan-work-mode",
      context.ui.theme.fg("accent", statusLabel),
    );
    context.ui.notify(t("plan.mode.choiceSaved"), "info");
    const pending = this.pendingFirstInput;
    this.pendingFirstInput = undefined;
    const images = event.images?.length ? event.images : pending?.images;
    if (images !== event.images)
      return { action: "transform", text: event.text, images };
    return { action: "continue" };
  }
  async planModePrompt(_prompt: string, _context: ExtensionContext) {
    if (this.workMode !== "plan" || this.awaitingDiscoveryChoice)
      return undefined;
    const instructions = {
      propose:
        "Draft a complete proposal first, and ask only questions that could materially change safety, scope, or the intended result.",
      essential:
        "Ask only the essential questions needed to resolve important uncertainty, then present a concise proposal.",
      stepwise:
        "Present one meaningful decision at a time and wait for the user's choice before proceeding to the next decision.",
    }[this.discoveryStyle];
    return {
      protocol: "pi-autoplan.plan-session.v1",
      mode: "Plan",
      discoveryStyle: this.discoveryStyle,
      instructions: [
        "Explore and discuss the requested work as a proposal only.",
        instructions,
        "Do not call tools, edit files, write or revise an active execution plan, install, deploy, change permissions, or perform other side effects. The user may separately save this proposal with Ctrl+S; never save it on their behalf.",
        "Keep decisions, affected scope, proposed tasks, dependencies, and acceptance statements in the response; criteria remain proposals and are not executable tests.",
        "During discovery, ask one essential question at a time in plain language and wait for the answer. Do not emit a proposal block while a blocking decision remains.",
        "When ready, give a concise readable proposal and append exactly one fenced pi-autoplan-proposal JSON block. Use schemaVersion 1 with title, objective, scope, outOfScope, decisions, assumptions, acceptance, and tasks. Each decision has topic, choice, and origin (user or suggested). Each acceptance item has behavior, verification, responsible (automated, human, user, mixed, or unknown), and status set to proposed. Each task has id, objective, dependsOn, acceptance, and optional scope. Include only decisions actually made; label suggestions as suggested. Do not invent model prices, executable checks, authorization, or completion evidence.",
        "Do not claim implementation or verification has occurred.",
      ],
    };
  }
  async planModeMessageEnd(
    event: MessageEndEvent,
    context: ExtensionContext,
  ): Promise<MessageEndEventResult | undefined> {
    const message = event.message;
    if (
      this.workMode !== "plan" ||
      this.awaitingDiscoveryChoice ||
      message.role !== "assistant" ||
      message.stopReason !== "stop"
    )
      return undefined;
    const textBlocks = message.content.filter((block) => block.type === "text") as {
      type: "text";
      text: string;
    }[];
    const fullText = textBlocks.map((block) => block.text).join("\n");
    let parsed: ReturnType<typeof parsePlanProposalBlock>;
    try {
      parsed = parsePlanProposalBlock(fullText, {
        maxTasks: this.host.config.maxInitialTasks,
        maxDepth: this.host.config.maxDependencyDepth,
      });
    } catch {
      if (context.hasUI)
        context.ui.notify(
          translate(this.workModeLocale, "plan.proposal.invalid"),
          "warning",
        );
      return undefined;
    }
    if (!parsed || !textBlocks.some((block) => block.text.includes(parsed!.block)))
      return undefined;

    this.proposalDraft = {
      id: id(),
      proposal: parsed.proposal,
      createdAt: now(),
      status: "draft",
    };
    const nextContent: typeof message.content = [];
    for (const block of message.content) {
      if (block.type !== "text" || !block.text.includes(parsed.block)) {
        nextContent.push(block);
        continue;
      }
      const text = block.text
        .replace(parsed.block, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (text) nextContent.push({ ...block, text });
    }
    if (!nextContent.some((block) => block.type === "text" && block.text.trim()))
      nextContent.push({
        type: "text",
        text: formatPlanProposal(parsed.proposal, this.workModeLocale),
      });
    if (context.hasUI) {
      context.ui.setStatus(
        "pi-autoplan-work-mode",
        context.ui.theme.fg(
          "accent",
          `${translate(this.workModeLocale, "action.plan-mode")}: ${translate(this.workModeLocale, "plan.proposal.ready")}`,
        ),
      );
      context.ui.notify(
        translate(this.workModeLocale, "plan.proposal.ready"),
        "info",
      );
    }
    return { message: { ...message, content: nextContent } };
  }
  private async reviewProposal(context: CommandContext): Promise<unknown> {
    let draft = this.proposalDraft;
    const ui = context.hostContext;
    const locale = context.locale ?? this.workModeLocale;
    const t = (key: string) => translate(locale, key);
    if (!draft) {
      ui?.ui.notify(t("plan.proposal.noDraft"), "info");
      return { reviewed: false, reason: "no-proposal" };
    }
    if (!ui?.hasUI || ui.mode !== "tui" || typeof ui.ui.custom !== "function")
      return { reviewed: false, reason: t("plan.mode.interactiveRequired") };

    let dirty = !draft.savedAt;
    let escapeArmed = false;
    let saving = false;
    let status = draft.startedAt
      ? t("plan.proposal.started")
      : draft.savedAt
        ? t("plan.proposal.saved")
        : "";
    let result: "closed" | "discarded" | "started" | undefined;
    try {
      result = await ui.ui.custom<"closed" | "discarded" | "started">(
        (tui, theme, _keybindings, done) => {
          let disposed = false;
          const container = new Container();
          let statusText: Text | undefined;
          let fieldList: SelectList | undefined;
          let fieldInput: Input | undefined;
          let currentTargets: ProposalEditTarget[] = [];
          const setStatus = (text: string) => {
            status = text;
            statusText?.setText(status ? theme.fg("warning", status) : "");
            container.invalidate();
            tui.requestRender();
          };
          const finish = (value: "closed" | "discarded" | "started") => {
            if (disposed) return;
            disposed = true;
            tui.setFocus?.(null);
            ui.signal?.removeEventListener("abort", onAbort);
            result = value;
            done(value);
          };
          const onAbort = () => finish("closed");
          ui.signal?.addEventListener("abort", onAbort, { once: true });
          if (ui.signal?.aborted) onAbort();
          const addHeader = (title: string) => {
            container.addChild(
              new DynamicBorder((text) => theme.fg("accent", text)),
            );
            container.addChild(
              new Text(theme.fg("accent", theme.bold(title)), 1, 0),
            );
          };
          const addStatus = () => {
            statusText = new Text(
              status ? theme.fg("warning", status) : "",
              1,
              0,
            );
            container.addChild(statusText);
            container.addChild(
              new DynamicBorder((text) => theme.fg("accent", text)),
            );
          };
          const updatePanel = () => {
            container.invalidate();
            tui.requestRender();
          };
          const renderReview = () => {
            fieldList = undefined;
            fieldInput = undefined;
            tui.setFocus?.(null);
            container.clear();
            addHeader(t("plan.proposal.reviewTitle"));
            container.addChild(
              new Markdown(
                formatPlanProposal(draft!.proposal, locale),
                1,
                1,
                getMarkdownTheme(),
              ),
            );
            const keys = draft!.startedAt
              ? t("plan.proposal.reviewKeysStarted")
              : t("plan.proposal.reviewKeys");
            container.addChild(new Text(theme.fg("dim", keys), 1, 0));
            addStatus();
            updatePanel();
          };
          const targetLabel = (target: ProposalEditTarget): string => {
            if (target.kind === "text")
              return t(`plan.proposal.edit.${target.field}`);
            if (target.kind === "list")
              return t(`plan.proposal.edit.${target.field}`);
            if (target.kind === "decision")
              return t(`plan.proposal.edit.decision${target.field === "topic" ? "Topic" : "Choice"}`)
                .replace("{n}", String(target.index + 1));
            if (target.kind === "acceptance")
              return t(`plan.proposal.edit.acceptance${target.field === "behavior" ? "Behavior" : "Verification"}`)
                .replace("{n}", String(target.index + 1));
            return t("plan.proposal.edit.taskObjective").replace(
              "{id}",
              draft!.proposal.tasks[target.index]!.id,
            );
          };
          const targetValue = (target: ProposalEditTarget): string => {
            if (target.kind === "text") return draft!.proposal[target.field];
            if (target.kind === "list")
              return draft!.proposal[target.field].join("; ");
            if (target.kind === "decision")
              return draft!.proposal.decisions[target.index]![target.field];
            if (target.kind === "acceptance")
              return draft!.proposal.acceptance[target.index]![target.field];
            return draft!.proposal.tasks[target.index]!.objective;
          };
          const makeTargets = (): ProposalEditTarget[] => [
            { kind: "text", field: "title" },
            { kind: "text", field: "objective" },
            { kind: "list", field: "scope" },
            { kind: "list", field: "outOfScope" },
            ...draft!.proposal.decisions.flatMap((_, index) => [
              { kind: "decision", index, field: "topic" } as const,
              { kind: "decision", index, field: "choice" } as const,
            ]),
            { kind: "list", field: "assumptions" },
            ...draft!.proposal.acceptance.flatMap((_, index) => [
              { kind: "acceptance", index, field: "behavior" } as const,
              { kind: "acceptance", index, field: "verification" } as const,
            ]),
            ...draft!.proposal.tasks.map((_, index) => ({
              kind: "task",
              index,
            }) as const),
          ];
          const renderFieldSelector = () => {
            fieldInput = undefined;
            tui.setFocus?.(null);
            container.clear();
            addHeader(t("plan.proposal.editFieldsTitle"));
            currentTargets = makeTargets();
            fieldList = new SelectList(
              currentTargets.map((target, index) => ({
                value: String(index),
                label: targetLabel(target),
                description: targetValue(target) || undefined,
              })),
              Math.min(Math.max(currentTargets.length, 1), 8),
              getSelectListTheme(),
            );
            fieldList.onSelect = (item) => {
              const target = currentTargets[Number(item.value)];
              if (target) renderFieldEditor(target);
            };
            fieldList.onCancel = () => renderReview();
            container.addChild(fieldList);
            container.addChild(
              new Text(theme.fg("dim", t("plan.proposal.editSelectHelp")), 1, 0),
            );
            addStatus();
            updatePanel();
          };
          const applyEdit = (target: ProposalEditTarget, value: string) => {
            if (!draft) return;
            const proposal: PlanProposalDraft = { ...draft.proposal };
            try {
              if (target.kind === "text") {
                proposal[target.field] = proposalText(
                  value,
                  target.field,
                  target.field === "title" ? 240 : 12000,
                );
              } else if (target.kind === "list") {
                const items = value.trim()
                  ? value.split(";").map((item) => item.trim()).filter(Boolean)
                  : [];
                proposal[target.field] = proposalTextList(items, target.field);
              } else if (target.kind === "decision") {
                const decisions = [...proposal.decisions];
                const decision = decisions[target.index];
                if (!decision) throw new Error("invalid-proposal-decision");
                decisions[target.index] = {
                  ...decision,
                  [target.field]: proposalText(
                    value,
                    `decision-${target.index}-${target.field}`,
                    target.field === "topic" ? 500 : 1000,
                  ),
                };
                proposal.decisions = decisions;
              } else if (target.kind === "acceptance") {
                const acceptance = [...proposal.acceptance];
                const criterion = acceptance[target.index];
                if (!criterion) throw new Error("invalid-proposal-acceptance");
                acceptance[target.index] = {
                  ...criterion,
                  [target.field]: proposalText(
                    value,
                    `acceptance-${target.index}-${target.field}`,
                  ),
                };
                proposal.acceptance = acceptance;
              } else {
                const tasks = [...proposal.tasks];
                const task = tasks[target.index];
                if (!task) throw new Error("invalid-proposal-task");
                tasks[target.index] = {
                  ...task,
                  objective: proposalText(
                    value,
                    `task-${target.index}-objective`,
                    12000,
                  ),
                };
                proposal.tasks = tasks;
              }
            } catch {
              setStatus(t("plan.proposal.editInvalid"));
              return;
            }
            if (JSON.stringify(proposal) !== JSON.stringify(draft.proposal)) {
              draft = { ...draft, proposal, savedAt: undefined };
              this.proposalDraft = draft;
              dirty = true;
              escapeArmed = false;
              setStatus(t("plan.proposal.editApplied"));
            }
            renderReview();
          };
          const renderFieldEditor = (target: ProposalEditTarget) => {
            fieldList = undefined;
            tui.setFocus?.(null);
            container.clear();
            addHeader(targetLabel(target));
            container.addChild(
              new Text(
                theme.fg(
                  "dim",
                  target.kind === "list"
                    ? t("plan.proposal.editListHelp")
                    : t("plan.proposal.editHelp"),
                ),
                1,
                0,
              ),
            );
            fieldInput = new Input({ prompt: "› " });
            fieldInput.setValue(targetValue(target));
            fieldInput.handleInput("\u0005");
            fieldInput.onSubmit = (value) => applyEdit(target, value);
            fieldInput.onEscape = () => renderFieldSelector();
            container.addChild(fieldInput);
            container.addChild(
              new Text(theme.fg("dim", t("plan.proposal.editCancelHelp")), 1, 0),
            );
            addStatus();
            tui.setFocus?.(fieldInput);
            updatePanel();
          };
          const render = (width: number) => {
            return container.render(width);
          };
          renderReview();
          const save = async () => {
            if (saving || disposed || !draft) return;
            saving = true;
            setStatus(t("notice.savingMode"));
            try {
              validatePlan(
                draft.proposal.tasks,
                this.host.config.maxInitialTasks,
                this.host.config.maxDependencyDepth,
              );
              const saved: StoredPlanProposal = {
                ...draft,
                savedAt: now(),
                status: "draft",
              };
              await this.host.store.putRecord("proposals", saved.id, saved);
              draft = saved;
              this.proposalDraft = saved;
              dirty = false;
              escapeArmed = false;
              setStatus(t("plan.proposal.saved"));
              ui.ui.notify(t("plan.proposal.saved"), "info");
            } catch {
              setStatus(t("plan.proposal.saveFailed"));
              ui.ui.notify(t("plan.proposal.saveFailed"), "warning");
            } finally {
              saving = false;
            }
          };
          const approveAndStart = async () => {
            if (saving || disposed || !draft) return;
            if (!draft.savedAt) {
              setStatus(t("plan.proposal.saveBeforeStart"));
              return;
            }
            if (draft.startedAt) {
              setStatus(t("plan.proposal.started"));
              return;
            }
            if (!this.host.api?.sendUserMessage) {
              setStatus(t("plan.proposal.startUnavailable"));
              return;
            }
            if (this.noModelSelected(ui.model)) {
              setStatus(t("plan.proposal.modelRequired"));
              ui.ui.notify(t("plan.proposal.modelRequired"), "warning");
              return;
            }
            if (!ui.isIdle() || ui.hasPendingMessages()) {
              setStatus(t("plan.proposal.startBusy"));
              return;
            }
            saving = true;
            setStatus(t("plan.proposal.starting"));
            try {
              const existing = await this.current();
              if (existing) {
                if (existing.sourceProposalId === draft.id) {
                  setStatus(
                    draft.startedAt
                      ? t("plan.proposal.started")
                      : t("plan.proposal.startUncertain"),
                  );
                  return;
                }
                setStatus(t("plan.proposal.activePlanExists"));
                return;
              }
              validatePlan(
                draft.proposal.tasks,
                this.host.config.maxInitialTasks,
                this.host.config.maxDependencyDepth,
              );
              const plan = await this.update({
                objective: draft.proposal.objective,
                tasks: draft.proposal.tasks,
                sourceProposalId: draft.id,
              });
              this.workMode = "normal";
              this.awaitingDiscoveryChoice = false;
              this.pendingFirstInput = undefined;
              ui.ui.setStatus("pi-autoplan-work-mode", undefined);
              this.host.api.sendUserMessage(
                `Implement the approved plan “${draft.proposal.title}”. Objective: ${draft.proposal.objective}\n\nApproved scope: ${draft.proposal.scope.join("; ")}\nOut of scope: ${draft.proposal.outOfScope.join("; ")}\nAcceptance criteria: ${draft.proposal.acceptance.map((item) => item.behavior).join("; ")}\n\nUse the active plan ${plan.id} already available in the planning context. Work within its task bounds and report evidence for each acceptance criterion.`,
                { expandPromptTemplates: false },
              );
              draft = {
                ...draft,
                startedAt: now(),
                startedPlanId: plan.id,
              };
              this.proposalDraft = draft;
              try {
                await this.host.store.putRecord("proposals", draft.id, draft);
              } catch {
                // The active plan is linked to this proposal and prevents a second submit.
              }
              ui.ui.notify(t("plan.proposal.started"), "info");
              finish("started");
            } catch {
              setStatus(t("plan.proposal.startFailed"));
              ui.ui.notify(t("plan.proposal.startFailed"), "warning");
            } finally {
              saving = false;
            }
          };
          return {
            render,
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              if (saving) return;
              if (fieldInput) {
                if (
                  matchesKey(data, "ctrl+s") ||
                  matchesKey(data, "ctrl+enter")
                ) {
                  setStatus(t("plan.proposal.editFinishFirst"));
                  return;
                }
                fieldInput.handleInput(data);
                return;
              }
              if (matchesKey(data, "ctrl+s")) {
                void save();
                return;
              }
              if (fieldList) {
                if (matchesKey(data, "ctrl+enter")) {
                  setStatus(t("plan.proposal.editReturnToReview"));
                  return;
                }
                fieldList.handleInput(data);
                return;
              }
              if (matchesKey(data, "ctrl+enter")) {
                void approveAndStart();
                return;
              }
              if (matchesKey(data, "e")) {
                if (draft?.startedAt) {
                  setStatus(t("plan.proposal.editStarted"));
                  return;
                }
                renderFieldSelector();
                return;
              }
              if (matchesKey(data, "enter")) {
                finish("closed");
                return;
              }
              if (!matchesKey(data, "escape")) return;
              if (!dirty) {
                finish("closed");
                return;
              }
              if (escapeArmed) {
                this.proposalDraft = undefined;
                finish("discarded");
                return;
              }
              escapeArmed = true;
              setStatus(t("plan.proposal.unsaved"));
            },
            dispose: () => {
              disposed = true;
              tui.setFocus?.(null);
              ui.signal?.removeEventListener("abort", onAbort);
            },
          };
        },
      );
    } catch {
      ui.ui.notify(t("plan.mode.unchanged"), "warning");
      return { reviewed: false, reason: "review-ui-failed" };
    }
    return {
      reviewed: true,
      saved: result !== "discarded" && Boolean(this.proposalDraft?.savedAt),
      discarded: result === "discarded",
      started: result === "started",
    };
  }
  async guardToolCall(_event: unknown, _context: ExtensionContext) {
    if (this.workMode !== "plan") return undefined;
    return {
      block: true as const,
      reason: translate(this.workModeLocale, "plan.mode.toolBlocked"),
    };
  }
  private async toggleWorkMode(context: CommandContext) {
    const ui = context.hostContext;
    const locale = context.locale ?? "en";
    const t = (key: string) => translate(locale, key);
    if (!ui || !ui.hasUI || typeof ui.ui.select !== "function")
      return { mode: this.workMode, changed: false, reason: t("plan.mode.interactiveRequired") };
    if (!ui.isIdle() || ui.hasPendingMessages()) {
      ui.ui.notify(t("plan.mode.busy"), "warning");
      return { mode: this.workMode, changed: false, reason: "agent-busy" };
    }
    if (this.workMode === "plan") {
      this.workMode = "normal";
      this.discoveryStyle = "essential";
      this.awaitingDiscoveryChoice = false;
      this.workModeLocale = locale;
      ui.ui.setStatus("pi-autoplan-work-mode", undefined);
      ui.ui.notify(t("plan.mode.disabled"), "info");
      return { mode: this.workMode, changed: true };
    }
    this.workMode = "plan";
    this.discoveryStyle = "essential";
    this.awaitingDiscoveryChoice = true;
    this.workModeLocale = locale;
    const statusLabel = `${t("action.plan-mode")}: ${t("plan.mode.discoveryPending")}`;
    ui.ui.setStatus(
      "pi-autoplan-work-mode",
      ui.ui.theme.fg("accent", statusLabel),
    );
    ui.ui.notify(t("plan.mode.enabled"), "info");
    return {
      mode: this.workMode,
      changed: true,
      discoveryStyle: this.discoveryStyle,
      awaitingDiscoveryChoice: true,
    };
  }
  private async configureShortcut(context: CommandContext) {
    const ui = context.hostContext;
    if (
      !ui?.hasUI ||
      typeof ui.ui.custom !== "function" ||
      typeof ui.ui.confirm !== "function"
    )
      return {
        changed: false,
        reason: translate(context.locale ?? "en", "shortcut.interactiveRequired"),
      };

    const locale = context.locale ?? "en";
    const t = (key: string) => translate(locale, key);
    const agentDir = getAgentDir();
    const existing = await readShortcutMigration(agentDir);
    if (existing) {
      const preview = await shortcutMigrationPreview(agentDir);
      if (!preview.matchesWritten) {
        const message = t("shortcut.changedAfterSetup");
        ui.ui.notify(message, "warning");
        return { restored: false, reason: "pi-thinking-binding-changed" };
      }
      const restoreValue = existing.previous.present
        ? `${t("shortcut.restoreExplicit")}: ${keybindingLabel(existing.previous.value)}`
        : `${t("shortcut.restoreDefault")}: ${keybindingLabel(existing.previousEffective)}`;
      const approved = await ui.ui.confirm(
        t("shortcut.restoreTitle"),
        [
          `${t("shortcut.current")}: ${keybindingLabel(preview.current)}`,
          restoreValue,
          t("shortcut.restoreSafety"),
        ].join("\n"),
        { signal: ui.signal },
      );
      if (!approved) return { restored: false, reason: "cancelled" };
      const result = await restoreShortcutMigration(agentDir);
      if (!result.restored) {
        ui.ui.notify(t("shortcut.changedAfterSetup"), "warning");
        return result;
      }
      ui.ui.notify(t("shortcut.restoredRestart"), "info");
      return result;
    }

    const initialDocument = await readKeybindingsDocument(agentDir);
    let effectiveBindings: Keybindings = {};
    let foundNoConflict = false;
    let foundNoFreeOption = false;
    const selected = await ui.ui.custom<string | undefined>(
      (tui, theme, keybindings, done) => {
        effectiveBindings = keybindings.getEffectiveConfig();
        const current = effectiveThinkingBinding(effectiveBindings);
        if (!keybindingKeys(current).includes("shift+tab"))
          foundNoConflict = true;
        const shortcuts = foundNoConflict
          ? []
          : freeThinkingShortcuts(effectiveBindings, initialDocument.config);
        if (!foundNoConflict && shortcuts.length === 0)
          foundNoFreeOption = true;
        const container = new Container();
        const border = new DynamicBorder((text) => theme.fg("accent", text));
        const title = foundNoConflict
          ? t("shortcut.noConflictTitle")
          : t("shortcut.chooseTitle");
        container.addChild(border);
        container.addChild(
          new Text(theme.fg("accent", theme.bold(title)), 1, 0),
        );
        container.addChild(
          new Text(
            theme.fg(
              "toolOutput",
              `${t("shortcut.current")}: ${keybindingLabel(current)}`,
            ),
            1,
            0,
          ),
        );
        let list: SelectList | undefined;
        if (shortcuts.length) {
          list = new SelectList(
            shortcuts.map((shortcut) => ({
              value: shortcut,
              label: shortcut.toUpperCase(),
              description: t("shortcut.freeOption"),
            })),
            Math.min(shortcuts.length, 8),
            getSelectListTheme(),
          );
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(undefined);
          container.addChild(list);
        } else {
          container.addChild(
            new Text(
              theme.fg(
                "warning",
                foundNoConflict
                  ? t("shortcut.noConflictBody")
                  : t("shortcut.noFreeOption"),
              ),
              1,
              0,
            ),
          );
        }
        container.addChild(
          new Text(
            theme.fg(
              "dim",
              list ? t("shortcut.chooseHelp") : t("shortcut.closeHelp"),
            ),
            1,
            0,
          ),
        );
        container.addChild(border);
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => list?.handleInput(data),
          handleMouse: (event: Parameters<SelectList["handleMouse"]>[0]) =>
            list?.handleMouse(event),
          dispose: () => container.invalidate(),
        };
      },
      { overlay: true, overlayOptions: { width: "72%", maxHeight: 12, anchor: "center", margin: 1 } },
    );

    if (foundNoConflict) {
      ui.ui.notify(t("shortcut.noConflictBody"), "info");
      return { changed: false, reason: "shift-tab-already-free" };
    }
    if (foundNoFreeOption) {
      ui.ui.notify(t("shortcut.noFreeOption"), "warning");
      return { changed: false, reason: "no-free-keybinding" };
    }
    if (!selected) return { changed: false, reason: "cancelled" };

    const previous = effectiveThinkingBinding(effectiveBindings);
    const previousExplicit = Object.hasOwn(
      initialDocument.config,
      "app.thinking.cycle",
    );
    const restoreValue = previousExplicit
      ? `${t("shortcut.restoreExplicit")}: ${keybindingLabel(initialDocument.config["app.thinking.cycle"])}`
      : `${t("shortcut.restoreDefault")}: ${keybindingLabel(previous)}`;
    const previewMessage = [
      `${t("shortcut.current")}: ${keybindingLabel(previous)}`,
      `${t("shortcut.proposed")}: ${selected}`,
      t("shortcut.planKey"),
      restoreValue,
      t("shortcut.restoreSafety"),
    ].join("\n");
    const approved = await ui.ui.confirm(
      t("shortcut.previewTitle"),
      previewMessage,
      { signal: ui.signal },
    );
    if (!approved) return { changed: false, reason: "cancelled" };

    try {
      const migration = await applyShortcutMigration({
        agentDir,
        shortcut: selected,
        effectiveBindings,
        expectedRaw: initialDocument.raw,
      });
      ui.ui.notify(t("shortcut.savedRestart"), "info");
      return { changed: true, migration };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "pi-shortcut-migration-failed";
      ui.ui.notify(t("shortcut.saveFailed") + ` (${reason})`, "error");
      return { changed: false, reason };
    }
  }
  async start() {
    this.host.interop.listen("pi.gate.result.v1", async (e) => {
      const p = e.payload as {
        evaluated: boolean;
        verified: boolean;
        rejected: boolean;
        evidenceRef?: string;
      };
      if (
        p.evaluated === true &&
        p.rejected === true &&
        typeof p.evidenceRef === "string"
      )
        await this.requestReplan({
          schemaVersion: 1,
          type: "verified-gate-failure",
          verified: true,
          evidenceRef: p.evidenceRef,
        });
    });
  }
  async current() {
    const ref = await this.host.store.getRecord<{ id: string }>(
      "current",
      "plan",
    );
    return ref
      ? this.host.store.getRecord<AdaptivePlan>("plans", ref.id)
      : null;
  }
  async update(
    input: { objective: string; tasks: PlanTask[]; sourceProposalId?: string },
    evidence?: ReplanEvidence,
  ): Promise<AdaptivePlan> {
    validatePlan(
      input.tasks,
      this.host.config.maxInitialTasks,
      this.host.config.maxDependencyDepth,
    );
    const current = await this.current();
    if (current) {
      if (!evidence || !shouldReplan(evidence))
        throw new Error("material-evidence-required");
      if (current.replans >= this.host.config.maxReplans)
        throw new Error("manual-review-required");
    }
    const decision = this.decision ?? decidePlanMode(assess(input.objective));
    const plan: AdaptivePlan = {
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
      ...(input.sourceProposalId
        ? { sourceProposalId: input.sourceProposalId }
        : current?.sourceProposalId
          ? { sourceProposalId: current.sourceProposalId }
          : {}),
    };
    await this.host.store.transact((s) => {
      const actual = s.records.plans?.[plan.id]?.value as
        AdaptivePlan | undefined;
      if ((actual?.revision ?? 0) !== (current?.revision ?? 0))
        throw new Error("plan-revision-conflict");
      if (evidence?.requestId) {
        const request = s.records["replan-requests"]?.[evidence.requestId]
          ?.value as
          { planId: string; revision: number; consumed: boolean } | undefined;
        if (
          !request ||
          request.planId !== plan.id ||
          request.revision !== current?.revision ||
          request.consumed
        )
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
    this.host.interop.emit(
      "pi.plan.updated.v1",
      { planId: plan.id, revision: plan.revision, tasks: plan.tasks, evidence },
      { correlationId: plan.id },
    );
    return plan;
  }
  async requestReplan(evidence: ReplanEvidence) {
    if (!shouldReplan(evidence)) throw new Error("invalid-replan-evidence");
    const plan = await this.current();
    if (!plan) return { requested: false, reason: "no-plan" };
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
  async prompt(prompt: string) {
    const local = assess(prompt);
    const cached = this.host.interop.assessments.get(digest(prompt));
    const assessment = cached
      ? { ...cached, risks: [...new Set([...cached.risks, ...local.risks])] }
      : local;
    this.decision = decidePlanMode(assessment);
    if (cached) this.decision.source = "assessment";
    const current = await this.current();
    const requests = current
      ? (
          await this.host.store.listRecords<{
            planId: string;
            revision: number;
            consumed: boolean;
            evidence: ReplanEvidence;
          }>("replan-requests")
        ).filter(
          (request) =>
            request.planId === current.id &&
            request.revision === current.revision &&
            !request.consumed,
        )
      : [];
    await this.host.store.putRecord("decisions", id(), {
      ...this.decision,
      createdAt: now(),
    });
    if (this.decision.mode === "none") return undefined;
    return this.decision.mode === "micro"
      ? {
          planning: "micro",
          instruction:
            "Use a short checklist with objective acceptance checks; do not create a workflow engine.",
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
          instruction:
            "Create a bounded execution DAG with autoplan_update before substantial implementation.",
          maxTasks: this.host.config.maxInitialTasks,
          replanRequests: requests.map((request) => request.evidence),
        };
  }
  async command(
    action: string,
    args: string[],
    context: CommandContext,
  ): Promise<unknown> {
    if (action === "plan-mode") return this.toggleWorkMode(context);
    if (action === "shortcut") return this.configureShortcut(context);
    if (action === "review") return this.reviewProposal(context);
    if (
      this.workMode === "plan" &&
      (action === "create" || action === "replan")
    )
      return {
        blocked: true,
        reason: translate(this.workModeLocale, "plan.mode.writeBlocked"),
      };
    if (action === "status" || action === "show") {
      const plan = await this.current();
      return {
        decision: this.decision,
        plan,
        proposal: this.proposalDraft
          ? {
              id: this.proposalDraft.id,
              title: this.proposalDraft.proposal.title,
              saved: Boolean(this.proposalDraft.savedAt),
              started: Boolean(this.proposalDraft.startedAt),
              startedPlanId: this.proposalDraft.startedPlanId,
              createdAt: this.proposalDraft.createdAt,
              savedAt: this.proposalDraft.savedAt,
            }
          : null,
        ...(!plan
          ? {
              next: "No plan yet. Use autoplan_update or /plan create <plan.json>.",
            }
          : {}),
      };
    }
    if (action === "explain")
      return this.decision ?? { reason: "no-assessment-yet" };
    if (action === "history") return this.host.store.listRecords("revisions");
    if (action === "validate") {
      if (!args[0]) throw new Error("plan-file-required");
      const input = JSON.parse(
        await readFile(await contained(context.cwd, args[0]), "utf8"),
      );
      validatePlan(
        input.tasks,
        this.host.config.maxInitialTasks,
        this.host.config.maxDependencyDepth,
      );
      return { valid: true };
    }
    if (action === "create") {
      if (!args[0])
        return { instruction: "Use autoplan_update or create <plan.json>" };
      const input = JSON.parse(
        await readFile(await contained(context.cwd, args[0]), "utf8"),
      );
      return this.update(input);
    }
    if (action === "replan") {
      const evidence: ReplanEvidence = {
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
      const input = JSON.parse(
        await readFile(await contained(context.cwd, args[0]!), "utf8"),
      );
      return this.update(input, evidence);
    }
    throw new Error("unknown-command:" + action);
  }
}
export const createService = (host: Host) => new Planner(host);
