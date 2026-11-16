import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export const PLAN_SHORTCUT = "shift+tab";
export const THINKING_CYCLE_BINDING = "app.thinking.cycle";

export const THINKING_SHORTCUT_CANDIDATES = [
  "ctrl+alt+shift+p",
  "ctrl+alt+shift+t",
  "ctrl+alt+shift+m",
  "ctrl+alt+shift+r",
  "ctrl+alt+shift+g",
  "ctrl+alt+shift+1",
  "ctrl+alt+shift+2",
  "ctrl+alt+shift+3",
] as const;

export type KeybindingValue = string | string[];
export type Keybindings = Record<string, unknown>;

export interface ShortcutMigration {
  schemaVersion: 1;
  status: "pending" | "active";
  written: string;
  previousFileExisted: boolean;
  previous: { present: boolean; value?: KeybindingValue };
  previousEffective: KeybindingValue;
}

export interface KeybindingsDocument {
  path: string;
  raw: string | null;
  config: Keybindings;
}

const LEGACY_THINKING_BINDING = "cycleThinkingLevel";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function keybindingKeys(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value.toLowerCase()];
  if (
    Array.isArray(value) &&
    value.every((key) => typeof key === "string" && key.length > 0)
  )
    return value.map((key) => key.toLowerCase());
  return [];
}

export function keybindingValue(value: unknown): KeybindingValue | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    Array.isArray(value) &&
    value.every((key) => typeof key === "string" && key.length > 0)
  )
    return [...value];
  if (Array.isArray(value) && value.length === 0) return [];
  return undefined;
}

export function sameKeybindingValue(left: unknown, right: unknown): boolean {
  const a = keybindingValue(left);
  const b = keybindingValue(right);
  return a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export function effectiveThinkingBinding(
  effective: Keybindings,
): KeybindingValue {
  return keybindingValue(effective[THINKING_CYCLE_BINDING]) ?? PLAN_SHORTCUT;
}

export function freeThinkingShortcuts(
  effective: Keybindings,
  userConfig: Keybindings = {},
): string[] {
  const occupied = new Set<string>();
  for (const [binding, value] of Object.entries(effective)) {
    if (binding === THINKING_CYCLE_BINDING) continue;
    for (const key of keybindingKeys(value)) occupied.add(key);
  }
  for (const [binding, value] of Object.entries(userConfig)) {
    if (binding === THINKING_CYCLE_BINDING || binding === LEGACY_THINKING_BINDING)
      continue;
    for (const key of keybindingKeys(value)) occupied.add(key);
  }
  return THINKING_SHORTCUT_CANDIDATES.filter(
    (candidate) => !occupied.has(candidate),
  );
}

export function planShortcutIsFree(agentDir: string): boolean {
  try {
    const document = requireKeybindingsDocumentSync(agentDir);
    const configured = currentThinkingBinding(document.config);
    if (keybindingValue(configured) === undefined) return false;
    return !keybindingKeys(configured).includes(PLAN_SHORTCUT);
  } catch {
    // A malformed or unreadable keybindings file must never make the extension
    // claim a shortcut that Pi may still assign to thinking-level cycling.
    return false;
  }
}

function requireKeybindingsDocumentSync(agentDir: string): KeybindingsDocument {
  const path = join(agentDir, "keybindings.json");
  try {
    const raw = readFileSync(path, "utf8");
    const config = parseKeybindings(raw);
    return { path, raw, config };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, raw: null, config: {} };
    throw error;
  }
}

export function currentThinkingBinding(config: Keybindings): unknown {
  if (Object.hasOwn(config, THINKING_CYCLE_BINDING))
    return config[THINKING_CYCLE_BINDING];
  if (Object.hasOwn(config, LEGACY_THINKING_BINDING))
    return config[LEGACY_THINKING_BINDING];
  return PLAN_SHORTCUT;
}

export function keybindingLabel(value: unknown): string {
  const keys = keybindingKeys(value);
  return keys.length ? keys.join(" / ") : "unassigned";
}

function parseKeybindings(raw: string): Keybindings {
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("pi-keybindings-invalid-json");
  }
  if (!isRecord(value)) throw new Error("pi-keybindings-invalid-root");
  return value;
}

