import express from "express";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp.js";
import { call, deleteSaved, HUMAN, PALETTE, readSaved, savedCalls, type Seat } from "./call.js";
import { createInvite, getInvite, listInvites, rememberGuest, revokeInvite, type Invite } from "./invites.js";

// Settings come from the environment, or from .env (see .env.example).
const PORT = Number(process.env.PORT || 8788);
// TUNNEL: empty = no tunnel (Claude Code on this machine only); "quick" = a throwaway trycloudflare.com
// URL that changes every start; anything else = the name of your own Cloudflare tunnel, served at TUNNEL_HOST.
const TUNNEL = process.env.TUNNEL || "";
const QUICK = TUNNEL === "quick";
const TUNNEL_HOST = process.env.TUNNEL_HOST || "";
if (TUNNEL && !QUICK && !TUNNEL_HOST) {
  console.error(`TUNNEL=${TUNNEL} needs TUNNEL_HOST too: the hostname your tunnel serves, e.g. partyline.example.com.`);
  process.exit(1);
}
const CLOUDFLARED_DEFAULT = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
let tunnelUp = false;
// Where people outside this computer reach the line. A quick tunnel only learns its URL once cloudflared connects.
let publicBase = TUNNEL && !QUICK ? `https://${TUNNEL_HOST}` : "";

// The MCP endpoint lives at a secret path so a stranger who finds the tunnel can't dial in.
const SECRET_FILE = ".partyline-secret";
let SECRET =
  process.env.PARTYLINE_SECRET ||
  (existsSync(SECRET_FILE)
    ? readFileSync(SECRET_FILE, "utf8").trim()
    : (() => {
        const s = randomBytes(12).toString("hex");
        writeFileSync(SECRET_FILE, s);
        return s;
      })());

const localUrl = () => `http://localhost:${PORT}/mcp/${SECRET}`;
const publicUrl = () => (publicBase ? `${publicBase}/mcp/${SECRET}` : "");

const app = express();

// Stateless MCP: a fresh server + transport per request. Identity comes from the seat token, not the session.
// The host's AIs come in on the secret; a guest's come in on their invite code, and their seats say so.
app.post("/mcp/:key", express.json({ limit: "1mb" }), async (req, res) => {
  const key = String(req.params.key);
  const invite = key === SECRET ? undefined : getInvite(key);
  if (key !== SECRET && !invite) return res.status(404).end();
  const server = buildServer(invite && { code: invite.code, label: invite.label });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp]", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.all("/mcp/:key", (_req, res) => res.status(405).set("Allow", "POST").end());

// The board is local-only. The server only listens on this computer, and anything relayed in by a
// tunnel (Cloudflare, ngrok, a reverse proxy) carries a forwarding header, so that's turned away too.
const FORWARDED = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded"];
const localOnly: express.RequestHandler = (req, res, next) =>
  FORWARDED.some((h) => req.headers[h]) ? res.status(404).end() : next();

app.get("/", localOnly, (_req, res) => res.sendFile("board.html", { root: "public" }));

app.get("/api/state", localOnly, (req, res) => {
  const since = Number(req.query.since || 0);
  res.json({
    open: call.open,
    epoch: call.epoch,
    topic: call.topic,
    brief: call.brief,
    startedAt: call.startedAt,
    humanName: call.humanName,
    humanHex: PALETTE[0],
    turn: { ...call.turn, name: call.nameOf(call.turn.holder) },
    readUntil: call.readUntil,
    paused: call.paused,
    aiStreak: call.aiStreak,
    allAgree: call.allAgree(),
    settings: call.settings,
    latest: call.latest(),
    posts: call.since(since),
    seats: [...call.seats.values()].map(({ token, via, ...s }) => ({ id: token, ...s })),
    asks: call.openAsks(HUMAN).map(({ id, at, fromName, question }) => ({ id, at, fromName, question })),
    connect: { local: localUrl(), public: publicUrl(), tunnelUp },
    lastSaved: call.lastSaved,
    now: Date.now(),
  });
});

app.post("/api/start", localOnly, express.json(), (req, res) => {
  const topic = String(req.body.topic ?? "").trim();
  if (!topic) return res.status(400).json({ error: "What's the call about? Give it a topic." });
  if (call.open) return res.status(409).json({ error: "A call is already live. End it first." });
  call.start(topic, String(req.body.brief ?? ""));
  res.json({ ok: true });
});

app.post("/api/end", localOnly, (_req, res) => {
  res.json({ ok: true, saved: call.open ? call.end() : "" });
});

app.post("/api/seat", localOnly, express.json(), (req, res) => {
  const { id, action } = req.body as { id: string; action: "approve" | "deny" | "remove" };
  const ok = action === "approve" ? call.approve(id) : call.drop(id, action === "deny" ? "denied" : "removed");
  res.status(ok ? 200 : 400).json({ ok });
});

app.post("/api/turn", localOnly, express.json(), (req, res) => {
  if (!call.open) return res.status(409).json({ error: "No call is live." });
  const holder: string | null = req.body.holder ?? null;
  if (holder && holder !== HUMAN && call.seats.get(holder)?.status !== "approved") return res.status(400).json({ error: "No such seat." });
  call.hostGive(holder);
  res.json({ ok: true });
});

app.post("/api/post", localOnly, express.json({ limit: "1mb" }), (req, res) => {
  if (!call.open) return res.status(409).json({ error: "No call is live." });
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });
  call.humanPost(text);
  res.json({ ok: true });
});

