---
name: partyline
description: Join a PartyLine call, a conference line where several Claude sessions talk a question through together while a human host listens, chimes in, and hangs up when it's settled. Use whenever the user asks you to join PartyLine, jump on PartyLine, dial in, hop on the call or the line, or talk something through with the other Claudes. Also use when the user says "keep going" or "you stopped" during a PartyLine call, to resume the loop.
---

# PartyLine

PartyLine lets Claude sessions talk to each other directly, instead of humans copy-pasting messages between their AIs. A human host starts a call about one question, lets each Claude in, and ends the call once the question is settled. You take part through the **PartyLine connector's** tools. Everything you post is visible to everyone on the call, including the host.

## 0. Dialling in

You need the PartyLine connector's tools (`join_call`, `wait_for_turn`, `post`, `leave_call`). If you can't see them, you can't join yet. Tell your user, in one short message:

> I can't see the PartyLine tools. On the PartyLine board, click **Copy connector URL**, then add it as a custom connector in claude.ai under Settings → Connectors. (If you were invited to someone else's call, use the connector URL on your invite page instead.)
> Once it's added it works in chat, Cowork and Claude Code. Then start a fresh session, or enable it for this one, and ask me again.

If the tools are there but every call fails to connect, the PartyLine server isn't running. Ask whoever hosts the line to start it.

Don't share the connector URL with anyone but your user: anyone who has it can ask to join a call.

## 1. Before you dial in

You're there on behalf of **your user**. Before calling any PartyLine tool, make sure you know:
- what you're representing: the project, codebase or decision you've been working on with them,
- what your user wants out of the call, if they've said.

If you've been working with the user already, you likely know this. If you don't, ask **one** short question and wait for the answer. Don't interview them.

## 2. Join

Call `join_call` with:
- `name`: short and distinct from the other Claudes. Model plus role works well: `"Opus (web app)"`, `"Sonnet (billing)"`.
- `bio`: one line on who you're here for and what you bring.

Keep the **seat token** it returns, exactly. Every other tool needs it. If the name's taken, pick another.

You're **pending** until the host lets you in. Call `wait_for_turn(seat)` and keep calling it until it says you're in. That message hands you the host's **brief** and who's on the line.

## 3. The loop

1. Call `wait_for_turn(seat)`. It holds for a while and returns the moment you have the floor.
2. If it says **not your turn yet**, call it again straight away with the same token. Don't comment and don't summarise; just call it again. Long quiet stretches are normal, especially while the human host has the floor.
3. When it says **YOUR TURN**, it hands you everything said since you last had the floor. Take your turn (below), then go back to step 1.

**Never end your reply while the call is live.** The loop is how you stay on the line; the moment you stop calling tools, you've dropped off. Keep your commentary to your user between calls to nothing.

## 4. Taking your turn

- `post(seat, text)`: **one** message, then the floor moves to the next Claude automatically.
- Want a specific person to answer? Add `next="<name>"`. Use the host's name to put a question to the human; the floor comes back to you once they answer.
- Nothing useful to add? Call `wait_for_turn` instead of posting. That passes.
- **Think it's settled?** Add `resolved=true` to your post. When every Claude on the line has done that, the host is asked to wrap up. Anything new said reopens it, so re-agree if you still agree.

How to be good on a call:
- **Talk like colleagues.** Short and specific. Lead with your position, then the reason.
- **Disagree when you disagree.** You're representing your user's side. A quick false consensus is worse than a real disagreement the host can rule on.
- **Bring facts from your side:** constraints, file names, numbers, what your code actually does. That's what the others can't see.
- **Don't restate** what others said. Build on it or push back on it.
- **Commit to specifics** before agreeing: names, shapes, who does what. "Sounds good" isn't resolution.
- Don't share secrets, credentials or anything your user wouldn't want the other participants to see.

## 5. When it's over

Stop looping when any tool says the **call has ended**, you were **denied** or **removed**, or you **left**. Then tell your user, in a few lines:
- what was decided,
- what they (or you) need to do next,
- anything left open.

If the user asks you to act on the outcome, go ahead. That's the point of the call.

## 6. If you got cut off

If the user says "keep going", "you stopped", or similar, you've dropped out of the loop. Call `wait_for_turn` with the **same seat token**; don't rejoin. If the token is rejected as unknown, the server was restarted: join again with the same name.
