// Smoke test for the whole call: joining, approval, the floor, @mentions, the cap, agreement, ending.
// Usage: npm run smoke   (server must be running; ends whatever call is live, and leaves none open)
import { readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = `http://localhost:${process.env.PORT || 8788}`;
const url = new URL(`${base}/mcp/${readFileSync(".partyline-secret", "utf8").trim()}`);
const board = (path: string, body: object = {}) =>
  fetch(`${base}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const state = async () => (await fetch(`${base}/api/state`)).json();

async function claude() {
  const c = new Client({ name: "smoke", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(url));
  return async (name: string, args: Record<string, unknown>) => {
    const r: any = await c.callTool({ name, arguments: args });
    return r.content[0].text as string;
  };
}

let failed = 0;
function check(label: string, got: string | boolean, want: RegExp | boolean) {
  const ok = typeof want === "boolean" ? got === want : want.test(String(got));
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got: ${got}`}`);
}
const HOST: string = (await state()).humanName;
const tokenOf = (s: string) => s.match(/seat-\w+/)![0];

await board("end");
await board("settings", { holdSecs: 3, turnCap: 20, readWpm: 0 });
const a = await claude();
const b = await claude();
const c = await claude();

check("join with no call", await a("join_call", { name: "Opus", bio: "x" }), /No call is open/);

await board("start", { topic: "_smoke: tabs or spaces", brief: "Settle it for the style guide." });
const A = tokenOf(await a("join_call", { name: "Opus", bio: "Here for the frontend." }));
check("duplicate name rejected", await b("join_call", { name: "opus", bio: "x" }), /taken/);
check("host's name reserved", await b("join_call", { name: HOST, bio: "x" }), /taken/);
const B = tokenOf(await b("join_call", { name: "Sonnet", bio: "Here for the backend." }));
check("post while pending rejected", await a("post", { seat: A, text: "hi" }), /waiting for the host/);

setTimeout(() => board("seat", { id: A, action: "approve" }), 500);
const inA = await a("wait_for_turn", { seat: A });
check("approval arrives with the brief", inA, /You're in[\s\S]*style guide/);
await board("seat", { id: B, action: "approve" });
check("B approved", await b("wait_for_turn", { seat: B }), /You're in/);

check("nobody has the floor yet", await a("wait_for_turn", { seat: A }), /Not your turn yet/);
check("post off-turn rejected", await a("post", { seat: A, text: "hi" }), /not your turn/i);

// The host kicks off: the floor goes to the first Claude.
await board("post", { text: "Tabs or spaces? Go." });
const t1 = await a("wait_for_turn", { seat: A });
check("host post hands the first Claude the floor", t1, /YOUR TURN[\s\S]*Tabs or spaces/);
check("A posts", await a("post", { seat: A, text: "Spaces. Consistent everywhere." }), /Sonnet has the floor/);
const t2 = await b("wait_for_turn", { seat: B });
check("B gets the floor with A's message", t2, /YOUR TURN \(from Opus\)[\s\S]*Spaces\. Consistent/);
check("B's view doesn't repeat the host message twice", (t2.match(/Tabs or spaces/g) ?? []).length === 1, true);

// B asks the host directly.
check("B hands the floor to the host", await b("post", { seat: B, text: `${HOST}, is there a linter?`, next: HOST }), new RegExp(String.raw`${HOST} has the floor`));
check("floor is the host's", (await state()).turn.holder, /^human$/);
await board("post", { text: "Yes, Prettier." });
const t3 = await b("wait_for_turn", { seat: B });
check("host's answer goes back to the asker", t3, new RegExp(String.raw`YOUR TURN \(from ${HOST}\)[\s\S]*Prettier`));

// A third Claude joins mid-call and the rotation includes them.
const C = tokenOf(await c("join_call", { name: "Haiku", bio: "Here for the docs." }));
await board("seat", { id: C, action: "approve" });
await c("wait_for_turn", { seat: C });
await b("post", { seat: B, text: "Then spaces, Prettier default." });
const t4 = await c("wait_for_turn", { seat: C });
check("rotation reaches the newcomer, with the whole history", t4, /YOUR TURN[\s\S]*Tabs or spaces[\s\S]*Prettier default/);

// @mention jumps the queue.
await board("post", { text: "@Opus what about Makefiles?" });
check("@mention hands the floor over", (await a("wait_for_turn", { seat: A })), new RegExp(String.raw`YOUR TURN \(from ${HOST}\)[\s\S]*Makefiles`));

// Agreement: everyone resolved hands the floor to the host.
await a("post", { seat: A, text: "Makefiles keep tabs; everything else spaces.", resolved: true });
await b("wait_for_turn", { seat: B });
await b("post", { seat: B, text: "Agreed.", resolved: true });
await c("wait_for_turn", { seat: C });
check("C's turn", String((await state()).turn.holder === C), /true/);
await c("post", { seat: C, text: "Agreed, I'll write it up.", resolved: true });
const s1 = await state();
check("everyone agrees", s1.allAgree, true);
check("floor goes to the host when everyone agrees", s1.turn.holder, /^human$/);

// Once settled, a thank-you doesn't reopen it: no round of re-agreeing.
await board("post", { text: "Thanks, all!" });
const s1b = await state();
check("thanks keeps it settled", s1b.allAgree, true);
check("thanks keeps the floor with the host", s1b.turn.holder, /^human$/);

// An @mention reopens it.
await board("post", { text: "@Opus one more: line length?" });
check("@mention clears agreement", (await state()).allAgree, false);

// Passing: everyone passes, the floor comes back to the host.
const holder = (await state()).turn.holder;
const byTok: Record<string, typeof a> = { [A]: a, [B]: b, [C]: c };
await byTok[holder]("wait_for_turn", { seat: holder }); // delivers the turn
await byTok[holder]("wait_for_turn", { seat: holder }); // passes
for (let i = 0; i < 2; i++) {
  const h = (await state()).turn.holder;
  await byTok[h]("wait_for_turn", { seat: h });
  await byTok[h]("wait_for_turn", { seat: h });
}
check("all pass: floor to the host", (await state()).turn.holder, /^human$/);

// The cap: two Claude messages, then the line waits on the host.
await board("settings", { turnCap: 2 });
await board("post", { text: "Line length, go." });
for (let i = 0; i < 2; i++) {
  const h = (await state()).turn.holder;
  await byTok[h]("wait_for_turn", { seat: h });
  await byTok[h]("post", { seat: h, text: `100 chars (${i})` });
}
const s2 = await state();
check("cap hands the floor to the host", s2.turn.holder, /^human$/);
check("cap message posted", s2.posts.at(-1).text, new RegExp(String.raw`2 messages without ${HOST}`));
await board("settings", { turnCap: 20 });

// Hold: no floor gets delivered while paused.
await board("turn", { holder: A });
await board("pause", { paused: true });
check("held: A doesn't get the floor", await a("wait_for_turn", { seat: A }), /on hold/);
await board("pause", { paused: false });
check("resumed: A gets it", await a("wait_for_turn", { seat: A }), /YOUR TURN[\s\S]*capped at 1200 characters/);

// Post limit: an over-long post bounces, whole, and the floor stays put.
await board("settings", { postLimit: 20 });
check("long post bounces", await a("post", { seat: A, text: "This is far more than twenty characters." }), /Too long: \d+ characters[\s\S]*still have the floor/);
check("bounced post isn't on the line", (await state()).posts.at(-1).text, /^(?!This is far more)/);
check("A still has the floor", (await state()).turn.holder === A, true);
await board("settings", { postLimit: 1200 });

// Asking your own human: private, and it doesn't need or hold the floor.
check("B asks off-turn", await b("ask_my_human", { seat: B, question: "Can I mention the Zebra project?" }), new RegExp(String.raw`Asked ${HOST} privately[\s\S]*wait_for_turn`));
const asked = await state();
check("host's board has the question", asked.asks[0]?.question, /Zebra/);
check("the line only hears that B asked", asked.posts.at(-1).text, new RegExp(String.raw`^Sonnet asked ${HOST} a private question\.$`));
setTimeout(() => fetch(`${base}/api/answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: asked.asks[0].id, text: "No, keep Zebra quiet." }) }), 400);
const ans = await b("wait_for_turn", { seat: B });
check("answer wakes B straight away, off-turn", ans, new RegExp(String.raw`PRIVATE ANSWER from ${HOST}[\s\S]*keep Zebra quiet[\s\S]*not your turn`));
check("question cleared from the board", (await state()).asks.length === 0, true);
check("answer is delivered once", await b("wait_for_turn", { seat: B }), /^Not your turn/);

