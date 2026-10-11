# Adversarial review — `apps/control-plane/ui` chat surface

Scope: `chat.tsx` (+ diff vs `db481fd`), new `chat-stream.ts`, `chat-composer.ts`,
`chat.css`, `chat-stream.test.ts`, `chat-composer.test.ts`, with
`permission-mode.tsx`, `events.ts`, `draft-state.ts` and
`packages/workbench/src/index.ts` read for ground truth.

Verification run for this review: `npx tsc --noEmit` in
`apps/control-plane/ui` → exit 0. `node --test src/chat-stream.test.ts
src/chat-composer.test.ts src/draft-state.test.ts src/events.test.ts` → 20 pass,
0 fail. Every behavioural claim below marked *verified* was reproduced with a
throwaway script that was deleted afterwards.

No source file was modified.

---

## 0. The restored hunk — `now` and `edited` (the reason this review exists)

**They are intact and correctly wired. Nothing to fix.**

`git diff -U0 apps/control-plane/ui/src/chat.tsx` contains no `+`/`-` line that
touches either declaration (the only grep hit is `unknown` inside the new
`toolStatusLabel` signature). Both lines are byte-identical to `HEAD`, and
neither appears in the diff at all — the restoration was exact.

Traced end to end:

| value | declared | written | read | controls |
|---|---|---|---|---|
| `now` | `chat.tsx:266` `useState(Date.now())` | `chat.tsx:522` `setInterval(() => setNow(Date.now()), 1000)` | `chat.tsx:518` `Math.ceil((retryAt - now) / 1000)` | the provider rate-limit countdown in the notices region, and via `retryWait` the `disabled` on both the send button (`:1360`) and the "Send draft" button (`:1069`) |
| `edited` | `chat.tsx:267` `useState("")` | `:977` (branch from a row — user text, or `""` for an assistant row), `:995` (Retry — the preceding user text), `:1192` (ArrowUp history — `lastUserMessage`) | `:770` `prompt: edited` in the branch POST, `:1556` `value=` on the branch dialog textarea | the editable text inside the "New conversation branch" dialog |

Both are load-bearing. `now` must be state, not a ref, because the countdown has
to re-render the composer; the interval at `:520-524` is correctly gated on
`retryWait` so it does not tick forever. `edited` is the only carrier of the
edited message between opening the branch dialog and submitting it, and all
three write sites set it at the same moment they call `selectBranch`, so the
dialog never opens with a stale or empty body. Neither is declared-but-unused,
used-but-never-set, or set-and-not-read.

One cosmetic note only: they sit at `:266-267`, wedged between the
`selectBranch`/`branchRequestKey` block above and the `attachments` state
below, which is exactly the shape that makes the next editor delete them by
mistake. Moving the two lines next to the other plain state declarations would
remove the trap. This is a nit, not a defect.

---

## 1. Must fix before merge

### 1.1 A stopped or failed run leaves the last answer permanently marked "arriving", with no way to copy, branch or retry it
`chat-stream.ts:20` · `chat.tsx:917-918` · `chat.tsx:967`

`streamPhase` clears the open delta run **only** on `message.completed`. The
server does not guarantee that event.

`packages/workbench/src/index.ts:2061` and `:2068`:

```ts
if (session.controller.signal.aborted) return;   // after complete(), before this.event(...)
```

and the `run.status`/throw paths. `stopRun` (`chat.tsx:680-695`, wired to the
Stop button at `:1338` and to Esc at `:1181`) calls `/api/runs/:id/stop`, which
reaches `workbench` `:940` → `session.controller.abort()` → status `cancelled`
→ a `run.status` event. The run loop then returns **without** emitting
`message.completed`. A provider throw after deltas flushed does the same via
`run.error`.

Verified against real event sequences:

```
stopped run  -> { streaming: true, seq: '4' }
failed run   -> { streaming: true, seq: '4' }
truncated    -> { streaming: true, seq: '4' }   // historyComplete === false / page boundary
```

