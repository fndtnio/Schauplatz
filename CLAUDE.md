# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

Schauplatz is a tiny declarative language for describing and querying 3D
scenes. A program is a set of **facts** about named objects and their spatial
relations — not a sequence of draw calls. The 3D view is only a projection of
the text; there is no state that isn't in the source. It's built for humans and
LLMs to reason about spaces together.

The full language spec, semantics, and roadmap live in **`LANGUAGE.md`** — read
it before touching the core. `README.md` covers running and embedding.

## Running & testing

```sh
npm run serve    # python3 -m http.server 8000, then open http://localhost:8000
npm test         # node --test tests/ — no dependencies
```

No build system. `index.html` opens directly over `file://` too (except the
examples dropdown, which needs the server to fetch neighboring files). The
playground needs internet for its CDN scripts (CodeMirror, three.js).

## Architecture

The design invariant is a hard split between **language** and **rendering**:

- **`lang.js`** — the language core. Pure JS, no dependencies, no DOM, no
  three.js. `compile(source)` returns plain data (`{ objects, results,
  errors }`); also exports `sample`, `prolog`, `version`. UMD-wrapped:
  `window.Schauplatz` in the browser, `require()` in Node. **This is the only
  place language semantics live.** Keeping it host-agnostic is deliberate —
  the language should port to another host (Rust, etc.) by translating this one
  file.
- **`index.html`** — the playground: CodeMirror editor + three.js viewport +
  controls. A renderer/UI over the core; it consumes `compile()` output and
  owns everything visual. Themes and views are rendering hints the core only
  validates and passes through.
- **`rules.pl`** — the optional inference layer. A compiled scene exports
  itself as Prolog ground facts (`compiled.facts` / `Schauplatz.prolog()`);
  the playground consults Tau Prolog with those facts plus this file to answer
  `?- goal(...)` statements. The starter rules speak detective (`could/4`,
  `sole/4`); the language core contains no domain concepts — the vocabulary
  belongs to the rules file.
- **`examples/*.scene`** — example scenes. `examples/manifest.json` lists them
  for the playground dropdown.
- **`tests/lang.test.js`** — the Node test suite (built-in `node:test`, zero
  deps). Covers the parser, engine, queries, and compiles **every** example as
  a regression fixture. The tests also enforce that `manifest.json` and the
  `examples/` directory stay in sync.

## Working rules

- **Semantics change → edit `lang.js` and extend `tests/lang.test.js`.** The
  test suite is the regression net; never let a language change land without a
  test. Rendering-only changes stay in `index.html`.
- **Keep the core DOM-free and dependency-free.** Nothing in `lang.js` may
  reach for three.js, the DOM, or an npm package. If a feature seems to need
  one, it belongs in the renderer, not the core.
- **Adding an example:** drop the `.scene` file in `examples/` and add it to
  `manifest.json` — the tests will fail until both agree, and until the scene
  compiles clean.
- **Update `LANGUAGE.md`** when you add or change a language feature; it is the
  spec, and figures are expected to reproduce from a `.scene` file alone.
- Color, themes, and views have **zero semantic weight** — no query reads them
  and no bound depends on them. Keep it that way: don't let rendering concerns
  leak into query answers.
