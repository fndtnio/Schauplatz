"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { compile, sample, prolog } = require("../lang.js");

// Compile and assert no errors; returns objects keyed by name.
function scene(src) {
  const out = compile(src);
  assert.deepEqual(out.errors, [], "expected no errors");
  return Object.fromEntries(out.objects.map((o) => [o.name, o]));
}

function errorsOf(src) {
  return compile(src).errors.map((e) => e.msg);
}

// ------------------------------------------------------------------ parsing

test("defaults: box 1x1x1, sphere r 0.5, cylinder r 0.5 h 1, resting at origin", () => {
  const s = scene("box b\nsphere s at(3 3 3)\ncylinder c at(5 0.5 0)");
  assert.deepEqual(s.b.pos, [0, 0.5, 0]);
  assert.deepEqual(s.b.dims, { w: 1, h: 1, d: 1 });
  assert.deepEqual(s.s.dims, { w: 1, h: 1, d: 1 });
  assert.deepEqual(s.c.dims, { w: 1, h: 1, d: 1 });
});

test("default placement rests on the ground: y is half the height", () => {
  const s = scene("box slab size(2 0.4 2)\nsphere orb r(0.75) at(2 0.75 0)");
  assert.deepEqual(s.slab.pos, [0, 0.2, 0]);
});

test("at(x z) rests on the ground at that spot; at(x y z) places the center", () => {
  const s = scene("cylinder alice at(-3 0) h(0.5)\nsphere ball at(2 4)\nbox crate size(1 2 1) at(5 -1)");
  assert.deepEqual(s.alice.pos, [-3, 0.25, 0]); // her own rest height, not center-sunk
  assert.deepEqual(s.ball.pos, [2, 0.5, 4]);
  assert.deepEqual(s.crate.pos, [5, 1, -1]);
});

test("at(x z) on rooms and tubes keeps the base on the ground (structure convention)", () => {
  const s = scene("room cell size(2 2 2) at(4 6)\ntube well r(0.3) h(4) at(-4 0)");
  assert.deepEqual(s.cell.pos, [4, 0, 6]); // group origin = base
  const posed = sample(compile("tube well r(0.3) h(4) at(-4 0)"), 0).objects;
  assert.equal(posed.find((o) => o.name === "well-seg-1").pos[1], 2); // still standing
});

test("at(x z) bakes through part scale()", () => {
  const s = scene("part perch\n  box seat size(1 0.2 1) at(3 -2)\nend\nperch p scale(2)");
  assert.deepEqual(s["p-seat"].pos, [6, 0.2, -4]); // x/z scaled, rest height from scaled size
});

test("at() arity errors teach both numeric forms", () => {
  assert.match(errorsOf("box b at(1)")[0], /at\(x y z\), at\(x z\) to rest on the ground/);
});

test("commas and spaces both separate arguments", () => {
  const s = scene("box a size(1, 2, 3)\nbox b size(1 2 3)");
  assert.deepEqual(s.a.dims, s.b.dims);
});

test("comments and blank lines are ignored", () => {
  const s = scene("// header\n\nbox b // trailing\n\n// ? overlaps(x y)\n");
  assert.equal(Object.keys(s).length, 1);
});

test("# is not a comment (// is the only style); hex colors are untouched", () => {
  const s = scene("box b color(#8b5e3c)");
  assert.equal(s.b.color, "#8b5e3c");
  assert.equal(compile("# not a comment").errors.length, 1);
});

test("properties parse: at, color, rotate, size", () => {
  const s = scene("box b size(2 1 0.5) at(1 5 -2) color(#abc123) rotate(0 45 0)");
  assert.deepEqual(s.b.pos, [1, 5, -2]);
  assert.equal(s.b.color, "#abc123");
  assert.deepEqual(s.b.rot, [0, 45, 0]);
});

// ---------------------------------------------------------------- placement

test("on(): sits exactly on top of the target", () => {
  const s = scene("box base size(2 1 2)\nsphere ball r(0.25) on(base)");
  assert.deepEqual(s.ball.pos, [0, 1.25, 0]); // base top 1 + radius 0.25
});

test("above()/below() use the gap (default 0.5)", () => {
  const s = scene(
    "box base size(1 1 1) at(0 3 0)\n" +
      "box up above(base)\n" +
      "box up2 above(base 2)\n" +
      "box down below(base)",
  );
  assert.deepEqual(s.up.pos, [0, 4.5, 0]);
  assert.deepEqual(s.up2.pos, [0, 6, 0]);
  assert.deepEqual(s.down.pos, [0, 1.5, 0]);
});

test("walls(0): an open room — ground pad, interior bounds, no walls", () => {
  const c = compile(
    "room front_yard size(10 2.5 6) walls(0)\n" +
      "cylinder visitor r(0.25) h(1.6) at(front_yard 2 1)\n" +
      "box hedge size(1 1 1) at(front_yard -3 0)\n" +
      "? in(visitor front_yard)\n" +
      "? sees(visitor hedge)",
  );
  assert.deepEqual(c.errors, []);
  const members = c.objects.filter((o) => o.parent === "front_yard");
  assert.deepEqual(members.map((m) => m.name), ["front_yard-ground"]); // a pad, no walls
  assert.equal(c.results[0].value, true); // in() works at person height
  assert.equal(c.results[1].value, true); // nothing blocks across the yard
  assert.match(errorsOf("room y walls(0) door(south)")[0], /open room .* no walls for doors/);
  assert.match(errorsOf("room y walls(0) window(south)")[0], /open room .* no walls for doors/);
});

test("shift(dx dz): a nudge after placement — composes with relations", () => {
  const c = compile(
    "room study\n" +
      "room hall east-of(study) size(1 2.5 8) shift(0 -2) door(to study)\n" +
      "box crate on(hall) shift(0.5 0)",
  );
  assert.deepEqual(c.errors, []);
  const h = c.objects.find((o) => o.name === "hall");
  assertNear(h.pos, [2.9, 0, -2]); // centered by the relation, slid 2 north
  assert.ok(c.adjacency.has("hall|study")); // the door still carves
  assert.match(errorsOf("box b shift(1)")[0], /shift\(\): expected dx dz/);
});

test("horizontal relations rest on the anchor's base — floors propagate", () => {
  const c = compile(
    "room shaft size(1.6 2.5 1.6)\n" +
      "room upper_hall above(shaft 0.4)\n" +
      "room bedroom south-of(upper_hall) door(to upper_hall)\n" +
      "cylinder kid r(0.2) h(1.3) at(bedroom 0 0)",
  );
  assert.deepEqual(c.errors, []);
  assert.ok(Math.abs(c.objects.find((o) => o.name === "upper_hall").pos[1] - 2.9) < 1e-9);
  assert.ok(Math.abs(c.objects.find((o) => o.name === "bedroom").pos[1] - 2.9) < 1e-9); // inherited the floor
  assertNear(c.objects.find((o) => o.name === "kid").pos, [0, 3.55, 4.4]); // south (+z) of the hall, standing on floor 2
  assert.ok(c.adjacency.has("bedroom|upper_hall")); // doors carve at elevation
});

test("legacy relation names error with the compass mapping", () => {
  assert.match(errorsOf("box a\nbox b left-of(a)")[0], /left-of\(\) is now west-of\(\)/);
  assert.match(errorsOf("box a\nbox b behind(a)")[0], /behind\(\) is now north-of\(\)/);
});

test("horizontal relations offset x/z and rest the object on the ground", () => {
  const s = scene(
    "box base size(2 4 2) at(0 2 0)\n" +
      "sphere l r(0.5) west-of(base)\n" +
      "sphere r r(0.5) east-of(base 1)\n" +
      "sphere f r(0.5) south-of(base)\n" +
      "sphere b r(0.5) north-of(base)",
  );
  assert.deepEqual(s.l.pos, [-1.75, 0.5, 0]); // 1 + 0.25 gap + 0.5
  assert.deepEqual(s.r.pos, [2.5, 0.5, 0]); // 1 + 1 gap + 0.5
  assert.deepEqual(s.f.pos, [0, 0.5, 1.75]);
  assert.deepEqual(s.b.pos, [0, 0.5, -1.75]);
});

test("placement chains resolve regardless of definition order", () => {
  const s = scene("sphere top r(0.5) on(mid)\nbox mid on(base)\nbox base size(1 2 1)");
  assert.deepEqual(s.base.pos, [0, 1, 0]);
  assert.deepEqual(s.mid.pos, [0, 2.5, 0]);
  assert.deepEqual(s.top.pos, [0, 3.5, 0]);
});

// ------------------------------------------------------------------- errors

test("error: duplicate names report the original line", () => {
  const msgs = errorsOf("box a\nbox a");
  assert.match(msgs[0], /already defined on line 1/);
});

test("error: unknown shape, unknown property, unknown query", () => {
  assert.match(errorsOf("cone c")[0], /unknown shape "cone"/);
  assert.match(errorsOf("box b wobble(3)")[0], /unknown property/);
  assert.match(errorsOf("box a\nbox b\n? near(a b)")[0], /unknown query "near"/);
});

test("sides: cylinders only, whole number 3–64, default null (smooth)", () => {
  const s = scene("cylinder hex r(0.7) sides(8)\ncylinder smooth r(0.7) at(3 0.5 0)");
  assert.equal(s.hex.sides, 8);
  assert.equal(s.smooth.sides, null);
  assert.match(errorsOf("box b sides(6)")[0], /only cylinders/);
  assert.match(errorsOf("cylinder c sides(2)")[0], /3 to 64/);
  assert.match(errorsOf("cylinder c sides(4.5)")[0], /whole number/);
});

test("error: bad arguments", () => {
  assert.match(errorsOf("box b size(1 2)")[0], /expected 3 numbers/);
  assert.match(errorsOf("sphere s r(nope)")[0], /positive number/);
  assert.match(errorsOf("sphere s r(-1)")[0], /positive number/);
  assert.match(errorsOf("box b size(1 1 1) r(2)")[0], /boxes use size/);
});

test("error: at() and a relation are mutually exclusive; one relation max", () => {
  assert.match(errorsOf("box t\nbox b at(0 0 0) on(t)")[0], /not both/);
  assert.match(errorsOf("box t\nbox b on(t) above(t)")[0], /already has a placement/);
});

test("error: unknown relation target; object still renders at default", () => {
  const out = compile("box b on(ghost)");
  assert.match(out.errors[0].msg, /no object named "ghost"/);
  assert.deepEqual(out.objects[0].pos, [0, 0.5, 0]);
});

test("error: circular placement is reported, not a hang", () => {
  const msgs = errorsOf("box a on(b)\nbox b on(a)");
  assert.equal(msgs.filter((m) => /circular placement/.test(m)).length, 1);
});

test("errors carry line numbers and are sorted", () => {
  const out = compile("box a\ncone x\n\nbox a");
  assert.deepEqual(out.errors.map((e) => e.line), [2, 4]);
});

// ------------------------------------------------------------------ queries

test("overlaps: true when interpenetrating, false when apart", () => {
  const src =
    "box a size(2 2 2) at(0 1 0)\n" +
    "box b size(2 2 2) at(1 1 1)\n" +
    "box c size(1 1 1) at(9 0.5 0)\n";
  const out = compile(src + "? overlaps(a b)\n? overlaps(a c)");
  assert.deepEqual(out.results.map((r) => r.value), [true, false]);
});

test("overlaps: touching (resting on) does not count", () => {
  const out = compile("box base\nsphere ball r(0.5) on(base)\n? overlaps(ball base)");
  assert.equal(out.results[0].value, false);
});

test("distance: center-to-center, rounded to 2 decimals", () => {
  const out = compile("box a at(0 0 0)\nbox b at(3 4 0)\n? distance(a b)");
  assert.equal(out.results[0].value, 5);
  const out2 = compile("box a at(0 0 0)\nbox b at(1 1 1)\n? distance(a b)");
  assert.equal(out2.results[0].value, 1.73);
});

test("sees: true with a clear line, false when an object is in the way", () => {
  const src =
    "sphere a r(0.2) at(-3 1 0)\n" +
    "sphere b r(0.2) at(3 1 0)\n";
  assert.equal(compile(src + "? sees(a b)").results[0].value, true);
  const blocked = compile(src + "box wall size(0.5 3 3) at(0 1.5 0)\n? sees(a b)").results[0];
  assert.equal(blocked.value, false);
  assert.match(blocked.text, /blocked by wall/);
});

test("blocked-by: lists blockers nearest-first; 'nothing' when clear", () => {
  const src =
    "sphere a r(0.2) at(-3 1 0)\n" +
    "sphere b r(0.2) at(3 1 0)\n" +
    "box far size(0.2 3 3) at(1 1.5 0)\n" +
    "box near size(0.2 3 3) at(-1 1.5 0)\n";
  const out = compile(src + "? blocked-by(a b)");
  assert.deepEqual(out.results[0].value, ["near", "far"]);
  const clear = compile("box a at(0 0.5 0)\nbox b at(5 0.5 0)\n? blocked-by(a b)");
  assert.deepEqual(clear.results[0].value, []);
  assert.match(clear.results[0].text, /nothing/);
});

test("sees: endpoints' own objects never block their own sight line", () => {
  // the segment starts and ends inside a and b themselves
  const out = compile("box a size(2 2 2) at(0 1 0)\nbox b size(2 2 2) at(6 1 0)\n? sees(a b)");
  assert.equal(out.results[0].value, true);
});

test("sees: grazing a face exactly does not block (consistent with overlaps)", () => {
  const src =
    "sphere a r(0.1) at(-3 1 0)\n" +
    "sphere b r(0.1) at(3 1 0)\n" +
    "box ledge size(1 1 1) at(0 1.5 0)\n" + // bottom face exactly at y=1
    "? sees(a b)";
  assert.equal(compile(src).results[0].value, true);
});

test("sees: blocked when the line starts inside another object", () => {
  const src =
    "sphere a r(0.1) at(0 1 0)\n" +
    "sphere b r(0.1) at(5 1 0)\n" +
    "box shell size(2 2 2) at(0 1 0)\n" + // encloses a's center
    "? sees(a b)\n? blocked-by(a b)";
  const out = compile(src);
  assert.equal(out.results[0].value, false);
  assert.deepEqual(out.results[1].value, ["shell"]);
});

test("sees/blocked-by results carry sight-line data for renderers", () => {
  const out = compile(
    "sphere a r(0.1) at(-2 1 0)\nsphere b r(0.1) at(2 1 0)\n" +
      "box wall size(0.4 3 3) at(0 1.5 0)\n? sees(a b)",
  );
  const s = out.results[0].sight;
  assert.deepEqual(s.from, [-2, 1, 0]);
  assert.deepEqual(s.to, [2, 1, 0]);
  assert.equal(s.hits.length, 1);
  assert.equal(s.hits[0].name, "wall");
  assert.ok(s.hits[0].t > 0.4 && s.hits[0].t < 0.5); // wall face at x=-0.2 → t=0.45
});

test("query errors: wrong arity, unknown object", () => {
  const out = compile("box a\n? overlaps(a)\n? distance(a ghost)");
  assert.equal(out.results[0].error, true);
  assert.match(out.results[1].text, /no object or set named "ghost"/);
});

// ---------------------------------------------------------------- animation

function posAt(compiled, name, t) {
  return sample(compiled, t).objects.find((o) => o.name === name).pos;
}

test("move: interpolates from placed position; holds ends", () => {
  const c = compile("box t at(0 0.5 0)\nmove t to(4 0.5 0) over(2)");
  assert.equal(c.duration, 2);
  assert.deepEqual(posAt(c, "t", 0), [0, 0.5, 0]);
  assert.deepEqual(posAt(c, "t", 1), [2, 0.5, 0]);
  assert.deepEqual(posAt(c, "t", 2), [4, 0.5, 0]);
  assert.deepEqual(posAt(c, "t", 99), [4, 0.5, 0]); // holds after the end
});

test("move: segments chain — next starts when and where the previous ended", () => {
  const c = compile(
    "box t at(0 0.5 0)\n" +
      "move t to(4 0.5 0) over(2)\n" +
      "move t to(4 0.5 4) over(2)",
  );
  assert.equal(c.duration, 4);
  assert.deepEqual(posAt(c, "t", 3), [4, 0.5, 2]); // halfway through leg two
});

test("move: explicit start() leaves a gap where the value holds", () => {
  const c = compile(
    "box t at(0 0.5 0)\n" +
      "move t to(2 0.5 0) over(1)\n" +
      "move t to(2 0.5 2) start(3) over(1)",
  );
  assert.deepEqual(posAt(c, "t", 2), [2, 0.5, 0]); // parked between legs
  assert.deepEqual(posAt(c, "t", 3.5), [2, 0.5, 1]);
});

test("move: before an explicit start(), the object is at its placed position", () => {
  const c = compile("box t at(1 0.5 1)\nmove t to(5 0.5 1) start(2) over(1)");
  assert.deepEqual(posAt(c, "t", 1), [1, 0.5, 1]);
});

test("turn: rotates independently of move", () => {
  const c = compile(
    "box t at(0 0.5 0)\n" +
      "move t to(4 0.5 0) over(2)\n" +
      "turn t to(0 90 0) over(2)",
  );
  const posed = sample(c, 1).objects[0];
  assert.deepEqual(posed.pos, [2, 0.5, 0]);
  assert.deepEqual(posed.rot, [0, 45, 0]);
});

test("ease: bounce hits its endpoints exactly; midpoint differs from linear", () => {
  const c = compile("sphere b r(0.4) at(0 5 0)\nmove b to(0 0.4 0) over(2) ease(bounce)");
  assert.deepEqual(posAt(c, "b", 0), [0, 5, 0]);
  assert.deepEqual(posAt(c, "b", 2), [0, 0.4, 0]);
  assert.notDeepEqual(posAt(c, "b", 1), [0, 2.7, 0]); // linear midpoint
});