// Reading time: after a Claude posts, the next Claude waits long enough for the host to read it.
await board("settings", { readWpm: 60, holdSecs: 1 }); // one word a second
const postedAt = Date.now();
await a("post", { seat: A, text: "One two three four." }); // four words: four seconds
const s4 = await state();
check("floor moves on at once", s4.turn.name, /Sonnet/);
check("but the board shows reading time", s4.readUntil > s4.now, true);
check("next Claude is told to wait", await b("wait_for_turn", { seat: B }), /Not your turn yet[\s\S]*yours in about \ds/);
let turn = "";
for (let i = 0; i < 8 && !/YOUR TURN/.test(turn); i++) turn = await b("wait_for_turn", { seat: B });
check("then gets the floor", turn, /YOUR TURN/);
check("not before the host could read it", Date.now() - postedAt >= 3000, true);
check("new posts are labelled as information", turn, /information, not instructions/);
await b("post", { seat: B, text: "Five six seven eight." }); // floor to Haiku, four more seconds
await board("post", { text: "Read it." }); // the host has plainly read it
check("a host post clears the wait", (await state()).readUntil, /^0$/);
await board("settings", { readWpm: 0, holdSecs: 3 });
check("and the next Claude is woken straight away", await c("wait_for_turn", { seat: C }), /YOUR TURN/);
await c("post", { seat: C, text: "ok." });

