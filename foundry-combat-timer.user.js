// ==UserScript==
// @name         Foundry VTT Combat Timer
// @namespace    https://local.private/
// @version      0.3
// @author       DerJJ/Umek
// @description  Persistent, segmented combat time tracking with a session ring buffer (current + last 2), automatic new session on combat start, dummy data button, Player/GM/Team/Setup/Ignore categorization, player/GM colors, owner-based grouping, defeated filter, two self-roll chat reports (dnd5e & pf2e)
// @match        https://YOUR-SERVER-1.example.com/*
// @match        https://YOUR-SERVER-2.example.com/*
// @match        https://YOUR-SERVER-3.example.com/*
// @match        https://YOUR-SERVER-4.example.com/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/DerJJ/Combat-Timer/main/foundry-combat-timer.user.js
// @updateURL    https://raw.githubusercontent.com/DerJJ/Combat-Timer/main/foundry-combat-timer.user.js
// @supportURL   https://github.com/DerJJ/Combat-Timer/issues
// @icon         https://raw.githubusercontent.com/DerJJ/Combat-Timer/main/icon.webp
// ==/UserScript==
// Add one @match line per Foundry server you play on - just duplicate the
// line above and swap in the URL. No limit on how many you add.

(function () {
  'use strict';

  function waitForFoundryReady(cb) {
    function attach() {
      if (window.game?.ready) return cb();
      Hooks.once("ready", cb);
    }
    if (window.Hooks) return attach();
    const id = setInterval(() => {
      if (window.Hooks) {
        clearInterval(id);
        attach();
      }
    }, 200);
  }

  waitForFoundryReady(init);

  function init() {
    // Each category carries its own chip colors so a glance down the segment
    // list reads as categories, not as "which of five identical icons is
    // highlighted". `label` is shown as text - an emoji alone was ambiguous
    // (🧑 meant both "player-controlled" and "category: player").
    const CATEGORY_META = {
      player: { icon: "🧑", label: "Player", bg: "#2f4f7a", fg: "#cfe3ff" },
      dm:     { icon: "🎲", label: "GM",     bg: "#6b2f2f", fg: "#ffd2d2" },
      team:   { icon: "👥", label: "Team",   bg: "#2f5f57", fg: "#c9f0e6" },
      setup:  { icon: "🛠️", label: "Setup",  bg: "#6b5220", fg: "#ffe0ad" },
      ignore: { icon: "🚫", label: "Ignore", bg: "#3a3a46", fg: "#b8b8c4" }, // manual-only (never auto-assigned) - excluded from every total, for a segment that's really just a wall-clock gap (e.g. the session resumed days later)
    };

    // Team and Setup are categories, not people. Setup used to reuse the GM's
    // color (getCombatantColor(null)), which made two adjacent bars in the same
    // chat report identical and unidentifiable. Team stays genuinely
    // person-independent (shared/group time); Setup is DM-only by definition
    // (see defaultCategory()/categoryPickerHTML()) but keeps its own row and
    // color rather than folding into the GM bar, for that same legibility reason.
    const TEAM_COLOR = "#383E42";
    const SETUP_COLOR = "#6b6f74";

    // ---- Persistence ----
    function storageKey() {
      return `ctp-state-${game.world?.id ?? "default"}-${game.user?.id ?? "default"}`;
    }
    function loadPersisted() {
      try {
        return JSON.parse(localStorage.getItem(storageKey()) ?? "null");
      } catch (e) {
        console.warn("Combat Timer: could not load saved state", e);
        return null;
      }
    }
    function persist() {
      try {
        localStorage.setItem(storageKey(), JSON.stringify({ v: 1, segments, currentSegment, sessionHistory }));
      } catch (e) {
        console.warn("Combat Timer: could not save state", e);
      }
    }

    let segments = [];          // current session: closed segments
    let currentSegment = null;  // current session: the running segment
    let sessionHistory = [];    // ring buffer: last 2 finished sessions, newest first
    let panelVisible = true;

    const saved = loadPersisted();
    if (saved) {
      segments = saved.segments ?? [];
      currentSegment = saved.currentSegment ?? null;
      sessionHistory = saved.sessionHistory ?? [];
    }

    function uid() {
      return crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function getOwningPlayerId(actor) {
      if (!actor) return null;
      const owner = game.users.find((u) => !u.isGM && actor.testUserPermission(u, "OWNER"));
      return owner?.id ?? null;
    }

    // Deterministic fallback color for an owner id that doesn't resolve to a
    // real, currently-known Foundry user - a synthetic dummy-data id (see
    // getDummyPlayerSource()), or a real id from an imported session that
    // isn't in THIS world's roster (a player who left, or data imported from
    // a different game). Hashing the id itself keeps the color stable across
    // renders and reloads with no state to persist, and two different
    // unresolvable ids reliably land on two different colors instead of
    // every one of them collapsing onto the same flat grey.
    function hashToHex(str) {
      let hash = 0;
      for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
      const hue = Math.abs(hash) % 360;
      return hslToHex(hue, 55, 55);
    }
    function hslToHex(h, s, l) {
      s /= 100; l /= 100;
      const k = (n) => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      const toHex = (n) => Math.round(f(n) * 255).toString(16).padStart(2, "0");
      return `#${toHex(0)}${toHex(8)}${toHex(4)}`;
    }

    function getCombatantColor(ownerId) {
      if (ownerId) return game.users.get(ownerId)?.color.css ?? hashToHex(ownerId);
      const gm = game.users.find((u) => u.isGM && u.active) ?? game.users.find((u) => u.isGM);
      return gm ? gm.color.css : "#c0392b";
    }

    const SETUP_PAUSE_THRESHOLD_MS = 5000; // a pause right after a short prior segment is likely a round-boundary pause, not a mid-decision one
    const SHORT_PAUSE_MERGE_THRESHOLD_MS = 3000; // a pause shorter than this is noise (toggle lag, a misclick) - fold it into whatever ran right before instead of showing it as its own segment

    // Setup is a DM-only category (see CATEGORY_META) - a segment with a
    // player owner can never default to, or inherit, "setup".
    function defaultCategory(trigger, prevSegment, ownerId) {
      if (trigger === "pause") {
        const dmOwned = !ownerId;
        const prevDur = prevSegment ? segMs(prevSegment) : Infinity;
        if (dmOwned && prevDur < SETUP_PAUSE_THRESHOLD_MS) return "setup";
        // "ignore" is manual-only (see CATEGORY_META) - a live pause is real
        // time and must never silently inherit it from the segment before.
        if (prevSegment && prevSegment.category !== "ignore" && (dmOwned || prevSegment.category !== "setup")) {
          return prevSegment.category;
        }
        return dmOwned ? "setup" : "player";
      }
      return "player";
    }

    function closeSegment() {
      if (!currentSegment) return;
      currentSegment.end = currentSegment.end ?? Date.now();
      const prev = segments[segments.length - 1] ?? null;
      if (currentSegment.trigger === "pause" && prev && segMs(currentSegment) < SHORT_PAUSE_MERGE_THRESHOLD_MS) {
        // Too short to be a meaningful pause - absorb it into whatever was
        // running right before instead of leaving a tiny segment behind.
        prev.end = currentSegment.end;
      } else {
        segments.push(currentSegment);
      }
      currentSegment = null;
    }

    // Single source of truth for the Segment shape - every field gets a
    // default here, so a caller (real tracking, a split, dummy data) only
    // has to specify what's actually different from "nothing". Adding a new
    // field means adding it once, here, instead of hunting down every place
    // a segment literal gets built by hand and hoping none get missed.
    function makeSegment(overrides) {
      return {
        id: uid(),
        start: Date.now(),
        end: null,
        trigger: null, // "turn" | "pause" | "unpause" | "resume" | "split"
        combatId: null, // which Combat document this belongs to - used to detect a genuinely new encounter
        round: null, // only known at creation time - can't be reconstructed later from timestamps alone
        turnIndex: null,
        combatantId: null,
        combatantName: "–",
        actorId: null, // stable across the encounter (and across sessions), unlike combatantId
        actorType: null, // combatant.actor.type - raw value, stored as-is; see isPcActorType() for what counts as "a real PC" vs a player-owned summon/pet, which "ownerId !== null" alone can't distinguish
        ownerId: null,
        overrideOwnerId: null, // manual reassignment to a specific player, wins over ownerId
        defeated: false,
        category: "player",
        ...overrides,
      };
    }

    function openSegment(trigger, combatant, combat = null) {
      const prev = segments[segments.length - 1] ?? null;
      const ownerId = getOwningPlayerId(combatant?.actor);
      currentSegment = makeSegment({
        trigger,
        combatId: combat?.id ?? null,
        round: combat?.round ?? null,
        turnIndex: combat?.turn ?? null,
        combatantId: combatant?.id ?? null,
        combatantName: combatant?.name ?? combatant?.token?.name ?? "–",
        actorId: combatant?.actor?.id ?? null,
        actorType: combatant?.actor?.type ?? null,
        ownerId,
        defeated: combatant?.isDefeated ?? false,
        category: defaultCategory(trigger, prev, ownerId),
      });
    }

    // Manually split the currently running segment right now, e.g. to carve
    // out an Attack of Opportunity or similar interrupt during someone's
    // turn. The new segment keeps the same technical identity (still "whoever
    // is on the clock") until you explicitly reassign it via the player
    // picker - it does NOT count as a new turn (trigger "split" is excluded
    // from turnCount, same as "unpause"/"resume").
    function splitCurrentSegment() {
      if (!currentSegment) return;
      const carryOver = { ...currentSegment }; // copy before closeSegment() mutates the original's `end`
      closeSegment();
      currentSegment = makeSegment({
        ...carryOver, // same technical identity and category - a split is a continuation, not a reclassification
        id: uid(),
        start: Date.now(),
        end: null,
        trigger: "split",
        overrideOwnerId: null, // a split does NOT inherit a manual reassignment - it reverts to the technical owner
      });
      selectedSession = "current";
      persist();
    }

    function reconcileWithLiveState() {
      const liveCombat = game.combat ?? null;
      const liveCombatant = liveCombat?.combatant ?? null;
      const liveCombatantId = liveCombatant?.id ?? null;
      const livePaused = liveCombat ? game.paused : false; // pause outside combat doesn't count
      const currentIsPause = currentSegment?.trigger === "pause";

      if (currentSegment && currentSegment.combatantId === liveCombatantId && currentIsPause === livePaused) {
        return;
      }
      // Same short-pause merge as every other close path - the threshold is
      // judged purely on the pause segment's own wall-clock duration, which is
      // exactly as meaningful whether it's being closed live or caught here
      // (e.g. right after a page reload), so a brief pause doesn't survive as
      // its own tiny segment just because of which path happened to close it.
      closeSegment();
      if (!liveCombat) return; // no combat -> track nothing, currentSegment stays null
      if (livePaused) {
        openSegment("pause", liveCombatant, liveCombat);
      } else if (liveCombatant) {
        openSegment("resume", liveCombatant, liveCombat);
      }
    }
    reconcileWithLiveState();

    // A brand new session starts automatically as soon as we detect the
    // ACTUAL Combat id has changed from whatever the current session was
    // tracking - this is more robust than relying on the "combatStart" hook
    // alone (which may not fire for every reset-and-restart edge case).
    let selectedSession = "current"; // "current" | "prev1" | "prev2" - display only, NOT the live data
    let playerPickerSegId = null; // which segment's player-reassignment picker is expanded, if any
    function archiveSessionIfNeeded() {
      closeSegment();
      if (!segments.length) return;
      sessionHistory.unshift({ segments, endedAt: Date.now() });
      sessionHistory = sessionHistory.slice(0, 2);
      segments = [];
      currentSegment = null;
      selectedSession = "current"; // focus the new session
      // Same reset a manual tab switch already does (see renderTabs()) - a
      // fresh session's segments get fresh ids so there's no collision risk
      // either way, but this bounds liveGroupsSeeded's growth to one
      // session's worth of turns instead of the whole page's lifetime.
      expandedGroups = new Set();
      liveGroupsSeeded = new Set();
    }

    function getSelectedSessionData() {
      if (selectedSession === "current") return { segs: segments, current: currentSegment };
      const idx = selectedSession === "prev1" ? 0 : 1;
      const hist = sessionHistory[idx];
      return { segs: hist ? hist.segments : [], current: null };
    }

    function switchTurn(combat) {
      const newCombatId = combat?.id ?? null;
      const hasExistingData = !!currentSegment || segments.length > 0;
      const knownCombatId = currentSegment?.combatId ?? segments[segments.length - 1]?.combatId ?? null;
      // Mismatch if there's existing data and its recorded combat id doesn't
      // match the live one - including the case where old data has NO
      // combatId at all (e.g. persisted by a script version from before this
      // field existed). Missing != known real id counts as "different".
      if (newCombatId && hasExistingData && knownCombatId !== newCombatId) {
        archiveSessionIfNeeded();
      }
      closeSegment();
      openSegment("turn", combat?.combatant ?? null, combat);
    }

    Hooks.on("combatStart", (combat) => switchTurn(combat));
    Hooks.on("updateCombat", (combat, changed) => {
      if ("turn" in changed || "round" in changed) switchTurn(combat);
    });
    Hooks.on("deleteCombat", () => closeSegment());
    Hooks.on("deleteCombatant", (combatant) => {
      // Some modules auto-delete a combatant as soon as it's defeated (instead
      // of just flagging it defeated and leaving it in the tracker). Treat
      // that the same way as an already-defeated combatant: the current
      // segment is marked defeated (excluded from every aggregate) before
      // reconcileWithLiveState() closes it out and picks up whatever's next.
      if (currentSegment?.combatantId === combatant.id) {
        currentSegment.defeated = true;
        reconcileWithLiveState();
      }
    });
    Hooks.on("pauseGame", (paused) => {
      if (!game.combat) return; // pausing outside of combat isn't tracked
      const active = game.combat.combatant ?? null;
      closeSegment();
      openSegment(paused ? "pause" : "unpause", active, game.combat);
    });

    // Some modules hide an NPC's real name until a reveal condition is met
    // (an "unidentified creature" system, say), then rename the combatant
    // later. combatantName is captured once at segment creation and never
    // re-read on its own (see Segment in AGENTS.md), so without this a
    // reveal would leave every already-created segment showing the old,
    // hidden name forever - checked once per render tick against the LIVE
    // combat and propagated backward onto every segment for that combatant
    // in the CURRENTLY TRACKED session (segments/currentSegment directly,
    // not allSegments() - this must stay tied to the live data regardless of
    // which tab is selected for viewing). An archived session's combat no
    // longer exists live to compare against, so it can't be fixed there.
    function syncCombatantNames() {
      const combat = game.combat;
      if (!combat) return;
      const liveSegs = currentSegment ? [...segments, currentSegment] : segments;
      for (const c of combat.combatants) {
        const liveName = c.name ?? c.token?.name ?? null;
        if (!liveName) continue;
        for (const seg of liveSegs) {
          if (seg.combatantId === c.id && seg.combatantName !== liveName) seg.combatantName = liveName;
        }
      }
    }

    // ---- Derived stats (always for the SELECTED session) ----
    function allSegments() {
      const { segs, current } = getSelectedSessionData();
      return current ? [...segs, current] : segs;
    }
    function segMs(seg) {
      return (seg.end ?? Date.now()) - seg.start;
    }
    function formatDuration(totalSeconds) {
      const s = Math.max(0, Math.round(totalSeconds));
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m > 0 ? `${m}m${String(sec).padStart(2, "0")}s` : `${sec}s`;
    }
    // Every name interpolated into innerHTML/ChatMessage content goes through
    // this first - names come from token/actor/user names, which anyone with
    // rename permission controls, and chat content can be seen by other
    // clients after "Reveal to Everyone".
    function escapeHtml(s) {
      return String(s ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    function findSegment(id) {
      return allSegments().find((s) => s.id === id) ?? null;
    }

    // Single source of truth for "does this segment have real combat context
    // at all" - used by every aggregate below (see AGENTS.md).
    function hasCombatContext(seg) {
      return !!seg.combatantId;
    }
    function resolvedOwner(seg) {
      return seg.overrideOwnerId ?? seg.ownerId ?? null;
    }
    function isPlayerControlled(seg) {
      return resolvedOwner(seg) !== null;
    }
    // dnd5e/pf2e-specific: the Actor "type" value that means "a real player
    // character", as opposed to an NPC/summon - ownership alone can't tell
    // them apart, since a player-owned summon still has an NPC-shaped actor.
    // Not generalized to other systems (this script doesn't support any),
    // but kept as one place to extend if that ever changes, instead of the
    // same literal string duplicated at every call site that cares.
    const PC_ACTOR_TYPE = "character";
    function isPcActorType(actorType) {
      return actorType === PC_ACTOR_TYPE;
    }

    // A defeated PC still gets a real turn (death saves etc. are genuine
    // activity); a defeated NPC's turn is an instant skip - nobody actually
    // decided anything, so it never counts as "a turn" for averaging,
    // regardless of who its time ends up credited to (see effectiveOwner()).
    function isRealTurn(seg) {
      return hasCombatContext(seg) && (!seg.defeated || isPcActorType(seg.actorType));
    }
    // For each combatantId, who resolvedOwner() credited its most recent real
    // (non-instant-skip) turn to. Recomputed fresh every time - not cached -
    // so it always reflects the latest known ownership, including a manual
    // reassignment made after the fact via the player picker.
    function lastLiveOwnerByCombatant() {
      const map = new Map();
      for (const seg of allSegments()) {
        if (isRealTurn(seg)) map.set(seg.combatantId, resolvedOwner(seg));
      }
      return map;
    }
    // Like resolvedOwner(), but a defeated NPC's instant-skip inherits
    // whoever owned its last real turn (possibly nobody, i.e. the GM/Monsters
    // bucket) instead of always reading as unclaimed - this is what stops
    // that time from silently vanishing from every total.
    function effectiveOwner(seg, lastLiveOwner) {
      if (seg.overrideOwnerId) return seg.overrideOwnerId;
      if (seg.ownerId) return seg.ownerId;
      if (seg.defeated) return lastLiveOwner.get(seg.combatantId) ?? null;
      return null;
    }

    // One player's turn/entity-time breakdown. "In-turn" = time during a slot
    // this owner was structurally designated for (their own turn, or one of
    // their controlled entities' turns - e.g. a necromancer's summons).
    // "Out-of-turn" = time reassigned to them from someone else's slot (e.g.
    // an Attack of Opportunity). turnCount/byEntity only count designated
    // slots, never out-of-turn credit, so reassignment can't inflate them.
    function perCombatantStats() {
      const map = new Map();
      const getOwner = (id) => {
        if (!map.has(id)) {
          map.set(id, {
            id, name: ownerName(id), color: getCombatantColor(id),
            totalMs: 0, turnCount: 0, inTurnMs: 0, outOfTurnMs: 0, pausedMs: 0, byEntity: new Map(),
          });
        }
        return map.get(id);
      };
      // seg's own combatantId/combatantName/actorType, not the slot's - an
      // out-of-turn credit's entity is whichever combatant actually did the
      // acting (e.g. the monster a redirected defeated-NPC segment came
      // from), which can differ from the owner's other entities entirely.
      const getEntity = (owner, seg) => {
        if (!owner.byEntity.has(seg.combatantId)) {
          owner.byEntity.set(seg.combatantId, {
            combatantId: seg.combatantId, name: seg.combatantName, actorType: seg.actorType,
            inTurnMs: 0, outOfTurnMs: 0, pausedMs: 0, turnCount: 0,
          });
        }
        return owner.byEntity.get(seg.combatantId);
      };

      const lastLiveOwner = lastLiveOwnerByCombatant();
      for (const slot of buildTurnSlots()) {
        const opening = slot.segments[0];
        if (slot.designatedOwner && opening.category === "player" && isRealTurn(opening) && isTurnStart(opening)) {
          const owner = getOwner(slot.designatedOwner);
          owner.turnCount += 1;
          getEntity(owner, opening).turnCount += 1;
        }
        for (const seg of slot.segments) {
          if (seg.category !== "player" || !hasCombatContext(seg)) continue;
          const owner = effectiveOwner(seg, lastLiveOwner);
          if (!owner) continue; // unclaimed NPC turn -> npcAggregate/gmTotalStats instead
          const e = getOwner(owner);
          const entity = getEntity(e, seg);
          const ms = segMs(seg);
          e.totalMs += ms;
          if (seg.trigger === "pause") { e.pausedMs += ms; entity.pausedMs += ms; }
          if (owner === slot.designatedOwner) {
            e.inTurnMs += ms;
            entity.inTurnMs += ms;
          } else {
            e.outOfTurnMs += ms;
            entity.outOfTurnMs += ms;
          }
        }
      }
      return [...map.values()].map((e) => ({ ...e, byEntity: [...e.byEntity.values()] }));
    }

    function npcAggregate() {
      let totalMs = 0, turns = 0;
      const lastLiveOwner = lastLiveOwnerByCombatant();
      for (const seg of allSegments()) {
        if (seg.category !== "player" || !hasCombatContext(seg)) continue;
        if (effectiveOwner(seg, lastLiveOwner) !== null) continue; // claimed by someone -> perCombatantStats/gmTotalStats("dm") instead
        totalMs += segMs(seg);
        // isTurnStart() too - see gmTotalStats() - so a pause/unpause/split
        // inside one monster's turn doesn't count as several turns.
        if (isRealTurn(seg) && isTurnStart(seg)) turns += 1; // an instant-skip's brief duration still counts toward totalMs, but never masquerades as "a turn"
      }
      return { totalS: Math.round(totalMs / 1000), turns, avgS: turns ? Math.round(totalMs / turns / 1000) : 0 };
    }

    // Raw totals for the two categories nobody else already aggregates -
    // "dm" is covered by gmTotalStats()/countsForGM() instead, so it isn't
    // tracked here. Deliberately does not gate on hasCombatContext() like
    // the other aggregates - team/setup time commonly has no combatantId at
    // all (pre-combat prep, between-encounter housekeeping), and that's
    // exactly the time these categories exist to capture, not an edge case
    // to drop.
    function categoryTotals() {
      const t = { team: 0, setup: 0 };
      for (const seg of allSegments()) if (seg.category in t) t[seg.category] += segMs(seg);
      return { teamMs: t.team, setupMs: t.setup };
    }

    // Partitions the whole timeline into turn slots, independent of who ends
    // up owning any individual segment inside one. A slot starts at every
    // "turn"/"resume" segment (a genuine new turn beginning) and absorbs
    // every following segment - pause/unpause/split, or a reassigned chunk -
    // until the next one. The very first segment always opens slot 1;
    // trailing segments after the last trigger stay in the last slot.
    // designatedOwner is the TECHNICAL (non-overridden) owner of whoever's
    // turn this structurally was - it never changes due to reassignment.
    function isTurnStart(seg) {
      return seg.trigger === "turn" || seg.trigger === "resume";
    }
    function buildTurnSlots() {
      const slots = [];
      let afterIgnored = false;
      for (const seg of allSegments()) {
        if (seg.category === "ignore") {
          // A wall-clock gap someone manually marked as not real time (e.g.
          // the session resumed days later) - never becomes part of any
          // slot, and never lets one slot span across it either.
          afterIgnored = true;
          continue;
        }
        if (!slots.length || isTurnStart(seg) || afterIgnored) {
          slots.push({ designatedOwner: seg.ownerId ?? null, start: seg.start, end: seg.end ?? Date.now(), segments: [seg] });
        } else {
          const slot = slots[slots.length - 1];
          slot.end = seg.end ?? Date.now();
          slot.segments.push(seg);
        }
        afterIgnored = false;
      }
      return slots;
    }

    // Shared by betweenTurnStats() and turnWindowStats(): each player's own
    // real turn-opening slots, grouped by owner, plus the whole session's
    // span. A slot's designatedOwner comes straight from the opening
    // segment's raw ownerId regardless of category - a stray "setup" blip
    // (e.g. a tracker mis-click) still carries a real player's id and would
    // otherwise be mistaken for one of "their" turn boundaries.
    function ownTurnSlotsByOwner() {
      const slots = buildTurnSlots();
      const byOwner = new Map();
      for (const s of slots) {
        if (!s.designatedOwner || s.segments[0].category !== "player" || !isRealTurn(s.segments[0]) || !isTurnStart(s.segments[0])) continue;
        if (!byOwner.has(s.designatedOwner)) byOwner.set(s.designatedOwner, []);
        byOwner.get(s.designatedOwner).push(s);
      }
      const spanStart = slots.length ? Math.min(...slots.map((s) => s.start)) : 0;
      const spanEnd = slots.length ? Math.max(...slots.map((s) => s.end)) : 0;
      return { byOwner, spanStart, spanEnd };
    }

    function betweenTurnStats() {
      const { byOwner, spanStart, spanEnd } = ownTurnSlotsByOwner();
      const result = new Map();
      for (const [id, list] of byOwner) {
        list.sort((a, b) => a.start - b.start);
        let sum = 0, count = 0;
        for (let i = 0; i < list.length - 1; i++) {
          const gap = list[i + 1].start - list[i].end;
          if (gap > 0) { sum += gap; count += 1; }
        }
        const wrap = (list[0].start - spanStart) + (spanEnd - list[list.length - 1].end);
        if (wrap > 0) { sum += wrap; count += 1; }
        result.set(id, { avgMs: count ? sum / count : 0, count });
      }
      return result;
    }

    // Fences each player's own timeline into one window per turn, the same
    // way a "round" was defined for them from the start: a turn's window
    // runs from the end of their PREVIOUS turn (or the session start, for
    // their first) through the end of THIS turn - so anything credited to
    // them out-of-turn in between (e.g. an Attack of Opportunity) belongs to
    // the turn whose window it fell in, not floating outside every turn.
    // The last turn has no "next" turn to hand off to, so its window keeps
    // absorbing time through the end of the session instead of stopping at
    // its own turn's end - trailing activity still counts toward the turn
    // that precedes it. Because these windows partition the player's
    // entire credited timeline with no gaps or overlaps, the sum across all
    // of them is always exactly perCombatantStats()'s totalMs for that
    // player - so the average this returns can never disagree with the
    // total shown next to it, unlike a plain inTurnMs/turnCount average.
    function turnWindowStats() {
      const { byOwner, spanStart, spanEnd } = ownTurnSlotsByOwner();
      const lastLiveOwner = lastLiveOwnerByCombatant();
      const segs = allSegments();

      const result = new Map();
      for (const [owner, list] of byOwner) {
        list.sort((a, b) => a.start - b.start);
        const windows = list.map((slot, i) => ({
          turnIndex: i + 1,
          start: i === 0 ? spanStart : list[i - 1].end,
          end: i === list.length - 1 ? spanEnd : slot.end,
          ms: 0,
        }));
        for (const seg of segs) {
          if (seg.category !== "player" || !hasCombatContext(seg)) continue;
          if (effectiveOwner(seg, lastLiveOwner) !== owner) continue;
          // Half-open [start, end) windows chained end-to-end - every
          // credited segment's start falls in exactly one, except a
          // zero-duration edge case at the very last boundary, which the
          // fallback folds into the last window rather than dropping.
          const w = windows.find((win) => seg.start >= win.start && seg.start < win.end) ?? windows[windows.length - 1];
          w.ms += segMs(seg);
        }
        const totalMs = windows.reduce((sum, w) => sum + w.ms, 0);
        result.set(owner, { windows, avgMs: windows.length ? totalMs / windows.length : 0 });
      }
      return result;
    }

    // Wait = session span minus a player's own active time (in-turn +
    // out-of-turn combined - both mean "not idle"). "setup" segments are
    // excluded from active time but stay inside the span, so they read as
    // wait time for every player. "team" segments are cut out of the span
    // itself, so shared/group time is invisible to individual wait entirely
    // (it only shows up via the GM/Team category totals).
    function absoluteWaitStats() {
      let spanStart = null, spanEnd = null, teamMs = 0, ignoredMs = 0;
      for (const seg of allSegments()) {
        if (!hasCombatContext(seg)) continue;
        const end = seg.end ?? Date.now();
        if (spanStart === null || seg.start < spanStart) spanStart = seg.start;
        if (spanEnd === null || end > spanEnd) spanEnd = end;
        if (seg.category === "team") teamMs += segMs(seg);
        if (seg.category === "ignore") ignoredMs += segMs(seg);
      }
      if (spanStart === null) return new Map();
      const span = Math.max(0, (spanEnd - spanStart) - teamMs - ignoredMs);

      const lastLiveOwner = lastLiveOwnerByCombatant();
      const activeMs = new Map();
      for (const seg of allSegments()) {
        if (seg.category !== "player" || !hasCombatContext(seg)) continue;
        const owner = effectiveOwner(seg, lastLiveOwner);
        if (!owner) continue;
        activeMs.set(owner, (activeMs.get(owner) ?? 0) + segMs(seg));
      }
      const result = new Map();
      for (const [id, active] of activeMs) result.set(id, Math.max(0, span - active));
      return result;
    }

    // Wall-clock span of the whole session: first segment start to last
    // segment end (or now, if still running) - "how long did this take overall".
    function sessionTotalMs() {
      const segs = allSegments();
      if (!segs.length) return 0;
      const start = Math.min(...segs.map((s) => s.start));
      const end = Math.max(...segs.map((s) => s.end ?? Date.now()));
      // Excluding an "ignore" segment from the min/max above wouldn't shrink
      // the span by itself - segments before and after it still anchor the
      // same start/end. Its duration has to be explicitly subtracted instead.
      const ignoredMs = segs.filter((s) => s.category === "ignore").reduce((sum, s) => sum + segMs(s), 0);
      return Math.max(0, (end - start) - ignoredMs);
    }

    // ---- Dummy data (only if the current session is empty) ----

    // Standard normal via Box-Muller, then rescaled to (mean, stdDev).
    function gaussianRandom(mean, stdDev) {
      let u = 0, v = 0;
      while (u === 0) u = Math.random(); // avoid log(0)
      while (v === 0) v = Math.random();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return mean + z * stdDev;
    }

    // Gaussian duration within [minMs, maxMs]: mean at the range's center,
    // stdDev = range/6 so ~99.7% of draws land inside on their own; clamped
    // at the edges to catch the rare outlier from the Box-Muller tail.
    function randomGaussianDurationMs(minMs, maxMs) {
      const mean = (minMs + maxMs) / 2;
      const stdDev = (maxMs - minMs) / 6;
      const val = gaussianRandom(mean, stdDev);
      return Math.round(Math.min(maxMs, Math.max(minMs, val)));
    }
    const randomTurnDurationMs = () => randomGaussianDurationMs(30_000, 210_000);
    const randomPauseDurationMs = () => randomGaussianDurationMs(30_000, 60_000);

    // Always uses every real (non-GM) user the world actually has - not
    // capped at 3 - so the preview reflects the actual campaign roster.
    // Padded up to 3 total with synthetic placeholder players when there
    // aren't enough real ones: `dummy-owner-<Name>` never collides with a
    // real Foundry user id, and ownerName()/getCombatantColor() both
    // know how to resolve it (name straight out of the id, color via a
    // stable hash) - so a 1-player world still gets 2 distinct placeholder
    // people instead of a bare grey "?", but never fakes over a real player.
    function getDummyPlayerSource() {
      const realPlayers = game.users.filter((u) => !u.isGM).map((u) => ({ name: u.name, ownerId: u.id }));
      const needed = Math.max(0, 3 - realPlayers.length);
      const synthetic = ["Aria", "Boro", "Cass"].slice(0, needed).map((name) => ({ name, ownerId: `dummy-owner-${name}` }));
      return [...realPlayers, ...synthetic];
    }

    function generateDummySegments() {
      const players = getDummyPlayerSource();
      const monsters = [
        { name: "Goblin A" },
        { name: "Goblin B" },
        { name: "Ogre" },
      ];
      // Round-robin interleave - works for any player count, not just 3.
      const order = [];
      const maxLen = Math.max(players.length, monsters.length);
      for (let i = 0; i < maxLen; i++) {
        if (players[i]) order.push(players[i]);
        if (monsters[i]) order.push(monsters[i]);
      }

      const out = [];
      let t = Date.now() - 15 * 60 * 1000;
      for (let round = 0; round < 3; round++) {
        for (const [turnIndex, entry] of order.entries()) {
          const isPC = !!entry.ownerId;
          const actorType = isPC ? PC_ACTOR_TYPE : "npc";
          const dur = randomTurnDurationMs();
          out.push(makeSegment({
            start: t, end: t + dur, trigger: "turn",
            combatantId: `dummy-${entry.name}`, combatantName: entry.name,
            round: round + 1, turnIndex, // Foundry rounds are 1-indexed, turn index is 0-indexed
            ownerId: entry.ownerId ?? null, actorType,
            defeated: !isPC && round === 2 && entry.name === "Goblin A",
          }));
          t += dur;
          if (Math.random() < 0.25) {
            const pauseDur = randomPauseDurationMs();
            out.push(makeSegment({
              start: t, end: t + pauseDur, trigger: "pause",
              combatantId: `dummy-${entry.name}`, combatantName: entry.name,
              round: round + 1, turnIndex,
              ownerId: entry.ownerId ?? null, actorType,
              category: !entry.ownerId && Math.random() < 0.5 ? "setup" : "player",
            }));
            t += pauseDur;
          }
        }
      }
      return out;
    }

    function loadDummyData() {
      if (selectedSession !== "current") {
        toast("Switch to the “Now” tab first.");
        return;
      }
      if (segments.length || currentSegment) {
        toast("This session already has data. Start a new session first.");
        return;
      }
      segments = generateDummySegments();
      currentSegment = null;
      persist();
      toast("Dummy data loaded.");
    }

    // Shared by gmTotalStats() and gmRoundStats(): does this segment's time
    // belong to the GM at all - either an unclaimed monster's own turn (the
    // indirect path) or anything explicitly recategorized to "dm" (the
    // direct path, e.g. a player's turn or a pause that was really the GM's
    // time). A DM-direct segment has no combatant by nature - hasCombatContext()
    // only gates the indirect (unclaimed-monster) path.
    function countsForGM(seg, lastLiveOwner) {
      const unclaimedNpcTurn = hasCombatContext(seg) && seg.category === "player" && effectiveOwner(seg, lastLiveOwner) === null;
      return unclaimedNpcTurn || seg.category === "dm";
    }

    // Combined GM total: monster-turn time (not reassigned away) PLUS any
    // segment explicitly recategorized as "dm". byEntity lets buildBarsContent()
    // render the GM bar as a stack of per-monster segments, same as a player's
    // controlled entities. See gmRoundStats() for the GM's per-round average -
    // unlike a player, the GM has no single "own turn" to fence an average by.
    function gmTotalStats() {
      const lastLiveOwner = lastLiveOwnerByCombatant();
      const byEntity = new Map();
      let ms = 0;
      for (const seg of allSegments()) {
        if (!countsForGM(seg, lastLiveOwner)) continue;
        const segDurMs = segMs(seg);
        ms += segDurMs;
        if (!byEntity.has(seg.combatantId)) {
          byEntity.set(seg.combatantId, { combatantId: seg.combatantId, name: seg.combatantName, ms: 0 });
        }
        byEntity.get(seg.combatantId).ms += segDurMs;
      }
      return { totalMs: ms, byEntity: [...byEntity.values()] };
    }

    // The GM's average "per turn" is defined per ROUND, not per individual
    // monster turn - round 1 is "combat start through the end of round 1",
    // round 2 is "end of round 1 through end of round 2", and so on. Unlike
    // a player's turnWindowStats() (which has to compute window boundaries
    // from turn-slot end times, since a player's own turns are scattered
    // through the timeline), every segment already carries the round it was
    // created in (see Segment in AGENTS.md) - rounds are already a
    // contiguous, gapless partition of the whole session, so grouping by
    // that field directly IS the fencing. A round with no GM-attributed time
    // still counts in the denominator (a quiet round still happened), which
    // is why this can't just reuse gmTotalStats()'s totalMs - it also needs
    // to know how many rounds occurred at all, not only which had GM time.
    function gmRoundStats() {
      const lastLiveOwner = lastLiveOwnerByCombatant();
      const rounds = new Set();
      let ms = 0;
      for (const seg of allSegments()) {
        if (seg.round != null) rounds.add(seg.round);
        if (countsForGM(seg, lastLiveOwner)) ms += segMs(seg);
      }
      return { roundCount: rounds.size, avgMs: rounds.size ? ms / rounds.size : 0 };
    }

    // All players worth offering in the reassignment picker: currently in
    // combat, plus anyone already seen in this session (in case they left).
    function getCombatPlayers() {
      const seen = new Map();
      const combat = game.combat;
      if (combat) {
        for (const c of combat.combatants) {
          const ownerId = getOwningPlayerId(c.actor);
          if (!ownerId || seen.has(ownerId)) continue;
          seen.set(ownerId, { ownerId, name: game.users.get(ownerId)?.name ?? c.name, color: getCombatantColor(ownerId) });
        }
      }
      for (const seg of allSegments()) {
        if (seg.ownerId && !seen.has(seg.ownerId)) {
          seen.set(seg.ownerId, { ownerId: seg.ownerId, name: game.users.get(seg.ownerId)?.name ?? seg.combatantName, color: getCombatantColor(seg.ownerId) });
        }
      }
      return [...seen.values()];
    }

    // ---- Chat reports (always self-roll, i.e. whisper to yourself) ----

    // Scales each RGB channel by `factor` (1 = unchanged, <1 = darker).
    // Computed as real hex values rather than a CSS filter, since a filter
    // is easier for an aggressive Foundry/system theme to override, and
    // hard constraint #2 wants every color fully inline and self-contained.
    // Shared by darkenHex() and relLuminance() - parses "#rrggbb" (or
    // "rrggbb") into [r, g, b] ints, or null if it doesn't match.
    function parseHexRgb(hex) {
      const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex ?? "");
      return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
    }

    function darkenHex(hex, factor) {
      const rgb = parseHexRgb(hex);
      if (!rgb) return hex;
      const scale = (c) => Math.round(c * factor).toString(16).padStart(2, "0");
      return `#${rgb.map(scale).join("")}`;
    }

    // Orders a list of per-entity items so the "primary" one (a player's own
    // PC, found via isPrimary) ends up last/rightmost in full color, with
    // every other entity trailing to its left in progressively darker shades
    // of the same base color, in their original (turn-order) sequence. With
    // no primary match (e.g. the GM's monsters), the last item in original
    // order anchors instead, so "rightmost = brightest" holds everywhere.
    function orderAndShade(items, isPrimary) {
      if (!items.length) return [];
      const primaryIdx = items.findIndex(isPrimary);
      const primary = primaryIdx >= 0 ? items[primaryIdx] : items[items.length - 1];
      const ordered = [...items.filter((it) => it !== primary), primary];
      const minShade = 0.45;
      return ordered.map((item, i) => ({
        item,
        shade: ordered.length <= 1 ? 1 : minShade + (1 - minShade) * (i / (ordered.length - 1)),
      }));
    }

    // Caps how many entities a single bar splits into. orderAndShade() spreads
    // shades from 0.45 to 1.0 across however many items it gets - past four or
    // five, neighbouring shades differ by so little that the bar reads as one
    // smear, and minLabelPct suppresses most of the labels anyway. Everything
    // past the cap is merged into a single "+N more" item placed first, so it
    // takes the darkest shade at the far left and the named entities keep the
    // bright end. Sums every numeric field the two callers use.
    function capEntities(items, valueOf, isPrimary, max = MAX_BAR_ENTITIES) {
      if (items.length <= max) return items;
      const primaryIdx = items.findIndex(isPrimary);
      const primary = primaryIdx >= 0 ? items[primaryIdx] : items[items.length - 1];
      const others = items.filter((it) => it !== primary);
      const ranked = [...others].sort((a, b) => valueOf(b) - valueOf(a));
      // max - 2, not max - 1: the merged "+N more" item occupies one of the
      // slices too, and the primary always keeps its own.
      const keep = new Set(ranked.slice(0, Math.max(0, max - 2)));
      const merged = ranked.slice(Math.max(0, max - 2));
      const sum = (field) => merged.reduce((total, it) => total + (it[field] ?? 0), 0);
      const mergedItem = {
        combatantId: "__more__",
        name: `+${merged.length} more`,
        mergedNames: merged.map((it) => it.name), // for the merged slice's tooltip
        actorType: null,
        ms: sum("ms"),
        inTurnMs: sum("inTurnMs"),
        outOfTurnMs: sum("outOfTurnMs"),
        pausedMs: sum("pausedMs"),
        turnCount: sum("turnCount"),
      };
      // Kept entities stay in their original (turn-order) sequence.
      return [mergedItem, ...items.filter((it) => it === primary || keep.has(it))];
    }

    // Renders one row's worth of proportional, colored sub-segments sharing
    // a common parent width. A part's label is only drawn when its own
    // share is wide enough to plausibly fit it - a narrow sliver still
    // contributes its color and proportion, just without forcing illegible
    // text into it (per design: show every part, label only where it fits).
    function proportionalSegmentsHtml(parts, minLabelPct) {
      const total = parts.reduce((sum, p) => sum + p.ms, 0) || 1;
      return parts.filter((p) => p.ms > 0).map((p) => {
        const w = (p.ms / total) * 100;
        // Two-tier label: the name when the segment is wide enough to carry
        // it, the duration when it isn't, nothing when even that won't fit.
        // The color is derived from the fill - segments are shaded down to 45%
        // of the base color, so a single fixed label color is unreadable on
        // roughly half of them.
        const text = (p.label && w >= (p.labelPct ?? minLabelPct)) ? p.label
          : (p.altLabel && w >= minLabelPct) ? p.altLabel
          : "";
        const label = text
          ? `<span style="font-size:8px; font-weight:600; color:${labelColorOn(p.color)} !important; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding:0 2px;">${text}</span>`
          : "";
        return `<div ${p.title ? `title="${escapeHtml(p.title)}"` : ""} style="width:${w}%; height:100%; background:${p.color} !important;
                     box-shadow:inset 0 1px 0 rgba(255,255,255,0.25) !important;
                     display:flex; align-items:center; justify-content:center; overflow:hidden;">${label}</div>`;
      }).join("");
    }

    // Builds the main (solid, per-entity) bar segments and, only when there's
    // something exceptional to show, a slim aligned indicator row splitting
    // each entity's own column into paused / out-of-turn / in-turn. For an
    // ordinary single-entity player with no paused/out-of-turn time this
    // degenerates to exactly today's single solid bar with no indicator row.
    function buildPlayerBarRows(e) {
      const entities = capEntities(e.byEntity, (en) => en.inTurnMs + en.outOfTurnMs, (en) => isPcActorType(en.actorType));
      const ordered = orderAndShade(entities, (en) => isPcActorType(en.actorType))
        .map(({ item, shade }) => ({ item, color: darkenHex(e.color, shade) }));
      const showLabels = ordered.length > 1;
      const personTotalMs = entities.reduce((sum, en) => sum + en.inTurnMs + en.outOfTurnMs, 0) || 1;

      const mainParts = ordered.map(({ item, color }) => ({
        ms: item.inTurnMs + item.outOfTurnMs,
        color,
        // Name where it fits, duration where it doesn't - an unlabelled stack
        // of shades tells the reader nothing about who is in it.
        label: showLabels ? escapeHtml(item.name) : null,
        labelPct: 28,
        altLabel: showLabels ? formatDuration(Math.round((item.inTurnMs + item.outOfTurnMs) / 1000)) : null,
        // The capped "+N more" slice otherwise names nobody it actually swallowed.
        title: item.mergedNames ? item.mergedNames.join(", ") : null,
      }));
      const mainSegs = proportionalSegmentsHtml(mainParts, 12);

      let indicatorRow = "";
      if (e.pausedMs > 0 || e.outOfTurnMs > 0) {
        const cols = ordered.map(({ item, color }) => {
          const entMs = item.inTurnMs + item.outOfTurnMs;
          if (entMs <= 0) return "";
          const colWidth = (entMs / personTotalMs) * 100;
          const pausedMs = Math.min(item.pausedMs, entMs);
          // A segment that's both paused and reassigned out-of-turn would
          // otherwise get counted in both buckets. Paused wins - it describes
          // what the time WAS, while out-of-turn describes who it's charged
          // to - so the overlap is drawn from the out-of-turn bucket first.
          const outOfTurnMs = Math.max(0, item.outOfTurnMs - pausedMs);
          const inTurnPlainMs = Math.max(0, entMs - pausedMs - outOfTurnMs);
          const parts = proportionalSegmentsHtml([
            { ms: pausedMs, color: "#e8a33d" }, // fixed, entity-independent - means "paused" everywhere in the report
            { ms: outOfTurnMs, color: "#4fc3d9" }, // fixed, entity-independent - means "out-of-turn" everywhere
            { ms: inTurnPlainMs, color },
          ], Infinity); // never label the indicator row - it's a proportion signal, not a number to read
          return `<div style="width:${colWidth}%; height:100%; display:flex;">${parts}</div>`;
        }).join("");
        indicatorRow = `<div style="display:flex; height:4px; margin-top:1px; border-radius:0 0 4px 4px; overflow:hidden;">${cols}</div>`;
      }

      return { mainSegs, indicatorRow };
    }

    // Same idea as buildPlayerBarRows() but for the combined GM/Monsters bar
    // - one segment per contributing combatant, no indicator row (the GM
    // bucket doesn't track paused/out-of-turn time the way a player does).
    function buildGmBarSegments(gm, gmColor) {
      const entities = capEntities(gm.byEntity, (en) => en.ms, () => false);
      const ordered = orderAndShade(entities, () => false)
        .map(({ item, shade }) => ({ item, color: darkenHex(gmColor, shade) }));
      const showLabels = ordered.length > 1;
      const parts = ordered.map(({ item, color }) => ({
        ms: item.ms,
        color,
        label: showLabels ? escapeHtml(item.name) : null,
        labelPct: 28,
        altLabel: showLabels ? formatDuration(Math.round(item.ms / 1000)) : null,
        title: item.mergedNames ? item.mergedNames.join(", ") : null,
      }));
      return proportionalSegmentsHtml(parts, 12);
    }

    // Shared card chrome (see hard constraint #2) - the single place the
    // inline-!important styling has to be kept correct, instead of two.
    function wrapCard({ title, subtitle, body }) {
      return `
        <div style="font-family:Signika,sans-serif; font-size:13px; color:#eee !important;
             background:linear-gradient(160deg,#2a2a35,#1b1b22) !important; border:1px solid #45414f !important;
             border-radius:8px; padding:10px 12px;">
          <div style="font-weight:700; letter-spacing:0.3px; margin-bottom:6px; color:#eee !important; display:flex; justify-content:space-between; align-items:baseline;">
            <span>${title}</span>
            <span style="opacity:0.7; font-weight:400; font-size:11px;">${subtitle}</span>
          </div>
          ${body || `<div style="opacity:0.6; color:#eee !important;">No data</div>`}
        </div>`;
    }

    function buildBarsContent() {
      // Same entry list the panel summary uses, so the two can never disagree
      // about who is in the session.
      const entries = summaryEntries();
      const max = Math.max(1, ...entries.map((e) => e.totalMs));
      const sessionMs = sessionTotalMs();
      // Player averages come from turnWindowStats() - it fences each
      // player's own out-of-turn credit into the turn-cycle it fell in, so
      // the average always multiplies back out to exactly their total. The
      // GM's average is per ROUND instead (gmRoundStats()) - the GM has no
      // single "own turn" the way a player does, so "combat start through
      // end of round 1", "end of round 1 through end of round 2", etc. is
      // the unit that makes sense there. Both are exact partitions of the
      // relevant total, so neither ever needs an "in-turn only" caveat.
      const turnWindows = turnWindowStats();
      const gmRounds = gmRoundStats();
      let anyIndicator = false;

      const bars = entries.map((e) => {
        const s = Math.round(e.totalMs / 1000);
        const pct = Math.max(4, Math.round((e.totalMs / max) * 100));
        const ofTotal = sessionMs > 0 ? ` · ${Math.round((e.totalMs / sessionMs) * 100)}%` : "";
        const tw = e.kind === "player" ? turnWindows.get(e.id) : null;
        let avg = "";
        if (tw && tw.windows.length) {
          // turnWindowStats() fences on this player's own consecutive turns,
          // which in ordinary play (one turn per combatant per round) lines
          // up with the actual combat round - "/round" here, matching the
          // GM's label, without changing what's being computed.
          avg = ` · Ø ${formatDuration(Math.round(tw.avgMs / 1000))}/round`;
        } else if (e.kind === "gm" && gmRounds.roundCount > 0) {
          avg = ` · Ø ${formatDuration(Math.round(gmRounds.avgMs / 1000))}/round`;
        }

        let fillInner, indicatorRow = "";
        if (e.kind === "player") {
          const built = buildPlayerBarRows(e);
          fillInner = built.mainSegs;
          indicatorRow = built.indicatorRow;
          if (indicatorRow) anyIndicator = true;
        } else if (e.kind === "gm") {
          fillInner = buildGmBarSegments(e, e.color);
        } else {
          fillInner = `<div style="width:100%; height:100%; background:${e.color} !important;
                             box-shadow:inset 0 1px 0 rgba(255,255,255,0.25) !important;"></div>`;
        }

        return `
          <div style="margin:6px 0;">
            <div style="display:flex; justify-content:space-between; gap:6px; font-size:11px; margin-bottom:2px; color:#eee !important;">
              <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#eee !important;">${e.icon} ${escapeHtml(e.name)}</span>
              <span style="flex-shrink:0; opacity:0.85; color:#eee !important;">${formatDuration(s)}${ofTotal}${avg}</span>
            </div>
            <div style="background:rgba(255,255,255,0.08) !important; border-radius:4px; height:9px; overflow:hidden;">
              <div style="width:${pct}%; height:100%; display:flex;">${fillInner}</div>
            </div>
            ${indicatorRow ? `<div style="width:${pct}%;">${indicatorRow}</div>` : ""}
          </div>`;
      }).join("");

      // The indicator row's two fixed colors are meaningless to anyone who
      // hasn't read the README - and after "Reveal to Everyone", that's most
      // people who see this. Only rendered when a row actually exists.
      const swatch = (color) => `<span style="display:inline-block; width:7px; height:7px; border-radius:2px;
             background:${color} !important; vertical-align:middle; margin-right:3px;"></span>`;
      const legend = anyIndicator
        ? `<div style="font-size:9px; opacity:0.5; margin-top:8px; color:#eee !important;">
             Thin row: ${swatch("#e8a33d")}paused · ${swatch("#4fc3d9")}out of turn
           </div>`
        : "";

      return wrapCard({
        title: "⚔️ Combat Times",
        subtitle: `Total ${formatDuration(Math.round(sessionTotalMs() / 1000))}`,
        body: bars + legend,
      });
    }

    function buildPlayerListContent() {
      const gaps = betweenTurnStats();
      const waits = absoluteWaitStats();
      const turnWindows = turnWindowStats();
      const rows = perCombatantStats()
        .sort((a, b) => b.totalMs - a.totalMs)
        .map((e) => {
          const tw = turnWindows.get(e.id);
          const avgTurn = tw && tw.windows.length ? Math.round(tw.avgMs / 1000) : 0;
          const turnCountTag = e.turnCount ? ` (${e.turnCount}×)` : "";
          const g = gaps.get(e.id);
          const avgGap = g && g.count ? `Ø ${formatDuration(Math.round(g.avgMs / 1000))}` : "–";
          const waitMs = waits.get(e.id) ?? 0;
          return `
            <div style="margin:8px 0;">
              <div style="display:flex; align-items:center; gap:6px; font-weight:600; color:#eee !important;">
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${e.color} !important; flex-shrink:0;"></span>
                <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#eee !important;">${escapeHtml(e.name)}</span>
              </div>
              <div style="display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; font-size:10px; opacity:0.8; margin-top:2px; padding-left:14px; color:#eee !important;">
                <span style="color:#eee !important;">Turn: Ø ${formatDuration(avgTurn)}${turnCountTag}</span>
                <span style="color:#eee !important;">Gap: ${avgGap}</span>
                <span style="color:#eee !important;">Wait: ${formatDuration(Math.round(waitMs / 1000))}</span>
              </div>
            </div>`;
        }).join("");

      const legend = rows
        ? `<div style="font-size:9px; opacity:0.45; margin-top:6px; color:#eee !important;">Ø turn length · Ø gap between PC turns · total time waiting</div>`
        : "";

      return wrapCard({
        title: "🧑 Player Overview",
        subtitle: `Total ${formatDuration(Math.round(sessionTotalMs() / 1000))}`,
        body: rows + legend,
      });
    }

    // Acts on whichever session is CURRENTLY DISPLAYED. For "current" this
    // archives (not discards) and starts fresh; for archived sessions it's a
    // real, permanent delete.
    function deleteSelectedSession() {
      if (selectedSession === "current") {
        confirmBar("Start a new session? The current one is archived, not lost.", "Start", () => {
          archiveSessionIfNeeded();
          reconcileWithLiveState();
          persist();
          toast("New session started. The old one is under “Prev”.");
          renderPanel();
        });
        return;
      }
      const idx = selectedSession === "prev1" ? 0 : 1;
      if (!sessionHistory[idx]) return;
      confirmBar("Delete this archived session? No undo.", "Delete", () => {
        sessionHistory.splice(idx, 1);
        selectedSession = "current";
        persist();
        toast("Archived session deleted.");
        renderPanel();
      });
    }

    // Exports only the currently VIEWED session (whichever tab is selected),
    // not the full ring buffer - matches "what you're looking at" rather than
    // requiring a full-state restore just to move one session elsewhere.
    function exportSelectedSession() {
      const { segs, current } = getSelectedSessionData();
      const idx = selectedSession === "prev1" ? 0 : selectedSession === "prev2" ? 1 : null;
      const payload = {
        v: 1, // matches the schema version persist() writes - see makeSegment()
        exportedAt: Date.now(),
        world: game.world?.id ?? null,
        session: selectedSession, // "current" | "prev1" | "prev2" - informational, doesn't constrain re-import
        endedAt: idx !== null ? (sessionHistory[idx]?.endedAt ?? null) : null,
        segments: segs,
        currentSegment: current,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `combat-timer-${game.world?.id ?? "world"}-${selectedSession}-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    // Replaces whichever session is currently viewed with the imported file's
    // data outright - no archiving of what was there before, matching export
    // being scoped to "just the viewed session" rather than the full state.
    function importSessionFromFile(file) {
      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = JSON.parse(reader.result);
        } catch (e) {
          toast("That file isn't valid JSON.");
          return;
        }
        if (!Array.isArray(parsed.segments)) {
          toast("That file isn't Combat Timer session data.");
          return;
        }
        const label = selectedSession === "current" ? "Now" : selectedSession === "prev1" ? "Prev" : "Older";
        confirmBar(`Replace the “${label}” tab with this file?`, "Replace", () => {
          // One-level snapshot taken immediately before the overwrite. Import
          // still replaces outright (no archiving), but the thing it replaced
          // is now recoverable for as long as the panel stays open.
          importUndo = selectedSession === "current"
            ? { session: "current", segments: [...segments], currentSegment }
            : { session: selectedSession, entry: sessionHistory[selectedSession === "prev1" ? 0 : 1] ?? null };

          // Imported data is assumed to already be in the current segment
          // shape (this script only supports data it wrote itself) - no
          // backfilling for fields from an older script version.
          const importedSegments = parsed.segments;
          const importedCurrent = parsed.currentSegment ?? null;

          if (selectedSession === "current") {
            segments = importedSegments;
            currentSegment = importedCurrent;
            reconcileWithLiveState(); // imported data may not match what's actually live right now
          } else {
            const idx = selectedSession === "prev1" ? 0 : 1;
            sessionHistory[idx] = { segments: importedSegments, endedAt: parsed.endedAt ?? Date.now() };
          }
          persist();
          renderPanel();
          toast(`Imported into “${label}”.`, "Undo", () => undoImport());
        });
      };
      reader.readAsText(file);
    }

    // Restores whatever the last import overwrote. Only one level deep and
    // only for this page session - it's a safety net for a misclick, not a
    // history feature.
    function undoImport() {
      if (!importUndo) return;
      if (importUndo.session === "current") {
        segments = importUndo.segments;
        currentSegment = importUndo.currentSegment;
        reconcileWithLiveState();
      } else {
        const idx = importUndo.session === "prev1" ? 0 : 1;
        if (importUndo.entry) sessionHistory[idx] = importUndo.entry;
        else sessionHistory.splice(idx, 1);
      }
      importUndo = null;
      persist();
      toast("Import undone.");
      renderPanel();
    }

    async function postToChat(content, kind) {
      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ alias: "Combat Timer" }),
        whisper: [game.user.id],
        flags: { "combat-timer": { kind, session: selectedSession, at: Date.now() } },
      });
    }

    // ---- Panel UI state ----------------------------------------------------
    // Everything below is pure presentation state. None of it is part of the
    // tracked data, and none of it is stored in the tracking blob - it lives
    // under its own localStorage key so a corrupt/absent UI state can never
    // take session data down with it.
    function uiStorageKey() {
      return `ctp-ui-${game.world?.id ?? "default"}-${game.user?.id ?? "default"}`;
    }
    const UI_DEFAULTS = { left: null, top: 60, segHeight: 240, summaryOpen: false };
    let ui = { ...UI_DEFAULTS };
    try {
      const savedUi = JSON.parse(localStorage.getItem(uiStorageKey()) ?? "null");
      if (savedUi && typeof savedUi === "object") ui = { ...UI_DEFAULTS, ...savedUi };
    } catch (e) {
      console.warn("Combat Timer: could not load panel layout", e);
    }
    function persistUi() {
      try {
        localStorage.setItem(uiStorageKey(), JSON.stringify(ui));
      } catch (e) {
        console.warn("Combat Timer: could not save panel layout", e);
      }
    }

    const PANEL_WIDTH = 300;
    const MAX_BAR_ENTITIES = 4; // per-entity stack cap in the chat bar chart
    const SEG_HEIGHT_MIN = 120;
    const SEG_HEIGHT_MAX = 700;

    let segFilter = "all";              // "all" | "setup" | "reassigned" | "long"
    let expandedGroups = new Set();     // turn-slot keys (opening segment id) currently expanded
    let liveGroupsSeeded = new Set();   // live-group keys already given their one-time default-expanded seed
    let openCatSegId = null;            // which segment has its category picker open
    let menuOpen = false;               // the ⋯ overflow menu
    let postMenuOpen = false;           // the "Post report" dropdown
    let importUndo = null;              // one-level undo snapshot taken right before an import
    let lastSegSig = null;              // see renderSegments(): skips the rebuild when nothing changed
    let toastTimer = null;
    let dragState = null;
    let resizeState = null;
    // Declared here rather than at the `buildPanel()` call site: buildPanel()
    // assigns to it while running (applyPanelPosition() has to measure the real
    // element), which would hit the temporal dead zone if the binding were
    // created by that same call's initializer.
    let panel = null;

    // ---- Small shared helpers ----------------------------------------------
    // 24h regardless of locale: the column is ~40px wide and a locale that
    // renders "09:30 PM" pushes the name column into an ellipsis.
    function formatClock(ts) {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    // WCAG relative luminance, used to decide whether a label drawn ON a fill
    // should be dark or light. The bar segments are shaded down to 45% of the
    // base color, so a single hardcoded label color is unreadable on roughly
    // half of them.
    function relLuminance(hex) {
      const rgb = parseHexRgb(hex);
      if (!rgb) return 0.5;
      const lin = rgb.map((c8) => {
        const c = c8 / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    }
    function labelColorOn(hex) {
      return relLuminance(hex) > 0.3 ? "rgba(0,0,0,0.62)" : "rgba(255,255,255,0.85)";
    }
    // Same "unresolvable id" problem as getCombatantColor(): a
    // dummy-data id carries its own name right in the id (see
    // getDummyPlayerSource()) and is resolved back out of it here; anything
    // else unresolvable (an imported session's owner who isn't in this
    // world's roster) gets a short, stable placeholder instead of a bare "?".
    function ownerName(id) {
      if (!id) return null;
      const real = game.users.get(id)?.name;
      if (real) return real;
      const dummy = /^dummy-owner-(.+)$/.exec(id);
      if (dummy) return dummy[1];
      return `Player ${id.slice(0, 4)}`;
    }
    function pct(part, whole) {
      return whole > 0 ? Math.round((part / whole) * 100) : 0;
    }

    // ---- Panel chrome -------------------------------------------------------
    function openPanel() {
      const reopenBtn = document.getElementById("ctp-reopen");
      if (reopenBtn) reopenBtn.remove();
      if (!document.body.contains(panel)) panel = buildPanel();
      panelVisible = true;
      lastSegSig = null; // freshly built DOM - force a full segment render
    }
    function closePanel() {
      if (document.body.contains(panel)) panel.remove();
      panelVisible = false;
      buildReopenButton();
    }

    // Keeps the panel inside the viewport. Called on load (the window may have
    // been resized, or the panel dragged on a much wider screen last session)
    // and on every drag move, so it can never end up somewhere unreachable.
    function clampPanelPosition(left, top) {
      const w = panel?.offsetWidth || PANEL_WIDTH;
      const h = panel?.offsetHeight || 200;
      const maxLeft = Math.max(0, window.innerWidth - w);
      const maxTop = Math.max(0, window.innerHeight - Math.min(h, 120)); // keep at least the header reachable
      return {
        left: Math.min(Math.max(0, left), maxLeft),
        top: Math.min(Math.max(0, top), maxTop),
      };
    }

    // Caps the resizable segment list against the *measured* chrome height
    // (everything else in the panel) rather than the flat SEG_HEIGHT_MAX
    // constant, so the panel's total height can never exceed the viewport -
    // otherwise #ctp-toast, the last element in the panel, renders past
    // window.innerHeight and becomes unreachable.
    function maxSegHeight() {
      const segEl = panel?.querySelector("#ctp-segments");
      if (!panel || !segEl) return SEG_HEIGHT_MAX;
      const top = panel.getBoundingClientRect().top;
      const chromeHeight = panel.offsetHeight - segEl.offsetHeight;
      const available = window.innerHeight - top - chromeHeight - 8;
      return Math.max(SEG_HEIGHT_MIN, Math.min(SEG_HEIGHT_MAX, Math.floor(available)));
    }

    function applyPanelPosition() {
      if (ui.left === null || ui.left === undefined) {
        panel.style.right = "16px";
        panel.style.left = "auto";
        panel.style.top = `${ui.top ?? 60}px`;
        return;
      }
      const { left, top } = clampPanelPosition(ui.left, ui.top ?? 60);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
    }

    // Re-clamps position and segment-list height against the current
    // viewport - called on load and on window resize, so a panel sized/moved
    // on a larger screen (or before the browser window shrank) can't leave
    // the confirm/undo bar unreachable.
    function reclampForViewport() {
      if (!panel || !document.body.contains(panel)) return;
      applyPanelPosition();
      const cap = maxSegHeight();
      if (ui.segHeight > cap) {
        ui.segHeight = cap;
        panel.querySelector("#ctp-segments").style.height = `${ui.segHeight}px`;
        persistUi();
      }
    }

    // ---- Toast / inline confirm --------------------------------------------
    // Replaces alert()/confirm(). A browser dialog steals focus from Foundry
    // (which listens for keybinds globally) and looks nothing like the panel;
    // both of these render inside it and dismiss themselves.
    function toast(message, actionLabel = null, onAction = null) {
      const el = panel?.querySelector("#ctp-toast");
      if (!el) return;
      if (toastTimer) clearTimeout(toastTimer);
      el.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="flex:1;">${escapeHtml(message)}</span>
          ${actionLabel ? `<span data-toast-action style="cursor:pointer; padding:2px 8px; border-radius:5px; border:1px solid #4a4a58;">${escapeHtml(actionLabel)}</span>` : ""}
        </div>`;
      el.style.display = "block";
      if (actionLabel && onAction) {
        el.querySelector("[data-toast-action]").addEventListener("click", () => {
          hideToast();
          onAction();
        });
      }
      toastTimer = setTimeout(hideToast, actionLabel ? 9000 : 3500);
    }
    function hideToast() {
      const el = panel?.querySelector("#ctp-toast");
      if (!el) return;
      el.style.display = "none";
      el.innerHTML = "";
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = null;
    }
    // Destructive actions get a two-button bar in the same slot instead of a
    // native confirm(), so the panel never loses focus mid-combat.
    function confirmBar(message, confirmLabel, onConfirm) {
      const el = panel?.querySelector("#ctp-toast");
      if (!el) return;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = null;
      el.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="flex:1;">${escapeHtml(message)}</span>
          <span data-confirm-no style="cursor:pointer; padding:2px 8px; border-radius:5px; border:1px solid #4a4a58;">Cancel</span>
          <span data-confirm-yes style="cursor:pointer; padding:2px 8px; border-radius:5px; background:#8c3b3b; color:#fff;">${escapeHtml(confirmLabel)}</span>
        </div>`;
      el.style.display = "block";
      el.querySelector("[data-confirm-no]").addEventListener("click", () => hideToast());
      el.querySelector("[data-confirm-yes]").addEventListener("click", () => {
        hideToast();
        onConfirm();
      });
    }

    // ---- Panel construction -------------------------------------------------
    // This MUST succeed no matter what - it is the first thing init() does that
    // can possibly fail, so nothing experimental is allowed to run before it.
    // Section order follows the reading order: what scopes the view (tabs) is
    // above what it scopes, and the segment list - the only editable surface -
    // gets the largest, resizable share of the height.
    function buildPanel() {
      const el = document.createElement("div");
      el.id = "combat-timer-panel";
      el.style.cssText = `
        position: fixed; top: 60px; right: 16px; z-index: 9999;
        width: ${PANEL_WIDTH}px; font-family: "Signika", sans-serif; font-size: 12px;
        background: #17171d;
        border: 1px solid #3a3a46; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: #ddd; overflow: hidden;
      `;

      el.innerHTML = `
        <div id="ctp-header" style="cursor:move; padding:7px 10px; background:#2a2a35;
             display:flex; justify-content:space-between; align-items:center; user-select:none;">
          <span style="font-weight:600; letter-spacing:0.3px;">⚔️ Combat Times</span>
          <span style="display:flex; gap:2px;">
            <span id="ctp-menu-btn" title="More actions" style="cursor:pointer; opacity:0.6; padding:0 5px; border-radius:4px;">⋯</span>
            <span id="ctp-close" title="Hide the panel" style="cursor:pointer; opacity:0.6; padding:0 5px; border-radius:4px;">✕</span>
          </span>
        </div>

        <div id="ctp-menu" style="display:none; background:#20202a; border-bottom:1px solid #3a3a46; padding:4px;"></div>

        <div id="ctp-tabs" style="display:flex; gap:4px; padding:6px 8px; background:#20202a;
             border-bottom:1px solid #3a3a46; font-size:11px;"></div>

        <div id="ctp-live" style="padding:8px 10px; border-bottom:1px solid #2c2c36;"></div>

        <div id="ctp-summary" style="padding:8px 10px; border-bottom:1px solid #2c2c36;"></div>

        <div id="ctp-filters" style="display:flex; gap:5px; align-items:center; padding:6px 10px;
             font-size:10px; border-bottom:1px solid #2c2c36;"></div>

        <div id="ctp-segments" style="overflow-y:auto; overflow-x:hidden;"></div>

        <div id="ctp-resize" title="Drag to resize the segment list"
             style="height:9px; cursor:ns-resize; display:flex; align-items:center; justify-content:center;
                    border-top:1px solid #2c2c36; user-select:none;">
          <span style="width:26px; height:2px; border-radius:1px; background:#4a4a58;"></span>
        </div>

        <div id="ctp-post-menu" style="display:none; padding:4px 8px 0;"></div>

        <div style="padding:7px 10px;">
          <button id="ctp-post" style="width:100%; padding:6px; border:none; border-radius:6px;
                  background:#4b3fa0; color:#fff; cursor:pointer; font-size:11px;">
            📊 Post report ▾
          </button>
        </div>

        <div id="ctp-toast" style="display:none; padding:6px 10px; font-size:11px;
             background:#20202a; border-top:1px solid #3a3a46;"></div>

        <input type="file" id="ctp-import-file" accept="application/json" style="display:none;">
      `;
      document.body.appendChild(el);
      panel = el; // applyPanelPosition() measures the real element

      el.querySelector("#ctp-close").addEventListener("click", () => closePanel());
      el.querySelector("#ctp-menu-btn").addEventListener("click", () => {
        menuOpen = !menuOpen;
        postMenuOpen = false;
        renderPanel();
      });
      el.querySelector("#ctp-post").addEventListener("click", () => {
        postMenuOpen = !postMenuOpen;
        menuOpen = false;
        renderPanel();
      });
      el.querySelector("#ctp-import-file").addEventListener("change", (ev) => {
        const file = ev.target.files[0];
        ev.target.value = ""; // allow re-selecting the same file later
        if (file) importSessionFromFile(file);
      });

      // Drag: pointer events (so it keeps tracking outside the window), the
      // position is clamped into the viewport and persisted, and text
      // selection is suppressed for the duration - dragging over Foundry's UI
      // used to select whatever was underneath.
      const header = el.querySelector("#ctp-header");
      header.addEventListener("pointerdown", (ev) => {
        if (ev.target.closest("#ctp-menu-btn, #ctp-close")) return;
        const rect = el.getBoundingClientRect();
        dragState = { dx: ev.clientX - rect.left, dy: ev.clientY - rect.top, moved: false };
        header.setPointerCapture(ev.pointerId);
        document.body.style.userSelect = "none";
      });
      header.addEventListener("pointermove", (ev) => {
        if (!dragState) return;
        dragState.moved = true;
        const { left, top } = clampPanelPosition(ev.clientX - dragState.dx, ev.clientY - dragState.dy);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = "auto";
      });
      const endDrag = () => {
        if (!dragState) return;
        const { moved } = dragState;
        dragState = null;
        document.body.style.userSelect = "";
        if (!moved) return; // a plain click, not a drag - don't commit a position from unmoved "auto" styles
        const left = parseInt(el.style.left, 10);
        const top = parseInt(el.style.top, 10);
        if (Number.isFinite(left)) ui.left = left;
        if (Number.isFinite(top)) ui.top = top;
        persistUi();
      };
      header.addEventListener("pointerup", endDrag);
      header.addEventListener("pointercancel", endDrag);

      // Resize: same pattern, adjusting the segment pane's height only.
      const resizer = el.querySelector("#ctp-resize");
      resizer.addEventListener("pointerdown", (ev) => {
        resizeState = { startY: ev.clientY, startH: ui.segHeight };
        resizer.setPointerCapture(ev.pointerId);
        document.body.style.userSelect = "none";
      });
      resizer.addEventListener("pointermove", (ev) => {
        if (!resizeState) return;
        const next = resizeState.startH + (ev.clientY - resizeState.startY);
        ui.segHeight = Math.min(maxSegHeight(), Math.max(SEG_HEIGHT_MIN, Math.round(next)));
        el.querySelector("#ctp-segments").style.height = `${ui.segHeight}px`;
      });
      const endResize = () => {
        if (!resizeState) return;
        resizeState = null;
        document.body.style.userSelect = "";
        persistUi();
      };
      resizer.addEventListener("pointerup", endResize);
      resizer.addEventListener("pointercancel", endResize);

      el.querySelector("#ctp-segments").style.height = `${ui.segHeight}px`;
      reclampForViewport();
      return el;
    }

    function injectPanelStyles() {
      if (document.getElementById("ctp-styles")) return;
      const style = document.createElement("style");
      style.id = "ctp-styles";
      style.textContent = `
        #combat-timer-panel [data-hover] {
          transition: background 0.12s ease, opacity 0.12s ease, filter 0.12s ease;
        }
        #combat-timer-panel [data-hover]:hover {
          opacity: 1 !important;
          background: rgba(255,255,255,0.12);
        }
        #combat-timer-panel #ctp-menu-btn:hover,
        #combat-timer-panel #ctp-close:hover {
          opacity: 1 !important;
          background: rgba(255,255,255,0.14);
        }
        #combat-timer-panel #ctp-resize:hover span {
          background: #6a6a7c;
        }
        #combat-timer-panel #ctp-post:hover,
        #ctp-reopen:hover {
          filter: brightness(1.15);
        }
        #combat-timer-panel [data-group-row]:hover {
          background: rgba(255,255,255,0.05);
        }
        #combat-timer-panel #ctp-segments::-webkit-scrollbar { width: 8px; }
        #combat-timer-panel #ctp-segments::-webkit-scrollbar-thumb {
          background: #3a3a46; border-radius: 4px;
        }
      `;
      document.head.appendChild(style);
    }

    function buildReopenButton() {
      if (document.getElementById("ctp-reopen")) return;
      const btn = document.createElement("div");
      btn.id = "ctp-reopen";
      btn.textContent = "⚔️";
      btn.style.cssText = `
        position: fixed; left: 12px; top: 50%; transform: translateY(-50%); z-index: 9999;
        width: 34px; height: 34px; border-radius: 50%; background: #2a2a35;
        border: 1px solid #3a3a46; display:flex; align-items:center; justify-content:center;
        cursor:pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      `;
      btn.addEventListener("click", () => openPanel());
      document.body.appendChild(btn);
    }

    panel = buildPanel();
    injectPanelStyles();

    // Note: a scene-controls toolbar button was attempted and abandoned.
    // getSceneControlButtons fires exactly once, very early during Foundry's
    // own boot sequence - before a @run-at document-idle Tampermonkey script
    // can possibly attach a listener - and ui.controls.render() does not
    // re-invoke it afterward. The floating ⚔️ reopen button is therefore the
    // only entry point back into the panel once closed.

    // ---- Section renderers ---------------------------------------------------

    function renderMenu() {
      const el = panel.querySelector("#ctp-menu");
      el.style.display = menuOpen ? "block" : "none";
      if (!menuOpen) return;
      const archived = selectedSession !== "current";
      const items = [
        { key: "new", label: "🆕 Start a new session", hint: "archives the current one" },
        ...(archived ? [{ key: "delete", label: "🗑️ Delete this archived session", hint: "permanent", danger: true }] : []),
        { key: "export", label: "📤 Export this session" },
        { key: "import", label: "📥 Import into this session" },
        ...(importUndo ? [{ key: "undo", label: "↩ Undo last import" }] : []),
        { key: "dummy", label: "🧪 Load dummy data", hint: "only if empty" },
        { key: "resetpos", label: "📍 Reset panel position" },
      ];
      el.innerHTML = items.map((it) => `
        <div data-menu="${it.key}" data-hover style="cursor:pointer; padding:5px 7px; border-radius:5px;
             display:flex; justify-content:space-between; gap:8px; align-items:baseline;
             ${it.danger ? "color:#e79a9a;" : ""}">
          <span>${it.label}</span>
          ${it.hint ? `<span style="opacity:0.45; font-size:10px;">${it.hint}</span>` : ""}
        </div>`).join("");

      el.querySelectorAll("[data-menu]").forEach((node) => {
        node.addEventListener("click", () => {
          const action = node.dataset.menu;
          menuOpen = false;
          if (action === "new" || action === "delete") deleteSelectedSession();
          else if (action === "export") exportSelectedSession();
          else if (action === "import") panel.querySelector("#ctp-import-file").click();
          else if (action === "undo") undoImport();
          else if (action === "dummy") loadDummyData();
          else if (action === "resetpos") {
            ui.left = null;
            ui.top = 60;
            persistUi();
            applyPanelPosition();
          }
          renderPanel();
        });
      });
    }

    function renderTabs() {
      const el = panel.querySelector("#ctp-tabs");
      // "hasData" only dims a tab - an empty archived slot must stay clickable,
      // since selecting it is the only way to import data into it.
      const tabs = [
        { key: "current", label: "Now", hasData: true },
        { key: "prev1", label: "Prev", hasData: !!sessionHistory[0] },
        { key: "prev2", label: "Older", hasData: !!sessionHistory[1] },
      ];
      el.innerHTML = tabs.map((t) => `
        <span data-session="${t.key}" ${selectedSession === t.key ? "" : "data-hover"}
          style="flex:1; text-align:center; padding:4px 2px; border-radius:5px; cursor:pointer;
                 ${selectedSession === t.key ? "background:#4b3fa0;" : ""}
                 opacity:${selectedSession === t.key ? "1" : (t.hasData ? "0.6" : "0.35")};">${t.label}</span>`).join("");
      el.querySelectorAll("[data-session]").forEach((node) => {
        node.addEventListener("click", () => {
          selectedSession = node.dataset.session;
          openCatSegId = null;
          playerPickerSegId = null;
          expandedGroups = new Set();
          liveGroupsSeeded = new Set();
          renderPanel();
        });
      });
    }

    function renderLive() {
      const el = panel.querySelector("#ctp-live");
      const sessionMs = sessionTotalMs();
      const totalLine = `<span>${formatDuration(Math.round(sessionMs / 1000))} total</span>`;

      if (selectedSession !== "current") {
        const hist = sessionHistory[selectedSession === "prev1" ? 0 : 1];
        el.innerHTML = hist
          ? `<div style="display:flex; justify-content:space-between; font-size:11px; opacity:0.65;">
               <span>📦 Archived · ended ${formatClock(hist.endedAt)}</span>${totalLine}
             </div>
             <div style="font-size:11px; opacity:0.5; margin-top:5px;">Read-only view. Tracking continues on “Now”.</div>`
          : `<div style="font-size:11px; opacity:0.65;">📦 Nothing in this slot yet</div>
             <div style="font-size:11px; opacity:0.5; margin-top:5px;">Import a session file here, or it fills itself the next time a session archives.</div>`;
        return;
      }

      const combat = game.combat;
      const turnCount = combat?.turns?.length ?? 0;
      const where = combat
        ? `Round ${combat.round ?? "–"}${turnCount ? ` · turn ${(combat.turn ?? 0) + 1} of ${turnCount}` : ""}`
        : "No active combat";
      const paused = game.paused ? ` <span style="color:#e8a33d;">⏸ paused</span>` : "";

      let body = `<div style="font-size:11px; opacity:0.5; margin-top:6px;">Nothing is being tracked right now.</div>`;
      if (currentSegment) {
        const owner = resolvedOwner(currentSegment);
        const color = isPlayerControlled(currentSegment) ? getCombatantColor(owner) : getCombatantColor(null);
        const who = ownerName(owner);
        body = `
          <div style="display:flex; align-items:center; gap:8px; margin-top:6px;">
            <span style="width:9px; height:9px; border-radius:50%; background:${color}; flex-shrink:0;"></span>
            <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;">
              ${escapeHtml(currentSegment.combatantName)}${who ? ` <span style="opacity:0.55; font-weight:400;">${escapeHtml(who)}</span>` : ""}
            </span>
            <span id="ctp-live-dur" style="font-variant-numeric:tabular-nums;">${formatDuration(Math.round(segMs(currentSegment) / 1000))}</span>
            <span id="ctp-split" data-hover title="Split the running segment right now"
                  style="cursor:pointer; padding:4px 8px; border-radius:5px; border:1px solid #4a4a58; white-space:nowrap;">✂️ Split</span>
          </div>`;
      }

      el.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; font-size:11px; opacity:0.65;">
          <span>${where}${paused}</span>${totalLine}
        </div>
        ${body}`;

      const splitBtn = el.querySelector("#ctp-split");
      if (splitBtn) {
        splitBtn.addEventListener("click", () => {
          splitCurrentSegment();
          toast("Segment split. The new one starts now.");
          renderPanel();
        });
      }
    }

    // Every entry that appears in a total, in one place: players, the combined
    // GM bucket, and the Team/Setup categories when they have any time at all.
    // Shared by the panel summary and the chat bar chart so the two can never
    // disagree about who is in the session.
    function summaryEntries() {
      const entries = perCombatantStats().map((e) => ({ ...e, icon: "🧑", kind: "player" }));
      const gm = gmTotalStats();
      const cat = categoryTotals();
      if (gm.totalMs > 0) {
        // No turnCount/inTurnMs here - buildBarsContent() gets the GM's
        // per-round average from gmRoundStats() instead, since the GM has
        // no single "own turn" the way a player does.
        entries.push({ id: "gm-total", name: "GM", icon: "🎲", color: getCombatantColor(null), totalMs: gm.totalMs, byEntity: gm.byEntity, kind: "gm" });
      }
      if (cat.teamMs > 0) {
        entries.push({ id: "team-total", name: "Team", icon: "👥", color: TEAM_COLOR, totalMs: cat.teamMs, kind: "flat" });
      }
      if (cat.setupMs > 0) {
        entries.push({ id: "setup-total", name: "Setup", icon: "🛠️", color: SETUP_COLOR, totalMs: cat.setupMs, kind: "flat" });
      }
      entries.sort((a, b) => b.totalMs - a.totalMs);
      return entries;
    }

    // Collapsed: one proportion strip answering "was this fight lopsided", plus
    // the three biggest by name. Expanded: a labelled mini-bar per entry. The
    // strip deliberately does not try to identify anyone - every slice carries
    // a title tooltip, and the expanded state is the labelled view.
    function renderSummary() {
      const el = panel.querySelector("#ctp-summary");
      const entries = summaryEntries();
      if (!entries.length) {
        el.innerHTML = `<div style="font-size:11px; opacity:0.5;">No tracked time yet.</div>`;
        return;
      }
      // Shared denominator with the chat report's bars (sessionTotalMs(), not
      // the sum of entries) - leftover time (a segment with no active
      // combatant, e.g. pre-combat setup) isn't in any entry, so without this
      // it would silently vanish from the strip instead of showing as "Other".
      const entriesMs = entries.reduce((sum, e) => sum + e.totalMs, 0);
      const sessionMs = sessionTotalMs();
      const total = Math.max(sessionMs, entriesMs) || 1;
      const leftoverMs = Math.max(0, sessionMs - entriesMs);
      const strip = entries.map((e) => `
        <div title="${escapeHtml(e.name)} · ${formatDuration(Math.round(e.totalMs / 1000))} · ${pct(e.totalMs, total)}%"
             style="width:${(e.totalMs / total) * 100}%; min-width:3px; background:${e.color};"></div>`).join("")
        + (leftoverMs > 0 ? `
        <div title="Other (no active turn, e.g. pre-combat setup) · ${formatDuration(Math.round(leftoverMs / 1000))} · ${pct(leftoverMs, total)}%"
             style="width:${(leftoverMs / total) * 100}%; min-width:3px; background:rgba(255,255,255,0.15);"></div>` : "");

      let detail = "";
      if (ui.summaryOpen) {
        const max = Math.max(1, ...entries.map((e) => e.totalMs));
        const rows = entries.map((e) => `
          <div style="display:flex; align-items:center; gap:7px; padding:2px 0; font-size:11px;">
            <span style="width:56px; flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(e.name)}</span>
            <span style="flex:1; height:6px; border-radius:3px; background:rgba(255,255,255,0.07); overflow:hidden;">
              <span style="display:block; height:100%; width:${Math.max(3, (e.totalMs / max) * 100)}%; background:${e.color};"></span>
            </span>
            <span style="width:46px; text-align:right; opacity:0.8; font-variant-numeric:tabular-nums;">${formatDuration(Math.round(e.totalMs / 1000))}</span>
          </div>`).join("");
        // The GM bar above combines monster time with any dm-recategorized
        // time (that combination is a deliberate, closed decision - see
        // gmTotalStats()). This is the only place that isolates just the
        // creatures' own share of it, only computed when actually shown.
        const npc = npcAggregate();
        const npcLine = npc.turns
          ? `<div style="margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08); font-size:10px; opacity:0.6;">
               👹 Monsters: ${formatDuration(npc.totalS)} · Ø ${formatDuration(npc.avgS)}/turn
             </div>`
          : "";
        detail = `<div style="margin-top:8px;">${rows}</div>${npcLine}`;
      }

      const top = entries.slice(0, 3)
        .map((e) => `${escapeHtml(e.name)} ${formatDuration(Math.round(e.totalMs / 1000))}`).join(" · ");

      el.innerHTML = `
        <div style="display:flex; height:10px; border-radius:3px; overflow:hidden;">${strip}</div>
        <div style="display:flex; justify-content:space-between; gap:8px; font-size:10px; opacity:0.6; margin-top:6px;">
          <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${ui.summaryOpen ? `${entries.length} entries` : top}</span>
          <span id="ctp-summary-toggle" style="cursor:pointer; opacity:0.85; flex-shrink:0;">Details ${ui.summaryOpen ? "▴" : "▾"}</span>
        </div>
        ${detail}`;

      el.querySelector("#ctp-summary-toggle").addEventListener("click", () => {
        ui.summaryOpen = !ui.summaryOpen;
        persistUi();
        renderPanel();
      });
    }

    const SEG_FILTERS = [
      { key: "all", label: "All" },
      { key: "setup", label: "Setup" },
      { key: "reassigned", label: "Reassigned" },
      { key: "long", label: ">1m" },
    ];
    function segmentMatchesFilter(seg) {
      if (segFilter === "setup") return seg.category === "setup" || seg.category === "ignore";
      if (segFilter === "reassigned") return !!seg.overrideOwnerId || seg.category === "dm" || seg.category === "team";
      if (segFilter === "long") return segMs(seg) >= 60_000;
      return true;
    }
    function renderFilters() {
      const el = panel.querySelector("#ctp-filters");
      el.innerHTML = `<span style="opacity:0.5;">Filter</span>` + SEG_FILTERS.map((f) => `
        <span data-filter="${f.key}" ${segFilter === f.key ? "" : "data-hover"}
          style="cursor:pointer; padding:2px 7px; border-radius:9px;
                 ${segFilter === f.key ? "background:#4b3fa0;" : "border:1px solid #3f3f4c; opacity:0.6;"}">${f.label}</span>`).join("");
      el.querySelectorAll("[data-filter]").forEach((node) => {
        node.addEventListener("click", () => {
          segFilter = node.dataset.filter;
          renderPanel();
        });
      });
    }

    // ---- Segment list --------------------------------------------------------

    // Display-side grouping. Deliberately NOT buildTurnSlots(): that one drops
    // "ignore" segments entirely (correct for statistics, useless here - you
    // could never un-ignore one), and its slots are keyed for aggregation
    // rather than for a stable DOM identity across renders.
    function buildDisplayGroups() {
      const groups = [];
      for (const seg of allSegments()) {
        if (!groups.length || isTurnStart(seg)) {
          groups.push({ key: seg.id, opener: seg, round: seg.round, segments: [seg] });
        } else {
          groups[groups.length - 1].segments.push(seg);
        }
      }
      return groups;
    }
    // Excludes "ignore"-category time - a group spanning a split-off,
    // manually-ignored wall-clock gap shouldn't show that gap baked into its
    // header total (statistics already exclude it via buildTurnSlots(); this
    // keeps the segment list's own display honest about the same thing).
    function groupTotalMs(g) {
      return g.segments.reduce((sum, s) => sum + (s.category === "ignore" ? 0 : segMs(s)), 0);
    }
    function groupIgnoredMs(g) {
      return g.segments.reduce((sum, s) => sum + (s.category === "ignore" ? segMs(s) : 0), 0);
    }
    function groupIsLive(g) {
      return g.segments.some((s) => s.end === null);
    }

    // The rebuild is skipped when nothing that affects the markup changed, so
    // the list keeps its scroll position and any text selection instead of
    // being thrown away once per second. Only the durations of the live
    // segment/group tick, and those are patched in place.
    function segmentSignature(groups) {
      const parts = [selectedSession, segFilter, openCatSegId ?? "", playerPickerSegId ?? "", [...expandedGroups].sort().join(",")];
      for (const g of groups) {
        parts.push(`G${g.key}:${g.segments.length}`);
        for (const s of g.segments) {
          // combatantName included - syncCombatantNames() mutates it in
          // place on already-created segments when a module reveals a
          // hidden NPC name mid-combat, and without it in the signature the
          // list wouldn't reflect that until some other field changed too.
          parts.push(`${s.id}:${s.category}:${s.overrideOwnerId ?? ""}:${s.defeated ? 1 : 0}:${s.combatantName}:${s.end === null ? "live" : s.end}`);
        }
      }
      return parts.join("|");
    }

    function categoryChipHTML(seg) {
      const meta = CATEGORY_META[seg.category] ?? CATEGORY_META.player;
      return `<span data-cat-open="${seg.id}" title="Change category"
        style="cursor:pointer; padding:2px 7px; border-radius:5px; font-size:10px; white-space:nowrap;
               background:${meta.bg}; color:${meta.fg};">${meta.label} ▾</span>`;
    }

    function categoryPickerHTML(seg) {
      // "setup" is DM-only (see CATEGORY_META / defaultCategory()) - never
      // offered as a choice on a segment a player owns.
      const dmOwned = !resolvedOwner(seg);
      const cats = Object.entries(CATEGORY_META)
        .filter(([key]) => key !== "setup" || dmOwned)
        .map(([key, meta]) => {
        const active = seg.category === key;
        const label = key === "player" ? `${meta.label}…` : meta.label;
        return `<span data-seg-id="${seg.id}" data-cat="${key}" ${active ? "" : "data-hover"}
          style="cursor:pointer; padding:2px 7px; border-radius:5px; font-size:10px;
                 ${active ? `background:${meta.bg}; color:${meta.fg};` : "border:1px solid #3f3f4c;"}">${label}</span>`;
      }).join("");

      let players = "";
      if (playerPickerSegId === seg.id) {
        const chips = getCombatPlayers().map((p) => `
          <span data-seg-id="${seg.id}" data-owner-pick="${p.ownerId}"
            style="cursor:pointer; padding:2px 7px; border-radius:5px; font-size:10px;
                   background:${p.color}; color:${labelColorOn(p.color)};">${escapeHtml(p.name)}</span>`).join("");
        players = `
          <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:5px;">
            <span data-seg-id="${seg.id}" data-owner-pick="__default__" data-hover
              style="cursor:pointer; padding:2px 7px; border-radius:5px; font-size:10px;
                     border:1px dashed rgba(255,255,255,0.35); opacity:0.75;">↩ Default</span>
            ${chips}
          </div>`;
      }
      return `<div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:5px;">${cats}</div>${players}`;
    }

    function segRowHTML(seg) {
      const live = seg.end === null;
      const triggerIcon = seg.trigger === "pause" ? "⏸ "
        : seg.trigger === "split" ? "✂️ "
        : (seg.trigger === "unpause" || seg.trigger === "resume") ? "▶ " : "";
      const who = seg.combatantId ? escapeHtml(seg.combatantName) : "(no combat)";
      const override = seg.overrideOwnerId
        ? ` <span style="color:${getCombatantColor(seg.overrideOwnerId)};">→ ${escapeHtml(ownerName(seg.overrideOwnerId))}</span>`
        : "";
      const defeated = seg.defeated ? " 💀" : "";
      const dur = formatDuration(Math.round(segMs(seg) / 1000));
      return `
        <div data-anchor-seg="${seg.id}" style="padding:4px 0;">
          <div style="display:flex; align-items:center; gap:6px; font-size:11px;">
            <span style="opacity:0.45; font-size:10px; font-variant-numeric:tabular-nums; flex-shrink:0;">${formatClock(seg.start)}</span>
            <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${triggerIcon}${who}${override}${defeated}${live ? " ●" : ""}
            </span>
            <span ${live ? `data-live-dur="${seg.id}"` : ""} style="opacity:0.85; font-variant-numeric:tabular-nums; flex-shrink:0;">${dur}</span>
            ${categoryChipHTML(seg)}
          </div>
          ${openCatSegId === seg.id ? categoryPickerHTML(seg) : ""}
        </div>`;
    }

    function groupHTML(g, expanded) {
      const opener = g.opener;
      const owner = resolvedOwner(opener);
      const isPC = isPlayerControlled(opener);
      const who = ownerName(owner);
      const dot = isPC
        ? `<span style="width:8px; height:8px; border-radius:50%; background:${getCombatantColor(owner)}; flex-shrink:0;"></span>`
        : `<span style="flex-shrink:0;">👹</span>`;
      const live = groupIsLive(g);

      // A slot that never got split is one segment, so a header plus a single
      // child would print the same name and duration twice. Render it as one
      // row that carries the category chip directly - no expanding needed to
      // reach the only thing there is to edit. Its own duration is shown as-is
      // regardless of category - there's no "other" time in this row to
      // conflate it with, unlike a multi-segment group's header total below.
      if (g.segments.length === 1) {
        const seg = g.segments[0];
        const total = formatDuration(Math.round(segMs(seg) / 1000));
        return `
          <div data-anchor-group="${g.key}" style="border-bottom:1px solid rgba(255,255,255,0.05); padding:6px 10px;">
            <div style="display:flex; align-items:center; gap:6px; font-size:11px;">
              <span style="opacity:0.45; font-size:10px; font-variant-numeric:tabular-nums; flex-shrink:0;">${formatClock(seg.start)}</span>
              ${dot}
              <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                ${escapeHtml(seg.combatantName)}${who ? ` <span style="opacity:0.45;">${escapeHtml(who)}</span>` : ""}
                ${seg.overrideOwnerId ? ` <span style="color:${getCombatantColor(seg.overrideOwnerId)};">→ ${escapeHtml(ownerName(seg.overrideOwnerId))}</span>` : ""}
                ${seg.defeated ? " 💀" : ""}${live ? " ●" : ""}
              </span>
              <span ${live ? `data-live-dur="${seg.id}"` : ""} style="font-variant-numeric:tabular-nums; flex-shrink:0; opacity:0.85;">${total}</span>
              ${categoryChipHTML(seg)}
            </div>
            ${openCatSegId === seg.id ? categoryPickerHTML(seg) : ""}
          </div>`;
      }

      const total = formatDuration(Math.round(groupTotalMs(g) / 1000));
      const ignoredMs = groupIgnoredMs(g);
      // The time existed and was deliberately excluded, not hidden - shown
      // muted rather than folded silently into (or out of) the real total.
      const ignoredTag = ignoredMs > 0
        ? ` <span style="opacity:0.45;">· 🚫 ${formatDuration(Math.round(ignoredMs / 1000))}</span>`
        : "";
      // visibleSegments narrows which children render under the active
      // filter; the count/total above always reflect the group's real,
      // unfiltered contents so a filtered subtotal never masquerades as the
      // whole - the "X of Y" makes the gap explicit instead.
      const visible = g.visibleSegments ?? g.segments;
      const partsLabel = visible.length === g.segments.length
        ? `${g.segments.length} parts`
        : `${visible.length} of ${g.segments.length} parts`;
      // A collapsed group attributes its whole total to the opener's name and
      // color even when some of its parts were recategorized or reassigned
      // elsewhere - the children show the truth when expanded, but a small
      // composition chip (reusing proportionalSegmentsHtml(), same as
      // the chat report bars) signals the split at a glance instead. Colored
      // the same way a segment's own dot/chip would be: a "player" segment
      // by its (possibly reassigned) owner's color, everything else by its
      // category color - so the chip lines up with what expanding reveals.
      // "ignore" segments are left out, matching groupTotalMs()'s exclusion.
      const chipColor = (seg) => seg.category === "player"
        ? getCombatantColor(resolvedOwner(seg))
        : (CATEGORY_META[seg.category]?.bg ?? CATEGORY_META.player.bg);
      const countable = g.segments.filter((s) => s.category !== "ignore");
      const mixed = new Set(countable.map(chipColor)).size > 1;
      const compositionChip = mixed
        ? `<span title="Mixes more than one category/owner - expand to see the split"
                 style="flex-shrink:0; width:30px; height:7px; border-radius:3px; overflow:hidden; display:flex;">
             ${proportionalSegmentsHtml(countable.map((s) => ({ ms: segMs(s), color: chipColor(s) })), Infinity)}
           </span>`
        : "";
      const header = `
        <div data-group-row data-group="${g.key}" data-anchor-group="${g.key}" style="display:flex; align-items:center; gap:6px;
             padding:6px 10px; font-size:11px; cursor:pointer;">
          <span style="opacity:0.5; width:9px; flex-shrink:0;">${expanded ? "▾" : "▸"}</span>
          ${dot}
          <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
            ${escapeHtml(opener.combatantName)}${who ? ` <span style="opacity:0.45;">${escapeHtml(who)}</span>` : ""}
            <span style="opacity:0.4;"> · ${partsLabel}</span>
            ${live ? " ●" : ""}
          </span>
          ${compositionChip}
          <span ${live ? `data-group-dur="${g.key}"` : ""} style="font-variant-numeric:tabular-nums; flex-shrink:0;">${total}</span>${ignoredTag}
        </div>`;

      if (!expanded) return `<div style="border-bottom:1px solid rgba(255,255,255,0.05);">${header}</div>`;

      const children = visible.map((s) => segRowHTML(s)).join("");
      return `
        <div style="border-bottom:1px solid rgba(255,255,255,0.05); background:#1b1b23;">
          ${header}
          <div style="margin:0 10px 6px 22px; border-left:2px solid #33333f; padding-left:8px;">${children}</div>
        </div>`;
    }

    function renderSegments() {
      const host = panel.querySelector("#ctp-segments");
      let groups = buildDisplayGroups();
      // Liveness only seeds the *initial* expanded state, once per group key -
      // after that it's tracked in expandedGroups like every other group, so
      // the chevron can actually collapse a still-running group.
      for (const g of groups) {
        if (groupIsLive(g) && !liveGroupsSeeded.has(g.key)) {
          expandedGroups.add(g.key);
          liveGroupsSeeded.add(g.key);
        }
      }
      const filtering = segFilter !== "all";
      if (filtering) {
        // Keep g.segments as the group's real, full list (groupTotalMs() etc.
        // all read it) - only visibleSegments narrows for display, so a
        // filtered group's header can still show its true total instead of a
        // filtered subtotal masquerading as the whole.
        groups = groups
          .map((g) => ({ ...g, visibleSegments: g.segments.filter(segmentMatchesFilter) }))
          .filter((g) => g.visibleSegments.length);
      }

      const sig = segmentSignature(groups);
      if (sig === lastSegSig) {
        // Nothing structural changed - only patch the two things that tick.
        host.querySelectorAll("[data-live-dur]").forEach((node) => {
          const seg = findSegment(node.dataset.liveDur);
          if (seg) node.textContent = formatDuration(Math.round(segMs(seg) / 1000));
        });
        host.querySelectorAll("[data-group-dur]").forEach((node) => {
          const g = groups.find((x) => x.key === node.dataset.groupDur);
          if (g) node.textContent = formatDuration(Math.round(groupTotalMs(g) / 1000));
        });
        return;
      }
      lastSegSig = sig;

      if (!groups.length) {
        host.innerHTML = `<div style="opacity:0.5; padding:10px; font-size:11px;">${
          filtering ? "Nothing matches this filter." : "No data yet — import a session, or wait for combat to start."
        }</div>`;
        return;
      }

      // Newest first, chronological inside a group. Round markers are emitted
      // as the (reversed) walk crosses a round boundary.
      const ordered = [...groups].reverse();
      let html = "";
      ordered.forEach((g, i) => {
        const nextRound = ordered[i + 1]?.round ?? null;
        // A filtered group can be auto-expanded: hiding a match behind a
        // collapsed header would defeat the point of filtering for it.
        const expanded = filtering || expandedGroups.has(g.key);
        html += groupHTML(g, expanded);
        if (g.round != null && nextRound !== g.round) {
          html += `
            <div style="padding:4px 10px; font-size:10px; letter-spacing:0.5px; opacity:0.5; background:#1d1d25;">
              🔄 ROUND ${g.round}
            </div>`;
        }
      });

      // Anchor on the topmost visible row's own element instead of a raw
      // scrollTop pixel offset - the list is newest-first (new content
      // inserts at the top), so a bare offset points at different content
      // after every new segment (only invisible at scrollTop === 0).
      const hostRectBefore = host.getBoundingClientRect();
      let anchor = null;
      for (const node of host.querySelectorAll("[data-anchor-group], [data-anchor-seg]")) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom > hostRectBefore.top) {
          const attr = node.hasAttribute("data-anchor-seg") ? "data-anchor-seg" : "data-anchor-group";
          const id = node.getAttribute(attr);
          // If this anchor is a child segment, also remember its enclosing
          // group's own key (which survives the group being collapsed, since
          // the header keeps data-anchor-group) as a fallback - so collapsing
          // a group scrolled halfway down the list re-anchors on its
          // now-collapsed header instead of snapping to the top.
          const fallbackKey = attr === "data-anchor-seg" ? groups.find((g) => g.segments.some((s) => s.id === id))?.key ?? null : null;
          anchor = {
            selector: `[${attr}="${CSS.escape(id)}"]`,
            fallbackSelector: fallbackKey ? `[data-anchor-group="${CSS.escape(fallbackKey)}"]` : null,
            offset: rect.top - hostRectBefore.top,
          };
          break;
        }
      }

      host.innerHTML = html;

      const newAnchorEl = anchor && (host.querySelector(anchor.selector) ?? (anchor.fallbackSelector && host.querySelector(anchor.fallbackSelector)));
      if (newAnchorEl) {
        const hostRectAfter = host.getBoundingClientRect();
        const newOffset = newAnchorEl.getBoundingClientRect().top - hostRectAfter.top;
        host.scrollTop = newOffset - anchor.offset;
      }

      host.querySelectorAll("[data-group]").forEach((node) => {
        node.addEventListener("click", () => {
          const key = node.dataset.group;
          if (expandedGroups.has(key)) expandedGroups.delete(key);
          else expandedGroups.add(key);
          openCatSegId = null;
          playerPickerSegId = null;
          renderPanel();
        });
      });
      host.querySelectorAll("[data-cat-open]").forEach((node) => {
        node.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const id = node.dataset.catOpen;
          openCatSegId = openCatSegId === id ? null : id;
          playerPickerSegId = null;
          renderPanel();
        });
      });
      host.querySelectorAll("[data-cat]").forEach((node) => {
        node.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const seg = findSegment(node.dataset.segId);
          if (!seg) return;
          const cat = node.dataset.cat;
          if (cat === "player") {
            // Don't assign straight away - open the player list, so the time
            // can go to somebody other than the technical owner.
            playerPickerSegId = playerPickerSegId === seg.id ? null : seg.id;
            renderPanel();
            return;
          }
          seg.category = cat;
          seg.overrideOwnerId = null;
          playerPickerSegId = null;
          openCatSegId = null;
          persist();
          toast(`Marked as ${CATEGORY_META[cat].label}.`);
          renderPanel();
        });
      });
      host.querySelectorAll("[data-owner-pick]").forEach((node) => {
        node.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const seg = findSegment(node.dataset.segId);
          if (!seg) return;
          const pick = node.dataset.ownerPick;
          seg.category = "player";
          seg.overrideOwnerId = pick === "__default__" ? null : pick;
          playerPickerSegId = null;
          openCatSegId = null;
          persist();
          toast(pick === "__default__" ? "Back to the default owner." : `Reassigned to ${ownerName(pick)}.`);
          renderPanel();
        });
      });
    }

    function renderPostMenu() {
      const el = panel.querySelector("#ctp-post-menu");
      el.style.display = postMenuOpen ? "block" : "none";
      if (!postMenuOpen) return;
      const options = [
        { key: "bars", label: "📊 Bar chart — time per person" },
        { key: "players", label: "🧑 Player list — turn, gap, wait" },
      ];
      el.innerHTML = `
        <div style="border:1px solid #3a3a46; border-radius:6px; overflow:hidden;">
          ${options.map((o) => `
            <div data-post="${o.key}" data-hover style="cursor:pointer; padding:6px 8px; font-size:11px;">${o.label}</div>`).join("")}
        </div>
        <div style="font-size:10px; opacity:0.45; margin:4px 2px 0;">Whispered to you. Right-click the message → “Reveal to Everyone” to share.</div>`;
      el.querySelectorAll("[data-post]").forEach((node) => {
        node.addEventListener("click", async () => {
          const kind = node.dataset.post;
          postMenuOpen = false;
          renderPanel();
          await postToChat(kind === "bars" ? buildBarsContent() : buildPlayerListContent(), kind);
          toast("Posted to chat — only you can see it.");
        });
      });
    }

    function renderPanel() {
      syncCombatantNames();
      persist();
      if (!panelVisible || !document.body.contains(panel)) return;
      renderMenu();
      renderTabs();
      renderLive();
      renderSummary();
      renderFilters();
      renderSegments();
      renderPostMenu();
    }

    setInterval(renderPanel, 1000);
    window.addEventListener("resize", reclampForViewport);

    // The ⋯ overflow menu and "Post report" dropdown otherwise only close via
    // their own button or picking an entry - a click anywhere else left them
    // open (U-10).
    document.addEventListener("pointerdown", (ev) => {
      if (!panel || !document.body.contains(panel)) return;
      if (!menuOpen && !postMenuOpen) return;
      if (ev.target.closest("#ctp-menu, #ctp-menu-btn, #ctp-post-menu, #ctp-post")) return;
      menuOpen = false;
      postMenuOpen = false;
      renderPanel();
    });
  }
})();