test("anim errors: unknown target, missing to(), bad over/start/ease", () => {
  assert.match(errorsOf("move ghost to(1 1 1)")[0], /no object named "ghost"/);
  assert.match(errorsOf("box t\nmove t over(2)")[0], /needs a destination/);
  assert.match(errorsOf("box t\nmove t to(1 1 1) over(-1)")[0], /non-negative duration/);
  assert.match(errorsOf("box t\nmove t to(1 1 1) start(-1)")[0], /time >= 0/);
  assert.match(errorsOf("box t\nmove t to(1 1 1) ease(wiggle)")[0], /ease\(\)/);
});

test("time: a named fact usable wherever a point in time goes", () => {
  const c = compile(
    "clock 1:00 minute(0.5)\n" +
      "time time_of_death 3:00\n" + // declared before OR after use — order-free
      "room lion size(4 2.5 4)\n" +
      "cylinder alice r(0.25) h(1.6) at(lion 1 1) vanish(time_of_death)\n" +
      "turn alice to(90 0 0) start(time_of_death) over(1m) ease(in)\n" +
      "? in(alice lion) at(time_of_death)\n" +
      "time first_scream 2:45\n" +
      "? never in(alice lion) during(first_scream time_of_death)",
  );
  assert.deepEqual(c.errors, []);
  assert.equal(c.times.get("time_of_death"), 60); // (3:00 - 1:00) * 0.5s
  assert.match(c.results[0].text, /at\(3:00\)/); // answers speak wall time
  assert.equal(c.objects.find((o) => o.name === "alice").vanish, 60);
});

test("time: plain seconds work without a clock; guard rails hold", () => {
  const c = compile("time boom 5\nbox b vanish(boom)");
  assert.deepEqual(c.errors, []);
  assert.equal(c.objects.find((o) => o.name === "b").vanish, 5);
  // a point in time is not a duration
  assert.match(errorsOf("clock 1:00\ntime t 2:00\nbox b\nmove b to(1 1 1) over(t)")[0], /names a point in time/);
  assert.match(errorsOf("time t 5m")[0], /"5m" is a duration/);
  // h:mm needs a clock; names can't collide or redefine
  assert.match(errorsOf("time t 2:00")[0], /wall-clock time/);
  assert.match(errorsOf("clock 1:00\ntime t 2:00\nbox t")[0], /collides with the object/);
  assert.match(errorsOf("clock 1:00\ntime t 2:00\ntime t 3:00")[0], /already defined/);
});

const HYP_SCENE = (act) =>
  "clock 8:00 minute(0.2)\n" +
  "room cabin size(4 2.5 4)\n" +
  "room unknown size(4 2.5 4) at(-9 0 0)\n" +
  "cylinder cooper r(0.25) h(1.6) at(cabin)\n" +
  "hypothesis fbi_zone\n" +
  "  time jump 8:13\n" +
  "end\n" +
  "hypothesis columbia\n" +
  "  time jump 8:20\n" +
  "  box raft size(1 0.3 0.5) at(unknown 1 1)\n" + // hypothesis-local object
  "end\n" +
  "active " + act + "\n" +
  "walk cooper to(unknown) start(jump) over(0)\n" +
  "check in(cooper cabin) at(8:05)";

test("hypothesis blocks: only the active world compiles", () => {
  const a = compile(HYP_SCENE("fbi_zone"));
  assert.deepEqual(a.errors, []);
  assert.equal(a.times.get("jump"), (13 * 60 * 0.2) / 60); // 8:13 under minute(0.2)
  assert.ok(!a.objects.some((o) => o.name === "raft")); // columbia's raft doesn't exist here
  const b = compile(HYP_SCENE("columbia"));
  assert.deepEqual(b.errors, []);
  assert.ok(b.objects.some((o) => o.name === "raft"));
  assert.deepEqual(a.hypotheses, ["fbi_zone", "columbia"]);
  assert.deepEqual(b.active, ["columbia"]);
});

test("multiple active hypotheses compose into one world", () => {
  const c = compile(`box gavel size(0.3 0.1 0.2) at(5 0)
cylinder pine at(0 0) h(1.8)
cylinder oak at(3 0) h(1.8)
hypothesis pine_false
  walk pine to(8 0) over(0)
end
hypothesis oak_true
  take oak gavel at(1)
end
hypothesis oak_false
  take pine gavel at(1)
end
active pine_false oak_true`);
  assert.deepEqual(c.errors, []);
  const at = (t, n) => sample(c, t).objects.find((o) => o.name === n);
  assert.equal(at(0.5, "pine").pos[0], 8); // pine_false's walk ran
  assert.equal(at(2, "gavel").pos[0], 3); // oak_true's take ran
  assert.deepEqual(c.facts.has.map((h) => h[0]), ["oak"]); // oak_false stayed dark
  assert.deepEqual(c.active, ["pine_false", "oak_true"]);
});

test("multi-active guard rails: unknown and duplicated names", () => {
  assert.match(errorsOf("hypothesis a\nend\nactive a zzz")[0], /no hypothesis named "zzz"/);
  assert.ok(errorsOf("hypothesis a\nend\nactive a a").some((e) => /names "a" twice/.test(e)));
});

