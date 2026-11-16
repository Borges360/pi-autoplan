import { Type } from "typebox";
import type { ExtensionContext, InputEvent, InputEventResult, MessageEndEvent, MessageEndEventResult, ModelSelectEvent } from "@earendil-works/pi-coding-agent";
import { type Assessment } from "./common/contracts.js";
import type { Host, Service, CommandContext } from "./common/runtime.js";
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
    type: "verified-gate-failure" | "dependency-missing" | "scope-expanded" | "constraint-changed" | "goal-changed" | "task-blocked";
    evidenceRef: string;
    verified: boolean;
    requestId?: string;
}
export declare const PlanInputSchema: Type.TObject<{
    objective: Type.TString;
    tasks: Type.TArray<Type.TObject<{
        id: Type.TString;
        objective: Type.TString;
        dependsOn: Type.TArray<Type.TString>;
        acceptance: Type.TArray<Type.TString>;
        scope: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
}>;
export declare function decidePlanMode(s: Assessment, dependencies?: number, multiSubsystem?: boolean): PlanDecision;
export declare function validatePlan(tasks: PlanTask[], maxTasks?: number, maxDepth?: number): void;
export declare function parsePlanProposalBlock(content: string, options?: {
    maxTasks?: number;
    maxDepth?: number;
}): {
    proposal: PlanProposalDraft;
    block: string;
} | undefined;
export declare function shouldReplan(e: ReplanEvidence): boolean;
export declare class Planner implements Service {
    readonly host: Host;
    private workMode;
    private discoveryStyle;
    private awaitingDiscoveryChoice;
    private pendingFirstInput?;
    private proposalDraft?;
    private workModeLocale;
    modeDescriptions: {
        auto: string;
        observe: string;
        off: string;
    };
    menuGroups: {
        Plan: string[];
        History: string[];
        Settings: string[];
    };
    menuInputs: {
        create: string;
        validate: string;
    };
    capabilities: string[];
    menu: string[];
    private decision?;
    constructor(host: Host);
    private isStoredProposal;
    sessionStart(context: ExtensionContext): Promise<void>;
    modelSelect(event: ModelSelectEvent, context: ExtensionContext): Promise<void>;
    private noModelSelected;
    private consumePendingInput;
    private selectDiscoveryStyle;
    input(event: InputEvent, context: ExtensionContext): Promise<InputEventResult | undefined>;
    planModePrompt(_prompt: string, _context: ExtensionContext): Promise<{
        protocol: string;
        mode: string;
        discoveryStyle: "propose" | "essential" | "stepwise";
        instructions: string[];
    } | undefined>;
    planModeMessageEnd(event: MessageEndEvent, context: ExtensionContext): Promise<MessageEndEventResult | undefined>;
    private reviewProposal;
    guardToolCall(_event: unknown, _context: ExtensionContext): Promise<{
        block: true;
        reason: string;
    } | undefined>;
    private toggleWorkMode;
    private configureShortcut;
    start(): Promise<void>;
    current(): Promise<AdaptivePlan | null>;
    update(input: {
        objective: string;
        tasks: PlanTask[];
        sourceProposalId?: string;
    }, evidence?: ReplanEvidence): Promise<AdaptivePlan>;
    requestReplan(evidence: ReplanEvidence): Promise<{
        requested: boolean;
        reason: string;
        requestId?: undefined;
        evidence?: undefined;
    } | {
        requested: boolean;
        requestId: `${string}-${string}-${string}-${string}-${string}`;
        evidence: {
            requestId: `${string}-${string}-${string}-${string}-${string}`;
            schemaVersion: 1;
            type: "verified-gate-failure" | "dependency-missing" | "scope-expanded" | "constraint-changed" | "goal-changed" | "task-blocked";
            evidenceRef: string;
            verified: boolean;
        };
        reason?: undefined;
    }>;
    prompt(prompt: string): Promise<{
        planning: string;
        instruction: string;
        current?: undefined;
        maxTasks?: undefined;
        replanRequests?: undefined;
    } | {
        planning: string;
        current: {
            id: string;
            revision: number;
            tasks: PlanTask[];
        } | null;
        instruction: string;
        maxTasks: number;
        replanRequests: ReplanEvidence[];
    } | undefined>;
    command(action: string, args: string[], context: CommandContext): Promise<unknown>;
}
export declare const createService: (host: Host) => Planner;