app.post("/api/answer", localOnly, express.json({ limit: "1mb" }), (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });
  res.status(call.answer(Number(req.body.id), text, HUMAN) ? 200 : 404).json({});
});

app.post("/api/pause", localOnly, express.json(), (req, res) => {
  if (!call.open) return res.status(409).json({ error: "No call is live." });
  call.setPaused(!!req.body.paused);
  res.json({ ok: true });
});

// A new connector secret. The old URL dies at once, so every AI dialled in on it would be cut off: only between
// calls. Invite codes are separate and unaffected. `secret` lets the tests put the original back afterwards.
app.post("/api/rotate-secret", localOnly, express.json(), (req, res) => {
  if (call.open) return res.status(409).json({ error: "End the call first. Rotating the secret cuts off every Claude dialled in on it." });
  if (process.env.PARTYLINE_SECRET) return res.status(409).json({ error: "The secret is set by PARTYLINE_SECRET in your environment or .env. Change it there and restart." });
  const given = String(req.body?.secret ?? "");
  if (given && !/^[0-9a-f]{24}$/.test(given)) return res.status(400).json({ error: "A secret is 24 hex characters." });
  SECRET = given || randomBytes(12).toString("hex");
  writeFileSync(SECRET_FILE, SECRET);
  console.log(`Secret rotated. Claude Code URL:   ${localUrl()}`);
  if (publicUrl()) console.log(`                 claude.ai URL:     ${publicUrl()}`);
  res.json({ ok: true, local: localUrl(), public: publicUrl() });
});

app.post("/api/settings", localOnly, express.json(), (req, res) => {
  const b = req.body;
  const s: Partial<typeof call.settings> = {};
  if (typeof b.autoEnd === "boolean") s.autoEnd = b.autoEnd;
  if (Number.isFinite(b.turnCap) && b.turnCap >= 0) s.turnCap = Math.round(b.turnCap);
  if (Number.isFinite(b.holdSecs) && b.holdSecs >= 1 && b.holdSecs <= 600) s.holdSecs = Math.round(b.holdSecs);
  if (Number.isFinite(b.postLimit) && b.postLimit >= 0 && b.postLimit <= 6000) s.postLimit = Math.round(b.postLimit);
  if (Number.isFinite(b.readWpm) && b.readWpm >= 0 && b.readWpm <= 2000) s.readWpm = Math.round(b.readWpm);
  call.updateSettings(s);
  res.json({ ok: true });
});

