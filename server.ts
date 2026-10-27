import type { BbPluginApi, JsonValue, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, rpcContract, type HostEntry } from "./contract.js";

export { rpcContract } from "./contract.js";

// The ACP agent (bin/zcode-acp, installed by scripts/install.sh) runs on the machine that has the ZCode desktop app. The default
// command is a bare name on purpose: the host daemon resolves it through its own PATH, so no home directory is written into the plugin.
// With visibility "installed" the provider shows up only on a host where the command resolves. The setting "Agent command" overrides it
// for a machine that keeps the command somewhere else.
export const ZCODE_PROVIDER_ID = "zcode";
export const ZCODE_AGENT_COMMAND = "zcode-acp";

export const MODE_OPTIONS = ["full", "auto", "ask", "plan"];

const SETTINGS = {
  defaultMode: {
    type: "select",
    label: "Default ZCode mode / Режим ZCode по умолчанию",
    description:
      "The mode ZCode runs every session in. Full access: no confirmations. Autonomous mode: ZCode asks only for risky actions. Ask before changes: every change asks. Plan mode: plan only. Default: Full access.",
    options: MODE_OPTIONS,
    experimental_optionLabels: { full: "Full access", auto: "Autonomous mode", ask: "Ask before changes", plan: "Plan mode" },
    default: "full",
  },
  followChatMode: {
    type: "boolean",
    label: "Chat permission mode decides / Права чата решают",
    description: "When on, the chat's BB permission mode wins over the setting above: Accept edits runs ZCode in Autonomous mode, Full runs it in Full access. Off by default, because BB gives every chat one of the two.",
    default: false,
  },
  autoScope: {
    type: "select",
    label: "Autonomous mode: answers on its own / Автономный режим: сам разрешает",
    description: "What the plugin allows once without asking while ZCode is in Autonomous mode. Files inside the project folder (default) or everything. Always allow is never pressed.",
    options: ["project", "all"],
    experimental_optionLabels: { project: "Inside the project folder", all: "Everything" },
    default: "project",
  },
  model: {
    type: "string",
    label: "Model override / Модель (пусто = как в ZCode)",
    description: "Name of a ZCode model, for example GLM-5.3-Flash. Empty follows ZCode's own default model. The model list in BB is what your ZCode offers.",
    default: "",
  },
  route: {
    type: "select",
    label: "Plan that pays / Маршрут GLM-5.3-Flash",
    description: "Which ZCode plan pays for a task. Keep: leave ZCode's current choice. Auto: the free promo Start Plan for GLM-5.3-Flash while it is ready and inside 15:00-01:00 UTC, else the plan. Needs no other ZCode task to be running when it switches.",
    options: ["keep", "auto", "plan", "promo"],
    experimental_optionLabels: { keep: "Keep ZCode's choice", auto: "Promo when ready, else plan", plan: "Always the plan", promo: "Always the promo Start Plan" },
    default: "keep",
  },
  maxParallel: {
    type: "number",
    label: "Max parallel tasks / Параллельных задач",
    description: "How many ZCode tasks run at the same time (0 = no limit). More wait for a free slot.",
    experimental_schema: z.number().int().min(0).max(16),
    default: 3,
  },
  autoCreateProjects: {
    type: "boolean",
    label: "Create ZCode projects automatically / Создавать проекты ZCode",
    description: "A chat's folder works in the ZCode project of that folder (or of its git repository). Off: a folder ZCode does not know yet fails instead of being registered.",
    default: true,
  },
  removePrefixes: {
    type: "string",
    label: "Remove auto-created projects under / Удалять проекты под",
    description: "Folder prefixes, one per line (~ allowed). A ZCode project that a session registered for a folder under one of them is taken out of ZCode's project list when the session ends (only the list entry; no file is touched). For throw-away worktrees.",
    experimental_multiline: true,
    default: "~/.lane-pilot/worktrees",
  },
  forwardInstructions: {
    type: "boolean",
    label: "Forward BB instructions to ZCode / Передавать инструкции BB",
    description: "Send BB's own instruction block (rules and skill list) with the first prompt. Off by default: ZCode has its own system prompt and reads AGENTS.md itself.",
    default: false,
  },
  agentCommand: {
    type: "string",
    label: "Agent command",
    description: "Command that starts the ZCode agent on the host. Change it only if zcode-acp is not on the host daemon's PATH (use an absolute path).",
    default: ZCODE_AGENT_COMMAND,
  },
} satisfies Record<string, PluginSettingDescriptor>;

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define(SETTINGS);
  const host = bb.hosts.experimental_client({ contract: hostContract });

  const agentEnv = (v: Record<string, string | number | boolean | undefined>) => ({
    ZCODE_ACP_MODE_DEFAULT: String(v.defaultMode ?? "full"),
    ZCODE_ACP_FOLLOW_CHAT: v.followChatMode === true ? "1" : "0",
    ZCODE_ACP_AUTO_SCOPE: String(v.autoScope ?? "project"),
    ZCODE_ACP_MODEL: String(v.model ?? ""),
    ZCODE_ROUTE: String(v.route ?? "keep"),
    ZCODE_MAX_PARALLEL: String(Math.max(0, Math.floor(Number(v.maxParallel ?? 3)))),
    ZCODE_ACP_AUTOADD: v.autoCreateProjects === false ? "0" : "1",
    ZCODE_ACP_REMOVE_PREFIXES: String(v.removePrefixes ?? "").trim() || "-",   // "-" = none (an empty value is not forwarded)
    ZCODE_ACP_KEEP_INSTRUCTIONS: v.forwardInstructions === true ? "1" : "0",
  });

  bb.providers.register({
    id: ZCODE_PROVIDER_ID,
    displayName: "ZCode",
    icon: "./icons/zcode.svg",
    family: "acp",
    strings: {
      signInHint: "Sign in inside the ZCode app on this Mac (never run `zcode login`).",
      expiredHint: "The ZCode session expired. Sign in inside the ZCode app, then reload.",
      installUrl: "https://zcode.z.ai",
    },
    experimental_visibility: "installed",
    experimental_bridgeOptions: {
      acpLaunchSpec: { displayName: "ZCode", command: ZCODE_AGENT_COMMAND, args: [], env: {} },
    },
    // The chat's BB permission mode reaches the agent as an argument (the agent restarts when it changes); the plugin settings reach it
    // as environment, resolved again for every turn.
    deriveProviderOptions(ctx) {
      const command = String(ctx.settings.agentCommand ?? "").trim() || ZCODE_AGENT_COMMAND;
      return {
        acpLaunchSpec: {
          displayName: "ZCode",
          command,
          args: [],
          env: {},
          permissionCli: { full: ["--bb-permission=full"], workspaceWrite: ["--bb-permission=accept-edits"] },
        } as JsonValue,
      };
    },
    models: { scope: "host" },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "high", "max"],
    },
    reasoningLevels: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
    ],
    composerActions: [],
  });

  bb.providers.experimental_contributeEnv(ZCODE_PROVIDER_ID, async () => {
    const env = agentEnv(await settings.get());
    return Object.entries(env)
      .filter(([, value]) => value !== "")
      .map(([name, value]) => ({ name, value, reason: "ZCode provider setting" }));
  });

  bb.rpc.register(rpcContract, {
    async hosts({ refresh, hostId }) {
      const listed = await bb.sdk.hosts.list();
      const rows = listed.filter((h) => !hostId || h.id === hostId);
      const hosts: HostEntry[] = await Promise.all(
        rows.map(async (h): Promise<HostEntry> => {
          const connected = h.status === "connected";
          if (!connected) return { hostId: h.id, name: h.name || h.id, connected, status: null, error: null };
          try {
            const method = refresh === "models" ? "refreshModels" : refresh === "quota" ? "readQuota" : "status";
            const status = await host.call(method, {}, { hostId: h.id });
            return { hostId: h.id, name: h.name || h.id, connected, status, error: null };
          } catch (e) {
            return { hostId: h.id, name: h.name || h.id, connected, status: null, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      // keep the machines that have ZCode first
      hosts.sort((a, b) => Number(b.status?.appFound ?? false) - Number(a.status?.appFound ?? false));
      return { hosts };
    },
  });
}
