# AGENTS.md — Technical Reference

This file describes the current architecture of the project for anyone (human or AI) picking it up cold. It intentionally omits rationale, history, and future plans — just what exists and how it fits together.

## What this is

- A single-file Tampermonkey **userscript** (`foundry-combat-timer.user.js`) for Foundry VTT. Not a Foundry module — it is never installed via Foundry's module manager, never appears in "Manage Modules", never touches `game.settings`.
- Plain IIFE, no build step, no dependencies, no imports. Everything lives in one file.
- Target: Foundry VTT **v13 and v14** (v14 is primary). Uses v13/v14-era APIs: the `Color` class (`user.color.css`), `Document#testUserPermission`, the record-based `getSceneControlButtons` shape (`controls.tokens.tools` / a top-level `SceneControl` with `tools`/`activeTool`), ApplicationV2-style `render({force: true})`.
- Tuned for the **dnd5e** and **pf2e** systems specifically where system-dependent assumptions were needed (e.g. actor types), but most logic is system-agnostic.

## Hard constraints

These are invariants the code must keep satisfying, not just current behavior:

1. **Client-side only.** No server writes. No `game.settings.register` (its intended timing — the `init` hook — is generally already past by the time a `document-idle` Tampermonkey script attaches; local persistence is `localStorage` instead).
2. **Anything visible to other connected clients must be self-contained.** Concretely: all HTML passed to `ChatMessage.create` must use fully inline `style="..."` with `!important` on every color/background/border declaration, and must never reference an externally injected `<style>` tag, CSS class, or anything else that depends on the *viewer* also having this script. This must render identically for someone who has never heard of this script, in both Foundry's light and dark theme. (`<table>` was deliberately abandoned for chat content in favor of flexbox `<div>`s — Foundry's/system's own table styling kept leaking through even with `!important`-hardened cells.)
3. **`combatStart` cannot be trusted alone** to signal a genuinely new encounter (reset-and-restart of the same Combat document, hook ordering, etc.). Session-boundary detection is done by comparing the live `Combat#id` against the last known one on tracked data (see "Session boundary detection" below), independent of which hook fires.
4. **The panel itself must never depend on anything experimental or version-sensitive.** `buildPanel()` / `let panel = buildPanel()` must remain the first thing that can possibly fail-safe; nothing else in `init()` is allowed to run before it if there's any chance it could throw. This script attaches via `@run-at document-idle`, i.e. strictly after Foundry's own core boot sequence — hooks that only fire once during that early boot (e.g. `getSceneControlButtons`, confirmed by logging: it never fires for a listener registered this late, and `ui.controls.render()` does not re-invoke it) are permanently unreachable from here and should not be relied on. The floating `⚔️` reopen button (`buildReopenButton()`, fixed position left-middle) is therefore the only entry point back into a closed panel — there is no scene-controls toolbar integration.

## Bootstrap

`waitForFoundryReady()` polls for `window.Hooks` to exist, then either calls back immediately if `game.ready` is already true or waits for `Hooks.once("ready", ...)`. This handles the race between Tampermonkey's `@run-at document-idle` firing before vs. after Foundry's own boot sequence — by the time our script attaches, Foundry's early lifecycle hooks (`init`/`setup`/`ready`) may already have fired.

## Data model

### Segment

The atomic unit of tracking — one contiguous slice of time with a single technical identity and a category. Segments are plain JSON-serializable objects (persisted via `JSON.stringify`).

```
{
  id: string,
  start: number,          // Date.now() timestamp
  end: number | null,     // null while running
  trigger: "turn" | "pause" | "unpause" | "resume" | "split",
  combatId: string | null,      // Combat document id, for session-boundary detection
  round: number | null,         // combat.round at creation time - not reconstructable later from timestamps (pauses/splits/reloads break that)
  turnIndex: number | null,     // combat.turn at creation time (0-indexed turn-order position); Foundry rounds themselves are 1-indexed
  combatantId: string | null,   // Combatant document id
  combatantName: string,
  actorId: string | null,       // Actor document id - stable across the encounter (and across sessions), unlike combatantId; not consumed anywhere yet
  ownerId: string | null,       // Foundry User id of the owning player; null = true NPC/monster
  overrideOwnerId: string | null, // manual reassignment target; wins over ownerId when set
  defeated: boolean,              // combatant.isDefeated, snapshotted at segment creation
  category: "player" | "dm" | "team" | "setup",
}
```

### Session and history

```js
segments: Segment[]          // current session, closed segments
currentSegment: Segment|null // current session, the running one
sessionHistory: { segments: Segment[], endedAt: number }[]  // ring buffer, max 2, newest first
```

