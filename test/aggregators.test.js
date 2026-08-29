// The session-stats aggregators (perCombatantStats() excluded - it still
// resolves names/colors from game.users, so it stays inside init()). Each
// of these used to read allSegments() (whichever session the panel has
// selected) directly; they now take a `segs` array parameter instead, so
// the exact same aggregator can be pointed at two different sessions'
// data - see the last test below for that in action.
// Run with: node --test

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  lastLiveOwnerByCombatant, effectiveOwner, npcAggregate, categoryTotals,
  buildTurnSlots, ownTurnSlotsByOwner, betweenTurnStats, turnWindowStats,
  absoluteWaitStats, sessionTotalMs, countsForGM, gmTotalStats, gmRoundStats,
} = require("../foundry-combat-timer.user.js");

// Minimal segment builder - only the fields a given test actually cares
// about need overriding; the rest default to "a normal player turn".
function seg(overrides) {
  return {
    id: "s", start: 0, end: 1000, trigger: "turn", combatId: "c1", round: 1,
    turnIndex: 0, combatantId: "pc1", combatantName: "Hero", actorId: "a1",
    actorType: "character", ownerId: "p1", overrideOwnerId: null,
    defeated: false, category: "player",
    ...overrides,
  };
}

test("buildTurnSlots partitions on turn/resume and absorbs everything after", () => {
  const segs = [
    seg({ id: "a", start: 0, end: 100, trigger: "turn", ownerId: "p1" }),
    seg({ id: "b", start: 100, end: 150, trigger: "pause", ownerId: "p1" }),
    seg({ id: "c", start: 150, end: 250, trigger: "turn", ownerId: null, category: "gm" }),
  ];
  const slots = buildTurnSlots(segs);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].designatedOwner, "p1");
  assert.equal(slots[0].end, 150); // extended by the trailing pause
  assert.deepEqual(slots[0].segments.map((s) => s.id), ["a", "b"]);
  assert.equal(slots[1].designatedOwner, null);
  assert.deepEqual(slots[1].segments.map((s) => s.id), ["c"]);
});

test("buildTurnSlots: an 'ignore' segment breaks the current slot without joining any slot", () => {
  const segs = [
    seg({ id: "a", start: 0, end: 100, trigger: "turn" }),
    seg({ id: "b", start: 100, end: 200, trigger: "pause", category: "ignore" }),
    seg({ id: "c", start: 200, end: 300, trigger: "unpause" }), // not itself a turn-start trigger
  ];
  const slots = buildTurnSlots(segs);
  assert.equal(slots.length, 2); // the ignored gap forces a fresh slot even though "unpause" doesn't normally open one
  assert.deepEqual(slots[0].segments.map((s) => s.id), ["a"]);
  assert.deepEqual(slots[1].segments.map((s) => s.id), ["c"]);
});

test("sessionTotalMs subtracts ignored time without shrinking the span otherwise", () => {
  const segs = [
    seg({ start: 0, end: 1000, category: "player" }),
    seg({ start: 1000, end: 2000, category: "ignore" }),
    seg({ start: 2000, end: 3000, category: "player" }),
  ];
  assert.equal(sessionTotalMs(segs), 2000); // 3000 span minus the 1000ms gap
  assert.equal(sessionTotalMs([]), 0);
});

test("categoryTotals sums team/setup independent of combat context", () => {
  const segs = [
    seg({ category: "team", start: 0, end: 500, combatantId: null }),
    seg({ category: "setup", start: 500, end: 800, combatantId: null }),
    seg({ category: "player", start: 800, end: 900 }),
  ];
  assert.deepEqual(categoryTotals(segs), { teamMs: 500, setupMs: 300 });
});

test("effectiveOwner: a defeated NPC's instant-skip inherits its last real owner", () => {
  const realTurn = seg({ id: "gob-turn", combatantId: "gob1", ownerId: null, overrideOwnerId: "p1", defeated: false, category: "player" });
  const instantSkip = seg({ id: "gob-skip", combatantId: "gob1", ownerId: null, overrideOwnerId: null, defeated: true, actorType: "npc", category: "gm" });
  const lastLiveOwner = lastLiveOwnerByCombatant([realTurn, instantSkip]);
  assert.equal(lastLiveOwner.get("gob1"), "p1");
  assert.equal(effectiveOwner(instantSkip, lastLiveOwner), "p1");
});

test("effectiveOwner: a manual 'gm' recategorization wins over the technical ownerId", () => {
  const s = seg({ ownerId: "p1", category: "gm", overrideOwnerId: null, defeated: false });
  assert.equal(effectiveOwner(s, new Map()), null); // category === "gm" short-circuits the ownerId branch
});

test("npcAggregate: an unclaimed monster's turn counts fully, its defeated instant-skip counts toward time but not turns", () => {
  const realTurn = seg({ id: "t1", combatantId: "gob1", ownerId: null, category: "gm", start: 0, end: 1000, defeated: false });
  const instantSkip = seg({ id: "t2", combatantId: "gob1", ownerId: null, category: "gm", start: 1000, end: 1010, defeated: true, actorType: "npc" });
  const result = npcAggregate([realTurn, instantSkip]);
  assert.equal(result.turns, 1);
  assert.equal(result.totalS, 1); // 1010ms rounds to 1s
});

