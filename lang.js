/*
 * Schauplatz v0 — the language core.
 *
 * Pure JS, no dependencies, no rendering. compile(source) returns plain data:
 *   { objects, results, errors }
 * A renderer (three.js, or anything else) consumes that. Keeping this file
 * free of the DOM and three.js is deliberate: the language should be
 * portable to another host (Rust, etc.) by translating only this module.
 */
(function (global) {
  "use strict";

  const SHAPES = new Set(["box", "sphere", "cylinder"]);

  // Horizontal relations speak COMPASS (north = -z, matching door/window
  // sides and the north-up top view) — camera-relative names lied the
  // moment you orbited. The old egocentric names error with the mapping.
  const RELATIONS = new Set([
    "on", "above", "below",
    "west-of", "east-of", "south-of", "north-of",
  ]);

  const LEGACY_RELATIONS = {
    "left-of": "west-of", "right-of": "east-of",
    "in-front-of": "south-of", behind: "north-of",
  };

  const DEFAULT_GAP = {
    on: 0, above: 0.5, below: 0.5,
    "west-of": 0.25, "east-of": 0.25, "south-of": 0.25, "north-of": 0.25,
  };

  const QUERIES = new Set(["overlaps", "distance", "sees", "blocked-by", "in", "adjacent", "carries", "touches", "on"]);
  const BOOLEAN_QUERIES = new Set(["sees", "overlaps", "in", "carries", "touches", "on"]); // quantifiable / checkable

  // Themes are a whole-scene rendering hint: zero semantic effect (bounds,
  // sight lines, and queries ignore them). The core only validates the name
  // and passes it through; renderers decide what a theme looks like.

  // Like themes, views are a whole-scene rendering hint with zero semantic
  // effect: the projection and starting vantage the scene asks for.
  const VIEWS = new Set(["iso", "top"]);

  const EASES = {
    linear: (t) => t,
    in: (t) => t * t,
    out: (t) => t * (2 - t),
    "in-out": (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    bounce: (t) => {
      const n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
      if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
      return n1 * (t -= 2.625 / d1) * t + 0.984375;
    },
  };

  // ---------------------------------------------------------------- helpers

  function splitArgs(s) {
    s = s.trim();
    return s ? s.split(/[\s,]+/) : [];
  }

  function num(tok) {
    return /^-?(\d+\.?\d*|\.\d+)$/.test(tok) ? parseFloat(tok) : null;
  }

  function nums(args, count) {
    if (args.length !== count) return null;
    const out = args.map(num);
    return out.some((n) => n === null) ? null : out;
  }

  // ---------------------------------------------------------------- parsing

  const RESERVED = new Set([
    ...SHAPES, "group", "room", "link", "part", "end", "move", "turn", "orbit", "walk", "paint", "time", "hypothesis", "active",
    "theme", "clock", "check", "set",
  ]);

  // With a clock declared, h:mm tokens become valid absolute times and Nm
  // tokens valid durations. Returns timeline seconds, or null if the token
  // isn't a time form (callers fall back to plain numbers).
  // Resolves one time token: a declared time name, h:mm (needs the
  // clock), or Nm minutes. timeCtx = { clock, times } threads through
  // every parser that accepts a time.
  function wallTime(tok, timeCtx, err) {
    const times = timeCtx && timeCtx.times;
    if (times && times.has(tok)) return times.get(tok).value;
    const clock = timeCtx && timeCtx.clock;
    const abs = tok.match(/^(\d{1,2}):(\d{2})$/);
    if (abs) {
      if (!clock) {
        err(`"${tok}" is a wall-clock time — declare one first, e.g. clock 4:00 minute(1)`);
        return NaN;
      }
      const mins = parseInt(abs[1], 10) * 60 + parseInt(abs[2], 10);
      if (parseInt(abs[2], 10) > 59) {
        err(`"${tok}" isn't a time`);
        return NaN;
      }
      const t = (mins - clock.start) * clock.minute;
      if (t < 0) {
        err(`"${tok}" is before the clock's start`);
        return NaN;
      }
      return t;
    }
    const dur = tok.match(/^(\d+\.?\d*|\.\d+)m$/);
    if (dur) {
      if (!clock) {
        err(`"${tok}" is a duration in minutes — declare a clock first, e.g. clock 4:00 minute(1)`);
        return NaN;
      }
      return parseFloat(dur[1]) * clock.minute;
    }
    return null;
  }

  function parse(src) {
    const objects = new Map(); // name -> object
    const queries = [];
    const anims = [];
    const errors = [];
    const parts = new Map(); // name -> { name, line, body: [{ line, lineNo }] }
    const sets = new Map(); // name -> { name, line, members }
    const times = new Map(); // name -> { name, tok, line, value } — named time facts
    const goals = []; // ?- goal(...) — questions FOR THE RULES LAYER, data here
    const events = []; // take/drop — possession changing hands on the timeline
    const thenBlocks = []; // sequence blocks — anchored at the frontier in buildTracks
    const statements = []; // statement <speaker> <claim> — testimony as data
    const cameras = []; // camera segments — scripted projection, zero semantics
    let theme = null; // { name, line }
    let view = null; // { name, line }
    let clock = null; // { start: minutes, minute: seconds-per-story-minute, line }

    // /* block comments */ vanish first — a character walk, not a
    // regex, so `/*` inside a // comment stays prose and every newline
    // survives (error line numbers must not shift). Quoted atoms are
    // not tracked: a literal '/*' inside quotes isn't supported.
    src = (() => {
      let out = "";
      let mode = 0; // 0 code, 1 line comment, 2 block comment
      let line = 1;
      let openLine = 0;
      for (let i = 0; i < src.length; i++) {
        const c = src[i];
        const d = src[i + 1];
        if (c === "\n") {
          line++;
          if (mode === 1) mode = 0;
          out += "\n";
          continue;
        }
        if (mode === 0) {
          if (c === "/" && d === "/") { mode = 1; out += "//"; i++; continue; }
          if (c === "/" && d === "*") { mode = 2; openLine = line; out += "  "; i++; continue; }
          if (c === "*" && d === "/") {
            errors.push({ line, msg: "stray */ — no /* opened this comment" });
            out += "  ";
            i++;
            continue;
          }
          out += c;
          continue;
        }
        if (mode === 1) { out += c; continue; }
        if (c === "*" && d === "/") { mode = 0; out += "  "; i++; continue; }
        out += " ";
      }
      if (mode === 2) errors.push({ line: openLine, msg: "/* comment is never closed — missing */" });
      return out;
    })();

    const stripped = src
      .split("\n")
      .map((raw) => raw.replace(/\/\/.*$/, "").trim());

    // Goals may span lines: a ?- line CONTINUES while its parens are
    // unbalanced or it ends mid-conjunction (`,` `;` or an open paren).
    // No continuation token — incompleteness is the signal. Joined here,
    // before any pass sees the lines, so a continuation like `at(...)`
    // can't be mistaken for a statement. Comments and blank lines are
    // fine inside; errors report the ?- line.
    {
      const parenDebt = (s) => {
        let n = 0;
        for (const ch of s) {
          if (ch === "(") n++;
          else if (ch === ")") n--;
        }
        return n;
      };
      for (let i = 0; i < stripped.length; i++) {
        if (!/^\?-/.test(stripped[i])) continue;
        let text = stripped[i];
        let j = i;
        while ((parenDebt(text) > 0 || /[,;(]$/.test(text)) && j + 1 < stripped.length) {
          j++;
          if (!stripped[j]) continue; // blank (or comment-only) lines inside a goal are fine
          text += " " + stripped[j];
          stripped[j] = "";
        }
        stripped[i] = text;
      }
    }

    // Pass 0 — HYPOTHESIS blocks: alternate worlds in one file. The base
    // text is the shared world (evidence checks live there); each
    // `hypothesis <name> … end` holds one variant routing; `active <name>`
    // picks exactly one, and only that block compiles. One compile is
    // still ONE determinate world — this is conditional compilation, not
    // modality; the multiverse lives across compiles. Inactive blocks are
    // checked for shape (their ends must match) and otherwise skipped.
    const skip = new Array(stripped.length).fill(false);
    const hypotheses = new Map(); // name -> { name, line, range }
    let active = null;
    {
      const stack = []; // open blocks, for end-matching: { kind, name?, line, start }
      stripped.forEach((line, i) => {
        const lineNo = i + 1;
        if (!line) return;
        let m;
        if ((m = line.match(/^hypothesis\s+([A-Za-z_][\w-]*)\s*$/))) {
          skip[i] = true;
          if (stack.some((b) => b.kind === "hypothesis")) {
            errors.push({ line: lineNo, msg: "hypothesis blocks don't nest" });
          }
          if (RESERVED.has(m[1])) {
            errors.push({ line: lineNo, msg: `"${m[1]}" is a reserved word — pick another hypothesis name` });
          } else if (hypotheses.has(m[1])) {
            errors.push({ line: lineNo, msg: `hypothesis "${m[1]}" is already defined on line ${hypotheses.get(m[1]).line}` });
          } else {
            hypotheses.set(m[1], { name: m[1], line: lineNo });
          }
          stack.push({ kind: "hypothesis", name: m[1], line: lineNo, start: i });
          return;
        }
        if ((m = line.match(/^active\s+(.+?)\s*$/))) {
          // active <name> <name>... — SELECT the world: the union of the
          // named blocks compiles. Still one determinate world per
          // compile; composition lets per-statement branches (slate_true,
          // pine_false) assemble a theory without duplicating facts.
          // Deliberately NO contradiction checking between blocks — the
          // author composes; duplicate names and red checks police it.
          skip[i] = true;
          if (active) {
            errors.push({ line: lineNo, msg: `active is already set (line ${active.line}) — one active line per scene` });
          } else {
            const names = splitArgs(m[1]);
            const badTok = names.find((n) => !/^[A-Za-z_][\w-]*$/.test(n));
            const dup = names.find((n, k) => names.indexOf(n) !== k);
            if (badTok) {
              errors.push({ line: lineNo, msg: `active: "${badTok}" isn't a hypothesis name` });
            } else if (dup) {
              errors.push({ line: lineNo, msg: `active names "${dup}" twice` });
            } else {
              active = { names, line: lineNo };
            }
          }
          return;
        }
        if (/^part\b/.test(line)) {
          if (stack.some((b) => b.kind === "hypothesis")) {
            errors.push({ line: lineNo, msg: "part definitions don't belong inside a hypothesis — define parts at the top level" });
          }
          stack.push({ kind: "part", line: lineNo, start: i });
          return;
        }
        if (/^at\b/.test(line) || /^set\s+[A-Za-z_][\w-]*\s*$/.test(line)) {
          stack.push({ kind: "block", line: lineNo, start: i });
          return;
        }
        if (line === "end") {
          const top = stack.pop(); // a stray end reports in later passes
          if (top && top.kind === "hypothesis") {
            skip[i] = true;
            const ref = hypotheses.get(top.name);
            if (ref && !ref.range) ref.range = [top.start, i];
          }
        }
      });
      for (const b of stack) {
        if (b.kind === "hypothesis") {
          errors.push({ line: b.line, msg: `hypothesis "${b.name}" is missing its end` });
        }
      }
      if (hypotheses.size && !active) {
        errors.push({
          line: [...hypotheses.values()][0].line,
          msg: `${hypotheses.size} ${hypotheses.size === 1 ? "hypothesis" : "hypotheses"} declared — pick one or more: active <name>... (${[...hypotheses.keys()].join(", ")})`,
        });
      }
      if (active && !hypotheses.size) {
        errors.push({ line: active.line, msg: "active names a hypothesis, but none are declared" });
      }
      if (active && hypotheses.size) {
        for (const n of active.names) {
          if (!hypotheses.has(n)) {
            errors.push({
              line: active.line,
              msg: `active: no hypothesis named "${n}" (declared: ${[...hypotheses.keys()].join(", ")})`,
            });
          }
        }
      }
      const activeSet = new Set(active ? active.names : []);
      for (const h of hypotheses.values()) {
        if (!h.range) continue;
        if (!activeSet.has(h.name)) {
          for (let i = h.range[0]; i <= h.range[1]; i++) skip[i] = true; // the worlds not taken
        }
      }
    }

    // Pass 1 — lift out part definitions (part <name> ... end) and the
    // clock. Both are collected before anything else parses, so statement
    // order stays meaningless (a move may use 5:15 before the clock line).
    const inPart = new Array(stripped.length).fill(false);
    let cur = null;
    let blockDepth = 0; // pass 1 only tells at/set-block ends from part ends
    stripped.forEach((line, i) => {
      if (skip[i]) return;
      const lineNo = i + 1;
      if (!cur && (/^(at|then)\b/.test(line) || /^set\s+[A-Za-z_][\w-]*\s*$/.test(line))) {
        blockDepth++; // at/then-blocks and set-BLOCKS (bare `set name`) parse in pass 2
        return;
      }
      if (!cur && /^clock\b/.test(line)) {
        inPart[i] = true; // consumed here, skipped by pass 2
        const m = line.match(/^clock\s+(\d{1,2}):(\d{2})(?:\s+minute\(([^)]*)\))?$/);
        if (!m || parseInt(m[2], 10) > 59) {
          errors.push({ line: lineNo, msg: "expected: clock h:mm minute(seconds)? — e.g. clock 4:45 minute(0.5)" });
          return;
        }
        if (clock) {
          errors.push({ line: lineNo, msg: `clock is already set (line ${clock.line}) — one clock per scene` });
          return;
        }
        const spm = m[3] !== undefined ? num(m[3]) : 1;
        if (spm === null || spm <= 0) {
          errors.push({ line: lineNo, msg: "minute(): expected one positive number — how many seconds a story-minute lasts" });
          return;
        }
        clock = { start: parseInt(m[1], 10) * 60 + parseInt(m[2], 10), minute: spm, line: lineNo };
        return;
      }
      if (!cur && /^time\b/.test(line)) {
        // time <name> <h:mm|seconds> — a NAMED time fact ("time_of_death"),
        // usable wherever a point in time goes. Collected order-free like
        // the clock; resolved after pass 1 (the clock may come later).
        inPart[i] = true;
        const m = line.match(/^time\s+([A-Za-z_][\w-]*)\s+(\S+)$/);
        if (!m) {
          errors.push({ line: lineNo, msg: "expected: time <name> <h:mm or seconds> — e.g. time time_of_death 3:00" });
        } else if (RESERVED.has(m[1])) {
          errors.push({ line: lineNo, msg: `"${m[1]}" is a reserved word — pick another time name` });
        } else if (times.has(m[1])) {
          errors.push({ line: lineNo, msg: `time "${m[1]}" is already defined on line ${times.get(m[1]).line}` });
        } else {
          times.set(m[1], { name: m[1], tok: m[2], line: lineNo, value: null });
        }
        return;
      }
      if (/^part\b/.test(line)) {
        inPart[i] = true;
        if (cur) {
          errors.push({ line: lineNo, msg: "part definitions can't nest" });
          return;
        }
        const m = line.match(/^part\s+([A-Za-z_][\w-]*)$/);
        if (!m) {
          errors.push({ line: lineNo, msg: "expected: part <name>" });
        } else if (RESERVED.has(m[1])) {
          errors.push({ line: lineNo, msg: `"${m[1]}" is a reserved word — pick another part name` });
        } else if (parts.has(m[1])) {
          errors.push({
            line: lineNo,
            msg: `part "${m[1]}" is already defined on line ${parts.get(m[1]).line}`,
          });
        } else {
          cur = { name: m[1], line: lineNo, body: [] };
        }
      } else if (line === "end") {
        if (!cur && blockDepth > 0) {
          blockDepth--; // closes an at/set block; pass 2 handles it
          return;
        }
        inPart[i] = true;
        if (!cur) {
          errors.push({ line: lineNo, msg: '"end" without a matching part, at or set block' });
        } else if (!cur.body.length) {
          errors.push({ line: cur.line, msg: `part "${cur.name}" is empty` });
          cur = null;
        } else {
          parts.set(cur.name, cur);
          cur = null;
        }
      } else if (cur) {
        inPart[i] = true;
        if (line) cur.body.push({ line, lineNo });
      }
    });
    if (cur) {
      errors.push({ line: cur.line, msg: `part "${cur.name}" is missing its end` });
    }

    // Resolve declared times now that the clock (if any) is known.
    // Names bind LITERALS only: no chains, no arithmetic, no durations.
    for (const tm of [...times.values()]) {
      if (/^(\d+\.?\d*|\.\d+)m$/.test(tm.tok)) {
        errors.push({ line: tm.line, msg: `time ${tm.name}: names a point in time — "${tm.tok}" is a duration` });
        times.delete(tm.name);
        continue;
      }
      let bad = false;
      const w = wallTime(tm.tok, { clock, times: null }, (msg) => {
        errors.push({ line: tm.line, msg: `time ${tm.name}: ${msg}` });
        bad = true;
      });
      if (bad) { times.delete(tm.name); continue; }
      const v = w !== null ? w : num(tm.tok);
      if (v === null || v < 0) {
        errors.push({ line: tm.line, msg: `time ${tm.name}: expected h:mm (with a clock) or seconds >= 0` });
        times.delete(tm.name);
      } else {
        tm.value = v;
      }
    }
    const timeCtx = { clock, times };

    // Pass 2 — everything else
    let block = null; // open `at <time>` block: { t, line }
    let setBlock = null; // open `set <name>` BLOCK: declarations enroll as members
    stripped.forEach((line, i) => {
      if (skip[i] || inPart[i] || !line) return;
      const lineNo = i + 1;

      // set <name> ... end — the BLOCK form of set: every object
      // declared inside becomes a member. Membership is single-sourced
      // in where the declaration lives — no name list to drift out of
      // sync when members are added, removed or renamed.
      if (/^set\s+[A-Za-z_][\w-]*\s*$/.test(line)) {
        const name = line.match(/^set\s+([A-Za-z_][\w-]*)/)[1];
        if (setBlock || block) {
          errors.push({ line: lineNo, msg: `blocks don't nest (block open since line ${(setBlock || block).line})` });
          return;
        }
        if (RESERVED.has(name)) {
          errors.push({ line: lineNo, msg: `"${name}" is a reserved word — pick another set name` });
          return;
        }
        if (sets.has(name)) {
          errors.push({ line: lineNo, msg: `set "${name}" is already defined on line ${sets.get(name).line}` });
          return;
        }
        setBlock = { name, line: lineNo, members: [] };
        return;
      }
      if (setBlock) {
        if (line === "end") {
          if (!setBlock.members.length) {
            errors.push({ line: setBlock.line, msg: `set "${setBlock.name}" is empty` });
          } else {
            sets.set(setBlock.name, { name: setBlock.name, line: setBlock.line, members: setBlock.members });
          }
          setBlock = null;
          return;
        }
        if (/^(move|turn|orbit|walk|paint|take|drop|at|check|set|theme|view|time|clock|statement|camera)\b/.test(line) || line.startsWith("?")) {
          errors.push({
            line: lineNo,
            msg: `a set block encloses declarations — only objects belong inside (set "${setBlock.name}" open since line ${setBlock.line})`,
          });
          return;
        }
        parseStatement(line, lineNo, objects, errors, { parts, anims, timeCtx });
        // enroll the declared name — always the statement's second token
        // (shape/room/group/link/instance all read `<kind> <name> ...`)
        const nm = (line.match(/^\S+\s+([A-Za-z_][\w-]*)/) || [])[1];
        if (nm && objects.has(nm)) {
          if (objects.get(nm).repeat) {
            errors.push({
              line: lineNo,
              msg: `repeat inside a set block: the copies already form a set (the "${nm}" family)`,
            });
          } else {
            setBlock.members.push(nm);
          }
        }
        return;
      }

      // at <time> ... end / at <t0> .. <t1> ... end — TIME BLOCKS.
      // The instant form scopes MOMENT facts, the range form DURATION
      // facts: statements inside get the block's time where they didn't
      // state their own (explicit start/at/during always wins). Pure
      // desugar: afterwards every statement stands alone, and order
      // still means nothing.
      if (/^at\b/.test(line)) {
        if (block) {
          errors.push({ line: lineNo, msg: `at blocks don't nest (block open since line ${block.line})` });
          return;
        }
        const m = line.match(/^at\s+(\S+?)(?:\s*\.\.\s*(\S+))?$/);
        if (!m) {
          errors.push({ line: lineNo, msg: "expected: at <time> ... end, or at <t0> .. <t1> ... end" });
          return;
        }
        let bad = false;
        const resolve = (tok) => {
          const w = wallTime(tok, timeCtx, (msg) => {
            errors.push({ line: lineNo, msg: `at: ${msg}` });
            bad = true;
          });
          return w !== null ? w : num(tok);
        };
        const t0 = resolve(m[1]);
        const t1 = m[2] !== undefined ? resolve(m[2]) : null;
        if (bad) return;
        if (t0 === null || t0 < 0 || (m[2] !== undefined && t1 === null)) {
          errors.push({ line: lineNo, msg: "at: expected a time >= 0 (h:mm, seconds, or a time name)" });
          return;
        }
        if (t1 !== null && t1 <= t0) {
          errors.push({ line: lineNo, msg: "at: a range needs two increasing times — at 3:00 .. 3:15" });
          return;
        }
        block = { t0, t1, line: lineNo };
        return;
      }

      // then <gap>? ... end — the SEQUENCE block: anchors its contents
      // at the FRONTIER (the moment everything written before it has
      // finished), plus an optional pacing gap. The at-block with a
      // computed time: the story's order becomes the schedule, and no
      // absolute number is invented. Animation has always been the
      // language's one ordered corner (segments chain in written
      // order); then extends chaining from an object's segments to the
      // scene's beats.
      if (/^then\b/.test(line)) {
        if (block) {
          errors.push({ line: lineNo, msg: `time blocks don't nest (block open since line ${block.line})` });
          return;
        }
        const m = line.match(/^then(?:\s+(\S+))?$/);
        if (!m) {
          errors.push({ line: lineNo, msg: "expected: then <gap>? ... end" });
          return;
        }
        let gap = 0;
        if (m[1] !== undefined) {
          if (/:/.test(m[1])) {
            errors.push({ line: lineNo, msg: "then takes a gap DURATION, not a clock time — then 2m or seconds" });
            return;
          }
          const mm = m[1].match(/^(\d+(?:\.\d+)?)m$/);
          if (mm && timeCtx.clock) gap = parseFloat(mm[1]) * timeCtx.clock.minute;
          else gap = num(m[1]);
          if (gap === null || gap < 0) {
            errors.push({ line: lineNo, msg: "then: expected a non-negative gap in seconds (or 2m with a clock)" });
            return;
          }
        }
        block = { then: thenBlocks.length, gap, line: lineNo };
        thenBlocks.push({ id: thenBlocks.length, gap, line: lineNo });
        return;
      }
      if (line === "end") {
        // pass 1 already vetted this end as an at-block's; after a
        // nesting error block may be null — swallow either way
        block = null;
        return;
      }
      const blockAt = block ? (block.then !== undefined ? { then: block.then } : { t0: block.t0, t1: block.t1 }) : null;

      // ?- goal(Args) — a question for the RULES LAYER. The core carries
      // it as data (compiled.goals); evaluation happens wherever an
      // engine consumes the fact export. Deliberately unvalidated beyond
      // shape: the goal's vocabulary belongs to the rules, not to us.
      if (/^\?-/.test(line)) {
        if (block) {
          errors.push({ line: lineNo, msg: "goals ask the rules layer — they don't take a time block" });
          return;
        }
        const body = line.slice(2).trim().replace(/\.$/, "");
        if (!body) {
          errors.push({ line: lineNo, msg: "expected: ?- goal(Args) — a question for the rules layer" });
          return;
        }
        goals.push({ goal: body, line: lineNo });
        return;
      }

      if (line.startsWith("?")) {
        parseQuery(line.slice(1), lineNo, queries, errors, timeCtx, false, blockAt);
      } else if (/^check\b/.test(line)) {
        parseQuery(line.slice(5), lineNo, queries, errors, timeCtx, true, blockAt);
      } else if (block && !/^(move|turn|orbit|walk|paint|take|drop|camera)\b/.test(line)) {
        // a time block scopes EVENTS; things that exist are declared outside
        errors.push({
          line: lineNo,
          msg: `only animations, queries and checks belong in an at block (open since line ${block.line}) — declare objects outside it`,
        });
      } else if (/^set\b/.test(line)) {
        // set <name> <member> <member> ... — a named, non-spatial
        // collection that queries can quantify over
        const m = line.match(/^set\s+([A-Za-z_][\w-]*)\s+(.+)$/);
        if (!m) {
          errors.push({ line: lineNo, msg: "expected: set <name> <member> <member> ..." });
        } else if (RESERVED.has(m[1])) {
          errors.push({ line: lineNo, msg: `"${m[1]}" is a reserved word — pick another set name` });
        } else if (sets.has(m[1])) {
          errors.push({
            line: lineNo,
            msg: `set "${m[1]}" is already defined on line ${sets.get(m[1]).line}`,
          });
        } else {
          const members = splitArgs(m[2]);
          if (members.some((x) => num(x) !== null)) {
            errors.push({ line: lineNo, msg: "set members are object names" });
          } else {
            sets.set(m[1], { name: m[1], line: lineNo, members });
          }
        }
      } else if (/^(move|turn|orbit|walk|paint)\b/.test(line)) {
        parseAnim(line, lineNo, anims, errors, timeCtx, blockAt);
      } else if (/^(take|drop)\b/.test(line)) {
        parsePossess(line, lineNo, events, errors, timeCtx, blockAt);
      } else if (/^camera\b/.test(line)) {
        parseCamera(line, lineNo, cameras, errors, timeCtx, blockAt);
      } else if (/^statement\b/.test(line)) {
        // statement <speaker> <claim> — testimony as DATA: the claim is
        // goal syntax, carried unevaluated (its vocabulary belongs to
        // the rules, like ?- goals). Declared ONCE; the playground
        // assembles the liar certificate from all statements. Inside a
        // hypothesis block, a statement exists only in worlds that
        // select it.
        const m = line.match(/^statement\s+([A-Za-z_][\w-]*)\s+(.+)$/);
        if (!m) {
          errors.push({
            line: lineNo,
            msg: "expected: statement <speaker> <claim> — e.g. statement bob present_at(bob, garden, 0)",
          });
        } else {
          statements.push({ speaker: m[1], claim: m[2].trim().replace(/\.$/, ""), line: lineNo });
        }
      } else if (/^theme\b/.test(line)) {
        const m = line.match(/^theme\s+([A-Za-z_][\w-]*)$/);
        if (!m) {
          errors.push({ line: lineNo, msg: "expected: theme <name>" });
        } else if (theme) {
          // NOTE: theme names are no longer validated here — custom
          // themes live in the renderer's themes.json, so the renderer
          // owns the list and warns about unknowns. The core just
          // carries the name.
          errors.push({
            line: lineNo,
            msg: `theme is already "${theme.name}" (line ${theme.line}) — one theme per scene`,
          });
        } else {
          theme = { name: m[1], line: lineNo };
        }
      } else if (/^view\b/.test(line)) {
        const m = line.match(/^view\s+([A-Za-z_][\w-]*)$/);
        if (!m) {
          errors.push({ line: lineNo, msg: "expected: view <name>" });
        } else if (!VIEWS.has(m[1])) {
          errors.push({
            line: lineNo,
            msg: `unknown view "${m[1]}" (available: ${[...VIEWS].join(", ")}; omit for free perspective)`,
          });
        } else if (view) {
          errors.push({
            line: lineNo,
            msg: `view is already "${view.name}" (line ${view.line}) — one view per scene`,
          });
        } else {
          view = { name: m[1], line: lineNo };
        }
      } else {
        parseStatement(line, lineNo, objects, errors, { parts, anims, timeCtx });
      }
    });
    if (block) {
      errors.push({ line: block.line, msg: "at block is missing its end" });
    }
    if (setBlock) {
      errors.push({ line: setBlock.line, msg: `set "${setBlock.name}" block is missing its end` });
    }

    // a time name that shadows an object or set would read ambiguously
    for (const tm of times.values()) {
      const other = objects.get(tm.name) || sets.get(tm.name);
      if (other) {
        errors.push({
          line: tm.line,
          msg: `time "${tm.name}" collides with the ${objects.has(tm.name) ? "object" : "set"} of that name (line ${other.line})`,
        });
      }
    }

    return {
      objects, queries, anims, events, errors, sets, goals, statements, cameras, thenBlocks,
      theme: theme ? theme.name : null,
      view: view ? view.name : null,
      clock: clock ? { start: clock.start, minute: clock.minute } : null,
      times: new Map([...times].map(([k, v]) => [k, v.value])),
      hypotheses: [...hypotheses.keys()],
      active: active ? active.names : null,
      parts: [...parts.keys()],
    };
  }

  function parseAnim(line, lineNo, anims, errors, timeCtx, blockAt) {
    const err = (msg) => errors.push({ line: lineNo, msg });

    const m = line.match(/^(move|turn|orbit|walk|paint)\s+([A-Za-z_][\w-]*)\s*(.*)$/);
    if (!m) {
      err("expected: move <name> to(x y z) over(seconds) ...");
      return;
    }
    const [, kind, target, rest] = m;
    const a = {
      kind, target, line: lineNo,
      // paint snaps by default (a light changes, it doesn't smear);
      // spatial verbs default to a 1-second glide
      to: null, by: null, from: null, start: null, after: null,
      over: kind === "paint" ? 0 : 1, ease: "linear",
      around: null, axis: "y", // orbit only
    };

    // one time argument: a number, a named time, or (with a clock) 5:15 / 2m
    const timeArg = (args, key) => {
      if (args.length !== 1) return null;
      const w = wallTime(args[0], timeCtx, (msg) => err(`${key}(): ${msg}`));
      if (Number.isNaN(w)) return NaN; // wallTime already reported
      if (w !== null) return w;
      return num(args[0]);
    };

    let r = rest;
    while (r.length) {
      const pm = r.match(/^([A-Za-z_][\w-]*)\(([^)]*)\)\s*/);
      if (!pm) {
        err(`can't read "${r}" — properties look like name(args)`);
        return;
      }
      const key = pm[1];
      const args = splitArgs(pm[2]);
      r = r.slice(pm[0].length);

      switch (key) {
        case "to": {
          if (kind === "orbit") return err("orbit uses around() and by(degrees), not to()");
          if (kind === "paint") {
            // to(color) — one color name or #hex, same tokens color() takes
            if (args.length !== 1) return err("paint to(): expected one color name or #hex");
            a.to = args[0];
            break;
          }
          // to(x y z), to(name), or to(name dx dz / dx dy dz) — a named
          // object's placed position, optionally slid by an offset
          if (args.length >= 1 && num(args[0]) === null) {
            if (kind === "turn") return err("turn to(): expected 3 numbers (degrees)");
            a.to = { ref: args[0] };
            if (args.length > 1) {
              const off = nums(args.slice(1), kind === "walk" ? 2 : 3);
              if (!off) {
                return err(
                  kind === "walk"
                    ? "to(name dx dz): expected 2 numbers after the name"
                    : "to(name dx dy dz): expected 3 numbers after the name",
                );
              }
              a.to.off = off;
            }
            break;
          }
          // walk moves on the ground plane: x z only, height stays yours
          const v = nums(args, kind === "walk" ? 2 : 3);
          if (!v) {
            return err(
              kind === "walk" ? "to(): walk expects x z, or one name" : "to(): expected 3 numbers or one object name",
            );
          }
          a.to = v;
          break;
        }
        case "by": {
          if (kind === "paint") return err("paint has no by() — colors don't add; use to(color)");
          if (kind === "orbit") {
            const v = nums(args, 1);
            if (!v) return err("by(): orbit expects one number (degrees of arc)");
            a.by = v;
            break;
          }
          const v = nums(args, kind === "walk" ? 2 : 3);
          if (!v) return err(kind === "walk" ? "by(): walk expects dx dz" : "by(): expected 3 numbers");
          a.by = v;
          break;
        }
        case "from": {
          if (kind === "paint") return err("paint chains from the previous color — it has no from()");
          const v = nums(args, kind === "walk" ? 2 : 3);
          if (!v) return err(kind === "walk" ? "from(): walk expects x z" : "from(): expected 3 numbers");
          a.from = v;
          break;
        }
        case "around": {
          // around(x y z), or around(name) — the circle's center
          if (kind !== "orbit") return err(`around(): only orbit has around()`);
          if (args.length === 1 && num(args[0]) === null) {
            a.around = { ref: args[0] };
            break;
          }
          const v = nums(args, 3);
          if (!v) return err("around(): expected 3 numbers or one object name");
          a.around = v;
          break;
        }
        case "axis": {
          if (kind !== "orbit") return err(`axis(): only orbit has axis()`);
          if (args.length !== 1 || !["x", "y", "z"].includes(args[0])) {
            return err("axis(): one of x, y, z");
          }
          a.axis = args[0];
          break;
        }
        case "start": {
          const v = timeArg(args, "start");
          if (Number.isNaN(v)) return; // time error already reported
          if (v === null || v < 0) return err("start(): expected a time >= 0 (or 5:15 with a clock)");
          a.start = v;
          break;
        }
        case "after": case "over": {
          if (args.length === 1 && /:/.test(args[0])) {
            return err(`${key}(): takes a duration, not a clock time — use ${key}(2m) or seconds`);
          }
          if (args.length === 1 && timeCtx && timeCtx.times.has(args[0])) {
            return err(`${key}(): takes a duration — "${args[0]}" names a point in time`);
          }
          const v = timeArg(args, key);
          if (Number.isNaN(v)) return;
          // over(0) is the LEAP: "was there at that time", no path, no
          // invented route — testimony placement, honest about the gap
          if (v === null || v < 0) {
            return err(`${key}(): expected a non-negative duration in seconds (or 2m with a clock)`);
          }
          a[key] = v;
          break;
        }
        case "ease": {
          if (args.length !== 1 || !(args[0] in EASES)) {
            return err(`ease(): one of ${Object.keys(EASES).join(", ")}`);
          }
          a.ease = args[0];
          break;
        }
        default:
          return err(`${key}(): unknown property for ${kind}`);
      }
    }

    if (kind === "orbit") {
      if (!a.around) return err("orbit needs around(): a center point or object");
      if (!a.by) return err("orbit needs by(degrees): the arc to sweep");
    } else if (kind === "paint") {
      if (!a.to) return err("paint needs to(color)");
    } else {
      if (!a.to && !a.by) return err(`${kind} needs a destination: to() or by()`);
      if (a.to && a.by) return err("use to() or by(), not both");
    }
    if (a.start !== null && a.after !== null) {
      return err("use start(t) or after(s), not both");
    }
    // inside an at block: fill the block's time where the statement
    // stated no time of its own — explicit start/after always wins.
    // A range block anchors anims at its START (the window scopes what
    // holds; movement that establishes it begins as the window opens).
    if (blockAt != null && a.start === null && a.after === null) {
      if (blockAt.then !== undefined) a.thenBlock = blockAt.then;
      else a.start = blockAt.t0;
    }
    anims.push(a);
  }

  // take <holder> <thing> at(time) off(dx dy dz)? / drop <holder> <thing>
  // at(time) — possession changing hands on the timeline. Instant events
  // like appear/vanish, not segments: a hand closing isn't a smear.
  // take teleports (the leap's logic — "she had it by 2:15" is honest
  // testimony; walk the holder there first if you know the pickup);
  // drop rests the thing on the ground at the holder's spot.
  function parsePossess(line, lineNo, events, errors, timeCtx, blockAt) {
    const err = (msg) => errors.push({ line: lineNo, msg });
    const m = line.match(/^(take|drop)\s+([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*(.*)$/);
    if (!m) {
      err("expected: take <holder> <thing> at(<time>)  /  drop <holder> <thing> at(<time>)");
      return;
    }
    const [, kind, holder, thing, rest] = m;
    const e = { kind, holder, thing, t: null, off: [0, 0, 0], line: lineNo };
    let r = rest;
    while (r.length) {
      const pm = r.match(/^([A-Za-z_][\w-]*)\(([^)]*)\)\s*/);
      if (!pm) return err(`can't read "${r}" — properties look like name(args)`);
      const key = pm[1];
      const args = splitArgs(pm[2]);
      r = r.slice(pm[0].length);
      if (key === "at") {
        if (args.length !== 1) return err("at(): expected one time");
        const w = wallTime(args[0], timeCtx, (msg) => err(`at(): ${msg}`));
        if (Number.isNaN(w)) return;
        const t = w !== null ? w : num(args[0]);
        if (t === null || t < 0) return err("at(): expected a time >= 0 (seconds, a time name, or 2:30 with a clock)");
        e.t = t;
      } else if (key === "off" && kind === "take") {
        if (args.length === 1 && num(args[0]) === null) {
          if (!WEAR_ANCHORS.has(args[0])) {
            return err(`off(): unknown anchor "${args[0]}" — one of ${[...WEAR_ANCHORS].join(", ")} (or give dx dy dz)`);
          }
          e.anchor = args[0];
        } else {
          const v = nums(args, 3);
          if (!v) return err("off(): expected 3 numbers or an anchor (head, neck, chest, back, hand)");
          e.off = v;
        }
      } else {
        return err(`${kind} doesn't take ${key}() — just at(time)${kind === "take" ? " and off(dx dy dz)" : ""}`);
      }
    }
    if (e.t === null && blockAt != null) {
      if (blockAt.then !== undefined) e.thenBlock = blockAt.then;
      else e.blockT = blockAt.t0;
    }
    // no explicit time: the event CHAINS — resolved in buildPossession,
    // when segment end times are known (the walk lands, then the hand
    // closes). A block's instant is the floor, not the fill: a bare
    // event never interrupts the thing's own walk.
    events.push(e);
  }

  // camera <props> — the SCRIPTED CAMERA: a projection channel speaking
  // the animation grammar. to() dollies (over(0) is a cut), from()
  // mounts the camera on an object (first person — it rides until the
  // next position segment), look() aims. Zero semantic effect: the
  // camera has no bounds, blocks nothing, and never appears in facts —
  // it changes what you see, never what is true. Because aiming is
  // projection, look(name) TRACKS its target live (the to()-no-pursuit
  // rule is about world facts; a camera may follow).
  const COMPASS_DIRS = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
  const WEAR_ANCHORS = new Set(["head", "neck", "chest", "back", "hand"]);

  // A wear anchor on a person, as an offset from their BOUNDS CENTER
  // (which is what deriveHeld offsets from): computed from the same
  // proportions makePerson uses, so a scaled person wears things at
  // scaled heights. Front is -z (the compass north the person faces
  // by default); hand is the +x side.
  function wearOffset(person, anchor) {
    const h = person.h;
    const headR = 0.11 * h;
    const bodyH = h - 2 * headR;
    const bodyR = 0.15 * h;
    const c = h / 2; // bounds center height (feet at 0, crown at h)
    switch (anchor) {
      case "head": return [0, h - c, 0]; // at the crown — a hat's brim sits on it
      case "neck": return [0, bodyH - c, -bodyR]; // top of the body, at the front surface
      case "chest": return [0, 0.62 * bodyH - c, -bodyR];
      case "back": return [0, 0.62 * bodyH - c, bodyR];
      case "hand": return [bodyR + 0.04 * h, 0.42 * bodyH - c, 0];
    }
  }
  function parseCamera(line, lineNo, cameras, errors, timeCtx, blockAt) {
    const err = (msg) => errors.push({ line: lineNo, msg });
    const seg = { to: null, from: null, look: null, start: null, after: null, over: null, ease: "linear", line: lineNo };
    const timeArg = (args, key) => {
      if (args.length !== 1) return null;
      const w = wallTime(args[0], timeCtx, (msg) => err(`${key}(): ${msg}`));
      if (Number.isNaN(w)) return NaN;
      return w !== null ? w : num(args[0]);
    };
    let r = line.slice(6).trim();
    while (r.length) {
      const pm = r.match(/^([A-Za-z_][\w-]*)\(([^)]*)\)\s*/);
      if (!pm) return err(`can't read "${r}" — properties look like name(args)`);
      const key = pm[1];
      const args = splitArgs(pm[2]);
      r = r.slice(pm[0].length);
      switch (key) {
        case "to": {
          // to(x y z), to(name), or to(name dx dy dz) — the usual
          // destination grammar, camera edition
          if (args.length >= 1 && num(args[0]) === null) {
            const off = args.length > 1 ? nums(args.slice(1), 3) : [0, 0, 0];
            if (!off) return err("camera to(name dx dy dz): expected 3 numbers after the name");
            seg.to = { ref: args[0], off };
            break;
          }
          const v = nums(args, 3);
          if (!v) return err("camera to(): expected 3 numbers, or a name with an optional dx dy dz");
          seg.to = v;
          break;
        }
        case "from": {
          if (args.length !== 1 || num(args[0]) !== null) return err("camera from(): expected one object name");
          seg.from = { ref: args[0] };
          break;
        }
        case "look": {
          if (args.length === 1 && COMPASS_DIRS[args[0]]) { seg.look = { dir: COMPASS_DIRS[args[0]] }; break; }
          if (args.length === 1 && num(args[0]) === null) { seg.look = { ref: args[0] }; break; }
          const v = nums(args, 3);
          if (!v) return err("camera look(): expected a name, north/south/east/west, or 3 numbers");
          seg.look = { at: v };
          break;
        }
        case "start": {
          const v = timeArg(args, "start");
          if (Number.isNaN(v)) return;
          if (v === null || v < 0) return err("start(): expected a time >= 0 (or 5:15 with a clock)");
          seg.start = v;
          break;
        }
        case "after": case "over": {
          if (args.length === 1 && /:/.test(args[0])) {
            return err(`${key}(): takes a duration, not a clock time — use ${key}(2m) or seconds`);
          }
          const v = timeArg(args, key);
          if (Number.isNaN(v)) return;
          if (v === null || v < 0) return err(`${key}(): expected a non-negative duration`);
          seg[key] = v;
          break;
        }
        case "ease": {
          if (args.length !== 1 || !(args[0] in EASES)) return err(`ease(): one of ${Object.keys(EASES).join(", ")}`);
          seg.ease = args[0];
          break;
        }
        default:
          return err(`${key}(): unknown property for camera`);
      }
    }
    if (seg.to && seg.from) return err("camera: to() or from(), not both — a dolly or a mount");
    if (!seg.to && !seg.from && !seg.look) return err("camera needs to(), from(), or look()");
    if (blockAt != null && seg.start === null && seg.after === null) {
      if (blockAt.then !== undefined) seg.thenBlock = blockAt.then;
      else seg.start = blockAt.t0;
    }
    cameras.push(seg);
  }

  // Parses the body of `? ...` queries and `check ...` assertions — the
  // same grammar: [quant] fn(args) [at(t) | during(t1 t2)].
  function parseQuery(body, lineNo, queries, errors, timeCtx, isCheck, blockAt) {
    const err = (msg) => errors.push({ line: lineNo, msg });
    const m = body
      .trim()
      .match(/^(?:(ever|always|when|never)\s+)?([A-Za-z_][\w-]*)\(([^)]*)\)\s*(.*)$/);
    if (!m) {
      return err(
        isCheck
          ? "expected: check ever|always|never name(a b), or check name(a b) at(time)"
          : "bad query — expected: ? name(a b) or ? ever name(a b)",
      );
    }
    let [, quant, fn, rawArgs, trailing] = m; // quant may be defaulted by a range block
    if (!QUERIES.has(fn)) {
      return err(`unknown query "${fn}" (available: ${[...QUERIES].join(", ")})`);
    }

    let at = null;
    let during = null;
    let except = null;
    let thenBlock = null;
    let r = trailing;
    while (r.length) {
      const pm = r.match(/^([A-Za-z_][\w-]*)\(([^)]*)\)\s*/);
      if (!pm) return err(`can't read "${r}" — properties look like name(args)`);
      const key = pm[1];
      const args = splitArgs(pm[2]);
      r = r.slice(pm[0].length);
      const time = (tok) => {
        const w = wallTime(tok, timeCtx, (msg) => err(`${key}(): ${msg}`));
        if (Number.isNaN(w)) return NaN;
        return w !== null ? w : num(tok);
      };
      if (key === "at") {
        if (args.length !== 1) return err("at(): expected one time");
        const t = time(args[0]);
        if (Number.isNaN(t)) return;
        if (t === null || t < 0) return err("at(): expected a time >= 0 (or 2:30 with a clock)");
        at = t;
      } else if (key === "during") {
        if (args.length !== 2) return err("during(): expected two times: during(start end)");
        const t0 = time(args[0]);
        const t1 = time(args[1]);
        if (Number.isNaN(t0) || Number.isNaN(t1)) return;
        if (t0 === null || t1 === null || t0 < 0 || t1 <= t0) {
          return err("during(): expected two increasing times");
        }
        during = [t0, t1];
      } else if (key === "except") {
        if (!args.length || args.some((x) => num(x) !== null)) {
          return err("except(): expected object names to leave out of a set");
        }
        except = args;
      } else {
        return err(`${key}(): queries take at(time), during(start end) or except(names)`);
      }
    }

    // inside an at block: fill the block's time where the query stated
    // no time scope of its own (adjacent has no time at all).
    // Instant block: fills at(); a quantifier IS a time scope, so ever/
    // always/when keep their own timeline (never combines, as instant
    // negation). Range block: fills during(); a BARE boolean reads as a
    // duration fact — "held throughout" — so it defaults to always.
    if (blockAt != null && blockAt.then !== undefined) {
      // a then block is an instant known only after chaining resolves —
      // mark now, fill in compile (same rule as an instant at-block:
      // bare/never queries get at(anchor); a quantifier keeps its own
      // timeline)
      if (fn !== "adjacent" && at === null && during === null && (!quant || quant === "never")) {
        thenBlock = blockAt.then;
      }
    } else if (blockAt != null && fn !== "adjacent" && at === null && during === null) {
      if (blockAt.t1 === null) {
        if (!quant || quant === "never") at = blockAt.t0;
      } else if (quant) {
        during = [blockAt.t0, blockAt.t1];
      } else if (BOOLEAN_QUERIES.has(fn)) {
        quant = "always";
        during = [blockAt.t0, blockAt.t1];
      } else {
        return err(`inside an at-range block, ${fn}() needs its own at(time)`);
      }
    }

    if (fn === "adjacent") {
      // a fact about the floor plan: it doesn't change, so time words
      // don't apply — and it's checkable bare
      if (quant) return err("adjacent() is a fact about the floor plan — it takes no quantifier");
      if (at !== null || during) return err("adjacent() doesn't change over time — drop at()/during()");
      if (except) return err("except() needs a set argument");
      queries.push({
        line: lineNo, fn, quant: null, args: splitArgs(rawArgs),
        at: null, during: null, except: null, check: !!isCheck,
      });
      return;
    }
    if (quant && !BOOLEAN_QUERIES.has(fn)) {
      return err(`${quant} works with the true/false queries — ${[...BOOLEAN_QUERIES].join(", ")}`);
    }
    if (quant && at !== null && quant !== "never") {
      return err(
        "use a quantifier or at(time), not both — except never, which asserts the opposite at that instant",
      );
    }
    if (during && !quant) return err("during() needs ever, always, never or when");
    if (isCheck) {
      if (quant === "when") {
        return err("check needs a true/false answer — ever, always, never, or at(time)");
      }
      if (!quant && at === null && thenBlock === null) return err("check needs ever/always/never, or at(time)");
      if (at !== null && !BOOLEAN_QUERIES.has(fn)) {
        return err(`check needs a true/false query — ${[...BOOLEAN_QUERIES].join(", ")}`);
      }
    }
    queries.push({
      line: lineNo, fn, quant: quant || null, args: splitArgs(rawArgs),
      at, during, except, thenBlock, check: !!isCheck,
    });
  }

  function parseStatement(line, lineNo, objects, errors, ctx) {
    const err = (msg) => errors.push({ line: lineNo, msg });

    const stmt = line.match(/^([A-Za-z_][\w-]*)\s+([A-Za-z_][\w-]*)\s*(.*)$/);
    if (!stmt) {
      err("expected: <shape> <name> <properties...>");
      return;
    }
    const [, shape, name, rest] = stmt;

    const partDef = ctx && ctx.parts && ctx.parts.get(shape);
    if (!SHAPES.has(shape) && shape !== "group" && shape !== "room" && shape !== "tube" && shape !== "person" && shape !== "animal" && shape !== "link" && !partDef) {
      if (ctx && ctx.nestedFrom && ctx.nestedFrom.has(shape)) {
        err(`parts can't use other parts (yet) — "${shape}" must be spelled out here`);
        return;
      }
      const known = [...SHAPES].join(", ") + ", group, room, tube, person, animal";
      const partNames = ctx && ctx.parts && ctx.parts.size ? ", " + [...ctx.parts.keys()].join(", ") : "";
      err(`unknown shape "${shape}" (available: ${known}${partNames})`);
      return;
    }
    if (objects.has(name)) {
      err(`"${name}" is already defined on line ${objects.get(name).line}`);
      return;
    }

    // Pull off property calls one at a time: key(args) key(args) ...
    // A bare word is a FLAG property (glass) — args: [], and unknown
    // flags still error in applyProp, so typos can't hide as flags.
    const props = [];
    let r = rest;
    while (r.length) {
      const m = r.match(/^([A-Za-z_][\w-]*)\(([^)]*)\)\s*/);
      if (m) {
        props.push({ key: m[1], args: splitArgs(m[2]) });
        r = r.slice(m[0].length);
        continue;
      }
      const f = r.match(/^([A-Za-z_][\w-]*)\s*/);
      if (!f) {
        err(`can't read "${r}" — properties look like name(args)`);
        return;
      }
      props.push({ key: f[1], args: [] });
      r = r.slice(f[0].length);
    }

    const timeCtx = ctx && ctx.timeCtx;
    if (shape === "room") {
      makeRoom(name, props, lineNo, objects, err, timeCtx);
      return;
    }
    if (shape === "tube") {
      makeTube(name, props, lineNo, objects, err, timeCtx);
      return;
    }
    if (shape === "person") {
      makePerson(name, props, lineNo, objects, err, timeCtx);
      return;
    }
    if (shape === "animal") {
      makeAnimal(name, props, lineNo, objects, err, timeCtx);
      return;
    }
    if (partDef) {
      makeInstance(partDef, name, props, lineNo, objects, ctx.anims, errors, ctx.parts, timeCtx);
      return;
    }

    const obj = {
      name, shape, line: lineNo,
      size: shape === "box" ? [1, 1, 1] : null,
      r: shape === "box" ? null : shape === "link" ? 0.05 : 0.5,
      h: shape === "cylinder" ? 1 : null,
      sides: null, // cylinder only: faceted prism instead of smooth
      at: null, rel: null,
      rot: [0, 0, 0],
      color: null,
      appear: 0, vanish: null, // lifetime window [appear, vanish)
      parent: null, // group membership via in(name)
      repeat: null, spread: null, jitter: null, seed: null, stagger: null,
      between: null, // link only: the two endpoints it spans
      heldBy: null, // possession via held-by(holder): pose derives from the holder
    };

    for (const p of props) {
      if (!applyProp(obj, p, err, timeCtx)) return;
    }

    if (obj.at && obj.rel) {
      err(`"${name}": use at() or a placement relation, not both`);
      return;
    }
    if (obj.vanish !== null && obj.vanish <= obj.appear) {
      err(`"${name}": vanish(${obj.vanish}) must come after appear(${obj.appear})`);
      return;
    }
    if (!obj.repeat && (obj.spread || obj.jitter || obj.stagger !== null)) {
      err(`"${name}": spread/jitter/stagger only make sense with repeat(n)`);
      return;
    }
    if (obj.shape === "link" && !obj.between) {
      err(`"${name}": a link needs between(a b) — the two things it spans`);
      return;
    }
    if (obj.heldBy && (obj.at || obj.rel || obj.parent || (obj.rot[0] || obj.rot[1] || obj.rot[2]) || obj.shift)) {
      err(`"${name}": held-by() derives position and rotation from the holder — drop at/relations/in/rotate/shift`);
      return;
    }

    objects.set(name, obj);
  }

  // ------------------------------------------------------------------ parts
  //
  // A part teaches the language a new noun: "a desk consists of ..." — a
  // fixed arrangement of facts (objects and animations), defined once with
  // `part <name> ... end` and used exactly like a shape. No parameters, no
  // arithmetic, no conditionals — that is a hard line; the sanctioned knob
  // is uniform per-instance scale(), which is BAKED here at parse time
  // (positions, sizes, gaps, movement vectors all multiply by s), so the
  // core never learns about scaling and instances are ordinary groups.
  // Bodies are self-contained: referencing a name from outside is an error.

  function makeInstance(def, instName, props, lineNo, objects, anims, errors, allParts, timeCtx) {
    const err = (msg) => errors.push({ line: lineNo, msg });
    const group = {
      name: instName, shape: "group", line: lineNo,
      size: null, r: null, h: null, sides: null,
      at: null, rel: null, rot: [0, 0, 0], color: null,
      appear: 0, vanish: null, parent: null,
      repeat: null, spread: null, jitter: null, seed: null, stagger: null,
    };
    let s = 1;
    let tint = null; // instance color() fills members that don't set their own

    for (const p of props) {
      if (p.key === "scale") {
        const v = nums(p.args, 1);
        if (!v || v[0] <= 0) return err("scale(): expected one positive number");
        s = v[0];
      } else if (p.key === "color") {
        if (p.args.length !== 1) return err("color(): expected one color name or #hex");
        tint = p.args[0];
      } else if (!applyProp(group, p, err, timeCtx)) {
        return;
      }
    }
    if (group.at && group.rel) {
      return err(`"${instName}": use at() or a placement relation, not both`);
    }
    if (group.vanish !== null && group.vanish <= group.appear) {
      return err(`"${instName}": vanish(${group.vanish}) must come after appear(${group.appear})`);
    }

    // parse the body fresh for this instance, into its own namespace
    const body = new Map();
    const bodyAnims = [];
    for (const b of def.body) {
      if (b.line.startsWith("?")) {
        errors.push({ line: b.lineNo, msg: "queries don't belong inside a part" });
      } else if (/^theme\b/.test(b.line)) {
        errors.push({ line: b.lineNo, msg: "theme doesn't belong inside a part" });
      } else if (/^(move|turn|orbit|walk|paint)\b/.test(b.line)) {
        parseAnim(b.line, b.lineNo, bodyAnims, errors, timeCtx);
      } else {
        parseStatement(b.line, b.lineNo, body, errors, { nestedFrom: allParts, timeCtx });
      }
    }

    // bake scale: the core never sees s, only scaled facts
    if (s !== 1) {
      for (const o of body.values()) {
        if (o.at) {
          o.at = o.at.ref
            ? { ...o.at, dx: o.at.dx * s, dz: o.at.dz * s }
            : o.at.map((v) => v * s);
        }
        if (o.heldBy) o.heldBy = { ...o.heldBy, off: o.heldBy.off.map((v) => v * s) };
        if (o.person) o.person = { ...o.person, h: o.person.h * s };
        if (o.animal) o.animal = { ...o.animal, h: o.animal.h * s };
        if (o.size) o.size = o.size.map((v) => v * s);
        if (o.r !== null) o.r *= s;
        if (o.h !== null) o.h *= s;
        if (o.rel) {
          const target = body.get(o.rel.target);
          const gap = o.rel.gap !== null
            ? o.rel.gap
            : o.room && target && target.room ? 0 : DEFAULT_GAP[o.rel.kind];
          o.rel = { ...o.rel, gap: gap * s };
        }
        if (o.spread) o.spread = o.spread.map((v) => v * s);
        if (o.shift) o.shift = o.shift.map((v) => v * s);
        if (o.jitter) o.jitter = o.jitter.map((v) => v * s);
        if (o.room) {
          o.room = {
            ...o.room,
            size: o.room.size.map((v) => v * s),
            thick: o.room.thick * s,
            doors: Object.fromEntries(
              Object.entries(o.room.doors).map(([k, ds]) => [
                k, ds.map((d) => ({ width: d.width * s, offset: d.offset * s })),
              ]),
            ),
            windows: Object.fromEntries(
              Object.entries(o.room.windows).map(([k, ws]) => [
                k, ws.map((w) => ({ width: w.width * s, height: w.height * s, sill: w.sill * s, offset: w.offset * s })),
              ]),
            ),
            autos: o.room.autos.map((a) => ({
              ...a, width: a.width * s,
              ...(a.kind === "window" ? { height: a.height * s, sill: a.sill * s } : {}),
            })),
          };
        }
        if (o.tube) {
          o.tube = { ...o.tube, r: o.tube.r * s, h: o.tube.h * s, thick: o.tube.thick * s };
        }
      }
      for (const a of bodyAnims) {
        if (a.kind === "turn") continue; // degrees don't scale
        if (a.from) a.from = a.from.map((v) => v * s);
        if (a.kind === "move" || a.kind === "walk") {
          if (a.to && !a.to.ref) a.to = a.to.map((v) => v * s);
          if (a.to && a.to.off) a.to.off = a.to.off.map((v) => v * s);
          if (a.by) a.by = a.by.map((v) => v * s);
        } else if (a.kind === "orbit" && a.around && !a.around.ref) {
          a.around = a.around.map((v) => v * s); // by() is degrees: unscaled
        }
      }
    }

    // transfer into the scene: prefix names, remap internal references
    const mapping = new Map([...body.keys()].map((n) => [n, instName + "-" + n]));
    for (const nm of mapping.values()) {
      if (objects.has(nm)) {
        return err(
          `${def.name} "${instName}" creates "${nm}", but that name is taken (line ${objects.get(nm).line})`,
        );
      }
    }
    // validate self-containment fully before transferring anything
    let ok = true;
    const contained = (b, what, ref) => {
      if (mapping.has(ref)) return true;
      errors.push({
        line: b.line,
        msg: `part "${def.name}" is self-contained — ${what}("${ref}") must name something defined in the part`,
      });
      ok = false;
      return false;
    };
    for (const o of body.values()) {
      if (o.parent) contained(o, "in", o.parent);
      if (o.rel) contained(o, o.rel.kind, o.rel.target);
      if (o.rel && o.rel.target2) contained(o, o.rel.kind, o.rel.target2);
      if (o.at && o.at.ref) contained(o, "at", o.at.ref);
      if (o.heldBy) contained(o, "held-by", o.heldBy.ref);
      if (o.between) for (const en of o.between) contained(o, "between", en);
      if (o.room) for (const a of o.room.autos) contained(o, "door(to ", a.target);
    }
    for (const a of bodyAnims) {
      contained(a, a.kind, a.target);
      const ref = (a.to && a.to.ref) || (a.around && a.around.ref);
      if (ref) contained(a, "to/around", ref);
    }
    if (!ok) return;

    for (const o of body.values()) {
      objects.set(mapping.get(o.name), {
        ...o,
        name: mapping.get(o.name),
        parent: o.parent ? mapping.get(o.parent) : instName,
        at: o.at && o.at.ref ? { ...o.at, ref: mapping.get(o.at.ref) } : o.at,
        heldBy: o.heldBy ? { ...o.heldBy, ref: mapping.get(o.heldBy.ref) } : null,
        rel: o.rel
          ? {
              ...o.rel,
              target: mapping.get(o.rel.target),
              target2: o.rel.target2 ? mapping.get(o.rel.target2) : null,
            }
          : null,
        between: o.between ? o.between.map((en) => mapping.get(en)) : null,
        room: o.room
          ? { ...o.room, autos: o.room.autos.map((a) => ({ ...a, target: mapping.get(a.target) })) }
          : undefined,
        color: o.color === null ? tint : o.color,
        family: def.name + "/" + (o.family || o.name), // instances share palette slots
      });
    }
    for (const a of bodyAnims) {
      const c = { ...a, target: mapping.get(a.target) };
      if (a.to && a.to.ref) c.to = { ...a.to, ref: mapping.get(a.to.ref) };
      if (a.around && a.around.ref) c.around = { ref: mapping.get(a.around.ref) };
      anims.push(c);
    }
    objects.set(instName, group);
  }

  // ------------------------------------------------------------------ rooms
  //
  // `room` is pure syntactic sugar: it desugars, at parse time, into the
  // group-of-wall-boxes you would have written by hand. Nothing downstream
  // learns anything new — walls block sight lines because they are boxes,
  // doorways let them through because they are real gaps, and the room is a
  // group (query endpoint, never a blocker; relation target from outside).
  // size() is the INTERIOR; walls extrude outward. No floor, no ceiling —
  // the ground is the floor and the camera looks in from above.

  function makeRoom(name, props, lineNo, objects, err, timeCtx) {
    const group = {
      name, shape: "group", line: lineNo,
      size: null, r: null, h: null, sides: null,
      at: null, rel: null, rot: [0, 0, 0], color: null,
      appear: 0, vanish: null, parent: null,
    };
    let size = [4, 2.5, 4];
    let thick = 0.2;
    let glass = false;
    let floor = false;
    let color = "#5b6575";
    const doors = { north: [], south: [], east: [], west: [] };
    const windows = { north: [], south: [], east: [], west: [] };
    const autos = []; // door(to)/window(to): carved after positions resolve

    for (const p of props) {
      switch (p.key) {
        case "size": {
          const v = nums(p.args, 3);
          if (!v || v.some((n) => n <= 0)) {
            return err("size(): expected 3 positive numbers — the interior w h d");
          }
          size = v;
          break;
        }
        case "glass": {
          // a display case, a greenhouse: the walls are real (bounds,
          // touch, containment) but sight passes through
          if (p.args.length) return err("glass is a flag — no arguments");
          glass = true;
          break;
        }
        case "floor": {
          // a boat hull, a storey slab: rooms are floorless by the
          // dollhouse convention, but sometimes the bottom is real —
          // it takes the room's color, blocks sight from below, and
          // gives on() a surface
          if (p.args.length) return err("floor is a flag — no arguments");
          floor = true;
          break;
        }
        case "walls": {
          // walls(0) = an OPEN room: no shells, just a ground pad — a
          // yard, a field, a plaza. Query bounds come from the declared
          // interior instead of the (absent) wall union.
          const v = nums(p.args, 1);
          if (!v || v[0] < 0) return err("walls(): expected one number (thickness; 0 = open, no walls)");
          thick = v[0];
          break;
        }
        case "color": {
          if (p.args.length !== 1) return err("color(): expected one color name or #hex");
          color = p.args[0];
          break;
        }
        case "door": {
          const [side, ...rest] = p.args;
          if (side === "to") {
            // door(to <room> <width?>): a shared, auto-aligned opening —
            // declared once, carved into BOTH rooms after positions resolve
            const target = rest[0];
            const width = rest.length > 1 ? num(rest[1]) : 1;
            if (!target || num(target) !== null || rest.length > 2 || width === null || width <= 0) {
              return err("door(): expected door(to <room>) or door(to <room> <width>)");
            }
            autos.push({ kind: "door", target, width, line: lineNo });
            break;
          }
          if (!(side in doors)) {
            return err("door(): first argument is a side (north, south, east, west) or `to`");
          }
          const width = rest.length > 0 ? num(rest[0]) : 1;
          const offset = rest.length > 1 ? num(rest[1]) : 0;
          if (rest.length > 2 || width === null || width <= 0 || offset === null) {
            return err("door(): expected door(side width? offset?)");
          }
          doors[side].push({ width, offset });
          break;
        }
        case "window": {
          // a WINDOW is a y-band opening: wall below (sill) and above
          // (lintel) stay; sight, air — and snakes — pass through.
          // window(side w? h? sill? offset?) or window(to <room> w? h? sill?)
          const [side, ...rest] = p.args;
          if (side === "to") {
            const target = rest[0];
            const w = rest.length > 1 ? num(rest[1]) : 0.8;
            const wh = rest.length > 2 ? num(rest[2]) : 0.8;
            const sill = rest.length > 3 ? num(rest[3]) : 1;
            if (!target || num(target) !== null || rest.length > 4 ||
                w === null || w <= 0 || wh === null || wh <= 0 || sill === null || sill < 0) {
              return err("window(): expected window(to <room> width? height? sill?)");
            }
            autos.push({ kind: "window", target, width: w, height: wh, sill, line: lineNo });
            break;
          }
          if (!(side in windows)) {
            return err("window(): first argument is a side (north, south, east, west) or `to`");
          }
          const w = rest.length > 0 ? num(rest[0]) : 0.8;
          const wh = rest.length > 1 ? num(rest[1]) : 0.8;
          const sill = rest.length > 2 ? num(rest[2]) : 1;
          const offset = rest.length > 3 ? num(rest[3]) : 0;
          if (rest.length > 4 || w === null || w <= 0 || wh === null || wh <= 0 ||
              sill === null || sill < 0 || offset === null) {
            return err("window(): expected window(side width? height? sill? offset?)");
          }
          windows[side].push({ width: w, height: wh, sill, offset });
          break;
        }
        default:
          // at/rotate/in/appear/vanish/relations behave exactly as on a group
          if (!applyProp(group, p, err, timeCtx)) return;
      }
    }

    if (group.at && group.rel) {
      return err(`"${name}": use at() or a placement relation, not both`);
    }
    if (group.vanish !== null && group.vanish <= group.appear) {
      return err(`"${name}": vanish(${group.vanish}) must come after appear(${group.appear})`);
    }
    // vertical fit is checked here, after the loop — size() may come
    // later in the property list than window() (order-free properties)
    for (const side of Object.keys(windows)) {
      for (const wd of windows[side]) {
        if (wd.sill + wd.height >= size[1] - 1e-9) {
          return err(`window(): sill ${wd.sill} + height ${wd.height} doesn't fit a ${size[1]}-high wall`);
        }
      }
    }
    for (const a of autos) {
      if (a.kind === "window" && a.sill + a.height >= size[1] - 1e-9) {
        return err(`window(to): sill ${a.sill} + height ${a.height} doesn't fit a ${size[1]}-high wall`);
      }
    }

    // All door carving happens after resolution (carveDoors): door(to)
    // needs resolved positions, and a counterpart opening may be carved
    // into a room that declared no doors of its own — so rooms always
    // emit whole walls here and get their doorways cut in one pass later.
    const members = [];
    if (thick === 0) {
      // open room: a flat pad instead of walls; doors/windows have no
      // wall to live in
      if (floor) return err(`"${name}" is an open room (walls(0)) — it already IS its floor (the ground pad)`);
      if (autos.length || Object.values(doors).some((d) => d.length) || Object.values(windows).some((w) => w.length)) {
        return err(`"${name}" is an open room (walls(0)) — there are no walls for doors or windows (declare the doorway from the walled neighbour instead: door(to ${name}) carves its wall and declares adjacency)`);
      }
      members.push({
        name: `${name}-ground`, shape: "box", line: lineNo,
        size: [size[0], 0.04, size[2]],
        r: null, h: null, sides: null,
        at: [0, 0.02, 0], rel: null, rot: [0, 0, 0], color,
        appear: group.appear, vanish: group.vanish, parent: name,
      });
    } else {
      for (const wl of roomWalls(size, thick)) {
        members.push(
          ...wallBoxes(name, wl, [{ lo: -wl.span / 2, hi: wl.span / 2, win: null }], size[1], thick, color, lineNo, group),
        );
      }
      if (floor) {
        // the open-room ground pad, granted to a walled room: fits the
        // interior, between the walls. Slightly THICKER than a zone pad
        // (0.06 vs 0.04) so a floored room standing in — or crossing —
        // an open zone keeps its top face off the pad's plane: coplanar
        // faces z-fight, and a boat's hull flickering with the river
        // under it looks like a bug in the world
        members.push({
          name: `${name}-floor`, shape: "box", line: lineNo,
          size: [size[0], 0.06, size[2]],
          r: null, h: null, sides: null,
          at: [0, 0.03, 0], rel: null, rot: [0, 0, 0], color,
          appear: group.appear, vanish: group.vanish, parent: name,
        });
      }
    }

    for (const m of members) {
      if (objects.has(m.name)) {
        return err(
          `room "${name}" creates a wall named "${m.name}", but that name is taken (line ${objects.get(m.name).line})`,
        );
      }
    }
    if (glass) for (const m of members) m.glass = true;
    group.room = { size, thick, color, glass, floor, doors, windows, autos };
    objects.set(name, group);
    for (const m of members) objects.set(m.name, m);
  }

  // the four walls of an interior w×h×d with thickness t, in local coords:
  // north/south span the corners; east/west fit exactly between them
  function roomWalls(size, thick) {
    const [w, , d] = size;
    return [
      { side: "north", along: "x", span: w + 2 * thick, x: 0, z: -(d + thick) / 2 },
      { side: "south", along: "x", span: w + 2 * thick, x: 0, z: (d + thick) / 2 },
      { side: "east", along: "z", span: d, x: (w + thick) / 2, z: 0 },
      { side: "west", along: "z", span: d, x: -(w + thick) / 2, z: 0 },
    ];
  }

  // A wall with openings becomes segments. A door is the ABSENCE of
  // wall; a window keeps wall below (sill) and above (lintel) — a
  // y-band opening that sight and small things pass through.
  // Openings: { width, offset } for doors, plus window: {height, sill}.
  // Returns spans: { lo, hi, win: null | {height, sill} }.
  function wallSegments(span, ds, side, err) {
    if (!ds.length) return [{ lo: -span / 2, hi: span / 2, win: null }];
    const sorted = ds.slice().sort((a, b) => a.offset - b.offset);
    const segs = [];
    let cursor = -span / 2;
    for (const op of sorted) {
      const what = op.window ? "window" : "door";
      const lo = op.offset - op.width / 2;
      const hi = op.offset + op.width / 2;
      if (lo < -span / 2 - 1e-9 || hi > span / 2 + 1e-9) {
        err(`${what}(): the ${side} ${what} (width ${op.width}, offset ${op.offset}) doesn't fit — that wall runs ${span} across`);
        return null;
      }
      if (lo < cursor - 1e-9) {
        err(
          `openings overlap on the ${side} wall — each door and window needs its own stretch (offset defaults to 0, centered)`,
        );
        return null;
      }
      if (lo - cursor > 1e-6) segs.push({ lo: cursor, hi: lo, win: null });
      if (op.window) segs.push({ lo, hi, win: op.window });
      cursor = hi;
    }
    if (span / 2 - cursor > 1e-6) segs.push({ lo: cursor, hi: span / 2, win: null });
    return segs;
  }

  function wallBoxes(roomName, wl, segs, h, thick, color, lineNo, group) {
    const boxes = [];
    const plainTotal = segs.filter((s) => !s.win).length;
    const winTotal = segs.filter((s) => s.win).length;
    let pi = 0;
    let wi = 0;
    const mk = (nm, len, mid, y, hh) => ({
      name: nm, shape: "box", line: lineNo,
      size: wl.along === "x" ? [len, hh, thick] : [thick, hh, len],
      r: null, h: null, sides: null,
      at: wl.along === "x" ? [mid, y, wl.z] : [wl.x, y, mid],
      rel: null, rot: [0, 0, 0], color,
      appear: group ? group.appear : 0, vanish: group ? group.vanish : null,
      parent: roomName,
    });
    for (const s of segs) {
      const len = s.hi - s.lo;
      const mid = (s.lo + s.hi) / 2;
      if (!s.win) {
        pi++;
        boxes.push(mk(`${roomName}-${wl.side}${plainTotal === 1 ? "" : "-" + pi}`, len, mid, h / 2, h));
      } else {
        wi++;
        const sfx = winTotal === 1 ? "" : "-" + wi;
        const below = s.win.sill;
        const above = h - s.win.sill - s.win.height;
        if (below > 1e-9) boxes.push(mk(`${roomName}-${wl.side}-sill${sfx}`, len, mid, below / 2, below));
        if (above > 1e-9) {
          boxes.push(mk(`${roomName}-${wl.side}-lintel${sfx}`, len, mid, s.win.sill + s.win.height + above / 2, above));
        }
      }
    }
    return boxes;
  }

  // ------------------------------------------------------------------ tubes
  //
  // `tube` is the room recipe bent into a circle: a hollow cylinder — a
  // well, a pipe, a chimney, a rabbit hole — desugared at parse time into
  // a group of thin wall boxes standing in a faceted ring. Like a room,
  // the hollowness is a FACT, not a look: segments block sight lines
  // individually, the bore between them is genuinely open (you can see
  // down a tube but not through it), and nothing downstream learns
  // anything new. r() is the BORE radius; walls() extrude outward; the
  // base sits at the group's origin, so a bare tube stands on the ground
  // and at() places its base (the room convention — structure rests
  // where you put it, it doesn't center-sink).

  function makeTube(name, props, lineNo, objects, err, timeCtx) {
    const group = {
      name, shape: "group", line: lineNo,
      size: null, r: null, h: null, sides: null,
      at: null, rel: null, rot: [0, 0, 0], color: null,
      appear: 0, vanish: null, parent: null,
    };
    let r = 0.5;
    let h = 1;
    let thick = 0.05;
    let sides = 8;
    let glass = false;
    let color = null;

    for (const p of props) {
      switch (p.key) {
        case "r": {
          const v = nums(p.args, 1);
          if (!v || v[0] <= 0) return err("r(): expected one positive number — the bore radius");
          r = v[0];
          break;
        }
        case "h": {
          const v = nums(p.args, 1);
          if (!v || v[0] <= 0) return err("h(): expected one positive number");
          h = v[0];
          break;
        }
        case "glass": {
          if (p.args.length) return err("glass is a flag — no arguments");
          glass = true;
          break;
        }
        case "walls": {
          const v = nums(p.args, 1);
          if (!v || v[0] <= 0) return err("walls(): expected one positive number — a tube IS its wall");
          thick = v[0];
          break;
        }
        case "sides": {
          const v = nums(p.args, 1);
          if (!v || !Number.isInteger(v[0]) || v[0] < 3 || v[0] > 64) {
            return err("sides(): expected a whole number from 3 to 64");
          }
          sides = v[0];
          break;
        }
        case "color": {
          if (p.args.length !== 1) return err("color(): expected one color name or #hex");
          color = p.args[0];
          break;
        }
        default:
          // at/rotate/in/appear/vanish/relations/repeat behave as on a group
          if (!applyProp(group, p, err, timeCtx)) return;
      }
    }

    if (group.at && group.rel) {
      return err(`"${name}": use at() or a placement relation, not both`);
    }
    if (group.vanish !== null && group.vanish <= group.appear) {
      return err(`"${name}": vanish(${group.vanish}) must come after appear(${group.appear})`);
    }

    // segment centers ring the mid-wall radius; width = the flat side of
    // that polygon, so neighbours meet mid-wall (inner edges overlap a
    // hair, outer edges gap a hair — the wall stays radially solid)
    const R = r + thick / 2;
    const w = 2 * R * Math.tan(Math.PI / sides);
    const members = [];
    for (let k = 0; k < sides; k++) {
      const a = (k * 2 * Math.PI) / sides;
      members.push({
        name: `${name}-seg-${k + 1}`, shape: "box", line: lineNo,
        size: [w, h, thick], r: null, h: null, sides: null,
        at: [R * Math.sin(a), h / 2, R * Math.cos(a)],
        rel: null, rot: [0, (k * 360) / sides, 0], color,
        appear: group.appear, vanish: group.vanish, parent: name,
        family: `${name}/seg`, // one palette slot; "/" keeps it out of implicit sets
        glass: glass || undefined,
      });
    }
    for (const m of members) {
      if (objects.has(m.name)) {
        return err(
          `tube "${name}" creates a segment named "${m.name}", but that name is taken (line ${objects.get(m.name).line})`,
        );
      }
    }
    group.tube = { r, h, thick, sides, color, glass };
    objects.set(name, group);
    for (const m of members) objects.set(m.name, m);
  }

  // person <name> h()? color()? — the most common object in a mystery,
  // as a noun: a body cylinder with a head sphere at honest human
  // proportions (the units convention's "people ≈ 1.7" made flesh).
  // Base-anchored like a room: bare = standing on the ground, at()
  // places the feet. Facts speak the person's NAME, not their parts —
  // members are excluded from whereabouts, the group is the mover.

  function makePerson(name, props, lineNo, objects, err, timeCtx) {
    const group = {
      name, shape: "group", line: lineNo,
      size: null, r: null, h: null, sides: null,
      at: null, rel: null, rot: [0, 0, 0], color: null,
      appear: 0, vanish: null, parent: null,
    };
    group.person = {}; // early: held-by()'s group guard excepts persons
    let h = 1.7;
    let color = null;

    for (const p of props) {
      switch (p.key) {
        case "h": {
          const v = nums(p.args, 1);
          if (!v || v[0] <= 0) return err("h(): expected one positive number — total height");
          h = v[0];
          break;
        }
        case "color": {
          if (p.args.length !== 1) return err("color(): expected one color name or #hex");
          color = p.args[0];
          break;
        }
        default:
          if (!applyProp(group, p, err, timeCtx)) return;
      }
    }

    if (group.at && group.rel) {
      return err(`"${name}": use at() or a placement relation, not both`);
    }
    if (group.heldBy && (group.at || group.rel || group.rot[0] || group.rot[1] || group.rot[2])) {
      return err(`"${name}": held-by() derives position and rotation from the holder — drop at/relations/rotate`);
    }
    if (group.vanish !== null && group.vanish <= group.appear) {
      return err(`"${name}": vanish(${group.vanish}) must come after appear(${group.appear})`);
    }

    // proportions from total height: head is ~22% of height in diameter,
    // the body cylinder fills the rest, the head sphere sits on top
    const headR = 0.11 * h;
    const bodyH = h - 2 * headR;
    const bodyR = 0.15 * h;
    const members = [
      {
        name: `${name}-body`, shape: "cylinder", line: lineNo,
        size: null, r: bodyR, h: bodyH, sides: null,
        at: [0, bodyH / 2, 0], rel: null, rot: [0, 0, 0], color,
        appear: group.appear, vanish: group.vanish, parent: name,
        family: `${name}/person`, // one palette slot; "/" keeps it out of implicit sets
      },
      {
        name: `${name}-head`, shape: "sphere", line: lineNo,
        size: null, r: headR, h: null, sides: null,
        at: [0, bodyH + headR, 0], rel: null, rot: [0, 0, 0], color,
        appear: group.appear, vanish: group.vanish, parent: name,
        family: `${name}/person`,
      },
    ];
    for (const m of members) {
      if (objects.has(m.name)) {
        return err(
          `person "${name}" creates a part named "${m.name}", but that name is taken (line ${objects.get(m.name).line})`,
        );
      }
    }
    group.person = { h, color };
    objects.set(name, group);
    for (const m of members) objects.set(m.name, m);
  }

  // animal <name> h()? color()? — the quadruped sibling of person: a
  // horizontal body, a head at the front (-z, the person-front
  // convention), four legs so the silhouette reads at a glance. h() is
  // SHOULDER height; everything scales from it — h(0.15) is a rat,
  // h(0.5) a fox, h(0.7) a goat. Facts speak the animal's name, and —
  // unlike plain groups — animals (and persons) can be carried.
  function makeAnimal(name, props, lineNo, objects, err, timeCtx) {
    const group = {
      name, shape: "group", line: lineNo,
      size: null, r: null, h: null, sides: null,
      at: null, rel: null, rot: [0, 0, 0], color: null,
      appear: 0, vanish: null, parent: null,
    };
    group.animal = {}; // early: held-by()'s group guard excepts animals
    let h = 0.6;
    let color = null;

    for (const p of props) {
      switch (p.key) {
        case "h": {
          const v = nums(p.args, 1);
          if (!v || v[0] <= 0) return err("h(): expected one positive number — shoulder height");
          h = v[0];
          break;
        }
        case "color": {
          if (p.args.length !== 1) return err("color(): expected one color name or #hex");
          color = p.args[0];
          break;
        }
        default:
          if (!applyProp(group, p, err, timeCtx)) return;
      }
    }

    if (group.at && group.rel) {
      return err(`"${name}": use at() or a placement relation, not both`);
    }
    if (group.heldBy && (group.at || group.rel || group.rot[0] || group.rot[1] || group.rot[2])) {
      return err(`"${name}": held-by() derives position and rotation from the holder — drop at/relations/rotate`);
    }
    if (group.vanish !== null && group.vanish <= group.appear) {
      return err(`"${name}": vanish(${group.vanish}) must come after appear(${group.appear})`);
    }

    const bodyR = 0.22 * h;
    const L = 1.3 * h;
    const legLen = h - 2 * bodyR;
    const mk = (mname, shape, extra) => ({
      name: `${name}-${mname}`, shape, line: lineNo,
      size: null, r: null, h: null, sides: null,
      at: [0, 0, 0], rel: null, rot: [0, 0, 0], color,
      appear: group.appear, vanish: group.vanish, parent: name,
      family: `${name}/animal`,
      ...extra,
    });
    const members = [
      mk("body", "cylinder", { r: bodyR, h: L, at: [0, h - bodyR, 0], rot: [90, 0, 0] }),
      mk("head", "sphere", { r: 0.26 * h, at: [0, h - bodyR + 0.12 * h, -(L / 2 + 0.06 * h)] }),
      mk("leg-1", "cylinder", { r: 0.06 * h, h: legLen, at: [0.13 * h, legLen / 2, -(L / 2 - 0.14 * h)] }),
      mk("leg-2", "cylinder", { r: 0.06 * h, h: legLen, at: [-0.13 * h, legLen / 2, -(L / 2 - 0.14 * h)] }),
      mk("leg-3", "cylinder", { r: 0.06 * h, h: legLen, at: [0.13 * h, legLen / 2, L / 2 - 0.14 * h] }),
      mk("leg-4", "cylinder", { r: 0.06 * h, h: legLen, at: [-0.13 * h, legLen / 2, L / 2 - 0.14 * h] }),
    ];
    for (const m of members) {
      if (objects.has(m.name)) {
        return err(
          `animal "${name}" creates a part named "${m.name}", but that name is taken (line ${objects.get(m.name).line})`,
        );
      }
    }
    group.animal = { h, color };
    objects.set(name, group);
    for (const m of members) objects.set(m.name, m);
  }

  // ------------------------------------------------- shared doors (door-to)
  //
  // Runs after resolution, when room positions are known. Each door(to X)
  // finds the facing walls, checks the rooms really touch, centers a door
  // on the shared stretch, and carves BOTH rooms — one declared fact, two
  // aligned openings. Declaring the same connection from both rooms is the
  // same fact twice (fine, if the widths agree).
  // Carves all doors (manual + shared), emits doorway markers, and returns
  // the ADJACENCY set: every pair of rooms a door(to) actually connected,
  // as sorted "a|b" keys. Manual one-sided doors declare no adjacency —
  // they don't say who is on the other side.
  function carveDoors(objects, errors) {
    const rooms = [...objects.values()].filter((o) => o.room);
    if (!rooms.length) return new Set();

    // per-room pending opening lists, seeded with the manual doors and
    // windows (a window entry carries its y-band: { window: {height, sill} })
    const winEntry = (w) => ({ width: w.width, offset: w.offset, window: { height: w.height, sill: w.sill } });
    const pending = new Map(rooms.map((r) => [r.name, {
      north: [...r.room.doors.north, ...r.room.windows.north.map(winEntry)],
      south: [...r.room.doors.south, ...r.room.windows.south.map(winEntry)],
      east: [...r.room.doors.east, ...r.room.windows.east.map(winEntry)],
      west: [...r.room.doors.west, ...r.room.windows.west.map(winEntry)],
    }]));
    const seen = new Map(); // "a|b|kind" -> width
    const connections = []; // shared openings, for marker placement

    const OPP = { north: "south", south: "north", east: "west", west: "east" };
    for (const rm of rooms) {
      for (const auto of rm.room.autos) {
        const kind = auto.kind || "door";
        const fail = (msg) => errors.push({ line: auto.line, msg });
        const t = objects.get(auto.target);
        if (!t) { fail(`${kind}(to): no room named "${auto.target}"`); continue; }
        if (!t.room) { fail(`${kind}(to): "${auto.target}" is not a room`); continue; }
        if ((t.parent || null) !== (rm.parent || null)) {
          fail(`${kind}(to): "${auto.target}" is in a different frame — connected rooms must be siblings`);
          continue;
        }
        if (rm.rot.some((v) => v) || t.rot.some((v) => v)) {
          fail(`${kind}(to): connected rooms can't be rotated (align them axis-parallel)`);
          continue;
        }
        if (kind === "window" && auto.sill + auto.height >= t.room.size[1] - 1e-9) {
          fail(`window(to): sill ${auto.sill} + height ${auto.height} doesn't fit ${t.name}'s ${t.room.size[1]}-high wall`);
          continue;
        }
        const key = [rm.name, t.name].sort().join("|") + "|" + kind;
        if (seen.has(key)) {
          if (seen.get(key) !== auto.width) {
            fail(`${kind}(to): ${rm.name} and ${t.name} declare this ${kind} with different widths`);
          }
          continue; // same fact stated twice
        }
        seen.set(key, auto.width);

        // rooms may touch on any side, offset or not (a long room can run
        // past its neighbor) — so try all four and take the wall that
        // actually touches with room enough for the door
        let hit = null;
        let short = null; // touched, but the shared stretch is too small
        let nearest = Infinity; // for the error message
        for (const side of ["north", "south", "east", "west"]) {
          const axis = side === "east" || side === "west" ? 0 : 2;
          const cross = axis === 0 ? 2 : 0;
          const sign = side === "east" || side === "south" ? 1 : -1;
          const ownFace = rm.pos[axis] + sign * (rm.room.size[axis] / 2 + rm.room.thick);
          const tgtFace = t.pos[axis] - sign * (t.room.size[axis] / 2 + t.room.thick);
          const gap = sign * (tgtFace - ownFace);
          if (Math.abs(gap) > 1e-6) {
            if (gap > 0) nearest = Math.min(nearest, gap);
            continue;
          }
          const lo = Math.max(rm.pos[cross] - rm.room.size[cross] / 2, t.pos[cross] - t.room.size[cross] / 2);
          const hi = Math.min(rm.pos[cross] + rm.room.size[cross] / 2, t.pos[cross] + t.room.size[cross] / 2);
          if (hi - lo < auto.width - 1e-9) {
            short = hi - lo;
            continue;
          }
          hit = { side, axis, cross, ownFace, lo, hi };
          break;
        }
        if (!hit) {
          if (short !== null) {
            fail(
              `${kind}(to): the shared wall between ${rm.name} and ${t.name} is only ${Math.max(0, short).toFixed(2)} long — too short for a width-${auto.width} ${kind}`,
            );
          } else {
            fail(
              `${kind}(to): ${rm.name} and ${t.name} don't share a wall${nearest < Infinity ? ` — their nearest faces are ${nearest.toFixed(2)} apart` : ""}. Place rooms against each other with a relation, e.g. north-of(${rm.name}) — room-to-room relations sit wall-to-wall`,
            );
          }
          continue;
        }

        const center = (hit.lo + hit.hi) / 2;
        const band = kind === "window" ? { window: { height: auto.height, sill: auto.sill } } : {};
        pending.get(rm.name)[hit.side].push({ width: auto.width, offset: center - rm.pos[hit.cross], ...band });
        const tp = pending.get(t.name);
        if (tp) tp[OPP[hit.side]].push({ width: auto.width, offset: center - t.pos[hit.cross], ...band });
        connections.push({
          rm, other: t.name, axis: hit.axis, plane: hit.ownFace, center, kind,
          y: kind === "window" ? auto.sill + auto.height / 2 : 0,
        });
      }
    }

    // Every doorway becomes a named PLACE: an invisible, zero-size marker
    // at the opening's center on the ground — walk to(study-south-door),
    // ? distance(frida command_center-barracks-door). Never a blocker.
    function marker(name, rm, pos) {
      if (objects.has(name)) {
        errors.push({
          line: rm.line,
          msg: `the doorway marker "${name}" collides with an existing name (line ${objects.get(name).line})`,
        });
        return;
      }
      objects.set(name, {
        name, shape: "marker", line: rm.line,
        size: null, r: null, h: null, sides: null,
        at: pos.slice(), rel: null, rot: [0, 0, 0], color: null,
        appear: rm.appear, vanish: rm.vanish, parent: rm.parent,
        pos: pos.slice(), dims: { w: 0, h: 0, d: 0 }, bboxOff: [0, 0, 0],
      });
    }
    for (const c of connections) {
      const pos = c.axis === 0 ? [c.plane, c.y, c.center] : [c.center, c.y, c.plane];
      marker(`${c.rm.name}-${c.other}-${c.kind}`, c.rm, pos);
    }
    for (const rm of rooms) {
      for (const wl of roomWalls(rm.room.size, rm.room.thick)) {
        const axis = wl.along === "x" ? 0 : 2;
        const plane = rm.pos[axis === 0 ? 2 : 0] + (axis === 0 ? wl.z : wl.x);
        const place = (offset, y, nm) => {
          const center = rm.pos[axis] + offset;
          marker(nm, rm, axis === 0 ? [center, y, plane] : [plane, y, center]);
        };
        rm.room.doors[wl.side].forEach((d, i) =>
          place(d.offset, 0, `${rm.name}-${wl.side}-door${i ? "-" + (i + 1) : ""}`));
        rm.room.windows[wl.side].forEach((w, i) =>
          place(w.offset, w.sill + w.height / 2, `${rm.name}-${wl.side}-window${i ? "-" + (i + 1) : ""}`));
      }
    }

    // carve: replace whole walls with segment boxes (resolved in place)
    for (const rm of rooms) {
      const err = (msg) => errors.push({ line: rm.line, msg });
      for (const wl of roomWalls(rm.room.size, rm.room.thick)) {
        const ds = pending.get(rm.name)[wl.side];
        if (!ds.length) continue;
        const segs = wallSegments(wl.span, ds, wl.side, err);
        if (!segs) continue;
        const wall = objects.get(`${rm.name}-${wl.side}`);
        if (!wall) continue; // name collision already reported at parse
        objects.delete(wall.name);
        for (const m of wallBoxes(rm.name, wl, segs, rm.room.size[1], rm.room.thick, wall.color, rm.line, rm)) {
          // resolution already ran: finish these members by hand
          m.pos = m.at.slice();
          m.dims = { w: m.size[0], h: m.size[1], d: m.size[2] };
          m.bboxOff = [0, 0, 0];
          m.family = wall.family || null;
          m.glass = wall.glass || undefined;
          objects.set(m.name, m);
        }
      }
    }
    // adjacency = door connections only: a window is not a way THROUGH —
    // people can't cross it. (The Speckled Band turns on exactly this:
    // the rooms aren't adjacent, yet death crosses. Sight and small
    // things pass; adjacency stays a walkability fact.)
    return new Set(connections.filter((c) => c.kind === "door").map((c) => [c.rm.name, c.other].sort().join("|")));
  }

  function applyProp(obj, { key, args }, err, timeCtx) {
    const bad = (msg) => { err(`${key}(): ${msg}`); return false; };

    if (obj.shape === "group" && ["size", "r", "h", "sides", "color"].includes(key)) {
      return bad("groups don't have " + key + "() — put it on the members");
    }
    if (
      obj.shape === "link" &&
      (["at", "rotate", "in", "size", "h", "repeat", "spread", "jitter", "stagger", "held-by"].includes(key) ||
        RELATIONS.has(key))
    ) {
      return bad("links derive their pose — they take between(a b), r(), sides(), color(), appear(), vanish()");
    }

    switch (key) {
      case "in": {
        if (args.length !== 1 || num(args[0]) !== null) {
          return bad("expected one group name");
        }
        obj.parent = args[0];
        return true;
      }
      case "size": {
        if (obj.shape !== "box") return bad("only boxes have size(w h d)");
        const v = nums(args, 3);
        return v ? ((obj.size = v), true) : bad("expected 3 numbers: size(w h d)");
      }
      case "r": {
        if (obj.shape === "box") return bad("boxes use size(w h d), not r()");
        const v = nums(args, 1);
        if (!v || v[0] <= 0) return bad("expected one positive number");
        obj.r = v[0];
        return true;
      }
      case "h": {
        if (obj.shape !== "cylinder") return bad("only cylinders have h()");
        const v = nums(args, 1);
        if (!v || v[0] <= 0) return bad("expected one positive number");
        obj.h = v[0];
        return true;
      }
      case "between": {
        if (obj.shape !== "link") return bad("only links have between(a b)");
        if (args.length !== 2 || args.some((a2) => num(a2) !== null)) {
          return bad("expected two object names: between(a b)");
        }
        obj.between = args.slice();
        return true;
      }
      case "sides": {
        if (obj.shape !== "cylinder" && obj.shape !== "link") return bad("only cylinders and links have sides()");
        const v = nums(args, 1);
        if (!v || !Number.isInteger(v[0]) || v[0] < 3 || v[0] > 64) {
          return bad("expected a whole number from 3 to 64");
        }
        obj.sides = v[0];
        return true;
      }
      case "at": {
        // at(x y z) places the center; at(x z) places on the ground
        // plane at that spot (rest height stays the object's own);
        // at(name dx? dz?) — standing at a named thing's spot
        if (args.length >= 1 && num(args[0]) === null) {
          const off = args.length > 1 ? nums(args.slice(1), 2) : [0, 0];
          if (args.length !== 1 && !off) {
            return bad("expected at(name) or at(name dx dz)");
          }
          obj.at = { ref: args[0], dx: off[0], dz: off[1] };
          return true;
        }
        const v = nums(args, 3) || nums(args, 2);
        return v ? ((obj.at = v), true) : bad("expected at(x y z), at(x z) to rest on the ground, or at(name dx? dz?)");
      }
      case "rotate": {
        const v = nums(args, 3);
        return v ? ((obj.rot = v), true) : bad("expected 3 numbers (degrees): rotate(x y z)");
      }
      case "held-by": {
        // possession: this object's pose derives from its holder — same
        // spot by default (concealed on the person; the geometry makes
        // sees() honestly false while in() stays true), an offset shows
        // it. The offset rides the holder's rotation like a pocket.
        // A person holder also takes a named WEAR ANCHOR — head, neck,
        // chest, back, hand — computed from their proportions: worn
        // possession, visible (and honestly seeable) instead of pocketed.
        if (obj.shape === "group" && !obj.person && !obj.animal) {
          return bad("groups can't be held — hold a plain shape, a person, or an animal");
        }
        if (args.length < 1 || num(args[0]) !== null) {
          return bad("expected held-by(holder), held-by(holder dx dy dz), or held-by(person head|neck|chest|back|hand)");
        }
        if (args.length === 2 && num(args[1]) === null) {
          if (!WEAR_ANCHORS.has(args[1])) {
            return bad(`unknown anchor "${args[1]}" — one of ${[...WEAR_ANCHORS].join(", ")} (or give dx dy dz)`);
          }
          obj.heldBy = { ref: args[0], anchor: args[1], off: [0, 0, 0] };
          return true;
        }
        const off = args.length > 1 ? nums(args.slice(1), 3) : [0, 0, 0];
        if (!off) return bad("expected held-by(holder), held-by(holder dx dy dz), or held-by(person head|neck|chest|back|hand)");
        obj.heldBy = { ref: args[0], off };
        return true;
      }
      case "color": {
        if (args.length !== 1) return bad("expected one color name or #hex");
        obj.color = args[0];
        return true;
      }
      case "glass": {
        // a FACT, not a look: glass never blocks a sight line —
        // sees(witness, knife) is true through the display case, while
        // in()/touches/bounds stay solid. Renderers draw it translucent.
        if (args.length) return bad("glass is a flag — no arguments");
        if (obj.shape === "group") return bad("groups aren't glass — use a glass room, or flag the members");
        obj.glass = true;
        return true;
      }
      case "appear": case "vanish": {
        if (args.length === 1) {
          const w = wallTime(args[0], timeCtx, bad);
          if (Number.isNaN(w)) return false;
          if (w !== null) {
            obj[key] = w;
            return true;
          }
        }
        const v = nums(args, 1);
        if (!v || v[0] < 0) return bad("expected one number >= 0 (seconds, or 5:15 with a clock)");
        obj[key] = v[0];
        return true;
      }
      case "repeat": {
        const v = nums(args, 1);
        if (!v || !Number.isInteger(v[0]) || v[0] < 2 || v[0] > 200) {
          return bad("expected a whole number of copies, 2 to 200");
        }
        obj.repeat = v[0];
        return true;
      }
      case "spread": {
        const v = nums(args, 3);
        return v ? ((obj.spread = v), true) : bad("expected 3 numbers: the per-copy offset");
      }
      case "jitter": {
        const v = nums(args, 3) || nums(args, 4);
        if (!v || v.slice(0, 3).some((n) => n < 0)) {
          return bad("expected jitter(x y z) or jitter(x y z seed), amounts >= 0");
        }
        obj.jitter = v.slice(0, 3);
        if (v.length === 4) obj.seed = v[3];
        return true;
      }
      case "stagger": {
        const v = nums(args, 1);
        if (!v || v[0] < 0) return bad("expected one number >= 0 (seconds between copies)");
        obj.stagger = v[0];
        return true;
      }
      case "shift": {
        // a ground-plane nudge applied AFTER placement — composes with
        // relations (which center on their target), at(name), on(), all
        // of it. shift(0 -2): two north, no other change.
        const v = nums(args, 2);
        if (!v) return bad("shift(): expected dx dz — a slide applied after placement");
        obj.shift = v;
        return true;
      }
      default: {
        if (LEGACY_RELATIONS[key]) {
          return bad(`${key}() is now ${LEGACY_RELATIONS[key]}() — placement relations use compass names (north = -z, up in view top)`);
        }
        if (RELATIONS.has(key)) {
          if (obj.rel) return bad(`"${obj.name}" already has a placement relation`);
          if (args.length < 1 || args.length > 3) {
            return bad("expected: " + key + "(target gap?) or " + key + "(a b gap?) — two targets anchor to their combined bounds");
          }
          // second argument: a gap if numeric, a second target if a name
          let gap = null;
          let target2 = null;
          if (args.length >= 2) {
            if (num(args[1]) === null) target2 = args[1];
            else gap = num(args[1]);
          }
          if (args.length === 3) {
            if (!target2) return bad("expected: " + key + "(a b gap)");
            gap = num(args[2]);
            if (gap === null) return bad("gap must be a number");
          }
          obj.rel = { kind: key, target: args[0], target2, gap };
          return true;
        }
        return bad(`unknown property`);
      }
    }
  }

  // ----------------------------------------------------------------- repeat
  //
  // repeat(n) stamps an object (or a whole group) into n copies named
  // name-1 … name-n, then removes the original. Copies vary declaratively:
  // spread = per-copy offset, jitter = seeded random offset (reproducible —
  // same scene, same layout, on any host), stagger = each copy's animation
  // clock runs s seconds behind the previous. Animations written against
  // the original name apply to every copy; relations and queries naming it
  // from outside are ambiguous and error. Expansion happens before
  // resolution, innermost repeats first, so nothing downstream changes.

  // The PRNG is part of the language spec (mulberry32): ports must match it.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function expandRepeats(objects, anims, queries, errors) {
    // every object whose ancestor chain passes through `name`
    function descendantsOf(name) {
      const out = [];
      for (const o of objects.values()) {
        const seen = new Set();
      let cur = o;
        while (cur && cur.parent && !seen.has(cur.parent)) {
          if (cur.parent === name) {
            out.push(o);
            break;
          }
          seen.add(cur.parent);
          cur = objects.get(cur.parent);
        }
      }
      return out;
    }

    function expandOne(obj) {
      const family = [obj, ...descendantsOf(obj.name)];
      const familyNames = new Set(family.map((f) => f.name));
      const doored = (f) =>
        f.room && (f.room.autos.length ||
          Object.values(f.room.doors).some((d) => d.length) ||
          Object.values(f.room.windows).some((w) => w.length));
      if (family.some(doored)) {
        // opening carving runs post-resolution and clone wall names drift
        // (cc-north-1 vs cc-1-north); keep this combination off until designed
        errors.push({
          line: obj.line,
          msg: "repeat: rooms with doors or windows can't repeat yet — lay them out individually",
        });
        obj.repeat = null;
        return;
      }
      const n = obj.repeat;
      const spread = obj.spread || [0, 0, 0];
      const jit = obj.jitter || [0, 0, 0];
      const stag = obj.stagger || 0;
      const rng = mulberry32(obj.seed === null ? 1 : obj.seed);

      // check every generated name before touching anything
      for (let i = 1; i <= n; i++) {
        for (const f of family) {
          const nm = f.name + "-" + i;
          if (objects.has(nm) && !familyNames.has(nm)) {
            errors.push({
              line: obj.line,
              msg: `repeat: wants to create "${nm}", but that name is taken (line ${objects.get(nm).line})`,
            });
            obj.repeat = null;
            return;
          }
        }
      }

      for (const f of family) objects.delete(f.name);

      for (let i = 1; i <= n; i++) {
        const shift = (i - 1) * stag;
        const off = [
          (i - 1) * spread[0] + (rng() * 2 - 1) * jit[0],
          (i - 1) * spread[1] + (rng() * 2 - 1) * jit[1],
          (i - 1) * spread[2] + (rng() * 2 - 1) * jit[2],
        ];
        const mapping = new Map(family.map((f) => [f.name, f.name + "-" + i]));
        for (const f of family) {
          const base = f.offset || [0, 0, 0];
          objects.set(mapping.get(f.name), {
            ...f,
            name: mapping.get(f.name),
            repeat: null, spread: null, jitter: null, stagger: null,
            parent: f.parent ? mapping.get(f.parent) || f.parent : null,
            rel: f.rel
              ? {
                  ...f.rel,
                  target: mapping.get(f.rel.target) || f.rel.target,
                  target2: f.rel.target2 ? mapping.get(f.rel.target2) || f.rel.target2 : null,
                }
              : null,
            // spread/jitter move the copy itself; members just ride along
            offset: f === obj ? [base[0] + off[0], base[1] + off[1], base[2] + off[2]] : base.slice(),
            // stagger delays the copy's animation clock, not its existence
            clockShift: (f.clockShift || 0) + shift,
            family: f.family || f.name, // rendering hint: copies share a palette slot
          });
        }
      }

      // animations against a family name fan out to every copy, staggered
      const fanned = [];
      for (const a of anims) {
        if (!familyNames.has(a.target)) {
          const ref = (a.to && a.to.ref) || (a.around && a.around.ref);
          if (ref && familyNames.has(ref)) {
            errors.push({
              line: a.line,
              msg: `"${ref}" is repeated into ${n} copies — name one, e.g. ${ref}-1`,
            });
            continue;
          }
          fanned.push(a);
          continue;
        }
        for (let i = 1; i <= n; i++) {
          const c = { ...a, target: a.target + "-" + i, startShift: (a.startShift || 0) + (i - 1) * stag };
          if (a.to && a.to.ref && familyNames.has(a.to.ref)) c.to = { ...a.to, ref: a.to.ref + "-" + i };
          if (a.around && a.around.ref && familyNames.has(a.around.ref)) {
            c.around = { ref: a.around.ref + "-" + i };
          }
          fanned.push(c);
        }
      }
      anims.length = 0;
      anims.push(...fanned);

      // naming the family from outside is ambiguous — say so clearly
      for (const o of objects.values()) {
        if (o.rel && (familyNames.has(o.rel.target) || familyNames.has(o.rel.target2))) {
          const hit = familyNames.has(o.rel.target) ? o.rel.target : o.rel.target2;
          errors.push({
            line: o.line,
            msg: `${o.rel.kind}(): "${hit}" is repeated into ${n} copies — place against one, e.g. ${hit}-1`,
          });
          o.rel = null;
        }
        if (o.between) {
          const hit = o.between.find((en) => familyNames.has(en));
          if (hit) {
            errors.push({
              line: o.line,
              msg: `between(): "${hit}" is repeated into ${n} copies — link one, e.g. ${hit}-1`,
            });
          }
        }
      }
      // (queries may keep naming the family: it becomes a SET of the copies)
    }

    // innermost first: a repeated member inside a repeated group expands
    // before the group stamps out the whole (already-expanded) assembly
    let guard = 0;
    while (guard++ < 300) {
      const next = [...objects.values()].find(
        (o) => o.repeat && !descendantsOf(o.name).some((d) => d.repeat),
      );
      if (!next) break;
      expandOne(next);
    }
  }

  // ------------------------------------------------------------------ links
  //
  // A link is a DERIVED object — the first of its kind: a rigid straight
  // cylinder spanning two named things, its pose recomputed from their
  // live world positions at every sampled instant. It is a maintained
  // relation, not a motion — which is why it tracks even though to(name)
  // deliberately doesn't ("no pursuit" is about animation segments).
  // Links may cross frames (they derive from world poses). Hard line:
  // straight and rigid only — no springs, chains, or joints.

  function validateLinks(objects, errors) {
    for (const o of objects.values()) {
      if (o.shape !== "link") continue;
      for (const en of o.between) {
        const t = objects.get(en);
        if (!t) {
          errors.push({ line: o.line, msg: `between(): no object named "${en}"` });
        } else if (t.shape === "link") {
          errors.push({ line: o.line, msg: `between(): "${en}" is a link — links can't chain (yet)` });
        }
      }
    }
  }

  // ------------------------------------------------------------- resolution

  // Axis-aligned dimensions. Rotation is ignored for bounds in v0.
  function dimsOf(o) {
    switch (o.shape) {
      case "box": return { w: o.size[0], h: o.size[1], d: o.size[2] };
      case "sphere": return { w: 2 * o.r, h: 2 * o.r, d: 2 * o.r };
      case "cylinder": return { w: 2 * o.r, h: o.h, d: 2 * o.r };
    }
  }

  // Positions are resolved in the object's own frame: group members in
  // group-local space, everything else in world space. A group's bounds are
  // the union of its members' local bounds; since that union need not be
  // centered on the group origin, every object carries bboxOff — the offset
  // from its position to its bounding-box center ([0,0,0] for shapes).
  function resolveAll(objects, errors) {
    // membership: validate in() targets and index children
    const children = new Map(); // group name -> [member objects]
    for (const o of objects.values()) {
      if (!o.parent) continue;
      const p = objects.get(o.parent);
      if (!p) {
        errors.push({ line: o.line, msg: `in(): no group named "${o.parent}"` });
        o.parent = null;
        continue;
      }
      if (p.shape !== "group") {
        errors.push({ line: o.line, msg: `in(): "${o.parent}" is not a group` });
        o.parent = null;
        continue;
      }
      if (!children.has(o.parent)) children.set(o.parent, []);
      children.get(o.parent).push(o);
    }

    // membership cycles (a in b, b in a): break them before resolving
    for (const o of objects.values()) {
      const seen = new Set([o.name]);
      let cur = o;
      while (cur.parent) {
        const p = objects.get(cur.parent);
        if (seen.has(p.name)) {
          errors.push({ line: p.line, msg: `circular in() membership involving "${p.name}"` });
          const sibs = children.get(p.parent);
          if (sibs) sibs.splice(sibs.indexOf(p), 1);
          p.parent = null;
          break;
        }
        seen.add(p.name);
        cur = p;
      }
    }

    const status = new Map(); // name -> "resolving" | "done"

    function boundsOf(o) {
      if (o.shape !== "group") return { dims: dimsOf(o), off: [0, 0, 0] };
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      let any = false;
      for (const c of children.get(o.name) || []) {
        resolve(c);
        any = true;
        const half = [c.dims.w / 2, c.dims.h / 2, c.dims.d / 2];
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], c.pos[i] + c.bboxOff[i] - half[i]);
          max[i] = Math.max(max[i], c.pos[i] + c.bboxOff[i] + half[i]);
        }
      }
      if (!any) return { dims: { w: 0, h: 0, d: 0 }, off: [0, 0, 0] };
      return {
        dims: { w: max[0] - min[0], h: max[1] - min[1], d: max[2] - min[2] },
        off: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      };
    }

    function resolve(o) {
      if (status.get(o.name) === "done") return;
      if (status.get(o.name) === "resolving") {
        errors.push({ line: o.line, msg: `circular placement involving "${o.name}"` });
        o.dims = o.shape === "group" ? { w: 0, h: 0, d: 0 } : dimsOf(o);
        o.bboxOff = [0, 0, 0];
        o.pos = [0, o.dims.h / 2, 0];
        status.set(o.name, "done");
        return;
      }
      status.set(o.name, "resolving");

      if (o.shape === "link") {
        // a link's real pose is derived at sample time from its endpoints;
        // these placeholders exist so generic code paths have something
        o.dims = { w: 0, h: 0, d: 0 };
        o.bboxOff = [0, 0, 0];
        o.pos = [0, 0, 0];
        status.set(o.name, "done");
        return;
      }

      if (o.heldBy) {
        // held things keep their real dims but their pose derives from
        // the holder at sample time (the holder may move; the held thing
        // rides along) — validate the chain here, derive in poseAt
        const hb = boundsOf(o);
        o.dims = hb.dims;
        o.bboxOff = hb.off;
        o.pos = [0, 0, 0];
        const t = objects.get(o.heldBy.ref);
        if (!t) {
          errors.push({ line: o.line, msg: `held-by(): no object named "${o.heldBy.ref}"` });
        } else if (t.shape === "link") {
          errors.push({ line: o.line, msg: `held-by(): "${t.name}" is a link — links can't hold things` });
        } else if (t.name === o.name) {
          errors.push({ line: o.line, msg: `held-by(): "${o.name}" can't hold itself` });
        } else {
          let cur = t, hops = 0;
          while (cur && cur.heldBy && hops++ <= objects.size) {
            if (cur.heldBy.ref === o.name) {
              errors.push({
                line: o.line,
                msg: `held-by(): "${o.name}" and "${t.name}" hold each other — possession can't loop`,
              });
              break;
            }
            cur = objects.get(cur.heldBy.ref);
          }
        }
        status.set(o.name, "done");
        return;
      }

      const b = boundsOf(o);
      const d = b.dims;
      const off = b.off;
      // default: shapes rest on the ground; a group is a frame at the origin
      let pos = o.shape === "group" ? [0, 0, 0] : [0, d.h / 2, 0];

      if (o.at && o.at.ref) {
        const t = objects.get(o.at.ref);
        if (!t) {
          errors.push({ line: o.line, msg: `at(): no object named "${o.at.ref}"` });
        } else if (t.shape === "link") {
          errors.push({ line: o.line, msg: `at(): "${t.name}" is a link — links have no placed position` });
        } else if (t.heldBy) {
          errors.push({ line: o.line, msg: `at(): "${t.name}" is held by "${t.heldBy.ref}" — its position rides its holder; name the holder` });
        } else if ((t.parent || null) !== (o.parent || null)) {
          errors.push({
            line: o.line,
            msg: `at(): "${t.name}" is in a different group — positions must stay within one frame`,
          });
        } else {
          resolve(t);
          // the named thing's x/z — and rest on the named thing's BASE
          // level, so at(upstairs_bedroom 1 0) stands on that floor,
          // not the ground floor below it (base 0 for ground rooms:
          // identical to the old ground-rest)
          const tBase = t.pos[1] + (t.bboxOff ? t.bboxOff[1] : 0) - t.dims.h / 2;
          // rest the object's UNION on the target's base: subtract the
          // bbox offset like relations do, so an off-origin group (a
          // person — origin at the feet) stands ON the floor, not
          // floated by half its height (shapes: off is zero, unchanged)
          pos = [t.pos[0] + o.at.dx, tBase + d.h / 2 - off[1], t.pos[2] + o.at.dz];
        }
      } else if (o.at) {
        // at(x z): x/z only — keep the default rest y (h/2 for shapes,
        // 0 for groups, so a room's base still lands on the ground)
        pos = o.at.length === 2 ? [o.at[0], pos[1], o.at[1]] : o.at.slice();
      } else if (o.rel) {
        const anchor = (name) => {
          const t = objects.get(name);
          if (!t) {
            errors.push({ line: o.line, msg: `${o.rel.kind}(): no object named "${name}"` });
            return null;
          }
          if (t.shape === "link") {
            errors.push({
              line: o.line,
              msg: `${o.rel.kind}(): "${t.name}" is a link — links have no placed position to build on`,
            });
            return null;
          }
          if (t.heldBy) {
            errors.push({
              line: o.line,
              msg: `${o.rel.kind}(): "${t.name}" is held by "${t.heldBy.ref}" — its position rides its holder; name the holder`,
            });
            return null;
          }
          if ((t.parent || null) !== (o.parent || null)) {
            errors.push({
              line: o.line,
              msg: `${o.rel.kind}(): "${t.name}" is in a different group — relations must stay within one frame`,
            });
            return null;
          }
          resolve(t);
          return t;
        };
        const t = anchor(o.rel.target);
        const t2 = t && o.rel.target2 ? anchor(o.rel.target2) : null;
        if (t && (!o.rel.target2 || t2)) {
          // anchor box: one target's bounds, or the union of two —
          // "west-of(command lab)" runs along both
          let td = t.dims;
          let tc = [t.pos[0] + t.bboxOff[0], t.pos[1] + t.bboxOff[1], t.pos[2] + t.bboxOff[2]];
          if (t2) {
            const c2 = [t2.pos[0] + t2.bboxOff[0], t2.pos[1] + t2.bboxOff[1], t2.pos[2] + t2.bboxOff[2]];
            const halves = [td.w / 2, td.h / 2, td.d / 2];
            const halves2 = [t2.dims.w / 2, t2.dims.h / 2, t2.dims.d / 2];
            const min = tc.map((v, i) => Math.min(v - halves[i], c2[i] - halves2[i]));
            const max = tc.map((v, i) => Math.max(v + halves[i], c2[i] + halves2[i]));
            td = { w: max[0] - min[0], h: max[1] - min[1], d: max[2] - min[2] };
            tc = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
          }
          // between rooms, "beside" means adjacent: the gap defaults to 0
          // (wall-to-wall), which is what door(to) needs
          const gap = o.rel.gap !== null
            ? o.rel.gap
            : o.room && t.room && (!t2 || t2.room) ? 0 : DEFAULT_GAP[o.rel.kind];
          let c;
          switch (o.rel.kind) {
            case "on":     c = [tc[0], tc[1] + td.h / 2 + d.h / 2, tc[2]]; break;
            case "above":  c = [tc[0], tc[1] + td.h / 2 + gap + d.h / 2, tc[2]]; break;
            case "below":  c = [tc[0], tc[1] - td.h / 2 - gap - d.h / 2, tc[2]]; break;
            // Horizontal relations set x/z; the object rests on the ground.
            // horizontal relations rest on the ANCHOR'S BASE level, not
            // the ground — so a second-floor room placed south-of a
            // second-floor room stays on the second floor. Ground
            // anchors have base 0: identical to the old ground-rest.
            case "west-of":     c = [tc[0] - td.w / 2 - gap - d.w / 2, tc[1] - td.h / 2 + d.h / 2, tc[2]]; break;
            case "east-of":     c = [tc[0] + td.w / 2 + gap + d.w / 2, tc[1] - td.h / 2 + d.h / 2, tc[2]]; break;
            case "south-of":    c = [tc[0], tc[1] - td.h / 2 + d.h / 2, tc[2] + td.d / 2 + gap + d.d / 2]; break;
            case "north-of":    c = [tc[0], tc[1] - td.h / 2 + d.h / 2, tc[2] - td.d / 2 - gap - d.d / 2]; break;
          }
          pos = [c[0] - off[0], c[1] - off[1], c[2] - off[2]];
        }
      }

      // repeat's spread/jitter land here, after placement, so they compose
      // with at() and relations alike
      if (o.offset) {
        pos = [pos[0] + o.offset[0], pos[1] + o.offset[1], pos[2] + o.offset[2]];
      }
      // shift(dx dz): the author's nudge, same composition — relations
      // center on their target; shift slides along it (a hallway placed
      // east-of a room but extending north, not jutting both ways)
      if (o.shift) {
        pos = [pos[0] + o.shift[0], pos[1], pos[2] + o.shift[1]];
      }

      o.dims = d;
      o.bboxOff = off;
      o.pos = pos;
      status.set(o.name, "done");
    }

    for (const o of objects.values()) resolve(o);
    return children;
  }

  // -------------------------------------------------------------- animation
  //
  // Each object gets up to two channels: "move" (position) and "turn"
  // (rotation). Within a channel, segments chain: a segment starts when the
  // previous one ends (unless start() is explicit) and starts from wherever
  // the previous one left off (unless from() is explicit).

  function buildTracks(objects, anims, errors, events = [], thenBlocks = [], thenAnchors = new Map()) {
    const cursors = new Map(); // "target\0kind" -> { end, lastTo }
    let duration = 0;

    // THE FRONTIER: how far the story has gotten, walking statements in
    // written order — every segment end and possession event so far.
    // A then-block anchors at the frontier as of its opener (+ gap);
    // declarations never feed it (they are order-free facts, not beats).
    let frontier = 0;
    const pendingThen = thenBlocks.slice();
    const anchorUpTo = (line) => {
      while (pendingThen.length && pendingThen[0].line < line) {
        const b = pendingThen.shift();
        thenAnchors.set(b.id, frontier + b.gap);
      }
    };
    // within one then block, an object's FIRST bare segment takes the
    // anchor; its later bare segments chain from it (a move is three
    // written lines, one beat)
    const thenTaken = new Set();

    // a bare take/drop resolves here, interleaved in written order: in
    // a block (at or then) the block instant is the floor, lifted past
    // the THING's own landing; outside, it fires when both parties have
    // finished everything written for them so far
    const resolveEvent = (e) => {
      if (e.t == null) {
        const th = objects.get(e.thing), ho = objects.get(e.holder);
        const floor = e.thenBlock != null ? thenAnchors.get(e.thenBlock) : e.blockT;
        let t;
        if (floor != null) {
          t = floor;
          for (const a of anims) {
            if (a.kind === "paint" || a.line >= e.line || a._t1 == null) continue;
            if (a.target !== e.thing) continue;
            if (a._t1 > t) t = a._t1;
          }
        } else {
          t = Math.max(th ? th.appear : 0, ho ? ho.appear : 0);
          for (const a of anims) {
            if (a.kind === "paint" || a.line >= e.line || a._t1 == null) continue;
            if (a.target !== e.holder && a.target !== e.thing) continue;
            if (a._t1 > t) t = a._t1;
          }
        }
        e.t = t;
      }
      if (e.t > frontier) frontier = e.t;
    };

    const items = anims.map((a) => ({ line: a.line, a }))
      .concat(events.map((e) => ({ line: e.line, e })))
      .sort((x, y) => x.line - y.line); // stable: same-line fan-outs keep order

    for (const it of items) {
      anchorUpTo(it.line);
      if (it.e) { resolveEvent(it.e); continue; }
      const a = it.a;
      const obj = objects.get(a.target);
      if (!obj) {
        errors.push({ line: a.line, msg: `${a.kind}: no object named "${a.target}"` });
        continue;
      }
      if (obj.shape === "link" && a.kind !== "paint") {
        errors.push({
          line: a.line,
          msg: `${a.kind}: "${a.target}" is a link — its pose is derived from its endpoints`,
        });
        continue;
      }
      if (obj.heldBy && a.kind !== "paint") {
        errors.push({
          line: a.line,
          msg: `${a.kind}: "${a.target}" is held by "${obj.heldBy.ref}" — move the holder and it rides along`,
        });
        continue;
      }
      if (a.kind === "paint" && (obj.shape === "group" || obj.shape === "marker")) {
        if (obj.room || obj.tube || obj.person || obj.animal) {
          // painting a ROOM (or a tube) paints its walls — the same
          // surfaces its color() owns at birth (segments, sills and
          // lintels included). Runs post-carve, so it lands on the real
          // wall pieces.
          for (const w of objects.values()) {
            // rooms/tubes paint their box pieces; a person paints all
            // their parts (body cylinder + head sphere)
            if (w.parent !== obj.name || (w.shape !== "box" && !obj.person && !obj.animal)) continue;
            const wkey = w.name + "/paint";
            const wcur = cursors.get(wkey) || { end: w.appear + (w.clockShift || 0), lastTo: null };
            const wt0 = a.start !== null ? a.start + (a.startShift || 0)
              : a.thenBlock != null ? thenAnchors.get(a.thenBlock)
              : wcur.end + (a.after || 0);
            const wt1 = wt0 + a.over;
            if (wt1 > frontier) frontier = wt1;
            if (!w.track) w.track = { move: [], turn: [], paint: [] };
            w.track.paint.push({ t0: wt0, t1: wt1, from: wcur.lastTo !== null ? wcur.lastTo : w.color, to: a.to, ease: a.ease });
            cursors.set(wkey, { end: wt1, lastTo: a.to });
            if (wt1 > duration) duration = wt1;
          }
          continue;
        }
        errors.push({
          line: a.line,
          msg: obj.shape === "group"
            ? `paint: "${a.target}" is a group — groups have no surface; paint a member`
            : `paint: "${a.target}" is a doorway marker — markers are invisible`,
        });
        continue;
      }
      // orbit is position animation: it shares the move channel and chains
      // with move segments (fly to the ring, then circle it).
      const channel = a.kind === "turn" ? "turn" : a.kind === "paint" ? "paint" : "move";
      const key = a.target + "/" + channel;
      // An object's clock starts when it exists: the first segment chains
      // from appear(), not from t=0. Explicit start() still overrides.
      // a repeated copy's clock runs stagger-shifted: chaining starts late,
      // and explicit start() times shift with it
      const cur = cursors.get(key) || { end: obj.appear + (obj.clockShift || 0), lastTo: null };
      let t0;
      if (a.start !== null) t0 = a.start + (a.startShift || 0);
      else if (a.thenBlock != null && !thenTaken.has(a.thenBlock + "|" + key)) {
        t0 = thenAnchors.get(a.thenBlock) + (a.startShift || 0);
        thenTaken.add(a.thenBlock + "|" + key);
      } else t0 = cur.end + (a.after || 0);
      const t1 = t0 + a.over;
      a._t1 = t1; // bare take/drop events chain from these
      if (t1 > frontier) frontier = t1;

      if (a.kind === "paint") {
        // the color channel chains like the spatial ones; from may be null —
        // an unset birth color is the renderer's palette pick, which the
        // core never knows (renderers resolve null to the mesh's own color)
        const from = cur.lastTo !== null ? cur.lastTo : obj.color;
        if (!obj.track) obj.track = { move: [], turn: [], paint: [] };
        obj.track.paint.push({ t0, t1, from, to: a.to, ease: a.ease });
        cursors.set(key, { end: t1, lastTo: a.to });
        if (t1 > duration) duration = t1;
        continue;
      }
      const base = channel === "move" ? obj.pos : obj.rot;
      const prev = cur.lastTo || base.slice();
      // walk's from() is x z; its height comes from wherever the walker is
      const from = a.from ? (a.kind === "walk" ? [a.from[0], prev[1], a.from[1]] : a.from) : prev;

      let to;
      let orbit = null;
      if (a.kind === "orbit") {
        let center;
        if (a.around.ref) {
          // around(name): the named object's placed (t=0) position,
          // same rules as to(name) — same frame, no pursuit
          const c = objects.get(a.around.ref);
          if (!c) {
            errors.push({ line: a.line, msg: `around(): no object named "${a.around.ref}"` });
            continue;
          }
          if (c.heldBy) {
            errors.push({ line: a.line, msg: `around(): "${c.name}" is held by "${c.heldBy.ref}" — its position rides its holder; name the holder` });
            continue;
          }
          if ((c.parent || null) !== (obj.parent || null)) {
            errors.push({
              line: a.line,
              msg: `around(): "${c.name}" is in a different group — centers must stay within one frame`,
            });
            continue;
          }
          center = c.pos.slice();
        } else {
          center = a.around;
        }
        // The radius is wherever the segment starts, projected onto the
        // circle's plane; starting on the axis leaves nothing to travel.
        const rel = [from[0] - center[0], from[1] - center[1], from[2] - center[2]];
        const planar =
          a.axis === "x" ? Math.hypot(rel[1], rel[2]) :
          a.axis === "y" ? Math.hypot(rel[0], rel[2]) :
          Math.hypot(rel[0], rel[1]);
        if (planar < 1e-9) {
          errors.push({
            line: a.line,
            msg: `orbit: "${a.target}" starts on the ${a.axis} axis through the center — no circle to travel`,
          });
          continue;
        }
        orbit = { center, axis: a.axis, deg: a.by[0] };
        to = orbitPos(orbit, from, 1);
      } else if (a.kind === "walk") {
        // ground-plane movement: x/z from the destination, height stays put
        if (a.by) {
          to = [from[0] + a.by[0], from[1], from[2] + a.by[1]];
        } else if (a.to.ref) {
          const dest = objects.get(a.to.ref);
          if (!dest) {
            errors.push({ line: a.line, msg: `to(): no object named "${a.to.ref}"` });
            continue;
          }
          if (dest.shape === "link") {
            errors.push({ line: a.line, msg: `to(): "${dest.name}" is a link — links have no placed position` });
            continue;
          }
          if (dest.heldBy) {
            errors.push({ line: a.line, msg: `to(): "${dest.name}" is held by "${dest.heldBy.ref}" — its position rides its holder; name the holder` });
            continue;
          }
          if ((dest.parent || null) !== (obj.parent || null)) {
            errors.push({
              line: a.line,
              msg: `to(): "${dest.name}" is in a different group — destinations must stay within one frame`,
            });
            continue;
          }
          const off = a.to.off || [0, 0];
          to = [dest.pos[0] + off[0], from[1], dest.pos[2] + off[1]];
        } else {
          to = [a.to[0], from[1], a.to[1]];
        }
      } else if (a.by) {
        // relative: displacement from wherever this segment starts
        to = [from[0] + a.by[0], from[1] + a.by[1], from[2] + a.by[2]];
      } else if (a.to.ref) {
        // to(name): the named object's placed (t=0) position — not its
        // animated position; there is no pursuit
        const dest = objects.get(a.to.ref);
        if (!dest) {
          errors.push({ line: a.line, msg: `to(): no object named "${a.to.ref}"` });
          continue;
        }
        if (dest.shape === "link") {
          errors.push({ line: a.line, msg: `to(): "${dest.name}" is a link — links have no placed position` });
          continue;
        }
        if (dest.heldBy) {
          errors.push({ line: a.line, msg: `to(): "${dest.name}" is held by "${dest.heldBy.ref}" — its position rides its holder; name the holder` });
          continue;
        }
        if ((dest.parent || null) !== (obj.parent || null)) {
          errors.push({
            line: a.line,
            msg: `to(): "${dest.name}" is in a different group — destinations must stay within one frame`,
          });
          continue;
        }
        const off = a.to.off || [0, 0, 0];
        to = [dest.pos[0] + off[0], dest.pos[1] + off[1], dest.pos[2] + off[2]];
      } else {
        to = a.to;
      }

      if (!obj.track) obj.track = { move: [], turn: [], paint: [] };
      obj.track[channel].push({ t0, t1, from, to, ease: a.ease, orbit });
      cursors.set(key, { end: t1, lastTo: to });
      if (t1 > duration) duration = t1;
    }

    anchorUpTo(Infinity); // trailing then blocks (checks-only beats)

    for (const o of objects.values()) {
      if (o.track) {
        o.track.move.sort((x, y) => x.t0 - y.t0);
        o.track.turn.sort((x, y) => x.t0 - y.t0);
        o.track.paint.sort((x, y) => x.t0 - y.t0);
      }
      // lifetime events are part of the timeline too
      if (o.appear > duration) duration = o.appear;
      if (o.vanish !== null && o.vanish > duration) duration = o.vanish;
    }
    return duration;
  }

  // take/drop events become per-thing POSSESSION TIMELINES: intervals of
  // "held by whom" plus drop points. A held-by() declaration is the
  // born-holding case (an open interval from birth); a take on a held
  // thing is a hand-off; drop must name the current holder — a free
  // consistency check on the transcription. Runs after buildTracks so
  // it can refuse things that also animate themselves, and returns the
  // timeline duration extended to cover the last event.
  function buildPossession(objects, events, errors, duration) {
    // a wear anchor names person anatomy — resolve it to a numeric
    // offset here, where the holder is known (order-free scenes mean
    // parse time is too early)
    const anchorOff = (holderName, anchor, line) => {
      const holder = objects.get(holderName);
      if (!holder) return null; // missing holder reported elsewhere
      if (!holder.person) {
        errors.push({
          line,
          msg: `anchor "${anchor}": "${holderName}" isn't a person — anchors are anatomy; give a numeric offset instead`,
        });
        return null;
      }
      return wearOffset(holder.person, anchor);
    };
    const byThing = new Map();
    for (const e of events) {
      // bare events were resolved in buildTracks (interleaved with the
      // segments they chain from)
      const thing = objects.get(e.thing);
      const holder = objects.get(e.holder);
      if (!thing) { errors.push({ line: e.line, msg: `${e.kind}: no object named "${e.thing}"` }); continue; }
      if (!holder) { errors.push({ line: e.line, msg: `${e.kind}: no object named "${e.holder}"` }); continue; }
      if ((thing.shape === "group" && !thing.person && !thing.animal) || thing.shape === "link" || thing.shape === "marker") {
        errors.push({ line: e.line, msg: `${e.kind}: "${e.thing}" is a ${thing.shape} — only shapes, persons, and animals can change hands` });
        continue;
      }
      if (holder.shape === "link" || holder.shape === "marker") {
        errors.push({ line: e.line, msg: `${e.kind}: "${e.holder}" is a ${holder.shape} — it can't hold things` });
        continue;
      }
      if (e.holder === e.thing) { errors.push({ line: e.line, msg: `${e.kind}: "${e.thing}" can't hold itself` }); continue; }
      if (!byThing.has(e.thing)) byThing.set(e.thing, []);
      byThing.get(e.thing).push(e);
      if (e.t > duration) duration = e.t;
    }

    for (const [name, evs] of byThing) {
      const o = objects.get(name);
      evs.sort((x, y) => x.t - y.t || x.line - y.line);
      let bad = false;
      for (let i = 1; i < evs.length; i++) {
        if (evs[i].t === evs[i - 1].t) {
          errors.push({
            line: evs[i].line,
            msg: `two possession events for "${name}" at the same time — order them` +
              ` (or, if "${evs[i - 1].holder}" should keep holding it, take "${evs[i - 1].holder}" instead — chains carry)`,
          });
          bad = true;
        }
      }
      // the position channel belongs to the object until possession first
      // claims it: a clue may walk the token into a room (its placement),
      // and a later take carries it from there — only movement scheduled
      // AFTER the first event conflicts
      const firstT = evs[0].t;
      if (o.track) {
        for (const chn of ["move", "turn"]) {
          const lateSeg = o.track[chn].find((s) => s.t1 > firstT);
          if (lateSeg) {
            errors.push({
              line: evs[0].line,
              msg: `"${name}" still ${chn === "move" ? "moves" : "turns"} after its first take/drop (at ${firstT}) — its position belongs to possession from there on; drop the event's at() so it chains to the ${chn === "move" ? "walk" : "turn"}'s end, finish the animation earlier, or animate the holder`,
            });
            bad = true;
          }
        }
      }
      if (bad) continue;
      const intervals = [];
      const drops = [];
      let cur = o.heldBy
        ? {
            t0: 0, holder: o.heldBy.ref,
            off: (o.heldBy.anchor && anchorOff(o.heldBy.ref, o.heldBy.anchor, o.line)) || o.heldBy.off,
          }
        : null;
      for (const e of evs) {
        if (e.kind === "take") {
          if (cur) intervals.push({ ...cur, t1: e.t }); // hand-off
          cur = { t0: e.t, holder: e.holder, off: (e.anchor && anchorOff(e.holder, e.anchor, e.line)) || e.off };
        } else if (!cur || cur.holder !== e.holder) {
          errors.push({
            line: e.line,
            msg: `drop: at that time "${name}" is held by ${cur ? `"${cur.holder}"` : "nobody"}, not "${e.holder}"`,
          });
        } else {
          intervals.push({ ...cur, t1: e.t });
          drops.push({ t: e.t, holder: e.holder, pos: null });
          cur = null;
        }
      }
      if (cur) intervals.push({ ...cur, t1: null });
      o.possession = { intervals, drops };
    }

    // pure held-by things get the same timeline shape: one open interval
    for (const o of objects.values()) {
      if (o.heldBy && !o.possession) {
        const off = (o.heldBy.anchor && anchorOff(o.heldBy.ref, o.heldBy.anchor, o.line)) || o.heldBy.off;
        o.possession = { intervals: [{ t0: 0, t1: null, holder: o.heldBy.ref, off }], drops: [] };
      }
    }
    return duration;
  }

  // Drop points freeze where the holder stood: computed once per compile,
  // in event order, so a chain (drop the purse, the letter inside stays
  // with it) reads earlier drops' already-frozen positions.
  function resolveDrops(compiled) {
    const all = [];
    for (const o of compiled.objects) {
      if (o.possession) for (const d of o.possession.drops) all.push({ o, d });
    }
    all.sort((x, y) => x.d.t - y.d.t);
    for (const { o, d } of all) {
      const h = poseAt(compiled, d.t).get(d.holder);
      if (!h) continue;
      // dropped things land: ground-rest at the holder's spot (persons
      // and animals are base-anchored — their origin IS the ground)
      const restY = o.person || o.animal ? 0 : o.dims.h / 2;
      d.pos = [h.pos[0], restY, h.pos[2]];
    }
  }

  // Camera segments become two channels (position + aim), chained like
  // animation channels. Runs after resolution: to(name) needs placed
  // positions. The camera never extends the timeline — projection has
  // no events.
  function buildCamera(objects, cameras, errors) {
    if (!cameras.length) return null;
    const pos = [];
    const look = [];
    let cursor = 0;
    for (const c of cameras) {
      const err = (msg) => errors.push({ line: c.line, msg });
      const t0 = c.start !== null ? c.start : cursor + (c.after || 0);
      const over = c.over !== null ? c.over : c.to ? 1 : 0;
      const t1 = t0 + over;
      cursor = t1;
      let bad = false;
      const checkRef = (ref, what) => {
        const t = objects.get(ref);
        if (!t) { err(`camera ${what}(): no object named "${ref}"`); bad = true; return null; }
        if (t.shape === "link" || t.shape === "marker") {
          err(`camera ${what}(): "${ref}" is a ${t.shape} — no pose to ${what === "from" ? "ride" : "aim at"}`);
          bad = true;
          return null;
        }
        return t;
      };
      if (c.to && c.to.ref !== undefined) {
        const t = checkRef(c.to.ref, "to");
        if (t) {
          // a room: hover at eye height inside it; anything else: its
          // bounds center — plus the optional slide
          const base = t.room
            ? [t.pos[0], t.pos[1] + 1.6, t.pos[2]]
            : [t.pos[0] + t.bboxOff[0], t.pos[1] + t.bboxOff[1], t.pos[2] + t.bboxOff[2]];
          c.to = [base[0] + c.to.off[0], base[1] + c.to.off[1], base[2] + c.to.off[2]];
        }
      }
      if (c.from) checkRef(c.from.ref, "from");
      if (c.look && c.look.ref) checkRef(c.look.ref, "look");
      if (bad) continue;
      if (c.to) pos.push({ kind: "to", t0, t1, to: c.to, ease: c.ease });
      else if (c.from) pos.push({ kind: "mount", t0, ref: c.from.ref });
      if (c.look) look.push({ t0, t1, ...c.look, ease: c.ease });
    }
    // a dolly starts wherever the camera last was: the previous target,
    // or — after a mount — the mount's pose at the dolly's start (a
    // dynamic value, resolved at sample time)
    for (let i = 0; i < pos.length; i++) {
      if (pos[i].kind !== "to") continue;
      const prev = pos[i - 1];
      pos[i].fromPos = !prev
        ? pos[i].to.slice()
        : prev.kind === "to"
          ? prev.to.slice()
          : { mountRef: prev.ref };
    }
    return { pos, look };
  }

  // Pure camera sampling: {pos, look, mount} at time t, or null before
  // the first segment (the renderer keeps its free camera). Mounted
  // cameras ride at eye height and face along their carrier's motion.
  function sampleCamera(compiled, t) {
    const cam = compiled.camera;
    if (!cam || !cam.pos.length || t < cam.pos[0].t0) return null;
    const byName = new Map(compiled.objects.map((o) => [o.name, o]));
    const map = poseAt(compiled, t);
    const eyeOf = (name, m) => {
      const o = (m || map).get(name);
      const src = byName.get(name);
      const eyeY = src && src.person ? src.person.h * 0.87 : o.bboxOff ? o.bboxOff[1] : 0;
      return [o.pos[0], o.pos[1] + eyeY, o.pos[2]];
    };
    let p = null;
    let mount = null;
    let mountHorizon = -1; // most recent mount start ≤ t — aim history restarts there
    for (const s of cam.pos) {
      if (t < s.t0) break;
      if (s.kind === "mount") {
        p = eyeOf(s.ref);
        mount = s.ref;
        mountHorizon = s.t0;
      } else {
        mount = null;
        let f = s.fromPos;
        if (f.mountRef) f = eyeOf(f.mountRef, poseAt(compiled, s.t0));
        if (t >= s.t1) p = s.to;
        else {
          const k = EASES[s.ease]((t - s.t0) / (s.t1 - s.t0));
          p = [f[0] + (s.to[0] - f[0]) * k, f[1] + (s.to[1] - f[1]) * k, f[2] + (s.to[2] - f[2]) * k];
        }
      }
    }
    // aim: the governing look segment (a name tracks live; a compass is
    // a direction from wherever the camera is), else the carrier's
    // facing when mounted, else the scene origin
    const lookPoint = (s) => {
      if (s.ref) {
        const o = map.get(s.ref);
        return [o.pos[0] + (o.bboxOff ? o.bboxOff[0] : 0), o.pos[1] + (o.bboxOff ? o.bboxOff[1] : 0), o.pos[2] + (o.bboxOff ? o.bboxOff[2] : 0)];
      }
      if (s.dir) return [p[0] + s.dir[0] * 10, p[1] + s.dir[1] * 10, p[2] + s.dir[2] * 10];
      return s.at;
    };
    let active = null;
    let prev = null;
    for (const s of cam.look) {
      if (t < s.t0) break;
      // a mount is an aim HORIZON: looks declared before it never
      // apply at or after it — not while mounted (the approach dolly's
      // look(holmes) must not leave the mounted camera staring down
      // its own body) and not on the way out (the pull-back must not
      // lerp FROM that stale aim either). Aim history restarts at the
      // mount; a look declared at or after it wins normally.
      if (s.t0 < mountHorizon) continue;
      prev = active;
      active = s;
    }
    let lk;
    if (active) {
      const cur = lookPoint(active);
      if (prev && t < active.t1 && active.t1 > active.t0) {
        const pv = lookPoint(prev);
        const k = EASES[active.ease]((t - active.t0) / (active.t1 - active.t0));
        lk = [pv[0] + (cur[0] - pv[0]) * k, pv[1] + (cur[1] - pv[1]) * k, pv[2] + (cur[2] - pv[2]) * k];
      } else lk = cur;
    } else if (mount) {
      // face along the carrier's motion: the active or most recent move
      // segment's direction; a never-moved carrier faces its rotation
      const src = byName.get(mount);
      let dir = null;
      if (src && src.track) {
        for (const s of src.track.move) {
          if (s.t0 > t) break;
          if (s.orbit || !s.from || !s.to) continue;
          const d = [s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]];
          if (Math.hypot(d[0], d[1], d[2]) > 1e-9) dir = d;
        }
      }
      if (!dir) dir = matVec(eulerToMat((src && src.rot) || [0, 0, 0]), [0, 0, -1]);
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      lk = [p[0] + (dir[0] / len) * 10, p[1] + (dir[1] / len) * 10, p[2] + (dir[2] / len) * 10];
    } else {
      lk = [0, 0.5, 0];
    }
    return { pos: p, look: lk, mount };
  }

  // Value of one channel at time t: base before the first segment,
  // interpolating inside a segment, holding the last reached value between
  // and after segments.
  function sampleChannel(segs, base, t) {
    let value = base;
    for (const s of segs) {
      if (t >= s.t1) { value = s.to; continue; }
      if (t >= s.t0) {
        const k = EASES[s.ease]((t - s.t0) / (s.t1 - s.t0));
        value = s.orbit
          ? orbitPos(s.orbit, s.from, k)
          : [
              s.from[0] + (s.to[0] - s.from[0]) * k,
              s.from[1] + (s.to[1] - s.from[1]) * k,
              s.from[2] + (s.to[2] - s.from[2]) * k,
            ];
      }
      break;
    }
    return value;
  }

  // The color channel at time t: the settled color (string, or null for
  // "birth color" — the renderer's palette pick), plus a mix while a fade
  // is in flight. Color math stays out of the core: a mix hands the
  // renderer {from, to, k} and lerping is its problem.
  function samplePaint(segs, base, t) {
    let value = base;
    let mix = null;
    for (const s of segs) {
      if (t >= s.t1) { value = s.to; continue; }
      if (t >= s.t0 && s.t1 > s.t0) {
        mix = { from: s.from, to: s.to, k: EASES[s.ease]((t - s.t0) / (s.t1 - s.t0)) };
      }
      break;
    }
    return { value, mix };
  }

  // Position along an orbit at fraction k of the sweep: rotate the start
  // point around the axis through the center. Built on eulerToMat so a
  // positive arc turns exactly the way turn() does around the same axis.
  function orbitPos(orbit, from, k) {
    const angle = orbit.deg * k;
    const e =
      orbit.axis === "x" ? [angle, 0, 0] :
      orbit.axis === "y" ? [0, angle, 0] :
      [0, 0, angle];
    const rel = [from[0] - orbit.center[0], from[1] - orbit.center[1], from[2] - orbit.center[2]];
    const v = matVec(eulerToMat(e), rel);
    return [orbit.center[0] + v[0], orbit.center[1] + v[1], orbit.center[2] + v[2]];
  }

  // ------------------------------------------------------- rotation math
  // Row-major 3x3 matrices; Euler order XYZ in degrees (R = Rx·Ry·Rz),
  // matching the three.js default so renderers can use rot directly.

  const DEG = Math.PI / 180;

  function eulerToMat(e) {
    const cx = Math.cos(e[0] * DEG), sx = Math.sin(e[0] * DEG);
    const cy = Math.cos(e[1] * DEG), sy = Math.sin(e[1] * DEG);
    const cz = Math.cos(e[2] * DEG), sz = Math.sin(e[2] * DEG);
    return [
      cy * cz, -cy * sz, sy,
      cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy,
      sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy,
    ];
  }

  function matMul(a, b) {
    const m = new Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        m[r * 3 + c] =
          a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      }
    }
    return m;
  }

  function matVec(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
  }

  function matToEuler(m) {
    const sy = Math.max(-1, Math.min(1, m[2]));
    const y = Math.asin(sy);
    let x, z;
    if (Math.abs(sy) < 0.9999999) {
      x = Math.atan2(-m[5], m[8]);
      z = Math.atan2(-m[1], m[0]);
    } else {
      x = Math.atan2(m[7], m[4]); // gimbal lock: fold z into x
      z = 0;
    }
    return [x / DEG, y / DEG, z / DEG];
  }

  // The whole scene at time t: posed objects in WORLD space (group members
  // compose through their ancestors' transforms) plus query answers, which
  // are time-dependent (a sight line can open and close as things move, and
  // objects only exist inside their [appear, vanish) window).
  function sample(compiled, t) {
    const map = poseAt(compiled, t);
    return { t, objects: [...map.values()], results: evalQueries(compiled.queries, map, compiled.sets) };
  }

  // Just the poses (name -> posed object), shared by sample() and the
  // temporal-query sweep, which asks the same questions at many times.
  function poseAt(compiled, t) {
    const byName = new Map(compiled.objects.map((o) => [o.name, o]));

    const locals = new Map();
    for (const o of compiled.objects) {
      locals.set(o.name, {
        pos: o.track ? sampleChannel(o.track.move, o.pos, t) : o.pos,
        rot: o.track ? sampleChannel(o.track.turn, o.rot, t) : o.rot,
        present: t >= o.appear && (o.vanish === null || t < o.vanish),
      });
    }

    const worlds = new Map();
    function worldOf(name) {
      if (worlds.has(name)) return worlds.get(name);
      const o = byName.get(name);
      const l = locals.get(name);
      let w;
      if (!o.parent) {
        w = { pos: l.pos, rot: l.rot, mat: eulerToMat(l.rot), present: l.present };
      } else {
        const p = worldOf(o.parent);
        const off = matVec(p.mat, l.pos);
        const mat = matMul(p.mat, eulerToMat(l.rot));
        w = {
          pos: [p.pos[0] + off[0], p.pos[1] + off[1], p.pos[2] + off[2]],
          rot: matToEuler(mat),
          mat,
          present: l.present && p.present, // absent group hides its members
        };
      }
      worlds.set(name, w);
      return w;
    }

    const out = new Map(
      compiled.objects.map((o) => {
        const w = worldOf(o.name);
        const posed = { ...o, pos: w.pos, rot: w.rot, present: w.present };
        if (o.track && o.track.paint.length) {
          const p = samplePaint(o.track.paint, o.color, t);
          posed.color = p.value;
          if (p.mix) posed.colorMix = p.mix;
        }
        return [o.name, posed];
      }),
    );

    // possessed things derive from their possession timeline: placed
    // normally before any take, riding the holder while held (offset
    // rotated with the holder like a pocket), resting at the frozen
    // drop point after a drop. Chains resolve holder-first (the letter
    // in the purse in the hand); repeat's spread/jitter composes on top.
    const heldDone = new Set();
    // a held/dropped GROUP (person, animal) moves as a unit: once its
    // frame pose is overridden, its members re-derive from the new
    // frame (their main-pass world poses used the placed frame)
    function reposeMembers(groupName) {
      const gw = out.get(groupName);
      const gmat = eulerToMat(gw.rot);
      for (const o2 of compiled.objects) {
        if (o2.parent !== groupName) continue;
        const l = locals.get(o2.name);
        const off2 = matVec(gmat, l.pos);
        const mat2 = matMul(gmat, eulerToMat(l.rot));
        out.set(o2.name, {
          ...out.get(o2.name),
          pos: [gw.pos[0] + off2[0], gw.pos[1] + off2[1], gw.pos[2] + off2[2]],
          rot: matToEuler(mat2),
          present: l.present && gw.present,
        });
      }
    }
    function deriveHeld(name) {
      if (heldDone.has(name)) return;
      heldDone.add(name);
      const o = byName.get(name);
      const P = o.possession;
      const iv = P.intervals.find((v) => t >= v.t0 && (v.t1 === null || t < v.t1));
      const p = out.get(name);
      const extra = o.offset || [0, 0, 0];
      if (iv) {
        const holder = byName.get(iv.holder);
        if (!holder) return; // missing holder already errored at compile
        if (holder.possession) deriveHeld(holder.name);
        const h = out.get(holder.name);
        const m = eulerToMat(h.rot);
        // concealed = at the holder's BOUNDS center, not frame origin —
        // a person group's origin is at their feet; the pocket is at
        // the chest (plain shapes: bboxOff is zero, nothing changes)
        const bOff = holder.bboxOff ? matVec(m, holder.bboxOff) : [0, 0, 0];
        const off = matVec(m, iv.off);
        // center the held thing's UNION at the carry point (a person or
        // animal group's origin is at its feet — subtract its own
        // bounds offset, rotated with the ride; plain shapes: zero)
        const own = o.bboxOff ? matVec(m, o.bboxOff) : [0, 0, 0];
        out.set(name, {
          ...p,
          pos: [
            h.pos[0] + bOff[0] + off[0] + extra[0] - own[0],
            h.pos[1] + bOff[1] + off[1] + extra[1] - own[1],
            h.pos[2] + bOff[2] + off[2] + extra[2] - own[2],
          ],
          rot: h.rot,
          present: p.present && h.present,
          // the full holder chain at this instant, nearest first — the
          // carries() query reads it (the snake in the bag in the hand
          // is carried by all three... well, by the bag and the hand)
          carriedBy: [iv.holder, ...(h.carriedBy || [])],
        });
        if (o.shape === "group") reposeMembers(name);
        return;
      }
      let last = null;
      for (const d of P.drops) if (d.t <= t && d.pos) last = d;
      if (last) {
        out.set(name, {
          ...p,
          pos: [last.pos[0] + extra[0], last.pos[1] + extra[1], last.pos[2] + extra[2]],
        });
        if (o.shape === "group") reposeMembers(name);
      }
      // before the first take: the ordinary placed pose already in `out`
    }
    for (const o of compiled.objects) if (o.possession) deriveHeld(o.name);

    // links derive last, from their endpoints' posed world positions
    for (const o of compiled.objects) {
      if (o.shape !== "link") continue;
      const p = out.get(o.name);
      const e0 = out.get(o.between[0]);
      const e1 = out.get(o.between[1]);
      if (!e0 || !e1) continue; // endpoint errors already reported
      const d = [e1.pos[0] - e0.pos[0], e1.pos[1] - e0.pos[1], e1.pos[2] - e0.pos[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      let rot = [0, 0, 0];
      if (len > 1e-9) {
        const dir = [d[0] / len, d[1] / len, d[2] / len];
        // orthonormal basis with +y along the link (cylinders point +y)
        const up = Math.abs(dir[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
        let ax = [
          up[1] * dir[2] - up[2] * dir[1],
          up[2] * dir[0] - up[0] * dir[2],
          up[0] * dir[1] - up[1] * dir[0],
        ];
        const al = Math.hypot(ax[0], ax[1], ax[2]);
        ax = [ax[0] / al, ax[1] / al, ax[2] / al];
        const az = [
          ax[1] * dir[2] - ax[2] * dir[1],
          ax[2] * dir[0] - ax[0] * dir[2],
          ax[0] * dir[1] - ax[1] * dir[0],
        ];
        rot = matToEuler([
          ax[0], dir[0], az[0],
          ax[1], dir[1], az[1],
          ax[2], dir[2], az[2],
        ]);
      }
      out.set(o.name, {
        ...p,
        pos: [(e0.pos[0] + e1.pos[0]) / 2, (e0.pos[1] + e1.pos[1]) / 2, (e0.pos[2] + e1.pos[2]) / 2],
        rot, len,
        ep0: e0.pos.slice(), ep1: e1.pos.slice(),
        present: p.present && e0.present !== false && e1.present !== false,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- queries

  // World bounds follow the posed rotation: the axis-aligned box around the
  // rotated shape. Exact at 90° steps (a lying body blocks low, not tall),
  // conservative in between (a 45° box blocks as its enclosing box).
  // Spheres skip this — rotation cannot change their bounds, and the box
  // formula would wrongly inflate them.
  function aabb(o) {
    // a posed link: the box around its live endpoints, fattened by r
    if (o.shape === "link" && o.ep0) {
      return {
        min: [
          Math.min(o.ep0[0], o.ep1[0]) - o.r,
          Math.min(o.ep0[1], o.ep1[1]) - o.r,
          Math.min(o.ep0[2], o.ep1[2]) - o.r,
        ],
        max: [
          Math.max(o.ep0[0], o.ep1[0]) + o.r,
          Math.max(o.ep0[1], o.ep1[1]) + o.r,
          Math.max(o.ep0[2], o.ep1[2]) + o.r,
        ],
      };
    }
    let hw = o.dims.w / 2, hh = o.dims.h / 2, hd = o.dims.d / 2;
    if (o.shape !== "sphere" && (o.rot[0] || o.rot[1] || o.rot[2])) {
      const m = eulerToMat(o.rot);
      const ex = Math.abs(m[0]) * hw + Math.abs(m[1]) * hh + Math.abs(m[2]) * hd;
      const ey = Math.abs(m[3]) * hw + Math.abs(m[4]) * hh + Math.abs(m[5]) * hd;
      const ez = Math.abs(m[6]) * hw + Math.abs(m[7]) * hh + Math.abs(m[8]) * hd;
      hw = ex; hh = ey; hd = ez;
    }
    return {
      min: [o.pos[0] - hw, o.pos[1] - hh, o.pos[2] - hd],
      max: [o.pos[0] + hw, o.pos[1] + hh, o.pos[2] + hd],
    };
  }

  // Contact: no axis separated by more than a hair — exact face/edge
  // contact counts, interpenetration counts (touching conductors
  // conduct either way), a visible gap does not. The complement of
  // overlaps' strictness: overlaps excludes touching, touches includes
  // overlapping.
  const TOUCH_EPS = 1e-4;
  function restsOn(A, B) {
    return A.min[0] < B.max[0] && B.min[0] < A.max[0]
        && A.min[2] < B.max[2] && B.min[2] < A.max[2]
        && Math.abs(A.min[1] - B.max[1]) <= TOUCH_EPS;
  }
  function boxesTouch(A, B) {
    for (let i = 0; i < 3; i++) {
      if (A.min[i] - B.max[i] > TOUCH_EPS || B.min[i] - A.max[i] > TOUCH_EPS) return false;
    }
    return true;
  }

  // Strict overlap: objects merely touching (resting on) do not overlap.
  function boxesOverlap(A, B) {
    for (let i = 0; i < 3; i++) {
      if (!(A.min[i] < B.max[i] && A.max[i] > B.min[i])) return false;
    }
    return true;
  }

  // Where segment p0→p1 enters an AABB, as t in [0,1), or null if it misses.
  // Strict, matching overlaps(): grazing a face or edge does not count.
  function segmentEntersAABB(p0, p1, box) {
    let tEnter = 0;
    let tExit = 1;
    for (let i = 0; i < 3; i++) {
      const d = p1[i] - p0[i];
      if (Math.abs(d) < 1e-12) {
        if (p0[i] <= box.min[i] || p0[i] >= box.max[i]) return null;
      } else {
        let t1 = (box.min[i] - p0[i]) / d;
        let t2 = (box.max[i] - p0[i]) / d;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tEnter) tEnter = t1;
        if (t2 < tExit) tExit = t2;
        if (tEnter >= tExit) return null;
      }
    }
    return tEnter;
  }

  // Spatial helpers over one posed instant, shared by instant queries and
  // the temporal sweep.
  function spatialEngine(objects) {
    const kids = new Map(); // group name -> present members (posed)
    for (const o of objects.values()) {
      if (o.parent && objects.has(o.parent)) {
        if (!kids.has(o.parent)) kids.set(o.parent, []);
        kids.get(o.parent).push(o);
      }
    }

    // one pose = one box per object: aabb() does rotation math, and a
    // sight sweep asks for the same boxes once per PAIR without this
    const boxCache = new Map();
    function aabbOf(o) {
      let b = boxCache.get(o);
      if (!b) {
        b = aabb(o);
        boxCache.set(o, b);
      }
      return b;
    }

    // World bounds: shapes use their own box; a group is the union of its
    // present members' bounds (a point at its origin if it has none).
    // An OPEN room (walls(0)) has no walls to union — its bounds are its
    // declared interior at full height, so in(x yard) works on a pad.
    function boundsOf(o) {
      if (o.room && o.room.thick === 0) {
        const [w, h, d] = o.room.size;
        return {
          min: [o.pos[0] - w / 2, o.pos[1], o.pos[2] - d / 2],
          max: [o.pos[0] + w / 2, o.pos[1] + h, o.pos[2] + d / 2],
        };
      }
      if (o.shape !== "group") return aabbOf(o);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      let any = false;
      for (const c of kids.get(o.name) || []) {
        if (c.present === false) continue;
        const b = boundsOf(c);
        any = true;
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], b.min[i]);
          max[i] = Math.max(max[i], b.max[i]);
        }
      }
      return any ? { min, max } : { min: o.pos.slice(), max: o.pos.slice() };
    }

    function centerOf(o) {
      const b = boundsOf(o);
      return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    }

    // Is o inside group a or b? Members never block their own sight line.
    function underEndpoint(o, aName, bName) {
      // carried things never shield their carrier: a pocketed gem sits
      // at the thief's center, but a sight line TO the thief must not
      // hit it (the reverse — the body concealing the gem — still holds,
      // because there the gem is the endpoint and the body the blocker)
      if (o.carriedBy && (o.carriedBy.includes(aName) || o.carriedBy.includes(bName))) return true;
      let cur = o;
      while (cur && cur.parent) {
        if (cur.parent === aName || cur.parent === bName) return true;
        cur = objects.get(cur.parent);
      }
      return false;
    }

    // Solid things blocking segment p0→p1, nearest first. Groups themselves
    // never block (their bbox spans empty space); their members do.
    function blockersBetween(p0, p1, a, b) {
      const hits = [];
      for (const o of objects.values()) {
        if (o === a || o === b || o.shape === "group" || o.shape === "marker" || o.glass || o.present === false) continue;
        if (underEndpoint(o, a.name, b.name)) continue;
        const t = segmentEntersAABB(p0, p1, aabbOf(o));
        if (t !== null) hits.push({ name: o.name, t });
      }
      hits.sort((x, y) => x.t - y.t);
      return hits;
    }

    // boolean form for sweeps: the first blocker settles it
    function anyBlocker(p0, p1, a, b) {
      for (const o of objects.values()) {
        if (o === a || o === b || o.shape === "group" || o.shape === "marker" || o.glass || o.present === false) continue;
        if (underEndpoint(o, a.name, b.name)) continue;
        if (segmentEntersAABB(p0, p1, aabbOf(o)) !== null) return true;
      }
      return false;
    }

    function distance(a, b) {
      const ca = centerOf(a), cb = centerOf(b);
      const dx = ca[0] - cb[0], dy = ca[1] - cb[1], dz = ca[2] - cb[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    return { boundsOf, centerOf, blockersBetween, anyBlocker, distance };
  }

  // in(a b): a's center strictly inside b's bounds (touching the boundary
  // doesn't count, consistent with overlaps and sight-line grazing)
  function centerInside(a, b, eng) {
    const c = eng.centerOf(a);
    const bb = eng.boundsOf(b);
    return (
      c[0] > bb.min[0] && c[0] < bb.max[0] &&
      c[1] > bb.min[1] && c[1] < bb.max[1] &&
      c[2] > bb.min[2] && c[2] < bb.max[2]
    );
  }

  // Shared guard rails for a query with a set argument.
  function validateSetQuery(q, aIsSet, bIsSet, sets, label) {
    if (aIsSet && bIsSet) return `${label} — one set per query`;
    if (!BOOLEAN_QUERIES.has(q.fn)) {
      return `${label} — ${q.fn} can't take a set (sets work with ${[...BOOLEAN_QUERIES].join(", ")})`;
    }
    if (q.except) {
      const setName = aIsSet ? q.args[0] : q.args[1];
      const members = sets.get(setName);
      const bad = q.except.find((e) => !members.includes(e));
      if (bad) return `${label} — except(): "${bad}" isn't in ${setName}`;
    }
    return null;
  }

  function pairTruth(fn, a, b, eng) {
    if (a.present === false || b.present === false) return false;
    if (fn === "overlaps") return boxesOverlap(eng.boundsOf(a), eng.boundsOf(b));
    if (fn === "in") return centerInside(a, b, eng);
    // carries(a b): a holds b at this instant, through any chain —
    // possession data, not geometry (poseAt stamps the holder chain)
    if (fn === "carries") return !!(b.carriedBy && b.carriedBy.includes(a.name));
    if (fn === "touches") return boxesTouch(eng.boundsOf(a), eng.boundsOf(b));
    // on(a b): a RESTS directly on b — footprints share interior and
    // a's underside meets b's top within a hair. Resting, not hovering:
    // a disk sliding OVER a stack mid-move doesn't trigger (the Hanoi
    // legality gate must survive transit)
    if (fn === "on") return restsOn(eng.boundsOf(a), eng.boundsOf(b));
    return !eng.anyBlocker(eng.centerOf(a), eng.centerOf(b), a, b);
  }

  // Is the boolean query true at this posed instant? Absent objects make
  // any predicate about them false — you can't see what isn't there.
  // A set argument means "some member": in(suspects room) is true when
  // any (non-excepted) member satisfies it. Returns the witness's name
  // for sets, true for plain args, false otherwise.
  function truthAt(q, objects, eng, sets) {
    const expandArg = (n) => {
      if (!objects.has(n) && sets && sets.has(n)) {
        const ex = q.except || [];
        return sets.get(n).filter((m) => !ex.includes(m));
      }
      return [n];
    };
    for (const an of expandArg(q.args[0])) {
      for (const bn of expandArg(q.args[1])) {
        const a = objects.get(an);
        const b = objects.get(bn);
        if (!a || !b) continue;
        if (pairTruth(q.fn, a, b, eng)) return an !== q.args[0] ? an : bn !== q.args[1] ? bn : true;
      }
    }
    return false;
  }

  // Every member that satisfies a set query at this instant — truthAt
  // stops at the first witness (right for temporal sweeps); an instant
  // ANSWER should name the whole candidate set.
  function witnessesAt(q, objects, eng, sets) {
    const ex = q.except || [];
    const expandArg = (n) =>
      !objects.has(n) && sets && sets.has(n) ? sets.get(n).filter((m) => !ex.includes(m)) : [n];
    const out = [];
    for (const an of expandArg(q.args[0])) {
      for (const bn of expandArg(q.args[1])) {
        const a = objects.get(an);
        const b = objects.get(bn);
        if (!a || !b) continue;
        if (pairTruth(q.fn, a, b, eng)) {
          const w = an !== q.args[0] ? an : bn !== q.args[1] ? bn : null;
          if (w !== null) out.push(w);
        }
      }
    }
    return out;
  }

  function evalQueries(queries, objects, sets) {
    const eng = spatialEngine(objects);
    const { boundsOf, centerOf, blockersBetween, distance } = eng;
    sets = sets || new Map();

    return queries.map((q) => {
      const label = `${q.quant ? q.quant + " " : ""}${q.fn}(${q.args.join(", ")})`;
      if (q.args.length !== 2) {
        return { line: q.line, error: true, text: `${label} — expected 2 object names` };
      }
      const missing = q.args.find((n) => !objects.has(n) && !sets.has(n));
      if (missing) {
        return { line: q.line, error: true, text: `${label} — no object or set named "${missing}"` };
      }
      const [a, b] = q.args.map((n) => objects.get(n));
      const aIsSet = !a && sets.has(q.args[0]);
      const bIsSet = !b && sets.has(q.args[1]);

      if (q.quant || q.at !== null || q.check || q.fn === "adjacent") {
        // answered once, at compile (evalTemporal/evalAdjacents) —
        // quantified, pinned to a fixed at(time), asserted, or static;
        // the viewport still gets a live sight line for "now"
        const result = {
          line: q.line, error: !!(q.temp && q.temp.error), fn: q.fn, quant: q.quant,
          check: q.check, args: q.args,
          value: q.temp ? q.temp.value : null,
          text: q.temp ? q.temp.text : `${label} — not evaluated`,
        };
        if (q.temp && q.temp.members) result.members = q.temp.members;
        if (!result.error && q.fn === "sees" && a && b && a.present !== false && b.present !== false) {
          const p0 = centerOf(a), p1 = centerOf(b);
          result.sight = { from: p0, to: p1, hits: blockersBetween(p0, p1, a, b) };
        }
        return result;
      }

      // a set argument: "some member" — answered with a witness
      if (aIsSet || bIsSet) {
        const setErr = validateSetQuery(q, aIsSet, bIsSet, sets, label);
        if (setErr) return { line: q.line, error: true, text: setErr };
        const other = aIsSet ? b : a;
        if (other && other.present === false) {
          return {
            line: q.line, error: false, fn: q.fn, args: q.args, value: null,
            text: `${label} → — (${other.name} not present)`,
          };
        }
        const witnesses = witnessesAt(q, objects, eng, sets);
        return {
          line: q.line, error: false, fn: q.fn, args: q.args,
          value: witnesses.length > 0,
          witnesses,
          text: `${label} → ${witnesses.length > 0}${witnesses.length ? ` (${witnesses.join(", ")})` : ""}`,
        };
      }

      if (q.except) {
        return { line: q.line, error: true, text: `${label} — except() needs a set argument` };
      }
      const result = { line: q.line, error: false, fn: q.fn, args: q.args };

      // Questions about objects that don't exist right now have no answer.
      const absent = [a, b].filter((o) => o.present === false).map((o) => o.name);
      if (absent.length) {
        result.value = null;
        result.text = `${label} → — (${absent.join(", ")} not present)`;
        return result;
      }

      switch (q.fn) {
        case "overlaps":
          result.value = boxesOverlap(boundsOf(a), boundsOf(b));
          result.text = `${label} → ${result.value}`;
          break;
        case "carries":
          result.value = !!(b.carriedBy && b.carriedBy.includes(a.name));
          result.text = `${label} → ${result.value}`;
          break;
        case "touches":
          result.value = boxesTouch(boundsOf(a), boundsOf(b));
          result.text = `${label} → ${result.value}`;
          break;
        case "on":
          result.value = restsOn(boundsOf(a), boundsOf(b));
          result.text = `${label} → ${result.value}`;
          break;
        case "in":
          result.value = centerInside(a, b, { centerOf, boundsOf });
          result.text = `${label} → ${result.value}`;
          break;
        case "distance":
          result.value = Math.round(distance(a, b) * 100) / 100;
          result.text = `${label} → ${result.value}`;
          break;
        case "sees":
        case "blocked-by": {
          const p0 = centerOf(a), p1 = centerOf(b);
          const hits = blockersBetween(p0, p1, a, b);
          // sight-line data for renderers: endpoints + where it was cut off
          result.sight = { from: p0, to: p1, hits };
          if (q.fn === "sees") {
            result.value = hits.length === 0;
            result.text = result.value
              ? `${label} → true`
              : `${label} → false (blocked by ${hits.map((h) => h.name).join(", ")})`;
          } else {
            result.value = hits.map((h) => h.name);
            result.text = `${label} → ${result.value.length ? result.value.join(", ") : "nothing"}`;
          }
          break;
        }
      }
      return result;
    });
  }

  // ------------------------------------------------------ temporal queries
  //
  // ever/always/when quantify a boolean query over the whole timeline
  // [0, duration] instead of one instant. Answered once, at compile: the
  // scene is sampled at every segment boundary and lifetime event plus a
  // dense sweep, and each truth-flip is refined by bisection, so range
  // edges are accurate far beyond the sweep resolution. (A predicate true
  // only inside one sweep step could still be missed — facts, sampled.)

  const SWEEP_STEPS = 256;

  // ------------------------------------------------------------------ facts
  //
  // v3 groundwork. Derive the compiled timeline into discrete GROUND
  // FACTS an inference engine (or an LLM, or a reader) can consume. The
  // core knows geometry, not detectives: what's exported is what IS true
  // in the modeled world — whereabouts intervals, adjacency, sets, named
  // times, lifetimes. Domain rules (murderer, alibi, opportunity) live
  // OUTSIDE the language, in whatever consumes these facts.
  function deriveFacts(compiled) {
    // the horizon: the world persists after its last event, and a named
    // time may point past it (time_of_death after everyone stops moving) —
    // facts must cover wherever a rule can ask
    const D = Math.max(compiled.duration, ...compiled.times.values(), 0);
    const byName = new Map(compiled.objects.map((o) => [o.name, o]));
    const rooms = compiled.objects.filter((o) => o.room);
    // movers: things whose whereabouts mean something — not rooms, not
    // structure (room walls, tube segments, markers), not frames or
    // derived links
    const partOfStructure = (o) => {
      for (let p = o.parent; p; ) {
        const po = byName.get(p);
        if (!po) return false;
        if (po.room || po.tube || po.person || po.animal) return true;
        p = po.parent;
      }
      return false;
    };
    // person groups ARE movers (facts speak "bob", not "bob-head" —
    // their members are excluded above, like room walls)
    const movers = compiled.objects.filter(
      (o) => !o.room && (o.shape !== "group" || o.person || o.animal) && o.shape !== "marker" && o.shape !== "link" && !partOfStructure(o),
    );

    // sight facts are exported for SET MEMBERS only — the cast you've
    // named is the cast rules reason about. All-pairs would be
    // O(n²·sweep) and grind big scenes on every compile.
    const castAll = [...new Set([...compiled.sets.values()].flat())]
      .map((n) => byName.get(n))
      .filter((o) => o && o.shape !== "marker");
    // sight pairs: shapes only — except person groups, whose union
    // center is a chest-height endpoint the sees() machinery already
    // handles; order admits groups too (rooms in a set get left_of
    // facts — the zebra houses)
    const cast = castAll.filter((o) => o.shape !== "group" || o.person || o.animal);
    const castPairs = [];
    for (let i = 0; i < cast.length; i++) {
      for (let j = i + 1; j < cast.length; j++) castPairs.push([cast[i], cast[j]]);
    }

    const whereabouts = [];
    const visible = [];
    const touching = [];
    if ((rooms.length && movers.length) || castPairs.length) {
      // one shared grid (segment boundaries + lifetime events + sweep),
      // one pose pass per grid time — facts are grid-resolution, like
      // temporal queries: sampled facts, not symbolic proofs
      const grid = new Set([0, D]);
      const clampD = (t) => Math.min(Math.max(t, 0), D);
      for (const o of compiled.objects) {
        grid.add(clampD(o.appear));
        if (o.vanish !== null) grid.add(clampD(o.vanish));
        if (o.track) {
          for (const chn of ["move", "turn", "paint"]) {
            for (const s of o.track[chn]) {
              grid.add(clampD(s.t0));
              grid.add(clampD(s.t1));
            }
          }
        }
        if (o.possession) {
          for (const iv of o.possession.intervals) {
            grid.add(clampD(iv.t0));
            if (iv.t1 !== null) grid.add(clampD(iv.t1));
          }
        }
      }
      for (let i = 0; i <= SWEEP_STEPS; i++) grid.add((D * i) / SWEEP_STEPS);
      const ts = [...grid].sort((x, y) => x - y);

      const round2 = (t) => Math.round(t * 100) / 100;
      const open = new Map(); // "a|b" -> range start (rooms and sight share)
      const ranges = new Map(); // "a|b" -> [[t0,t1]...]
      const track = (key, truth, t) => {
        if (truth && !open.has(key)) {
          open.set(key, t);
        } else if (!truth && open.has(key)) {
          if (!ranges.has(key)) ranges.set(key, []);
          ranges.get(key).push([open.get(key), t]);
          open.delete(key);
        }
      };
      for (const t of ts) {
        const map = poseAt(compiled, t);
        const eng = spatialEngine(map);
        for (const m of movers) {
          const mo = map.get(m.name);
          for (const r of rooms) {
            track(m.name + "|" + r.name, mo.present !== false && centerInside(mo, map.get(r.name), eng), t);
          }
        }
        for (const [a, b] of castPairs) {
          track(a.name + "@" + b.name, pairTruth("sees", map.get(a.name), map.get(b.name), eng), t);
          // contact facts share the same pairs and grid: face-to-face
          // or overlapping = in contact (the circuit's conductivity,
          // the ladder against the window)
          track(a.name + "~" + b.name, pairTruth("touches", map.get(a.name), map.get(b.name), eng), t);
        }
      }
      for (const [key, t0] of open) {
        if (!ranges.has(key)) ranges.set(key, []);
        ranges.get(key).push([t0, D]);
      }
      const rounded = (rs) => rs.map(([a, b]) => [round2(a), round2(b)]);
      for (const m of movers) {
        for (const r of rooms) {
          const rs = ranges.get(m.name + "|" + r.name);
          if (rs) whereabouts.push({ name: m.name, room: r.name, ranges: rounded(rs) });
        }
      }
      for (const [a, b] of castPairs) {
        const rs = ranges.get(a.name + "@" + b.name);
        if (rs) visible.push({ a: a.name, b: b.name, ranges: rounded(rs) });
        const ts2 = ranges.get(a.name + "~" + b.name);
        if (ts2) touching.push({ a: a.name, b: b.name, ranges: rounded(ts2) });
      }
    }

    // order facts: where things ENDED UP — the horizon pose, so a
    // deduction-time timeline exports its SOLVED arrangement. Set
    // members only, like sight. left_of(a, b): a's center is west
    // (-x) of b's, matching the west-of placement relation.
    const leftOf = [];
    if (castAll.length >= 2) {
      const endMap = poseAt(compiled, D);
      for (const a of castAll) {
        for (const b of castAll) {
          if (a === b) continue;
          if (endMap.get(a.name).pos[0] < endMap.get(b.name).pos[0] - 1e-6) leftOf.push([a.name, b.name]);
        }
      }
    }

    // possession is declared, not derived: held-by() and take/drop in
    // the scene text ARE the facts — exported as who-held-what intervals
    // (open holds close at the horizon, like whereabouts)
    const has = [];
    for (const o of compiled.objects) {
      if (!o.possession) continue;
      for (const iv of o.possession.intervals) {
        if (!byName.has(iv.holder)) continue;
        has.push([iv.holder, o.name, Math.min(iv.t0, D), iv.t1 === null ? D : Math.min(iv.t1, D)]);
      }
    }

    return {
      duration: D,
      rooms: rooms.map((r) => r.name),
      adjacent: [...compiled.adjacency].map((k) => k.split("|")),
      sets: Object.fromEntries(compiled.sets),
      times: Object.fromEntries(compiled.times),
      lifetimes: movers
        .filter((o) => o.appear > 0 || o.vanish !== null)
        .map((o) => ({ name: o.name, appear: o.appear, vanish: o.vanish })),
      whereabouts,
      visible,
      touches: touching,
      leftOf,
      has,
    };
  }

  // Prolog-text rendering of compiled.facts — the exchange format for a
  // rules layer, an engine, or an LLM. Times are timeline seconds.
  function prologFacts(compiled) {
    const f = compiled.facts;
    const atom = (s) => (/^[a-z][a-zA-Z0-9_]*$/.test(s) ? s : `'${String(s).replace(/'/g, "\\'")}'`);
    const lines = ["% ground facts derived from the scene — times in timeline seconds"];
    if (compiled.clock) lines.push(`clock(${compiled.clock.start}, ${compiled.clock.minute}).`);
    lines.push(`duration(${f.duration}).`);
    for (const r of f.rooms) lines.push(`room(${atom(r)}).`);
    for (const [a, b] of f.adjacent) {
      lines.push(`adjacent(${atom(a)}, ${atom(b)}).`);
      lines.push(`adjacent(${atom(b)}, ${atom(a)}).`); // symmetric, closed here so rules stay trivial
    }
    for (const [s, members] of Object.entries(f.sets)) {
      for (const m of members) lines.push(`set_member(${atom(s)}, ${atom(m)}).`);
    }
    for (const [n, v] of Object.entries(f.times)) lines.push(`time_fact(${atom(n)}, ${v}).`);
    for (const lt of f.lifetimes) {
      lines.push(`lifetime(${atom(lt.name)}, ${lt.appear}, ${lt.vanish === null ? "inf" : lt.vanish}).`);
    }
    for (const w of f.whereabouts) {
      for (const [t0, t1] of w.ranges) lines.push(`in(${atom(w.name)}, ${atom(w.room)}, ${t0}, ${t1}).`);
    }
    for (const v of f.visible || []) {
      // sight is symmetric (center-to-center); closed here so rules stay trivial
      for (const [t0, t1] of v.ranges) {
        lines.push(`visible(${atom(v.a)}, ${atom(v.b)}, ${t0}, ${t1}).`);
        lines.push(`visible(${atom(v.b)}, ${atom(v.a)}, ${t0}, ${t1}).`);
      }
    }
    for (const v of f.touches || []) {
      // contact is symmetric; closed here so rules stay trivial
      for (const [t0, t1] of v.ranges) {
        lines.push(`touches(${atom(v.a)}, ${atom(v.b)}, ${t0}, ${t1}).`);
        lines.push(`touches(${atom(v.b)}, ${atom(v.a)}, ${t0}, ${t1}).`);
      }
    }
    for (const [a, b] of f.leftOf || []) {
      lines.push(`left_of(${atom(a)}, ${atom(b)}).`); // end-of-timeline arrangement
    }
    for (const [holder, thing, t0, t1] of f.has || []) {
      lines.push(`has(${atom(holder)}, ${atom(thing)}, ${t0}, ${t1}).`); // declared possession interval
    }
    return lines.join("\n") + "\n";
  }

  // adjacent(a b): a static fact read off the door(to) graph — answered
  // once at compile, constant while scrubbing. True iff a shared door
  // connects the two rooms directly (no transitivity; that would be a
  // future connected()).
  function evalAdjacents(compiled, errors) {
    const byName = new Map(compiled.objects.map((o) => [o.name, o]));
    for (const q of compiled.queries) {
      if (q.fn !== "adjacent") continue;
      const label = `${q.check ? "check " : ""}adjacent(${q.args.join(", ")})`;
      const bad = (msg) => {
        q.temp = { error: true, value: null, text: `${label} — ${msg}` };
        if (q.check) errors.push({ line: q.line, msg: q.temp.text });
      };
      if (q.args.length !== 2) { bad("expected two room names"); continue; }
      const notRoom = q.args.find((n) => { const o = byName.get(n); return !o || !o.room; });
      if (notRoom !== undefined) { bad(`"${notRoom}" isn't a room — adjacency is a fact about rooms`); continue; }
      const value = compiled.adjacency.has([q.args[0], q.args[1]].sort().join("|"));
      q.temp = { error: false, value, text: `${label} → ${value}` };
      if (q.check) {
        q.temp.text = (value ? "✓ " : "✗ ") + q.temp.text;
        if (!value) { q.temp.error = true; errors.push({ line: q.line, msg: q.temp.text }); }
      }
    }
  }

  function evalTemporal(compiled, errors) {
    const temporal = compiled.queries.filter((q) => q.quant || q.at !== null);
    if (!temporal.length) return;
    const D = compiled.duration;
    const names = new Set(compiled.objects.map((o) => o.name));

    // with a clock, temporal answers speak wall time: "4:45–5:11"
    const ck = compiled.clock;
    const fmt = (t) => {
      if (!ck) return (Math.round(t * 100) / 100).toFixed(2);
      const totalMin = ck.start + t / ck.minute;
      let h = Math.floor(totalMin / 60);
      let m = Math.floor(totalMin - h * 60);
      let s = Math.round((totalMin - h * 60 - m) * 60);
      if (s === 60) { s = 0; m += 1; }
      if (m === 60) { m = 0; h += 1; }
      return `${h}:${String(m).padStart(2, "0")}` + (s ? `:${String(s).padStart(2, "0")}` : "");
    };
    const labelOf = (q) =>
      `${q.check ? "check " : ""}${q.quant ? q.quant + " " : ""}${q.fn}(${q.args.join(", ")})` +
      (q.except ? ` except(${q.except.join(" ")})` : "") +
      (q.at !== null ? ` at(${fmt(q.at)})` : "") +
      (q.during ? ` during(${fmt(q.during[0])} ${fmt(q.during[1])})` : "");

    const fail = (q, text) => {
      q.temp.error = true;
      if (q.check) errors.push({ line: q.line, msg: text });
    };

    const truthOne = (q, t) => {
      const map = poseAt(compiled, t);
      return truthAt(q, map, spatialEngine(map), compiled.sets) !== false;
    };
    // lo and hi disagree; return the flip point
    function refine(truth, lo, hi) {
      const hiVal = truth(hi);
      for (let i = 0; i < 24 && hi - lo > 1e-9; i++) {
        const mid = (lo + hi) / 2;
        if (truth(mid) === hiVal) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    // truth ranges of one predicate across sorted sample times
    function rangesOver(ts, truth, w1) {
      const ranges = [];
      let start = null;
      let prev = null;
      for (const t of ts) {
        const v = truth(t);
        if (v && start === null) {
          start = prev === null ? t : refine(truth, prev, t);
        } else if (!v && start !== null) {
          ranges.push([start, refine(truth, prev, t)]);
          start = null;
        }
        prev = t;
      }
      if (start !== null) ranges.push([start, w1]);
      return ranges;
    }
    const round2 = (t) => Math.round(t * 100) / 100;
    const fmtRanges = (rs) => rs.map(([s, e]) => `${fmt(s)}–${fmt(e)}`).join(", ");

    for (const q of temporal) {
      const label = labelOf(q);
      if (q.args.length !== 2) {
        q.temp = { error: true, value: null, text: `${label} — expected 2 object names` };
        if (q.check) errors.push({ line: q.line, msg: q.temp.text }); // a broken check must not pass silently
        continue;
      }
      const missing = q.args.find((n) => !names.has(n) && !compiled.sets.has(n));
      if (missing) {
        q.temp = { error: true, value: null, text: `${label} — no object or set named "${missing}"` };
        if (q.check) errors.push({ line: q.line, msg: q.temp.text });
        continue;
      }
      const aIsSet = !names.has(q.args[0]) && compiled.sets.has(q.args[0]);
      const bIsSet = !names.has(q.args[1]) && compiled.sets.has(q.args[1]);
      if (aIsSet || bIsSet) {
        const msg = validateSetQuery(q, aIsSet, bIsSet, compiled.sets, label);
        if (msg) {
          q.temp = { error: true, value: null, text: msg };
          if (q.check) errors.push({ line: q.line, msg });
          continue;
        }
      } else if (q.except) {
        q.temp = { error: true, value: null, text: `${label} — except() needs a set argument` };
        if (q.check) errors.push({ line: q.line, msg: q.temp.text });
        continue;
      }

      // pinned to one instant: evaluate the plain query at that time
      if (q.at !== null) {
        const map = poseAt(compiled, q.at);
        const inst = evalQueries(
          [{ ...q, quant: null, at: null, check: false, temp: undefined }],
          map,
          compiled.sets,
        )[0];
        let value = inst.value;
        let answer = inst.text.includes(" → ") ? inst.text.slice(inst.text.indexOf(" → ") + 3) : inst.text;
        if (q.quant === "never") {
          // "was NOT the case at that instant" — absence counts as not-there
          value = inst.value !== true;
          const who = inst.witnesses && inst.witnesses.length ? inst.witnesses.join(", ") : "it was";
          answer = `${value}${inst.value === true ? ` (${who})` : ""}`;
        }
        q.temp = { error: false, value, text: `${label} → ${answer}` };
        if (q.check) {
          const ok = value === true;
          q.temp.text = (ok ? "✓ " : "✗ ") + q.temp.text;
          if (!ok) fail(q, q.temp.text);
        }
        continue;
      }

      // quantified over a window (during, or the whole timeline)
      const w0 = q.during ? q.during[0] : 0;
      const w1 = q.during ? q.during[1] : D;
      const clampW = (t) => Math.min(Math.max(t, w0), w1);
      const times = new Set([w0, w1]);
      for (const o of compiled.objects) {
        times.add(clampW(o.appear));
        if (o.vanish !== null) times.add(clampW(o.vanish));
        if (o.track) {
          for (const chn of ["move", "turn"]) {
            for (const s of o.track[chn]) {
              times.add(clampW(s.t0));
              times.add(clampW(s.t1));
            }
          }
        }
        if (o.possession) {
          for (const iv of o.possession.intervals) {
            times.add(clampW(iv.t0));
            if (iv.t1 !== null) times.add(clampW(iv.t1));
          }
        }
      }
      for (let i = 0; i <= SWEEP_STEPS; i++) times.add(w0 + ((w1 - w0) * i) / SWEEP_STEPS);
      const ts = [...times].sort((x, y) => x - y);

      const ranges = rangesOver(ts, (t) => truthOne(q, t), w1);

      // a set argument answers per member too: WHO, not just whether —
      // "? never in(suspects room) during(...)" alibis everyone it can
      // and names the residual. always stays pooled (it's a fact about
      // the place — "never unoccupied" — not about any one member).
      let members = null;
      if ((aIsSet || bIsSet) && q.quant !== "always") {
        const setName = aIsSet ? q.args[0] : q.args[1];
        const excluded = new Set(q.except || []);
        members = [];
        for (const m of compiled.sets.get(setName)) {
          if (excluded.has(m)) continue;
          const qm = { ...q, args: aIsSet ? [m, q.args[1]] : [q.args[0], m], except: null };
          members.push({ name: m, ranges: rangesOver(ts, (t) => truthOne(qm, t), w1) });
        }
      }
      const isFull = (rs) => rs.length === 1 && rs[0][0] <= w0 + 1e-6 && rs[0][1] >= w1 - 1e-6;
      const memberDetail = () =>
        members
          .map((m) => `${m.name} ${m.ranges.length === 0 ? "never" : isFull(m.ranges) ? "always" : fmtRanges(m.ranges)}`)
          .join("; ");
      // only the members the predicate was ever true for, with their times
      const culprits = () =>
        members
          .filter((m) => m.ranges.length > 0)
          .map((m) => `${m.name} ${isFull(m.ranges) ? "always" : fmtRanges(m.ranges)}`)
          .join("; ");

      const full = isFull(ranges);
      // gaps: where the predicate was false, within the window
      const gaps = [];
      let cursor = w0;
      for (const [s, e] of ranges) {
        if (s - cursor > 1e-6) gaps.push([cursor, s]);
        cursor = e;
      }
      if (w1 - cursor > 1e-6) gaps.push([cursor, w1]);

      let value;
      let text;
      if (q.quant === "when") {
        value = ranges.map(([s, e]) => [round2(s), round2(e)]);
        text = `${label} → ${
          members ? memberDetail() : ranges.length === 0 ? "never" : full ? "always" : fmtRanges(ranges)
        }`;
      } else if (q.quant === "ever") {
        value = ranges.length > 0;
        const detail = !value ? "" :
          members ? ` (${culprits()})` :
          ranges[0][0] > w0 + 1e-6 ? ` (first at ${fmt(ranges[0][0])})` : "";
        text = `${label} → ${value}${detail}`;
      } else if (q.quant === "never") {
        value = ranges.length === 0;
        text = `${label} → ${value}${value ? "" : ` (${members ? culprits() : "true " + fmtRanges(ranges)})`}`;
      } else { // always
        value = full;
        text = `${label} → ${value}${value ? "" : ` (fails ${fmtRanges(gaps)})`}`;
      }
      q.temp = { error: false, value, text };
      if (members) q.temp.members = members.map((m) => ({ name: m.name, ranges: m.ranges.map(([s, e]) => [round2(s), round2(e)]) }));
      if (q.check) {
        const ok = value === true || (q.quant === "when" && ranges.length > 0);
        q.temp.text = (ok ? "✓ " : "✗ ") + q.temp.text;
        if (!ok) fail(q, q.temp.text);
      }
    }
  }

  // ------------------------------------------------------------------- API

  function compile(src) {
    const { objects, queries, anims, events, errors, sets, goals, statements, cameras, thenBlocks, theme, view, clock, times, hypotheses, active, parts } = parse(src);
    expandRepeats(objects, anims, queries, errors);
    resolveAll(objects, errors);
    const adjacency = carveDoors(objects, errors);
    // after the carve, so a link may span a doorway/window MARKER —
    // the Speckled Band's bell-rope hangs from a ventilator
    validateLinks(objects, errors);
    const thenAnchors = new Map();
    const duration = buildPossession(objects, events, errors,
      buildTracks(objects, anims, errors, events, thenBlocks, thenAnchors));
    // queries and camera segments in then blocks learn their instant now
    for (const q of queries) {
      if (q.thenBlock != null && q.at === null) q.at = thenAnchors.get(q.thenBlock) || 0;
    }
    for (const cs of cameras) {
      if (cs.thenBlock != null && cs.start === null && cs.after === null) {
        cs.start = thenAnchors.get(cs.thenBlock) || 0;
      }
    }

    // named sets queries can quantify over: repeat families come free
    // (every family of copies is a set), explicit `set` statements on top
    const setMap = new Map();
    for (const o of objects.values()) {
      if (o.family && !o.family.includes("/")) {
        if (!setMap.has(o.family)) setMap.set(o.family, []);
        setMap.get(o.family).push(o.name);
      }
    }
    for (const s of sets.values()) {
      if (objects.has(s.name)) {
        errors.push({ line: s.line, msg: `set "${s.name}" collides with an object of the same name` });
        continue;
      }
      const missing = s.members.find((mn) => !objects.has(mn));
      if (missing) {
        errors.push({ line: s.line, msg: `set ${s.name}: no object named "${missing}"` });
        continue;
      }
      setMap.set(s.name, s.members.slice());
    }

    // statement speakers must exist — a typo'd speaker would silently
    // drop out of the liar certificate
    for (const st of statements) {
      if (!objects.has(st.speaker)) {
        errors.push({ line: st.line, msg: `statement: no object named "${st.speaker}"` });
      }
    }

    const compiled = { objects: [...objects.values()], queries, duration, errors, theme, view, clock, times, adjacency, goals, statements, hypotheses, active, parts, sets: setMap };
    compiled.camera = buildCamera(objects, cameras, errors); // projection only — after resolution, before nothing
    resolveDrops(compiled); // freeze drop points before anything samples poses
    evalAdjacents(compiled, errors); // failed adjacency checks are compile errors
    evalTemporal(compiled, errors); // failed checks are compile errors
    compiled.facts = deriveFacts(compiled); // v3 groundwork: the world as ground facts
    errors.sort((a, b) => a.line - b.line);
    compiled.results = sample(compiled, 0).results;
    return compiled;
  }

  const Schauplatz = { compile, sample, sampleCamera, prolog: prologFacts, version: "0.52.0" };

  if (typeof module !== "undefined" && module.exports) module.exports = Schauplatz;
  global.Schauplatz = Schauplatz;
})(typeof window !== "undefined" ? window : globalThis);