Why it matters to a user: the moment the user presses Stop, the run ends, the
Stop button unmounts, focus returns to the composer — and the last answer is
stuck with a breathing caret, the "arriving" flag, `aria-busy="true"`, and
**its entire `.message-actions` row suppressed** by `{text && !arriving && ...}`
at `:967`. The user can no longer copy the answer they just asked for, branch
from it, or retry it, and nothing on screen says why. Same outcome on a
provider failure. The diff introduces the flag, the rail, the caret and the
action suppression together, so the regression lands with the feature.

A correct fix: give `streamPhase` every terminal transition, not just the happy
one — treat `run.error`, and any `run.status` in a terminal set
(`stopped`/`cancelled`/`idle`/`failed`), as closing the open run the same way
`message.completed` does. A second, independent guard is worth having: scope
the "still arriving" claim to a run that is actually live (`runBlocksInput`), so
a stale buffer can never assert provisionality on its own.

### 1.2 The two send entry points do not share the size guard
`chat.tsx:1357` vs `chat.tsx:1069`

The main send button gained `size.over` (`:1357`). The "Odeslat koncept /
Send draft" button inside the queue banner did not:

```tsx
// :1069
disabled={busy || running || retryWait > 0 || !draft.trim()}
```

So with a draft that is over budget, the composer shows a red "over the limit"
warning, the primary send button is correctly dead, and a second, equally
prominent button is **live and enabled**. Clicking it does not send (the guard
at `:720` catches it) but it throws a raw error banner at the user after
setting `busy`. The whole point of hoisting `prompt`/`size` was that the
number on screen and the thing that blocks you cannot disagree; this path still
disagrees.

Fix: `disabled={busy || running || retryWait > 0 || !draft.trim() || size.over}`.

### 1.3 The send path clears the draft text imperatively but leaves the files to a React effect — the two drift apart
`chat-composer.ts:74-81` · `draft-state.ts:submitDraft` · `chat.tsx:750-753`

`send()` on success calls `submitDraft`, which imperatively does
`storage.removeItem(draftKey)`. The matching `nomo-files:` key is removed only
by the React effect at `chat.tsx:488-493`, which fires because `setAttachments([])`
was called at `:753`. Two reachable ways that effect never runs:

* the tab closes or the route unmounts the component between `submitDraft`
  resolving and the effect flushing;
* the send creates a new session, so `navigate("/chat/" + result.session.id)` at
  `:757` changes `draftKey` from `…:new` to `…:<id>` — the old `…:new` files
  key is then never removed, because every subsequent effect writes the *new*
  key.

Result: `nomo-draft:ws:new` is gone but `nomo-files:ws:new` survives. Navigate
back to `/chat/new` and the composer restores attachments against an **empty
draft** — the precise "a different message than the one on screen" failure the
author set out to prevent, reappearing one layer down. The symmetric case is
that these entries also accumulate for the life of the tab with no eviction.

Fix: give `submitDraft` a sibling that removes the files key in the same
imperative block (or move the key derivation into `chat-composer.ts` and have
`draft-state.ts` call it), so the clear is atomic and independent of React.

### 1.4 The attachment limit is duplicated as a magic number twice, and the test that claims to guard it does not
`chat.tsx:1293` · `chat.tsx:1462` · `chat-composer.test.ts:62`

```tsx
// :1293  (file picker)
if (file.size + attachments.reduce((n, a) => n + a.bytes, 0) > 24576) { … }
// :1462  (context picker)
if (bytes + attachments.reduce((n, a) => n + a.bytes, 0) > 24576) { … }
```

while the visible counter at `:1122-1125` reads `ATTACHMENT_BYTE_LIMIT`. The
new module went to real trouble to make the *message* budget single-source, and
left the *attachment* budget as a literal in two places. Change the constant and
the counter moves while both guards do not.

The test that appears to cover this is the worst kind:

```ts
assert.equal(ATTACHMENT_BYTE_LIMIT, 24576);
```

