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

## roblox deployment
Roblox's Luau sandbox disables `loadstring`/`load` for untrusted/dynamic code
in both LocalScripts and Scripts — the VM-wrap layer depends on that function
existing, so **check "targeting roblox" in the UI** before obfuscating. This
auto-disables VM-wrap and ships string encryption + identifier mangling only,
both of which are pure Luau with no dynamic exec dependency — fully supported
on real Roblox clients/servers, ModuleScripts included.

If you obfuscate with VM-wrap left on and paste the result into Roblox, it
will throw `this environment has no loadstring/load` at runtime — that's the
generated code failing loudly instead of silently doing nothing, which is
correct behavior, not a bug to report.

## anti-pattern-matching
Two independent cipher families (multiplicative+rolling vs two-stage
additive) are randomly selected once per obfuscation run — same obfuscator,
different decoder shape every time, so there's no single fixed template for
a tool (AI or otherwise) to learn and generalize across every output you
produce. Combined with unique per-literal keys, shuffled+encrypted chunk
storage (when VM-wrap is on), and randomized identifier names/declaration
styles, no two runs on the same input are byte-identical.

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