Persisted as one JSON blob (`{ v: 1, segments, currentSegment, sessionHistory }`) under `localStorage["ctp-state-<world.id>-<user.id>"]`. `v` exists so a future schema change has a way to tell "this data predates versioning" from "this field is legitimately absent" — nothing currently reads or branches on it; it's a placeholder for exactly one future migration decision, not a general migration framework. **Scope is per-browser, per-Foundry-world, per-Foundry-user.** The user-id component exists specifically so two different Foundry accounts logged in from the same physical browser (e.g. a GM previewing a player account in a second tab) don't collide on the same storage key — Foundry only prevents two concurrent logins as the *same* account, not two different ones from one browser. There is no sync between different users' copies of this script — a GM and each player all have entirely independent tracking state. The only cross-client communication is the static HTML snapshot posted via chat reports; nothing feeds back from chat into tracking.

`loadPersisted()` falls back to the pre-user-scoping key (`ctp-state-<world.id>`, via `legacyStorageKey()`) whenever the current key has no *real* data yet (`hasPersistedData()`: any segments, a running segment, or history) — not just when it's completely absent, since a prior run of the script may already have written an empty state under the new key before this fallback existed. It's read-only as a fallback — the next `persist()` tick writes the adopted data forward under the current key, so this is a one-time, self-healing migration rather than an ongoing dual-read.

`selectedSession` (`"current" | "prev1" | "prev2"`) is pure UI state controlling what `getSelectedSessionData()` / `allSegments()` return for display and chat-report purposes. It never affects what's actually being tracked live — that always follows `game.combat` / `game.paused` regardless of what's on screen.

## Segmentation: what creates/closes a segment

Every segment, wherever it's built (real tracking, a split, dummy data), goes through `makeSegment(overrides)` — one function defining the default value for every field. A caller only specifies what's actually different from "nothing"; adding a new field later means adding it once, here, rather than hunting down every place a segment literal is built by hand.

- `Hooks.on("combatStart" | "updateCombat" [turn/round changed])` → `switchTurn(combat)`
- `Hooks.on("pauseGame")` → pause/unpause, but only if `game.combat` currently exists (pausing outside combat is not tracked)
- `Hooks.on("deleteCombatant")` → if the deleted combatant is the one `currentSegment` is tracking (some modules auto-delete a combatant the moment it's defeated, instead of just flagging it and leaving it in the tracker), the segment is marked `defeated: true` *before* `reconcileWithLiveState()` closes it out — same treatment as a combatant that was already defeated when its segment was created.
- Script (re)load → `reconcileWithLiveState()`: compares whatever was persisted against the actual live Foundry state (active combatant id + pause state). If it matches, the persisted `currentSegment` is left running untouched (including its original `start` time). If not, it's closed out and a fresh segment opened with trigger `"resume"`.
- Manual split (✂️ button) → `splitCurrentSegment()`: copies the running segment's fields (before `closeSegment()` mutates it), then closes it and opens a new one via `makeSegment({ ...carryOver, id, start, end: null, trigger: "split", overrideOwnerId: null })` — carries over everything (technical identity, category — a split is a continuation, not a reclassification, so it does not run back through `defaultCategory()`) except identity/timing and `overrideOwnerId`, which is explicitly reset: a split does not inherit a manual reassignment, it reverts to the technical owner.
- Manual category/player reassignment: mutates an existing segment's `category`/`overrideOwnerId` in place (no new segment created).

Only triggers `"turn"` and `"resume"` mark a genuinely new turn boundary (see `isTurnStart()` in Timing statistics) — never `"pause"`, `"unpause"`, or `"split"`, since those are continuations of an already-counted turn rather than new ones. `"resume"` counts because, by construction, `reconcileWithLiveState()` only ever creates one when live state does *not* match what was persisted — meaning it always represents either a genuinely new turn discovered after a reload, or a turn change missed while reloading. Either way it hasn't been counted anywhere else.

## Session boundary detection

`switchTurn(combat)`:
```js
const newCombatId = combat?.id ?? null;
const hasExistingData = !!currentSegment || segments.length > 0;
const knownCombatId = currentSegment?.combatId ?? segments.at(-1)?.combatId ?? null;
if (newCombatId && hasExistingData && knownCombatId !== newCombatId) archiveSessionIfNeeded();
```
A mismatch — including "no `combatId` recorded at all" (e.g. data persisted before this field existed) — triggers archival. This runs identically from both `combatStart` and `updateCombat`, so a new encounter is caught regardless of which hook actually fires for it.

`archiveSessionIfNeeded()`: closes the running segment, and if `segments` is non-empty, unshifts `{segments, endedAt: Date.now()}` onto `sessionHistory`, capped at 2 entries, then resets `segments`/`currentSegment` and forces `selectedSession = "current"`.

## Categorization & attribution

Four categories: `player`, `dm`, `team`, `setup`.

- **Default on creation** (`defaultCategory(trigger, prevSegment)`): `"player"` for every trigger except `"pause"`. For `"pause"`: if the segment right before it lasted under 5 seconds (likely a pause right at a round boundary, before anyone actually started deciding anything), default to `"setup"`; otherwise carry over the previous segment's category (assume genuine mid-decision interruption).
- **`isTracked(seg)`**: `!seg.defeated && !!seg.combatantId` — the single gate every aggregate uses for "does this segment count at all". An instantly-skipped already-dead combatant, or a segment with no combat context, never drags down any average.
- **`resolvedOwner(seg)`**: `seg.overrideOwnerId ?? seg.ownerId ?? null` — the single source of truth for "who does this segment's time belong to". An explicit reassignment via the player picker always wins over the technical owner.
- **`isPlayerControlled(seg)`**: `resolvedOwner(seg) !== null` — derived, not stored. There is no persisted `isPC` field; it used to be frozen at segment creation (`ownerId !== null`) and went stale the moment a segment was reassigned via `overrideOwnerId`, which was the root cause of B-04. Old persisted data may still have an `isPC` field on disk — it's simply ignored on load, no migration needed since it was always derivable.
- **`perCombatantStats()`**: only `category === "player"` segments, grouped by `resolvedOwner()`. Segments with no resolvable owner (a true, unclaimed NPC turn) are skipped here — they belong to `gmTotalStats()`/`npcAggregate()` instead. Splits each owner's time into `inTurnMs` (time during a turn slot they were structurally designated for — see Timing statistics) and `outOfTurnMs` (time reassigned to them from someone else's slot, e.g. an Attack of Opportunity); `byEntity` further breaks `inTurnMs` down per `combatantId`, so a player controlling multiple combatants (character + summons) can eventually be shown per-entity instead of only merged into one number.
- **`npcAggregate()`** / **`gmTotalStats()`**: unclaimed NPC-turn segments (`category === "player" && !isPlayerControlled(seg)`) plus, for `gmTotalStats()`, anything explicitly recategorized to `"dm"`. Both use `isTracked()`; `isPlayerControlled()` already accounts for `overrideOwnerId`, so a reassigned NPC turn is never double-counted against both the GM/NPC bucket and the receiving player.
- **`categoryTotals()`**: raw per-category sums for `dm`/`team`/`setup`, independent of any specific person.

