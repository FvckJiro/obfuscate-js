# lua obfuscator — client-side, netlify-ready

pure JS, no backend, no build step. drag this folder onto Netlify (or any
static host) and it works immediately — nothing to install, no lua runtime
needed server-side because there IS no server.

## deploy on netlify
drag the whole `netobf/` folder onto netlify.com/drop, or:
```
git init && git add . && git commit -m init
```
push to GitHub, then Netlify → Add new site → import from Git → build
command: (leave blank) → publish directory: `/` → deploy.

## layers
- **string encryption** — every string literal replaced with a keyed
  byte-array + inline decoder (`(v+k+i)%256` scramble, pure arithmetic,
  runs on lua5.1 with zero bitlib dependency)
- **identifier mangling** — every non-reserved identifier renamed to
  randomized garbage, consistent across all its uses in the file
- **VM-wrap** — the whole processed script is split into line-chunks,
  stored as a quoted string array, and executed via `loadstring`/`load`
  at runtime — so the shipped file is an interpreter stub + opaque data,
  not readable Lua
- **junk injection** — dead no-op statements scattered before the real
  payload, density adjustable 0–10 in the UI

seed is randomized per run (`Date.now() ^ random`), so obfuscating the
same input twice never produces byte-identical output.

## known limits (be straight with yourself about this)
- identifier renaming is regex/token-based, not a full AST parse — it
  skips `foo.bar`/`foo:bar` field access correctly, but table-constructor
  keys (`{foo = 1}`) are a known blind spot: if `foo` as a bare key
  collides with a renamed local elsewhere in the same file, test your
  output before shipping it. always run obfuscated output through the
  target runtime before relying on it.
- this raises the bar against casual script-kiddie copy-paste theft and
  static string-grep. it does not stop a determined reverse engineer with
  a debugger attached to a live loadstring call — nothing client-side-only
  does. for real protection of logic you can't let the client see at all
  (loot tables, anti-cheat checks), that has to live server-side instead.
