// Invite test: a guest joins from their own board, their AI dials in on the invite connector,
// the guest posts and takes the floor, and revoking kicks them both.
// Usage: PORT=8790 npx tsx scripts/invite-test.ts   (server must be running; ends whatever call is live)
import { readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = `http://localhost:${process.env.PORT || 8788}`;
const send = (path: string, body: object = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const board = (path: string, body: object = {}) => send(`/api/${path}`, body);
const state = () => fetch(`${base}/api/state`).then((r) => r.json());

async function ai(key: string) {
  const c = new Client({ name: "invite-test", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${key}`)));
  return async (name: string, args: Record<string, unknown>) => ((await c.callTool({ name, arguments: args })) as any).content[0].text as string;
}

let failed = 0;
function check(label: string, got: unknown, want: RegExp | boolean) {
  const ok = typeof want === "boolean" ? got === want : want.test(String(got));
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got: ${String(got)}`}`);
}
const tokenOf = (s: string) => s.match(/seat-\w+/)![0];

await board("end");
await board("settings", { holdSecs: 3, turnCap: 20, readWpm: 0 });
check("no invites without a call", (await board("invites", { label: "Sam" })).error, /Start a call first/);

await board("start", { topic: "_invite: the skill bug", brief: "Sam's skill misreads dates." });
const inv = await board("invites", { label: "Sam" });
const g = (path: string, body: object = {}) => send(`/g/${inv.code}/api/${path}`, body);
const gState = () => fetch(`${base}/g/${inv.code}/api/state`).then((r) => r.json());

check("invite has a board link", inv.board, /\/join\/[0-9a-f]{32}$/);
check("invite has an AI connector", inv.connector, /\/mcp\/[0-9a-f]{32}$/);
check("guest board page serves", (await fetch(`${base}/join/${inv.code}`)).status === 200, true);
check("bad invite link is refused", (await fetch(`${base}/join/nope`)).status, /404/);
check("bad invite connector is refused", (await fetch(`${base}/mcp/nope`, { method: "POST" })).status, /404/);
const host = await ai(readFileSync(".partyline-secret", "utf8").trim());
const H = tokenOf(await host("join_call", { name: "Opus", bio: "The host's AI. Found the bug." }));
await board("seat", { id: H, action: "approve" });
await host("wait_for_turn", { seat: H });

check("guest can't post before joining", (await g("post", { text: "hi" })).error, /not on the call/);
check("guest joins", (await g("join", { name: "Sam", bio: "Wrote the skill." })).ok, true);
check("guest can't join twice", (await g("join", { name: "Sam" })).error, /already/);
const gs = (await state()).seats.find((s: any) => s.human);
check("host sees the guest pending", gs?.status, /pending/);
check("guest sees their pending status", (await gState()).guest.status, /pending/);
check("pending guest sees no posts", (await gState()).posts.length, /^0$/);
check("pending guest isn't told the topic", (await gState()).topic, /^$/);
await board("seat", { id: gs.id, action: "approve" });

const gv = await gState();
check("approved guest sees the whole call", gv.posts.map((p: any) => p.text).join("|"), /Call started[\s\S]*Sam \(human guest\) joined/);
check("guest sees no seat tokens", JSON.stringify(gv), /^(?![\s\S]*seat-)/);
check("guest's view of the host AI", gv.seats[0]?.name, /Opus/);

// The guest's own AI dials in on the invite connector.
const theirs = await ai(inv.code);
const theirJoin = await theirs("join_call", { name: "Sonnet", bio: "Sam's AI. Knows the skill." });
check("join_call names whose call it is", theirJoin, /'s call as Sonnet/);
check("a pending seat isn't told the topic", /skill bug/.test(theirJoin), false);
const C = tokenOf(theirJoin);
const cs = (await state()).seats.find((s: any) => s.id === C);
check("host sees the guest's AI tagged via Sam", cs?.viaName, /Sam/);
await board("seat", { id: C, action: "approve" });
check("guest's AI gets a roster naming the guest", await theirs("wait_for_turn", { seat: C }), /Sam: a human guest[\s\S]*Sonnet: an AI, here for Sam/);

// Guests chime in any time; posting off the floor doesn't move it.
await board("post", { text: "Opus, explain the bug." }); // host kicks off, floor goes to the first AI
check("guest posts off the floor", (await g("post", { text: "I'm listening." })).ok, true);
const t1 = await host("wait_for_turn", { seat: H });
check("host AI sees the guest's post", t1, /YOUR TURN[\s\S]*Sam: I'm listening/);

// An AI can ask the guest directly; the guest's answer goes back to the asker.
await host("post", { seat: H, text: "Sam, is the date field ISO or US?", next: "Sam" });
check("guest has the floor", (await gState()).turn.holder, /^me$/);
check("AIs are told a human guest has the floor", await theirs("wait_for_turn", { seat: C }), /Sam \(a human guest\) has the floor/);
await g("post", { text: "US format. That's the bug, isn't it." });
check("guest's answer goes back to the asker", (await state()).turn.name, /Opus/);
check("guests don't count toward 'settled'", (await host("post", { seat: H, text: "Yes. Fixed.", resolved: true })) && (await state()).allAgree, false);

// Revoking kicks the guest and their AI.
await board("invites/revoke", { code: inv.code });
const after = (await state()).seats.map((s: any) => s.name);
check("revoke removes the guest and their AI", after.join(","), /^Opus$/);
check("revoked link is dead", (await fetch(`${base}/join/${inv.code}`)).status, /404/);
check("revoked connector is dead", await theirs("wait_for_turn", { seat: C }).catch((e) => `${e.code}`), /404/);

// Invites belong to one call: ending it expires every link.
const other = await board("invites", { label: "Priya" });
check("second invite works mid-call", (await fetch(`${base}/join/${other.code}`)).status === 200, true);
await board("end");
check("ending the call expires its invites", (await fetch(`${base}/join/${other.code}`)).status, /404/);
check("no invites left after the call", (await fetch(`${base}/api/invites`).then((r) => r.json())).length, /^0$/);

// Clean up the test transcript, like the other suites do.
const last = (await state()).lastSaved;
for (const ext of [".md", ".json"]) rmSync(`calls/${last.replace(/\.md$/, ext)}`, { force: true });
console.log(failed ? `\n${failed} FAILED` : "\nAll passed.");
process.exit(failed ? 1 : 0);
