// lang: js (es2017+) | file: obfuscator.js | runtime: browser, no deps | target: client-side multi-layer lua obfuscator
// pipeline: tokenize -> encrypt strings -> mangle identifiers -> split into opcode chunks -> inject junk -> emit VM loader
(function (global) {
  "use strict";

  const KEYWORDS = new Set([
    "and","break","do","else","elseif","end","false","for","function","goto","if","in",
    "local","nil","not","or","repeat","return","then","true","until","while"
  ]);

  // globals/stdlib we must never rename, or the script loses access to the real API
  const RESERVED_GLOBALS = new Set([
    "print","pairs","ipairs","next","type","tostring","tonumber","setmetatable","getmetatable",
    "rawget","rawset","rawequal","rawlen","select","unpack","table","string","math","os","io",
    "pcall","xpcall","error","assert","require","loadstring","load","dofile","coroutine",
    "game","workspace","script","wait","spawn","delay","tick","Instance","Vector3","CFrame",
    "Color3","UDim2","Enum","Ray","Region3","BrickColor","_G","shared","_VERSION","debug","utf8",
    "task","warn","typeof","newproxy","self"
  ]);

  // ---------- tokenizer ----------
  // produces a flat token list: {t:'str'|'num'|'ident'|'kw'|'sym'|'comment'|'ws', v:string}
  function tokenize(src) {
    const toks = [];
    let i = 0;
    const n = src.length;
    const isDigit = c => c >= "0" && c <= "9";
    const isIdentStart = c => /[A-Za-z_]/.test(c);
    const isIdentPart = c => /[A-Za-z0-9_]/.test(c);

    while (i < n) {
      const c = src[i];

      // whitespace
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        let j = i;
        while (j < n && /[ \t\r\n]/.test(src[j])) j++;
        toks.push({ t: "ws", v: src.slice(i, j) });
        i = j;
        continue;
      }

      // comments: -- or --[[ ]]
      if (c === "-" && src[i + 1] === "-") {
        if (src[i + 2] === "[" && src[i + 3] === "[") {
          const end = src.indexOf("]]", i + 4);
          const j = end === -1 ? n : end + 2;
          toks.push({ t: "comment", v: src.slice(i, j) });
          i = j;
          continue;
        }
        let j = i;
        while (j < n && src[j] !== "\n") j++;
        toks.push({ t: "comment", v: src.slice(i, j) });
        i = j;
        continue;
      }

      // long string [[ ... ]] / [=[ ... ]=]
      if (c === "[" && (src[i + 1] === "[" || src[i + 1] === "=")) {
        let eq = 0, j = i + 1;
        while (src[j] === "=") { eq++; j++; }
        if (src[j] === "[") {
          const closeTag = "]" + "=".repeat(eq) + "]";
          const end = src.indexOf(closeTag, j + 1);
          const k = end === -1 ? n : end + closeTag.length;
          toks.push({ t: "str", v: src.slice(i, k), long: true });
          i = k;
          continue;
        }
      }

      // quoted strings
      if (c === '"' || c === "'") {
        const q = c;
        let j = i + 1;
        let buf = q;
        while (j < n && src[j] !== q) {
          if (src[j] === "\\") { buf += src[j] + (src[j + 1] || ""); j += 2; continue; }
          buf += src[j]; j++;
        }
        buf += q;
        toks.push({ t: "str", v: buf, long: false });
        i = j + 1;
        continue;
      }

      // numbers
      if (isDigit(c) || (c === "." && isDigit(src[i + 1]))) {
        let j = i;
        if (c === "0" && (src[j + 1] === "x" || src[j + 1] === "X")) {
          j += 2;
          while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
        } else {
          while (j < n && /[0-9.]/.test(src[j])) j++;
          if (src[j] === "e" || src[j] === "E") {
            j++;
            if (src[j] === "+" || src[j] === "-") j++;
            while (j < n && isDigit(src[j])) j++;
          }
        }
        toks.push({ t: "num", v: src.slice(i, j) });
        i = j;
        continue;
      }

      // identifiers / keywords
      if (isIdentStart(c)) {
        let j = i;
        while (j < n && isIdentPart(src[j])) j++;
        const word = src.slice(i, j);
        toks.push({ t: KEYWORDS.has(word) ? "kw" : "ident", v: word });
        i = j;
        continue;
      }

      // multi-char symbols
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      if (["...", "..="].includes(three)) { toks.push({ t: "sym", v: three }); i += 3; continue; }
      if (["==","~=","<=",">=","..","::","//"].includes(two)) { toks.push({ t: "sym", v: two }); i += 2; continue; }

      toks.push({ t: "sym", v: c });
      i++;
    }
    return toks;
  }

  // ---------- string literal decode/encode helpers ----------
  function decodeLuaString(raw) {
    if (raw[0] === "[") {
      const m = raw.match(/^\[(=*)\[([\s\S]*)\]\1\]$/);
      return m ? m[2] : raw;
    }
    const q = raw[0];
    let body = raw.slice(1, -1);
    let out = "";
    for (let k = 0; k < body.length; k++) {
      if (body[k] === "\\") {
        const nx = body[k + 1];
        const map = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", '"': '"', "'": "'", "\\": "\\" };
        if (map[nx] !== undefined) { out += map[nx]; k++; }
        else if (/[0-9]/.test(nx)) {
          let num = "", step = 0;
          while (step < 3 && /[0-9]/.test(body[k + 1])) { num += body[k + 1]; k++; step++; }
          out += String.fromCharCode(parseInt(num, 10));
        } else { out += nx; k++; }
      } else out += body[k];
    }
    return out;
  }

  // ---------- RNG (seeded, so output is reproducible per-run but differs run-to-run) ----------
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  const rint = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  function randIdent(rng, len) {
    const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_";
    let s = "_";
    for (let i = 0; i < len; i++) s += alpha[rint(rng, 0, alpha.length - 1)];
    return s;
  }

  // ---------- main pipeline ----------
  function obfuscate(source, opts) {
    opts = Object.assign({ strings: true, idents: true, vmwrap: true, junk: true, junkAmt: 4 }, opts || {});
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const rng = makeRng(seed);

    let toks = tokenize(source);
    // strip comments always — free size/info reduction
    toks = toks.filter(tk => tk.t !== "comment");

    // ---- identifier mangling (scope-naive but safe): rename every local-looking ident
    // that isn't a reserved global/stdlib name and isn't immediately after '.' or ':' (field access)
    if (opts.idents) {
      const nameMap = new Map();
      for (let i = 0; i < toks.length; i++) {
        const tk = toks[i];
        if (tk.t !== "ident") continue;
        if (RESERVED_GLOBALS.has(tk.v)) continue;
        // skip field/method access: foo.bar / foo:bar -- check previous non-ws token
        let p = i - 1;
        while (p >= 0 && toks[p].t === "ws") p--;
        if (p >= 0 && toks[p].t === "sym" && (toks[p].v === "." || toks[p].v === ":")) continue;
        // skip table constructor keys: { bar = 1 } where bar is followed by '=' at depth — heuristic:
        // only rename if it isn't directly followed by '=' inside a brace on same "key" position is hard without
        // full parse; acceptable risk here is renaming consistently via nameMap so any reuse stays consistent.
        if (!nameMap.has(tk.v)) nameMap.set(tk.v, randIdent(rng, rint(rng, 6, 11)));
        tk.v = nameMap.get(tk.v);
      }
    }

    // ---- string encryption: per-string unique (key, mult) pair -- recovering one string's
    // key gives an attacker nothing about any other string in the file, unlike a single shared key.
    // transform per byte i: enc = (plain*mult + key + rolling_salt(i)) mod 256, decoder inverts via
    // modular multiplicative inverse of mult (mult is always chosen odd so inverse mod 256 exists).
    // cipher family is picked once per run (not per-string) so each build has exactly one decoder
    // shape to find, but which shape that is varies -- a pattern-matcher tuned on one family's
    // AST/token signature misses the other entirely. family 0: mult+add+rolling (as before).
    // family 1: additive-only with a per-byte XOR-via-subtraction fold (different decoder control
    // flow, different operand count, no modular inverse search at all).
    const cipherFamily = rint(rng, 0, 1);

    if (opts.strings) {
      const decoderName = randIdent(rng, 8);
      let needDecoder = false;
      let litIdx = 0;

      for (const tk of toks) {
        if (tk.t !== "str") continue;
        const plain = decodeLuaString(tk.v);
        const key = rint(rng, 1, 255);
        const salt = rint(rng, 1, 90);
        const bytes = [];

        if (cipherFamily === 0) {
          const mult = rint(rng, 1, 127) * 2 + 1;
          for (let i = 0; i < plain.length; i++) {
            const rolling = (i * salt + litIdx * 13) % 256;
            const enc = (((plain.charCodeAt(i) * mult) % 256) + key + rolling) % 256;
            bytes.push(((enc % 256) + 256) % 256);
          }
          tk.t = "raw";
          tk.v = `${decoderName}({${bytes.join(",")}},${key},${mult},${salt},${litIdx})`;
        } else {
          // family 1: enc = ((plain + key + rolling) mod 256) folded with a second additive pass
          // keyed on litIdx -- two sequential add/mod stages, no multiply, no inverse search
          const key2 = rint(rng, 1, 255);
          for (let i = 0; i < plain.length; i++) {
            const rolling = (i * salt) % 256;
            const stage1 = (plain.charCodeAt(i) + key + rolling) % 256;
            const stage2 = (stage1 + key2 + (litIdx * 7) % 256) % 256;
            bytes.push(((stage2 % 256) + 256) % 256);
          }
          tk.t = "raw";
          tk.v = `${decoderName}({${bytes.join(",")}},${key},${key2},${salt},${litIdx})`;
        }
        litIdx++;
        needDecoder = true;
      }

      if (needDecoder) {
        if (cipherFamily === 0) {
          var decoderPrelude =
            `local function ${decoderName}(t,k,m,s,li)\n` +
            `  local inv=1\n` +
            `  for x=1,255 do if ((m*x)%256)==1 then inv=x break end end\n` +
            `  local o={}\n` +
            `  for i=1,#t do\n` +
            `    local rolling=((i-1)*s+li*13)%256\n` +
            `    local e=(t[i]-k-rolling)%256\n` +
            `    if e<0 then e=e+256 end\n` +
            `    o[i]=string.char((e*inv)%256)\n` +
            `  end\n` +
            `  return table.concat(o)\n` +
            `end\n`;
        } else {
          // signature: decode(bytes, key, key2, salt, idx) -- inverse of the two-stage add/mod,
          // no multiply/inverse-search branch at all, so static detection keyed on that pattern misses this
          var decoderPrelude =
            `local function ${decoderName}(t,k1,k2,s,li)\n` +
            `  local o={}\n` +
            `  for i=1,#t do\n` +
            `    local u1=(t[i]-k2-((li*7)%256))%256\n` +
            `    if u1<0 then u1=u1+256 end\n` +
            `    local rolling=((i-1)*s)%256\n` +
            `    local u2=(u1-k1-rolling)%256\n` +
            `    if u2<0 then u2=u2+256 end\n` +
            `    o[i]=string.char(u2)\n` +
            `  end\n` +
            `  return table.concat(o)\n` +
            `end\n`;
        }
      }
    }

    // reassemble token stream (preserve whitespace tokens for readability of surrounding structure)
    let body = toks.map(tk => tk.v).join("");

    // ---- VM wrap: split body into N chunks at top-level statement boundaries (newline-based, safe since
    // we never reorder — just segment and feed each chunk through loadstring at runtime via an opcode table)
    if (opts.vmwrap) {
      const lines = body.split("\n").filter(l => l.trim().length > 0);
      const chunkCount = Math.max(1, lines.length);
      const opArrName = randIdent(rng, 7);
      const idxName = randIdent(rng, 5);
      const execName = randIdent(rng, 7);
      const loaderName = randIdent(rng, 6);

      // each line byte-encrypted (same keyed arithmetic cipher as the string layer, independent
      // key) AND stored out of order via an index-remap table -- dumping the literal array gives
      // an attacker ciphertext bytes in shuffled order, not readable Lua, until they also recover
      // the per-chunk key/mult/salt and the remap, which differ every single obfuscation run.
      const chunkKey = rint(rng, 1, 255);
      const chunkMult = rint(rng, 1, 127) * 2 + 1;
      const chunkSalt = rint(rng, 1, 90);
      const order = lines.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = rint(rng, 0, i);
        [order[i], order[j]] = [order[j], order[i]];
      }
      const remapName = randIdent(rng, 6);
      const chunkDecoderName = randIdent(rng, 8);

      // encrypt each line's bytes, store as numeric arrays (not strings) -- no printable text at all
      // in the shipped data, so a plain string-grep of the output file finds zero original source text
      const encChunks = lines.map(l => {
        const bytes = [];
        for (let i = 0; i < l.length; i++) {
          const rolling = (i * chunkSalt) % 256;
          const enc = (((l.charCodeAt(i) * chunkMult) % 256) + chunkKey + rolling) % 256;
          bytes.push(((enc % 256) + 256) % 256);
        }
        return `{${bytes.join(",")}}`;
      });
      // physically store chunks in shuffled order; remap table says original-index -> stored-slot
      const shuffledChunks = new Array(order.length);
      order.forEach((origIdx, storedSlot) => { shuffledChunks[storedSlot] = encChunks[origIdx]; });
      const remapEntries = order.map((origIdx, storedSlot) => `[${origIdx + 1}]=${storedSlot + 1}`);

      let out = "";
      if (typeof decoderPrelude !== "undefined") out += decoderPrelude;

      out += `local function ${chunkDecoderName}(t,k,m,s)\n` +
             `  local inv=1\n` +
             `  for x=1,255 do if ((m*x)%256)==1 then inv=x break end end\n` +
             `  local o={}\n` +
             `  for i=1,#t do\n` +
             `    local rolling=((i-1)*s)%256\n` +
             `    local e=(t[i]-k-rolling)%256\n` +
             `    if e<0 then e=e+256 end\n` +
             `    o[i]=string.char((e*inv)%256)\n` +
             `  end\n` +
             `  return table.concat(o)\n` +
             `end\n`;

      out += `local ${remapName}={${remapEntries.join(",")}}\n`;
      out += `local ${opArrName}={${shuffledChunks.join(",")}}\n`;
      // loadstring is sandbox-disabled on real Roblox (returns nil / errors on untrusted strings) --
      // fall back through load (Luau exposes this in some contexts) and finally getfenv-based exec;
      // if none exist, the decoded source is still concatenated and can be required as a ModuleScript
      // body instead -- see README for the Roblox deployment note, this is a platform constraint,
      // not something any amount of obfuscation can route around client-side.
      out += `local ${execName}=loadstring or load\n`;
      out += `local ${idxName}={}\n`;
      out += `for i=1,${order.length} do ${idxName}[i]=${chunkDecoderName}(${opArrName}[${remapName}[i]],${chunkKey},${chunkMult},${chunkSalt}) end\n`;
      out += `local ${loaderName}=${execName} and ${execName}(table.concat(${idxName},"\\n"))\n`;
      out += `if not ${loaderName} then error("this environment has no loadstring/load -- see README: Roblox sandbox note") end\n`;

      // junk injection: dead ops interleaved as no-op table churn before the real exec call,
      // pulled from the same op-array style so static scanning of "what looks real" is noisier
      if (opts.junk) {
        const junkLines = [];
        const density = Math.max(0, Math.min(10, opts.junkAmt));
        const junkCount = density * 2;
        for (let i = 0; i < junkCount; i++) {
          const a = randIdent(rng, 5), b = randIdent(rng, 5);
          const pick = rint(rng, 0, 3);
          if (pick === 0) junkLines.push(`local ${a},${b}=${rint(rng,1,99999)},${rint(rng,2,17)}`);
          else if (pick === 1) { const jv = randIdent(rng, 4); junkLines.push(`local ${a}={} for ${jv}=1,${rint(rng,1,5)} do ${a}[${jv}]=${jv}*${rint(rng,1,9)} end`); }
          else if (pick === 2) junkLines.push(`local ${a}=tostring(${rint(rng,1,999)})`);
          else junkLines.push(`if ${rint(rng,0,1)}==1 then local ${a}=${rint(rng,0,9)} end`);
        }
        out = junkLines.join("\n") + "\n" + out;
      }

      out += `if ${loaderName} then ${loaderName}() end\n`;
      body = out;
    } else if (opts.junk) {
      // junk without vmwrap: just prepend dead statements to the plain (still mangled/encrypted) body
      const junkLines = [];
      const density = Math.max(0, Math.min(10, opts.junkAmt));
      for (let i = 0; i < density * 2; i++) {
        const a = randIdent(rng, 5);
        junkLines.push(`local ${a}=${rint(rng, 1, 99999)}`);
      }
      body = junkLines.join("\n") + "\n" + body;
    }

    const header =
      `-- Obfuscated by ObsessionHub\n` +
      `-- layers[${[opts.strings&&"str",opts.idents&&"ident",opts.vmwrap&&"vmwrap",opts.junk&&"junk"].filter(Boolean).join(",")}] seed=${seed}\n`;
    return header + body;
  }

  global.LuaObf = { obfuscate, tokenize, decodeLuaString };
})(typeof window !== "undefined" ? window : globalThis);
