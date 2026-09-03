# Schauplatz v0

A tiny declarative language for describing 3D scenes. A program is a set of
facts about named objects, not a sequence of draw calls. The 3D view is a
projection of the program; there is no state that isn't in the text.

The language core lives in `lang.js` — pure JS, no dependencies, plain data
in/out — so it can be ported to another host language by translating one file.

## Program structure

One statement per line. `//` comments to end of line; `/* … */`
comments span lines (tutorial prose without re-prefixing every line —
line numbers in errors are preserved through them; a `/*` inside a
`//` comment is prose, and a literal `'/*'` inside a quoted atom is
not supported). `#` belongs to hex colors. Blank lines are ignored.
Statements can reference objects defined later in the file (order is not
meaningful — it's a set of facts).

**One unit is one meter.** Nothing enforces this, but every default
assumes it (people ≈ 1.7, ceilings 2.5, doorways 1 wide), and scenes that
follow it get human-plausible spaces by default.

There are three statement forms:

```
<shape> <name> <property>...                define an object
group <name> <property>...                  define a group (a named frame)
room <name> <property>...                   define a room (sugar: group + walls)
tube <name> <property>...                   define a hollow cylinder (sugar: group + ring)
person <name> <property>...                 define a person (sugar: body + head at human scale)
animal <name> <property>...                 define an animal (sugar: body, head, four legs)
link <name> between(a b) <property>...      a derived connector spanning two things
part <name> ... end                         define a part (a reusable noun)
<part> <name> <property>...                 instantiate a part
move <name> to(...)|by(...) <property>...   animate position over time
walk <name> to(...)|by(...) <property>...   animate position on the ground plane
turn <name> to(...)|by(...) <property>...   animate rotation (degrees)
orbit <name> around(...) by(deg) <property>...   animate position in a circle
take <holder> <thing> at(time) off(...)?    possession begins (an instant event)
drop <holder> <thing> at(time)              possession ends — the thing lands there
theme <name>                                whole-scene look (rendering only)
view <name>                                 projection & vantage (rendering only)
camera <property>...                        scripted camera segment (rendering only)
clock <h:mm> minute(seconds)?               wall-clock time for the timeline
set <name> <member>...                      a named collection queries quantify over
statement <speaker> <claim>                 testimony as data — the liar certificate derives
? <query>(<args>)                           ask a question about the scene
check <quantified query>                    assert it — failing is a compile error
then <gap>? ... end                         sequence block: starts when everything
                                            written before it has finished
```

## Shapes and properties

```
box    b  size(w h d)          default size(1 1 1)
sphere s  r(radius)            default r(0.5)
cylinder c  r(radius) h(height) sides(n)   default r(0.5) h(1), smooth
```

`sides(n)` (3–64) renders a cylinder as a faceted prism — `sides(6)` is a
hex nut, `sides(8)` a shaft. Facets matter for animation: a smooth spinning
cylinder is rotationally symmetric, so its rotation is invisible; a faceted
one visibly turns. Bounds are unchanged (still the full-radius cylinder box).

Common properties (all optional):

| property | meaning |
|---|---|
| `at(x y z)` | absolute position of the object's center |
| `at(x z)` | ground-plane spot: rest on the ground there at your own height (rooms and tubes keep their base on the ground) — two numbers mean the ground plane, like `walk to(x z)` |
| `at(name dx? dz?)` | standing at a named thing: its x/z (plus an optional slide), resting on the ground at your own height — `at(command_module)`, `at(desk1 1.2 0)` |
| `color(name)` or `color(#hex)` | CSS color name or hex |
| `rotate(x y z)` | rotation in degrees |
| `held-by(holder dx? dy? dz?)` | possession: pose derives from the holder, riding all movement — see Possession |
| `glass` | a flag (no parens): sight lines pass through — `sees()` is true through it — while bounds, `in()`, and `touches` stay solid. Works on shapes, rooms (all walls), and tubes; renders translucent |
| `appear(t)` | the object does not exist before t seconds |
| `vanish(t)` | the object stops existing at t seconds |

`appear`/`vanish` define a lifetime window. An absent object isn't rendered,
doesn't block sight lines, and queries about it answer "not present."
Lifetime events extend the timeline like animation segments do.

Arguments are separated by spaces or commas — `size(1 2 3)` and `size(1, 2, 3)`
are the same.

## Placement relations

Instead of `at()`, an object can be placed relative to another object. This is
the preferred way to build scenes: it reads the way you'd describe a room, and
it's what later spatial reasoning builds on. An object has at most one of
`at()` or one relation; with neither, it rests on the ground at the origin.

| relation | meaning | default gap |
|---|---|---|
| `on(target)` | resting on top of target | — |
| `above(target gap?)` | floating above target | 0.5 |
| `below(target gap?)` | below target | 0.5 |
| `west-of(target gap?)` | beside target (−x), resting on the ground | 0.25 |
| `east-of(target gap?)` | beside target (+x), resting on the ground | 0.25 |
| `south-of(target gap?)` | toward the default camera (+z), on the ground | 0.25 |
| `north-of(target gap?)` | away from the camera (−z), on the ground | 0.25 |

A relation may name **two** targets — `west-of(command_module lab_module)`
— anchoring to the union of their bounds: "left of those two" places you
beside the pair, centered on their combined span. (This is how a long
room runs along two neighbors.) A gap may follow: `west-of(a b 0.5)`.

Horizontal relations rest on the **anchor's base level** — a room
placed `south-of` a second-floor room stays on the second floor
(ground anchors: plain ground-rest, as always). With `above()` to
start a floor from its stair shaft, a whole storey lays out in compass
relations with zero coordinates.

Relations **center** on their target's cross-axis; `shift(dx dz)` slides
after placement and composes with any of them (and with `at(name)` and
`on()`): `east-of(study) shift(0 -2)` places a hallway beside the study
but extending north instead of jutting both ways.

Circular placements (`a on(b)`, `b on(a)`) are an error.

## Groups

A group is a named frame; membership is a property: `in(group)`.

```
group truck at(-7 0 2)
box body  size(1.8 0.9 1) in(truck) at(0 0.45 0)
box cab   size(0.7 0.6 0.9) in(truck) at(0.55 1.2 0)
box crate size(0.5 0.5 0.5) in(truck) on(body)

move truck by(14 0 0) over(6)     // everything rides along
turn truck to(0 90 0) over(1)     // members orbit the group origin
```

Rules:

- **Members live in group-local space.** Their `at()` and placement
  relations are relative to the group origin; `move`/`turn` on a member
  animates locally (a piston moves within its engine, wherever the engine
  is). Groups nest; transforms compose.
- **One frame per fact.** A placement relation or `to(name)` may not cross
  group boundaries — siblings only. (Groups themselves can be relation
  targets from their own frame: `on(truck)` outside the group works.)
- A group's `at()` places its *origin* (no auto ground-resting — it's a
  frame, not a body); default is `(0 0 0)`. Its bounds, when queried or
  used as a relation target, are the union of its members' bounds.