## Timing statistics

- **`buildTurnSlots()`**: partitions the *entire* selected session's timeline (not per-owner) into consecutive turn slots. A slot starts at every segment with `trigger === "turn"` or `"resume"` (a genuine new turn beginning) and absorbs every following segment — `pause`/`unpause`/`split`, or a segment reassigned to someone else — until the next trigger. The very first segment always opens slot 1; trailing segments after the last trigger (including the live running one) stay in the last slot. Each slot's `designatedOwner` is the *technical*, non-overridden `ownerId` of whoever's turn it structurally was (`null` for an NPC/monster turn) — reassigning a segment inside a slot never changes who the slot belongs to structurally, it only moves that segment's *time* to a different person's bucket via `resolvedOwner()`.
- `perCombatantStats()`'s `turnCount` (and `byEntity[].turnCount`) counts slots by `designatedOwner`, gated on the slot's opening segment being `isTracked()` and `category === "player"` — so reassignment can inflate someone's *time* but never their turn count, and a defeated/non-player-category turn doesn't count as a turn at all.
- **`betweenTurnStats()`**: for each `designatedOwner`, the average gap between the end of one of their turn slots and the start of the next. The time before their very first slot plus the time after their very last slot is combined into **one extra synthetic gap** ("wraparound") before averaging — a boundary fragment alone is biased by seat/turn-order position, but the combination of both reconstructs something equivalent to one full real gap, included as exactly one additional sample. This also means someone with only a single turn slot still gets a usable average instead of "no data".
- **`absoluteWaitStats()`**: session span minus a player's own active time, where "active" is `inTurnMs + outOfTurnMs` combined (both mean "not idle", regardless of whose slot the time technically fell in). `setup`-category segments are excluded from active time but stay inside the span, so setup time reads as wait time for *every* player. `team`-category segments are cut out of the span itself, so shared/group time is invisible to individual wait entirely — it only shows up via `categoryTotals().teamMs` / the Team bar in the chart. Keyed directly by `resolvedOwner()` across all tracked player-category segments (not by turn slots), so a player who only ever received reassigned time and never had their own designated turn still gets a real wait figure instead of being missing from the map.
- **`sessionTotalMs()`**: first segment start to last segment end (or now) across the whole selected session — "how long this took overall". Not the same span `absoluteWaitStats()` uses internally (that one excludes `team` time); the two can legitimately differ.
- **`formatDuration(seconds)`**: renders `>=60s` as `XmYYs`, otherwise `Ys`. Used everywhere a duration is displayed, in both the panel and chat reports.
- **`escapeHtml(s)`**: escapes `& < > " '`. Every name interpolated into `innerHTML` or `ChatMessage` content goes through it — token/actor/user names are renamed by anyone with permission, and both the panel's `innerHTML` and chat content (post "Reveal to Everyone") render whatever's in them to other clients.

