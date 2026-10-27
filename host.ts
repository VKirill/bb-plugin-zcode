import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type HostStatus } from "./contract.js";

// The provider bridge is BB's stock ACP bridge; it launches the `zcode-acp` command on the host (see server.ts).
export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";

const run = promisify(execFile);
const HOME = os.homedir();
const STATE = path.join(HOME, ".zcode-bridge");

function findCommand(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), path.join(HOME, ".local/bin"), path.join(HOME, ".agents/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const d of dirs) {
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {}
  }
  return null;
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
async function bridge(bin: string, args: string[], timeout: number): Promise<Record<string, any> | null> {
  try {
    const { stdout } = await run(bin, args, { timeout, env: { ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", path.join(HOME, ".local/bin")].join(path.delimiter) } });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "null");
  } catch (e: any) {
    const out = String(e?.stdout ?? "").trim().split("\n").pop();
    try {
      return out ? JSON.parse(out) : null;
    } catch {
      return null;
    }
  }
}

async function status(opts: { models?: boolean; quota?: boolean } = {}): Promise<HostStatus> {
  const problems: string[] = [];
  const platform = process.platform;
  const appPath = ["/Applications/ZCode.app", path.join(HOME, "Applications/ZCode.app")].find((p) => fs.existsSync(p)) ?? null;
  const bin = findCommand("zcbridge");
  const agent = findCommand("zcode-acp");
  const out: HostStatus = {
    platform,
    appFound: appPath !== null,
    appPath,
    bridgeFound: bin !== null,
    bridgeVersion: null,
    agentFound: agent !== null,
    zcaxFound: false,
    running: null,
    signedIn: null,
    sessionExpired: null,
    accessibility: null,
    defaultModel: null,
    models: [],
    route: null,
    rewards: null,
    quota: null,
    problems,
  };
  if (platform !== "darwin") problems.push("ZCode control needs macOS.");
  if (!appPath) problems.push("The ZCode app was not found in /Applications.");
  if (!bin) {
    problems.push("zcbridge is not installed on this machine (run scripts/install.sh).");
    return out;
  }
  const v = await bridge(bin, ["version"], 15000);
  out.bridgeVersion = v?.version ?? null;
  out.zcaxFound = v?.zcax_found === true;
  if (!out.zcaxFound) problems.push("zcax (the accessibility helper) is missing: run scripts/install.sh.");
  if (!agent) problems.push("zcode-acp is not on PATH of the BB host daemon.");
  const d = await bridge(bin, ["doctor"], 60000);
  const c = d?.checks ?? null;
  if (c) {
    out.running = c.app_running === true;
    out.sessionExpired = c.session_expired === true;
    out.signedIn = out.running ? !out.sessionExpired : null;
    out.accessibility = true;
    if (!out.running) problems.push("ZCode is not running.");
    if (out.sessionExpired) problems.push("ZCode asks to sign in again: sign in inside the ZCode app.");
  } else {
    const code = d?.error?.code;
    if (code === "no_window" || code === "ui_element_missing") {
      out.accessibility = false;
      problems.push("The bridge cannot see ZCode's window: grant Accessibility to the program that runs BB's host daemon (System Settings > Privacy & Security > Accessibility), and keep ZCode open.");
    } else if (code === "not_running") {
      out.running = false;
      problems.push("ZCode is not running.");
    }
  }
  if (opts.models) await bridge(bin, ["models"], 120000);
  const m = readJson<{ models?: { name: string; enabled: boolean }[]; default?: string }>(path.join(STATE, "models.json"));
  out.models = m?.models ?? [];
  out.defaultModel = m?.default ?? null;
  const setting = readJson<any>(path.join(HOME, ".zcode/v2/setting.json"));
  out.route = setting?.providerFamilyConnectionSelections?.zai?.kind ?? null;
  const r = readJson<any>(path.join(STATE, "rewards.json"));
  out.rewards = r ? { status: r.status ?? null, atUtc: r.at_utc ?? null, claimedDay: r.claimed_day ?? null, bannerSeen: typeof r.banner_seen === "boolean" ? r.banner_seen : null } : null;
  if (opts.quota) {
    const q = await bridge(bin, ["usage", "--days", "1", "--quota"], 120000);
    out.quota = q?.quota ?? null;
    if (!out.quota) problems.push("Could not read the quota from ZCode.");
  }
  return out;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: () => status(),
    refreshModels: () => status({ models: true }),
    readQuota: () => status({ quota: true }),
  },
});