- `appear`/`vanish` on a group applies to all members.
- Groups have no `size/r/h/sides/color` — geometry belongs to members.
- In queries a group is an **endpoint but never a blocker**: `sees(x truck)`
  aims at the union-bbox center and the truck's own members don't block it,
  while other sight lines are blocked by members individually (the union
  bbox spans empty space — a fence's gap is real).

## Rooms

`room` is syntactic sugar for the group-of-wall-boxes you would build by
hand — nothing else in the language knows rooms exist:

```
room study size(6 2.5 6) at(-4 0 0) door(south 1.2) door(east)
```

This creates a group `study` containing wall boxes named `study-north`,
`study-east-1`, `study-east-2`, … — real objects with real names:
`blocked-by` reports them, `on(study-north)` works, and the room itself is
a group (query endpoint, never a blocker, relation target from outside,
moves as one).

| property | meaning | default |
|---|---|---|
| `size(w h d)` | the **interior**; walls extrude outward | `size(4 2.5 4)` |
| `walls(t)` | wall thickness; `walls(0)` = an **open room** — no walls, just a flat ground pad (a yard, a plaza); query bounds are the declared interior, so `in()` works at full height. No doors or windows *on* it (nothing to cut into) — but a walled neighbour may declare `door(to the_yard)`: its wall carves one-sided and the adjacency fact is real | `0.2` |
| `floor` | a flag: the room grows a bottom — a pad fitting the interior, in the room's color. Rooms are floorless by the dollhouse convention (look down into them); `floor` is for when the bottom is real: a boat hull, a storey slab in a multi-floor house. It blocks sight from below (`sees()` no longer passes vertically through), gives `on()` a surface, and takes room flags (`glass`) and `paint` like any wall. An open room refuses it (the ground pad already is its floor) | off |
| `door(side width? offset?)` | a gap in a wall; side is `north/south/east/west`, offset slides it along the wall | width 1, centered |
| `door(to room width?)` | a **shared** doorway: finds the facing walls, checks the rooms really touch, and carves one aligned opening into *both* rooms, centered on their shared stretch | width 1 |
| `window(side width? height? sill? offset?)` | a **y-band** opening: wall stays below (the sill) and above (the lintel); sight, air — and small things — pass through the band | 0.8 × 0.8, sill 1, centered |
| `window(to room width? height? sill?)` | a shared window/ventilator through a party wall, aligned in both rooms like `door(to)` | same |
| `color(c)` | wall color | slate |

`door(to)` is how a floor plan states its adjacency graph — each
connection declared once, from either room (declaring it from both is the
same fact twice, fine if the widths agree). Rooms that don't actually
share a wall are a compile error that reports the gap. Connected rooms
must be unrotated siblings.

Rooms don't need coordinates: placement relations between two rooms
default to **gap 0** (wall-to-wall) — "the lab is behind the command
module" means adjacent. A whole floor plan is sides and connections:

```
room command_module size(4 2.5 4) door(to lab_module 1.1)
room lab_module size(4 2.5 4) north-of(command_module)
```

The compass side is deliberately yours to state: a connection graph
doesn't determine a layout, and the language checks floor plans rather
than solving them.

…plus everything a group takes (`at`, `rotate`, `in`, `appear`/`vanish`,
placement relations). North is −z, south is +z (toward the default
camera), east +x, west −x; a door's offset runs along its wall's axis.

A door is the **absence of wall** — a wall with doors becomes separate
segments, so sight lines genuinely pass through doorways and are blocked
by the segments beside them. A window keeps wall below and above
(`<room>-<side>-sill` / `-lintel` boxes), so a ground-level sight line
is blocked while one at band height passes. **A window is not
adjacency**: `adjacent()` and the fact export count only doors — people
can't cross a window, and the whole Speckled Band turns on exactly that
distinction (see `examples/speckled-band.scene`). Window markers sit at
the band's center height (`a-b-window`, `study-north-window`) and, like
all markers, can anchor a `link` — a bell-rope can hang from a
ventilator. There is no floor and no ceiling: the ground is the floor,
and the camera looks in from above, dollhouse-style.

Every doorway also becomes a named **place**: an invisible, zero-size
marker at the opening's center on the ground — `study-south-door` for
manual doors (`-door-2`, … for more on one wall), `a-b-door` for a shared
`door(to)` (declaring room first). Markers are query endpoints and
`walk`/`to()` targets but never blockers: `walk frida to(a-b-door)` then
`walk frida to(b)` is a route with no coordinates. For cross-room
movement, keep people at the top level (same frame as the rooms) and
place them with `at(room)` / `at(room dx dz)` — the object rests on the
named thing's **base level**, so `at(upstairs_bedroom 1 0)` stands on
that floor in a stacked, multi-story house (ground rooms: identical to
plain ground-rest). Stacked floors want slab boxes between stories
(there are no built-in floors, and without a slab `sees()` passes
vertically) and stairwell rooms with `move` routes between levels —
membership via `in()` is
for things that should *ride along* when their group moves, not for
people who walk between rooms. (Doorway markers can't be `at()` targets
— they're born after placement resolves; use `at(room dx dz)`.)

Fine print: doorways are carved after placement resolves, so placement
relations may target whole walls (`on(study-north)`) but not carved
segments (`study-south-1` exists only for queries and animation). Rooms
with doors can't `repeat()` yet.

## Tubes

```
tube <name> r(bore) h(height) walls(t)? sides(n)? color()? ...
```

A **tube** is the room recipe bent into a circle: a hollow cylinder — a
well, a pipe, a chimney, a rabbit hole. It desugars into a group of thin
wall boxes standing in a faceted ring (`<name>-seg-1` … `-seg-n`), so
its hollowness is a **fact, not a look**: the segments block sight lines
individually and the bore between them is genuinely open. You can see
*down* a tube but not *through* it; something inside is `in()` it; a
sphere can `move` down the bore.

`r()` is the **bore** (inner) radius, default 0.5. `h()` is the height,
default 1. `walls(t)` is the wall thickness, extruded outward (default
0.05; `walls(0)` is an error — a tube IS its wall, unlike a room, which
degrades to an open pad). `sides(n)` sets the facet count, 3–64, default
8 — the same faceted-prism look as a cylinder's `sides()`.

Like a room — and unlike a plain shape — a tube is base-anchored: a bare
tube stands on the ground, and `at(x y z)` places its **base**, not its
center. `at(0 -4 0)` sinks a 4-high tube flush with the ground: a hole.
Everything else is group behavior: relations can target it, `rotate()`
lays it down (a tunnel), `repeat()` clones it (a colonnade), it works
inside `part` bodies (`scale()` bakes r/h/walls), `paint` recolors its
segments like a room's walls, and unset `color()` gives all segments one
shared palette slot.

Fine print: query bounds are the union of the segment boxes, so `in(x
tube)` is true anywhere in that ring-shaped box — including inside the
wall — not strictly the bore. Segments are structure: like room walls
they are excluded from the whereabouts fact export (a tube is a place
things pass through, not a thing with a location; a solid `cylinder` is
still the right shape for a hand-held pipe that rules must track).

## People

`person <name> h()? color()?` — the most common object in a mystery,
as a noun: a body cylinder with a head sphere at honest human
proportions. `person bob at(garden)` reads the way a scene is
described, and encodes the units convention (people ≈ 1.7m) without
anyone remembering the numbers:

```
person guard at(cell) color(steelblue)
person kid h(1.1) at(cell 1 1)          // h() scales the whole figure
walk guard to(gate) over(3)
take guard lantern at(2:00)
```

Sugar: a group + `<name>-body` + `<name>-head` (family `<name>/person`
— one palette slot, no implicit set). Base-anchored like a room: bare
= standing on the ground, `at()` places the feet. Everything composes
as you'd hope: people walk, turn, block sight lines (body and head
individually — the sergeant still fills the doorway), hold things
(concealed at chest height), get painted, repeat, and scale inside
parts. **Facts speak the person's name**, not their parts: whereabouts
export `bob`, never `bob-head`, and person groups join the sight-fact
cast (their union center is a chest-height endpoint).

A plain `cylinder` is still fine for a person — `person` is the same
facts with a face on them.

`animal <name> h()? color()?` is the quadruped sibling: a horizontal
body, a head at the front (−z), four legs. `h()` is **shoulder
height** — `h(0.15)` is a rat, `h(0.5)` a fox, `h(0.7)` a goat.
Same contract as person: facts speak the animal's name, parts block
sight individually, paint hits all parts, scaling works in parts.

**Persons and animals can be carried.** Unlike plain groups, they may
be held (`held-by`) and taken (`take dude goat at(1)`) — the whole
figure rides, members and all, and a `drop` sets it down *on its
feet* at the holder's spot (base-anchored things land on their base).
Wear anchors work as carry points: `take dude goat at(1) off(back)`.
This is also how a body gets moved: `person victim held-by(killer)`.

## Possession

`held-by(<holder> dx? dy? dz?)` declares that a thing is carried (or
contained): its position and rotation derive from the holder for its
whole life. One fact, and every movement composes — walk the person,
the pocket contents go too:

```
cylinder slate at(2 0) h(1.8)
box ticket size(0.2 0.1 0.01) held-by(slate)
walk slate to(6 0) over(2)          // the ticket rides along
```

The default offset is `(0 0 0)`: the held thing sits at the holder's
center — **concealed on the person**, which is what possession usually
means in a mystery. The concealment is honest geometry, not a special
rule: `sees(witness ticket)` is false because the holder's own body
blocks the sight line, while `in(ticket room)` stays true because the
ticket really is in the room. Give an offset to show the thing
(`held-by(slate 0.4 0 0)` — a lantern in hand); the offset rotates with
the holder like a pocket. In the playground, hovering an object lists
what it holds.

A `person` holder also takes a named **wear anchor** instead of
numbers — `head`, `neck`, `chest`, `back`, `hand` — computed from
their proportions (a scaled person wears things at scaled heights),
riding rotation like any offset. `held-by(bob neck)` is a worn scarf:
visible, and honestly *seeable* — `sees(witness scarf)` can be true,
where the pocketed version is concealed by the body. Worn vs pocketed
is a real evidentiary distinction, and it's just geometry. `take`
accepts anchors too: `take cop lantern at(2:00) off(hand)`. The
person's front is north (−z) until rotated; anchors on non-person
holders are an error (anatomy — give numbers instead).

Holders can be anything placed (a person, a box, a group, a room —
"the safe holds the will"). Held things are plain shapes — or persons
and animals, which ride whole (see People) — and they chain: `purse held-by(slate)`, `letter held-by(purse)` — the letter
crosses town in the purse in the hand. Cycles are a compile error.

A held thing cannot be independently placed or animated — `at()`,
relations, `in()`, `rotate()`, `move`/`walk`/`turn`/`orbit` on it are
errors (move the holder). `paint` still works (color isn't pose), and
`appear`/`vanish` still work (a possession can be revealed
mid-timeline); a held thing is absent whenever its holder is. Held
things can't anchor others: they are not valid targets for relations,
`at(name)`, `to(name)`, or `around(name)` — name the holder instead.

### take / drop — possession changing hands

```
take <holder> <thing> at(<time>)? off(dx dy dz)?
drop <holder> <thing> at(<time>)?
```

Instant events, like `appear`/`vanish` — not segments (a hand closing
isn't a smear). The time is optional: a bare `take`/`drop` **chains**
like an animation segment — it fires when both parties have finished
everything written for them so far. The boarding idiom needs no
bookkeeping:

```
walk dude to(boat 0.6 0)
take boat dude off(0.5 0.5 0)      // fires when the walk lands
walk boat to(north_bank 0 2) start(5)
drop boat dude                     // fires when the boat arrives
```

Written order is the chain, exactly as with `move` segments. With
nothing written for either party, the event fires at their birth
(`appear`). Inside an `at <time> … end` block the block instant is
the event's FLOOR: the event fires then, lifted later only if the
thing itself is still finishing its own walk — so walk-and-board
works inside a block too. Only the thing lifts the instant, never the
holder: taking from (or dropping off) a holder that is mid-walk keeps
the declared time — leaping aboard a moving train and mid-flight
drops mean exactly what the block says. A thing placed normally sits where it was put until its
first `take`; while held it rides the holder exactly as `held-by`
things do; `drop` rests it on the ground at the holder's spot at that
instant, where it stays. A second `take` is a hand-off (the scarf
passes from Pine to Oak — no intervening drop needed). A born-held
thing (`held-by`) can be dropped and re-taken; `take` works inside
hypothesis blocks — which is the point: the base scene declares
everyone and everything once, and a theory is one line:

```
hypothesis oak_did_it
  take ex_chancellor_oak gavel at(found)
end
```

`take` **teleports** — no proximity required. This is the leap's
logic: "she had it by 2:15" is testimony-shaped, honest about the
unmodeled pickup; walk the holder to the thing first when you know the
route. `drop` deliberately names the holder: `drop slate gavel` is a
compile error if Slate doesn't hold it at that time — a free
consistency check on your transcription.

A thing named in `take`/`drop` owns its position channel only **until
its first event**: a clue may walk the token into a room (that's its
placement — the leap idiom), and a later `take` carries it from
wherever it ended up. Movement scheduled *after* the first take/drop
is an error — from there on the position belongs to possession
(carried → dropped). Two possession events for one thing at the same
instant are an error.

Possession is a fact, and it exports as intervals:
`has(holder, thing, t0, t1).` — who held what, when. rules.pl offers
`has(A, B)` (ever held), `has_at(A, B, T)` (held at a moment — "who
had the knife at time_of_death" is one goal), `carries`/`carries_at`
(transitive: a clue like "whoever has the bag of cash knew they could
get away" is `knew_get_away held-by(bag_cash)` — weld the label to the
bag, and `carries_at(X, knew_get_away, T)` names whoever took the bag;
the clue becomes true by construction), and
`pair_up_scene(SetA, SetB, Cs, Pairs)`, which seeds the pairing search
from declared possessions so goals carry only the still-open clues.
Whereabouts intervals of held things follow their holder through every
room ("the money was wherever Cooper was").

## Repeat

`repeat(n)` stamps an object — or a whole group, or a room — into `n`
copies named `name-1` … `name-n`, and removes the original:

```
cylinder coin r(0.08) h(0.02) on(desk) color(gold) repeat(9) spread(0.09 0 0) jitter(0.02 0 0.15 5) stagger(0.3)
move coin by(0.9 0 0) over(0.6)      // animates every coin, staggered
```

| property | meaning | default |
|---|---|---|
| `repeat(n)` | number of copies, 2–200 | — |
| `spread(dx dy dz)` | per-copy offset: copy i sits (i−1)·spread from the first | `0 0 0` |
| `jitter(x y z seed?)` | per-copy random offset in ±x/±y/±z, **seeded** — the same scene scatters the same way on every run and every host (PRNG: mulberry32) | off, seed 1 |
| `stagger(s)` | each copy's *animation clock* runs s seconds behind the previous (existence is not staggered — no pop-in) | `0` |

Spread and jitter compose with placement: `on(desk) repeat(5) spread(…)`
puts five things on the desk, offset from where one would have sat.
Repeating a group stamps the whole assembly — members and their internal
relations come along, remapped per copy (`roof-2` sits `on(base-2)`).

Animations written against the original name fan out to every copy.
Everything else naming a repeated object from outside — relations,
queries, `to()`/`around()` — is ambiguous and errors, suggesting a copy
name (`coin-1`). Copies inherit the template's color; uncolored copies
share one palette color rather than cycling.

## Links

A link is a **derived** object — the first of its kind: a rigid straight
cylinder spanning two named things, its pose recomputed from their live
world positions at every instant:

```
link rod between(pin tooth-e) r(0.07) color(#8a93a5)
```

- Endpoints are positions (origins), which for group endpoints means the
  frame's pivot — usually exactly what a mechanism wants.
- Links **track**: as the endpoints animate, the link follows. (This is
  not a change to `to(name)`'s no-pursuit rule — a link is a maintained
  *relation*, not a motion.)
- Links may **cross frames**: they derive from world poses, so a rod from
  a spinning group's member to an outside anchor is legal and correct.
- A link is physical: it blocks sight lines and answers queries (its
  bounds are the box around its live endpoints, conservative when
  diagonal). It exists only while both endpoints do.
- A link takes `between(a b)`, `r()`, `sides()`, `color()`,
  `appear`/`vanish` — nothing else. It can't be animated, placed,
  repeated, targeted by relations/`to()`, or be another link's endpoint.
  Links are straight and rigid, permanently: no springs, chains, or
  joints.

## Parts

A part teaches the language a new noun. Between `part <name>` and `end`,
ordinary statements describe what the thing *consists of*; the part is
then used exactly like a shape. Definitions may appear anywhere in the
file (order is not meaningful):

```
part chair
  box seat size(0.45 0.06 0.45) at(0 0.45 0)
  box back size(0.45 0.55 0.06) at(0 0.76 -0.2)
end

chair c1 in(study) at(2 0 1)
chair c2 on(stage) scale(1.3) color(#8b5e3c) rotate(0 180 0)
```

An instance is a group: its members get prefixed names (`c1-seat`), and
everything groups can do — relations, `in()` nesting, `repeat`,
`appear`/`vanish`, animation targeting the instance — works on instances.

- **No parameters, no arithmetic, no conditionals.** A part is a fixed
  arrangement of facts. The one knob is `scale(s)`: a uniform multiplier
  baked at expansion (sizes, positions, gaps, and movement distances all
  scale; angles and time don't).
- **Parts may contain animation** — "a fan spins" is a fact — and every
  instance runs its own copy.
- **Bodies are self-contained**: statements inside a part may only name
  things defined in that part. Parts can't (yet) use other parts, and
  queries/`theme` don't belong inside one.
- Instance `color()` fills in members that don't set their own.

## Animation

`move` animates an object's position, `turn` its rotation. Both take:

| property | meaning | default |
|---|---|---|
| `to(x y z)`, `to(name)`, or `to(name dx dy dz)` | absolute destination — coordinates, another object's *placed* position, or that position slid by an offset | one of `to`/`by` required |
| `by(dx dy dz)` | relative destination: displacement from where this segment starts | — |
| `from(x y z)` | starting value | where the previous segment left it |
| `start(t)` | absolute start time in seconds | when the previous segment ended |
| `after(s)` | wait s seconds after the previous segment ends (XOR with `start`) | 0 |
| `over(seconds)` | duration; `over(0)` is a **leap** — there at that instant, no path travelled | 1 |
| `ease(kind)` | `linear`, `in`, `out`, `in-out`, `bounce` | `linear` |

Position (`move`) and rotation (`turn`) are independent channels. Within a
channel, statements **chain**: each segment starts when and where the
previous one for the same object ended, so a path is just consecutive
`move` lines. An object's clock starts when it exists — the first segment
chains from `appear()`, so a coin with `appear(3)` starts moving at t=3.
(An explicit `start()` overrides this and can even animate an absent
object, e.g. to pre-position it.) An explicit `start()` leaves a gap during which the value
holds. The scene's timeline runs to the last segment's end; the playground
shows a play/pause + scrubber bar whenever there is one.

```
box truck size(1.8 0.9 1) at(-7 0.45 2)
move truck to(0 0.45 2) over(3)
move truck to(0 0.45 8) over(3)      // starts at t=3, from where leg 1 ended
turn truck to(0 -90 0) start(2.6) over(0.8)
```

`to(name)` targets the named object's placed (t=0) position — not its
animated position; there is no pursuit. `to(name dx dy dz)` slides that
destination by an offset, the moving mirror of `at(name dx dz)` — two
people can head for the same room without converging on one point
(`walk butler to(window)` vs `walk butler to(parlor 2.5 -1)`). `turn`
accepts only numeric `to`/`by` (degrees). `by()` composes with `from()`:
the displacement is applied from wherever the segment starts.

### walk

`walk` is `move` on the ground plane: `to(x z)`, `to(name)`,
`to(name dx dz)`, or `by(dx dz)` — two numbers, and the walker's
**height stays its own**. `walk frida to(study-south-door)` sends her
to the doorway without sinking her to the marker's floor-level y;
`walk frida to(study 1.5 0)` puts her a step and a half east of the
study's center. Walk shares the position channel with `move`/`orbit`
and chains with them.

A walk is a straight line — there is no pathfinding, and a long walk
can cut through rooms and walls in between, which spatial queries will
faithfully (and misleadingly) report as presence. Two honest idioms:

- **Known route** — chain walks through the doorway markers; the path
  is then a fact you stated, room by room.
- **Testimony placement** — `walk carol to(monkey_island 1 0)
  start(2:15) over(0)`: a **leap**. She is there at 2:15 and no path is
  invented; use it when a witness places someone somewhere and how they
  got there is exactly what you don't know.

### paint

`paint` is the appearance channel: it changes an object's **color** over
time, the way `move` changes its position.

```
paint red_lamp to(#3f3f42) start(4)          // snaps: over defaults to 0
paint sky to(#2b3350) start(2) over(9)       // fades: over() lerps
paint pistol to(#333) start(1:30)            // wall times work as everywhere
```

`to(color)` takes one color name or #hex — the same tokens `color()`
takes. Paint segments chain on their own channel (independent of
move/turn), take `start/after/over/ease`, and the first segment chains
from `appear()`. There is no `by()` (colors don't add) and no `from()`
(a paint chains from the previous color; before the first paint, the
object wears its declared `color()`, or the palette pick if none).
Links may be painted, and so may **rooms** — painting a room paints its
walls, the same surfaces its `color()` owns (door segments, sills and
lintels included). Plain groups and doorway markers may not (no
surface).

Color has **zero semantic weight**: no query reads it, no bound depends
on it. It exists for the humans watching — dim the ruled-out weapons at
the wall time each clue eliminates them, and the timeline becomes a
film of the investigation narrowing. Deliberate boundary: color is the
only paintable property. Size or shape changes would alter query
answers mid-timeline and are not planned.

### time

`time <name> <h:mm|seconds>` names a **time fact** — a single point in
time, usable wherever one goes (`start`, `appear`, `vanish`, `at()`,
`during()`):

```
time time_of_death 3:00
turn alice to(90 0 0) start(time_of_death) over(1m) ease(in)
check in(people lion_enclosure) at(time_of_death)
```

Refine the fact in one place and every statement that cites it follows.
Names bind literals only — no arithmetic, no chains of names, and a
named time is **not a duration**: `over(time_of_death)` is an error.
Statement order is free (the clock may come later); h:mm forms need a
clock, plain seconds don't. A time name may not collide with an object
or set name.

### at blocks

`at <time> … end` groups statements under one instant, and
`at <t0> .. <t1> … end` under one window — **moment facts and duration
facts**. The block's time fills in wherever a statement didn't state
its own:

```
at 2:15
  check in(people monkey_island) except(carol)   // gets at(2:15)
  check never in(alice aviary)                   // gets at(2:15)
  walk eddie to(unknown)                         // gets start(2:15)
end

at 3:00 .. 3:15
  walk bob to(cave 1 0) over(0)      // anims anchor at the window START
  check in(bob cave)                 // bare boolean = a duration fact:
end                                  //   check always in(bob cave) during(3:00 3:15)
walk bob to(unknown) start(3:15) over(0)   // and back to unaccounted
```

In a range block, a bare boolean check/query defaults to `always` — a
duration fact is a "held throughout" fact — while an explicit
quantifier keeps itself and gets the window as its `during()`.
Non-boolean queries (`distance`) need their own `at()` inside a range.

The rules: **explicit wins** (a statement carrying `start()`, `after()`,
`at()` or `during()` keeps it); a quantifier is already a time scope, so
`ever/always/when` queries keep their whole timeline (`never` combines,
as instant negation); `adjacent` ignores the block (floor plans have no
time). Only animations, queries and checks belong inside — objects are
declared outside (a time block scopes *events*, not existence). Blocks
don't nest. This is pure desugaring: afterwards every statement stands
alone, and statement order still means nothing — inside the block or
between blocks. Block times take h:mm, seconds, or a time name
(`at time_of_death`).

### then blocks — sequence without arithmetic

```
then
walk goose to(boat)
take boat goose off(-0.4 0.9 0)
end

then 2
walk boat to(north_bank 0 1.5)
end

then
drop boat goose
check in(goose north_bank)
end
```

`then <gap>? … end` is the at-block with a **computed** time: it
anchors its contents at the *frontier* — the moment everything written
before it has finished (every segment end and possession event so
far; declarations don't count, they're order-free facts, not beats).
The optional gap adds pacing (`then 2` = frontier + 2; `2m` works
with a clock). Use `at` when a clue names a time; use `then` when the
story only knows order — construction puzzles (a river crossing, a
Hanoi solution, a heist plan) are made of "then".

Everything else matches at-blocks: explicit `start()`/`at()` always
wins; a bare check asserts *at that point in the story*; bare
takes/drops chain within the beat; quantified queries keep their own
timeline; no nesting. One refinement over at-blocks: within a beat,
an object's *first* bare segment takes the anchor and its later ones
chain — so a three-segment move is one beat, not three overlapping
starts. Reordering `then` blocks reorders the story; that is the
point, and it stays inside the language's one ordered corner
(animation has chained in written order since v0.1). The frontier is
computed once at compile into ordinary constants — `poseAt` stays
closed-form, and the scrubber still runs backwards.

### hypotheses

`hypothesis <name> … end` blocks hold **alternate theories** of one
scene; `active <name> <name>...` selects one or more, and the union of
the selected blocks compiles. The base text is the shared world;
statements outside the blocks — especially checks — are the evidence
*every* theory must survive. One compile is still one determinate
world: this is conditional compilation, not modality; the multiverse
lives across compiles.

```
hypothesis fbi_zone
  time jump 8:13
end
hypothesis over_the_columbia
  time jump 8:20
  box raft size(1 0.3 0.5) at(river_bank 1 0)   // exists only in THIS world
end
active fbi_zone

walk cooper to(unknown) start(jump) over(0)      // base text uses the knob
check in(cooper cabin) at(8:05)                  // evidence: outside, shared
```

A hypothesis may declare objects (they exist only when it's active —
don't reference them from base text, or the other worlds break), set
time facts (the classic knob), and contain any ordinary statements
including at-blocks. Blocks don't nest, `part` definitions stay at the
top level, and `active` is always explicit — declared hypotheses with
no `active` is an error that lists your options. To compare theories,
swap `active` and recompile: which checks die *is* the analysis.

Selecting **several** blocks turns hypotheses into composable
*branch-facts*. The natural factoring for liar puzzles: one block per
statement-branch (`slate_true`, `slate_false`, each carrying that
branch's geometric consequences), and a full theory is a selection —
`active slate_true pine_false oak_true`. n pairs of blocks instead of
2ⁿ theories, no duplicated facts. The language does **no**
contradiction checking between selected blocks (deliberate):
composing a consistent world is the author's job, and the usual police
apply — duplicate names collide, impossible worlds fail their checks.

### clock

`clock 4:45 minute(0.5)` declares that the timeline starts at 4:45 and
each story-minute lasts 0.5 seconds (`minute` defaults to 1). With a
clock, wall times work anywhere an absolute time goes — `start(5:15)`,
`appear(4:45)`, `vanish(5:30)` — and durations take an `m` suffix:
`over(2m)`, `after(30m)`. One clock per scene; the playground transport
and temporal query answers (`when sees … → 4:57–5:41`) speak wall time
too. Purely notation: nothing about the scene's behavior changes.

### orbit

`orbit` moves an object in a circle around a point or another object:

```
orbit moon around(planet) by(360) over(6)
```

| property | meaning | default |
|---|---|---|
| `around(x y z)` or `around(name)` | center of the circle — coordinates, or another object's *placed* position (same rule as `to(name)`) | required |
| `by(degrees)` | arc to sweep; positive turns the same direction as `turn` does around the same axis, negative reverses | required |
| `axis(x\|y\|z)` | the axis of the circle, through the center | `y` |

`orbit` shares `from/start/after/over/ease` with `move` and lives on the
**same position channel**: orbit and move segments chain with each other,
so "fly to the ring, then circle it" is two consecutive lines. The radius
is wherever the segment starts relative to the center — orbit never
teleports. Distance along the axis is preserved (a `y` orbit keeps its
height). Starting on the axis itself is an error — there is no circle to
travel. `orbit` moves without rotating the object; add a `turn` if it
should also spin.

Queries evaluate **at the current time** — `? sees(a b)` can flip as things
move, and the playground updates answers and sight lines live.

Note: placement relations are resolved once, at t=0, in the object's own
frame. To make things ride along, put them in a group — a crate
`in(truck) on(body)` moves with the truck.

## Themes

A theme names a whole-scene look. It is part of the text (a figure's look
must reproduce from the `.scene` file alone), but it has **zero semantic
effect**: bounds, sight lines, and queries are unchanged. The core just
validates the name and passes it through; renderers decide what each theme
looks like.

```
theme ink
```

| theme | look |
|---|---|
| `ink` | white page, flat shading, black outlines — technical illustration; survives grayscale printing |
| `clay` | matte pastels, warm background, soft shadows — friendly explainer look |
| `blueprint` | blue paper, translucent x-ray fills, white line work — drafting table |
| `noir` | near-black room, one hard raking light, long shadows — for the mysteries |
| `paper` | warm cream paper, navy-ink outlines and shadows, riso-print palette — vintage journal |
| `rts` | dark terrain, player-color palette, selection rings under every object — game map |
| `snow` | white snowfield, overcast winter light, blue-grey shadows, woolen palette — the Orient Express look |
| `asphalt` | hazy daylight over a lit asphalt lot, crisp shadows, signal-paint palette — bus stops, airports, street scenes |
| `meadow` | summer daylight on a lit grass field, warm sun, nature palette — riverbanks, gardens, outdoor scenes |
| `night` | moonlit woods: deep blue sky, cool pale moon as the key light, a low warm lantern-amber rim, lit dark forest floor — cabins, campsites, anything after dark. Day-for-night bright: readable, not murky |

**Custom themes** live in `themes.json` beside the playground — pure
data, no code. Each entry is usable as `theme <name>`; missing fields
inherit from the default theme; entries may override built-ins. Colors
are `"#hex"` strings; `material.kind` is `standard|toon|lambert|basic`
(standard takes `roughness`/`metalness`; any kind takes
`transparent`/`opacity`/`depthWrite`); optional extras: `ground` (an
opaque lit floor), `rim` light, `shadowColor`, `outline`+`outlineColor`,
`edges`, `ring`. A theme is a JSON object — share it by sharing the
object. See the bundled `synthwave` for a worked example. Because the
theme list now lives with the renderer, the core accepts *any* theme
name; the playground warns (amber) when a name matches nothing loaded.

At most one `theme` statement per scene; omitted means the renderer's
default look. Themes bundle background, ground, lighting, materials, and
the fallback palette for uncolored objects — explicit `color()` always
wins, the theme only decides how that color is shaded. There is
deliberately no per-object styling beyond `color()`.

## Views

`view` asks for a projection and starting vantage — like `theme`, it is
part of the text (a figure's viewpoint must reproduce from the file) and
has **zero semantic effect**:

```
view iso    orthographic, classic RTS angle (45°, ~35° elevation)
view top    orthographic, straight down — a floor plan, north up
```

Omitted means the free perspective camera. The playground still orbits
in any view; the statement sets where you start and how parallel lines
behave, not a cage. One `view` per scene.

## Camera

`camera` statements script the shot — a projection channel speaking
the animation grammar. Like `theme` and `view`, **zero semantic
effect**: the camera has no bounds, blocks no sight line, appears in
no fact, and never extends the timeline. It changes what you see,
never what is true.

```
camera to(4 6 8) over(0) look(study)               // a CUT: over(0)
camera to(hall 0 0.4 1) start(0.8) over(1) look(holmes)   // a dolly
camera from(holmes) start(3:01)                    // first person
camera to(study -1 1.6 2) start(3:03) over(2) look(desk)
```

Segments chain in written order like `move` segments (`start`/`after`/
`over`/`ease`; inside an `at` block they inherit the block time).
`to(x y z)`, `to(name)`, or `to(name dx dy dz)` dollies the camera —
a room resolves to eye height (1.6) at its center, anything else to
its bounds center. `from(name)` **mounts** the camera on an object:
first person, riding at eye height (a `person`'s eyes, an object's
center), facing along its motion, until the next position segment
takes over — the mounted object is hidden so you look through it, not
at the inside of its head. `look()` aims: a point, a compass word
(`north`/`south`/`east`/`west`), or a name — and a name **tracks its
target live**. (The `to(name)`-no-pursuit rule is about world facts;
aiming is projection, so a camera may follow.) Unaimed mounts face
their carrier's motion — a mount *clears* any aim declared before it
(the approach dolly's `look(holmes)` must not leave the mounted camera
staring down its own body); a look declared at or after the mount
wins. Everything else holds the last aim, or the scene origin.

Before the first segment starts, the free camera applies. In the
playground, grabbing the viewport takes the wheel back (orbiting
resumes); recompiling returns it to the script. A dolly takes the
straight line — through walls if they're in the way; film cuts
(`over(0)`) are the idiom for room-to-room jumps. First-person note:
what a mounted camera shows is the `sees()` predicate, rendered — you
are standing inside the fact.

Queries are statements that return answers instead of creating objects.
Answers appear in the output panel under the editor.

```
? overlaps(a b)     do the two objects' bounds intersect? (touching ≠ overlapping)
? distance(a b)     center-to-center distance
? sees(a b)         is the straight line between a's and b's centers clear
                    of every other object? false lists what's in the way
? blocked-by(a b)   the objects blocking that line, nearest first
                    ("nothing" if the line is clear)
? in(a b)           is a's center strictly inside b's bounds? the room-
                    presence question: ? in(carol lab_module)
? carries(a b)      does a hold b right now — directly or through a
                    chain (the snake in the bag in the hand)? reads the
                    possession timeline, not geometry
? touches(a b)      are the two in physical contact — face to face or
                    overlapping? the complement of overlaps' strictness
                    (overlaps excludes touching; touches includes
                    overlapping); a visible gap is false
? on(a b)           does a REST directly on b — footprints sharing
                    interior, a's underside meeting b's top? resting,
                    not hovering: an object passing OVER another
                    mid-move is false. The query form of the on()
                    placement: the language could say it, now it can
                    ask it
? adjacent(a b)     do the two ROOMS share a declared door? read off the
                    door(to) graph — a static fact about the floor plan
```

`carries` is the possession clue's check form: "Taupe was chased by
the person with the snake" means Taupe never had it —
`check never carries(taupe snake)` gates it (red the moment any take
says otherwise). Set arguments work and name the carrier
(`? carries(suspects snake) → true (oak)`), and `when carries(pine
scales)` is the chain of custody as ranges.

`on` is the stacking rule's check form — Towers of Hanoi's "never a
larger disk on a smaller" is `check never on(disk_3 disk_1)`, and it
survives transit: a big disk sliding over a small one on its way to
another peg doesn't trigger (no contact — the rule is about resting,
which is why the query is `on`, not `above`). Contact tolerance is a
hair (1e-4), so stack with `on()` placement or exact heights; a
hand-sunk object doesn't count as resting.

`adjacent` is the odd one out: it never changes, so it takes no
quantifier, `at()` or `during()` — but `check adjacent(a b)` works bare,
and a failing one is a compile error like any other check. Direct
adjacency only (two doors apart is false — a transitive `connected()`
would be a different, later fact), and only `door(to)` connections
count: a manual one-sided `door(south)` doesn't say who is on the other
side. Its detective use is validating earwitness testimony: "Carol
heard footsteps in the lion enclosure from the aviary" asserts both
`in(people lion_enclosure)` at that time and
`adjacent(aviary lion_enclosure)` — geometry the scene can vouch for.

`sees` and `blocked-by` also draw their sight line in the viewport: green
where clear, red from the first blocker onward. Lines are center-to-center
in v0 — an object is not "seen" around its edges. Grazing a surface exactly
does not block, consistent with `overlaps`. `glass` objects never block:
a display case shows its contents to every witness, honestly —
`sees(guard gem)` true, `in(gem case)` also true. Seen is not touched.

### Temporal queries

Prefixing a true/false query (`sees`, `overlaps`, `in`) with a quantifier
asks about the **whole timeline** instead of the current instant:

```
? ever sees(frida dave)      was it true at any time?  (+ when it first was)
? always sees(carol dave)    was it true the whole time?  (+ the failing ranges)
? never in(dave lab_module)  was it false the whole time?  (+ the violating ranges)
? when in(carol lab_module)  the time ranges where it was true
```

Two scoping properties: `at(time)` pins **any** query to one instant
(`? distance(a b) at(2:30)`), and `during(t1 t2)` limits a quantifier's
window (`? never in(dave hq) during(2:00 2:15)`). With a clock, times and
answers speak wall clock. Quantifiers and `at()` don't combine — except
`never`, which asserts the *opposite* at that instant:
`check never in(bob garden_module) at(2:45)` is "Bob was not there at
2:45."

Quantified answers are facts about the timeline — they don't change as
you scrub (though `when sees` still draws the live sight line for the
current instant). Moments where either object doesn't exist count as
false: you can't see what isn't there. `when` answers `never`, `always`,
or a list of ranges.

### Sets

`set` names a collection — a mystery's cast, a machine's fasteners:

```
set suspects alice bob carol eddie
```

A set is **not** a group: no frame, no geometry, pure membership. The
**block form** declares and enrolls in one motion — membership is
single-sourced in where the declaration lives, so adding, removing or
renaming a member is one edit with no name list to drift out of sync:

```
set weapons
  box coffee_thermos size(0.3 0.1 0.2) at(unknown .5 -1.8)
  box cookie size(0.3 0.1 0.2) at(unknown 0 -1.8)
end
```

Only declarations belong inside (objects, rooms, groups, links —
animations and queries are errors there); blocks don't nest; `repeat()`
inside is refused (the copies already form a set — the family). The
inline form remains for enrolling already-declared names; a given set
is declared once, either way.

A set's name can stand in one argument of a true/false query, meaning
"some member" — and the temporal quantifiers do the rest:

```
? in(suspects lab_module)                       is SOMEONE there? (names every member who is)
check never in(suspects command_module) at(1:15)   "it was empty"
check ever in(suspects command_module)             "someone was there at some point"
check always in(suspects command_module)           "it was never unattended"
```

A window-quantified set query answers **per member** — who, not just
whether. `when` breaks out every member's presence; `ever`'s true and
`never`'s false name the members responsible, with their times. This is
the **alibi query**: given a time of death, everyone the answer doesn't
name is cleared —

```
? never in(suspects lion_enclosure) during(2:00 2:45)
   → false (dave 2:12–2:20)                        everyone but dave is alibied
? when in(suspects lion_enclosure) during(2:00 2:45)
   → alice never; dave 2:12–2:20; eddie never      full whereabouts breakdown
```

(`always` stays a pooled answer — "never unoccupied" is a fact about
the place, not about any one member.)

`except(names)` leaves members out, which is how "alone" is written:

```
check always in(carol garden_module) during(2:45 3:30)
check always in(eddie garden_module) during(2:45 3:30)
check never in(suspects garden_module) except(carol eddie) during(2:45 3:30)
```

**Repeat families are sets automatically**: after `box bolt … repeat(8)`,
the name `bolt` in a query means "any bolt" — `check never in(bolt
cabin)` is the stray-fastener debug in one line. (Placement and
animation still need one specific copy.)

One set per query; sets work with the true/false queries (`in`, `sees`,
`overlaps`) only; a set can't be placed, animated, or nested in another
set. Unknown members — in the set or in `except()` — are compile errors.

### Checks

`check` asserts a quantified (or `at(time)`-pinned) true/false query.
Passing checks answer `✓`; a failing check answers `✗` **with the
violating times** and is a compile error — the scene doesn't pass until
its testimony holds:

```
check never in(dave command_module) during(2:00 2:15)   // "it was empty when I left"
check in(carol lab_module) at(2:30)                     // "I was in the lab at 2:30"
check always sees(frida carol) during(3:30 4:00)
```

"A and B were alone in room R" is a check pattern: `always in(A R)` +
`always in(B R)` + `never in(X R)` for each other X, over the window.

How it's computed: the scene is sampled at every animation-segment
boundary and lifetime event plus a dense 256-step sweep, and each truth
flip is refined by bisection — range edges are accurate far beyond the
sweep spacing. A predicate true only inside a single sweep step could
still be missed; these are sampled facts, not symbolic proofs.

## Fact export

Every compiled scene also derives itself into **ground facts** — the
substrate for the inference era (v3): a rules layer, a logic engine, or
an LLM can consume the world without re-deriving geometry. The
playground's **facts** button shows them as Prolog text (copy-paste
ready); programmatically they're `compiled.facts` (structured) and
`Schauplatz.prolog(compiled)` (text):

```prolog
% ground facts derived from the scene — times in timeline seconds
clock(285, 0.5).
room(command_center).
adjacent(barracks, command_center).      % both directions emitted
set_member(suspects, eddie).
time_fact(time_of_death, 60).
lifetime(carol, 2.5, inf).
in(frida, command_center, 0, 6).         % whereabouts intervals
in(frida, radio_room, 6.09, 27).
```

What's exported: rooms, the `door(to)` adjacency graph, sets, named
times, lifetimes, per-object room-presence intervals (for every
non-structural object — people and props alike, so "was the killer
ever in the room with the screwdriver" is answerable rule-side), and
**sight intervals** — `visible(a, b, t0, t1)`, `sees()` published as
data, exported for **set members only** (the cast you've named is the
cast rules reason about; all-pairs would be quadratic). With them,
"is every crate on camera" is one rule-side double negation — see
`all_visible`/`unseen` in rules.pl and `examples/storeroom.scene`.
**Contact intervals** — `touches(a, b, t0, t1)`, set members only,
symmetric, same sweep: face-to-face or overlapping counts, a gap does
not. rules.pl derives `touches_at/3` and `reaches/3` — reachability
through contact at a named time, loop-safe — which turns a circuit's
conductivity, a domino run, or a train coupling into one recursive
rule (`examples/prolog-4-circuits.scene`).
Also **order facts** — `left_of(a, b)` for set members (rooms
included), sampled where things **end up**, so a deduction-time
timeline exports its solved arrangement. rules.pl derives
`immediately_left_of`, `next_to`, and `at_end` within a peer set, and
`exactly_one` certifies one-member-per-room and names it — the zebra
puzzle certificate (`examples/zebra.scene`).
Intervals are grid-resolution (segment boundaries + the sweep), same
honesty clause as temporal queries: sampled facts, not symbolic
proofs. The language itself contains no detective concepts — rules
like *murderer* or *alibi* belong to whatever consumes the facts.

## Goals — asking the rules layer

`?- goal(Args)` hands a question to the **rules layer**: the playground
consults Tau Prolog with the scene's fact export plus `rules.pl`, and
the answers appear under the query results (purple — derived, not
stated). The goal's vocabulary belongs to the rules file, not to the
language; the core just carries it. Goals may span lines — a `?-` line
continues while its parens are unbalanced or it ends mid-conjunction
(`,` `;` or an open paren); no continuation token, incompleteness is
the signal. Blank lines and comments are fine inside.

```
set suspects carol eddie bob
time time_of_death 3:00

?- could(suspects, X, lion_enclosure, time_of_death)
   → X = eddie · X = bob (2 answers)      … clues accumulate …
   → X = eddie                            the verdict (bold when one remains)
?- sole(suspects, X, lion_enclosure, time_of_death)
```

The starter `rules.pl` speaks detective, and its three goals read as a
case file — the eliminations, the candidates, the verdict:

```
?- cleared(suspects, X, hut, time_of_death, Where)   → X = alice, Where = beach
?- could(suspects, X, hut, time_of_death)            → X = bob
?- sole(suspects, X, hut, time_of_death)             → X = bob
```

For pairing puzzles (each suspect holds exactly one weapon), the
solver goal searches the assignment and RULES OUT as clues accumulate
— multiple answers mean the clues don't determine it yet:

```
?- pair_up(suspects, weapons, [holds(chancellor, flag), no(ivory, crowbar)], P)
```

Constraint forms: `holds(A, B)`, `no(A, B)`, `one_of([a, b], B)` (B's
holder is one of the listed As), `among(A, [b, c])` (A's item is one
of the listed Bs — "the person in the jury room had either the scales
or the bag of cash"). Place the surviving pairing in the scene; the
checks certify it.

`cleared/5` and `could/4` partition the set — every member is one or
the other; `sole/4` succeeds when exactly one candidate remains. Write
your own rules file for other domains; the facts don't care. Goals
need the playground served over HTTP (the engine and rules load at
runtime); the core never evaluates them — `compiled.goals` is data.

**Per-scene rules** — goals run in written order in one session, so an
early goal can teach the session a rule that later goals use:

```
?- assertz(loves(vincent, mia))
?- assertz((jealous(X, Y) :- loves(X, Z), loves(Y, Z), X \= Y))
?- jealous(A, B)
```

This is the honest home for rules (and facts) that belong to one scene
rather than to `rules.pl`: they live in the file, they ship with it,
and — like everything asserted rather than derived — the world does
not vouch for them. Note this is the one ordered corner of the
language: scene statements are order-free facts, but the goal list is
a *session* — definitions before uses.

New to Prolog? `examples/prolog-1-facts.scene` and
`prolog-2-rules.scene` teach it against a world you can see — facts,
variables, conjunction, negation-as-failure, disjunction, and the
anatomy of a real rule, each goal answered live under the scene.

### statements — testimony as data

```
statement viscount_eminence \+ present_at(viscount_eminence, college, 0)
statement vice_president_mauve carries_at(viscount_eminence, help_career, 0)
```

`statement <speaker> <claim>` declares what someone SAID — the claim
in goal syntax, transcribed literally (what the words assert, never
who they implicate). Declared once, it drives two derived panel lines:
each claim's **truth in the current world** (`viscount_eminence: … →
false` — not an error; a false statement is the lie the contract
predicts), and the assembled **liar certificate**: exactly one
speaker's claim false names the murderer, bold when it binds. The
speaker must be a scene object; claims are unevaluated data in the
core, like goals. Inside a hypothesis block, a statement exists only
in worlds that select it. The certificate is the body-free form —
pair it with the `where(body …)` verdict conjunction for the
geometric cross-check. See `template-murdle-liars.scene`.

**The `unknown` room** — a convention with teeth, so name it exactly
`unknown`. The *language* attaches no meaning to the name: it's an
ordinary room, deliberately (ignorance modeled as a place, not a
construct). But the layers above do: `rules.pl` treats presence in
`unknown` as *unaccounted* (`could_be_at` lets it mean "could be
anywhere"; `alibi` won't accept it as an alibi; `with` won't count two
things parked there as "together"), and the playground's persistence
reminder skips stays there. Park anything you can't yet place in a
room named `unknown`; everything downstream then reasons honestly
about your ignorance. (A future version may replace the magic name
with a room property — the convention is logged as debt.)

## Example

```
box crate    size(1.2 1.2 1.2) color(#8b5e3c)
sphere ball  r(0.35) on(crate) color(tomato)
box wall     size(4 2 0.2) north-of(crate 1) color(#5b6575)

? distance(ball wall)
```

## Known v0 limitations (deliberate)

- Query bounds are the axis-aligned box **around the rotated shape**: exact
  at 90° turns (a lying body blocks low, not tall — and animated rotation
  changes bounds over time), conservative at odd angles (a 45° box blocks
  as its enclosing box). Placement relations still use unrotated dims.
- Spheres and cylinders query via their bounding boxes, not true geometry.
- Sight lines are center-to-center; there is no field-of-view or edge peeking.
- Placement relations don't follow moving objects (no attachment/grouping).
- No `fits`, true-geometry intersection, or logical inference queries (v2/v3).

## Roadmap

- ~~**v1 — time**~~: done — `move`/`turn`, easing, chaining, scrubber,
  time-dependent queries.
- **v2 — spatial queries**: `fits?`, true-geometry intersection,
  attachment/grouping (`on()` that rides along), maybe `during`-style
  temporal queries ("was it ever visible?").
- **v3 — inference**: export the scene as facts to a logic engine (e.g. Tau
  Prolog in the browser) and derive conclusions about the space.
