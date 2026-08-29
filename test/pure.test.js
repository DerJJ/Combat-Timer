// Exercises the pure helpers exported (Node-only, see the module.exports
// guard at the end of foundry-combat-timer.user.js) directly against the
// exact file Tampermonkey runs - no build step, no second copy of the logic.
// Run with: node --test

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatDuration, formatClock, formatArchiveLabel, escapeHtml,
  parseHexRgb, darkenHex, relLuminance, labelColorOn, hashToHex, hslToHex, pct,
  PC_ACTOR_TYPE, isPcActorType, hasCombatContext, resolvedOwner, isPlayerControlled,
  isRealTurn, isTurnStart, segMs, defaultCategory,
  MAX_BAR_ENTITIES, orderAndShade, capEntities, mergeAlienEntities,
  gaussianRandom, randomGaussianDurationMs,
} = require("../foundry-combat-timer.user.js");

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(5), "5s");
  assert.equal(formatDuration(59), "59s");
  assert.equal(formatDuration(60), "1m00s");
  assert.equal(formatDuration(65), "1m05s");
  assert.equal(formatDuration(-5), "0s"); // clamped, never a negative duration
});

test("escapeHtml", () => {
  assert.equal(escapeHtml(`<b class="x">&'</b>`), "&lt;b class=&quot;x&quot;&gt;&amp;&#39;&lt;/b&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
});

test("formatClock is 24h and zero-padded regardless of locale", () => {
  const ts = new Date(2024, 0, 1, 5, 3).getTime(); // 05:03 local
  assert.equal(formatClock(ts), "05:03");
  const pm = new Date(2024, 0, 1, 23, 59).getTime();
  assert.equal(formatClock(pm), "23:59");
});

test("formatArchiveLabel includes month, day, and the 24h clock", () => {
  const ts = new Date(2024, 7, 12, 14, 3).getTime(); // Aug 12, 14:03
  const label = formatArchiveLabel(ts);
  assert.match(label, /Aug/);
  assert.match(label, /12/);
  assert.match(label, /14:03/);
});

test("parseHexRgb", () => {
  assert.deepEqual(parseHexRgb("#ff0000"), [255, 0, 0]);
  assert.deepEqual(parseHexRgb("00ff00"), [0, 255, 0]); // leading # optional
  assert.equal(parseHexRgb("not-a-color"), null);
  assert.equal(parseHexRgb(undefined), null);
});

test("darkenHex", () => {
  assert.equal(darkenHex("#ffffff", 0), "#000000");
  assert.equal(darkenHex("#ff0000", 0.5), "#800000");
  assert.equal(darkenHex("nonsense", 0.5), "nonsense"); // unparseable input passed through
});

test("relLuminance / labelColorOn pick readable label color", () => {
  assert.ok(relLuminance("#ffffff") > relLuminance("#000000"));
  assert.equal(labelColorOn("#ffffff"), "rgba(0,0,0,0.62)"); // bright fill -> dark label
  assert.equal(labelColorOn("#000000"), "rgba(255,255,255,0.85)"); // dark fill -> light label
});

test("hashToHex/hslToHex are deterministic and produce valid hex", () => {
  assert.equal(hashToHex("same-id"), hashToHex("same-id"));
  assert.notEqual(hashToHex("id-a"), hashToHex("id-b"));
  assert.match(hashToHex("whatever"), /^#[0-9a-f]{6}$/);
});

test("pct", () => {
  assert.equal(pct(1, 4), 25);
  assert.equal(pct(0, 0), 0); // no division by zero
  assert.equal(pct(5, 0), 0);
});

test("isPcActorType matches only the configured PC actor type", () => {
  assert.equal(isPcActorType(PC_ACTOR_TYPE), true);
  assert.equal(isPcActorType("npc"), false);
  assert.equal(isPcActorType(null), false);
});

test("hasCombatContext / resolvedOwner / isPlayerControlled", () => {
  assert.equal(hasCombatContext({ combatantId: "c1" }), true);
  assert.equal(hasCombatContext({ combatantId: null }), false);
  // overrideOwnerId wins over ownerId
  assert.equal(resolvedOwner({ overrideOwnerId: "p1", ownerId: "p2" }), "p1");
  assert.equal(resolvedOwner({ overrideOwnerId: null, ownerId: "p2" }), "p2");
  assert.equal(resolvedOwner({}), null);
  assert.equal(isPlayerControlled({ ownerId: "p1" }), true);
  assert.equal(isPlayerControlled({}), false);
});

test("isRealTurn: a defeated PC still counts, a defeated NPC's instant-skip doesn't", () => {
  assert.equal(isRealTurn({ combatantId: "c1", defeated: true, actorType: PC_ACTOR_TYPE }), true);
  assert.equal(isRealTurn({ combatantId: "c1", defeated: true, actorType: "npc" }), false);
  assert.equal(isRealTurn({ combatantId: "c1", defeated: false, actorType: "npc" }), true);
  assert.equal(isRealTurn({ combatantId: null, defeated: false, actorType: PC_ACTOR_TYPE }), false);
});

test("isTurnStart only fires for turn/resume", () => {
  assert.equal(isTurnStart({ trigger: "turn" }), true);
  assert.equal(isTurnStart({ trigger: "resume" }), true);
  assert.equal(isTurnStart({ trigger: "pause" }), false);
  assert.equal(isTurnStart({ trigger: "split" }), false);
});

test("segMs uses the explicit end when present", () => {
  assert.equal(segMs({ start: 1000, end: 4500 }), 3500);
});

test("defaultCategory: non-pause triggers default by ownership", () => {
  assert.equal(defaultCategory("turn", null, "player-1"), "player");
  assert.equal(defaultCategory("turn", null, null), "gm"); // unowned turn is GM's by default, not "player"
  assert.equal(defaultCategory("resume", null, null), "gm");
});

test("defaultCategory: pause right after a short GM-owned segment defaults to setup", () => {
  const shortPrev = { start: 0, end: 2000, category: "gm" }; // 2s, under the 5s threshold
  assert.equal(defaultCategory("pause", shortPrev, null), "setup");
});

test("defaultCategory: pause after a long segment carries over its category", () => {
  const longPrev = { start: 0, end: 10_000, category: "team" }; // 10s, over the threshold
  assert.equal(defaultCategory("pause", longPrev, null), "team");
});

test("defaultCategory: pause never inherits 'ignore' from the previous segment", () => {
  const ignoredPrev = { start: 0, end: 2000, category: "ignore" };
  assert.equal(defaultCategory("pause", ignoredPrev, null), "setup"); // falls through to the gmOwned default instead
});

test("defaultCategory: pause on a now-player-owned segment never inherits 'setup'", () => {
  const setupPrev = { start: 0, end: 10_000, category: "setup" };
  assert.equal(defaultCategory("pause", setupPrev, "player-1"), "player");
});

test("orderAndShade puts the primary last/rightmost at full shade", () => {
  const items = ["a", "b", "c"];
  const result = orderAndShade(items, (x) => x === "b");
  assert.equal(result.at(-1).item, "b");
  assert.equal(result.at(-1).shade, 1);
  assert.ok(result[0].shade < result.at(-1).shade);
});

test("orderAndShade with no primary match anchors on the last item", () => {
  const items = ["a", "b", "c"];
  const result = orderAndShade(items, () => false);
  assert.equal(result.at(-1).item, "c");
});

test("capEntities passes through when under the cap", () => {
  const items = [{ ms: 1 }, { ms: 2 }];
  assert.equal(capEntities(items, (i) => i.ms, () => false, 4), items);
});

test("capEntities merges everything past the cap into one '+N more' item, keeping the primary", () => {
  const items = Array.from({ length: 6 }, (_, i) => ({
    combatantId: `c${i}`, name: `E${i}`, ms: i, inTurnMs: i, outOfTurnMs: 0, pausedMs: 0, turnCount: 1,
  }));
  const primary = items[2];
  const result = capEntities(items, (i) => i.ms, (i) => i === primary, MAX_BAR_ENTITIES);
  assert.equal(result.length, MAX_BAR_ENTITIES);
  assert.equal(result[0].combatantId, "__more__"); // merged item is placed first (darkest/leftmost)
  assert.ok(result.includes(primary)); // the primary is never merged away
  const merged = result[0];
  const keptIds = new Set(result.filter((it) => it !== merged).map((it) => it.combatantId));
  const mergedSum = items.filter((it) => it !== primary && !keptIds.has(it.combatantId))
    .reduce((sum, it) => sum + it.ms, 0);
  assert.equal(merged.ms, mergedSum);
});

test("mergeAlienEntities folds redirected-only time into the primary entity", () => {
  const primary = { combatantId: "pc", inTurnMs: 100, outOfTurnMs: 0, pausedMs: 0, turnCount: 1 };
  const alien = { combatantId: "monster", inTurnMs: 0, outOfTurnMs: 50, pausedMs: 10, turnCount: 1 };
  const result = mergeAlienEntities([primary, alien], (e) => e === primary);
  assert.equal(result.length, 1);
  assert.equal(result[0].outOfTurnMs, 50);
  assert.equal(result[0].pausedMs, 10);
});

test("mergeAlienEntities does nothing when no entity has any inTurnMs", () => {
  const byEntity = [
    { combatantId: "a", inTurnMs: 0, outOfTurnMs: 10, pausedMs: 0, turnCount: 0 },
    { combatantId: "b", inTurnMs: 0, outOfTurnMs: 5, pausedMs: 0, turnCount: 0 },
  ];
  assert.equal(mergeAlienEntities(byEntity, () => false), byEntity);
});

test("randomGaussianDurationMs always stays within [min, max]", () => {
  for (let i = 0; i < 500; i++) {
    const v = randomGaussianDurationMs(30_000, 210_000);
    assert.ok(v >= 30_000 && v <= 210_000, `${v} out of range`);
  }
});

test("gaussianRandom is not clamped by itself (sanity: produces varying values)", () => {
  const samples = Array.from({ length: 20 }, () => gaussianRandom(0, 1));
  assert.ok(new Set(samples).size > 1);
});