## Rendering

- The panel is a hand-built `<div id="combat-timer-panel">`, not a Foundry `Application`/`ApplicationV2`.
- `renderPanel()` runs on a 1-second `setInterval`. It fully replaces the `innerHTML` of each dynamic sub-section and rebinds event listeners every tick — there is no diffing. This is intentional and cheap at this data size; it also means any interactive element inside a re-rendered region only needs its listener attached once per render, not preserved across renders.
- `persist()` is called at the top of every `renderPanel()` tick (plus at explicit mutation points like segment reassignment), so state loss on an unexpected reload is bounded to under ~1 second.
- Key panel element ids: `ctp-header`, `ctp-dummy`, `ctp-reset` (dual-purpose new/delete, see below), `ctp-close`, `ctp-status`, `ctp-rows`, `ctp-footer`, `ctp-toolbar` (split button + session tabs, rendered together as equal-width flex items), `ctp-io` (export/import, see below), `ctp-segments`, `ctp-post-bars`, `ctp-post-players`. The small always-on-top reopen button is `ctp-reopen` (not part of the panel's own DOM tree — created separately by `buildReopenButton()`).
- `exportSelectedSession()` / `importSessionFromFile()`: operate on whichever session is currently selected (`selectedSession`), not the full persisted blob — exporting downloads a JSON file (`{ exportedAt, world, session, endedAt, segments, currentSegment }`) via a throwaway `Blob`/`<a download>`; importing reads a file picked through a hidden `#ctp-import-file` input, validates only that `segments` is an array, then after a `confirm()` **replaces** that session's data outright (no archiving of what was there). Importing into `"current"` calls `reconcileWithLiveState()` immediately afterward, since the imported `currentSegment` (if any) has no guarantee of matching whatever's actually live right now. Importing into `"prev1"`/`"prev2"` is only reachable when that tab already has data, since the UI only lets you select an available tab.
- `#ctp-reset` changes icon/tooltip/behavior each render depending on `selectedSession`: on `"current"` it reads 🆕 and calls `archiveSessionIfNeeded()` + `reconcileWithLiveState()` (never destructive); on an archived tab it reads 🗑️ and permanently removes that entry from `sessionHistory`.
- The player-reassignment picker (segment row → 🧑 icon) is toggled via the module-level `playerPickerSegId` variable, compared against each segment's id during render; clicking a player chip sets `category:"player"` + `overrideOwnerId`, clicking "↩ Default" clears `overrideOwnerId` back to `null`.

## Chat output

`buildBarsContent()` and `buildPlayerListContent()` each return a standalone HTML string (see hard constraint #2 for the styling rules), built via a shared `wrapCard({ title, subtitle, body })` — the card container, header line, and "No data" fallback are written once, so the `!important` hardening only has to be kept correct in one place. Both are posted via `postToChat(content, kind)`:
```js
ChatMessage.create({
  content,
  speaker: ChatMessage.getSpeaker({ alias: "Combat Timer" }), // not the default - avoids posting under whatever token happens to be selected
  whisper: [game.user.id],
  flags: { "combat-timer": { kind, session: selectedSession, at: Date.now() } }, // kind: "bars" | "players"; lets a future feature find/identify its own past reports
});
```
Always self-only ("self roll" semantics) — there is deliberately no in-panel "reveal to everyone" button; Foundry's own chat-message context menu already offers "Reveal to Everyone" for any message the current user authored and whispered to themselves, so it isn't reimplemented here.

- `buildBarsContent()`: one bar per player (via `perCombatantStats()` — every entry it returns is already a real player, so no further filtering is needed), plus one combined "GM" bar (`gmTotalStats()`), plus a "Team" bar (anthracite `#383E42`) and a "Setup" bar (GM's color) whenever those categories have any time at all — all sorted together by total time descending, not shown separately or omitted when zero.
- `buildPlayerListContent()`: one stacked block per player (name on its own full-width line, three stats — avg turn / avg gap / total wait — on the line below), sorted by total time descending — the same order as `buildBarsContent()`, so the two reports line up when read side by side. Deliberately `<div>`-based, not a `<table>`, both to avoid host CSS leakage and because a 4-column table didn't fit Foundry's narrow chat sidebar without wrapping. A single tiny legend line follows the last row (only when there's at least one, i.e. not shown alongside the "No data" fallback) clarifying that Turn/Gap are averages and Wait is a total.

## Multi-server support

`@match` in the userscript header is a plain static list — one line per Foundry server URL, no dynamic logic. Duplicate the line to add more.
