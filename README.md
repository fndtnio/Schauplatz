# Schauplatz

An experiment: a tiny declarative language where 3D objects and spatial
relations are first-class, built for humans and LLMs to reason about spaces
together. The 3D view is only a projection — everything is in the code.

**[Try the live demo →](https://fndtnio.github.io/Schauplatz/)**

See [LANGUAGE.md](LANGUAGE.md) for the language spec and roadmap.

## Running

```sh
npm run serve          # python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly (file://) also works, except the examples
dropdown — browsers won't let the page fetch neighboring files. The
"open…" button loads any `.scene` file either way.

Needs internet for the CDN scripts (CodeMirror, three.js).

## Embedding

The playground is embeddable via iframe, configured by URL params:

| param | effect |
|---|---|
| `?scene=<path>` | load a scene file from the server (any path, e.g. `examples/trucking.scene`); localStorage is untouched so embeds don't clobber the playground buffer |
| `?editor=0` | hide the header and editor — visualization only, with query answers overlaid on the viewport |

```html
<!-- full playground, preloaded with a scene -->
<iframe src="/schauplatz/index.html?scene=examples/trucking.scene"
        width="900" height="500"></iframe>

<!-- visualization only -->
<iframe src="/schauplatz/index.html?scene=examples/motor.scene&editor=0"
        width="640" height="400"></iframe>
```

Host any extra `.scene` files anywhere on the same server and point
`scene=` at them — they don't need to be in `examples/` or the manifest
(the manifest only feeds the dropdown).

## Layout

| path | what |
|---|---|
| `lang.js` | the language core — pure JS, no dependencies, no rendering; the part that could be ported to another host language |
| `index.html` | the playground: editor + three.js viewport |
| `examples/*.scene` | example scenes; `manifest.json` lists them for the dropdown |
| `tests/lang.test.js` | test suite (also compiles every example as a regression fixture) |

## Tests

```sh
npm test               # node --test, no dependencies
```

Adding an example: drop a `.scene` file in `examples/` and add it to
`manifest.json` — the tests enforce that the manifest and directory match,
and that every example compiles clean.
