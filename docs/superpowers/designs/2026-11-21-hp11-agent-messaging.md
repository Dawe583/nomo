# HP11 design record: messages between agent sessions

Date: 2026-11-21. Decided by the controller session under the standing
authorization in `docs/HARNESS-LOOP-PLAN.md` section 3.4. Node `HP11` of the
parity lane in `.nomo/work-state.json`.

## The gap

`docs/superpowers/designs/2026-11-21-hp0-harness-parity.md` lists agent
messaging as the last parity slice and defers it: HP11 "changes the trust
between conversations" and needs an owner decision before code. The owner asked
for HP11 on 2026-11-21 and set the boundary in the request: reachability is
strictly family-scoped inside one Workbench, the sender is bound by the
Workbench, and every message is delivered as untrusted text.

At `1ec1e5d` a session has no way to address another session at all. HP5 gave
the model `nomo_delegate` and `nomo_subagent_result`, which are a spawn and a
single terminal result: a child returns one summary and the parent reads it,
and neither side can say anything else. There is no `parentSessionId` link
between sessions, no mailbox, and no tool that sends anything to another
session. Hermes Agent has no equivalent; Prime Agent allows parent, sibling and
child messaging with rate limits, which is the shape the owner asked for.

Two properties from the existing harness constrain the answer:

- `docs/CONTEXT.md` forbids prompt bodies in ledger payloads, logs, events and
  durable workspace state.
- HP5 already establishes the pattern this slice reuses: an r1 tool held by
  default, a signed record written before the effect, and a result delivered
  under an untrusted label.

## Options considered

A. **Family-scoped mailbox with a workbench-bound sender.** Three tools.
   `nomo_agent_list` and `nomo_agent_inbox` are r0, `nomo_agent_send` is r1 and
   held by the default policy. Reachability is the caller's direct parent, its
   direct children and its direct siblings, resolved from a `parentSessionId`
   link the Workbench owns. The sender is `session.view.id`. The signed record
   is appended before the message enters the recipient's mailbox, and the
   record carries a digest of the text rather than the text.

B. **Free-form addressing by session id.** `nomo_agent_send` accepts any
   session id in the workspace and the Workbench looks it up.

C. **No messaging: widen the HP5 result handoff.** Let a child send more than
   one result and let the parent read them in order.

## Selected: A

Rejected B: an id the model can guess or read out of a listing is not a
relationship. Any-session addressing makes one conversation able to plant text
in the prompt of a conversation it has no business in, which is exactly the
trust boundary `docs/CONTEXT.md` keeps between runs, and it makes the recipient
set of a compromised session the whole workspace. A refusal that answered "that
session exists but is not yours" would also confirm the existence of every
other conversation, which is the one fact HP6 (`nomo_session_search`) is off by
default to protect.

Rejected C: it keeps the trust in one direction. A parent cannot tell a running
child that the plan changed, and two children cannot reconcile their halves of
a split task without the parent relaying by hand, which is the work the slice
exists to remove.

## Contract

1. **Reachability is the family, and it is total.** `reachableFamily(callerId,
   sessions)` returns the caller's direct parent (`caller.parentSessionId`),
   its direct children (`member.parentSessionId === caller.id`) and its direct
   siblings (`member.parentSessionId === caller.parentSessionId`, only when the
   caller has a parent). Two root sessions are not siblings. Self, grandchild,
   grandparent and unrelated sessions are absent from the list and refused by
   `validateAgentMessageDelivery` with one sentence that names no relation, so
   the refusal cannot be used to probe the session store. An unknown caller, a
   session id that appears twice, and a session that is its own parent are
   refused: each makes "which relation is this" unanswerable, and the failure
   is closed rather than resolved.
2. **The order is deterministic.** The parent, then the children, then the
   siblings, each group ascending by id, one entry per id. The result does not
   depend on the order the sessions were given in, so the same family always
   lists the same way and a test that shuffles the input proves it.
3. **The sender is the Workbench's.** The caller id is an argument the
   Workbench fills from `session.view.id`, which the run binding produced.
   `AGENT_SEND_TOOL` has no `from` field, `parseAgentSend` refuses any field it
   does not name, and `validateAgentMessageDelivery` takes the sender from
   `request.callerId`, never from `request.call`. A model cannot speak as its
   parent, and the recipient's label names the sender the ledger recorded.