export async function readKeybindingsDocument(
  agentDir: string,
): Promise<KeybindingsDocument> {
  const path = join(agentDir, "keybindings.json");
  try {
    const raw = await readFile(path, "utf8");
    return { path, raw, config: parseKeybindings(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, raw: null, config: {} };
    throw error;
  }
}

function migrationPath(agentDir: string): string {
  return join(agentDir, "state", "pi-autoplan", "shortcut-migration.json");
}

function validMigration(value: unknown): value is ShortcutMigration {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (value.status !== "pending" && value.status !== "active") return false;
  if (typeof value.written !== "string" || !value.written) return false;
  if (typeof value.previousFileExisted !== "boolean") return false;
  if (!isRecord(value.previous) || typeof value.previous.present !== "boolean")
    return false;
  if (
    value.previous.present &&
    keybindingValue(value.previous.value) === undefined
  )
    return false;
  return keybindingValue(value.previousEffective) !== undefined;
}

export async function readShortcutMigration(
  agentDir: string,
): Promise<ShortcutMigration | undefined> {
  try {
    const value = JSON.parse(await readFile(migrationPath(agentDir), "utf8"));
    if (!validMigration(value)) throw new Error("pi-shortcut-migration-invalid");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function currentOwnThinkingValue(config: Keybindings): {
  present: boolean;
  value?: KeybindingValue;
} {
  if (!Object.hasOwn(config, THINKING_CYCLE_BINDING))
    return { present: false };
  const value = keybindingValue(config[THINKING_CYCLE_BINDING]);
  if (value === undefined) throw new Error("pi-thinking-binding-invalid");
  return { present: true, value };
}

function effectiveMatchesDocument(
  effective: Keybindings,
  userConfig: Keybindings,
): boolean {
  const configured = currentThinkingBinding(userConfig);
  const expected = effectiveThinkingBinding(effective);
  const normalizedConfigured = keybindingValue(configured);
  if (!normalizedConfigured) return false;
  return JSON.stringify(keybindingKeys(normalizedConfigured)) ===
    JSON.stringify(keybindingKeys(expected));
}

export async function applyShortcutMigration(options: {
  agentDir: string;
  shortcut: string;
  effectiveBindings: Keybindings;
  expectedRaw: string | null;
}): Promise<ShortcutMigration> {
  const { agentDir, shortcut, effectiveBindings, expectedRaw } = options;
  if (!(THINKING_SHORTCUT_CANDIDATES as readonly string[]).includes(shortcut))
    throw new Error("pi-thinking-binding-not-supported");
  const existing = await readShortcutMigration(agentDir);
  if (existing) throw new Error("pi-shortcut-migration-active");
  const document = await readKeybindingsDocument(agentDir);
  if (document.raw !== expectedRaw) throw new Error("pi-keybindings-changed");
  if (!effectiveMatchesDocument(effectiveBindings, document.config))
    throw new Error("pi-thinking-binding-changed");
  if (!freeThinkingShortcuts(effectiveBindings, document.config).includes(shortcut))
    throw new Error("pi-thinking-binding-no-longer-free");

  const migration: ShortcutMigration = {
    schemaVersion: 1,
    status: "pending",
    written: shortcut,
    previousFileExisted: document.raw !== null,
    previous: currentOwnThinkingValue(document.config),
    previousEffective: effectiveThinkingBinding(effectiveBindings),
  };
  const statePath = migrationPath(agentDir);
  await writeAtomic(statePath, JSON.stringify(migration, null, 2) + "\n");

  // The explicit preview is separated from this function. Re-read immediately
  // before writing so a settings edit made while the dialog was open is kept.
  const latest = await readKeybindingsDocument(agentDir);
  if (latest.raw !== expectedRaw) {
    await unlink(statePath).catch(() => {});
    throw new Error("pi-keybindings-changed");
  }
  latest.config[THINKING_CYCLE_BINDING] = shortcut;
  try {
    await writeAtomic(
      latest.path,
      JSON.stringify(latest.config, null, 2) + "\n",
    );
  } catch (error) {
    await unlink(statePath).catch(() => {});
    throw error;
  }
  migration.status = "active";
  await writeAtomic(statePath, JSON.stringify(migration, null, 2) + "\n");
  return migration;
}

export async function restoreShortcutMigration(
  agentDir: string,
): Promise<{ restored: true } | { restored: false; reason: string }> {
  const migration = await readShortcutMigration(agentDir);
  if (!migration) return { restored: false, reason: "pi-shortcut-migration-missing" };
  const document = await readKeybindingsDocument(agentDir);
  const current = currentThinkingBinding(document.config);
  if (!sameKeybindingValue(current, migration.written)) {
    return { restored: false, reason: "pi-thinking-binding-changed" };
  }
  if (migration.previous.present)
    document.config[THINKING_CYCLE_BINDING] = migration.previous.value;
  else delete document.config[THINKING_CYCLE_BINDING];
  if (!migration.previousFileExisted && Object.keys(document.config).length === 0)
    await unlink(document.path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  else
    await writeAtomic(document.path, JSON.stringify(document.config, null, 2) + "\n");
  await unlink(migrationPath(agentDir));
  return { restored: true };
}

export async function shortcutMigrationPreview(
  agentDir: string,
): Promise<{
  migration?: ShortcutMigration;
  current: unknown;
  matchesWritten: boolean;
}> {
  const [migration, document] = await Promise.all([
    readShortcutMigration(agentDir),
    readKeybindingsDocument(agentDir),
  ]);
  const current = currentThinkingBinding(document.config);
  return {
    migration,
    current,
    matchesWritten: migration
      ? sameKeybindingValue(current, migration.written)
      : false,
  };
}
