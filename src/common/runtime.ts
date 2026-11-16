import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  InputEvent,
  InputEventResult,
  MessageEndEvent,
  MessageEndEventResult,
  ModelSelectEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { loadConfig, saveConfig, type Config } from "./config.js";
import {
  loadProjectLocale,
  saveProjectLocale,
  translate,
  type Locale,
} from "./i18n.js";
import {
  FileStorage,
  SqliteStorage,
  type StorageBase,
  type PortableSnapshot,
} from "./storage.js";
import { DurableStorage } from "./durable.js";
import { Interop, type EventBus } from "./contracts.js";
import {
  atomicWrite,
  canonical,
  digest,
  projectKey,
  redact,
} from "./security.js";

export interface CommandContext {
  cwd: string;
  trusted: boolean;
  signal?: AbortSignal;
  locale?: Locale;
  hostContext?: ExtensionContext;
  commandContext?: ExtensionCommandContext;
}
export interface Service {
  capabilities: string[];
  menu: string[];
  menuGroups?: Record<string, string[]>;
  menuInputs?: Record<string, string>;
  modeDescriptions?: Partial<Record<"auto" | "observe" | "off", string>>;
  command(
    action: string,
    args: string[],
    context: CommandContext,
  ): Promise<unknown>;
  start?(): Promise<void>;
  sessionStart?(context: ExtensionContext): Promise<void>;
  close?(): Promise<void>;
  input?(
    event: InputEvent,
    context: ExtensionContext,
  ): Promise<InputEventResult | undefined>;
  modelSelect?(
    event: ModelSelectEvent,
    context: ExtensionContext,
  ): Promise<void>;
  prompt?(prompt: string, context: ExtensionContext): Promise<unknown>;
  planModePrompt?(prompt: string, context: ExtensionContext): Promise<unknown>;
  planModeMessageEnd?(
    event: MessageEndEvent,
    context: ExtensionContext,
  ): Promise<MessageEndEventResult | undefined>;
  guardToolCall?(
    event: unknown,
    context: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined>;
  toolCall?(
    event: unknown,
    context: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined>;
  toolResult?(event: unknown, context: ExtensionContext): Promise<void>;
  messageEnd?(event: unknown, context: ExtensionContext): Promise<void>;
  settle?(
    event: unknown,
    context: ExtensionContext,
  ): Promise<{ continue?: boolean; entries?: unknown[] } | undefined>;
}
export type ServiceFactory = (host: Host) => Service;
export const toolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(redact(value)) }],
  details: redact(value),
});
export class Host {
  config!: Config;
  store!: StorageBase;
  interop!: Interop;
  service!: Service;
  key = "";
  private started = false;
  private starting?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  migrationFault?: (phase: "after-seal" | "after-pointer") => void;
  constructor(
    readonly extension: string,
    readonly factory: ServiceFactory,
    readonly cwd: string,
    readonly bus: EventBus,
    readonly trusted = false,
    readonly api?: ExtensionAPI,
  ) {}
  async start() {
    if (this.started) return;
    if (!this.starting)
      this.starting = this.initialize().finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }
  private async initialize() {
    try {
      await this.initializeResources();
    } catch (error) {
      this.interop?.close();
      await this.service?.close?.().catch(() => {});
      await this.store?.close().catch(() => {});
      throw error;
    }
  }
  private async initializeResources() {
    this.config = await loadConfig(this.extension, this.cwd, this.trusted);
    this.key = await projectKey(this.cwd);
    const base = join(this.config.storage.root, "projects", this.key);
    await mkdir(base, { recursive: true, mode: 0o700 });
    let backend = this.config.storage.backend;
    let root = base;
    try {
      const pointer = JSON.parse(
        await readFile(join(base, "backend.json"), "utf8"),
      );
      if (
        !["files", "sqlite", "durable"].includes(pointer.backend) ||
        !/^migration-[a-zA-Z0-9-]+$/.test(pointer.directory)
      )
        throw new Error("invalid-backend-pointer");
      backend = pointer.backend;
      root = join(base, pointer.directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.store =
      backend === "files"
        ? new FileStorage({ root, extension: this.extension })
        : backend === "sqlite"
          ? new SqliteStorage({ root, extension: this.extension })
          : new DurableStorage({ root, extension: this.extension });
    await this.store.open();
    const metadata = await this.store.getMetadata();
    if (metadata.migratedTo) {
      // An old backend is only selected when the pointer switch did not commit.
      // Its own journal is still authoritative, so rollback never replays effects.
      if (metadata.migrationHost !== hostname() || !metadata.migrationPid)
        throw new Error("migration-owner-review-required");
      let dead = false;
      try {
        process.kill(metadata.migrationPid, 0);
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!dead) throw new Error("migration-in-progress");
      await this.store.rollbackMigration(metadata.migratedTo);
    }
    this.interop = new Interop(
      this.extension,
      this.bus,
      this.key,
      this.config.disabledIntegrations,
    );
    this.service = this.factory(this);
    await this.service.start?.();
    this.interop.start(this.service.capabilities);
    this.started = true;
  }
  async close() {
    await this.starting?.catch(() => {});
    if (!this.started) return;
    this.interop.close();
    await this.service.close?.();
    await this.store.close();
    this.started = false;
  }
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  async configure(patch: Partial<Config>) {
    this.config = await loadConfig(this.extension, this.cwd, this.trusted, {
      ...this.config,
      ...patch,
    });
    await saveConfig(this.extension, this.config);
    return this.config;
  }
  async doctor() {
    const recovery = await this.store.recover();
    return {
      extension: this.extension,
      version: "0.1.0",
      pi: "1.2.0",
      node: process.versions.node,
      enabled: this.config.enabled,
      mode: this.config.mode,
      storage: this.store.constructor.name,
      recovery,
      integrations: {
        failures: this.interop.failures,
        fallbacks: this.interop.fallbacks,
        incompatible: this.interop.incompatible,
      },
      standalone: true,
    };
  }
  async command(
    action: string,
    args: string[],
    context: CommandContext,
  ): Promise<unknown> {
    if (action === "doctor") return this.doctor();
    if (action === "config") return this.config;
    if (action === "off" || action === "auto" || action === "observe")
      return this.configure({ enabled: action !== "off", mode: action });
    if (action === "storage")
      return args[0] === "migrate"
        ? this.migrate(args[1])
        : {
            backend: this.store.constructor.name,
            root: this.store.options.root,
          };
    return this.service.command(action, args, context);
  }
  async migrate(backend?: string) {
    if (backend !== "files" && backend !== "sqlite" && backend !== "durable")
      throw new Error("supported-backends: files, sqlite, durable");
    const activeChildren = await this.store.listRecords<{ status: string }>(
      "children",
    );
    const activeRuns = await this.store.listRecords<{ status: string }>("runs");
    if (
      activeChildren.some((c) => c.status === "running") ||
      activeRuns.some((r) => r.status === "active")
    )
      throw new Error("pause-active-work-before-migration");
    const sourceStore = this.store;
    const migrationId = crypto.randomUUID();
    const base = join(this.config.storage.root, "projects", this.key);
    const directory = "migration-" + migrationId;
    const root = join(base, directory);
    const target =
      backend === "files"
        ? new FileStorage({ root, extension: this.extension })
        : backend === "sqlite"
          ? new SqliteStorage({ root, extension: this.extension })
          : new DurableStorage({ root, extension: this.extension });
    await target.open();
    let switched = false;
    let sealed = false;
    let previousPointer: string | undefined;
    try {
      previousPointer = await readFile(join(base, "backend.json"), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    try {
      await this.store.transact(async (source) => {
        const frozen = structuredClone(source);
        const logical = (s: PortableSnapshot) =>
          digest({
            metadata: s.metadata,
            records: s.records,
            events: s.events,
            blobs: s.blobs,
          });
        await target.importSnapshot(frozen);
        if (logical(await target.exportSnapshot()) !== logical(frozen))
          throw new Error("migration-parity-failed");
        await target.recover();
        source.metadata.migratedTo = root;
        source.metadata.migrationPid = process.pid;
        source.metadata.migrationHost = hostname();
      });
      sealed = true;
      this.migrationFault?.("after-seal");
      await atomicWrite(
        join(base, "backend.json"),
        canonical({
          schemaVersion: 1,
          backend,
          directory,
          migrationId,
          sourceRoot: this.store.options.root,
        }),
      );
      switched = true;
      this.migrationFault?.("after-pointer");
      await target.recover();
      await this.service.close?.();
      this.store = target;
      // Services capture Host, never a stale store handle; restart listeners after backend replacement.
      this.interop.close();
      this.interop = new Interop(
        this.extension,
        this.bus,
        this.key,
        this.config.disabledIntegrations,
      );
      this.service = this.factory(this);
      await this.service.start?.();
      this.interop.start(this.service.capabilities);
      await sourceStore.close();
      return { migrationId, backend, verified: true, backupPreserved: true };
    } catch (e) {
      if (switched) {
        if (previousPointer)
          await atomicWrite(join(base, "backend.json"), previousPointer);
        else await unlink(join(base, "backend.json"));
      }
      this.store = sourceStore;
      if (sealed) await sourceStore.rollbackMigration(root);
      await target.close();
      throw e;
    }
  }
}
export function register(
  pi: ExtensionAPI,
  extension: string,
  command: string,
  factory: ServiceFactory,
  tools: ToolDefinition[] = [],
  aliases: string[] = [],
) {
  let host: Host | undefined;
  const get = async (ctx: ExtensionContext) => {
    if (!host || host.cwd !== ctx.cwd) {
      await host?.close();
      host = new Host(
        extension,
        factory,
        ctx.cwd,
        pi.events,
        ctx.isProjectTrusted(),
        pi,
      );
      await host.start();
    }
    await host.start();
    return host;
  };
  const show = (value: unknown) =>
    pi.sendMessage({
      customType: extension,
      content: JSON.stringify(redact(value), null, 2),
      display: true,
    });
  pi.on("session_start", async (_e, ctx) => {
    const h = await get(ctx);
    await h.serial(
      () => h.service.sessionStart?.(ctx) ?? Promise.resolve(),
    );
  });
  pi.on("session_shutdown", async () => {
    await host?.close();
    host = undefined;
  });
  const commandDefinition = {
    description:
      `${extension}: status, explain, config, doctor` +
      (extension === "pi-autoplan" ? ", plan-mode" : ""),
    handler: async (args, ctx) => {
      const h = await get(ctx);
      let parts = args.trim().split(/\s+/).filter(Boolean);
      const interactive = ctx.mode === "tui" && ctx.hasUI;
      const localized = extension === "pi-autoplan" && interactive;
      const loadedLocale = localized
        ? await loadProjectLocale(ctx.cwd, ctx.isProjectTrusted())
        : { locale: "en" as Locale, invalid: false };
      let locale = loadedLocale.locale;
      const tr = (key: string) => translate(locale, key);
      const displayNames: Record<string, string> = {
        longrun: "Longrun",
        autoskills: "AutoSkills",
        autoplan: "Plan",
        plan: "Plan",
        subagents: "Subagent Router",
        mcprouter: "MCP Router",
      };
      const displayName = displayNames[command] ?? extension;
      const baseGroups = h.service.menuGroups ?? {
        Actions: h.service.menu,
        Settings: ["config", "doctor"],
      };
      const groups: Record<string, string[]> = Object.fromEntries(
        Object.entries(baseGroups).map(([group, actions]) => [group, [...actions]]),
      );
      if (localized)
        groups.Settings = [
          ...(groups.Settings ?? []).filter((action) => action !== "language"),
          "language",
        ];
      const modeOptions = ["auto", "observe", "off"] as const;
      const languageOptions: Locale[] = ["en", "pt-BR"];
      const formatKey = (key: string) =>
        ({
          enter: "Enter",
          return: "Enter",
          escape: "Esc",
          "ctrl+c": "Ctrl+C",
          up: "↑",
          down: "↓",
        })[key.toLowerCase()] ?? key.toUpperCase();
      const keyText = (keys: string[], fallback: string) =>
        keys.map(formatKey).join(" / ") || fallback;
      type PlannerMode = "auto" | "observe" | "off";
      const currentMode = (): PlannerMode =>
        !h.config.enabled || h.config.mode === "off"
          ? "off"
          : h.config.mode === "observe"
            ? "observe"
            : "auto";
      const modeLabel = (mode: string) =>
        tr(
          mode === "observe"
            ? "mode.observe"
            : mode === "off"
              ? "mode.off"
              : "mode.automatic",
        );
      const modeDescription = (mode: PlannerMode) => {
        if (localized)
          return tr(
            mode === "observe"
              ? "mode.description.observe"
              : mode === "off"
                ? "mode.description.off"
                : "mode.description.automatic",
          );
        return (
          h.service.modeDescriptions?.[mode] ??
          (mode === "observe"
            ? "Show decisions without acting automatically."
            : mode === "off"
              ? "Disable this extension's automatic behavior."
              : "Allow eligible actions when this extension's policy permits.")
        );
      };
      const localeLabel = (value: Locale) =>
        tr(value === "pt-BR" ? "locale.portuguese" : "locale.english");
      const groupLabel = (value: string) =>
        localized
          ? tr(
              value === "Plan"
                ? "group.plan"
                : value === "History"
                  ? "group.history"
                  : value === "Settings"
                    ? "group.settings"
                    : value,
            )
          : value;
      const actionLabel = (value: string) => {
        if (!localized) return value;
        const [action, ...rest] = value.split(/\s+/);
        const label = tr(`action.${action}`);
        return label === `action.${action}`
          ? value
          : [label, ...rest].join(" ");
      };
      const inputLabel = (action: string, fallback: string) =>
        localized && action === "validate"
          ? tr("input.validate")
          : localized && action === "create"
            ? tr("input.create")
            : fallback;
      const actionFailureStatus = (action: string, error: unknown) => {
        if (!["create", "validate", "replan"].includes(action))
          return tr("notice.actionFailed");
        const code =
          error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : undefined;
        if (code === "ENOENT") return tr("notice.planFileNotFound");
        if (code === "EACCES" || code === "EPERM")
          return tr("notice.planFileUnreadable");
        if (error instanceof SyntaxError)
          return tr("notice.planFileInvalidJson");
        return tr("notice.actionFailed");
      };

      const segmenter = new Intl.Segmenter(undefined, {
        granularity: "grapheme",
      });
      const graphemes = (value: string) =>
        Array.from(segmenter.segment(value), (part) => part.segment);
      const graphemeWidth = (value: string) => {
        const points = Array.from(value, (character) =>
          character.codePointAt(0) ?? 0,
        );
        if (!points.length) return 0;
        if (
          points.some(
            (point) =>
              point === 0x200d ||
              point === 0xfe0f ||
              (point >= 0x1f1e6 && point <= 0x1f1ff) ||
              (point >= 0x1f000 && point <= 0x1faff),
          )
        )
          return 2;
        let width = 0;
        for (const point of points) {
          const character = String.fromCodePoint(point);
          if (
            /\p{Mark}/u.test(character) ||
            point === 0x200d ||
            point === 0xfe0e ||
            point === 0xfe0f
          )
            continue;
          const wide =
            point >= 0x1100 &&
            (point <= 0x115f ||
              point === 0x2329 ||
              point === 0x232a ||
              (point >= 0x2e80 && point <= 0xa4cf) ||
              (point >= 0xac00 && point <= 0xd7a3) ||
              (point >= 0xf900 && point <= 0xfaff) ||
              (point >= 0xfe10 && point <= 0xfe19) ||
              (point >= 0xfe30 && point <= 0xfe6f) ||
              (point >= 0xff00 && point <= 0xff60) ||
              (point >= 0xffe0 && point <= 0xffe6) ||
              (point >= 0x20000 && point <= 0x3fffd));
          width = Math.max(width, wide ? 2 : 1);
        }
        return width;
      };
      const fitLine = (value: string, width: number) => {
        const cells = Math.max(1, Math.floor(width));
        const clean = String(value).replace(/[\r\n\t]/g, " ").replace(/\p{Cc}/gu, " ");
        const parts = graphemes(clean);
        const totalWidth = parts.reduce(
          (total, part) => total + graphemeWidth(part),
          0,
        );
        if (totalWidth <= cells)
          return clean + " ".repeat(Math.max(0, cells - totalWidth));
        let output = "";
        let used = 0;
        for (const part of parts) {
          const partWidth = graphemeWidth(part);
          if (partWidth && used + partWidth > cells) break;
          output += part;
          used += partWidth;
        }
        if (used < cells) {
          output += "…";
          used++;
        }
        return output + " ".repeat(Math.max(0, cells - used));
      };

      const fallbackModePanel = async () => {
        while (true) {
          const savedMode = currentMode();
          const selected = await ctx.ui.select(
            displayName +
              " / " +
              groupLabel("Settings") +
              " / " +
              tr("page.mode") +
              " — " +
              tr("page.currentMode") +
              ": " +
              modeLabel(savedMode),
            modeOptions.map(modeLabel),
          );
          if (!selected) return;
          const draft = modeOptions.find((mode) => modeLabel(mode) === selected);
          if (!draft) return;
          const decision = await ctx.ui.select(
            tr("page.draftMode") + ": " + modeLabel(draft),
            [tr("key.save") + " draft", tr("key.discard") + " draft"],
          );
          if (decision === tr("key.discard") + " draft") continue;
          if (decision !== tr("key.save") + " draft") return;
          try {
            await h.serial(() =>
              h.command(draft, [], {
                cwd: ctx.cwd,
                trusted: ctx.isProjectTrusted(),
                locale,
                hostContext: ctx,
                commandContext: ctx,
                signal: ctx.signal,
              }),
            );
            return;
          } catch {
            ctx.ui.notify(tr("notice.modeSaveFailed"));
          }
        }
      };
      const fallbackLanguagePanel = async () => {
        const savedLocale = locale;
        while (true) {
          const selected = await ctx.ui.select(
            displayName +
              " / " +
              groupLabel("Settings") +
              " / " +
              tr("page.language") +
              " — " +
              tr("page.currentLanguage") +
              ": " +
              localeLabel(savedLocale),
            languageOptions.map(localeLabel),
          );
          if (!selected) {
            locale = savedLocale;
            return;
          }
          const draft = languageOptions.find(
            (value) => localeLabel(value) === selected,
          );
          if (!draft) {
            locale = savedLocale;
            return;
          }
          locale = draft;
          const decision = await ctx.ui.select(
            tr("page.draftLanguage") + ": " + localeLabel(draft),
            [tr("key.save") + " language", tr("key.discard") + " language"],
          );
          if (decision === tr("key.discard") + " language") {
            locale = savedLocale;
            return;
          }
          if (decision !== tr("key.save") + " language") {
            locale = savedLocale;
            return;
          }
          try {
            await saveProjectLocale(
              ctx.cwd,
              ctx.isProjectTrusted(),
              draft,
              ctx.signal,
            );
            return;
          } catch {
            ctx.ui.notify(
              ctx.isProjectTrusted()
                ? tr("notice.languageSaveFailed")
                : tr("notice.trustedProjectRequired"),
            );
          }
        }
      };

      type MenuExit =
        | { type: "close" }
        | { type: "input"; title: string; action: string; args: string[] };
      type PendingMenuAction = {
        action: string;
        args: string[];
        label: string;
      };
      const showDashboard = async (
        initialPage: "groups" | "mode" | "language" = "groups",
      ): Promise<boolean> => {
        if (typeof ctx.ui.custom !== "function") return false;
        const groupNames = Object.keys(groups);
        let page: "groups" | "actions" | "mode" | "language" = initialPage;
        let selectedGroup =
          initialPage === "mode" || initialPage === "language"
            ? "Settings"
            : "";
        let selectedIndex =
          initialPage === "mode"
            ? Math.max(0, modeOptions.findIndex((mode) => mode === currentMode()))
            : initialPage === "language"
              ? Math.max(0, languageOptions.findIndex((value) => value === locale))
              : 0;
        let savedMode = currentMode();
        let draftMode = savedMode;
        let savedLocale = locale;
        let draftLocale = savedLocale;
        let status = loadedLocale.invalid ? tr("notice.invalidLocale") : "";
        let escapeArmed = false;
        let pendingAction: PendingMenuAction | undefined;

        while (true) {
          let exit: MenuExit | undefined;
          try {
            exit = await ctx.ui.custom<MenuExit>(
              (tui, theme, keybindings, done) => {
                let disposed = false;
                let busy = false;
                let operationId = 0;
                let operation: AbortController | undefined;
                const confirmKeys = keyText(
                  keybindings.getKeys("tui.select.confirm"),
                  "Enter",
                );
                const cancelKeys = keyText(
                  keybindings.getKeys("tui.select.cancel"),
                  "Esc",
                );
                const upKeys = keyText(
                  keybindings.getKeys("tui.select.up"),
                  "↑",
                );
                const downKeys = keyText(
                  keybindings.getKeys("tui.select.down"),
                  "↓",
                );
                const finish = (result: MenuExit) => {
                  if (disposed) return;
                  disposed = true;
                  operation?.abort();
                  ctx.signal?.removeEventListener("abort", onContextAbort);
                  done(result);
                };
                const onContextAbort = () => finish({ type: "close" });
                ctx.signal?.addEventListener("abort", onContextAbort, {
                  once: true,
                });
                if (ctx.signal?.aborted) onContextAbort();
                const isKey = (
                  data: string,
                  binding: Parameters<typeof keybindings.matches>[1],
                  fallback: string[],
                ) => {
                  try {
                    if (keybindings.matches(data, binding)) return true;
                  } catch {
                    // The host key matcher is optional in test and fallback UIs.
                  }
                  return fallback.includes(data.toLowerCase());
                };
                const requestRender = () => {
                  if (!disposed) tui.requestRender();
                };
                const startOperation = (
                  action: string,
                  args: string[],
                  label: string,
                  modeToSave?: "auto" | "observe" | "off",
                ) => {
                  if (busy || disposed) return;
                  const controller = new AbortController();
                  const id = ++operationId;
                  operation = controller;
                  busy = true;
                  escapeArmed = false;
                  status = modeToSave
                    ? tr("notice.savingMode")
                    : tr("notice.running") + " " + label + "…";
                  requestRender();
                  void h
                    .serial(() => {
                      if (controller.signal.aborted)
                        throw new Error("operation-cancelled");
                      return h.command(action, args, {
                        cwd: ctx.cwd,
                        trusted: ctx.isProjectTrusted(),
                        locale,
                        hostContext: ctx,
                        commandContext: ctx,
                        signal: controller.signal,
                      });
                    })
                    .then((result) => {
                      if (disposed || id !== operationId) return;
                      operation = undefined;
                      busy = false;
                      if (controller.signal.aborted) {
                        status = tr("notice.cancelled");
                      } else if (modeToSave) {
                        savedMode = modeToSave;
                        draftMode = modeToSave;
                        status =
                          tr("notice.modeSaved") + ": " + modeLabel(modeToSave) + ".";
                      } else {
                        show(result);
                        status = tr("notice.completed") + ": " + label + ".";
                      }
                      requestRender();
                    })
                    .catch((error: unknown) => {
                      if (disposed || id !== operationId) return;
                      operation = undefined;
                      busy = false;
                      status = controller.signal.aborted
                        ? tr("notice.cancelled")
                        : modeToSave
                          ? tr("notice.modeSaveFailed")
                          : actionFailureStatus(action, error);
                      requestRender();
                    });
                };
                const startLocaleSave = (localeToSave: Locale) => {
                  if (busy || disposed) return;
                  const controller = new AbortController();
                  const id = ++operationId;
                  operation = controller;
                  busy = true;
                  escapeArmed = false;
                  status = tr("notice.savingLanguage");
                  requestRender();
                  void saveProjectLocale(
                    ctx.cwd,
                    ctx.isProjectTrusted(),
                    localeToSave,
                    controller.signal,
                  )
                    .then(() => {
                      if (disposed || id !== operationId) return;
                      operation = undefined;
                      busy = false;
                      if (controller.signal.aborted) {
                        status = tr("notice.cancelled");
                      } else {
                        savedLocale = localeToSave;
                        draftLocale = localeToSave;
                        locale = localeToSave;
                        status = tr("notice.languageSaved");
                      }
                      requestRender();
                    })
                    .catch(() => {
                      if (disposed || id !== operationId) return;
                      operation = undefined;
                      busy = false;
                      status = controller.signal.aborted
                        ? tr("notice.cancelled")
                        : ctx.isProjectTrusted()
                          ? tr("notice.languageSaveFailed")
                          : tr("notice.trustedProjectRequired");
                      requestRender();
                    });
                };
                const selectedLabels = () =>
                  page === "groups"
                    ? groupNames.map(groupLabel)
                    : page === "actions"
                      ? (groups[selectedGroup] ?? []).map(actionLabel)
                      : page === "mode"
                        ? modeOptions.map(modeLabel)
                        : languageOptions.map(localeLabel);
                const lines: Array<{
                  text: string;
                  heading?: boolean;
                  selected?: boolean;
                }> = [];
                const push = (
                  text: string,
                  flags: { heading?: boolean; selected?: boolean } = {},
                ) => lines.push({ text, ...flags });

                const component = {
                  render(width: number) {
                    lines.length = 0;
                    if (page === "groups") {
                      push(displayName, { heading: true });
                      push("");
                      push(tr("page.currentMode") + ": " + modeLabel(savedMode));
                      push("");
                      push(tr("heading.groups"), { heading: true });
                      groupNames.forEach((group, index) =>
                        push((index === selectedIndex ? "› " : "  ") + groupLabel(group), {
                          selected: index === selectedIndex,
                        }),
                      );
                      push("");
                      push(
                        upKeys +
                          " / " +
                          downKeys +
                          " " +
                          tr("key.move") +
                          "    " +
                          confirmKeys +
                          " " +
                          tr("key.open") +
                          "    " +
                          cancelKeys +
                          " " +
                          tr("key.close"),
                      );
                    } else if (page === "actions") {
                      push(displayName + " / " + groupLabel(selectedGroup), {
                        heading: true,
                      });
                      push("");
                      push(tr("heading.actions"), { heading: true });
                      (groups[selectedGroup] ?? []).forEach((action, index) =>
                        push((index === selectedIndex ? "› " : "  ") + actionLabel(action), {
                          selected: index === selectedIndex,
                        }),
                      );
                      push("");
                      push(
                        upKeys +
                          " / " +
                          downKeys +
                          " " +
                          tr("key.move") +
                          "    " +
                          confirmKeys +
                          " " +
                          tr("key.open") +
                          "    " +
                          cancelKeys +
                          " " +
                          tr("key.back"),
                      );
                    } else if (page === "mode") {
                      push(displayName + " / " + groupLabel("Settings") + " / " + tr("page.mode"), {
                        heading: true,
                      });
                      push("");
                      push(tr("page.currentMode") + ": " + modeLabel(savedMode));
                      push(tr("page.draftMode") + ": " + modeLabel(draftMode));
                      push("");
                      push(tr("page.chooseMode"), { heading: true });
                      modeOptions.forEach((mode, index) =>
                        push(
                          (index === selectedIndex ? "› " : "  ") +
                            modeLabel(mode) +
                            (mode === savedMode ? "  " + tr("mark.saved") : "") +
                            (mode === draftMode ? "  " + tr("mark.draft") : ""),
                          { selected: index === selectedIndex },
                        ),
                      );
                      push("");
                      const selected = modeOptions[selectedIndex];
                      push(selected ? modeDescription(selected) : "");
                      push("");
                      push(
                        upKeys +
                          " / " +
                          downKeys +
                          " " +
                          tr("key.move") +
                          "    " +
                          confirmKeys +
                          " " +
                          tr("key.chooseDraft") +
                          "    Ctrl+S " +
                          tr("key.save") +
                          "    " +
                          cancelKeys +
                          (draftMode === savedMode
                            ? " " + tr("key.back")
                            : " " + tr("key.backDiscard")),
                      );
                    } else {
                      push(displayName + " / " + groupLabel("Settings") + " / " + tr("page.language"), {
                        heading: true,
                      });
                      push("");
                      push(tr("page.currentLanguage") + ": " + localeLabel(savedLocale));
                      push(tr("page.draftLanguage") + ": " + localeLabel(draftLocale));
                      push("");
                      push(tr("page.chooseLanguage"), { heading: true });
                      languageOptions.forEach((value, index) =>
                        push(
                          (index === selectedIndex ? "› " : "  ") +
                            localeLabel(value) +
                            (value === savedLocale ? "  " + tr("mark.saved") : "") +
                            (value === draftLocale ? "  " + tr("mark.draft") : ""),
                          { selected: index === selectedIndex },
                        ),
                      );
                      push("");
                      push(
                        upKeys +
                          " / " +
                          downKeys +
                          " " +
                          tr("key.move") +
                          "    " +
                          confirmKeys +
                          " " +
                          tr("key.chooseLanguage") +
                          "    Ctrl+S " +
                          tr("key.save") +
                          "    " +
                          cancelKeys +
                          (draftLocale === savedLocale
                            ? " " + tr("key.back")
                            : " " + tr("key.backDiscard")),
                      );
                    }
                    if (busy) push(tr("notice.working"));
                    if (status) push(status);
                    return lines.map((line) => {
                      const visible = fitLine(line.text, width);
                      const foreground =
                        line.heading || line.selected
                          ? theme.fg("accent", theme.bold(visible))
                          : theme.fg("toolOutput", visible);
                      return theme.bg("toolPendingBg", foreground);
                    });
                  },
                  invalidate() {},
                  async handleInput(data: string) {
                    if (disposed) return;
                    if (
                      isKey(data, "tui.select.cancel", [
                        "escape",
                        "\u001b",
                      ])
                    ) {
                      if (busy) {
                        operation?.abort();
                        status = tr("notice.cancelling");
                        requestRender();
                        return;
                      }
                      const hasUnsavedDraft =
                        (page === "mode" && draftMode !== savedMode) ||
                        (page === "language" && draftLocale !== savedLocale);
                      if (hasUnsavedDraft) {
                        if (!escapeArmed) {
                          escapeArmed = true;
                          status = tr("notice.unsavedDraft");
                          requestRender();
                          return;
                        }
                        if (page === "mode") draftMode = savedMode;
                        else {
                          draftLocale = savedLocale;
                          locale = savedLocale;
                        }
                        escapeArmed = false;
                        selectedIndex =
                          page === "mode"
                            ? Math.max(0, modeOptions.findIndex((mode) => mode === savedMode))
                            : Math.max(0, languageOptions.findIndex((value) => value === savedLocale));
                        page = "actions";
                        status = tr("notice.draftDiscarded");
                        requestRender();
                        return;
                      }
                      escapeArmed = false;
                      status = "";
                      if (page === "mode") {
                        page = "actions";
                        selectedIndex = Math.max(
                          0,
                          (groups[selectedGroup] ?? []).findIndex(
                            (action) =>
                              action.split(/\s+/)[0] === "config" ||
                              action.split(/\s+/)[0] === "mode",
                          ),
                        );
                      } else if (page === "language") {
                        page = "actions";
                        selectedIndex = Math.max(
                          0,
                          (groups[selectedGroup] ?? []).findIndex(
                            (action) => action.split(/\s+/)[0] === "language",
                          ),
                        );
                      } else if (page === "actions") {
                        page = "groups";
                        selectedIndex = Math.max(
                          0,
                          groupNames.indexOf(selectedGroup),
                        );
                      } else {
                        finish({ type: "close" });
                      }
                      requestRender();
                      return;
                    }
                    if (busy) return;
                    if (
                      (page === "mode" || page === "language") &&
                      (data === "\u0013" || data.toLowerCase() === "ctrl+s")
                    ) {
                      if (page === "mode") {
                        if (draftMode === savedMode) {
                          status = tr("notice.modeAlreadySaved");
                          requestRender();
                          return;
                        }
                        startOperation(
                          draftMode,
                          [],
                          "mode " + draftMode,
                          draftMode,
                        );
                      } else if (draftLocale === savedLocale) {
                        status = tr("notice.languageAlreadySaved");
                        requestRender();
                      } else {
                        startLocaleSave(draftLocale);
                      }
                      return;
                    }
                    if (isKey(data, "tui.select.up", ["up", "\u001b[A"])) {
                      const count = selectedLabels().length;
                      if (count) selectedIndex = (selectedIndex + count - 1) % count;
                      escapeArmed = false;
                      status = "";
                      requestRender();
                      return;
                    }
                    if (isKey(data, "tui.select.down", ["down", "\u001b[B"])) {
                      const count = selectedLabels().length;
                      if (count) selectedIndex = (selectedIndex + 1) % count;
                      escapeArmed = false;
                      status = "";
                      requestRender();
                      return;
                    }
                    if (!isKey(data, "tui.select.confirm", ["enter", "\r"]))
                      return;
                    escapeArmed = false;
                    status = "";
                    if (page === "groups") {
                      selectedGroup = groupNames[selectedIndex] ?? groupNames[0] ?? "";
                      page = "actions";
                      selectedIndex = 0;
                      requestRender();
                      return;
                    }
                    if (page === "actions") {
                      const selected = (groups[selectedGroup] ?? [])[selectedIndex];
                      if (!selected) return;
                      const tokens = selected.split(/\s+/).filter(Boolean);
                      const action = tokens.shift() ?? "status";
                      if (action === "config" || action === "mode") {
                        page = "mode";
                        draftMode = savedMode;
                        selectedIndex = Math.max(
                          0,
                          modeOptions.findIndex((mode) => mode === savedMode),
                        );
                        status = tr("notice.modeSaveHelp");
                        requestRender();
                        return;
                      }
                      if (action === "language" && localized) {
                        page = "language";
                        savedLocale = locale;
                        draftLocale = savedLocale;
                        selectedIndex = Math.max(
                          0,
                          languageOptions.findIndex((value) => value === savedLocale),
                        );
                        status = "";
                        requestRender();
                        return;
                      }
                      const inputTitle = h.service.menuInputs?.[selected];
                      if (inputTitle) {
                        finish({
                          type: "input",
                          title: inputLabel(action, inputTitle),
                          action,
                          args: tokens,
                        });
                        return;
                      }
                      startOperation(action, tokens, actionLabel(selected));
                      return;
                    }
                    if (page === "mode") {
                      const selected = modeOptions[selectedIndex];
                      if (!selected) return;
                      draftMode = selected;
                      status =
                        draftMode === savedMode
                          ? tr("notice.modeDraftMatches")
                          : tr("notice.modeDraftSelected");
                      requestRender();
                      return;
                    }
                    const selected = languageOptions[selectedIndex];
                    if (!selected) return;
                    draftLocale = selected;
                    locale = selected;
                    status =
                      draftLocale === savedLocale
                        ? tr("notice.languageDraftMatches")
                        : tr("notice.languageDraftSelected");
                    requestRender();
                  },
                };
                if (pendingAction) {
                  const pending = pendingAction;
                  pendingAction = undefined;
                  queueMicrotask(() =>
                    startOperation(
                      pending.action,
                      pending.args,
                      pending.label,
                    ),
                  );
                }
                return component;
              },
              {
                overlay: true,
                overlayOptions: {
                  width: "72%",
                  maxHeight: 18,
                  anchor: "center",
                  margin: 1,
                },
              },
            );
          } catch {
            return false;
          }
          if (!exit || exit.type === "close") return true;
          const value = await ctx.ui.input(exit.title);
          if (!value?.trim()) {
            status = tr("notice.inputCancelled");
            continue;
          }
          const label = actionLabel(exit.action) + " " + value.trim();
          pendingAction = {
            action: exit.action,
            args: [...exit.args, value.trim()],
            label,
          };
        }
      };

      const fallbackRunMenu = async (initialGroup?: string) => {
        let group = initialGroup;
        const groupNames = Object.keys(groups);
        while (true) {
          if (!group) {
            const selectedGroupLabel = await ctx.ui.select(
              displayName,
              groupNames.map(groupLabel),
            );
            if (!selectedGroupLabel) return;
            group = groupNames[groupNames.map(groupLabel).indexOf(selectedGroupLabel)];
            if (!group) return;
          }
          const actions = groups[group] ?? [];
          const selectedLabel = await ctx.ui.select(
            displayName + " / " + groupLabel(group),
            actions.map(actionLabel),
          );
          if (!selectedLabel) {
            group = undefined;
            continue;
          }
          const selectedIndex = actions.map(actionLabel).indexOf(selectedLabel);
          const selected = actions[selectedIndex];
          if (!selected) continue;
          const selectedParts = selected.split(/\s+/).filter(Boolean);
          const selectedAction = selectedParts[0] ?? "status";
          if (selectedAction === "config" || selectedAction === "mode") {
            await fallbackModePanel();
            continue;
          }
          if (selectedAction === "language" && localized) {
            await fallbackLanguagePanel();
            continue;
          }
          const inputTitle = h.service.menuInputs?.[selected];
          if (inputTitle) {
            const value = await ctx.ui.input(inputLabel(selectedAction, inputTitle));
            if (!value?.trim()) continue;
            selectedParts.push(value.trim());
          }
          const action = selectedParts.shift() ?? "status";
          try {
            const result = await h.serial(() =>
              h.command(action, selectedParts, {
                cwd: ctx.cwd,
                trusted: ctx.isProjectTrusted(),
                locale,
                hostContext: ctx,
                commandContext: ctx,
                signal: ctx.signal,
              }),
            );
            show(result);
          } catch (error) {
            const status = actionFailureStatus(action, error);
            show({ error: status, next: tr("notice.actionFailed") });
            ctx.ui.notify?.(status);
          }
        }
      };
      if (interactive && !parts.length) {
        if (!(await showDashboard()) && typeof ctx.ui.select === "function") await fallbackRunMenu();
        return;
      }
      let action = parts.shift() ?? "status";
      if (action === "mode") action = "config";
      if (interactive && action === "config") {
        if (!(await showDashboard("mode"))) {
          await fallbackModePanel();
          await fallbackRunMenu("Settings");
        }
        return;
      }
      show(
        await h.serial(() =>
          h.command(action, parts, {
            cwd: ctx.cwd,
            trusted: ctx.isProjectTrusted(),
            locale,
            hostContext: ctx,
            commandContext: ctx,
            signal: ctx.signal,
          }),
        ),
      );
    },
  } satisfies Parameters<ExtensionAPI["registerCommand"]>[1];
  for (const name of [command, ...aliases])
    pi.registerCommand(name, {
      ...commandDefinition,
      description:
        name === command
          ? commandDefinition.description
          : `${extension}: alias for /${command}`,
    });
  for (const t of tools)
    pi.registerTool({
      ...t,
      execute: async (callId, input, signal, onUpdate, ctx) => {
        await get(ctx);
        return t.execute(callId, input, signal, onUpdate, ctx);
      },
    });
  pi.on("input", async (e, ctx) => {
    const h = await get(ctx);
    return h.serial(
      () => h.service.input?.(e, ctx) ?? Promise.resolve(undefined),
    );
  });
  pi.on("model_select", async (e, ctx) => {
    const h = await get(ctx);
    await h.serial(
      () => h.service.modelSelect?.(e, ctx) ?? Promise.resolve(),
    );
  });
  pi.on("before_agent_start", async (e, ctx) => {
    const h = await get(ctx);
    if (e.messageType !== "user") return;
    const planModeValue = await h.serial(
      () =>
        h.service.planModePrompt?.(e.prompt, ctx) ?? Promise.resolve(undefined),
    );
    if (planModeValue !== undefined)
      return {
        message: {
          customType: `${extension}.plan-mode`,
          content: JSON.stringify(redact(planModeValue)),
          display: false,
        },
      };
    if (!h.config.enabled || h.config.mode === "off") return;
    const value = await h.serial(
      () => h.service.prompt?.(e.prompt, ctx) ?? Promise.resolve(undefined),
    );
    if (value !== undefined)
      return {
        message: {
          customType: extension,
          content: JSON.stringify(redact(value)),
          display: false,
        },
      };
  });
  pi.on("tool_call", async (e, ctx) => {
    const h = await get(ctx);
    const guard = await h.serial(
      () => h.service.guardToolCall?.(e, ctx) ?? Promise.resolve(undefined),
    );
    if (guard) return guard;
    if (h.config.enabled)
      return h.serial(
        () => h.service.toolCall?.(e, ctx) ?? Promise.resolve(undefined),
      );
  });
  pi.on("tool_result", async (e, ctx) => {
    const h = await get(ctx);
    if (h.config.enabled)
      await h.serial(() => h.service.toolResult?.(e, ctx) ?? Promise.resolve());
  });
  pi.on("message_end", async (e, ctx) => {
    const h = await get(ctx);
    const planModeResult = await h.serial(
      () =>
        h.service.planModeMessageEnd?.(e, ctx) ?? Promise.resolve(undefined),
    );
    if (planModeResult) return planModeResult;
    if (h.config.enabled)
      await h.serial(() => h.service.messageEnd?.(e, ctx) ?? Promise.resolve());
  });
  pi.on("agent_before_settle", async (e, ctx) => {
    const h = await get(ctx);
    if (!h.config.enabled || h.config.mode === "observe") return;
    return (await h.serial(
      () => h.service.settle?.(e, ctx) ?? Promise.resolve(undefined),
    )) as { continue?: boolean } | undefined;
  });
  return { get };
}
