import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { HostEntry } from "./contract";
import type { rpcContract } from "./server";

type Refresh = "none" | "models" | "quota";

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-0.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={bad ? "text-destructive" : undefined}>{value}</span>
    </div>
  );
}

const yn = (v: boolean | null | undefined, yes = "yes", no = "no") => (v === null || v === undefined ? "unknown" : v ? yes : no);

function HostCard({ h, busy, onRefresh }: { h: HostEntry; busy: boolean; onRefresh: (r: Refresh, hostId: string) => void }) {
  const st = h.status;
  if (!st) return <Row label={h.name} value={h.error ? `no answer: ${h.error}` : h.connected ? "no answer" : "offline"} bad={Boolean(h.error)} />;
  const enabled = st.models.filter((m) => m.enabled).map((m) => m.name);
  return (
    <div className="rounded-md border p-3">
      <div className="mb-1 text-sm font-medium">{h.name}</div>
      <Row label="ZCode app" value={st.appFound ? (st.appPath ?? "found") : "not found"} bad={!st.appFound} />
      <Row label="Bridge" value={st.bridgeFound ? `zcbridge ${st.bridgeVersion ?? "?"}` : "not installed"} bad={!st.bridgeFound} />
      <Row label="ZCode running" value={yn(st.running)} bad={st.running === false} />
      <Row label="Signed in" value={st.sessionExpired ? "session expired: sign in inside ZCode" : yn(st.signedIn)} bad={st.sessionExpired === true || st.signedIn === false} />
      <Row label="Accessibility" value={yn(st.accessibility, "granted", "not granted")} bad={st.accessibility === false} />
      <Row label="Models" value={enabled.length ? enabled.join(", ") : "not read yet"} />
      <Row label="Default model" value={st.defaultModel ?? "unknown"} />
      <Row label="Plan in use" value={st.route === "start-plan" ? "Start Plan (promo)" : st.route === "individual-coding-plan" ? "Z.ai plan" : (st.route ?? "unknown")} />
      <Row
        label="Daily token claim"
        value={st.rewards ? `${st.rewards.status ?? "no attempt"}${st.rewards.atUtc ? `, last try ${st.rewards.atUtc}` : ""}${st.rewards.claimedDay ? `, claimed ${st.rewards.claimedDay}` : ""}` : "no attempt yet"}
      />
      {st.quota ? Object.entries(st.quota).map(([k, v]) => <Row key={k} label={k} value={`${v.remaining ?? "?"}${v.resets ? `, resets ${v.resets}` : ""}`} />) : null}
      {st.problems.map((p) => (
        <div key={p} className="mt-1 text-sm text-destructive">
          {p}
        </div>
      ))}
      <div className="mt-2 flex gap-2">
        <button type="button" className="rounded border px-2 py-1 text-sm" disabled={busy} onClick={() => onRefresh("models", h.hostId)}>
          Refresh models
        </button>
        <button type="button" className="rounded border px-2 py-1 text-sm" disabled={busy} onClick={() => onRefresh("quota", h.hostId)}>
          Read quota
        </button>
      </div>
    </div>
  );
}

function ZCodeStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [hosts, setHosts] = useState<HostEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    (refresh: Refresh, hostId?: string) => {
      setBusy(true);
      rpc.call("hosts", { refresh, ...(hostId ? { hostId } : {}) }).then(
        (r) => {
          setHosts((prev) => (hostId && prev ? prev.map((h) => r.hosts.find((n) => n.hostId === h.hostId) ?? h) : r.hosts));
          setError(null);
          setBusy(false);
        },
        (e) => {
          setError(e instanceof Error ? e.message : String(e));
          setBusy(false);
        },
      );
    },
    [rpc],
  );
  useEffect(() => load("none"), [load]);
  return (
    <div className="flex flex-col gap-2">
      {error ? <div className="text-sm text-destructive">{error}</div> : null}
      {hosts === null ? <div className="text-sm text-muted-foreground">Checking ZCode on your machines...</div> : null}
      {hosts?.filter((h) => h.connected && (h.status?.appFound || h.error)).map((h) => <HostCard key={h.hostId} h={h} busy={busy} onRefresh={(r, id) => load(r, id)} />)}
      {hosts && !hosts.some((h) => h.status?.appFound) ? <div className="text-sm text-muted-foreground">No connected machine has the ZCode app. Install it on a Mac (https://zcode.z.ai), then run scripts/install.sh there.</div> : null}
      <div>
        <button type="button" className="rounded border px-2 py-1 text-sm" disabled={busy} onClick={() => load("none")}>
          Check again
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "zcode-status", title: "ZCode status", description: "The ZCode app, the bridge and the account on each machine.", component: ZCodeStatus });
});