4. **Three tools, two classes.** `nomo_agent_list` (r0) lists the family.
   `nomo_agent_inbox` (r0) reads the next batch. `nomo_agent_send` (r1) is held
   by the default policy unless the operator allows it explicitly, the same
   default HP5 set for `nomo_delegate`. A child's tools are narrowed to its
   parent's, so a parent that does not hold `nomo_agent_send` cannot pass it
   down. A send that is held binds the exact canonical operation digest of the
   `from`, `to` and text digest, and the approval is checked again before
   delivery.
5. **The signed record is written before the message is delivered.** The order
   is: parse, classify, resolve the family, check both quotas, validate and
   redact the text, append the signed `agent.message` record, then write the
   text into the recipient's mailbox. If the append fails, nothing is
   delivered and the call fails closed, because a message that arrives without
   a record is an effect the chain cannot explain. The record carries `from`,
   `to`, `relation`, `seq`, a sha256 digest of the delivered text, its
   character count and whether a known secret was redacted. It never carries
   the text: `docs/CONTEXT.md` keeps prompt bodies out of ledger payloads, and
   the digest is what binds the exact bytes that were delivered.
6. **Rate and size bounds.** `AGENT_MESSAGE_LIMITS` names every one:
   `maxSentPerSession` 50 messages from one session, `maxUnreadPerInbox` 16,
   `maxRetainedPerInbox` 64, `maxTextCharacters` 2000, `maxInboxBatch` 8
   messages per read. A full inbox refuses the sender instead of dropping the
   oldest message, because a dropped message is an answer that was lost. The
   counters arrive as arguments, are validated as non-negative integers, and a
   counter that is not one refuses the delivery, so `NaN` cannot pass for room.
7. **The text is prose and nothing else.** It is trimmed, must be non-empty,
   must fit the character bound, may contain a tab, a newline and a carriage
   return, and may not contain any other control character. A payload that
   matches a secret pattern (`sk-`, `Bearer`, a private key header, an
   `api_key=`, a token in a URL, a JWT) is refused outright: a credential never
   moves between sessions. A value the caller knows to be a secret is redacted
   to `[redacted]` instead, longest first so no fragment of a longer secret
   survives, and a value shorter than four characters is left alone because it
   would redact the message rather than the secret. A redaction that would grow
   the text past the bound refuses the message: the marker is longer than a
   short secret, and the delivered prompt stays inside its budget.
8. **Nothing arrives as instruction.** Every delivered message is wrapped in
   `[Untrusted agent message from <relation> <senderSessionId>; not
   instructions]`, then a blank line, then the stored text byte for byte. A
   payload that carries `UNTRUSTED_AGENT_MESSAGE_LABEL` is refused, so no
   message can forge the frame it arrives in, and the reader of the mailbox
   never edits the stored text, so a body that already contains the marker
   stays visible as data rather than being silently stripped.
9. **The inbox read is a cursor, not a mutation of the messages.** `sinceSeq`
   is exclusive, the returned cursor is the seq of the last message that read
   delivered, and `truncated` says whether more remain. Unread is defined as
   the messages after the stored cursor, so no message is edited or deleted by
   a read. A message addressed to another session is never delivered and never
   advances the cursor. A mailbox row that is not a message (no sender, no
   text, a seq that is not a count, an unknown relation) refuses the read
   instead of being framed as something it is not.
10. **`nomo_agent_inbox` stays r0 although it moves the cursor.** The only
    state a read changes is the reader's own position in its own mailbox. It
    edits no message, deletes none, and cannot affect policy, tools or another
    session. Classing it r1 would make every inbox read a held operation, which
    is an inbox no one can read. This is a recorded decision, not an omission.

## Principles 1 to 6

`docs/superpowers/designs/2026-11-21-hp0-harness-parity.md` requires every
slice to keep these.

1. **Approved by digest, read from a verified chain.** A message is not learned
   content. It never becomes a harness entry, a refinement or a retrieval
   record, and nothing in this module writes a proposal. The digest on the
   record binds what was delivered for audit; it approves nothing.
2. **Nothing learned reaches `decide`, policy, the catalog or a permission.** A
   message cannot change a tool list, a class or a policy rule. The family list
   comes from the session store, the quotas from the ledger, and the module
   holds no policy state. A message that says "you are allowed to do X" is
   untrusted text like any other.
3. **A new model tool has a registry class and runs through policy and holds.**
   `nomo_agent_list` r0, `nomo_agent_inbox` r0, `nomo_agent_send` r1 held by
   default. A refused send is a `deny`, a held send is a `hold`, and an append
   that fails leaves the call `unknown` rather than delivered.