app.get("/api/calls", localOnly, (_req, res) => {
  res.json(savedCalls());
});
app.get("/api/calls/:file", localOnly, (req, res) => {
  const md = readSaved(String(req.params.file));
  if (md === null) return res.status(404).end();
  if (req.query.download !== undefined) res.attachment(String(req.params.file));
  res.type("text/markdown").send(md);
});
app.delete("/api/calls/:file", localOnly, (req, res) => {
  res.status(deleteSaved(String(req.params.file)) ? 200 : 404).json({});
});
app.get("/api/transcript.md", localOnly, (_req, res) => {
  res.attachment(`${call.topic || "partyline"}.md`).type("text/markdown").send(call.transcript());
});

// ---- Invites: the host's side --------------------------------------------------

const inviteLinks = (code: string) => {
  const base = publicBase || `http://localhost:${PORT}`;
  return { board: `${base}/join/${code}`, connector: `${base}/mcp/${code}` };
};

app.get("/api/invites", localOnly, (_req, res) => {
  res.json(listInvites().map((i) => ({ code: i.code, label: i.label, created: i.created, ...inviteLinks(i.code) })));
});
app.post("/api/invites", localOnly, express.json(), (req, res) => {
  if (!call.open) return res.status(409).json({ error: "Start a call first. Invites are for one call and expire when it ends." });
  const inv = createInvite(String(req.body.label ?? ""));
  res.json({ code: inv.code, label: inv.label, ...inviteLinks(inv.code) });
});
// Revoking kicks everyone who came in on the invite: the guest and their AIs.
app.post("/api/invites/revoke", localOnly, express.json(), (req, res) => {
  const code = String(req.body.code ?? "");
  if (!revokeInvite(code)) return res.status(404).json({ error: "No such invite." });
  for (const s of [...call.seats.values()]) if (s.via === code) call.drop(s.token, "removed");
  res.json({ ok: true });
});

// ---- Invites: the guest's side ------------------------------------------------
// /join/<code> and /g/<code>/api/* are reachable through the tunnel, gated by the code.
// A guest's board is the host's board in guest mode: it can read and post, never steer.
// No seat tokens leave the server; seats are named by their public id.

app.get("/join/:code", (req, res) => {
  if (!getInvite(String(req.params.code))) return res.status(404).type("text/plain").send("This invite link isn't valid any more. Ask the host for a new one.");
  res.sendFile("board.html", { root: "public" });
});

const guest = express.Router({ mergeParams: true });
type GuestLocals = { invite: Invite; me: Seat | undefined };
guest.use((req, res, next) => {
  const invite = getInvite(String((req.params as { code?: string }).code));
  if (!invite) return res.status(404).json({ error: "This invite isn't valid any more." });
  Object.assign(res.locals, { invite, me: call.guestSeat(invite.code) } satisfies GuestLocals);
  next();
});

guest.get("/state", (req, res) => {
  const { invite, me } = res.locals as GuestLocals;
  if (me) me.lastCallAt = Date.now(); // the host's board shows whether they're still here
  const mine = me?.status === "approved" ? me.token : null;
  const pub = (h: string | null) => (h === null ? null : h === mine ? "me" : h === HUMAN ? "host" : call.seats.get(h)?.pid ?? null);
  res.json({
    guest: { status: me?.status ?? "none", label: invite.label, last: invite.last ?? null, connector: inviteLinks(invite.code).connector },
    open: call.open,
    epoch: call.epoch,
    topic: mine ? call.topic : "", // nothing about the call, not even its topic, until the host lets you in
    brief: mine ? call.brief : "",
    humanName: me?.name ?? invite.last?.name ?? invite.label, // "you", for styling your own posts
    hostName: call.humanName,
    humanHex: PALETTE[0],
    turn: { no: call.turn.no, holder: pub(call.turn.holder), name: call.nameOf(call.turn.holder) },
    paused: call.paused,
    allAgree: call.allAgree(),
    latest: call.latest(),
    posts: mine ? call.since(Number(req.query.since || 0)) : [],
    seats: mine
      ? call.approved().filter((s) => s.token !== mine).map((s) => ({
          id: s.pid, name: s.name, bio: s.bio, color: s.color, status: s.status, human: !!s.human, via: s.viaName ?? null,
          agrees: s.agrees, inHold: s.inHold, lastCallAt: s.lastCallAt, lastTurnDelivered: s.lastTurnDelivered,
        }))
      : [],
    asks: mine ? call.openAsks(mine).map(({ id, at, fromName, question }) => ({ id, at, fromName, question })) : [],
    now: Date.now(),
  });
});

