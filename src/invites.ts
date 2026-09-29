import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// An invite lets someone into the current call from outside: its code is both their board link (/join/<code>)
// and their AIs' connector (/mcp/<code>). Invites last until the call ends (see clearInvites), and
// survive a server restart mid-call; revoking one kicks everyone who came in on it. (Ported from Metagame.)

export type Invite = {
  code: string;
  label: string; // who it's for, as the host typed it
  created: string;
  last?: { name: string; bio: string }; // what they called themselves last time, to prefill the join form
};

const FILE = ".partyline-invites.json";

let invites: Invite[] = (() => {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
})();

const save = () => writeFileSync(FILE, JSON.stringify(invites, null, 2));

export const listInvites = () => invites;

export const getInvite = (code: string) => invites.find((i) => i.code === code);

export function createInvite(label: string): Invite {
  const inv = { code: randomBytes(16).toString("hex"), label: label.trim().slice(0, 40) || "A guest", created: new Date().toISOString() };
  invites.push(inv);
  save();
  return inv;
}

export function revokeInvite(code: string) {
  const had = invites.length;
  invites = invites.filter((i) => i.code !== code);
  save();
  return invites.length < had;
}

export function rememberGuest(code: string, last: Invite["last"]) {
  const inv = getInvite(code);
  if (!inv) return;
  inv.last = last;
  save();
}

/** Invites belong to one call: they all expire when it starts fresh or ends. */
export function clearInvites() {
  if (!invites.length) return;
  invites = [];
  save();
}
