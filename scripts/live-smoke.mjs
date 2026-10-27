// Live smoke test against the real zcbridge and the real ZCode app (Mac mini). Spends a few tokens of the owner's plan.
// usage: node scripts/live-smoke.mjs <project folder known to ZCode> [basic|permissions|long|cancel|stream]
//   basic        two one-word turns, then a cancel after 15 s
//   permissions  ZCode is asked to write a file twice; the client answers allow (file must exist), then deny (file must not exist)
//   long         a ~25k-character prompt that asks for a one-word answer
//   cancel       starts a long answer on an existing task, cancels after 10 s and prints how long the cancel took
//   stream       a prompt with a tool call and text on both sides; prints every session/update with its time
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAgent, text } from "../tests/support/acp-client.mjs";

const cwd = process.argv[2];
const scenario = process.argv[3] || "basic";
if (!cwd) throw new Error("usage: live-smoke.mjs <folder> [basic|permissions|long|cancel|stream]");
const agent = startAgent(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "zcode-acp"), []);
const t0 = Date.now();
const lap = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
await agent.request("initialize", { protocolVersion: 1 });
const s = await agent.request("session/new", { cwd, mcpServers: [] });
await agent.request("session/set_config_option", { sessionId: s.sessionId, configId: "effort", value: "low" });
const prompt = (t) => agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: t }] });
const ask = async (t) => {
  agent.updates.length = 0;
  const r = await prompt(t);
  lap(`${t.slice(0, 60)} -> ${r.stopReason} ${JSON.stringify(text(agent.updates).slice(0, 200))} usage=${JSON.stringify(r.usage)}`);
  return r;
};

if (scenario === "basic") {
  await ask("Ответь одним словом: ГОТОВО");
  await ask("Ответь одним словом: ВТОРОЙ");
  agent.updates.length = 0;
  const p = prompt("Write the integers 1 to 3000, one per line, no tools.");
  await new Promise((r) => setTimeout(r, 15000));
  agent.notify("session/cancel", { sessionId: s.sessionId });
  lap(`cancel -> ${(await p).stopReason}`);
} else if (scenario === "permissions") {
  let phase = "allow";
  const cards = [];
  agent.handlers.permission = (p) => {
    cards.push({ phase, title: p.toolCall.title, kind: p.toolCall.kind, options: p.options.map((o) => o.kind) });
    lap(`permission request (${phase}): ${p.toolCall.title} [${p.toolCall.kind}] -> ${phase}`);
    return phase;
  };
  const allowFile = path.join(cwd, "allow-test.txt");
  const denyFile = path.join(cwd, "deny-test.txt");
  await ask("Use the Write tool to create allow-test.txt in the project folder with the content ok-allow. Then answer DONE.");
  console.log("allow ->", fs.existsSync(allowFile) ? `written: ${JSON.stringify(fs.readFileSync(allowFile, "utf8"))}` : "NOT written");
  phase = "deny";
  await ask("Use the Write tool to create deny-test.txt in the project folder with the content ok-deny. Then answer DONE.");
  console.log("deny ->", fs.existsSync(denyFile) ? "WRITTEN (wrong)" : "not written (right)");
  console.log("cards:", JSON.stringify(cards));
} else if (scenario === "long") {
  const filler = Array.from({ length: 300 }, (_, i) => `Line ${String(i).padStart(4, "0")}: filler text about nothing in particular, ignore it completely and carry on.`).join("\n");
  const body = `Below is a long block of filler lines. Ignore all of it.\n${filler}\n\nEND OF FILLER. Now reply with exactly one word: PINEAPPLE (and nothing else).`;
  lap(`prompt length ${body.length} characters`);
  await ask(body);
} else if (scenario === "cancel") {
  await ask("Ответь одним словом: ГОТОВО"); // creates the ZCode task, so the cancel below hits a running turn (a cancel during `send` has to wait for it)
  agent.updates.length = 0;
  const p = prompt("Write a very long essay, 3000 words, about the history of salt. No tools.");
  await new Promise((r) => setTimeout(r, 10000));
  const t1 = Date.now();
  agent.notify("session/cancel", { sessionId: s.sessionId });
  const r = await p;
  lap(`cancel -> ${r.stopReason} after ${((Date.now() - t1) / 1000).toFixed(1)} s`);
} else if (scenario === "stream") {
  agent.handlers.permission = () => "allow";
  const p = prompt("First say STARTING. Then use the Bash tool to run: echo streamed-ok. Then count from 1 to 15, one number per line.");
  const seen = new Set();
  let n = 0;
  const flush = () => {
    for (; n < agent.updates.length; n++) {
      const u = agent.updates[n];
      lap(`${u.sessionUpdate} ${u.toolCallId || u.messageId || ""} ${u.status || ""} ${JSON.stringify((u.content?.text ?? u.content?.[0]?.content?.text ?? "").slice(0, 70))}`);
      seen.add(u.sessionUpdate);
    }
  };
  const timer = setInterval(flush, 200);
  const r = await p;
  clearInterval(timer);
  flush();
  lap(`done ${r.stopReason}; update kinds: ${[...seen].join(", ")}`);
}
agent.close();
