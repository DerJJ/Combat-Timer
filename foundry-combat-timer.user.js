// ==UserScript==
// @name         Foundry VTT Combat Timer
// @namespace    https://local.private/
// @version      0.2
// @author       DerJJ/Umek
// @description  Persistent, segmented combat time tracking with a session ring buffer (current + last 2), automatic new session on combat start, dummy data button, scene controls toggle, Player/GM/Team/Setup categorization, player/GM colors, owner-based grouping, defeated filter, two self-roll chat reports (dnd5e & pf2e)
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
    const CATEGORY_META = {
      player: { icon: "🧑" },
      dm:     { icon: "🎲" },
      team:   { icon: "👥" },
      setup:  { icon: "🛠️" },
      ignore: { icon: "🚫" }, // manual-only (never auto-assigned) - excluded from every total, for a segment that's really just a wall-clock gap (e.g. the session resumed days later)
    };

    // ---- Persistence ----
    function storageKey() {
      return `ctp-state-${game.world?.id ?? "default"}-${game.user?.id ?? "default"}`;
    }
    // Pre-user-scoping data lived under this key (no user id suffix). Only
    // read as a fallback, never written to - the next persist() tick writes
    // the adopted data forward under storageKey(), self-healing the migration.
    function legacyStorageKey() {
      return `ctp-state-${game.world?.id ?? "default"}`;
    }
    function hasPersistedData(state) {
      return !!state && (state.segments?.length > 0 || !!state.currentSegment || state.sessionHistory?.length > 0);
    }
    function loadPersisted() {
      try {
        const current = JSON.parse(localStorage.getItem(storageKey()) ?? "null");
        if (hasPersistedData(current)) return current;
        // Nothing (or only an empty state already written by a prior run of
        // this script) under the current key - fall back to whatever the
        // pre-user-scoping key holds, so an empty write doesn't permanently
        // block the one-time migration.
        const legacy = JSON.parse(localStorage.getItem(legacyStorageKey()) ?? "null");
        return hasPersistedData(legacy) ? legacy : current;
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
    let dragOffset = null;

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

    function getCombatantColor(ownerId) {
      if (ownerId) return game.users.get(ownerId)?.color.css ?? "#888888";
      const gm = game.users.find((u) => u.isGM && u.active) ?? game.users.find((u) => u.isGM);
      return gm ? gm.color.css : "#c0392b";
    }

    const SETUP_PAUSE_THRESHOLD_MS = 5000; // a pause right after a short prior segment is likely a round-boundary pause, not a mid-decision one
    const SHORT_PAUSE_MERGE_THRESHOLD_MS = 3000; // a pause shorter than this is noise (toggle lag, a misclick) - fold it into whatever ran right before instead of showing it as its own segment

    function defaultCategory(trigger, prevSegment) {
      if (trigger === "pause") {
        const prevDur = prevSegment ? segMs(prevSegment) : Infinity;
        if (prevDur < SETUP_PAUSE_THRESHOLD_MS) return "setup";
        return prevSegment ? prevSegment.category : "setup";
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
        actorType: null, // combatant.actor.type ("character" vs "npc" in dnd5e/pf2e) - distinguishes a PC from a player-owned summon/pet, which "ownerId !== null" alone can't
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
        category: defaultCategory(trigger, prev),
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
      if (currentSegment) {
        currentSegment.end = currentSegment.end ?? Date.now();
        segments.push(currentSegment);
        currentSegment = null;
      }
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
    // A defeated PC still gets a real turn (death saves etc. are genuine
    // activity); a defeated NPC's turn is an instant skip - nobody actually
    // decided anything, so it never counts as "a turn" for averaging,
    // regardless of who its time ends up credited to (see effectiveOwner()).
    function isRealTurn(seg) {
      return hasCombatContext(seg) && (!seg.defeated || seg.actorType === "character");
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
    // that time from silently vanishing from every total (see S-01).
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
            id, name: game.users.get(id)?.name ?? "?", color: getCombatantColor(id),
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
        if (slot.designatedOwner && opening.category === "player" && isRealTurn(opening)) {
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
        if (isRealTurn(seg)) turns += 1; // an instant-skip's brief duration still counts toward totalMs, but never masquerades as "a turn"
      }
      return { totalS: Math.round(totalMs / 1000), turns, avgS: turns ? Math.round(totalMs / turns / 1000) : 0 };
    }

    function categoryTotals() {
      const t = { dm: 0, team: 0, setup: 0 };
      for (const seg of allSegments()) if (seg.category in t) t[seg.category] += segMs(seg);
      return {
        dmMs: t.dm, teamMs: t.team, setupMs: t.setup,
        dmS: Math.round(t.dm / 1000), teamS: Math.round(t.team / 1000), setupS: Math.round(t.setup / 1000),
      };
    }

    function totalPausedRealS() {
      const ms = allSegments().filter((s) => s.trigger === "pause").reduce((sum, s) => sum + segMs(s), 0);
      return Math.round(ms / 1000);
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

    function betweenTurnStats() {
      const slots = buildTurnSlots();
      const byOwner = new Map();
      for (const s of slots) {
        if (!s.designatedOwner) continue;
        if (!byOwner.has(s.designatedOwner)) byOwner.set(s.designatedOwner, []);
        byOwner.get(s.designatedOwner).push(s);
      }
      const spanStart = slots.length ? Math.min(...slots.map((s) => s.start)) : 0;
      const spanEnd = slots.length ? Math.max(...slots.map((s) => s.end)) : 0;

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

    // Real players if the world actually has a GM plus at least 3 players
    // configured - otherwise nobody to draw from, so fall back to fixed
    // placeholder names. When real data is used, ALL non-GM users are
    // included (not capped at 3). Colors are always resolved fresh from
    // ownerId at render time (getCombatantColor()), never stored here.
    function getDummyPlayerSource() {
      const realPlayers = game.users.filter((u) => !u.isGM);
      const gmExists = game.users.some((u) => u.isGM);
      if (gmExists && realPlayers.length >= 3) {
        return realPlayers.map((u) => ({ name: u.name, ownerId: u.id }));
      }
      return [
        { name: "Aria", ownerId: "dummy-p1" },
        { name: "Boro", ownerId: "dummy-p2" },
        { name: "Cass", ownerId: "dummy-p3" },
      ];
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
          const actorType = isPC ? "character" : "npc";
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
              category: Math.random() < 0.5 ? "setup" : "player",
            }));
            t += pauseDur;
          }
        }
      }
      return out;
    }

    function loadDummyData() {
      if (selectedSession !== "current") {
        alert("Switch to the '🟢 Now' tab first to load dummy data.");
        return;
      }
      if (segments.length || currentSegment) {
        alert("The current session already has data. Reset it with 🗑️ first, then load dummy data.");
        return;
      }
      segments = generateDummySegments();
      currentSegment = null;
      persist();
    }

    // Combined GM total: monster-turn time (not reassigned away) PLUS any
    // segment explicitly recategorized as "dm" (e.g. a player's turn or a
    // pause that was really the GM's time, not the player's).
    function gmTotalStats() {
      let ms = 0, turns = 0;
      const byEntity = new Map();
      const lastLiveOwner = lastLiveOwnerByCombatant();
      for (const seg of allSegments()) {
        if (!hasCombatContext(seg)) continue;
        const unclaimedNpcTurn = seg.category === "player" && effectiveOwner(seg, lastLiveOwner) === null;
        const countsForGM = unclaimedNpcTurn || seg.category === "dm";
        if (!countsForGM) continue;
        const segDurMs = segMs(seg);
        ms += segDurMs;
        if (!byEntity.has(seg.combatantId)) {
          byEntity.set(seg.combatantId, { combatantId: seg.combatantId, name: seg.combatantName, ms: 0, turnCount: 0 });
        }
        const entity = byEntity.get(seg.combatantId);
        entity.ms += segDurMs;
        if (isRealTurn(seg)) { turns += 1; entity.turnCount += 1; }
      }
      return { totalMs: ms, turnCount: turns, byEntity: [...byEntity.values()] };
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
    function darkenHex(hex, factor) {
      const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
      if (!m) return hex;
      const scale = (h) => Math.round(parseInt(h, 16) * factor).toString(16).padStart(2, "0");
      return `#${scale(m[1])}${scale(m[2])}${scale(m[3])}`;
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

    // Renders one row's worth of proportional, colored sub-segments sharing
    // a common parent width. A part's label is only drawn when its own
    // share is wide enough to plausibly fit it - a narrow sliver still
    // contributes its color and proportion, just without forcing illegible
    // text into it (per design: show every part, label only where it fits).
    function proportionalSegmentsHtml(parts, minLabelPct) {
      const total = parts.reduce((sum, p) => sum + p.ms, 0) || 1;
      return parts.filter((p) => p.ms > 0).map((p) => {
        const w = (p.ms / total) * 100;
        const label = p.label && w >= minLabelPct
          ? `<span style="font-size:8px; font-weight:600; color:rgba(0,0,0,0.55); white-space:nowrap;">${p.label}</span>`
          : "";
        return `<div style="width:${w}%; height:100%; background:${p.color} !important;
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
      const ordered = orderAndShade(e.byEntity, (en) => en.actorType === "character")
        .map(({ item, shade }) => ({ item, color: darkenHex(e.color, shade) }));
      const showLabels = ordered.length > 1;
      const personTotalMs = e.byEntity.reduce((sum, en) => sum + en.inTurnMs + en.outOfTurnMs, 0) || 1;

      const mainParts = ordered.map(({ item, color }) => ({
        ms: item.inTurnMs + item.outOfTurnMs,
        color,
        label: showLabels ? formatDuration(Math.round((item.inTurnMs + item.outOfTurnMs) / 1000)) : null,
      }));
      const mainSegs = proportionalSegmentsHtml(mainParts, 12);

      let indicatorRow = "";
      if (e.pausedMs > 0 || e.outOfTurnMs > 0) {
        const cols = ordered.map(({ item, color }) => {
          const entMs = item.inTurnMs + item.outOfTurnMs;
          if (entMs <= 0) return "";
          const colWidth = (entMs / personTotalMs) * 100;
          const pausedMs = Math.min(item.pausedMs, entMs);
          const inTurnPlainMs = Math.max(0, entMs - pausedMs - item.outOfTurnMs);
          const parts = proportionalSegmentsHtml([
            { ms: pausedMs, color: "#e8a33d" }, // fixed, entity-independent - means "paused" everywhere in the report
            { ms: item.outOfTurnMs, color: "#4fc3d9" }, // fixed, entity-independent - means "out-of-turn" everywhere
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
      const ordered = orderAndShade(gm.byEntity, () => false)
        .map(({ item, shade }) => ({ item, color: darkenHex(gmColor, shade) }));
      const showLabels = ordered.length > 1;
      const parts = ordered.map(({ item, color }) => ({
        ms: item.ms,
        color,
        label: showLabels ? formatDuration(Math.round(item.ms / 1000)) : null,
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
      const playerEntries = perCombatantStats().map((e) => ({ ...e, icon: "🧑", kind: "player" }));
      const gm = gmTotalStats();
      const cat = categoryTotals();
      const entries = [...playerEntries];
      if (gm.totalMs > 0) {
        entries.push({ id: "gm-total", name: "GM", icon: "🎲", color: getCombatantColor(null), totalMs: gm.totalMs, turnCount: gm.turnCount, byEntity: gm.byEntity, kind: "gm" });
      }
      if (cat.teamMs > 0) {
        entries.push({ id: "team-total", name: "Team", icon: "👥", color: "#383E42", totalMs: cat.teamMs, turnCount: 0, kind: "flat" });
      }
      if (cat.setupMs > 0) {
        entries.push({ id: "setup-total", name: "Setup", icon: "🛠️", color: getCombatantColor(null), totalMs: cat.setupMs, turnCount: 0, kind: "flat" });
      }
      entries.sort((a, b) => b.totalMs - a.totalMs);
      const max = Math.max(1, ...entries.map((e) => e.totalMs));
      const sessionMs = sessionTotalMs();

      const bars = entries.map((e) => {
        const s = Math.round(e.totalMs / 1000);
        const pct = Math.max(4, Math.round((e.totalMs / max) * 100));
        const ofTotal = sessionMs > 0 ? ` · ${Math.round((e.totalMs / sessionMs) * 100)}%` : "";
        const avg = e.turnCount > 0 ? ` · Ø ${formatDuration(Math.round(s / e.turnCount))}/turn` : "";

        let fillInner, indicatorRow = "";
        if (e.kind === "player") {
          const built = buildPlayerBarRows(e);
          fillInner = built.mainSegs;
          indicatorRow = built.indicatorRow;
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

      return wrapCard({
        title: "⚔️ Combat Times",
        subtitle: `Total ${formatDuration(Math.round(sessionTotalMs() / 1000))}`,
        body: bars,
      });
    }

    function buildPlayerListContent() {
      const gaps = betweenTurnStats();
      const waits = absoluteWaitStats();
      const rows = perCombatantStats()
        .sort((a, b) => b.totalMs - a.totalMs)
        .map((e) => {
          const avgTurn = e.turnCount ? Math.round(e.totalMs / e.turnCount / 1000) : 0;
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
        if (!confirm("Start a new session now? The current one is archived, not lost.")) return;
        archiveSessionIfNeeded();
        reconcileWithLiveState();
      } else {
        const idx = selectedSession === "prev1" ? 0 : 1;
        if (!sessionHistory[idx]) return;
        if (!confirm("Really delete this archived session? This cannot be undone.")) return;
        sessionHistory.splice(idx, 1);
        selectedSession = "current";
      }
      persist();
    }

    // Exports only the currently VIEWED session (whichever tab is selected),
    // not the full ring buffer - matches "what you're looking at" rather than
    // requiring a full-state restore just to move one session elsewhere.
    function exportSelectedSession() {
      const { segs, current } = getSelectedSessionData();
      const idx = selectedSession === "prev1" ? 0 : selectedSession === "prev2" ? 1 : null;
      const payload = {
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
          alert("That file isn't valid JSON.");
          return;
        }
        if (!Array.isArray(parsed.segments)) {
          alert("That file doesn't look like Combat Timer session data (missing a segments array).");
          return;
        }
        const label = selectedSession === "current" ? "current (Now)" : selectedSession === "prev1" ? "-1" : "-2";
        if (!confirm(`Replace the "${label}" tab's data with the imported file? This cannot be undone.`)) return;

        if (selectedSession === "current") {
          segments = parsed.segments;
          currentSegment = parsed.currentSegment ?? null;
          reconcileWithLiveState(); // imported data may not match what's actually live right now
        } else {
          const idx = selectedSession === "prev1" ? 0 : 1;
          sessionHistory[idx] = { segments: parsed.segments, endedAt: parsed.endedAt ?? Date.now() };
        }
        persist();
        renderPanel();
      };
      reader.readAsText(file);
    }

    async function postToChat(content, kind) {
      await ChatMessage.create({
        content,
        speaker: ChatMessage.getSpeaker({ alias: "Combat Timer" }),
        whisper: [game.user.id],
        flags: { "combat-timer": { kind, session: selectedSession, at: Date.now() } },
      });
    }

    // ---- Open/close panel (shared by ✕, the reopen button, and the scene control) ----
    function openPanel() {
      const reopenBtn = document.getElementById("ctp-reopen");
      if (reopenBtn) reopenBtn.remove();
      if (!document.body.contains(panel)) panel = buildPanel();
      panelVisible = true;
    }
    function closePanel() {
      if (document.body.contains(panel)) panel.remove();
      panelVisible = false;
      buildReopenButton();
    }
    function togglePanel() {
      if (panelVisible && document.body.contains(panel)) closePanel();
      else openPanel();
    }

    // ---- Floating panel ----
    // This MUST succeed no matter what - built and shown before we touch
    // anything experimental (like the scene controls integration below),
    // so a failure there can never prevent the panel itself from existing.
    function buildPanel() {
      const el = document.createElement("div");
      el.id = "combat-timer-panel";
      el.style.cssText = `
        position: fixed; top: 60px; right: 16px; z-index: 9999;
        width: 260px; font-family: "Signika", sans-serif; font-size: 12px;
        background: linear-gradient(160deg, #1e1e26, #14141a);
        border: 1px solid #3a3a46; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5); color: #ddd; overflow: hidden;
      `;

      el.innerHTML = `
        <div id="ctp-header" style="cursor:move; padding:8px 10px; background:#2a2a35;
             display:flex; justify-content:space-between; align-items:center;
             border-bottom:1px solid #3a3a46;">
          <span style="font-weight:600; letter-spacing:0.3px;">⚔️ Combat Times</span>
          <span>
            <span id="ctp-dummy" title="Load dummy data (only if empty)" style="cursor:pointer; opacity:0.6; margin-right:8px;">🧪</span>
            <span id="ctp-reset" title="Start a new session now (archives the current one, nothing is lost)" style="cursor:pointer; opacity:0.6; margin-right:8px;">🆕</span>
            <span id="ctp-close" style="cursor:pointer; opacity:0.6;">✕</span>
          </span>
        </div>
        <div id="ctp-status" style="padding:6px 10px; font-size:11px; opacity:0.75;"></div>
        <div id="ctp-rows" style="padding:2px 10px 4px;"></div>
        <div id="ctp-footer" style="padding:0 10px 6px; font-size:11px; opacity:0.8;"></div>
        <div style="padding:4px 10px; font-size:10px; opacity:0.55; border-top:1px solid #3a3a46;">
          Segments (tap icons to recategorize)
        </div>
        <div id="ctp-segments" style="max-height:170px; overflow-y:auto; padding:2px 10px 6px;"></div>
        <div id="ctp-toolbar" style="display:flex; gap:4px; padding:6px 10px;
             border-top:1px solid #3a3a46; border-bottom:1px solid #3a3a46; font-size:10px;"></div>
        <div id="ctp-io" style="display:flex; gap:4px; padding:4px 10px; font-size:10px;">
          <span data-action="export" title="Export the currently viewed session (Now / -1 / -2) as a JSON file"
                style="flex:1; text-align:center; cursor:pointer; padding:3px 2px; border-radius:4px;
                       opacity:0.6; border:1px solid #3a3a46;">📤 Export</span>
          <span data-action="import" title="Import a JSON file, replacing the currently viewed session"
                style="flex:1; text-align:center; cursor:pointer; padding:3px 2px; border-radius:4px;
                       opacity:0.6; border:1px solid #3a3a46;">📥 Import</span>
          <input type="file" id="ctp-import-file" accept="application/json" style="display:none;">
        </div>
        <div style="padding:6px 10px; display:flex; flex-direction:column; gap:4px;">
          <button id="ctp-post-bars" style="padding:5px; border:none; border-radius:6px;
                  background:#4b3fa0; color:#fff; cursor:pointer; font-size:11px;">
            📊 Post bar chart (only me)
          </button>
          <button id="ctp-post-players" style="padding:5px; border:none; border-radius:6px;
                  background:#2f6fa0; color:#fff; cursor:pointer; font-size:11px;">
            🧑 Post player list (only me)
          </button>
        </div>
      `;
      document.body.appendChild(el);

      el.querySelector("#ctp-close").addEventListener("click", () => closePanel());
      el.querySelector("#ctp-dummy").addEventListener("click", () => loadDummyData());
      el.querySelector("#ctp-reset").addEventListener("click", () => deleteSelectedSession());
      el.querySelector("#ctp-post-bars").addEventListener("click", () => postToChat(buildBarsContent(), "bars"));
      el.querySelector("#ctp-post-players").addEventListener("click", () => postToChat(buildPlayerListContent(), "players"));
      el.querySelector('#ctp-io [data-action="export"]').addEventListener("click", () => exportSelectedSession());
      el.querySelector('#ctp-io [data-action="import"]').addEventListener("click", () => el.querySelector("#ctp-import-file").click());
      el.querySelector("#ctp-import-file").addEventListener("change", (ev) => {
        const file = ev.target.files[0];
        ev.target.value = ""; // allow re-selecting the same file later
        if (file) importSessionFromFile(file);
      });

      el.querySelector("#ctp-header").addEventListener("mousedown", (ev) => {
        const rect = el.getBoundingClientRect();
        dragOffset = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      });
      document.addEventListener("mousemove", (ev) => {
        if (!dragOffset) return;
        el.style.left = `${ev.clientX - dragOffset.x}px`;
        el.style.top = `${ev.clientY - dragOffset.y}px`;
        el.style.right = "auto";
      });
      document.addEventListener("mouseup", () => (dragOffset = null));

      return el;
    }

    // Hover states for every clickable control in the panel (header icons,
    // toolbar/split/session tabs, segment category + player-picker chips,
    // chat-report buttons) plus the floating reopen button. Injected once as
    // a real <style> tag rather than per-element JS listeners, since
    // renderPanel() rebuilds innerHTML every tick anyway - a stylesheet rule
    // survives that, inline :hover state wouldn't. This only affects the
    // LOCAL panel/reopen button, never ChatMessage content (hard constraint
    // #2 is about chat HTML specifically and doesn't apply here).
    function injectPanelStyles() {
      if (document.getElementById("ctp-styles")) return;
      const style = document.createElement("style");
      style.id = "ctp-styles";
      style.textContent = `
        #combat-timer-panel #ctp-dummy,
        #combat-timer-panel #ctp-reset,
        #combat-timer-panel #ctp-close,
        #combat-timer-panel #ctp-toolbar [data-action="split"],
        #combat-timer-panel #ctp-toolbar [data-session],
        #combat-timer-panel #ctp-io [data-action],
        #combat-timer-panel #ctp-segments [data-cat],
        #combat-timer-panel #ctp-segments [data-owner-pick],
        #combat-timer-panel #ctp-post-bars,
        #combat-timer-panel #ctp-post-players,
        #ctp-reopen {
          transition: background 0.12s ease, opacity 0.12s ease, filter 0.12s ease;
        }
        #combat-timer-panel #ctp-dummy:hover,
        #combat-timer-panel #ctp-reset:hover,
        #combat-timer-panel #ctp-close:hover {
          opacity: 1 !important;
          background: rgba(255,255,255,0.14);
          border-radius: 4px;
        }
        #combat-timer-panel #ctp-toolbar [data-action="split"]:hover,
        #combat-timer-panel #ctp-toolbar [data-session][data-available="true"]:hover,
        #combat-timer-panel #ctp-io [data-action]:hover {
          opacity: 1 !important;
          background: rgba(255,255,255,0.12);
        }
        #combat-timer-panel #ctp-segments [data-cat]:hover {
          opacity: 1 !important;
          filter: brightness(1.3);
        }
        #combat-timer-panel #ctp-segments [data-owner-pick]:hover {
          opacity: 1 !important;
          filter: brightness(1.25);
        }
        #combat-timer-panel #ctp-post-bars:hover,
        #combat-timer-panel #ctp-post-players:hover {
          filter: brightness(1.15);
        }
        #ctp-reopen:hover {
          filter: brightness(1.3);
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

    let panel = buildPanel();
    injectPanelStyles();

    // Note: a scene-controls toolbar button was attempted and abandoned.
    // getSceneControlButtons fires exactly once, very early during Foundry's
    // own boot sequence - before a @run-at document-idle Tampermonkey script
    // can possibly attach a listener - and ui.controls.render() does not
    // re-invoke it afterward (confirmed via logging: the hook never fired,
    // despite ui.controls being fully initialized and rendered by the time
    // we checked). This is a structural timing mismatch, not a fixable bug.
    // The floating ⚔️ reopen button (buildReopenButton(), left-middle of the
    // screen) is the only entry point back into the panel once closed.

    function segmentRowHTML(seg) {
      const s = Math.round(segMs(seg) / 1000);
      const live = seg.end === null;
      const triggerIcon = seg.trigger === "pause" ? "⏸ " : seg.trigger === "split" ? "✂️ " : (seg.trigger === "unpause" || seg.trigger === "resume") ? "▶ " : "";
      const who = !seg.combatantId ? "(no combat)" : `${isPlayerControlled(seg) ? "🧑" : "👹"} ${escapeHtml(seg.combatantName)}`;
      const defTag = seg.defeated ? " 💀" : "";
      const overrideTag = seg.overrideOwnerId ? ` → ${escapeHtml(game.users.get(seg.overrideOwnerId)?.name ?? "?")}` : "";
      const buttons = Object.entries(CATEGORY_META).map(([key, meta]) => `
        <span data-seg-id="${seg.id}" data-cat="${key}"
          style="cursor:pointer; padding:1px 5px; border-radius:4px; font-size:11px;
                 ${seg.category === key ? "background:#4b3fa0;" : "opacity:0.35;"}">
          ${meta.icon}
        </span>`).join("");

      let picker = "";
      if (playerPickerSegId === seg.id) {
        const players = getCombatPlayers();
        const chips = [
          `<span data-seg-id="${seg.id}" data-owner-pick="__default__"
             style="cursor:pointer; padding:1px 6px; border-radius:4px; font-size:10px; margin:2px;
                    opacity:0.7; border:1px dashed rgba(255,255,255,0.35);">↩ Default</span>`,
          ...players.map((p) => `
            <span data-seg-id="${seg.id}" data-owner-pick="${p.ownerId}"
              style="cursor:pointer; padding:1px 6px; border-radius:4px; font-size:10px; margin:2px;
                     background:${p.color}; color:#fff;">${escapeHtml(p.name)}</span>`),
        ].join("");
        picker = `<div style="margin-top:3px; padding-top:3px; border-top:1px dashed rgba(255,255,255,0.15);">${chips}</div>`;
      }

      return `
        <div style="padding:3px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
          <div style="display:flex; justify-content:space-between; font-size:11px;">
            <span>${triggerIcon}${who}${overrideTag}${defTag}${live ? " ●" : ""}</span>
            <span>${formatDuration(s)}</span>
          </div>
          <div style="margin-top:2px;">${buttons}</div>
          ${picker}
        </div>`;
    }

    function renderPanel() {
      persist();
      if (!panelVisible || !document.body.contains(panel)) return;

      // Toolbar: split button + session tabs, all equal width so it looks
      // like one consistent row of buttons.
      const toolbarEl = panel.querySelector("#ctp-toolbar");
      const tabs = [
        { key: "current", label: "🟢 Now", available: true },
        { key: "prev1", label: "📦 -1", available: !!sessionHistory[0] },
        { key: "prev2", label: "📦 -2", available: !!sessionHistory[1] },
      ];
      const splitHTML = `
        <span data-action="split" style="flex:1; text-align:center; cursor:pointer; padding:3px 2px;
              border-radius:4px; opacity:0.75;">✂️</span>`;
      const tabsHTML = tabs.map((t) => `
        <span data-session="${t.key}" data-available="${t.available}"
          style="flex:1; text-align:center; padding:3px 2px; border-radius:4px;
                 cursor:${t.available ? "pointer" : "default"};
                 ${selectedSession === t.key ? "background:#4b3fa0;" : ""}
                 opacity:${t.available ? (selectedSession === t.key ? "1" : "0.6") : "0.25"};">${t.label}</span>
      `).join("");
      toolbarEl.innerHTML = splitHTML + tabsHTML;

      toolbarEl.querySelector('[data-action="split"]').addEventListener("click", () => {
        if (!currentSegment) {
          alert("No segment is currently running (no active combat right now).");
          return;
        }
        splitCurrentSegment();
        renderPanel();
      });
      toolbarEl.querySelectorAll("[data-session]").forEach((el) => {
        el.addEventListener("click", () => {
          if (el.dataset.available !== "true") return;
          selectedSession = el.dataset.session;
          renderPanel();
        });
      });

      // Reset/New icon changes meaning depending on which tab is selected.
      const resetEl = panel.querySelector("#ctp-reset");
      if (selectedSession === "current") {
        resetEl.textContent = "🆕";
        resetEl.title = "Start a new session now (archives the current one, nothing is lost)";
      } else {
        resetEl.textContent = "🗑️";
        resetEl.title = "Permanently delete this archived session";
      }

      const statusEl = panel.querySelector("#ctp-status");
      if (selectedSession !== "current") {
        const idx = selectedSession === "prev1" ? 0 : 1;
        const hist = sessionHistory[idx];
        const when = hist ? new Date(hist.endedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "";
        statusEl.innerHTML = `📦 Archived session (ended ${when})<br>
          <span style="opacity:0.7;">Total pause (real): ${formatDuration(totalPausedRealS())}</span>`;
      } else {
        const combat = game.combat;
        const pausedTag = game.paused ? " ⏸ Paused" : "";
        let next = "";
        if (combat?.turns?.length) {
          const n = combat.turns[(combat.turn + 1) % combat.turns.length];
          if (n) next = ` · Next: ${escapeHtml(n.name)}`;
        }
        statusEl.innerHTML = `${combat ? "Combat active" : "No active combat"}${pausedTag}${next}<br>
          <span style="opacity:0.7;">Total pause (real): ${formatDuration(totalPausedRealS())}</span>`;
      }

      const rowsEl = panel.querySelector("#ctp-rows");
      const rows = perCombatantStats()
        .sort((a, b) => b.totalMs - a.totalMs)
        .map((e) => {
          const s = Math.round(e.totalMs / 1000);
          const avg = e.turnCount > 0 ? ` · Ø ${formatDuration(Math.round(s / e.turnCount))}` : "";
          return `<div style="display:flex; align-items:center; gap:6px; padding:2px 0;">
            <span style="width:8px; height:8px; border-radius:50%; background:${e.color}; flex-shrink:0;"></span>
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              🧑 ${escapeHtml(e.name)}
            </span>
            <span style="opacity:0.85; font-size:11px;">${formatDuration(s)}${avg}</span>
          </div>`;
        }).join("");
      rowsEl.innerHTML = rows || `<div style="opacity:0.5">–</div>`;

      const agg = npcAggregate();
      const cat = categoryTotals();
      panel.querySelector("#ctp-footer").innerHTML = `
        ${agg.turns ? `👹 Monsters total: ${formatDuration(agg.totalS)} · Ø ${formatDuration(agg.avgS)}/turn<br>` : ""}
        🎲 GM: ${formatDuration(cat.dmS)} · 👥 Team: ${formatDuration(cat.teamS)} · 🛠️ Setup: ${formatDuration(cat.setupS)}
      `;

      const segEl = panel.querySelector("#ctp-segments");
      const { segs: viewSegs, current: viewCurrent } = getSelectedSessionData();
      const list = [viewCurrent, ...viewSegs.slice().reverse()].filter(Boolean).slice(0, 15);
      segEl.innerHTML = list.map(segmentRowHTML).join("");
      segEl.querySelectorAll("[data-cat]").forEach((el) => {
        el.addEventListener("click", () => {
          const seg = findSegment(el.dataset.segId);
          if (!seg) return;
          const cat = el.dataset.cat;
          if (cat === "player") {
            // Don't assign immediately - open the picker so a specific
            // player can be chosen instead of always the technical owner.
            playerPickerSegId = playerPickerSegId === seg.id ? null : seg.id;
            renderPanel();
            return;
          }
          seg.category = cat;
          seg.overrideOwnerId = null;
          playerPickerSegId = null;
          renderPanel();
        });
      });
      segEl.querySelectorAll("[data-owner-pick]").forEach((el) => {
        el.addEventListener("click", () => {
          const seg = findSegment(el.dataset.segId);
          if (!seg) return;
          seg.category = "player";
          seg.overrideOwnerId = el.dataset.ownerPick === "__default__" ? null : el.dataset.ownerPick;
          playerPickerSegId = null;
          renderPanel();
        });
      });
    }

    setInterval(renderPanel, 1000);
  }
})();