test("hypothesis blocks: guard rails", () => {
  assert.match(errorsOf("hypothesis a\nend\nhypothesis b\nend")[0], /2 hypotheses declared — pick one/);
  assert.match(errorsOf("hypothesis a\nend\nactive zzz")[0], /no hypothesis named "zzz"/);
  assert.match(errorsOf("active a")[0], /none are declared/);
  assert.match(errorsOf("hypothesis a\nbox x")[0], /missing its end/);
  assert.match(errorsOf("hypothesis a\nhypothesis b\nend\nend\nactive a")[0], /don't nest/);
  assert.match(errorsOf("hypothesis a\npart p\n box s\nend\nend\nactive a")[0], /define parts at the top level/);
  assert.match(errorsOf("hypothesis a\nend\nhypothesis a\nend\nactive a")[0], /already defined/);
});

test("at(name): rests on the named thing's BASE level — stacked floors", () => {
  const c = compile(
    "room ground_room size(6 2.6 6)\n" +
      "room upstairs size(6 2.6 6) at(0 2.8 0)\n" +
      "box slab size(7 0.2 7) at(0 2.7 0)\n" +
      "cylinder ground_guy r(0.25) h(1.6) at(ground_room 1 0)\n" +
      "cylinder upstairs_gal r(0.25) h(1.6) at(upstairs 1 0)\n" +
      "? sees(ground_guy upstairs_gal)\n" +
      "? in(upstairs_gal upstairs)",
  );
  assert.deepEqual(c.errors, []);
  assertNear(c.objects.find((o) => o.name === "ground_guy").pos, [1, 0.8, 0]); // unchanged on the ground
  assertNear(c.objects.find((o) => o.name === "upstairs_gal").pos, [1, 3.6, 0]); // stands on floor 2
  assert.equal(c.results[0].value, false); // the slab blocks vertical sight
  assert.equal(c.results[1].value, true);
});

test("at block: statements inside get the block's instant", () => {
  const c = compile(
    "clock 1:00 minute(0.5)\n" +
      "time sighting 2:15\n" +
      "room monkey_island size(4 2.5 4)\n" +
      "room unknown size(4 2.5 4) at(-9 0 0)\n" +
      "cylinder carol r(0.25) h(1.6) at(monkey_island)\n" +
      "cylinder eddie r(0.25) h(1.6) at(unknown)\n" +
      "set people carol eddie\n" +
      "at sighting\n" + // time names work as block times
      "  check in(people monkey_island)\n" + // -> at(2:15)
      "  walk eddie to(monkey_island 1 0) over(0)\n" + // -> start(2:15)
      "  walk carol to(unknown) start(2:20)\n" + // explicit start wins
      "  ? when in(carol monkey_island)\n" + // quantifier keeps its own timeline
      "end",
  );
  assert.deepEqual(c.errors, []);
  assert.match(c.results[0].text, /at\(2:15\)/);
  assertNear(posAt(c, "eddie", 37.5), [1, 0.8, 0]); // leapt at 2:15
  assert.match(c.results[1].text, /when in\(carol, monkey_island\) → 1:00–2:2/); // whole-timeline
});

test("at range block: duration facts — bare booleans become always+during", () => {
  const c = compile(
    "clock 1:00 minute(0.5)\n" +
      "room cave size(4 2.5 4)\n" +
      "room unknown size(4 2.5 4) at(-9 0 0)\n" +
      "cylinder bob r(0.25) h(1.6) at(unknown)\n" +
      "set people bob\n" +
      "at 3:00 .. 3:15\n" +
      "  walk bob to(cave 1 0) over(0)\n" + // anims anchor at the window START
      "  check in(bob cave)\n" + // -> check always in(...) during(3:00 3:15)
      "  check never in(people unknown) during(3:01 3:14)\n" + // explicit during wins
      "  ? ever in(bob cave)\n" + // quantifier kept, window filled
      "end\n" +
      "walk bob to(unknown) start(3:15) over(0)",
  );
  assert.deepEqual(c.errors, []);
  assert.match(c.results[0].text, /✓ check always in\(bob, cave\) during\(3:00 3:15\)/);
  assert.match(c.results[1].text, /✓ check never in\(people, unknown\) during\(3:01 3:14\)/);
  assert.match(c.results[2].text, /ever in\(bob, cave\) during\(3:00 3:15\) → true/);
  assertNear(posAt(c, "bob", 60), [1, 0.8, 0]); // leapt at 3:00 (t=60)
});

test("at range block: guard rails", () => {
  assert.match(errorsOf("at 2 .. 1\ncheck in(a b)\nend")[0], /two increasing times/);
  assert.match(errorsOf("box a\nbox b\nat 1 .. 2\n? distance(a b)\nend")[0], /distance\(\) needs its own at\(time\)/);
  // time names work as range endpoints
  const c = compile("clock 1:00 minute(0.5)\ntime start_w 3:00\ntime end_w 3:15\nbox b\nat start_w .. end_w\nwalk b to(2 2) over(0)\nend");
  assert.deepEqual(c.errors, []);
  assertNear(posAt(c, "b", 60), [2, 0.5, 2]);
});

test("at block: guard rails", () => {
  assert.match(errorsOf("at 2\nbox b\nend")[0], /declare objects outside/);
  assert.match(errorsOf("at 2\ncheck in(a b)")[0], /at block is missing its end/);
  assert.match(errorsOf("box a\nend")[0], /"end" without a matching part, at or set block/);
  assert.match(errorsOf("at 2\nat 3\nend\nend")[0], /at blocks don't nest/);
  assert.match(errorsOf("at 2:15\ncheck in(a b)\nend")[0], /wall-clock time/); // h:mm needs a clock
  // a part's own end still belongs to the part, even inside a block
  const c = compile("at 2\nwalk p by(1 0)\nend\npart chair\n box seat\nend\nchair c1\ncylinder p r(0.2) h(1)");
  assert.deepEqual(c.errors, []);
});

test("over(0) is the leap: there at that instant, no path in between", () => {
  const c = compile(
    "clock 2:00 minute(0.5)\n" +
      "room a size(4 2.5 4)\n" +
      "room b size(4 2.5 4) at(20 0 0)\n" + // far away: a walk would smear across the map
      "cylinder carol r(0.25) h(1.6) at(a)\n" +
      "walk carol to(b 1 0) start(2:15) over(0)\n" +
      "? when in(carol b)\n" +
      "? never in(carol a) during(2:20 2:30)",
  );
  assert.deepEqual(c.errors, []);
  assertNear(posAt(c, "carol", 7.49), [0, 0.8, 0]); // still in a just before
  assertNear(posAt(c, "carol", 7.5), [21, 0.8, 0]); // 2:15: there
  assert.equal(c.results[1].value, true); // and she never smeared back through a
});

test("duration: 0 for a static scene, max segment end otherwise", () => {
  assert.equal(compile("box b").duration, 0);
  const c = compile("box t\nmove t to(1 0.5 0) start(5) over(2.5)");
  assert.equal(c.duration, 7.5);
});

test("queries are time-dependent: sees() flips as an object crosses a gap", () => {
  const c = compile(
    "sphere eye r(0.2) at(0 0.5 -4)\n" +
      "box target size(0.5 0.5 0.5) at(-4 0.25 2)\n" +
      "box wall size(2 2 2) at(-2 1 -1)\n" +
      "move target to(4 0.25 2) over(4)\n" +
      "? sees(eye target)",
  );
  assert.equal(sample(c, 0).results[0].value, false); // behind the wall
  assert.equal(sample(c, 2).results[0].value, true); // in the gap
  assert.equal(c.results[0].value, false); // compile() itself reports t=0
});

// ----------------------------------------------------------- time & lifetime

test("appear/vanish: objects exist only inside their window", () => {
  const c = compile("box b appear(1) vanish(3)");
  assert.equal(sample(c, 0.5).objects[0].present, false);
  assert.equal(sample(c, 1).objects[0].present, true); // appear is inclusive
  assert.equal(sample(c, 2.9).objects[0].present, true);
  assert.equal(sample(c, 3).objects[0].present, false); // vanish is exclusive
});

test("appear/vanish: defaults are always-present; events extend the timeline", () => {
  const c = compile("box a\nbox b at(3 0.5 0) appear(2)\nbox v at(6 0.5 0) vanish(5)");
  assert.equal(sample(c, 99).objects[0].present, true);
  assert.equal(c.duration, 5);
});

test("appear/vanish errors: negative time, vanish before appear", () => {
  assert.match(errorsOf("box b appear(-1)")[0], /number >= 0/);
  assert.match(errorsOf("box b appear(3) vanish(2)")[0], /must come after/);
  assert.match(errorsOf("box b appear(2) vanish(2)")[0], /must come after/);
});

test("queries have no answer for absent objects", () => {
  const c = compile("box a\nbox b at(4 0.5 0) appear(2)\n? distance(a b)");
  const before = sample(c, 1).results[0];
  assert.equal(before.value, null);
  assert.match(before.text, /b not present/);
  assert.equal(sample(c, 2.5).results[0].value, 4);
});

test("a vanished object stops blocking sight lines", () => {
  const c = compile(
    "sphere eye r(0.2) at(-4 0.5 0)\n" +
      "box target at(4 0.5 0)\n" +
      "box wall size(0.3 2 2) at(0 1 0) vanish(2)\n" +
      "? sees(eye target)",
  );
  assert.equal(sample(c, 1).results[0].value, false);
  assert.equal(sample(c, 2).results[0].value, true);
});

test("after(): waits relative to the previous segment's end", () => {
  const c = compile(
    "box t at(0 0.5 0)\n" +
      "move t to(2 0.5 0) over(1)\n" +
      "move t to(2 0.5 2) after(2) over(1)", // waits t=1..3, moves t=3..4
  );
  assert.equal(c.duration, 4);
  assert.deepEqual(posAt(c, "t", 2), [2, 0.5, 0]); // parked during the wait
  assert.deepEqual(posAt(c, "t", 3.5), [2, 0.5, 1]);
});

test("by(): relative displacement; chained by() legs never restate coordinates", () => {
  const c = compile(
    "box t at(1 0.5 0)\n" +
      "move t by(2 0 0) over(1)\n" +
      "move t by(0 0 3) over(1)",
  );
  assert.deepEqual(posAt(c, "t", 1), [3, 0.5, 0]);
  assert.deepEqual(posAt(c, "t", 2), [3, 0.5, 3]);
});

test("by() on turn: rotate relative to current heading", () => {
  const c = compile("box t\nturn t to(0 90 0) over(1)\nturn t by(0 270 0) over(1)");
  assert.deepEqual(sample(c, 2).objects[0].rot, [0, 360, 0]);
});

test("by() respects explicit from()", () => {
  const c = compile("box t at(0 0.5 0)\nmove t from(10 0.5 0) by(2 0 0) over(1)");
  assert.deepEqual(posAt(c, "t", 1), [12, 0.5, 0]);
});

test("to(name): moves to the named object's placed position, forward refs ok", () => {
  const c = compile(
    "sphere coin r(0.1) at(0 1 0)\n" +
      "move coin to(mark) over(2)\n" +
      "box mark size(0.4 0.02 0.4) at(3 0.01 2)",
  );
  assert.deepEqual(posAt(c, "coin", 2), [3, 0.01, 2]);
});

test("to(name): targets the placed position, not the animated one (no pursuit)", () => {
  const c = compile(
    "box rabbit at(5 0.5 0)\n" +
      "move rabbit by(0 0 9) over(1)\n" +
      "sphere fox r(0.3) at(0 0.3 0)\n" +
      "move fox to(rabbit) over(2)",
  );
  assert.deepEqual(posAt(c, "fox", 2), [5, 0.5, 0]); // where the rabbit *was placed*
});

test("to/by errors: both, neither, unknown ref, turn to(name), wrong arity", () => {
  assert.match(errorsOf("box t\nmove t to(1 1 1) by(1 0 0)")[0], /to\(\) or by\(\), not both/);
  assert.match(errorsOf("box t\nmove t over(2)")[0], /needs a destination/);
  assert.match(errorsOf("box t\nmove t to(ghost)")[0], /no object named "ghost"/);
  assert.match(errorsOf("box t\nturn t to(ghost)")[0], /expected 3 numbers \(degrees\)/);
  assert.match(errorsOf("box t\nmove t by(1 2)")[0], /expected 3 numbers/);
});

test("animation chains from appear(): a coin can't move before it exists", () => {
  const c = compile(
    "sphere coin r(0.1) at(0 1 0) appear(3) color(gold)\n" +
      "move coin to(5 1 0) over(3)", // runs t=3..6, not t=0..3
  );
  assert.equal(c.duration, 6);
  assert.deepEqual(posAt(c, "coin", 3), [0, 1, 0]); // appears at its start
  assert.deepEqual(posAt(c, "coin", 4.5), [2.5, 1, 0]);
  assert.equal(sample(c, 2).objects[0].present, false);
});

test("explicit start() can still animate before appear()", () => {
  const c = compile("box b appear(2)\nmove b to(4 0.5 0) start(0) over(2)");
  assert.deepEqual(posAt(c, "b", 1), [2, 0.5, 0]); // moving while absent
});

test("after() errors: negative, combined with start()", () => {
  assert.match(errorsOf("box t\nmove t to(1 1 1) after(-1)")[0], /non-negative duration/);
  assert.match(errorsOf("box t\nmove t to(1 1 1) start(1) after(1)")[0], /not both/);
});

// ----------------------------------------------------------------- grouping

test("group: member coordinates are local; group at() offsets them into world", () => {
  const c = compile(
    "group truck at(10 0 5)\n" +
      "box body size(1.8 0.9 1) in(truck) at(0 0.45 0)\n" +
      "box cab size(0.7 0.6 0.9) in(truck) at(0.55 1.2 0)",
  );
  assert.deepEqual(posAt(c, "body", 0), [10, 0.45, 5]);
  assert.deepEqual(posAt(c, "cab", 0), [10.55, 1.2, 5]);
});

test("group: moving the group carries every member", () => {
  const c = compile(
    "group g at(0 0 0)\n" +
      "box a in(g) at(1 0.5 0)\n" +
      "box b in(g) at(-1 0.5 0)\n" +
      "move g by(0 0 10) over(2)",
  );
  assert.deepEqual(posAt(c, "a", 2), [1, 0.5, 10]);
  assert.deepEqual(posAt(c, "b", 2), [-1, 0.5, 10]);
});

test("group: turning the group orbits members around its origin", () => {
  const c = compile(
    "group g at(0 0 0)\n" +
      "box a in(g) at(2 0.5 0)\n" +
      "turn g to(0 90 0) over(1)",
  );
  const p = posAt(c, "a", 1);
  assert.ok(Math.abs(p[0]) < 1e-9, "x ~ 0, got " + p[0]);
  assert.ok(Math.abs(p[1] - 0.5) < 1e-9);
  assert.ok(Math.abs(p[2] + 2) < 1e-9, "z ~ -2, got " + p[2]);
});

test("group: nesting composes transforms", () => {
  const c = compile(
    "group outer at(100 0 0)\n" +
      "group inner in(outer) at(10 0 0)\n" +
      "box b in(inner) at(1 0.5 0)",
  );
  assert.deepEqual(posAt(c, "b", 0), [111, 0.5, 0]);
});

test("group: member movement is local, composing with group movement", () => {
  const c = compile(
    "group g at(5 0 0)\n" +
      "box piston in(g) at(0 0.5 0)\n" +
      "move piston by(0 2 0) over(2)\n" +
      "move g by(10 0 0) over(2)",
  );
  assert.deepEqual(posAt(c, "piston", 1), [10, 1.5, 0]); // both half done
});

test("group: relations between siblings resolve in local space", () => {
  const c = compile(
    "group g at(0 3 0)\n" +
      "box base size(1 1 1) in(g) at(0 0.5 0)\n" +
      "sphere ball r(0.25) in(g) on(base)",
  );
  assert.deepEqual(posAt(c, "ball", 0), [0, 4.25, 0]);
});

test("group: relations and to() may not cross frames", () => {
  const cross =
    "group g\nbox inside in(g) at(0 0.5 0)\nbox outside on(inside)";
  assert.match(errorsOf(cross)[0], /different group/);
  const anim =
    "group g\nbox inside in(g) at(0 0.5 0)\nbox mover\nmove mover to(inside)";
  assert.match(errorsOf(anim)[0], /different group/);
});

test("group: relations may target a group (union bounds of members)", () => {
  const c = compile(
    "group tower at(0 0 0)\n" +
      "box lower size(2 1 2) in(tower) at(0 0.5 0)\n" +
      "box upper size(1 1 1) in(tower) at(0 1.5 0)\n" +
      "sphere ball r(0.5) on(tower)",
  );
  assert.deepEqual(posAt(c, "ball", 0), [0, 2.5, 0]); // on top of the union
});

test("group: vanishing the group hides members; queries agree", () => {
  const c = compile(
    "group g vanish(2)\n" +
      "box a in(g) at(0 0.5 0)\n" +
      "box lone at(4 0.5 0)\n" +
      "? distance(lone a)",
  );
  assert.equal(sample(c, 1).objects.find((o) => o.name === "a").present, true);
  assert.equal(sample(c, 2).objects.find((o) => o.name === "a").present, false);
  assert.match(sample(c, 2).results[0].text, /a not present/);
});

test("group: queries target the union bbox; members don't block their own line", () => {
  const c = compile(
    "group truck at(4 0 0)\n" +
      "box body size(1.8 0.9 1) in(truck) at(0 0.45 0)\n" +
      "box cab size(0.7 0.6 0.9) in(truck) at(0.55 1.2 0)\n" +
      "sphere watcher r(0.2) at(-4 0.5 0)\n" +
      "? sees(watcher truck)\n" +
      "? distance(watcher truck)",
  );
  const rs = c.results;
  assert.equal(rs[0].value, true, rs[0].text); // body/cab don't block their group
  assert.ok(rs[1].value > 7 && rs[1].value < 9);
});

test("group: groups never block other sight lines; their members do", () => {
  const c = compile(
    "sphere eye r(0.2) at(-4 0.5 0)\n" +
      "box target at(4 0.5 0)\n" +
      "group fence at(0 0 0)\n" +
      "box post-a size(0.4 2 0.4) in(fence) at(0 1 -3)\n" +
      "box post-b size(0.4 2 0.4) in(fence) at(0 1 3)\n" +
      "? sees(eye target)",
  );
  // fence union bbox spans the line, but the gap between posts is real
  assert.equal(c.results[0].value, true, c.results[0].text);
});

test("group errors: unknown group, non-group parent, cycles, group props", () => {
  assert.match(errorsOf("box b in(ghost)")[0], /no group named "ghost"/);
  assert.match(errorsOf("box a\nbox b in(a)")[0], /not a group/);
  const cyc = errorsOf("group g1 in(g2)\ngroup g2 in(g1)\nbox b in(g1)");
  assert.equal(cyc.filter((m) => /circular in\(\)/.test(m)).length, 1);
  assert.match(errorsOf("group g size(1 1 1)")[0], /groups don't have size/);
});

// ------------------------------------------------------------------- orbit

function assertNear(actual, expected, msg) {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < 1e-9,
      `${msg || "vec"}[${i}]: expected ~${expected[i]}, got ${actual[i]}`,
    );
  }
}

test("orbit: sweeps a circle around y — +x goes toward −z, matching turn()", () => {
  const c = compile("sphere p at(2 1 0)\norbit p around(0 1 0) by(90) over(2)");
  assert.deepEqual(c.errors, []);
  assert.equal(c.duration, 2);
  assertNear(posAt(c, "p", 0), [2, 1, 0]);
  assertNear(posAt(c, "p", 1), [Math.SQRT2, 1, -Math.SQRT2]); // 45°, on the circle
  assertNear(posAt(c, "p", 2), [0, 1, -2]);
});

test("orbit: axis(z) circles in the xy plane — +x goes toward +y", () => {
  const c = compile("sphere p at(1 3 0)\norbit p around(0 3 0) axis(z) by(90) over(1)");
  assertNear(posAt(c, "p", 1), [0, 4, 0]);
});

test("orbit: a full turn returns home, and the next move chains from there", () => {
  const c = compile(
    "sphere p at(2 1 0)\n" +
      "orbit p around(0 1 0) by(360) over(4)\n" +
      "move p by(0 2 0) over(1)",
  );
  assertNear(posAt(c, "p", 4), [2, 1, 0]);
  assertNear(posAt(c, "p", 5), [2, 3, 0]);
});

test("orbit: around(name) uses the target's placed position; height is kept", () => {
  const c = compile(
    "box hub size(1 1 1) at(0 0.5 0)\n" +
      "sphere p r(0.2) east-of(hub 1)\n" + // p at (1.7, 0.2, 0)
      "orbit p around(hub) by(180) over(2)",
  );
  assertNear(posAt(c, "p", 2), [-1.7, 0.2, 0]);
});

test("orbit: group members orbit in group-local space", () => {
  const c = compile(
    "group g at(10 0 0)\n" +
      "sphere planet r(0.3) in(g) at(0 1 0)\n" +
      "sphere moon r(0.1) in(g) at(1 1 0)\n" +
      "orbit moon around(planet) by(90) over(1)",
  );
  assertNear(posAt(c, "moon", 0), [11, 1, 0]);
  assertNear(posAt(c, "moon", 1), [10, 1, -1]);
});

test("orbit errors: missing parts, to(), on-axis start, cross-frame center", () => {
  assert.match(errorsOf("box b\norbit b by(90)")[0], /orbit needs around/);
  assert.match(errorsOf("box b\norbit b around(0 0 0)")[0], /orbit needs by/);
  assert.match(errorsOf("box b\norbit b to(1 0 0)")[0], /not to\(\)/);
  assert.match(errorsOf("box b\norbit b around(0 0 0) by(90) axis(w)")[0], /one of x, y, z/);
  assert.match(
    errorsOf("box b at(0 1 0)\norbit b around(0 0 0) by(90)")[0],
    /no circle to travel/,
  );
  assert.match(
    errorsOf("box b at(2 0.5 0)\norbit b around(ghost) by(90)")[0],
    /no object named "ghost"/,
  );
  assert.match(
    errorsOf(
      "group g\nbox m in(g) at(1 0 0)\nbox hub at(5 0.5 0)\norbit m around(hub) by(90)",
    )[0],
    /different group/,
  );
  assert.match(errorsOf("box b\nmove b to(1 1 1) around(0 0 0)")[0], /only orbit/);
});

// ------------------------------------------------------------------- theme

test("theme: recorded in compiled output; absent means null", () => {
  assert.equal(compile("theme ink\nbox b").theme, "ink");
  assert.equal(compile("theme clay\nbox b").theme, "clay");
  assert.equal(compile("box b").theme, null);
});

test("theme: zero semantic effect — poses and query answers are identical", () => {
  const plain = compile("box a\nsphere s r(0.3) on(a)\n? distance(a s)");
  const themed = compile("theme ink\nbox a\nsphere s r(0.3) on(a)\n? distance(a s)");
  assert.deepEqual(
    themed.objects.map((o) => o.pos),
    plain.objects.map((o) => o.pos),
  );
  assert.equal(themed.results[0].value, plain.results[0].value);
});

test("view: recorded in compiled output; rendering-only, like theme", () => {
  assert.equal(compile("view iso\nbox b").view, "iso");
  assert.equal(compile("view top\nbox b").view, "top");
  assert.equal(compile("box b").view, null);
  const plain = compile("box a\nsphere s r(0.3) on(a)\n? distance(a s)");
  const iso = compile("view iso\nbox a\nsphere s r(0.3) on(a)\n? distance(a s)");
  assert.deepEqual(iso.objects.map((o) => o.pos), plain.objects.map((o) => o.pos));
  assert.equal(iso.results[0].value, plain.results[0].value);
  assert.match(errorsOf("view fisheye\nbox b")[0], /unknown view "fisheye" \(available: iso, top/);
  assert.match(errorsOf("view iso\nview top\nbox b")[0], /one view per scene/);
});

test("theme: any name passes through — the renderer owns the list now", () => {
  // custom themes live in themes.json, so the core carries names
  // without judging them; the playground warns about unknowns
  const c = compile("theme vaporwave\nbox b");
  assert.deepEqual(c.errors, []);
  assert.equal(c.theme, "vaporwave");
  assert.match(errorsOf("theme ink\ntheme clay\nbox b")[0], /already "ink" \(line 1\)/);
  assert.match(errorsOf("theme\nbox b")[0], /expected: theme <name>/);
  assert.match(errorsOf("theme ink clay\nbox b")[0], /expected: theme <name>/);
});

// ------------------------------------------------------------------- rooms

test("room: desugars to a group plus four walls, interior size, corners closed", () => {
  const s = scene("room k size(4 2 4)");
  assert.equal(s.k.shape, "group");
  // north/south span the corners (w + 2*thick); east/west fit between
  assert.deepEqual(s["k-north"].dims, { w: 4.4, h: 2, d: 0.2 });
  assert.deepEqual(s["k-north"].pos, [0, 1, -2.1]);
  assert.deepEqual(s["k-south"].pos, [0, 1, 2.1]);
  assert.deepEqual(s["k-east"].dims, { w: 0.2, h: 2, d: 4 });
  assert.deepEqual(s["k-east"].pos, [2.1, 1, 0]);
  assert.deepEqual(s["k-west"].pos, [-2.1, 1, 0]);
  assert.equal(s["k-north"].parent, "k");
  // walls touch but never overlap (touching ≠ overlapping)
  const c = compile("room k size(4 2 4)\n? overlaps(k-north k-east)");
  assert.equal(c.results[0].value, false);
});

test("room: a door splits its wall into two segments around a real gap", () => {
  const s = scene("room k size(4 2 4) door(south 1)");
  assert.equal(s["k-south"], undefined);
  assertNear([s["k-south-1"].dims.w, s["k-south-1"].dims.h, s["k-south-1"].dims.d], [1.7, 2, 0.2]);
  assertNear(s["k-south-1"].pos, [-1.35, 1, 2.1]);
  assertNear(s["k-south-2"].pos, [1.35, 1, 2.1]);
});

test("room: door offset and multiple doors on one wall", () => {
  const s = scene("room k size(6 2 4) door(north 1 -2) door(north 1 2)");
  // span 6.4; doors at [-2.5,-1.5] and [1.5,2.5] -> three segments
  assert.deepEqual(s["k-north-1"].pos, [-2.85, 1, -2.1]); // [-3.2,-2.5]
  assert.deepEqual(s["k-north-2"].pos, [0, 1, -2.1]); // [-1.5,1.5]
  assert.deepEqual(s["k-north-3"].pos, [2.85, 1, -2.1]);
});

test("room: sight passes through a doorway and is blocked by a wall", () => {
  const c = compile(
    "room k size(4 2.5 4) door(south 1.2)\n" +
      "cylinder guard r(0.2) h(1) in(k) at(0 0.5 0)\n" +
      "cylinder cop r(0.2) h(1) at(0 0.5 5)\n" +
      "cylinder spy r(0.2) h(1) at(5 0.5 0)\n" +
      "? sees(cop guard)\n" +
      "? blocked-by(spy guard)",
  );
  assert.deepEqual(c.errors, []);
  assert.equal(c.results[0].value, true, c.results[0].text); // straight through the door
  assert.deepEqual(c.results[1].value, ["k-east"]); // wall in the way, by name
});

test("room: walls() thickness and color() flow into the generated walls", () => {
  const s = scene("room k size(4 2 4) walls(0.5) color(tomato)");
  assert.deepEqual(s["k-north"].dims, { w: 5, h: 2, d: 0.5 });
  assert.deepEqual(s["k-north"].pos, [0, 1, -2.25]);
  assert.equal(s["k-east"].color, "tomato");
});

test("room: is a group — relation target from outside, moves as one", () => {
  const s = scene("room k size(4 2 4)\nbox mat size(1 0.2 1) east-of(k)");
  assert.deepEqual(s.mat.pos, [2.95, 0.1, 0]); // 2.2 + 0.25 gap + 0.5
  const c = compile("room k size(4 2 4)\nmove k by(2 0 0) over(1)");
  assertNear(posAt(c, "k-west", 1), [-0.1, 1, 0]);
});

test("room errors: bad side, door too wide, overlapping doors, name collision", () => {
  assert.match(errorsOf("room k door(up)")[0], /north, south, east, west/);
  assert.match(errorsOf("room k size(4 2 4) door(south 10)")[0], /doesn't fit/);
  assert.match(
    errorsOf("room k size(4 2 4) door(south 2 0) door(south 2 1)")[0],
    /openings overlap/,
  );
  assert.match(errorsOf("box k-north\nroom k")[0], /that name is taken/);
});

// ----------------------------------------------------- shared doors (to)

test("door(to): one declaration carves aligned openings in BOTH rooms", () => {
  const c = compile(
    "room a size(4 2.5 4) at(0 0 0) door(to b)\n" +
      "room b size(4 2.5 4) at(4.4 0 0)\n" +
      "cylinder p r(0.2) h(1) in(a) at(0 0.5 0)\n" +
      "cylinder q r(0.2) h(1) in(b) at(0 0.5 0)\n" +
      "? sees(p q)",
  );
  assert.deepEqual(c.errors, []);
  const names = c.objects.map((o) => o.name);
  assert.ok(names.includes("a-east-1") && names.includes("a-east-2"), "a's east wall is split");
  assert.ok(names.includes("b-west-1") && names.includes("b-west-2"), "b's west wall is split");
  assert.equal(c.results[0].value, true, c.results[0].text); // straight through the doorway
});

test("door(to): the door centers on the shared stretch of offset rooms", () => {
  const s = scene(
    "room a size(4 2.5 4) at(0 0 0) door(to b)\n" + "room b size(4 2.5 4) at(4.4 0 1)",
  );
  // shared interior stretch z ∈ [-1, 2] → door center z=0.5, width 1 → gap [0, 1]
  // a's east wall (span 4): segments [-2, 0] and [1, 2]
  assertNear(s["a-east-1"].pos, [2.1, 1.25, -1]);
  assert.ok(Math.abs(s["a-east-1"].dims.d - 2) < 1e-9);
  assertNear(s["a-east-2"].pos, [2.1, 1.25, 1.5]);
  // b's west wall in b-local coords: gap [-1, 0] → segments [-2, -1], [0, 2]
  assertNear(s["b-west-1"].pos, [-2.1, 1.25, -1.5]);
  assertNear(s["b-west-2"].pos, [-2.1, 1.25, 1]);
});

test("door(to): declared from both rooms is the same fact — unless widths differ", () => {
  const both =
    "room a size(4 2.5 4) at(0 0 0) door(to b)\n" + "room b size(4 2.5 4) at(4.4 0 0) door(to a)";
  const s = scene(both); // no overlap error: deduped
  assert.ok(s["a-east-1"] && s["a-east-2"]);
  assert.match(
    errorsOf(both.replace("door(to a)", "door(to a 2)"))[0],
    /different widths/,
  );
});

test("door(to) errors: gap, non-room, short shared wall, rotation, unknown", () => {
  const two = (bAt, extra = "") =>
    `room a size(4 2.5 4) at(0 0 0) door(to b)\nroom b size(4 2.5 4) at(${bAt}) ${extra}`;
  assert.match(errorsOf(two("5 0 0"))[0], /don't share a wall — their nearest faces are 0.60 apart/);
  assert.match(errorsOf(two("4 0 0"))[0], /don't share a wall/); // overlapping shells: no touching side
  assert.match(errorsOf(two("4.4 0 3.5"))[0], /too short for a width-1 door/);
  assert.match(errorsOf(two("4.4 0 0", "rotate(0 45 0)"))[0], /can't be rotated/);
  assert.match(errorsOf("room a door(to ghost)")[0], /no room named "ghost"/);
  assert.match(errorsOf("box b\nroom a door(to b)")[0], /"b" is not a room/);
  assert.match(
    errorsOf("room a size(4 2 4) door(south) repeat(2) spread(5 0 0)")[0],
    /rooms with doors or windows can.t repeat yet/,
  );
});

// ------------------------------------------------------------------ repeat

test("repeat: n copies named -1..-n, spread apart; the original is gone", () => {
  const s = scene("box post size(0.2 1 0.2) at(0 0.5 0) repeat(3) spread(1 0 0)");
  assert.equal(s.post, undefined);
  assert.deepEqual(s["post-1"].pos, [0, 0.5, 0]);
  assert.deepEqual(s["post-2"].pos, [1, 0.5, 0]);
  assert.deepEqual(s["post-3"].pos, [2, 0.5, 0]);
});

test("repeat: spread composes with placement relations", () => {
  const s = scene(
    "box desk size(2 0.75 1)\n" +
      "cylinder coin r(0.1) h(0.02) on(desk) repeat(2) spread(0.5 0 0)",
  );
  assertNear(s["coin-1"].pos, [0, 0.76, 0]);
  assertNear(s["coin-2"].pos, [0.5, 0.76, 0]);
});

test("repeat: jitter is seeded and reproducible; the seed changes it", () => {
  const src = (seed) =>
    `sphere p r(0.1) at(0 5 0) repeat(4) jitter(0.5 0 0.5 ${seed})`;
  const a = scene(src(7));
  const b = scene(src(7));
  const c = scene(src(8));
  for (let i = 1; i <= 4; i++) {
    assert.deepEqual(a["p-" + i].pos, b["p-" + i].pos); // same seed, same layout
    const p = a["p-" + i].pos;
    assert.ok(Math.abs(p[0]) <= 0.5 && p[1] === 5 && Math.abs(p[2]) <= 0.5);
  }
  assert.notDeepEqual(
    [1, 2, 3, 4].map((i) => a["p-" + i].pos),
    [1, 2, 3, 4].map((i) => c["p-" + i].pos),
  );
});

test("repeat: groups stamp whole assemblies; internal relations remap", () => {
  const s = scene(
    "group hut repeat(2) spread(5 0 0)\n" +
      "box base size(1 1 1) in(hut)\n" +
      "sphere roof r(0.3) in(hut) on(base)",
  );
  assert.deepEqual(s["base-2"].parent, "hut-2");
  assert.deepEqual(s["roof-2"].rel.target, "base-2");
  // world positions: second hut sits 5 to the right
  const c = compile(
    "group hut repeat(2) spread(5 0 0)\n" +
      "box base size(1 1 1) in(hut)\n" +
      "sphere roof r(0.3) in(hut) on(base)",
  );
  assertNear(posAt(c, "roof-2", 0), [5, 1.3, 0]);
});

test("repeat: one move line animates every copy, stagger delays each clock", () => {
  const c = compile(
    "box crate size(0.5 0.5 0.5) at(0 0.25 0) repeat(3) spread(0 0 1) stagger(1)\n" +
      "move crate by(0 2 0) over(1)",
  );
  assert.deepEqual(c.errors, []);
  assert.equal(c.duration, 3); // copy 3 runs t=2..3
  assertNear(posAt(c, "crate-1", 1), [0, 2.25, 0]); // done
  assertNear(posAt(c, "crate-2", 1), [0, 0.25, 1]); // hasn't started
  assertNear(posAt(c, "crate-3", 0), [0, 0.25, 2]); // exists from t=0 (no pop-in)
  assert.equal(sample(c, 0).objects.find((o) => o.name === "crate-3").present, true);
});

test("repeat errors: ambiguous references, variation without repeat, collisions", () => {
  assert.match(
    errorsOf("box a repeat(2)\nbox b on(a)")[0],
    /"a" is repeated into 2 copies — place against one/,
  );
  // queries may name the family — it's a set of the copies — but only
  // the boolean queries can quantify; distance over a set has no answer
  const dq = compile("box a repeat(2) spread(2 0 0)\nbox b at(5 0.5 0)\n? distance(a b)");
  assert.equal(dq.results[0].error, true);
  assert.match(dq.results[0].text, /distance can't take a set/);
  assert.match(
    errorsOf("box a repeat(2)\nbox b\nmove b to(a) over(1)")[0],
    /"a" is repeated into 2 copies — name one/,
  );
  assert.match(errorsOf("box a spread(1 0 0)")[0], /only make sense with repeat/);
  assert.match(errorsOf("box a-2\nbox a repeat(2)")[0], /that name is taken/);
});

// -------------------------------------------------------- rotated bounds

test("rotated bounds: a lying cylinder blocks low and clears high", () => {
  const base =
    "sphere eyeA r(0.1) at(-2 Y 0)\nsphere eyeB r(0.1) at(2 Y 0)\n? sees(eyeA eyeB)\n";
  const lying = "cylinder dave r(0.25) h(1.6) at(0 0.25 0) rotate(90 0 0)\n";
  const standing = "cylinder dave r(0.25) h(1.6) at(0 0.8 0)\n";
  // high line: clears the lying body, hits the standing one
  const high = (body) => compile(body + base.replace(/Y/g, "0.9")).results[0].value;
  assert.equal(high(lying), true);
  assert.equal(high(standing), false);
  // low line: hits the lying body
  const low = compile(lying + base.replace(/Y/g, "0.3")).results[0];
  assert.equal(low.value, false);
  assert.match(low.text, /blocked by dave/);
});

test("rotated bounds: overlaps sees the swapped extents; they change mid-animation", () => {
  // lying dave reaches z=0.8; standing dave only z=0.25
  const probe = "box p size(0.2 0.2 0.2) at(0 0.25 0.6)\n? overlaps(dave p)\n";
  assert.equal(
    compile("cylinder dave r(0.25) h(1.6) at(0 0.25 0) rotate(90 0 0)\n" + probe).results[0].value,
    true,
  );
  // animated topple: the high sight line is blocked while he stands, clear once he's down
  const c = compile(
    "cylinder dave r(0.25) h(1.6) at(0 0.8 0)\n" +
      "turn dave to(90 0 0) over(1)\n" +
      "move dave by(0 -0.55 0) over(1)\n" +
      "sphere eyeA r(0.1) at(-2 1.4 0)\nsphere eyeB r(0.1) at(2 1.4 0)\n" +
      "? sees(eyeA eyeB)",
  );
  assert.equal(sample(c, 0).results[0].value, false);
  assert.equal(sample(c, 1).results[0].value, true);
});

test("rotated bounds: exact box at 45°, and spheres never inflate", () => {
  const probe = "box t size(0.2 0.2 0.2) at(0.95 0.5 0)\n? overlaps(b t)\n";
  // unrotated 2-long box reaches x=1.0 and overlaps; at 45° yaw it reaches ~0.78
  assert.equal(compile("box b size(2 0.2 0.2) at(0 0.5 0)\n" + probe).results[0].value, true);
  assert.equal(
    compile("box b size(2 0.2 0.2) at(0 0.5 0) rotate(0 45 0)\n" + probe).results[0].value,
    false,
  );
  // a rotated sphere is still just a sphere
  const s = compile(
    "sphere b r(0.5) at(0 0.5 0) rotate(45 45 0)\nbox t size(0.5 0.5 0.5) at(0.85 0.5 0)\n? overlaps(b t)",
  );
  assert.equal(s.results[0].value, false);
});

// ------------------------------------------------------------------- parts

const CHAIR =
  "part chair\n" +
  "  box seat size(0.4 0.05 0.4) at(0 0.45 0)\n" +
  "  box back size(0.4 0.5 0.05) at(0 0.7 -0.2)\n" +
  "end\n";

test("part: instances are groups with prefixed members; definition order is free", () => {
  // instance appears BEFORE the definition — order is not meaningful
  const s = scene("chair c1 at(2 0 1)\n" + CHAIR);
  assert.equal(s.c1.shape, "group");
  assert.equal(s["c1-seat"].parent, "c1");
  assert.equal(s.seat, undefined); // body names don't leak into the scene
  const c = compile("chair c1 at(2 0 1)\n" + CHAIR);
  assertNear(posAt(c, "c1-seat", 0), [2, 0.45, 1]);
});

test("part: scale() bakes sizes, positions, radii, and relation gaps", () => {
  const s = scene(
    "part tower\n" +
      "  box base size(1 1 1)\n" +
      "  sphere top r(0.2) above(base 0.4)\n" +
      "end\n" +
      "tower t1 scale(2)",
  );
  assert.deepEqual(s["t1-base"].dims, { w: 2, h: 2, d: 2 });
  assert.equal(s["t1-top"].r, 0.4);
  // base rests on ground (h/2=1); top = 2 (base top) + 0.8 (scaled gap) + 0.4 (r)
  assertNear(s["t1-top"].pos, [0, 3.2, 0]);
  const small = scene(CHAIR + "chair c2 scale(0.5)");
  assert.deepEqual(small["c2-seat"].dims, { w: 0.2, h: 0.025, d: 0.2 });
});

test("part: animations belong to the part — every instance runs its own", () => {
  const src =
    "part fan\n" +
    "  cylinder shaft r(0.1) h(0.5) at(0 0.25 0)\n" +
    "  turn shaft by(0 90 0) over(1)\n" +
    "end\n" +
    "fan f1 at(1 0 0)\nfan f2 at(-1 0 0)";
  const c = compile(src);
  assert.deepEqual(c.errors, []);
  assert.equal(c.duration, 1);
  const rotOf = (n, t) => sample(c, t).objects.find((o) => o.name === n).rot;
  assert.deepEqual(rotOf("f1-shaft", 1), [0, 90, 0]);
  assert.deepEqual(rotOf("f2-shaft", 1), [0, 90, 0]);
});

test("part: to(name) inside a body stays inside the instance, and scales", () => {
  const c = compile(
    "part pair\n" +
      "  box a size(0.2 0.2 0.2) at(0 0.1 0)\n" +
      "  box b size(0.2 0.2 0.2) at(1 0.1 0)\n" +
      "  move b to(a) over(1)\n" +
      "end\n" +
      "pair p1 at(0 0 5) scale(2)",
  );
  assert.deepEqual(c.errors, []);
  assertNear(posAt(c, "p1-b", 0), [2, 0.2, 5]); // scaled start
  assertNear(posAt(c, "p1-b", 1), [0, 0.2, 5]); // arrives at p1-a's placed spot
});

test("part: instances compose with repeat — a row of chairs", () => {
  const src = CHAIR + "chair row repeat(3) spread(1 0 0)";
  const s = scene(src);
  assert.equal(s.row, undefined);
  assert.equal(s["row-seat-3"].parent, "row-3");
  const c = compile(src);
  assertNear(posAt(c, "row-seat-1", 0), [0, 0.45, 0]);
  assertNear(posAt(c, "row-seat-3", 0), [2, 0.45, 0]);
});

test("part errors: structure, reserved names, self-containment, nesting", () => {
  assert.match(errorsOf("part desk\nbox top size(1 0.1 1)")[0], /missing its end/);
  assert.match(errorsOf("end")[0], /"end" without a matching part/);
  assert.match(errorsOf("part desk\nend")[0], /is empty/);
  assert.match(errorsOf("part box\nbox b\nend")[0], /reserved word/);
  assert.match(errorsOf(CHAIR + "part chair\nbox x\nend\nchair c1")[0], /already defined/);
  assert.match(
    errorsOf("part bad\n  box a size(1 1 1) on(outside)\nend\nbad b1")[0],
    /self-contained/,
  );
  assert.match(
    errorsOf(CHAIR + "part study-set\n  chair c in(nowhere)\nend\nstudy-set s1")[0],
    /parts can't use other parts/,
  );
  assert.match(errorsOf("box b scale(2)")[0], /unknown property/);
});

// -------------------------------------------------------- temporal queries

test("temporal: when/ever/always over a wall that slides away at t=1", () => {
  const c = compile(
    "sphere a r(0.1) at(-2 0.5 0)\n" +
      "sphere b r(0.1) at(2 0.5 0)\n" +
      "box wall size(0.2 2 2) at(0 1 0)\n" +
      "move wall by(0 0 5) over(5)\n" +
      "? when sees(a b)\n? ever sees(a b)\n? always sees(a b)",
  );
  assert.deepEqual(c.errors, []);
  const [when, ever, always] = c.results;
  // wall spans z ± 1 around its center z(t)=t: the line at z=0 clears at t=1
  assert.equal(when.value.length, 1);
  assert.ok(Math.abs(when.value[0][0] - 1) < 0.001, "flip found by bisection, got " + when.value[0][0]);
  assert.equal(when.value[0][1], 5);
  assert.equal(when.text, "when sees(a, b) → 1.00–5.00");
  assert.equal(ever.value, true);
  assert.match(ever.text, /true \(first at 1\.00\)/);
  assert.equal(always.value, false);
  assert.match(always.text, /false \(fails 0\.00–1\.00\)/);
});

test("temporal: a wall crossing the line yields two ranges", () => {
  const c = compile(
    "sphere a r(0.1) at(-2 0.5 0)\n" +
      "sphere b r(0.1) at(2 0.5 0)\n" +
      "box wall size(0.2 2 2) at(0 1 -5)\n" +
      "move wall by(0 0 10) over(10)\n" +
      "? when sees(a b)",
  );
  assert.equal(c.results[0].text, "when sees(a, b) → 0.00–4.00, 6.00–10.00");
});

test("temporal: absence counts as false — a lifetime bounds the answer", () => {
  const c = compile(
    "sphere a r(0.1) at(-2 0.5 0)\n" +
      "sphere b r(0.1) at(2 0.5 0) appear(1) vanish(3)\n" +
      "? when sees(a b)\n? always sees(a b)",
  );
  assert.equal(c.results[0].text, "when sees(a, b) → 1.00–3.00");
  assert.equal(c.results[1].value, false);
});

test("temporal: when overlaps tracks a pass-through", () => {
  const c = compile(
    "box still size(1 1 1) at(0 0.5 0)\n" +
      "box mover size(1 1 1) at(-3 0.5 0)\n" +
      "move mover by(6 0 0) over(6)\n" +
      "? when overlaps(still mover)",
  );
  const r = c.results[0];
  assert.ok(Math.abs(r.value[0][0] - 2) < 0.001 && Math.abs(r.value[0][1] - 4) < 0.001, r.text);
});

test("temporal: static scenes answer always/never; answers don't scrub", () => {
  const open = compile("box a at(0 0.5 0)\nbox b at(3 0.5 0)\n? when sees(a b)\n? ever sees(a b)");
  assert.equal(open.results[0].text, "when sees(a, b) → always");
  assert.equal(open.results[1].value, true);
  const walled = compile(
    "box a at(0 0.5 0)\nbox b at(4 0.5 0)\nbox wall size(0.2 2 2) at(2 1 0)\n? when sees(a b)",
  );
  assert.equal(walled.results[0].text, "when sees(a, b) → never");
  // a quantified answer is a fact about the timeline: identical at any t
  const moving = compile(
    "box a at(0 0.5 0)\nbox b at(3 0.5 0)\nmove b by(0 0 2) over(2)\n? ever sees(a b)",
  );
  assert.equal(sample(moving, 0).results[0].text, sample(moving, 1.7).results[0].text);
});

test("temporal errors: wrong query kind, unknown names", () => {
  assert.match(
    errorsOf("box a\nbox b\n? when distance(a b)")[0],
    /when works with the true\/false queries/,
  );
  const c = compile("box a at(0 0.5 0)\n? ever sees(a ghost)");
  assert.equal(c.results[0].error, true);
  assert.match(c.results[0].text, /no object or set named "ghost"/);
});

// --------------------------------------------------- room placement by side

test("rooms placed by relation sit wall-to-wall; door(to) needs no coordinates", () => {
  const c = compile(
    "room a size(4 2.5 4) door(to b)\n" +
      "room b size(4 2.5 4) north-of(a)\n" + // room-to-room: gap defaults to 0
      "cylinder p r(0.25) h(1.6) at(0 0.8 0)\n" +
      "cylinder q r(0.25) h(1.6) at(0 0.8 -4.4)\n" +
      "? sees(p q)",
  );
  assert.deepEqual(c.errors, []);
  const b = c.objects.find((o) => o.name === "b");
  assertNear(b.pos, [0, 0, -4.4]); // shells touch: 2.2 + 2.2
  assert.equal(c.results[0].value, true, c.results[0].text); // through the shared door
});

test("room placement: explicit gap still wins; non-rooms keep the 0.25 default", () => {
  assert.match(
    errorsOf("room a size(4 2.5 4) door(to b)\nroom b size(4 2.5 4) north-of(a 0.5)")[0],
    /0\.50 apart.*wall-to-wall/,
  );
  const s = scene("room a size(4 2.5 4)\nbox crate size(1 1 1) north-of(a)");
  assertNear(s.crate.pos, [0, 0.5, -2.95]); // 2.2 + 0.25 + 0.5: default gap kept
});

test("door(to): offset rooms connect on the wall that actually touches", () => {
  // Jeremy's "tough" layout (2026-07-12): two triangles sharing a hub.
  // garden's center is exactly diagonal from command's — the shared wall
  // is west, which center-direction guessing got wrong.
  const c = compile(
    "room command_module size(4 2.5 4) door(to lab_module 1.1) door(to garden_module) door(to airlock_module) door(to sleeping_module)\n" +
      "room lab_module size(4 2.5 4) north-of(command_module)\n" +
      "room sleeping_module size(4 2.5 4) east-of(command_module) door(to airlock_module)\n" +
      "room airlock_module size(8 2.5 4) south-of(sleeping_module)\n" +
      "room garden_module size(4 2.5 9) west-of(lab_module) door(to lab_module)\n",
  );
  assert.deepEqual(c.errors.map((e) => e.msg), []);
  // all six connections exist as doorway markers
  for (const m of [
    "command_module-lab_module-door",
    "command_module-garden_module-door",
    "command_module-airlock_module-door",
    "command_module-sleeping_module-door",
    "sleeping_module-airlock_module-door",
    "garden_module-lab_module-door",
  ]) {
    assert.ok(c.objects.some((o) => o.name === m), "missing " + m);
  }
  // the command↔garden door is on command's WEST wall, centered on the
  // overlap of the two interiors (z ∈ [-2, 0.1] → -0.95)
  const d = c.objects.find((o) => o.name === "command_module-garden_module-door");
  assertNear(d.pos, [-2.2, 0, -0.95]);
});

// -------------------------------------------------------------- at(name)

test("at(name): standing at a named thing, resting on the ground", () => {
  const s = scene(
    "room hq size(4 2.5 4) at(3 0 -5)\n" +
      "cylinder dave r(0.25) h(1.6) at(hq)\n" +
      "cylinder eddie r(0.25) h(1.6) at(hq 1.2 0)\n" +
      "sphere lamp r(0.2) at(dave 0 -0.8)", // relative to another object too
  );
  assert.deepEqual(s.dave.pos, [3, 0.8, -5]); // room's x/z, his own height
  assert.deepEqual(s.eddie.pos, [4.2, 0.8, -5]);
  assert.deepEqual(s.lamp.pos, [3, 0.2, -5.8]);
});

test("at(name) errors: unknown name, cross-frame, bad offsets", () => {
  assert.match(errorsOf("box b at(ghost)")[0], /at\(\): no object named "ghost"/);
  assert.match(
    errorsOf("group g\nbox m in(g)\nbox b at(m)")[0],
    /different group/,
  );
  assert.match(errorsOf("room hq\nbox b at(hq 1)")[0], /at\(name\) or at\(name dx dz\)/);
});

test("pair relations: anchored to the union of two targets' bounds", () => {
  // Jeremy's day-3 layout: the garden runs along command AND lab — no
  // single-target relation can center on the pair
  const s = scene(
    "room command size(4 2.5 4)\n" +
      "room lab size(4 2.5 4) north-of(command)\n" +
      "room garden size(4 2.5 8.4) west-of(command lab)",
  );
  assert.deepEqual(s.garden.pos, [-4.4, 0, -2.2]); // west of both, centered on their span
  // works for plain objects too, with the normal default gap
  const s2 = scene(
    "box a size(1 1 1) at(0 0.5 0)\nbox b size(1 1 1) at(0 0.5 4)\n" +
      "box shelf size(0.5 0.5 5) east-of(a b)",
  );
  assert.deepEqual(s2.shelf.pos, [1, 0.25, 2]); // 0.5 + 0.25 gap + 0.25, centered z=2
  assert.match(errorsOf("box a\nbox b\nbox c east-of(a b x)")[0], /gap must be a number/);
});

// ------------------------------------------------------- clock, walk, doors

test("clock: wall times become timeline seconds; order doesn't matter", () => {
  const c = compile(
    "move b to(4 0.5 0) start(5:15) over(2m)\n" + // uses the clock before it's declared
      "clock 4:45 minute(0.5)\n" +
      "box b at(0 0.5 0) appear(5:00)\n",
  );
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.clock, { start: 285, minute: 0.5 });
  const b = c.objects.find((o) => o.name === "b");
  assert.equal(b.appear, 7.5); // 15 min after 4:45 at 0.5 s/min
  assert.equal(b.track.move[0].t0, 15); // 5:15
  assert.equal(b.track.move[0].t1, 16); // + 2 story-minutes
});

test("clock: temporal answers speak wall time", () => {
  const c = compile(
    "clock 4:45 minute(0.5)\n" +
      "sphere a r(0.1) at(-2 0.5 0)\nsphere b r(0.1) at(2 0.5 0)\n" +
      "box wall size(0.2 2 2) at(0 1 0)\n" +
      "move wall by(0 0 5) start(0) over(5)\n" +
      "? when sees(a b)",
  );
  // clears at t=1 = 4:47; ends t=5 = 4:55
  assert.equal(c.results[0].text, "when sees(a, b) → 4:47–4:55");
});

test("clock errors: h:mm without a clock, before start, duplicates, misuse", () => {
  assert.match(errorsOf("box b appear(5:15)")[0], /declare one first/);
  assert.match(errorsOf("clock 5:00\nbox b appear(4:15)")[0], /before the clock's start/);
  assert.match(errorsOf("clock 4:00\nclock 5:00\nbox b")[0], /one clock per scene/);
  assert.match(errorsOf("clock 4:00\nbox b\nmove b to(1 1 1) over(4:30)")[0], /takes a duration/);
});

const colorAt = (c, name, t) => {
  const o = sample(c, t).objects.find((x) => x.name === name);
  return o.colorMix || o.color;
};

test("paint: snaps by default, chains on its own channel", () => {
  const c = compile(
    "sphere lamp r(0.2) color(#e04a3a)\n" +
      "paint lamp to(#333) start(4)\n" +
      "paint lamp to(#e04a3a) start(11)\n" +
      "move lamp to(0 5 0) over(2)", // spatial channels unaffected
  );
  assert.deepEqual(c.errors, []);
  assert.equal(colorAt(c, "lamp", 0), "#e04a3a");
  assert.equal(colorAt(c, "lamp", 3.999), "#e04a3a");
  assert.equal(colorAt(c, "lamp", 4), "#333"); // snap: over defaults to 0
  assert.equal(colorAt(c, "lamp", 12), "#e04a3a");
  assert.equal(c.duration, 11);
  assertNear(posAt(c, "lamp", 2), [0, 5, 0]); // move untouched by paints
});

test("paint: over() fades — mid-fade hands the renderer a mix", () => {
  const c = compile("box sky size(1 1 1) color(#8db7d6)\npaint sky to(#2b3350) start(2) over(4)");
  assert.deepEqual(c.errors, []);
  assert.equal(colorAt(c, "sky", 1), "#8db7d6");
  assert.deepEqual(colorAt(c, "sky", 4), { from: "#8db7d6", to: "#2b3350", k: 0.5 });
  assert.equal(colorAt(c, "sky", 7), "#2b3350");
  // an unset birth color mixes from null: the renderer's palette pick
  const d = compile("box plain\npaint plain to(red) start(1) over(2)");
  assert.equal(colorAt(d, "plain", 2).from, null);
});

test("paint: chains from appear, takes wall times, fans out over repeats", () => {
  const c = compile("box b appear(3) color(red)\npaint b to(blue) after(2)");
  assert.equal(colorAt(c, "b", 4.9), "red");
  assert.equal(colorAt(c, "b", 5), "blue"); // appear(3) + after(2)
  const d = compile(
    "clock 1:00 minute(0.5)\n" +
      "box coin size(0.2 0.05 0.2) color(gold) repeat(2) spread(1 0 0)\n" +
      "paint coin to(#444) start(1:30)",
  );
  assert.deepEqual(d.errors, []);
  assert.equal(colorAt(d, "coin-1", 16), "#444");
  assert.equal(colorAt(d, "coin-2", 16), "#444");
});

test("paint: a room paints its walls — segments, sills and lintels included", () => {
  const c = compile(
    "room house size(4 2.5 4) door(south) window(east 1 0.8 0.9)\n" +
      "paint house to(white) start(2)\n" +
      "paint house to(green) start(4)", // chains, per wall
  );
  assert.deepEqual(c.errors, []);
  const walls = (t) =>
    sample(c, t).objects.filter((o) => o.shape === "box").map((o) => o.color);
  assert.ok(walls(0).every((col) => col === "#5b6575"));
  assert.ok(walls(2).every((col) => col === "white"));
  assert.ok(walls(4).every((col) => col === "green"));
  assert.ok(sample(c, 0).objects.some((o) => o.name === "house-east-sill")); // windows carved and painted too
});

test("paint: guard rails", () => {
  assert.match(errorsOf("group g\nbox m in(g)\npaint g to(red)")[0], /groups have no surface/);
  assert.match(errorsOf("box a\npaint a to(red) by(1 1 1)")[0], /colors don't add/);
  assert.match(errorsOf("box a\npaint a to(red) from(blue)")[0], /chains from the previous color/);
  assert.match(errorsOf("box a\npaint a")[0], /paint needs to\(color\)/);
  assert.match(
    errorsOf("room a size(4 2.5 4) door(to b)\nroom b size(4 2.5 4) north-of(a)\npaint a-b-door to(red)")[0],
    /markers are invisible/,
  );
  // links CAN be painted: color isn't pose, and a link has a surface
  assert.deepEqual(errorsOf("box a at(0 0.5 0)\nbox b at(4 0.5 0)\nlink rod between(a b)\npaint rod to(red) start(1)"), []);
});

test("paint: rides through parts (instances run their own paints)", () => {
  const c = compile(
    "part flasher\n" +
      "  sphere bulb r(0.2) color(#222)\n" +
      "  paint bulb to(yellow) start(1)\n" +
      "end\n" +
      "flasher f1\n" +
      "flasher f2 scale(2)",
  );
  assert.deepEqual(c.errors, []);
  assert.equal(colorAt(c, "f1-bulb", 2), "yellow");
  assert.equal(colorAt(c, "f2-bulb", 2), "yellow"); // scale never touches time or color
});

test("walk: moves in x z and keeps the walker's height", () => {
  const c = compile(
    "cylinder p r(0.25) h(1.6) at(0 0.8 0)\n" +
      "walk p to(3 2) over(2)\n" +
      "walk p by(0 2) over(1)",
  );
  assert.deepEqual(c.errors, []);
  assertNear(posAt(c, "p", 2), [3, 0.8, 2]);
  assertNear(posAt(c, "p", 3), [3, 0.8, 4]); // chains, still at height
});

test("walk to(name): takes the target's floor position, not its height", () => {
  const c = compile(
    "cylinder p r(0.25) h(1.6) at(0 0.8 0)\n" +
      "sphere beacon r(0.2) at(4 3 1)\n" + // floating: walk ignores its y
      "walk p to(beacon) over(2)",
  );
  assertNear(posAt(c, "p", 2), [4, 0.8, 1]);
});

test("walk to(name dx dz): the target's spot, slid — height still the walker's", () => {
  const c = compile(
    "room parlor size(6 3 6)\n" +
      "cylinder butler r(0.25) h(1.8) at(-8 0.9 0)\n" +
      "walk butler to(parlor 2.5 -1) over(2)",
  );
  assert.deepEqual(c.errors, []);
  assertNear(posAt(c, "butler", 2), [2.5, 0.9, -1]);
});

test("move to(name dx dy dz): the target's position plus a 3d offset", () => {
  const c = compile(
    "box shelf size(2 0.1 0.5) at(4 1.5 0)\n" +
      "sphere ball r(0.2) at(0 3 0)\n" +
      "move ball to(shelf 0 0.25 0) over(1)",
  );
  assert.deepEqual(c.errors, []);
  assertNear(posAt(c, "ball", 1), [4, 1.75, 0]);
});

test("to(name offset): offset arity is per-verb; turn still refuses names", () => {
  assert.ok(errorsOf("box a\nbox b\nwalk a to(b 1) over(1)")
    .some((m) => m.includes("to(name dx dz): expected 2 numbers")));
  assert.ok(errorsOf("box a\nbox b\nmove a to(b 1 2) over(1)")
    .some((m) => m.includes("to(name dx dy dz): expected 3 numbers")));
  assert.ok(errorsOf("box a\nbox b\nturn a to(b 1 2 3) over(1)")
    .some((m) => m.includes("turn to(): expected 3 numbers")));
});

test("parts: walk vectors and to(name) offsets scale with the instance", () => {
  const c = compile(
    "part guy\n" +
      "  box body size(0.4 1.7 0.4)\n" +
      "  box post size(0.2 1 0.2) at(4 0.5 0)\n" +
      "  walk body to(post 2 0) over(2)\n" +
      "  walk body by(0 4) over(1)\n" +
      "end\n" +
      "guy g1 scale(0.5)",
  );
  assert.deepEqual(c.errors, []);
  assertNear(posAt(c, "g1-body", 2), [3, 0.425, 0]); // (4+2)*0.5
  assertNear(posAt(c, "g1-body", 3), [3, 0.425, 2]); // by() scales too
});

test("repeat: an anim fanning out to copies keeps its to(name) offset", () => {
  const c = compile(
    "group pair repeat(2) spread(0 0 3)\n" +
      "box spot size(0.2 0.2 0.2) at(5 0.1 0) in(pair)\n" +
      "cylinder p r(0.25) h(1.6) at(0 0.8 0) in(pair)\n" +
      "walk p to(spot 1 0) over(2)",
  );
  assert.deepEqual(c.errors, []);
  assertNear(posAt(c, "p-1", 2), [6, 0.8, 0]);
  assertNear(posAt(c, "p-2", 2), [6, 0.8, 3]);
});

test("doorway markers: shared and manual doors become named places", () => {
  const c = compile(
    "room a size(4 2.5 4) at(0 0 0) door(to b) door(south 1 0.5)\n" +
      "room b size(4 2.5 4) at(4.4 0 0)\n" +
      "cylinder p r(0.25) h(1.6) at(0 0.8 0)\n" +
      "walk p to(a-b-door) over(2)\n" +
      "? distance(p a-b-door)\n" +
      "? sees(p a-b-door)", // markers never block, incl. themselves
  );
  assert.deepEqual(c.errors, []);
  const shared = c.objects.find((o) => o.name === "a-b-door");
  assert.equal(shared.shape, "marker");
  assertNear(shared.pos, [2.2, 0, 0]); // on the shared wall plane, centered
  const manual = c.objects.find((o) => o.name === "a-south-door");
  assertNear(manual.pos, [0.5, 0, 2.1]);
  assertNear(posAt(c, "p", 2), [2.2, 0.8, 0]); // walked to the doorway
  assert.equal(c.results[1].value, true, c.results[1].text);
});

// ------------------------------------------------------------ in and check

const TWO_ROOMS =
  "clock 2:00 minute(0.5)\n" +
  "room hq size(4 2.5 4) door(to lab)\n" +
  "room lab size(4 2.5 4) north-of(hq)\n" +
  "cylinder carol r(0.25) h(1.6) at(hq)\n" +
  "walk carol to(hq-lab-door) start(2:10) over(2m)\n" +
  "walk carol to(lab) over(2m)\n"; // in the lab by 2:14

test("in(): room presence, instant and quantified, in wall time", () => {
  const c = compile(
    TWO_ROOMS + "? in(carol hq)\n? when in(carol lab)\n? never in(carol lab) during(2:00 2:10)",
  );
  assert.deepEqual(c.errors, []);
  assert.equal(c.results[0].value, true); // at t=0 she's in hq
  assert.match(c.results[1].text, /when in\(carol, lab\) → 2:1\d.*–2:00.*|when in\(carol, lab\) → 2:1/);
  assert.equal(c.results[2].value, true, c.results[2].text); // not in the lab before she left
});

test("in(): strict — standing in the doorway is in neither room", () => {
  const c = compile(
    "room a size(4 2.5 4) door(to b)\n" +
      "room b size(4 2.5 4) north-of(a)\n" +
      "cylinder p r(0.25) h(1.6) at(0 0.8 -2.2)\n" + // dead center of the shared doorway
      "? in(p a)\n? in(p b)",
  );
  assert.equal(c.results[0].value, false);
  assert.equal(c.results[1].value, false);
});

test("at(time): pins any query to an instant", () => {
  const c = compile(TWO_ROOMS + "? in(carol lab) at(2:20)\n? distance(carol hq-lab-door) at(2:00)");
  assert.deepEqual(c.errors, []);
  assert.equal(c.results[0].value, true, c.results[0].text);
  assert.equal(typeof c.results[1].value, "number");
  // pinned answers are constant while scrubbing
  assert.equal(sample(c, 0).results[0].text, sample(c, 9).results[0].text);
});

test("check: passing assertions are ✓ results, not errors", () => {
  const c = compile(
    TWO_ROOMS +
      "check in(carol hq) at(2:05)\n" +
      "check never in(carol lab) during(2:00 2:10)\n" +
      "check ever in(carol lab)",
  );
  assert.deepEqual(c.errors, []);
  for (const r of c.results) assert.match(r.text, /^✓ check/);
});

test("check: a typo'd name in a check is a compile error, never a silent pass", () => {
  const errs = errorsOf("box a at(0 0.5 0)\ncheck ever in(a ghost)");
  assert.match(errs[0], /no object or set named "ghost"/);
});

test("check: failures are compile errors carrying the violating times", () => {
  const c = compile(TWO_ROOMS + "check never in(carol lab)\ncheck always in(carol hq)");
  assert.equal(c.errors.length, 2);
  assert.match(c.errors[0].msg, /✗ check never in\(carol, lab\) → false \(true 2:1\d/);
  assert.match(c.errors[1].msg, /✗ check always in\(carol, hq\) → false \(fails 2:1\d/);
  assert.match(c.results[0].text, /^✗/);
  assert.equal(c.results[0].error, true);
});

test("check/query validation: shapes of the grammar", () => {
  assert.match(errorsOf("box a\nbox b\ncheck when sees(a b)")[0], /true\/false answer/);
  assert.match(errorsOf("box a\nbox b\ncheck sees(a b)")[0], /needs ever\/always\/never, or at\(time\)/);
  assert.match(errorsOf("box a\nbox b\ncheck distance(a b) at(1)")[0], /true\/false query/);
  assert.match(errorsOf("box a\nbox b\n? sees(a b) during(0 5)")[0], /during\(\) needs ever/);
  assert.match(errorsOf("box a\nbox b\n? ever sees(a b) at(1)")[0], /quantifier or at\(time\), not both/);
  // never + at(time) is the exception: a negative claim about an instant
  const c = compile(
    TWO_ROOMS +
      "check never in(carol lab) at(2:05)\n" + // she's still in hq: passes
      "check never in(carol hq) at(2:05)", // she IS in hq: fails
  );
  assert.equal(c.errors.length, 1);
  assert.match(c.results[0].text, /^✓ check never in\(carol, lab\) at\(2:05\) → true/);
  assert.match(c.results[1].text, /^✗ check never in\(carol, hq\) at\(2:05\) → false \(it was\)/);
  assert.match(errorsOf("box a\nbox b\n? never distance(a b)")[0], /true\/false queries/);
});

// ------------------------------------------------------------------- links

test("link: spans its endpoints and re-derives as they move", () => {
  const c = compile(
    "sphere a r(0.2) at(0 1 0)\n" +
      "sphere b r(0.2) at(4 1 0)\n" +
      "link rod between(a b) r(0.1)\n" +
      "move b by(0 2 0) over(2)",
  );
  assert.deepEqual(c.errors, []);
  const rodAt = (t) => sample(c, t).objects.find((o) => o.name === "rod");
  assertNear(rodAt(0).pos, [2, 1, 0]);
  assert.ok(Math.abs(rodAt(0).len - 4) < 1e-9);
  const r2 = rodAt(2);
  assertNear(r2.pos, [2, 2, 0]);
  assert.ok(Math.abs(r2.len - Math.hypot(4, 2)) < 1e-9, "length follows the moving endpoint");
  assert.notDeepEqual(r2.rot, [0, 0, 0]); // reoriented off the axis
});

test("link: is physical — it blocks sight lines; absent when an endpoint is", () => {
  const c = compile(
    "sphere a r(0.2) at(0 1 0)\n" +
      "sphere b r(0.2) at(4 1 0) vanish(1)\n" +
      "link rod between(a b) r(0.1)\n" +
      "sphere eyeA r(0.1) at(2 1 -2)\nsphere eyeB r(0.1) at(2 1 2)\n" +
      "? when sees(eyeA eyeB)",
  );
  assert.deepEqual(c.errors, []);
  // blocked by the rod until b (and so the rod) vanishes at t=1
  assert.equal(c.results[0].text, "when sees(eyeA, eyeB) → 1.00–1.00");
  const hit = sample(c, 0.5).objects && compile(
    "sphere a r(0.2) at(0 1 0)\nsphere b r(0.2) at(4 1 0)\nlink rod between(a b) r(0.1)\n" +
      "sphere eyeA r(0.1) at(2 1 -2)\nsphere eyeB r(0.1) at(2 1 2)\n? blocked-by(eyeA eyeB)",
  ).results[0];
  assert.deepEqual(hit.value, ["rod"]);
});

test("link: crosses frames — tracks a member of a moving group", () => {
  const c = compile(
    "group truck at(0 0 0)\n" +
      "box hitch size(0.2 0.2 0.2) in(truck) at(0 0.5 0)\n" +
      "box post size(0.2 1 0.2) at(0 0.5 -3)\n" +
      "link tow between(hitch post) r(0.05)\n" +
      "move truck by(4 0 0) over(2)",
  );
  assert.deepEqual(c.errors, []);
  const tow = (t) => sample(c, t).objects.find((o) => o.name === "tow");
  assert.ok(Math.abs(tow(0).len - 3) < 1e-9);
  assert.ok(Math.abs(tow(2).len - 5) < 1e-9); // 3-4-5 triangle after the drive
});

test("link errors: the boundaries hold", () => {
  assert.match(errorsOf("link rod r(0.1)")[0], /needs between\(a b\)/);
  assert.match(errorsOf("box a\nlink rod between(a ghost)")[0], /no object named "ghost"/);
  assert.match(
    errorsOf("box a\nbox b\nbox c\nlink r1 between(a b)\nlink r2 between(r1 c)")[0],
    /links can't chain/,
  );
  assert.match(errorsOf("box a\nbox b\nlink rod between(a b)\nmove rod by(1 0 0)")[0], /pose is derived/);
  assert.match(errorsOf("box a\nbox b\nlink rod between(a b)\nbox c on(rod)")[0], /no placed position/);
  assert.match(errorsOf("box a\nbox b\nlink rod between(a b) at(1 1 1)")[0], /links derive their pose/);
  assert.match(errorsOf("box a\nbox b\nlink rod between(a b) repeat(2)")[0], /links derive their pose/);
});

// -------------------------------------------------------------------- sets

const CASE_FILE =
  "clock 2:00 minute(0.5)\n" +
  "room hq size(4 2.5 4) door(to lab)\n" +
  "room lab size(4 2.5 4) north-of(hq)\n" +
  "cylinder ann r(0.25) h(1.6) at(hq)\n" +
  "cylinder ben r(0.25) h(1.6) at(hq 1.2 0)\n" +
  "cylinder cat r(0.25) h(1.6) at(lab)\n" +
  "set suspects ann ben cat\n" + // set can be declared after or before members
  "walk ben to(hq-lab-door) start(2:10) over(2m)\n" +
  "walk ben to(lab) over(2m)\n";

test("set: someone/nobody — quantified presence with a witness", () => {
  const c = compile(
    CASE_FILE +
      "? in(suspects lab)\n" + // someone in the lab now?
      "check ever in(suspects lab)\n" +
      "check never in(suspects hq) during(2:20 2:30)\n", // hq empties? no — ann stays
  );
  assert.equal(c.results[0].value, true);
  assert.match(c.results[0].text, /→ true \(cat\)/); // the witness is named
  assert.match(c.results[1].text, /^✓/);
  assert.match(c.results[2].text, /^✗ check never in\(suspects, hq\)/);
  assert.equal(c.errors.length, 1); // the failing check is a compile error
});

test("set: except() makes 'alone' writable; typos in except are errors", () => {
  const c = compile(
    CASE_FILE +
      "check always in(cat lab) during(2:20 2:30)\n" +
      "check always in(ben lab) during(2:20 2:30)\n" +
      "check never in(suspects lab) except(ben cat) during(2:20 2:30)\n", // and no one else
  );
  assert.deepEqual(c.errors, []);
  for (const r of c.results) assert.match(r.text, /^✓/);
  assert.match(
    errorsOf(CASE_FILE + "check never in(suspects lab) except(bob)")[0],
    /except\(\): "bob" isn't in suspects/,
  );
});

test("set: temporal answers attribute per member — the alibi query", () => {
  const c = compile(
    CASE_FILE +
      "? never in(suspects lab) during(2:10 2:30)\n" + // who lacks an alibi?
      "? when in(suspects lab) during(2:10 2:30)\n" +
      "? when in(suspects lab) during(2:10 2:30) except(ben)\n" +
      "? ever in(suspects lab) during(2:10 2:30)",
  );
  assert.deepEqual(c.errors, []);
  const [never, when, whenEx, ever] = c.results.map((r) => r.text);
  // never=false names only the members it's false BECAUSE of, with times
  assert.match(never, /→ false \(ben \d.*; cat always\)$/);
  assert.doesNotMatch(never, /ann/); // ann is alibied: not listed
  // when breaks out every member
  assert.match(when, /→ ann never; ben \d.*; cat always/);
  assert.doesNotMatch(whenEx.slice(whenEx.indexOf("→")), /ben/); // except() drops the member entirely
  assert.match(ever, /→ true \(ben \d.*; cat always\)/);
  // the machine-readable breakdown rides on the result
  const m = c.results[1].members;
  assert.equal(m.length, 3);
  assert.equal(m[0].name, "ann");
  assert.deepEqual(m[0].ranges, []);
});

test("set: instant answers name ALL witnesses — the candidate set", () => {
  const c = compile(
    CASE_FILE +
      "? in(suspects hq)\n" + // at t=0: ann AND ben are both in hq
      "check never in(suspects hq) at(2:00)\n" + // fails, naming both
      "? in(suspects hq) except(ann)",
  );
  assert.match(c.results[0].text, /→ true \(ann, ben\)/);
  assert.deepEqual(c.results[0].witnesses, ["ann", "ben"]);
  assert.match(c.results[1].text, /✗ .* → false \(ann, ben\)/);
  assert.match(c.results[2].text, /→ true \(ben\)/); // except() trims the pool
});

test("set: always stays pooled — a fact about the place, not a member", () => {
  const c = compile(CASE_FILE + "? always in(suspects hq) during(2:00 2:10)");
  assert.equal(c.results[0].value, true); // ann and ben cover it jointly
  assert.doesNotMatch(c.results[0].text, /ann|ben|cat/);
});

test("set: repeat families are implicit sets — the stray-bolt debug", () => {
  const c = compile(
    "room bay size(4 2.5 4) door(to cabin)\n" +
      "room cabin size(4 2.5 4) north-of(bay)\n" +
      "box bolt size(0.05 0.02 0.05) at(bay -1 0) repeat(3) spread(0.2 0 0)\n" +
      "move bolt-2 to(-0 0.5 -4.4) start(1) over(1)\n" + // one bolt strays
      "check never in(bolt cabin)\n" +
      "? when in(bolt cabin)",
  );
  assert.equal(c.errors.length, 1);
  assert.match(c.errors[0].msg, /✗ check never in\(bolt, cabin\)/);
  assert.match(c.results[1].text, /when in\(bolt, cabin\) → bolt-1 never; bolt-2 \d.*; bolt-3 never/); // the stray is NAMED
});

test("window: a y-band opening — sill and lintel stay, the band is open", () => {
  const c = compile(
    "room a size(4 2.8 4) window(to b 0.4 0.4 2.1)\n" +
      "room b size(4 2.8 4) north-of(a)\n" +
      "sphere low_eye r(0.05) at(a 0 1)\n" +
      "sphere low_tgt r(0.05) at(b 0 -1)\n" +
      "sphere high_eye r(0.05) at(0 2.3 1)\n" + // at band height, in a
      "sphere high_tgt r(0.05) at(0 2.3 -5.4)\n" + // at band height, in b
      "? sees(low_eye low_tgt)\n" +
      "? sees(high_eye high_tgt)\n" +
      "? adjacent(a b)",
  );
  assert.deepEqual(c.errors, []);
  const names = c.objects.map((o) => o.name);
  assert.ok(names.includes("a-north-sill") && names.includes("a-north-lintel"));
  assert.ok(names.includes("b-south-sill") && names.includes("b-south-lintel"));
  const mk = c.objects.find((o) => o.name === "a-b-window");
  assert.equal(mk.shape, "marker");
  assertNear(mk.pos, [0, 2.3, -2.2]); // band center, on the shared plane
  assert.equal(c.results[0].value, false); // ground-level sight: walls block
  assert.equal(c.results[1].value, true); // band-height sight passes through
  assert.equal(c.results[2].value, false); // a window is NOT adjacency
});

test("window: manual form, defaults, and guard rails", () => {
  const c = compile("room c size(4 2.5 4) window(south 1.2 1 0.9)");
  assert.deepEqual(c.errors, []);
  const mk = c.objects.find((o) => o.name === "c-south-window");
  assertNear(mk.pos, [0, 1.4, 2.1]); // sill 0.9 + h/2
  assert.match(errorsOf("room r size(4 2.5 4) window(south 1 2 1)")[0], /doesn't fit a 2.5-high wall/);
  assert.match(errorsOf("room r size(4 2.5 4) window(up 1)")[0], /first argument is a side/);
  assert.match(
    errorsOf("room r size(4 2.5 4) door(south 1) window(south 1 1 0.5)")[0],
    /openings overlap/,
  );
  assert.match(
    errorsOf("room a size(4 2.5 4) window(to b 0.4 0.4 2.3)\nroom b size(4 2.5 4) north-of(a)")[0],
    /doesn't fit a 2.5-high wall/,
  );
});

test("adjacent: a static fact read off the door(to) graph", () => {
  const c = compile(
    "room a size(4 2.5 4) door(to b)\n" +
      "room b size(4 2.5 4) north-of(a) door(to c)\n" +
      "room c size(4 2.5 4) north-of(b)\n" +
      "room lone size(4 2.5 4) at(20 0 0) door(south)\n" + // manual door: no adjacency fact
      "? adjacent(a b)\n" +
      "? adjacent(b a)\n" + // symmetric
      "? adjacent(a c)\n" + // two doors apart: NOT adjacent (no transitivity)
      "check adjacent(b c)",
  );
  assert.deepEqual(c.errors, []);
  assert.equal(c.results[0].value, true);
  assert.equal(c.results[1].value, true);
  assert.equal(c.results[2].value, false);
  assert.match(c.results[3].text, /^✓/);
});

test("adjacent: failing checks are compile errors; time words rejected", () => {
  const TWO = "room a size(4 2.5 4) door(to b)\nroom b size(4 2.5 4) north-of(a)\nbox crate\n";
  assert.match(errorsOf(TWO + "check adjacent(a crate)")[0], /isn't a room/);
  const fail = compile(TWO + "room far size(4 2.5 4) at(30 0 0)\ncheck adjacent(a far)");
  assert.equal(fail.errors.length, 1);
  assert.match(fail.errors[0].msg, /✗ check adjacent\(a, far\)/);
  assert.match(errorsOf(TWO + "? ever adjacent(a b)")[0], /takes no quantifier/);
  assert.match(errorsOf(TWO + "? adjacent(a b) at(3)")[0], /doesn't change over time/);
  assert.match(errorsOf(TWO + "check adjacent(a b) during(1 2)")[0], /doesn't change over time/);
});

test("goals: multiline — incompleteness continues the line", () => {
  const c = compile(
    "room field\n" +
      "?- where(body, found, R),\n" +
      "   exactly_one(suspects, R, found, Killer),\n" +
      "\n" + // blank line inside is fine
      "   testimony(Killer, earl_grey, present_at(x, field, 0))\n" +
      "? in(body field)", // and the next statement is untouched
  );
  assert.deepEqual(c.errors, []);
  assert.equal(c.goals.length, 1);
  assert.match(c.goals[0].goal, /^where.*testimony\(Killer, earl_grey.*0\)\)$/);
  assert.equal(c.queries.length, 1);
});

test("goals: ?- lines are data for the rules layer, not queries", () => {
  const c = compile(
    "room lion size(4 2.5 4)\n" +
      "?- could(suspects, X, lion, time_of_death)\n" +
      "?- sole(suspects, X, lion, time_of_death).", // trailing dot tolerated
  );
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.goals.map((g) => g.goal), [
    "could(suspects, X, lion, time_of_death)",
    "sole(suspects, X, lion, time_of_death)",
  ]);
  assert.equal(c.results.length, 0); // not evaluated by the core
  assert.match(errorsOf("?- ")[0], /expected: \?- goal/);
  assert.match(errorsOf("at 2\n?- could(x)\nend")[0], /don't take a time block/);
});

// ------------------------------------------------------------------- facts

test("facts: the world derived as ground facts (v3 substrate)", () => {
  const c = compile(
    "clock 1:00 minute(0.5)\n" +
      "time time_of_death 3:00\n" +
      "room lion size(4 2.5 4) door(to aviary)\n" +
      "room aviary size(4 2.5 4) north-of(lion)\n" +
      "room unknown size(4 2.5 4) at(-9 0 0)\n" +
      "cylinder eddie r(0.25) h(1.6) at(unknown)\n" +
      "cylinder carol r(0.25) h(1.6) at(aviary) appear(1:05)\n" +
      "set suspects eddie carol\n" +
      "walk eddie to(lion 1 0) start(2:00) over(0)\n" +
      "walk eddie to(unknown) start(2:30) over(0)",
  );
  assert.deepEqual(c.errors, []);
  const f = c.facts;
  assert.deepEqual(f.rooms, ["lion", "aviary", "unknown"]);
  assert.deepEqual(f.adjacent, [["aviary", "lion"]]);
  assert.deepEqual(f.sets.suspects, ["eddie", "carol"]);
  assert.equal(f.times.time_of_death, 60);
  assert.deepEqual(f.lifetimes, [{ name: "carol", appear: 2.5, vanish: null }]);
  const eddieLion = f.whereabouts.find((w) => w.name === "eddie" && w.room === "lion");
  assert.deepEqual(eddieLion.ranges, [[30, 45]]); // leapt in at 2:00, out at 2:30
  // walls and markers are room structure, never movers
  assert.ok(!f.whereabouts.some((w) => w.name.includes("-")));
});

test("facts: visible intervals — sees() published as data, for set members", () => {
  const c = compile(
    "room store size(8 2.5 6) door(south)\n" +
      "box cam size(0.3 0.3 0.3) at(-3.5 2 -2.5)\n" +
      "box wall_stack size(1.5 2 1) at(0 1 0)\n" +
      "box crate_open size(0.8 0.8 0.8) at(-2 0.4 1.5)\n" +
      "box crate_hidden size(0.8 0.8 0.8) at(1.6 0.4 1.2)\n" + // behind the stack from cam
      "cylinder guard r(0.25) h(1.7) at(-3 0.85 1.5)\n" +
      "walk guard to(3 1.5) start(1) over(2)\n" + // crosses behind the stack
      "set cams cam\n" +
      "set crates crate_open crate_hidden\n" +
      "set staff guard",
  );
  assert.deepEqual(c.errors, []);
  const pair = (a, b) => c.facts.visible.find((v) => (v.a === a && v.b === b) || (v.a === b && v.b === a));
  assert.ok(pair("cam", "crate_open"), "clear pair exports intervals");
  assert.ok(!pair("cam", "wall_stack"), "non-set objects get no sight facts");
  const hidden = pair("cam", "crate_hidden");
  assert.ok(!hidden || hidden.ranges.length === 0); // never visible: no fact (or empty)
  const g = pair("cam", "guard");
  assert.equal(g.ranges.length, 1);
  assert.ok(g.ranges[0][1] < 2.5, "the guard walks out of coverage and stays out");
  assert.ok(pair("cam", "crate_open").ranges.length >= 2, "the guard's body briefly blocks the crate");
});

test("facts: left_of order facts — the end-of-timeline arrangement, set members incl. rooms", () => {
  const c = compile(
    "room west_house door(south)\n" +
      "room east_house at(5 0 0) door(south)\n" +
      "set houses west_house east_house\n" +
      "box a size(0.5 0.5 0.5) at(4 0.25 0)\n" +
      "box b size(0.5 0.5 0.5) at(-4 0.25 0)\n" +
      "set movers a b\n" +
      "move b to(9 0.25 0) start(1) over(1)", // b ENDS east of a: order is the horizon pose
  );
  assert.deepEqual(c.errors, []);
  const has = (x, y) => c.facts.leftOf.some(([p, q]) => p === x && q === y);
  assert.ok(has("west_house", "east_house") && !has("east_house", "west_house"));
  assert.ok(has("a", "b") && !has("b", "a")); // despite b starting west of a
  const { prolog } = require("../lang.js");
  assert.match(prolog(c), /left_of\(west_house, east_house\)\./);
});

test("facts: prolog emits visible/4 both directions; rules helpers exist", () => {
  const { prolog } = require("../lang.js");
  const c = compile(
    "box a size(0.5 0.5 0.5) at(-2 0.25 0)\n" +
      "box b size(0.5 0.5 0.5) at(2 0.25 0)\n" +
      "set things a b",
  );
  const text = prolog(c);
  assert.match(text, /visible\(a, b, 0, 0\)\./); // static scene: the t=0 instant
  assert.match(text, /visible\(b, a, 0, 0\)\./);
  const rules = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "rules.pl"), "utf8");
  for (const head of ["visible_at", "all_visible", "unseen"]) {
    assert.ok(new RegExp("^" + head + "\\(", "m").test(rules), head + " defined in rules.pl");
  }
});

test("facts: prolog text renders atoms safely and closes symmetry", () => {
  const { prolog } = require("../lang.js");
  const c = compile(
    "room lion_enclosure size(4 2.5 4) door(to monkey-island)\n" +
      "room monkey-island size(4 2.5 4) north-of(lion_enclosure)\n" +
      "cylinder bob r(0.25) h(1.6) at(lion_enclosure)",
  );
  const text = prolog(c);
  assert.match(text, /room\('monkey-island'\)\./); // hyphens force quoting
  assert.match(text, /adjacent\(lion_enclosure, 'monkey-island'\)\./);
  assert.match(text, /adjacent\('monkey-island', lion_enclosure\)\./); // both directions
  assert.match(text, /in\(bob, lion_enclosure, 0, 0\)\./); // static scene: the t=0 instant
});

test("set block: declarations inside enroll — membership single-sourced", () => {
  const c = compile(
    "room unknown size(4 2.5 4) at(-9 0 0)\n" +
      "set platforms\n" +
      "  cylinder fewer_courses r(.4) h(.5) sides(5) at(unknown -1 1.5)\n" +
      "  cylinder overturn r(.4) h(.5) sides(5) at(unknown -1 0)\n" +
      "end\n" +
      "set houses\n" + // rooms enroll too
      "  room house_1 door(south)\n" +
      "  room house_2 at(5 0 0) door(south)\n" +
      "end\n" +
      "? in(platforms unknown)",
  );
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.sets.get("platforms"), ["fewer_courses", "overturn"]);
  assert.deepEqual(c.sets.get("houses"), ["house_1", "house_2"]);
  assert.match(c.results[0].text, /→ true \(fewer_courses, overturn\)/);
});

test("set block: guard rails", () => {
  assert.match(errorsOf("set things\nend")[0], /set "things" is empty/);
  assert.match(errorsOf("set things\nbox a")[0], /missing its end/);
  assert.ok(errorsOf("set things\nwalk a to(1 1)\nend").some((m) => /encloses declarations/.test(m)));
  assert.ok(errorsOf("set things\nbox a repeat(2)\nend").some((m) => /already form a set/.test(m)));
  assert.match(errorsOf("set things a b\nbox a\nbox b\nset things\nbox c\nend")[0], /already defined/);
});

test("set errors: the guard rails", () => {
  assert.match(errorsOf("box a\nset suspects a ghost")[0], /set suspects: no object named "ghost"/);
  assert.match(errorsOf("box a\nset a a")[0], /collides with an object/);
  assert.match(errorsOf("box a\nset s a\nset s a")[0], /already defined/);
  const c = compile("box a\nbox b\nset s a b\nset t a b\n? in(s t)");
  assert.match(c.results[0].text, /one set per query/);
  const d = compile("box a\nbox b\nset s a b\n? distance(s b)");
  assert.match(d.results[0].text, /distance can't take a set/);
  const e = compile("box a\nbox b\n? in(a b) except(a)");
  assert.match(e.results[0].text, /except\(\) needs a set/);
});

// ------------------------------------------------------------------- tubes

test("tube desugars into a ring of segments, base resting at the origin", () => {
  const s = scene("tube well r(0.3) h(4)");
  assert.equal(s.well.shape, "group");
  const segs = Object.values(s).filter((o) => o.name.startsWith("well-seg-"));
  assert.equal(segs.length, 8); // default sides(8)
  // base-anchored like a room: segment centers at h/2, so the tube
  // stands on the ground — and at() places the BASE, not the center
  const posed = sample(compile("tube well r(0.3) h(4)"), 0).objects;
  assert.equal(posed.find((o) => o.name === "well-seg-1").pos[1], 2);
  const sunk = sample(compile("tube well r(0.3) h(4) at(0 -4 0)"), 0).objects;
  assert.equal(sunk.find((o) => o.name === "well-seg-1").pos[1], -2);
});

test("tube hollowness is a fact: bore open, wall solid, union bounds contain", () => {
  const c = compile(`tube well r(0.3) h(4)
sphere pebble r(0.1) at(0 0.5 0)
sphere eye r(0.1) at(0 6 0)
sphere side r(0.1) at(3 0.5 0)
? sees(eye pebble)
? sees(side pebble)
? in(pebble well)`);
  assert.deepEqual(c.errors, []);
  const r = Object.fromEntries(sample(c, 0).results.map((x) => [x.text.split(" →")[0], x.text]));
  assert.match(r["sees(eye, pebble)"], /true/); // straight down the bore
  assert.match(r["sees(side, pebble)"], /false \(blocked by well-seg-/); // not through the wall
  assert.match(r["in(pebble, well)"], /true/);
});

test("tube knobs: sides(), walls(), color(); segments share a palette family", () => {
  const s = scene("tube pipe r(1) h(2) sides(12) walls(0.2) color(gray)");
  const segs = Object.values(s).filter((o) => o.name.startsWith("pipe-seg-"));
  assert.equal(segs.length, 12);
  assert.equal(segs[0].color, "gray");
  assert.equal(segs[0].family, "pipe/seg"); // "/" keeps it out of implicit sets
  assert.ok(!compile("tube pipe r(1) h(2)").sets.has("pipe"));
});

test("tube composes: repeat clones the ring, parts bake scale", () => {
  const rep = scene("tube post r(0.2) h(3) repeat(3) spread(2 0 0)");
  assert.equal(Object.values(rep).filter((o) => o.shape === "group").length, 3);
  assert.equal(Object.keys(rep).filter((n) => /^post-seg-\d+-\d$/.test(n)).length, 24);
  const part = scene("part wellhead\n  tube shaft r(0.3) h(2)\nend\nwellhead big scale(2)");
  assert.equal(part["big-shaft-seg-1"].size[1], 4); // h scaled
  assert.equal(part["big-shaft"].tube.h, 4); // meta baked too
});

test("paint a tube paints its segments (like painting a room's walls)", () => {
  const c = compile("tube well r(0.3) h(4) color(gray)\npaint well to(red) start(1)");
  assert.deepEqual(c.errors, []);
  const seg = sample(c, 2).objects.find((o) => o.name === "well-seg-1");
  assert.equal(seg.color, "red");
});

test("tube segments are structure: excluded from whereabouts facts", () => {
  const c = compile(`room cellar size(4 3 4)
tube shaft r(0.3) h(3) at(0 0 0)
sphere ball r(0.1) at(0 1 0)`);
  const who = new Set(c.facts.whereabouts.map((w) => w.name));
  assert.ok(who.has("ball"));
  assert.ok(![...who].some((n) => n.includes("seg")));
});

test("tube errors: walls(0), bad sides, name collision", () => {
  assert.match(errorsOf("tube a r(1) h(1) walls(0)")[0], /a tube IS its wall/);
  assert.match(errorsOf("tube a r(1) h(1) sides(2)")[0], /3 to 64/);
  assert.match(errorsOf("box c-seg-1\ntube c r(1) h(1)")[0], /name is taken/);
});

test("compiled.parts names defined parts (so the playground can hint)", () => {
  const c = compile("part straw\n  box seg size(1 1 1)\nend");
  assert.deepEqual(c.parts, ["straw"]);
  assert.equal(c.objects.length, 0); // a part alone renders nothing
  assert.deepEqual(c.errors, []);
});

// -------------------------------------------------------------- possession

test("held-by: the held thing sits at its holder and rides every move", () => {
  const c = compile(`cylinder slate at(2 0) h(1.8)
box token size(0.2 0.2 0.2) held-by(slate)
walk slate to(6 0) over(2)`);
  assert.deepEqual(c.errors, []);
  const at0 = sample(c, 0).objects.find((o) => o.name === "token");
  assert.deepEqual(at0.pos, [2, 0.9, 0]); // concealed: the holder's center
  const at2 = sample(c, 2).objects.find((o) => o.name === "token");
  assert.deepEqual(at2.pos, [6, 0.9, 0]); // one walk, both went
});

test("held-by offset rides the holder's rotation like a pocket", () => {
  const c = compile(`box guy size(1 2 1) rotate(0 90 0)
box lamp size(0.2 0.2 0.2) held-by(guy 1 0 0)`);
  const lamp = sample(c, 0).objects.find((o) => o.name === "lamp");
  // +x offset, holder turned 90° about y → offset points down -z
  assert.ok(Math.abs(lamp.pos[0] - 0) < 1e-9 && Math.abs(lamp.pos[2] - -1) < 1e-9);
  assert.deepEqual(lamp.rot, [0, 90, 0]); // held inherits the holder's rotation
});

test("held-by chains: the letter in the purse in the hand", () => {
  const c = compile(`cylinder slate at(0 0) h(1.8)
box purse size(0.3 0.3 0.1) held-by(slate 0.5 0 0)
box letter size(0.2 0.1 0.01) held-by(purse)
walk slate to(4 0) over(1)`);
  assert.deepEqual(c.errors, []);
  const letter = sample(c, 1).objects.find((o) => o.name === "letter");
  assert.deepEqual(letter.pos, [4.5, 0.9, 0]);
});

test("held things vanish with their holder", () => {
  const c = compile(`box guy size(1 2 1) vanish(5)
box coin size(0.1 0.1 0.1) held-by(guy)`);
  assert.equal(sample(c, 4).objects.find((o) => o.name === "coin").present, true);
  assert.equal(sample(c, 6).objects.find((o) => o.name === "coin").present, false);
});

test("concealment is geometry: a pocketed thing can't be seen, but is in the room", () => {
  const c = compile(`room cell size(3 2.5 3)
cylinder slate at(cell) h(1.8)
box knife size(0.1 0.4 0.05) held-by(slate)
sphere eye r(0.1) at(0 1.5 6)
? sees(eye knife)
? in(knife cell)`);
  assert.deepEqual(c.errors, []);
  assert.equal(c.results.find((q) => q.text.includes("sees")).value, false); // the holder blocks
  assert.equal(c.results.find((q) => q.text.includes("in(")).value, true);
});

test("held-by exports has/2 facts and whereabouts track the holder", () => {
  const c = compile(`clock 1:00 minute(1)
room a size(3 2 3) at(0 0 0)
room b size(3 2 3) east-of(a 2)
cylinder slate at(a) h(1.8)
box token size(0.2 0.2 0.2) held-by(slate)
walk slate to(b) over(2) start(1:01)`);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.facts.has, [["slate", "token", 0, c.facts.duration]]);
  assert.match(prolog(c), /has\(slate, token, 0, /);
  const tokenRooms = c.facts.whereabouts.filter((w) => w.name === "token").map((w) => w.room);
  assert.ok(tokenRooms.includes("a") && tokenRooms.includes("b")); // Cooper's money problem
});

test("held-by composes with parts: refs remap, offsets scale", () => {
  const s = scene(`part porter
  box body size(0.6 1.8 0.6)
  box case size(0.4 0.3 0.2) held-by(body 0.5 0 0)
end
porter p scale(2)`);
  assert.equal(s["p-case"].heldBy.ref, "p-body");
  assert.deepEqual(s["p-case"].heldBy.off, [1, 0, 0]);
});

test("wear anchors: the scarf sits at the neck, visible, and scales with the person", () => {
  const c = compile(`person bob at(0 0)
box scarf size(0.3 0.05 0.2) held-by(bob neck)
sphere eye r(0.1) at(0 1.3 -6)
? sees(eye scarf)`);
  assert.deepEqual(c.errors, []);
  const scarf = sample(c, 0).objects.find((o) => o.name === "scarf");
  const bodyH = 1.7 - 2 * 0.11 * 1.7;
  assert.ok(Math.abs(scarf.pos[1] - bodyH) < 1e-9); // top of the body: the neck
  assert.ok(scarf.pos[2] < 0); // front surface — worn, not buried
  assert.equal(c.results[0].value, true); // and honestly SEEABLE, unlike a pocketed one
  // a scaled person wears at scaled height
  const tall = compile(`person giant h(3.4) at(0 0)
box hat size(0.4 0.15 0.4) held-by(giant head)`);
  const hat = sample(tall, 0).objects.find((o) => o.name === "hat");
  assert.ok(Math.abs(hat.pos[1] - 3.4) < 1e-9); // at the crown
});

test("wear anchors ride rotation, work in take off(), and guard non-persons", () => {
  const c = compile(`person bob at(0 0) rotate(0 180 0)
box badge size(0.1 0.1 0.02) held-by(bob chest)`);
  const badge = sample(c, 0).objects.find((o) => o.name === "badge");
  assert.ok(badge.pos[2] > 0); // turned around: the chest now faces +z
  const taken = compile(`person cop at(0 0)
box lantern size(0.15 0.25 0.15) at(3 0)
take cop lantern at(1) off(hand)`);
  assert.deepEqual(taken.errors, []);
  const lantern = sample(taken, 2).objects.find((o) => o.name === "lantern");
  assert.ok(Math.abs(lantern.pos[0]) > 0.2); // carried at the side, not concealed
  assert.match(errorsOf(`box crate size(1 1 1)
box tag size(0.1 0.1 0.02) held-by(crate neck)`)[0], /isn't a person — anchors are anatomy/);
  assert.match(errorsOf(`person bob
box thing held-by(bob nose)`)[0], /unknown anchor "nose"/);
});

test("held things can be painted, but not moved", () => {
  const ok = compile(`box guy size(1 2 1)
box token size(0.2 0.2 0.2) color(gray) held-by(guy)
paint token to(red) start(1)`);
  assert.deepEqual(ok.errors, []);
  assert.match(errorsOf("box guy size(1 2 1)\nbox t held-by(guy)\nmove t by(1 0 0)")[0],
    /held by "guy" — move the holder/);
});

test("held-by errors: placement clash, missing/link/self/cycle holders, held targets", () => {
  assert.match(errorsOf("box a\nbox t held-by(a) at(1 0)")[0], /derives position and rotation/);
  assert.match(errorsOf("box t held-by(ghost)")[0], /no object named "ghost"/);
  assert.match(errorsOf("box a\nbox b\nlink l between(a b)\nbox t held-by(l)")[0], /links can't hold/);
  assert.match(errorsOf("box t held-by(t)")[0], /can't hold itself/);
  assert.match(errorsOf("box a held-by(b)\nbox b held-by(a)")[0], /possession can't loop/);
  assert.match(errorsOf("box a\nbox t held-by(a)\nbox c east-of(t)")[0], /rides its holder/);
  assert.match(errorsOf("box a\nbox t held-by(a)\nbox w\nwalk w to(t) over(1)")[0], /rides its holder/);
});

// ------------------------------------------------------------- take / drop

test("take teleports the thing to its holder; drop rests it where they stood", () => {
  const c = compile(`cylinder slate at(0 0) h(1.8)
box gavel size(0.3 0.1 0.2) at(5 0)
walk slate to(4 0) over(2)
take slate gavel at(3)
drop slate gavel at(6)`);
  assert.deepEqual(c.errors, []);
  const at = (t, n) => sample(c, t).objects.find((o) => o.name === n);
  assert.deepEqual(at(1, "gavel").pos, [5, 0.05, 0]); // placed, not yet taken
  assert.deepEqual(at(4, "gavel").pos, [4, 0.9, 0]); // carried (walk ended at x=4)
  assert.deepEqual(at(8, "gavel").pos, [4, 0.05, 0]); // dropped: ground-rest at slate's spot
  assert.equal(c.duration, 6); // events extend the timeline
});

test("a second take is a hand-off; the scarf passes from pine to oak", () => {
  const c = compile(`cylinder pine at(0 0) h(1.8)
cylinder oak at(3 0) h(1.8)
box scarf size(0.3 0.05 0.1) at(6 0)
take pine scarf at(1)
take oak scarf at(2)`);
  assert.deepEqual(c.errors, []);
  const at = (t) => sample(c, t).objects.find((o) => o.name === "scarf").pos[0];
  assert.equal(at(1.5), 0);
  assert.equal(at(3), 3);
  assert.deepEqual(c.facts.has, [["pine", "scarf", 1, 2], ["oak", "scarf", 2, 2]]);
});

test("drop names the holder — and errors when they don't hold it", () => {
  assert.match(errorsOf(`box a
box thing size(0.2 0.2 0.2) at(3 0)
drop a thing at(2)`)[0], /held by nobody, not "a"/);
  assert.match(errorsOf(`box a
box b at(1 0)
box thing size(0.2 0.2 0.2) at(3 0)
take a thing at(1)
drop b thing at(2)`)[0], /held by "a", not "b"/);
});

test("a born-held thing can be dropped, and a dropped chain stays together", () => {
  const c = compile(`cylinder slate at(0 0) h(1.8)
box purse size(0.3 0.3 0.1) held-by(slate)
box letter size(0.1 0.05 0.01) held-by(purse)
walk slate to(4 0) over(2)
drop slate purse at(3)`);
  assert.deepEqual(c.errors, []);
  const at = (t, n) => sample(c, t).objects.find((o) => o.name === n);
  assert.deepEqual(at(5, "purse").pos, [4, 0.15, 0]); // dropped where slate stood
  assert.deepEqual(at(5, "letter").pos.slice(0, 1), [4]); // still inside the purse
});

test("a clue may walk the token into place; the take carries it from there", () => {
  const c = compile(`room chambers size(3 2.5 3) at(6 0 0)
cylinder oak at(0 0) h(1.8)
box motive size(0.3 0.1 0.2)
walk motive to(chambers) over(0)
take oak motive at(2)`);
  assert.deepEqual(c.errors, []);
  const at = (t) => sample(c, t).objects.find((o) => o.name === "motive").pos[0];
  assert.equal(at(1), 6); // the walk placed it in the chambers
  assert.equal(at(3), 0); // the take carried it to oak
});

test("taken things can't animate themselves AFTER the take; same-instant events collide", () => {
  assert.match(errorsOf(`box a
box thing size(0.2 0.2 0.2) at(3 0)
take a thing at(1)
move thing by(1 0 0) start(2)`)[0], /position belongs to possession from there on/);
  assert.match(errorsOf(`box a
box b at(1 0)
box thing size(0.2 0.2 0.2) at(3 0)
take a thing at(1)
take b thing at(1)`)[0], /same time/);
});

test("take inside an at block inherits the block time; off() shows the carry", () => {
  const c = compile(`clock 2:00 minute(1)
cylinder slate at(0 0) h(1.8)
box lamp size(0.2 0.2 0.2) at(3 0)
at 2:05
  take slate lamp off(0 1.2 0)
end`);
  assert.deepEqual(c.errors, []);
  const lamp = (t) => sample(c, t).objects.find((o) => o.name === "lamp");
  assert.deepEqual(lamp(2).pos, [3, 0.1, 0]); // before the block: on the ground
  assert.deepEqual(lamp(8).pos, [0, 2.1, 0]); // carried high (0.9 + 1.2)
});

test("possession intervals join the temporal sweep: when in() flips at the take", () => {
  const c = compile(`clock 1:00 minute(1)
room a size(3 2 3) at(0 0 0)
room b size(3 2 3) east-of(a 4)
cylinder slate at(b) h(1.8)
box knife size(0.1 0.3 0.05) at(a)
walk slate to(a) over(2m) start(1:01)
take slate knife at(1:03)
walk slate to(b) over(2m) start(1:04)
? when in(knife b)`);
  assert.deepEqual(c.errors, []);
  const q = c.queries.find((q2) => q2.temp);
  // one range: the knife enters b mid-carry and stays to the horizon
  assert.match(q.temp.text, /→ 1:05(:\d+)?–1:06$/);
});

// ------------------------------------------------------------ carries query

test("carries: direct, chained, and honestly false", () => {
  const c = compile(`cylinder slate at(0 0) h(1.8)
cylinder taupe at(3 0) h(1.8)
box bag size(0.3 0.3 0.1) held-by(slate)
box snake size(0.4 0.1 0.1) held-by(bag)
? carries(slate bag)
? carries(slate snake)
? carries(bag snake)
? carries(taupe snake)`);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.results.map((r) => r.value), [true, true, true, false]);
});

test("check never carries: the negative possession clue gates", () => {
  const ok = compile(`cylinder taupe at(0 0) h(1.8)
cylinder mauve at(3 0) h(1.8)
box snake size(0.4 0.1 0.1) at(5 0)
take mauve snake at(1)
check never carries(taupe snake)`);
  assert.deepEqual(ok.errors, []);
  const bad = compile(`cylinder taupe at(0 0) h(1.8)
box snake size(0.4 0.1 0.1) at(5 0)
take taupe snake at(1)
check never carries(taupe snake)`);
  assert.match(bad.errors[0].msg, /never carries\(taupe, snake\) → false/);
});

test("carries composes with when and hand-offs", () => {
  const c = compile(`cylinder pine at(0 0) h(1.8)
cylinder oak at(3 0) h(1.8)
box scales size(0.3 0.1 0.2) at(5 0)
take pine scales at(1)
take oak scales at(3)
? when carries(pine scales)
? when carries(oak scales)`);
  assert.deepEqual(c.errors, []);
  const texts = c.queries.filter((q) => q.temp).map((q) => q.temp.text);
  assert.match(texts[0], /1\.00–3\.00/);
  assert.match(texts[1], /3\.00–/);
});

test("carries takes set arguments and names the carrier", () => {
  const c = compile(`cylinder pine at(0 0) h(1.8)
cylinder oak at(3 0) h(1.8)
set suspects pine oak
box snake size(0.4 0.1 0.1) at(5 0)
take oak snake at(1)
? carries(suspects snake) at(2)`);
  assert.deepEqual(c.errors, []);
  const q = c.queries.find((q2) => q2.temp);
  assert.match(q.temp.text, /true \(oak\)/);
});

// ----------------------------------------------------------------- person

test("person desugars: body + head at human proportions, standing on the ground", () => {
  const s = scene("person bob");
  assert.equal(s.bob.shape, "group");
  assert.equal(s.bob.person.h, 1.7);
  const posed = sample(compile("person bob"), 0).objects;
  const head = posed.find((o) => o.name === "bob-head");
  const body = posed.find((o) => o.name === "bob-body");
  assert.ok(Math.abs(head.pos[1] + head.r - 1.7) < 1e-9); // crown at full height
  assert.ok(Math.abs(body.pos[1] - body.h / 2) < 1e-9); // feet on the ground
  assert.equal(head.family, "bob/person"); // shared palette, no implicit set
});

test("person facts speak the name, not the parts", () => {
  const c = compile(`clock 1:00 minute(1)
room a size(3 2.5 3) at(0 0 0)
room b size(3 2.5 3) east-of(a 2)
person bob at(a)
walk bob to(b) over(2) start(1:01)`);
  assert.deepEqual(c.errors, []);
  const names = [...new Set(c.facts.whereabouts.map((w) => w.name))];
  assert.deepEqual(names, ["bob"]); // no bob-body, no bob-head
  const rooms = c.facts.whereabouts.map((w) => w.room);
  assert.ok(rooms.includes("a") && rooms.includes("b"));
});

test("person composes: walks, blocks sight, holds things at chest height", () => {
  const c = compile(`room cell size(4 2.5 4)
person guard at(cell)
box knife size(0.1 0.3 0.05) held-by(guard)
sphere eye r(0.1) at(0 1.5 8)
? sees(eye knife)
? in(knife cell)
check always carries(guard knife)`);
  assert.deepEqual(c.errors, []);
  assert.equal(c.results.find((q) => q.text.includes("sees")).value, false); // the body conceals it
  assert.equal(c.results.find((q) => q.text.includes("in(")).value, true);
  const knife = sample(c, 0).objects.find((o) => o.name === "knife");
  assert.ok(knife.pos[1] > 0.5 && knife.pos[1] < 1.2); // chest, not feet
});

test("person knobs and guards: h() scales, paint hits both parts, names collide", () => {
  const s = scene("person tall h(2)");
  assert.equal(s["tall-body"].h + 2 * s["tall-head"].r, 2);
  const painted = compile("person bob color(gray)\npaint bob to(red) start(1)");
  assert.deepEqual(painted.errors, []);
  const bodyTrack = painted.objects.find((o) => o.name === "bob-body").track;
  const headTrack = painted.objects.find((o) => o.name === "bob-head").track;
  assert.ok(bodyTrack.paint.length === 1 && headTrack.paint.length === 1);
  assert.match(errorsOf("box bob-head\nperson bob")[0], /name is taken/);
});

test("person scales inside parts", () => {
  const s = scene("part guardpost\n  person sentry\nend\nguardpost g scale(2)");
  assert.equal(s["g-sentry"].person.h, 3.4);
  assert.ok(Math.abs(s["g-sentry-body"].r - 0.15 * 1.7 * 2) < 1e-9);
});

// ----------------------------------------------------------------- touches

test("touches: face contact true, gap false, overlap true — overlaps stays strict", () => {
  const c = compile(`box a size(1 1 1) at(0 0)
box b size(1 1 1) at(1 0)
box far size(1 1 1) at(3 0)
box sunk size(1 1 1) at(0.5 0)
? touches(a b)
? touches(a far)
? touches(a sunk)
? overlaps(a b)`);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.results.map((r) => r.value), [true, false, true, false]);
});

test("touches quantifies: a blade swinging open breaks contact on the timeline", () => {
  const c = compile(`box wire_a size(1 0.1 0.1) at(0.5 0.05 0)
box blade size(1 0.1 0.1) at(1.5 0.05 0)
box wire_b size(1 0.1 0.1) at(2.5 0.05 0)
turn blade to(0 0 90) over(0.5) start(2)
? when touches(blade wire_b)
check ever touches(blade wire_b)
check never touches(blade wire_b) during(3 4)`);
  assert.deepEqual(c.errors, []);
  const q = c.queries.find((q2) => q2.temp && !q2.check);
  assert.match(q.temp.text, /0\.00–2\./); // in contact until the swing clears
});

test("touches facts export as symmetric intervals, set members only", () => {
  const c = compile(`set circuit blade wire_b
box wire_a size(1 0.1 0.1) at(0.5 0.05 0)
box blade size(1 0.1 0.1) at(1.5 0.05 0)
box wire_b size(1 0.1 0.1) at(2.5 0.05 0)
turn blade to(0 0 90) over(0.5) start(2)`);
  assert.deepEqual(c.errors, []);
  const t = c.facts.touches;
  assert.equal(t.length, 1); // only the pair in the set (wire_a is uncast)
  assert.deepEqual([t[0].a, t[0].b], ["blade", "wire_b"]);
  assert.equal(t[0].ranges[0][0], 0);
  assert.ok(t[0].ranges[0][1] >= 2 && t[0].ranges[0][1] < 2.6); // opens mid-swing
  const txt = prolog(c);
  assert.match(txt, /touches\(blade, wire_b, /);
  assert.match(txt, /touches\(wire_b, blade, /); // symmetric
});

// -------------------------------------------------------------- statements

test("statement declarations parse as data, in order, dot tolerated", () => {
  const c = compile(`person bob
person alice at(3 0)
statement bob present_at(bob, garden, 0).
statement alice \\+ present_at(bob, garden, 0)`);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.statements.map((s) => [s.speaker, s.claim]), [
    ["bob", "present_at(bob, garden, 0)"],
    ["alice", "\\+ present_at(bob, garden, 0)"],
  ]);
});

test("statement guards: unknown speaker, at-block rejection, set-block rejection", () => {
  assert.match(errorsOf("statement ghost foo(1)")[0], /no object named "ghost"/);
  assert.match(errorsOf("box b\nat 1\n  statement b foo(2)\nend")[0], /only animations, queries and checks/);
  assert.ok(errorsOf("set s\nstatement s foo(3)\nend").some((e) => /a set block encloses declarations/.test(e)));
  assert.match(errorsOf("box b\nstatement b")[0], /expected: statement <speaker> <claim>/);
});

test("statements scope to hypothesis worlds", () => {
  const src = (act) => `box b
hypothesis w1
  statement b foo(1)
end
hypothesis w2
end
active ${act}`;
  assert.equal(compile(src("w1")).statements.length, 1);
  assert.equal(compile(src("w2")).statements.length, 0);
});

// ------------------------------------------------------------------ camera

const { sampleCamera } = require("../lang.js");

test("camera: cut, dolly with ease, hold — pure projection, duration untouched", () => {
  const c = compile(`room kitchen size(4 2.5 4)
room parlor size(4 2.5 4) east-of(kitchen)
box crate size(1 1 1) at(parlor 1 1)
move crate by(0 1 0) over(2)
camera to(kitchen) over(0)
camera to(parlor) start(4) over(2)`);
  assert.deepEqual(c.errors, []);
  assert.equal(c.duration, 2); // the camera never extends the timeline
  assert.equal(sampleCamera(c, -1), null); // before the first segment: free camera
  const atCut = sampleCamera(c, 0.5);
  assert.deepEqual(atCut.pos, [0, 1.6, 0]); // eye height inside the kitchen
  const mid = sampleCamera(c, 5);
  assert.ok(Math.abs(mid.pos[0] - 2.2) < 1e-9); // halfway to the parlor (x=4.4)
  const held = sampleCamera(c, 9);
  assert.deepEqual(held.pos, [4.4, 1.6, 0]); // holds after the dolly
});

test("camera from(person): rides at eye height, faces along the walk", () => {
  const c = compile(`room hall size(6 2.5 6)
person bob at(-2 0)
walk bob to(2 0) over(4)
camera from(bob)`);
  assert.deepEqual(c.errors, []);
  const cam = sampleCamera(c, 2);
  assert.ok(Math.abs(cam.pos[0] - 0) < 1e-9); // riding bob mid-walk
  assert.ok(Math.abs(cam.pos[1] - 1.7 * 0.87) < 1e-9); // eye height
  assert.equal(cam.mount, "bob");
  assert.ok(cam.look[0] > cam.pos[0]); // facing +x, the walk direction
});

test("camera look: compass aims, names track their moving target", () => {
  const c = compile(`box ball size(0.5 0.5 0.5) at(5 0)
move ball by(0 2 0) over(2)
camera to(0 2 8) over(0) look(north)
camera look(ball) start(1)`);
  assert.deepEqual(c.errors, []);
  const north = sampleCamera(c, 0.5);
  assert.ok(north.look[2] < north.pos[2]); // aiming -z
  const track = sampleCamera(c, 2);
  assert.ok(Math.abs(track.look[0] - 5) < 1e-9 && track.look[1] > 1.5); // following the ball up
});

test("camera guards: to+from conflict, unknown refs, empty statement", () => {
  assert.match(errorsOf("box b\ncamera to(1 2 3) from(b)")[0], /a dolly or a mount/);
  assert.match(errorsOf("camera to(ghost)")[0], /no object named "ghost"/);
  assert.match(errorsOf("camera from(ghost)")[0], /no object named "ghost"/);
  assert.match(errorsOf("camera start(2)")[0], /camera needs to\(\), from\(\), or look\(\)/);
  assert.match(errorsOf("box a\nbox b at(2 0)\nlink l between(a b)\ncamera from(l)")[0], /no pose to ride/);
});

test("a mount clears the approach dolly's aim: face motion, not your own chest", () => {
  const c = compile(`person bob at(-2 0)
walk bob to(4 0) over(6)
camera to(0 1 6) over(1) look(bob)
camera from(bob) start(3)`);
  assert.deepEqual(c.errors, []);
  const cam = sampleCamera(c, 4);
  assert.equal(cam.mount, "bob");
  // aim is ahead along the walk (+x), not back at bob's own position
  assert.ok(cam.look[0] > cam.pos[0] + 5);
  // and a look declared AT the mount still wins
  const c2 = compile(`person bob at(-2 0)
box door size(1 2 0.1) at(0 1 -5)
walk bob to(4 0) over(6)
camera from(bob) look(door)`);
  const cam2 = sampleCamera(c2, 3);
  assert.ok(cam2.look[2] < cam2.pos[2]); // aimed at the door, -z
});

test("the mount is an aim horizon: the pull-back doesn't lerp from pre-mount looks", () => {
  const c = compile(`person bob at(-2 0)
box desk size(1 0.8 0.8) at(8 0)
walk bob to(4 0) over(6)
camera to(0 1 6) over(1) look(bob)
camera from(bob) start(2)
camera to(0 4 6) start(5) over(2) look(desk)`);
  assert.deepEqual(c.errors, []);
  const cam = sampleCamera(c, 5.05);
  // just after the pull-back begins: aim is AT the desk (no lerp from
  // the approach dolly's look(bob) — that history died at the mount)
  assert.ok(Math.abs(cam.look[0] - 8) < 1e-9);
});

test("door(to) an OPEN room from the walled side: carves the wall, declares adjacency", () => {
  // found working by Jeremy (2026-08-12) — pinned so it stays deliberate:
  // the open-room guard rejects doors ON the wall-less room; declared
  // from the walled neighbour, the carve is one-sided and the fact real
  const c = compile(`room kitchen size(4 2.5 4) door(to garden)
room garden size(4 2.5 4) east-of(kitchen) walls(0)
? adjacent(kitchen garden)`);
  assert.deepEqual(c.errors, []);
  assert.ok(c.objects.filter((o) => o.name.startsWith("kitchen-east-")).length >= 2); // carved
  assert.equal(c.results[0].value, true); // adjacency declared
});

test("camera chains and null before the first segment", () => {
  const c = compile(`box b
camera to(0 5 5) start(2) over(0)`);
  assert.equal(sampleCamera(c, 1), null); // free camera until the script starts
  assert.deepEqual(sampleCamera(c, 3).pos, [0, 5, 5]);
});

// ----------------------------------------------- examples are fixtures too

const examplesDir = path.join(__dirname, "..", "examples");
const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, "manifest.json"), "utf8"));

test("manifest lists every .scene file, and nothing else", () => {
  const onDisk = fs.readdirSync(examplesDir).filter((f) => f.endsWith(".scene")).sort();
  assert.deepEqual([...manifest].sort(), onDisk);
});

for (const file of manifest) {
  test(`example ${file} compiles clean`, () => {
    const out = compile(fs.readFileSync(path.join(examplesDir, file), "utf8"));
    assert.deepEqual(out.errors, []);
    assert.ok(out.objects.length > 0, "example should define objects");
    for (const r of out.results) assert.equal(r.error, false, r.text);
  });
}