That asserts a constant against the same literal the production code duplicates.
It fails when you change the constant and passes when you change either `24576`
in `chat.tsx` — precisely backwards from its stated purpose.

Fix: use `ATTACHMENT_BYTE_LIMIT` at `:1293` and `:1462`, and replace the
tautology with an assertion that reads the two call sites, the way
`compact-layout.test.ts` already reads `styles.css` in this package.

---

## 2. Should fix

### 2.1 The permission banner reports a loading state as a failure
`permission-mode.tsx:15-23` · `permission-mode.tsx:97-119` · `chat.tsx:1057`

`resolvePermissionMode` returns `{ mode: "read-only", source: "local" }` for
**any** input that is not an explicit server authority — including
`capabilities.data === undefined` while the query is still in flight. The
banner therefore renders

> Režim: jen čtení · server mode unavailable — read-only fallback

on every single page load, for a few hundred milliseconds, even when the server
is healthy and the session is `normal`. It then flips to "enforced by server".
The claim being reviewed — that the unenforced state is made *visually
distinct* rather than softer — holds (see §4), but the banner is not telling the
truth about **why** it is in that state, and it cannot distinguish "loading"
from "server said nothing" from "server unreachable".

The unsafe direction is fine: a permitted session never *looks* writable. But
the flicker is a lie, and it trains the reader to ignore the banner, which is
the one element that must be believed.

Fix: pass the query state through and render a neutral "checking the server"
banner while `capabilities.isPending`, reserving the "read-only fallback" wording
for `isError` or a loaded-but-unauthoritative response.

### 2.2 The "arriving" flag is announced to nobody exactly when it matters
`chat.tsx:924` · `chat.tsx:939-946` · `chat.tsx:1007-1013`

The comment at `:940-941` is right that the flag should not be its own live
region, on the grounds that "the run status below already announces the run".
That reasoning does not hold in the state where the flag is most visible. The
anchor it relies on is `{running && <p className="run-status" role="status">}`
at `:1007`, and `running = runBlocksInput(session)`. After Stop or after a
failure, `running` is false while `streaming.streaming` is still true (§1.1) —
so the transcript says "arriving", `aria-busy="true"` is set on the row, and
there is no live region announcing anything. The provisionality is conveyed by
an `aria-hidden` caret and a rail colour.

Fix follows from §1.1: once the run is genuinely terminal the flag is wrong, so
fixing the phase model fixes the announcement gap too.

### 2.3 The budget line is a live region that changes on every keystroke
`chat.tsx:1237-1246` · `chat.tsx:1162`

```tsx
<p className="composer-budget" id="composer-budget" role="status" data-over={size.over || undefined}>
```

`role="status"` implies `aria-live="polite"`. The text is
`"Before the limit: 23,456 characters or 59,000 B."` and it is recomputed from
`draft` on every keystroke. A screen-reader user typing a long message gets a
number read back at them per character. The same element is *also* the target of
`aria-describedby` on the textarea (`:1162`), which is the right channel and
already announces it on focus — the live region is redundant and harmful.

Fix: drop `role="status"`; keep `aria-describedby`. If it must announce
transitions, announce only on the `not over → over` edge, not on every count.

### 2.4 The pill is driven by any content resize, not by a new message
`chat.tsx:638-645`

```ts
const observer = new ResizeObserver(() => {
  if (!follow) { setNewMessages(true); return; }
  …
});
observer.observe(content);
```

The observed element is the right one — `el.firstElementChild` is the `.messages`
div, which is what actually grows. Disconnect on cleanup is present. But
*any* resize of that div sets the pill: a webfont finishing, a window resize, a
Markdown table reflowing, the user expanding a tool card. The user is scrolled
up, resizes their browser, and gets a "New messages ↓" pill for a message that
does not exist. The pill is a promise about content, so it should be driven by
`events.length` / last-event-text, not by geometry.

