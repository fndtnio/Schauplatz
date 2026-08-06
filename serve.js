#!/usr/bin/env node
// Tiny dev server — zero dependencies, `npm run serve`.
//
// Static serving plus ONE extra ability: write-back. The playground
// probes GET /__dev; when it answers, the save button writes the
// current buffer to its .scene file instead of downloading. Everything
// else (GitHub Pages, iframes, python -m http.server) keeps the
// download path — the static story is untouched.
//
//   GET  /__dev            -> {"dev":true}   (the probe)
//   PUT  /<path>.scene     -> writes the file (inside this dir only)
//   GET  <anything else>   -> static file
//
// No auth, local use only — don't expose this to a network you don't trust.

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 8003;
const MIME = {
  html: "text/html; charset=utf-8", js: "text/javascript", json: "application/json",
  md: "text/markdown; charset=utf-8", scene: "text/plain; charset=utf-8",
  pl: "text/plain; charset=utf-8", css: "text/css", png: "image/png",
  webp: "image/webp", svg: "image/svg+xml",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/__dev") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end('{"dev":true}');
    }
    const fp = path.normalize(path.join(ROOT, url));
    if (fp !== ROOT && !fp.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end("outside root");
    }
    if (req.method === "PUT") {
      if (!fp.endsWith(".scene")) {
        res.writeHead(403);
        return res.end("only .scene files are writable");
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        fs.mkdir(path.dirname(fp), { recursive: true }, () => {
          fs.writeFile(fp, body, (e) => {
            if (e) {
              res.writeHead(500);
              res.end(String(e));
            } else {
              res.writeHead(204);
              res.end();
              console.log("wrote", path.relative(ROOT, fp));
            }
          });
        });
      });
      return;
    }
    const file = url === "/" ? path.join(ROOT, "index.html") : fp;
    fs.readFile(file, (e, data) => {
      if (e) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).slice(1)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`port ${PORT} is taken (an old python -m http.server?) — stop it, or: PORT=8001 npm run serve`);
      process.exit(1);
    }
    throw e;
  })
  .listen(PORT, () => console.log(`schauplatz dev server: http://localhost:${PORT} (save writes back to files)`));
