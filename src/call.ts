import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearInvites } from "./invites.js";

export const HUMAN = "human";
export const CALLS_DIR = "calls";

export type Post = { n: number; at: number; author: string; text: string; system?: boolean; color?: string; resolved?: boolean };

/** A Claude asking its own human something off the record. Only the human it's addressed to sees the question and the answer. */
export type Ask = { id: number; at: number; from: string; fromName: string; to: string; question: string; answer?: string; delivered?: boolean };

/** Name colours, handed out in join order. The host keeps the first. */
export const PALETTE = ["#6cb8ff", "#ff9f6b", "#4cd9a0", "#c79bff", "#ffd166", "#ff7fa8", "#3cc9c9", "#b8e04a", "#e27fe0", "#c8c8d8"];

export type Seat = {
  token: string;
  name: string;
  bio: string;
  color: string;
  status: "pending" | "approved";
  joinedAt: number;
  lastCallAt: number;
  inHold: boolean;
  waitCalls: number;
  seen: number; // last post # this seat has been handed
  lastTurnDelivered: number;
  agrees: boolean; // thinks the call has done its job
  welcomed: boolean; // has been handed the brief and roster
  pid: string; // public id, for boards that mustn't see seat tokens (a guest's)
  human?: boolean; // an invited guest on their own board, not an AI
  via?: string; // the invite code this seat came in on
  viaName?: string; // who that invite is for
};

class Call {
  open = false;
  epoch = 0; // bumps on every start, so the board knows to wipe its log
  topic = "";
  brief = "";
  startedAt = 0;
  posts: Post[] = [];
  seats = new Map<string, Seat>();
  gone = new Map<string, string>(); // token -> why it's dead
  /** Who has the floor. `from` handed it over, so a question to the host comes back to the asker. */
  turn = { holder: null as string | null, no: 0, from: null as string | null };
  lastClaude: string | null = null; // last Claude to speak, so the rotation carries on after the host chimes in
  paused = false;
  aiStreak = 0; // Claude posts since the host last said anything
  passes = 0; // Claudes in a row who had nothing to add
  lastSaved = "";
  asks: Ask[] = [];
  humanName = process.env.HUMAN_NAME || "Host";
  settings = {
    turnCap: 20, // Claude posts in a row before the host has to weigh in (0 = no limit)
    holdSecs: Number(process.env.HOLD_SECONDS || 45), // how long one wait_for_turn call holds
    autoEnd: false, // Claudes hang up themselves once they all agree
    postLimit: Number(process.env.POST_LIMIT ?? 1200), // longest Claude post, in characters (0 = no limit). Longer ones bounce back to be trimmed.
  };

  private listeners = new Set<() => void>();

  private notify() {
    for (const fn of [...this.listeners]) fn();
  }