Fix: set the pill from the same signal the layout effect already watches
(`events.length`, `events.at(-1)?.text`) and keep the observer purely for
re-anchoring the scroll position while following.

### 2.5 A failed tool call is rendered exactly like a successful one
`chat.tsx:152-153` · `chat.tsx:165` · `chat.css:64-69`

`live = status === "requested"`, so `data-phase` is binary. `events.ts:26-29`
produces three statuses — `requested`, `completed`, `failed` — and `failed` lands
in `data-phase="settled"` with the neutral `var(--line)` rail. The only signal
is the badge word. The diff added an explicit two-state phase model and a
pending notice; failure is the third state it left out, and it is the one a user
most needs to see at a glance in a long transcript.

Fix: add a `[data-phase="failed"]` rail (and drop the pending copy into it), or
drop `data-phase` to one neutral style and let the badge carry it honestly.

### 2.6 `TOOL_LIFECYCLE` is hand-transcribed, and the comment claims a coupling it does not have
`chat.tsx:122-129`

> "They come from `events.ts`, which derives them from the real `tool.started`
> and `tool.result` pair, so a card never claims to be running without a start."

The *values* do come from `events.ts`; the *table* does not. It is a literal
copy of two strings that `events.ts:26-29` produces independently. Rename
`"requested"` in `events.ts` and this table silently stops matching — the badge
falls through `toolStatusLabel` to `statusLabel`, which has no entry for either
string and returns the raw English token, untranslated. Verified: neither
`requested` nor `completed` is in `status-label.ts`'s `LABELS`.

The ordering inside `toolStatusLabel` (`t(lifecycle[0], lifecycle[1])` = Czech
first) is correct and matches every other call site — do not "tidy" that.

Fix: a test that asserts the `status` values `transcriptEvents` emits are
exactly the keys of `TOOL_LIFECYCLE`, which makes the comment true. That is
cheap and is a real behavioural assertion, not a source grep.

### 2.7 The full transcript is re-derived on every render, once per second
`chat.tsx:508-512` · `chat.tsx:520-524`

```ts
const events = transcriptEvents(rawEvents);
const streaming = streamPhase(rawEvents);
const timings = toolTimings(rawEvents);
const usage = usageSummary(rawEvents);
```

None are memoised. `transcriptEvents` walks the entire event buffer and builds
new objects for every tool card; `toolTimings` rebuilds a `Map`; `usageSummary`
copies and reverses. This runs on every render — and the rate-limit countdown
forces a render every second via `setNow`. On a long conversation that is a
full O(n) re-derivation plus a fresh `Map` and fresh row objects sixty times a
minute, for a number that only appears in one string.

Fix: `useMemo` all four on `[rawEvents]`. `rawEvents` is a stable reference from
react-query when the session is loaded, so this memoises correctly; guard the
`?? []` arm so the empty case does not defeat it.

### 2.8 A disabled radio group announces the current mode as unselectable
`chat.tsx:1403-1408` · `permission-mode.tsx:70-80`

`PermissionModeSwitch` renders `role="radiogroup"` with three `role="radio"`
buttons, all `disabled`, one carrying `aria-checked="true"`. A screen reader
announces the active mode as "dimmed / unavailable" — the one thing it is
actually the authoritative value of. `aria-disabled="true"` on the group doubles
down on it.

The *visual* handling here is correct and better than most: the words
"Server controls this mode; it cannot be changed here" sit below the group, so
the state is not communicated by the disabled styling alone. The ARIA is what is
wrong.

Fix: drop `role="radio"`/`aria-checked` and render the mode as a labelled
`group` with the active value as text, or leave the checked radio enabled and
only disable the other two.

### 2.9 `branch` and `edited` survive a session switch, so a branch can be cut from another conversation's message
`chat.tsx:258-267` · `chat.tsx:474-487` · `chat.tsx:1542-1580`