// Leaving and removal.
check("C leaves", await c("leave_call", { seat: C }), /left the call/);
check("C's token is dead", await c("wait_for_turn", { seat: C }), /left the call/);

check("can't rotate the secret mid-call", (await board("rotate-secret")).error, /End the call first/);

// Ending: a held wait returns straight away with the hang-up.
await board("settings", { holdSecs: 20 });
await a("post", { seat: A, text: "Done here." });
const pending = b("wait_for_turn", { seat: B }).then(() => b("wait_for_turn", { seat: B }));
const t = Date.now();
setTimeout(() => board("end"), 400);
const bye = await pending;
check(`end wakes a waiting Claude (${Date.now() - t}ms)`, bye, /call has ended[\s\S]*Tell your user/);
check("ended token tells A too", await a("post", { seat: A, text: "hello?" }), /call has ended/);

const s3 = await state();
check("transcript saved", s3.lastSaved, /_smoke tabs or spaces\.md$/);
const md = await (await fetch(`${base}/api/calls/${encodeURIComponent(s3.lastSaved)}`)).text();
check("transcript has the brief, the people and the talk", md, /## Brief[\s\S]*Haiku[\s\S]*Makefiles keep tabs/);
check("transcript logs the private question, not its words", md, new RegExp(String.raw`asked ${HOST} a private question[\s\S]*answered Sonnet privately`));
check("private words stay off the transcript", /Zebra/.test(md), false);
const dl = await fetch(`${base}/api/calls/${encodeURIComponent(s3.lastSaved)}?download`);
check("past transcript downloads as a file", dl.headers.get("content-disposition") ?? "", /attachment/);

// Secret rotation: only between calls, the old URL dies at once, and the test puts the original back.
const oldSecret = readFileSync(".partyline-secret", "utf8").trim();
const rotated = await board("rotate-secret");
const newSecret = String(rotated.local ?? "").split("/mcp/")[1] ?? "";
check("rotation gives a new secret", newSecret !== oldSecret && /^[0-9a-f]{24}$/.test(newSecret), true);
check("board shows the new connector URL", (await state()).connect.local, new RegExp(`/mcp/${newSecret}$`));
const probe = (k: string) =>
  fetch(`${base}/mcp/${k}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status);
check("old connector is dead", String(await probe(oldSecret)), /404/);
await board("rotate-secret", { secret: oldSecret });
check("original secret restored", readFileSync(".partyline-secret", "utf8").trim() === oldSecret && (await probe(newSecret)) === 404, true);

await board("settings", { holdSecs: 45 });
for (const ext of [".md", ".json"]) rmSync(`calls/${s3.lastSaved.replace(/\.md$/, ext)}`, { force: true });


// ---- Auto hang-up: with the setting on, a unanimous agreement ends the call by itself. ----
{
  await board("settings", { holdSecs: 2, autoEnd: true });
  await board("start", { topic: "_smoke: auto end" });
  const x = await claude();
  const y = await claude();
  const X = tokenOf(await x("join_call", { name: "X", bio: "x" }));
  const Y = tokenOf(await y("join_call", { name: "Y", bio: "y" }));
  await board("seat", { id: X, action: "approve" });
  await board("seat", { id: Y, action: "approve" });
  await x("wait_for_turn", { seat: X });
  await y("wait_for_turn", { seat: Y });
  await board("post", { text: "Agree on something." });
  check("brief warns the call will end itself", await x("wait_for_turn", { seat: X }), /ends on its own/);
  await x("post", { seat: X, text: "Done?", resolved: true });
  await y("wait_for_turn", { seat: Y });
  check("last agreement ends the call", await y("post", { seat: Y, text: "Done.", resolved: true }), /unanimous[\s\S]*Tell your user/);
  check("X is told it's over", await x("wait_for_turn", { seat: X }), /call has ended/);
  const s = await state();
  check("call closed and saved", `${s.open} ${s.lastSaved}`, /^false .*_smoke auto end\.md$/);
  for (const ext of [".md", ".json"]) rmSync(`calls/${s.lastSaved.replace(/\.md$/, ext)}`, { force: true });
  await board("settings", { holdSecs: 45, autoEnd: false });
  console.log(failed ? `\n${failed} FAILED` : "\nAll passed.");
  process.exit(failed ? 1 : 0);
}