// Ask for a seat. The host lets them in like anyone else.
guest.post("/join", express.json(), (req, res) => {
  const { invite, me } = res.locals as GuestLocals;
  if (!call.open) return res.status(409).json({ error: "No call is live right now." });
  if (me) return res.status(409).json({ error: "You already have a seat." });
  const name = String(req.body.name ?? "").trim().slice(0, 40);
  const bio = String(req.body.bio ?? "").trim().slice(0, 300);
  if (!name) return res.status(400).json({ error: "What should the line call you?" });
  if (call.nameTaken(name)) return res.status(400).json({ error: `Someone's already called ${name}. Pick another name.` });
  call.join(name, bio, { human: true, via: invite.code, viaName: invite.label });
  rememberGuest(invite.code, { name, bio });
  res.json({ ok: true });
});

guest.post("/post", express.json({ limit: "1mb" }), (req, res) => {
  const { me } = res.locals as GuestLocals;
  if (!call.open || me?.status !== "approved") return res.status(409).json({ error: "You're not on the call." });
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "empty" });
  call.guestPost(me.token, text);
  res.json({ ok: true });
});

// Answer a question one of their own AIs asked them privately.
guest.post("/answer", express.json({ limit: "1mb" }), (req, res) => {
  const { me } = res.locals as GuestLocals;
  const text = String(req.body.text || "").trim();
  if (!me || !text) return res.status(400).json({ error: "empty" });
  res.status(call.answer(Number(req.body.id), text, me.token) ? 200 : 404).json({});
});

app.use("/g/:code/api", guest);

// 127.0.0.1 only: nobody else on your network can open the board. Tunnels connect from this computer.
app.listen(PORT, "127.0.0.1", (err?: Error) => {
  if (err) {
    console.error(`Couldn't start on port ${PORT}: ${err.message}. Is another PartyLine already running?`);
    process.exit(1);
  }
  console.log(`PartyLine board:   http://localhost:${PORT}/`);
  console.log(`Claude Code URL:   ${localUrl()}`);
  if (publicUrl()) console.log(`claude.ai URL:     ${publicUrl()}`);
  if (TUNNEL) startTunnel();
});

// Cloudflare tunnel rides along with the server, for claude.ai chats. TUNNEL= (empty) to skip it.
function startTunnel() {
  const exe = existsSync(CLOUDFLARED_DEFAULT) ? CLOUDFLARED_DEFAULT : "cloudflared";
  const target = `http://127.0.0.1:${PORT}`;
  const args = QUICK ? ["tunnel", "--url", target] : ["tunnel", "run", "--url", target, TUNNEL];
  const cf = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
  cf.stderr.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      const quickUrl = QUICK && line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (quickUrl && !publicBase) {
        publicBase = quickUrl[0];
        console.log(`claude.ai URL:     ${publicUrl()}   (quick tunnel: this changes every time you start)`);
      }
      if (/Registered tunnel connection/.test(line) && !tunnelUp) {
        tunnelUp = true;
        console.log("Tunnel:            connected");
      } else if (/\b(ERR|error)\b/.test(line)) console.log("[tunnel]", line.trim());
    }
  });
  cf.on("error", (e) => console.error(`[tunnel] couldn't start cloudflared: ${e.message}`));
  cf.on("exit", (code) => {
    tunnelUp = false;
    console.log(`[tunnel] exited (${code})`);
  });
  const stop = () => {
    cf.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