`PageComponent` (`ui.tsx:107-121`) renders `<Page … />` with **no `key`**, so
navigating `/chat/A` → `/chat/B` reuses the same `Chat` instance. The
`draftKey` effect resets `draft`, `queued`, `attachments`, `selectedTool`,
`commandDismissed` and `follow` — but not `branch`, and not `edited`. Open the
branch dialog in A, click a session in the sidebar, and the dialog is still open
holding A's `seq` and A's text. Confirming it POSTs to
`/api/sessions/<B>/branches` with A's `seq` and A's prompt.

This is pre-existing, but it is the same class of bug as §1.3 and it sits
directly in the blast radius of the state-restore work this diff did: the author
correctly noticed that restoring the draft without its attachments was a
half-restore, and the same half-restore reasoning applies here.

Fix: `setBranch(undefined)` (and let `edited` die with it, or reset it) in the
`draftKey` effect.

### 2.10 The byte figure shown is the serialised request size, not the message size
`chat-composer.ts:21`

```ts
const bytes = new TextEncoder().encode(JSON.stringify({ prompt })).length;
```

`JSON.stringify` adds braces, a key, quotes, and escapes every `"` and `\`, so
the number reported next to "characters" and above the send button is not the
message's byte length. A message that is 5 000 characters of JSON-ish text will
report materially more than 5 000 B. The guard and the counter use the same
value, so they cannot disagree with each other — but they can both be wrong
about the thing they claim to measure, and the error text at `:722-725` repeats
the wrong number back as a hard limit. It also allocates the whole encoded
string on every keystroke.

Fix: measure `new TextEncoder().encode(prompt).length` for the display, and
either keep the serialised figure as a separate explicitly-named field or drop
the byte bound to the prompt alone — whichever the server actually enforces.

---

## 3. Nits

* `chat.tsx:21` (import of `useLayoutEffect`) — fine, but the layout effect at
  `:625-630` calls `setNewMessages(false)`. It only ever sets `false` when it is
  already `false` on the follow path, so React bails out and there is no loop;
  it is safe, just worth knowing before someone "simplifies" it into a plain
  effect.
* `chat.tsx:1116` `key={a.name}` — two attachments with the same filename
  collide and React will reconcile them into one chip. Pre-existing, one-word
  fix (`key={name + ":" + i}`), but out of scope here.
* `chat.css:235-237` — `transition: opacity 140ms ease-out` on `.new-messages`,
  but nothing in any stylesheet changes that element's opacity. A transition for
  a property that never moves; harmless, dead.
* `chat.tsx:1525` — `aria-label={t("Oblíbený model", "Favorite model")}` on the
  per-model star. Three model cards produce three identically named buttons.
  Should be "…: <model name>". Pre-existing.
* `chat.tsx:1113` — `aria-label={t("Odebrat přílohu", "Remove attachment") + " " + a.name}`.
  This is a correct fix and the only accessible name in the composer that names
  the thing acted on rather than the control type. **Leave it.** By contrast the
  textarea's `aria-label` is still the bare `t("Zpráva", "Message")` at `:1153`.
* `chat.tsx:891-899` — `.chat-loading` is `role="status"` and contains empty
  `<span className="skeleton-line">` elements with no `aria-hidden`. They read
  as nothing, so it is harmless, but `aria-hidden` on the decorative spans is
  the honest markup.
* `chat.tsx:1017-1026` — the pill now calls `textarea.current?.focus()` after
  setting `follow`. Defensible (you are now following, so invite the reply), but
  the button announces as "New messages ↓" and silently moves focus to a
  different control. Either move focus and say so, or do not.
* `chat-composer.ts:45` `filesKey = key.replace(/^nomo-draft:/, "nomo-files:")` —
  `String.prototype.replace` with a non-matching pattern is a no-op, so a caller
  that passes a key not prefixed `nomo-draft:` writes the files JSON *into the
  draft key itself*, corrupting the draft. Today `chat.tsx` always builds the
  prefix, so it cannot happen. A `startsWith` guard, or deriving both keys from
  one function, would make that structural instead of conventional.
* `chat.css:130-165` — the sticky permission banner eats ~35 % of a notices
  region that `styles.css:3357` caps at `min(144px, 18dvh)`; at 320×568 that is
  102 px, leaving ~66 px for the error box, provider notice, queue banner,
  selected tool and attachments. It scrolls, so it is usable — but the banner is
  the least urgent thing in that stack to be permanently pinned.

---

## 4. Correct and subtle — do not "fix" these

* **`chat.tsx:271-272` + `474-493`, the `attachmentsRef` ordering.** The
  comment claims the save effect must read the ref rather than the state because
  it "runs in the same commit as the restore above". That is exactly right, and
  it works for a non-obvious reason: React flushes a commit's effects in
  declaration order, restore (`:474`) before save (`:488`), so by the time save
  runs, `attachmentsRef.current` has already been reassigned to the newly
  restored files. The render-phase `attachmentsRef.current = attachments` at
  `:272` is harmless because the restore effect overwrites it before any
  consumer reads it. If someone "cleans up" the ref into a lazy initialiser, or
  moves the save effect above the restore, the previous conversation's files get
  written under the new key — reintroducing exactly the bug this was built to
  fix. Correct; leave the ordering alone.
* **`chat.tsx:625-630`, the layout-effect anchor.** `useLayoutEffect` rather
  than `useEffect` is right: an autoscroll applied after paint is a visible jump
  on every streamed fragment. The early return on `!follow` is the correct
  semantics for "the reader is at the end" — a user scrolled up is never fought.
* **`chat.tsx:634-648`, the transcript `ResizeObserver`.** It observes
  `el.firstElementChild`, which is the `.messages` div — the element that
  actually grows when a streamed fragment, a Markdown table or a code block
  changes the layout. That is the correct target, not the scroll container
  itself. It disconnects on cleanup, and the effect re-binds on `[follow]` so
  the callback never closes over a stale `follow`. The only problem is what it
  does when *not* following (§2.4), not how it is wired.
* **`chat.tsx:652-666`, `--composer-offset`.** Measuring `.composer-wrap` and
  writing the result to the `.chat` section is right, and the containment is
  correct: the pill (`:1017`) is a child of the section, and the composer-wrap
  is the section's last flex child, so `bottom: composerHeight + 8px` lands the
  pill exactly 8 px above the input it points at. It also absorbs the notices
  region, which is what the old fixed `bottom: 200px` got wrong. The effect
  calls `apply()` once before observing, so the 132 px fallback is only ever
  visible for one frame.
* **`chat.css:220-258`, motion containment.** Every `animation` and
  `transition` declaration is inside `@media (prefers-reduced-motion:
  no-preference)` **and** gated on `:root:not([data-motion="off"])`, so motion
  collapses completely under either switch. The `@keyframes` are defined outside
  the block, which is correct and not a leak — a keyframe definition alone
  animates nothing, and no rule references them from outside the block. The
  framer-motion entrance (`initial`/`animate` at `:921-922`) is separately driven
  by the existing `useReducedMotion`/`MotionConfig` path. Nothing here needs
  changing.
* **`chat.css:151-165`, the permission rail.** The claim holds. The three modes
  are separated by `border-left-style` (solid / dashed / dotted) as well as
  colour, and the local fallback adds `double` at 5 px on top. A
  `data-source="local"` read-only banner therefore differs from a
  server-enforced read-only banner by border *pattern* and *width*, not hue —
  distinguishable in greyscale, in forced-colours mode, and to a reader who
  cannot separate the two greys. Combined with the words at
  `permission-mode.tsx:117`, the local-fallback state is never colour-only. The
  cascade works out correctly too: `[data-source="local"]` and `[data-mode=…]`
  are both (0,3,0), and the source rule is declared last, so the `double` wins
  over the mode's `dotted` without `!important`. **This part is right — do not
  simplify it back to a colour-only rail.**
* **`chat.tsx:967`, suppressing actions on a provisional row.** The reasoning
  is right — copying, branching or retrying unsettled text acts on something
  the server has not committed. The bug is the *predicate* (§1.1), not the idea.

---

## 5. Test quality

The package has **no DOM test infrastructure** — no jsdom, no testing-library,
`node --test` over `src/*.test.ts` only, and `package.json` has no test-render
dependency. So the highest-risk new code in this change — the layout effect, the
two `ResizeObserver` wirings, `onTranscriptScroll`, the pill clear, the
`attachmentsRef` ordering, `ToolCard` — has **no test at all, and could not
have one** under the current harness. That is the headline test finding, and it
is a harness gap, not a discipline gap.

### `chat-stream.test.ts` — the stronger of the two

These are real behavioural tests over pure functions, and several pin genuine
product decisions rather than arithmetic:

* *"a tool call between deltas does not settle an unfinished message"* —
  `streamPhase` correctly refuses to let an interleaved `tool.started` close an
  open message. This is a real semantic, and a naive implementation would fail
  it.
* *"an unfinished or untimestamped tool call has no duration, not a zero"* —
  pins the "absence is not zero" decision and the reversed-timestamp case. Good.
* *"duration is omitted below a second"* — the `< 1000 → null` suppression is a
  deliberate product call, not a restatement.

**The gap is the whole point.** Every test here covers a *happy* terminal
(`message.completed`). There is no test for `run.error`, a cancelled `run.status`,
or truncated history — the three inputs that produce §1.1. A single
`assert.equal(streamPhase([delta, {type:"run.status", payload:{status:"cancelled"}}]).streaming, false)`
would have failed before the change and passes after the fix. Its absence is why
the bug shipped.

Minor: the `assert.deepEqual(timings.get("c1"), {…})` at `:49-53` restates the
two `assert.equal`s immediately above it.

### `chat-composer.test.ts` — three of six tests do not test what they claim

* **`:42` "the visible budget and the blocking guard read the same numbers"** —
  the name asserts a cross-check between the visible budget and the send guard.
  The body never touches `chat.tsx`, never renders anything, and calls
  `messageSize` twice. **Revert `chat.tsx:1357` to the hardcoded
  `32000`/`60000` from `HEAD` and this test still passes.** That is the exact
  regression the test names, and it is invisible to it. It currently only pins
  `messageSize`'s own arithmetic — the same tautology, wearing a
  cross-component name.

* **`:62` `assert.equal(ATTACHMENT_BYTE_LIMIT, 24576)`** — asserts a constant
  against the literal that production code duplicates twice (`chat.tsx:1293`,
  `:1462`). It fails on the wrong edit and passes on the right one. See §1.4.

* **`:65` "attachments survive the same route change the draft text survives"**
  and **`:78` "a sent or cleared draft does not leave its files behind"** — both
  call `saveDraftFiles`/`loadDraftFiles` directly, so they test the module, not
  the wiring. **Delete `chat.tsx:481-483` (the whole restore) and both stay
  green** — the component would go back to `setAttachments([])` and the original
  bug would return untouched. The round-trip and the corrupt-record handling are
  worth keeping; the *names* promise integration coverage that is not there.
  The genuine regression test for the send path is precisely the one that would
  have caught §1.3, and it is absent.

* `:29` and `:59` are acceptable: they pin the "ordinary draft raises no
  budget line" UX contract and the "bytes are summed, not counted" decision.

**Net:** `chat-stream.test.ts` earns its keep. `chat-composer.test.ts` is
currently three integration tests wearing unit-test labels, and two of the
three would survive the exact bugs they were written to prevent. The fix is
either to rename them to what they check (`messageSize` arithmetic, key
derivation round-trip) or to make them real by reading the `chat.tsx` source the
way `compact-layout.test.ts:22` already does for `styles.css` — assert that the
`24576` literals are gone, that the queue-banner `disabled` includes `size.over`,
and that the restore effect calls `loadDraftFiles`. Plus the missing DOM harness
for the scroll and pill behaviour.
