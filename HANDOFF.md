# Handoff

## Changes and ownership

I made these changes with Claude Code as a pair (see the last section). Done means it is in the code and has a test.

**Done: base, R1–R6**
- `6001dab` **R1:** webhooks are deduplicated by `(tenant_id, event_id)`, in the same transaction as the business change.
- `79cb740` **R2:** tickets are scoped to the server-resolved actor's organization. A foreign ticket is a 404, like a missing one.
- `1d61fcf` **R3:** only the exact approved version is sent. The attempt is claimed before the provider call, so a repeated click sends once.
- `75895f6` **R4:** a timeout is `UNKNOWN` with its `clientRef` and is never resent; a 503 is `FAILED`. Check delivery resolves `UNKNOWN` only from provider evidence, and `not_found` stays `UNKNOWN`. On startup, an attempt left `SENDING` becomes `UNKNOWN`.
- `d2821e2` **R5:** the server refuses automation once a human owns the ticket.
- `7a7367b` **R6:** the inbox shows the true delivery state, approval per version, a readable audit and a next safe action computed by the server. Customer text is rendered as text.

**Done: extras I found after the base** (see Verification)
- `7ee8a57` **R4:** after a 503, the same version can be sent again with a new `clientRef` (one live attempt per version). Old databases are migrated on startup, keeping their rows.
- `e4a2e1f` **R4:** a provider answer only moves an attempt that is still open. Before this, Check delivery during an in-flight send wrote a second "sent" row, and a late 504 could turn `SENT` back into `UNKNOWN`.
- `9ba7b04` **R5/R6:** the audit records who dispatched each attempt before the provider call, so it shows an automation send that started before a takeover.

**Proposed, not done:** the table in "Remaining risks".

## Verification

To test from a clean checkout: `npm test` (Node 24, nothing to install). To run the app: `npm run provider` and `npm start`.

I ran my 31 tests against three versions of the code:

| Version | Result |
|---|---|
| The starter as received (`b28f114`) | 8 pass, 23 fail |
| After the R1–R6 base (`7a7367b`) | 26 pass, 5 fail (the cases of the three extras) |
| Final (`9ba7b04`) | 31 pass |

**Extra bugs:** after the base, I ran the tests from my first pass (see the last section) against this code to find cases I had missed. I fixed three of them (the extras above). The ones I did not fix are in "Remaining risks".

**Checked only by hand** in the running app: resending after a 503, Check delivery during a slow send, and five Check delivery calls at the same time (two "sent" rows before the fix, one after).

## Operator instructions

- **`UNKNOWN`:** we sent the message and got no clear answer. The customer may already have it.
- **What to do:** press **Check delivery**. If the provider confirms it, it becomes `SENT`. If the provider has no record yet, it stays `UNKNOWN`: check again later.
- **What not to do:** do not resend, and do not edit and re-approve to push it through. The server refuses a new send while an attempt is uncertain.
- **`FAILED`:** the provider rejected it before accepting it. It was not delivered, and it is safe to send again.
- **After a restart:** an in-flight send becomes `UNKNOWN` with an audit row. Use Check delivery. Nothing is resent automatically.

## Remaining risks and production plan

This is not production-ready. Known gaps:

| Gap | Next fix |
|---|---|
| Some malformed webhooks (e.g. missing `tenantId`) do not get a clean 400 | Validate field types first |
| `eventId` `1` and `"1"` are stored as two events | Normalize `eventId` to a string |
| A token without the `Bearer ` prefix is accepted | Require the exact `Bearer <token>` form |
| An id like `0202` reaches the actor's own ticket (no foreign access) | Accept only canonical ids |
| A lookup with `count > 1` resolves without flagging the duplicate | Record and show a warning |
| A malformed lookup answer throws a SQLite error instead of staying `UNKNOWN` | Accept "delivered" only with a string `providerMessageId` |
| Approve on a page showing v1 approves a v2 the operator never saw | Send the shown version; 409 if it differs |
| Reconciling v1 while v2 is approved sets the ticket to `SENT` | Update the state only for the current version |
| A `null` JSON body on draft gives a 502 with a JS `TypeError` | Reject it with 400 |

Other shortcuts: demo tokens and the webhook secret are fixed; messages have no timestamps; the inbox list refreshes only on Refresh.

**Single process and SQLite:** the claim before the provider call works because there is one process and one SQLite file. With several app instances, the same rule has to live in a shared database (for example, a unique index on the live attempt in Postgres), and old `UNKNOWN` attempts would need a scheduled check instead of only the button.

**First checks for a real GHL pilot:**
1. Confirm what GHL returns for "rejected before acceptance" versus "accepted, no answer". The resend after `FAILED` depends on it.
2. Confirm we can look up a message by our own reference. Without that, Check delivery has no evidence.
3. Use real webhook signatures and real identities.
4. Monitor the count and age of `UNKNOWN` attempts, repeated `not_found`, and `count > 1`.
5. Rollback: take over the affected tickets to stop automation, then restore the previous build. The migration is one-way, so back up `desk.sqlite` first.
6. Start with one internal test contact.

## AI use and time

**Two passes.** In pass 1 I ran a multi-agent workflow with Claude Code on the starter. One agent mapped the code, one wrote tests, one implemented and one verified, and a group of adversarial reviewers each tried to break one area (concurrency, delivery, tenant isolation, the operator view). I used its result to learn the problem and did not submit it. For pass 2, this submission, I started again from a clean copy of the starter and rebuilt it one requirement at a time, with Claude Code as a pair. Then I ran the pass 1 tests against it to find cases I had missed, and fixed the three most important.

**Tools:** Claude Code (Claude Opus) in VS Code. I reviewed every change and reproduced most bugs before fixing them.

**One changed suggestion:** for the resend after a 503, the AI also put a second test case into the same commit as another fix, without my review. I asked it to undo the commit and reproduced that case alone: it fails on the same line as the first one. So it is one fix (`7ee8a57`), and the second case only adds assertions to the test, which fails on `7a7367b` and passes on HEAD.

**Time:**

| Part | Minutes |
|---|---|
| Pass 1: multi-agent run plus my cleanup | ~115 (95 + 20) |
| Pass 2: R1–R6 base | 66 |
| Pass 2: the three extras (`7ee8a57`, `e4a2e1f`, `9ba7b04`) | 52, 22, 4 |
| Pass 2 implementation | 144 |
| Pass 2: this handoff | 23 |
| **Pass 2 total** | **167** (2 h 47 min) |
| **Total on the exercise, both passes** | **~282** (about 4 h 40 min) |