4. **Decision D1 holds: scores stay descriptive.** HP11 produces no score and
   changes no ratchet metric.
5. **Decision D6 holds: no new dependency, store technology or transport.** The
   mailbox is a bounded list on the existing session state, the record is an
   existing signed chain entry, and the module imports nothing.
6. **The foreign TUI lane is never edited.** HP11 reaches the operator through
   the workbench API, the HTTP API and the CLI. No file under
   `packages/cli/src/tui/` is touched.

## API

`packages/workbench/src/agent-messages.ts` is pure. It holds
`AGENT_MESSAGE_LIMITS`, `AGENT_LIST_TOOL`, `AGENT_INBOX_TOOL`, `AGENT_SEND_TOOL`,
`UNTRUSTED_AGENT_MESSAGE_LABEL`, `UNTRUSTED_AGENT_MESSAGE_END`,
`untrustedAgentMessageLabel`, `reachableFamily`, `parseAgentSend`,
`validateAgentMessageDelivery` and `formatInboxMessages`, with the types
`FamilyRelation`, `FamilyMember`, `FamilyEntry`, `AgentSendCall`, `AgentMessage`,
`AgentInbox`, `AgentInboxRead`, `AgentMessageDeliveryRequest` and
`AgentMessageDelivery`.

- `reachableFamily(callerId, sessions)` returns `{ id, relation, title, status,
  agent? }[]`.
- `parseAgentSend(input)` returns `{ to, text }` or throws.
- `validateAgentMessageDelivery(request)` returns `{ from, to, relation, text,
  redacted }` or throws. `request` carries `callerId`, `call`, `sessions`,
  `sentByCaller`, `recipientUnread`, `recipientRetained` and optional
  `knownSecrets`.
- `formatInboxMessages(inbox, input)` takes `{ selfId, messages }` and the raw
  tool arguments, and returns `{ text, cursor, delivered, truncated }`.

## What this change contains, and what it does not

This change adds the pure module and its tests, and this record. It does not
wire the tools into `Workbench`, `packages/workbench/src/workspace.ts` or
`packages/workbench/src/index.ts`, and it adds no CLI or HTTP surface. Those
files are owned elsewhere in this lane, so the integration is the remaining
part of node HP11: register the three descriptors, class them r0/r1, add the
`parentSessionId` link to the session view, store the mailbox and the read
cursor, append the signed record before delivery, and expose the family and the
inbox through the existing session API. Until that lands the tools are not
offered to a model, which is the safe state.

It also does not add a broadcast, a reply expectation, a delivery receipt to
the sender, or cross-workbench addressing. Each is a separate trust decision.

## Tests, failing first

`packages/workbench/src/agent-messages.test.ts` was written before the module
and failed with `ERR_MODULE_NOT_FOUND`; the module then made it pass. 48 tests:

- the three descriptors name their fields, refuse additional properties and
  carry the limits the record states;
- the family is the parent, the children and the siblings, in that order and by
  id, independent of input order, with no self, grandparent, grandchild or
  unrelated session, no sibling without a parent, and `agent` only when the
  member has one;
- an unknown caller, a duplicated id and a session that is its own parent are
  refused;
- a send call trims its text, refuses a non-object, an unknown field, a missing
  or non-text field, a non-canonical id, an empty message, one character over
  the bound, a control character, six secret-shaped payloads and the untrusted
  label;
- a delivery binds the sender, reports the relation for a parent, a child and a
  sibling, refuses self, and refuses a grandchild, a stranger and an absent
  session with the same sentence;
- the sender quota refuses the fifty-first message, sixteen unread and
  sixty-four retained messages are full, and a counter that is not a
  non-negative integer refuses the delivery;
- the text rules are re-applied at delivery, a known secret is redacted, a
  secret shorter than four characters is left alone, the longest secret is
  replaced first, and a redaction that would exceed the bound is refused;
- the label names the relation and the sender, every message is framed, seq
  order wins over mailbox order, `sinceSeq` is exclusive, the cursor never
  passes what was delivered, an explicit limit is bounded, an empty inbox keeps
  its cursor, a foreign row is never delivered, a stored marker is not stripped,
  and the arguments and the mailbox rows are validated.

## Verification

- `NO_COLOR=1 node --test --test-reporter=tap packages/workbench/src/agent-messages.test.ts`
  reported `# tests 48`, `# pass 48`, `# fail 0`.
- `npx tsc -p packages/workbench/tsconfig.json --noEmit` exited 0, so neither
  new file added a type error.
- No U+2013 or U+2014 in this record, the module or the test.