  /** Resolves on the next state change, or after `ms`. */
  change(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.listeners.add(done);
      signal?.addEventListener("abort", done);
    });
  }

  latest() {
    return this.posts.length;
  }

  since(n = 0) {
    return this.posts.filter((p) => p.n > n);
  }

  private add(author: string, text: string, extra: Partial<Post> = {}) {
    const post: Post = { n: this.posts.length + 1, at: Date.now(), author, text, ...extra };
    this.posts.push(post);
    this.notify();
    return post;
  }

  system(text: string) {
    return this.add("line", text, { system: true });
  }

  // ---- Starting and ending -------------------------------------------------

  start(topic: string, brief: string) {
    this.open = true;
    this.epoch++;
    this.topic = topic.trim().slice(0, 200);
    this.brief = brief.trim().slice(0, 4000);
    this.startedAt = Date.now();
    this.posts = [];
    this.seats.clear();
    this.departed = [];
    this.gone.clear();
    this.turn = { holder: null, no: 0, from: null };
    this.lastClaude = null;
    this.paused = false;
    this.aiStreak = 0;
    this.passes = 0;
    this.asks = [];
    clearInvites(); // any left over from a call that never ended cleanly
    this.system(`Call started: ${this.topic}`);
  }

  /** End the call, tell every Claude it's over, and save the transcript. */
  end(note = `${this.humanName} ended the call.`) {
    for (const s of this.seats.values()) this.gone.set(s.token, "ended");
    this.system(note);
    let saved = "";
    try {
      saved = this.save();
    } catch (err) {
      console.error("[end]", err); // ending must always work
    }
    this.seats.clear();
    clearInvites();
    this.turn.holder = null;
    this.open = false;
    this.lastSaved = saved;
    this.notify();
    return saved;
  }

  private save() {
    mkdirSync(CALLS_DIR, { recursive: true });
    const d = new Date(this.startedAt);
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    const slug = this.topic.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "call";
    const base = `${stamp} ${slug}`;
    writeFileSync(join(CALLS_DIR, base + ".md"), this.transcript());
    writeFileSync(join(CALLS_DIR, base + ".json"), JSON.stringify(this.exportJson(), null, 2));
    return base + ".md";
  }

  exportJson() {
    return {
      topic: this.topic,
      brief: this.brief,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      host: this.humanName,
      participants: this.everyone().map(({ name, bio, human, viaName }) => ({ name, bio, guest: !!human, via: human ? undefined : viaName })),
      posts: this.posts,
    };
  }

  transcript() {
    const who = this.everyone().map((s) => `- **${s.name}**${this.tag(s)}${s.bio ? `: ${s.bio}` : ""}`);
    const lines = this.posts.map((p) =>
      p.system ? `*${p.text}*` : `**${p.author}**${p.resolved ? " ✓" : ""}: ${p.text}`,
    );
    return [
      `# ${this.topic}`,
      "",
      `${new Date(this.startedAt).toLocaleString()} · hosted by ${this.humanName}`,
      "",
      ...(this.brief ? ["## Brief", "", this.brief, ""] : []),
      "## On the line",
      "",
      `- **${this.humanName}** (host)`,
      ...who,
      "",
      "## Transcript",
      "",
      ...lines.flatMap((l) => [l, ""]),
      "✓ = thought the question was settled",
      "",
    ].join("\n");
  }

  /** Everyone who was approved at some point this call, including anyone who has left. */
  private everyone() {
    return [...this.seats.values(), ...this.departed].filter((s) => s.status === "approved");
  }
  private departed: Seat[] = [];

  // ---- Seats ---------------------------------------------------------------

  /** Everyone on the line: AIs and invited guests. */
  approved() {
    return [...this.seats.values()].filter((s) => s.status === "approved");
  }

  /** The AIs on the line: they take turns in rotation and vote on "settled". Guests chime in like the host. */
  claudes() {
    return this.approved().filter((s) => !s.human);
  }

  /** The seat an invited guest is using, if they've asked for one. */
  guestSeat(code: string) {
    return [...this.seats.values()].find((s) => s.human && s.via === code);
  }

  /** " (guest)" or " (via Sam)", for rosters and transcripts. */
  tag(s: Seat) {
    return s.human ? " (guest)" : s.viaName ? ` (via ${s.viaName})` : "";
  }

  nameTaken(name: string) {
    const n = name.trim().toLowerCase();
    return n === this.humanName.toLowerCase() || [...this.seats.values()].some((s) => s.name.toLowerCase() === n);
  }

  join(name: string, bio: string, extra: { human?: boolean; via?: string; viaName?: string } = {}): Seat {
    const used = new Set([...this.seats.values()].map((s) => s.color));
    const color = PALETTE.slice(1).find((c) => !used.has(c)) ?? PALETTE[PALETTE.length - 1];
    const seat: Seat = {
      token: "seat-" + randomBytes(6).toString("hex"),
      name,
      bio,
      color,
      status: "pending",
      joinedAt: Date.now(),
      lastCallAt: Date.now(),
      inHold: false,
      waitCalls: 0,
      seen: 0,
      lastTurnDelivered: 0,
      agrees: false,
      welcomed: false,
      pid: "p-" + randomBytes(4).toString("hex"),
      ...extra,
    };
    this.seats.set(seat.token, seat);
    this.notify();
    return seat;
  }

  approve(token: string) {
    const seat = this.seats.get(token);
    if (!seat || seat.status !== "pending") return false;
    seat.status = "approved";
    this.system(`${seat.name}${this.tag(seat)} joined.${seat.bio ? " " + seat.bio : ""}`);
    return true;
  }

  /** Deny, remove, or let go of a seat. The token dies either way. */
  drop(token: string, why: "denied" | "removed" | "left") {
    const seat = this.seats.get(token);
    if (!seat) return false;
    const wasOn = seat.status === "approved";
    if (wasOn) this.departed.push(seat);
    this.seats.delete(token);
    this.gone.set(token, why);
    if (this.lastClaude === token) this.lastClaude = null;
    if (wasOn) this.system(why === "left" ? `${seat.name} left the call.` : `${seat.name} was removed from the call.`);
    if (this.turn.holder === token) this.handOn(token);
    else this.notify();
    return true;
  }

  // ---- The floor -----------------------------------------------------------

  private giveTurn(holder: string | null, from: string | null) {
    this.turn = { holder, no: this.turn.no + 1, from };
    this.notify();
  }

  /** The next Claude after `after` in join order, skipping `after` itself. Null if there's nobody else. */
  private nextAfter(after: string | null) {
    const ids = this.claudes().map((s) => s.token);
    if (!ids.length) return null;
    const i = after ? ids.indexOf(after) : -1;
    for (let k = 1; k <= ids.length; k++) {
      const id = ids[(i + k + ids.length) % ids.length];
      if (id !== after) return id;
    }
    return null;
  }

  /** Pass the floor on from `from`: to the next Claude, or to the host when there's no one else. */
  private handOn(from: string) {
    this.giveTurn(this.nextAfter(from) ?? HUMAN, from);
  }

  holderByName(name: string) {
    const n = name.trim().replace(/^@/, "").toLowerCase();
    if (n === this.humanName.toLowerCase() || n === "host") return HUMAN;
    return this.approved().find((s) => s.name.toLowerCase() === n)?.token ?? null;
  }

  allAgree() {
    const on = this.claudes();
    return on.length > 0 && on.every((s) => s.agrees);
  }

  /** A Claude speaks, which ends their turn. Returns an error message, or the post. */
  claudePost(token: string, text: string, nextName?: string, resolved = false): Post | string {
    const seat = this.seats.get(token)!;
    if (this.turn.holder !== token) return `It's not your turn. ${this.statusFor(seat)}`;
    let next: string | null = null;
    if (nextName) {
      next = this.holderByName(nextName);
      if (!next) return `No one called "${nextName}" is on the call. On the line: ${this.roster()}.`;
      if (next === token) return "You can't hand the floor to yourself. Leave `next` out to pass it on as usual.";
    }
    // Bounce, never truncate: the conclusion is always at the end.
    const limit = this.settings.postLimit;
    if (limit > 0 && text.length > limit)
      return `Too long: ${text.length} characters, and the limit on this call is ${limit}. Nothing was posted and you still have the floor. Cut it down to what matters most and post again.`;

    const post = this.add(seat.name, text, { color: seat.color, resolved: resolved || undefined });
    // Something new on the table reopens the question, unless it's an agreement.
    if (resolved) seat.agrees = true;
    else for (const s of this.seats.values()) s.agrees = false;
    this.lastClaude = token;
    this.passes = 0;
    this.aiStreak++;

    if (this.allAgree() && this.settings.autoEnd) {
      this.end("Everyone agreed it's settled, so the call ended itself.");
    } else if (this.allAgree()) {
      this.system(`Everyone on the line thinks this is settled. Over to ${this.humanName} to wrap up or end the call.`);
      this.giveTurn(HUMAN, token);
    } else if (this.settings.turnCap > 0 && this.aiStreak >= this.settings.turnCap && next !== HUMAN) {
      this.system(`${this.aiStreak} messages without ${this.humanName}. Holding the line until ${this.humanName} weighs in.`);
      this.giveTurn(HUMAN, token);
    } else if (next) this.giveTurn(next, token);
    else this.handOn(token);
    return post;
  }

  /** A Claude had the floor and nothing to add. */
  pass(token: string) {
    this.passes++;
    if (this.passes >= this.claudes().length) {
      this.passes = 0;
      this.system(`Nobody has anything to add. Over to ${this.humanName}.`);
      this.giveTurn(HUMAN, token);
    } else this.handOn(token);
  }

  /** The host speaks. "@Name" hands that Claude the floor; otherwise an idle floor goes back to the Claudes. */
  humanPost(text: string) {
    const settled = this.allAgree();
    this.add(this.humanName, text, { color: PALETTE[0] });
    this.aiStreak = 0;
    this.passes = 0;
    const at = this.mentioned(text);
    // Once everyone's agreed, a "thanks, all" mustn't reopen it and set off a round of re-agreeing.
    // Only an @mention (or a seat click) brings the Claudes back in.
    if (settled && !at) return;
    for (const s of this.seats.values()) s.agrees = false;
    if (at) return this.giveTurn(this.holderByName(at), HUMAN);
    if (this.turn.holder !== null && this.turn.holder !== HUMAN) return; // a Claude has it; they'll see this next turn
    const back = this.turn.from && this.seats.get(this.turn.from)?.status === "approved" ? this.turn.from : null;
    const to = back ?? this.nextAfter(this.lastClaude);
    if (to) this.giveTurn(to, HUMAN);
  }

  /** An invited guest speaks. They can chime in any time; if they held the floor, it moves on like the host's would. */
  guestPost(token: string, text: string) {
    const seat = this.seats.get(token)!;
    const settled = this.allAgree();
    this.add(seat.name, text, { color: seat.color });
    this.passes = 0;
    const at = this.mentioned(text, token);
    if (!settled || at) for (const s of this.seats.values()) s.agrees = false; // the host's settled-quiet rule, for guests too
    if (this.turn.holder !== token) return;
    if (at) return this.giveTurn(this.holderByName(at), token);
    const from = this.turn.from;
    const back = from && from !== token && (from === HUMAN || this.seats.get(from)?.status === "approved") ? from : null;
    this.giveTurn(back ?? this.nextAfter(this.lastClaude) ?? HUMAN, token);
  }

  /** The name `text` @mentions, if any. Longest first, so "@Opus (web)" beats "@Opus". */
  private mentioned(text: string, exclude?: string) {
    const names = this.approved().filter((s) => s.token !== exclude).map((s) => s.name).sort((a, b) => b.length - a.length);
    return names.find((n) => new RegExp(`@${escapeRe(n)}(?![\\w-])`, "i").test(text));
  }

  // ---- Asking your own human, off the record ---------------------------------

  /** A seat's own human: the guest whose invite it came in on, or the host. Null if that guest isn't on the board. */
  humanFor(seat: Seat) {
    if (!seat.via) return HUMAN;
    const g = this.guestSeat(seat.via);
    return g?.status === "approved" ? g.token : null;
  }

  /** A Claude asks its own human something. The line learns that it happened, never what was said. */
  ask(token: string, question: string): Ask | string {
    const seat = this.seats.get(token)!;
    const to = this.humanFor(seat);
    if (!to)
      return `${seat.viaName ?? "Your human"} isn't on the call's board right now, so there's no one to ask privately. Carry on, and raise it with them after the call.`;
    const ask: Ask = { id: this.asks.length + 1, at: Date.now(), from: token, fromName: seat.name, to, question };
    this.asks.push(ask);
    this.system(`${seat.name} asked ${this.nameOf(to)} a private question.`);
    return ask;
  }

  /** `by` answers a question put to them. */
  answer(id: number, text: string, by: string) {
    const ask = this.asks.find((a) => a.id === id && a.to === by && a.answer === undefined);
    if (!ask) return false;
    ask.answer = text;
    this.system(`${this.nameOf(by)} answered ${ask.fromName} privately.`);
    return true;
  }

  /** Questions waiting on `to`, from Claudes still on the line. */
  openAsks(to: string) {
    return this.asks.filter((a) => a.to === to && a.answer === undefined && this.seats.has(a.from));
  }

  /** Answers this seat hasn't been handed yet. */
  answersFor(token: string) {
    return this.asks.filter((a) => a.from === token && a.answer !== undefined && !a.delivered);
  }

  /** The host clicked a seat: that Claude has the floor now. */
  hostGive(holder: string | null) {
    this.aiStreak = 0;
    this.passes = 0;
    this.giveTurn(holder, HUMAN);
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.system(paused ? `${this.humanName} put the call on hold.` : "Back on.");
  }

  updateSettings(s: Partial<Call["settings"]>) {
    Object.assign(this.settings, s);
    this.notify();
  }

  /** True when this seat holds a turn it hasn't been told about yet. */
  pendingTurnFor(seat: Seat) {
    return !this.paused && this.turn.holder === seat.token && this.turn.no > seat.lastTurnDelivered;
  }

  nameOf(token: string | null) {
    if (token === HUMAN) return this.humanName;
    return token ? this.seats.get(token)?.name ?? null : null;
  }

  /** What the call is doing right now, for a Claude who's waiting. */
  statusFor(seat: Seat) {
    let now: string;
    if (this.paused) now = `${this.humanName} has put the call on hold.`;
    else if (this.turn.holder === HUMAN) now = `${this.humanName} (the human host) has the floor. Humans take longer, so expect a wait.`;
    else if (this.turn.holder === seat.token) now = "You have the floor.";
    else if (this.turn.holder && this.seats.get(this.turn.holder)?.human)
      now = `${this.nameOf(this.turn.holder)} (a human guest) has the floor. Humans take longer, so expect a wait.`;
    else if (this.turn.holder) now = `${this.nameOf(this.turn.holder)} has the floor.`;
    else now = `Waiting on ${this.humanName} to get things going.`;
    return `${now} The call is still live; quiet stretches are normal.`;
  }

  roster() {
    return [`${this.humanName} (host)`, ...this.approved().map((s) => s.name)].join(", ");
  }

  rosterWithBios() {
    return [
      `• ${this.humanName}: the human host. They approve who joins and end the call.`,
      ...this.approved().map((s) =>
        s.human
          ? `• ${s.name}: a human guest, invited by ${this.humanName}. ${s.bio}`.trim()
          : `• ${s.name}${s.viaName ? ` (${s.viaName}'s AI)` : ""}: ${s.bio || "(no bio)"}`,
      ),
    ].join("\n");
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const call = new Call();

export function fmt(posts: Post[]) {
  return posts
    .map((p) => (p.system ? `[#${p.n}] — ${p.text}` : `[#${p.n}] ${p.author}${p.resolved ? " (thinks we're done)" : ""}: ${p.text}`))
    .join("\n");
}

/** Saved transcripts, newest first. */
export function savedCalls() {
  try {
    return readdirSync(CALLS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ file: f, at: statSync(join(CALLS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export function readSaved(file: string) {
  if (!/^[^/\\]+\.md$/.test(file)) return null;
  try {
    return readFileSync(join(CALLS_DIR, file), "utf8");
  } catch {
    return null;
  }
}

/** Delete a saved call: its transcript and its JSON. */
export function deleteSaved(file: string) {
  if (!/^[^/\\]+\.md$/.test(file) || !existsSync(join(CALLS_DIR, file))) return false;
  rmSync(join(CALLS_DIR, file));
  rmSync(join(CALLS_DIR, file.replace(/\.md$/, ".json")), { force: true });
  return true;
}
