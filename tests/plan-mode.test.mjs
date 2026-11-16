import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBus } from "../dist/common/cli.js";
import { FileStorage } from "../dist/common/storage.js";
import { projectKey } from "../dist/common/security.js";
import extension from "../dist/extension.js";
import { Planner, parsePlanProposalBlock } from "../dist/plan.js";

const packageName = JSON.parse(
  await (await import("node:fs/promises")).readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ),
).name;

test(
  "Plan mode discovers on the first prompt, preserves drafts, and blocks tools independently of automatic planning",
  { skip: packageName !== "@borges360/pi-autoplan" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-autoplan-plan-mode-"));
    const previousStateRoot = process.env.PI_ECOSYSTEM_STATE_ROOT;
    process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
    const cwd = join(root, "project");
    await mkdir(cwd);

    const handlers = new Map();
    const commands = new Map();
    const messages = [];
    const selections = [];
    const selectedOptions = [];
    const customActions = [];
    const submittedUserMessages = [];
    const statuses = new Map();
    const notifications = [];
    let editorText = "";
    const pi = {
      events: localBus(),
      on: (name, handler) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
      registerCommand: (name, definition) => commands.set(name, definition),
      registerTool: () => {},
      sendMessage: (message) => messages.push(message),
      sendUserMessage: (message, options) => submittedUserMessages.push({ message, options }),
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools: () => {},
      registerMcpServer: () => {},
      unregisterMcpServer: () => {},
    };
    extension(pi);
    const ctx = {
      cwd,
      mode: "tui",
      hasUI: true,
      ui: {
        select: async (title, options) => {
          selectedOptions.push({ title, options });
          return selections.shift();
        },
        notify: (message, type) => notifications.push({ message, type }),
        setStatus: (key, value) => statuses.set(key, value),
        setEditorText: (value) => { editorText = value; },
        theme: { fg: (_color, value) => value },
        custom: async (factory) => {
          let finish;
          const result = new Promise((resolve) => { finish = resolve; });
          const component = factory(
            { requestRender: () => {} },
            { fg: (_color, value) => value, bold: (value) => value },
            {},
            (value) => finish(value),
          );
          for (const action of customActions.shift() ?? []) {
            if (action === "__wait_for_save__") {
              for (let index = 0; index < 100 && !notifications.some(({ message }) => /Proposal saved as a draft/.test(message)); index++)
                await new Promise((resolve) => setTimeout(resolve, 10));
            } else {
              component.handleInput(action);
            }
          }
          let timer;
          const outcome = await Promise.race([
            result.then((value) => ({ value })),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve({ timedOut: true }), 2000);
            }),
          ]);
          clearTimeout(timer);
          assert.ok("value" in outcome, "mock custom UI panel must close within 2 seconds");
          return outcome.value;
        },
      },
      isProjectTrusted: () => false,
      getContextUsage: () => undefined,
      compact: () => {},
      signal: undefined,
      isIdle: () => true,
      hasPendingMessages: () => false,
      abort: () => {},
      shutdown: () => {},
      getSystemPrompt: () => "",
      sessionManager: {},
      modelRegistry: {},
      model: undefined,
    };
    const command = commands.get("plan");
    assert.ok(command);
    assert.match(command.description, /plan-mode/);
    assert.ok(new Planner({}).menuGroups.Plan.includes("plan-mode"));
    await handlers.get("session_start")?.({}, ctx);
    t.after(async () => {
      await handlers.get("session_shutdown")?.({}, ctx);
      await rm(root, { recursive: true, force: true });
      if (previousStateRoot === undefined)
        delete process.env.PI_ECOSYSTEM_STATE_ROOT;
      else process.env.PI_ECOSYSTEM_STATE_ROOT = previousStateRoot;
    });

    await command.handler("plan-mode", ctx);
    assert.equal(selectedOptions.length, 0);
    assert.equal(JSON.parse(messages.at(-1).content).mode, "plan");
    assert.equal(JSON.parse(messages.at(-1).content).awaitingDiscoveryChoice, true);
    assert.match(statuses.get("pi-autoplan-work-mode"), /first prompt/);

    ctx.model = { id: "unknown", provider: "unknown", api: "unknown" };
    const originalPrompt = "Describe the homelab proposal";
    const attachedImage = { type: "image", data: "pending-image" };
    const noModelResult = await handlers.get("input")?.(
      { type: "input", text: originalPrompt, images: [attachedImage], source: "interactive" },
      ctx,
    );
    assert.deepEqual(noModelResult, { action: "handled" });
    assert.equal(editorText, originalPrompt);
    assert.equal(selectedOptions.length, 0);
    assert.ok(notifications.some(({ message }) => /No model is selected/.test(message)));

    ctx.model = { id: "test-model" };
    await handlers.get("model_select")?.(
      { type: "model_select", model: ctx.model, previousModel: undefined, source: "set" },
      ctx,
    );
    assert.equal(editorText, originalPrompt);
    customActions.push(["\u001b"]);
    const cancelled = await handlers.get("input")?.(
      { type: "input", text: originalPrompt, source: "interactive" },
      ctx,
    );
    assert.deepEqual(cancelled, { action: "handled" });
    assert.equal(editorText, originalPrompt);
    assert.equal(await handlers.get("before_agent_start")?.(
      { messageType: "user", prompt: originalPrompt }, ctx,
    ), undefined);

    customActions.push(["\u001b[A", "\r"]);
    const accepted = await handlers.get("input")?.(
      { type: "input", text: originalPrompt, source: "interactive" },
      ctx,
    );
    assert.deepEqual(accepted, {
      action: "transform",
      text: originalPrompt,
      images: [attachedImage],
    });
    assert.equal(selectedOptions.length, 0);
    assert.match(statuses.get("pi-autoplan-work-mode"), /Plan mode: Propose for me/);

    const injected = await handlers.get("before_agent_start")?.(
      { messageType: "user", prompt: "Do not leak this prompt into mode state" },
      ctx,
    );
    assert.equal(injected.message.display, false);
    const modeContext = JSON.parse(injected.message.content);
    assert.equal(modeContext.protocol, "pi-autoplan.plan-session.v1");
    assert.equal(modeContext.discoveryStyle, "propose");
    assert.doesNotMatch(injected.message.content, /Do not leak this prompt/);

    const proposal = {
      schemaVersion: 1,
      title: "Homelab proposal",
      objective: "Prepare a bounded homelab change.",
      scope: ["Local verification"],
      outOfScope: ["Production"],
      decisions: [{ topic: "Deployment", choice: "Not included", origin: "user" }],
      assumptions: ["The change remains local."],
      acceptance: [{
        behavior: "The local check passes.",
        verification: "Run the declared unit suite.",
        responsible: "automated",
        status: "proposed",
      }],
      tasks: [{ id: "local-check", objective: "Run the local check", dependsOn: [], acceptance: ["Check passes"] }],
    };
    const proposalBlock = `\`\`\`pi-autoplan-proposal\n${JSON.stringify(proposal, null, 2)}\n\`\`\``;
    const parsedProposal = parsePlanProposalBlock(`Prepared proposal.\n\n${proposalBlock}`);
    assert.equal(parsedProposal.proposal.title, "Homelab proposal");
    assert.throws(() => parsePlanProposalBlock("```pi-autoplan-proposal\n{}\n```"));
    const rewrittenMessage = await handlers.get("message_end")?.(
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: `Prepared proposal.\n\n${proposalBlock}` }],
        },
      },
      ctx,
    );
    assert.equal(
      rewrittenMessage.message.content[0].text,
      "Prepared proposal.",
    );
    assert.doesNotMatch(rewrittenMessage.message.content[0].text, /pi-autoplan-proposal/);
    assert.match(statuses.get("pi-autoplan-work-mode"), /Proposal ready for review/);
    customActions.push(["\u001b[13;5u", "\r"]);
    await command.handler("review", ctx);
    const unsavedStart = JSON.parse(messages.at(-1).content);
    assert.equal(unsavedStart.saved, false);
    assert.equal(unsavedStart.started, false);
    assert.equal(submittedUserMessages.length, 0);

    notifications.length = 0;
    customActions.push(["\u0013", "__wait_for_save__", "\r"]);
    await command.handler("review", ctx);
    await command.handler("status", ctx);
    const savedStatus = JSON.parse(messages.at(-1).content);
    assert.equal(savedStatus.proposal.saved, true);

    customActions.push([
      "e",
      "\r",
      "\u001b[B",
      "\r",
      ..." changed".split(""),
      "\u001b",
      "\u001b",
      "\r",
    ]);
    await command.handler("review", ctx);
    await command.handler("status", ctx);
    const cancelledFieldEdit = JSON.parse(messages.at(-1).content);
    assert.equal(cancelledFieldEdit.proposal.saved, true);
    assert.equal(cancelledFieldEdit.proposal.title, proposal.title);

    customActions.push([
      "e",
      "\r",
      ..." revised".split(""),
      "\r",
      "\u001b[13;5u",
      "\r",
    ]);
    await command.handler("review", ctx);
    await command.handler("status", ctx);
    const editedBeforeSave = JSON.parse(messages.at(-1).content);
    assert.equal(editedBeforeSave.proposal.saved, false);
    assert.equal(editedBeforeSave.proposal.title, "Homelab proposal revised");
    assert.equal(submittedUserMessages.length, 0);

    notifications.length = 0;
    customActions.push(["\u0013", "__wait_for_save__", "\r"]);
    await command.handler("review", ctx);
    await command.handler("status", ctx);
    const editedSavedStatus = JSON.parse(messages.at(-1).content);
    assert.ok(
      notifications.some(({ message }) => /Proposal saved as a draft/.test(message)),
      JSON.stringify(notifications),
    );
    assert.equal(editedSavedStatus.proposal.saved, true);
    assert.equal(editedSavedStatus.proposal.title, "Homelab proposal revised");

    const editFieldAndAppend = (index, suffix) => [
      "e",
      ...Array.from({ length: index }, () => "\u001b[B"),
      "\r",
      ...suffix.split(""),
      "\r",
    ];
    notifications.length = 0;
    customActions.push([
      ...editFieldAndAppend(1, " revised"),
      ...editFieldAndAppend(2, "; Project checkout"),
      ...editFieldAndAppend(3, "; Production stays untouched"),
      ...editFieldAndAppend(4, " confirmed"),
      ...editFieldAndAppend(5, " approved"),
      ...editFieldAndAppend(6, "; Existing work preserved"),
      ...editFieldAndAppend(7, " after review"),
      ...editFieldAndAppend(8, " with the declared command"),
      ...editFieldAndAppend(9, " in the isolated profile"),
      "\u0013",
      "__wait_for_save__",
      "\r",
    ]);
    await command.handler("review", ctx);
    await command.handler("status", ctx);
    const multiFieldSavedStatus = JSON.parse(messages.at(-1).content);
    assert.equal(multiFieldSavedStatus.proposal.saved, true);
    assert.equal(multiFieldSavedStatus.proposal.title, "Homelab proposal revised");
    assert.equal(submittedUserMessages.length, 0);
    const proposalStore = new FileStorage({
      root: join(
        process.env.PI_ECOSYSTEM_STATE_ROOT,
        "pi-autoplan",
        "projects",
        await projectKey(cwd),
      ),
      extension: "pi-autoplan",
    });
    await proposalStore.open();
    let persistedProposal;
    try {
      persistedProposal = await proposalStore.getRecord(
        "proposals",
        multiFieldSavedStatus.proposal.id,
      );
    } finally {
      await proposalStore.close();
    }
    assert.ok(persistedProposal);
    assert.equal(persistedProposal.proposal.title, "Homelab proposal revised");
    assert.equal(
      persistedProposal.proposal.objective,
      "Prepare a bounded homelab change. revised",
    );
    assert.deepEqual(persistedProposal.proposal.scope, [
      "Local verification",
      "Project checkout",
    ]);
    assert.deepEqual(persistedProposal.proposal.outOfScope, [
      "Production",
      "Production stays untouched",
    ]);
    assert.deepEqual(persistedProposal.proposal.decisions, [{
      topic: "Deployment confirmed",
      choice: "Not included approved",
      origin: "user",
    }]);
    assert.deepEqual(persistedProposal.proposal.assumptions, [
      "The change remains local.",
      "Existing work preserved",
    ]);
    assert.equal(
      persistedProposal.proposal.acceptance[0].behavior,
      "The local check passes. after review",
    );
    assert.equal(
      persistedProposal.proposal.acceptance[0].verification,
      "Run the declared unit suite. with the declared command",
    );
    assert.equal(
      persistedProposal.proposal.tasks[0].objective,
      "Run the local check in the isolated profile",
    );

    const guarded = await handlers.get("tool_call")?.(
      { toolName: "write", input: { path: "would-change" } },
      ctx,
    );
    assert.equal(guarded.block, true);

    await command.handler("create proposed.json", ctx);
    assert.equal(JSON.parse(messages.at(-1).content).blocked, true);

    customActions.push(["\u001b[13;5u"]);
    await command.handler("review", ctx);
    const startResult = JSON.parse(messages.at(-1).content);
    assert.equal(startResult.started, true, JSON.stringify({ startResult, notifications }));
    assert.equal(submittedUserMessages.length, 1);
    assert.equal(submittedUserMessages[0].options.expandPromptTemplates, false);
    await command.handler("status", ctx);
    const startedStatus = JSON.parse(messages.at(-1).content);
    assert.equal(startedStatus.plan.sourceProposalId, savedStatus.proposal.id);
    assert.equal(startedStatus.proposal.started, true);
    assert.equal(await handlers.get("tool_call")?.({ toolName: "write" }, ctx), undefined);

    customActions.push(["\u001b[13;5u", "\r"]);
    await command.handler("review", ctx);
    assert.equal(submittedUserMessages.length, 1);

    await command.handler("plan-mode", ctx);
    assert.match(statuses.get("pi-autoplan-work-mode"), /first prompt/);
    await command.handler("plan-mode", ctx);
    assert.equal(statuses.get("pi-autoplan-work-mode"), undefined);

    await command.handler("plan-mode", ctx);
    await handlers.get("session_start")?.({}, ctx);
    assert.equal(statuses.get("pi-autoplan-work-mode"), undefined);
    await command.handler("status", ctx);
    assert.equal(JSON.parse(messages.at(-1).content).proposal.saved, true);
    assert.equal(
      await handlers.get("tool_call")?.({ toolName: "write" }, ctx),
      undefined,
    );
    assert.ok(notifications.some(({ message }) => /Plan mode enabled/.test(message)));
  },
);
