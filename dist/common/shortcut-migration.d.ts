export declare const PLAN_SHORTCUT = "shift+tab";
export declare const THINKING_CYCLE_BINDING = "app.thinking.cycle";
export declare const THINKING_SHORTCUT_CANDIDATES: readonly ["ctrl+alt+shift+p", "ctrl+alt+shift+t", "ctrl+alt+shift+m", "ctrl+alt+shift+r", "ctrl+alt+shift+g", "ctrl+alt+shift+1", "ctrl+alt+shift+2", "ctrl+alt+shift+3"];
export type KeybindingValue = string | string[];
export type Keybindings = Record<string, unknown>;
export interface ShortcutMigration {
    schemaVersion: 1;
    status: "pending" | "active";
    written: string;
    previousFileExisted: boolean;
    previous: {
        present: boolean;
        value?: KeybindingValue;
    };
    previousEffective: KeybindingValue;
}
export interface KeybindingsDocument {
    path: string;
    raw: string | null;
    config: Keybindings;
}
export declare function keybindingKeys(value: unknown): string[];
export declare function keybindingValue(value: unknown): KeybindingValue | undefined;
export declare function sameKeybindingValue(left: unknown, right: unknown): boolean;
export declare function effectiveThinkingBinding(effective: Keybindings): KeybindingValue;
export declare function freeThinkingShortcuts(effective: Keybindings, userConfig?: Keybindings): string[];
export declare function planShortcutIsFree(agentDir: string): boolean;
export declare function currentThinkingBinding(config: Keybindings): unknown;
export declare function keybindingLabel(value: unknown): string;
export declare function readKeybindingsDocument(agentDir: string): Promise<KeybindingsDocument>;
export declare function readShortcutMigration(agentDir: string): Promise<ShortcutMigration | undefined>;
export declare function applyShortcutMigration(options: {
    agentDir: string;
    shortcut: string;
    effectiveBindings: Keybindings;
    expectedRaw: string | null;
}): Promise<ShortcutMigration>;
export declare function restoreShortcutMigration(agentDir: string): Promise<{
    restored: true;
} | {
    restored: false;
    reason: string;
}>;
export declare function shortcutMigrationPreview(agentDir: string): Promise<{
    migration?: ShortcutMigration;
    current: unknown;
    matchesWritten: boolean;
}>;