test("npcAggregate excludes a manually-recategorized 'gm' segment that still has a real ownerId", () => {
  const claimed = seg({ combatantId: "pc1", ownerId: "p1", category: "gm" }); // human override, not "a monster's turn"
  assert.equal(npcAggregate([claimed]).totalS, 0);
});

test("countsForGM / gmTotalStats / gmRoundStats", () => {
  const segs = [
    seg({ combatantId: "gob1", ownerId: null, category: "gm", start: 0, end: 1000, round: 1, defeated: false }),
    seg({ combatantId: "gob1", ownerId: null, category: "gm", start: 1000, end: 1010, round: 1, defeated: true, actorType: "npc" }),
  ];
  const lastLiveOwner = lastLiveOwnerByCombatant(segs);
  assert.equal(countsForGM(segs[0], lastLiveOwner), true);
  assert.equal(countsForGM(segs[1], lastLiveOwner), true);

  const totals = gmTotalStats(segs);
  assert.equal(totals.totalMs, 1010);
  assert.equal(totals.byEntity.length, 1);
  assert.equal(totals.byEntity[0].ms, 1010);

  const rounds = gmRoundStats(segs);
  assert.equal(rounds.roundCount, 1);
  assert.equal(rounds.avgMs, 1010);
});

test("gmRoundStats counts a quiet round (no GM time) in the denominator", () => {
  const segs = [
    seg({ combatantId: "gob1", ownerId: null, category: "gm", start: 0, end: 1000, round: 1 }),
    seg({ combatantId: "pc1", ownerId: "p1", category: "player", start: 1000, end: 2000, round: 2 }), // round 2 has no GM time at all
  ];
  const rounds = gmRoundStats(segs);
  assert.equal(rounds.roundCount, 2);
  assert.equal(rounds.avgMs, 500); // 1000ms of GM time averaged over 2 rounds
});

// A small multi-round scenario shared by the next few tests: p1 takes two
// turns (round 1 and round 2) with a monster's turn in between.
function twoRoundScenario() {
  return [
    seg({ id: "t1", combatantId: "pc1", ownerId: "p1", category: "player", trigger: "turn", start: 0, end: 1000, round: 1 }),
    seg({ id: "t2", combatantId: "gob1", ownerId: null, category: "gm", trigger: "turn", start: 1000, end: 2000, round: 1 }),
    seg({ id: "t3", combatantId: "pc1", ownerId: "p1", category: "player", trigger: "turn", start: 2000, end: 3500, round: 2 }),
  ];
}

test("betweenTurnStats: the gap between a player's own consecutive turns excludes anyone else's turn in between", () => {
  const gaps = betweenTurnStats(twoRoundScenario());
  const p1 = gaps.get("p1");
  assert.equal(p1.count, 1);
  assert.equal(p1.avgMs, 1000); // t3 starts at 2000, t1 ended at 1000
});

test("turnWindowStats: windows partition the player's whole credited timeline with no gaps or overlaps", () => {
  const segs = twoRoundScenario();
  const windows = turnWindowStats(segs).get("p1");
  assert.equal(windows.windows.length, 2);
  const sumMs = windows.windows.reduce((sum, w) => sum + w.ms, 0);
  // Documented invariant: this sum always equals perCombatantStats()'s
  // totalMs for the same player - verified directly here without needing
  // perCombatantStats() itself (which requires game.users to resolve names).
  const p1CreditedMs = segs
    .filter((s) => effectiveOwner(s, lastLiveOwnerByCombatant(segs)) === "p1")
    .reduce((sum, s) => sum + (s.end - s.start), 0);
  assert.equal(sumMs, p1CreditedMs);
  assert.equal(sumMs, 2500);
  assert.equal(windows.avgMs, 1250);
});

test("absoluteWaitStats: wait is session span minus a player's own active time", () => {
  const segs = twoRoundScenario();
  const wait = absoluteWaitStats(segs);
  // Span 0-3500 (3500ms); p1 active for t1 (1000) + t3 (1500) = 2500ms.
  assert.equal(wait.get("p1"), 1000);
  assert.equal(wait.has(null), false); // the unclaimed monster's turn never gets a wait entry
});

test("ownTurnSlotsByOwner only counts a player's own real turn-opening slots", () => {
  const { byOwner, spanStart, spanEnd } = ownTurnSlotsByOwner(twoRoundScenario());
  assert.equal(byOwner.get("p1").length, 2);
  assert.equal(byOwner.has(null), false); // the GM/monster slot has no designatedOwner
  assert.equal(spanStart, 0);
  assert.equal(spanEnd, 3500);
});

test("session comparison: the same aggregator applied to two independent sessions never mixes their data", () => {
  const sessionA = twoRoundScenario();
  const sessionB = [
    seg({ id: "u1", combatantId: "pc2", ownerId: "p2", category: "player", trigger: "turn", start: 0, end: 5000, round: 1 }),
  ];
  const totalA = sessionTotalMs(sessionA);
  const totalB = sessionTotalMs(sessionB);
  assert.equal(totalA, 3500);
  assert.equal(totalB, 5000);
  // Calling it on A again afterward gives the same result back - no shared
  // mutable state leaking between calls (there isn't any; both aggregators
  // are pure functions of the array they're handed).
  assert.equal(sessionTotalMs(sessionA), totalA);
});
