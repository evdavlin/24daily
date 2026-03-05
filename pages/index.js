import { useState, useEffect, useRef, useCallback } from "react";

// ── Anonymous ID ───────────────────────────────────────────────
function getOrCreateAnonId() {
  try {
    let id = localStorage.getItem("24daily_anon_id");
    if (!id) {
      id = "anon_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      localStorage.setItem("24daily_anon_id", id);
    }
    return id;
  } catch { return "anon_" + Math.random().toString(36).slice(2, 18); }
}

// ── API ────────────────────────────────────────────────────────
async function submitSession({ anonId, puzzleDate, firstSolveTime, solutionCount, solutions }) {
  const res = await fetch("/api/session/end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anonId, puzzleDate, firstSolveTime, solutionCount, solutions }),
  });
  if (!res.ok) throw new Error("Submit failed");
  return res.json();
}

// ── Deck ───────────────────────────────────────────────────────
const SUITS = ["♠","♥","♦","♣"];
const VALS  = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function buildDeck() {
  return SUITS.flatMap(suit =>
    VALS.map((display, i) => ({ suit, display, value: i+1, isRed: suit==="♥"||suit==="♦" }))
  );
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// ── Expression Canonicalizer ───────────────────────────────────
//
// Converts any expression to a stable canonical form by exploiting:
//   - Commutativity of + and ×:  a+b  === b+a
//   - Associativity  of + and ×: (a+b)+c === a+(b+c) === a+b+c
//
// Examples that collapse to the same canonical form:
//   ((5+8)+9)+2  ≡  (5+9+2)+8  ≡  (2+9)+(5+8)  →  "(((2+5)+8)+9)"
//
// Algorithm:
//   1. Parse expression string into an AST
//   2. For each + or × node: collect the entire associative chain,
//      recursively normalize each term, sort them, rebuild
//   3. For - and ÷: normalize children but preserve order
//   4. Serialize the normalized AST to a string

function canonicalize(exprStr) {
  // Strip whitespace and tokenize
  const s = exprStr.replace(/\s/g, "");
  const toks = [];
  let i = 0;
  while (i < s.length) {
    if ("()+−×÷".includes(s[i])) { toks.push(s[i]); i++; }
    else if (/\d/.test(s[i])) {
      let n = "";
      while (i < s.length && /\d/.test(s[i])) n += s[i++];
      toks.push(Number(n));
    } else i++;
  }

  let pos = 0;
  const peek = () => pos < toks.length ? toks[pos] : null;
  const consume = () => toks[pos++];

  // Recursive descent parser → AST
  function parseE() {
    let left = parseT();
    while (peek() === "+" || peek() === "−") {
      const op = consume();
      left = { op, left, right: parseT() };
    }
    return left;
  }
  function parseT() {
    let left = parseF();
    while (peek() === "×" || peek() === "÷") {
      const op = consume();
      left = { op, left, right: parseF() };
    }
    return left;
  }
  function parseF() {
    if (peek() === "(") { consume(); const e = parseE(); consume(); return e; }
    return { val: consume() };
  }

  const ast = parseE();

  // Collect all nodes in an associative chain of the same operator
  function collectChain(node, op) {
    if (node.val !== undefined) return [node];
    if (node.op !== op) return [node];
    return [...collectChain(node.left, op), ...collectChain(node.right, op)];
  }

  // Rebuild a left-leaning tree from a list of nodes
  function buildChain(nodes, op) {
    if (nodes.length === 1) return nodes[0];
    return { op, left: buildChain(nodes.slice(0, -1), op), right: nodes[nodes.length - 1] };
  }

  // Serialize AST → string (always fully parenthesized for unambiguous comparison)
  function nodeStr(node) {
    if (node.val !== undefined) return String(node.val);
    return `(${nodeStr(node.left)}${node.op}${nodeStr(node.right)})`;
  }

  // Normalize: sort commutative chains, recurse
  function normalize(node) {
    if (node.val !== undefined) return node;
    if (node.op === "+" || node.op === "×") {
      const chain = collectChain(node, node.op).map(normalize);
      chain.sort((a, b) => nodeStr(a).localeCompare(nodeStr(b)));
      return buildChain(chain, node.op);
    }
    return { op: node.op, left: normalize(node.left), right: normalize(node.right) };
  }

  return nodeStr(normalize(ast));
}

// ── Solvability checker ────────────────────────────────────────
function applyOp(a, op, b) {
  if (op==="+") return a+b;
  if (op==="−") return a-b;
  if (op==="×") return a*b;
  if (op==="÷") return Math.abs(b)<0.001 ? null : a/b;
  return null;
}

function canMake24(nums) {
  if (nums.length===1) return Math.abs(nums[0]-24)<0.001;
  for (let i=0; i<nums.length; i++) {
    for (let j=0; j<nums.length; j++) {
      if (i===j) continue;
      const rest = nums.filter((_,k)=>k!==i&&k!==j);
      const a=nums[i], b=nums[j];
      const cands=[a+b, a-b, a*b];
      if (Math.abs(b)>0.001) cands.push(a/b);
      for (const r of cands) if (canMake24([...rest, r])) return true;
    }
  }
  return false;
}

// ── Full solution enumerator ───────────────────────────────────
// Enumerates all 5 parenthesization patterns × 4! orderings × 4^3 op combos,
// then deduplicates using canonicalize() so equivalent solutions count once.
function findAllSolutions(cards) {
  const raw = new Set();
  const ops = ["+","−","×","÷"];

  function* perms(arr) {
    if (arr.length<=1) { yield arr; return; }
    for (let i=0; i<arr.length; i++)
      for (const p of perms(arr.filter((_,j)=>j!==i))) yield [arr[i],...p];
  }

  function tryAdd(expr, val) {
    if (val!==null && Math.abs(val-24)<0.001) raw.add(expr);
  }

  for (const perm of perms([0,1,2,3])) {
    const [i0,i1,i2,i3] = perm;
    const [a,b,c,d] = [cards[i0].value, cards[i1].value, cards[i2].value, cards[i3].value];
    const [da,db,dc,dd] = [cards[i0].display, cards[i1].display, cards[i2].display, cards[i3].display];

    for (const o1 of ops) for (const o2 of ops) for (const o3 of ops) {
      const ab=applyOp(a,o1,b), bc=applyOp(b,o2,c), cd=applyOp(c,o3,d);

      // Pattern 1: ((a o1 b) o2 c) o3 d
      if (ab!==null) {
        const abc=applyOp(ab,o2,c);
        tryAdd(`((${da}${o1}${db})${o2}${dc})${o3}${dd}`, applyOp(abc,o3,d));
        // Pattern 3: (a o1 b) o2 (c o3 d)
        if (cd!==null) tryAdd(`(${da}${o1}${db})${o2}(${dc}${o3}${dd})`, applyOp(ab,o2,cd));
      }
      // Pattern 2: (a o1 (b o2 c)) o3 d
      if (bc!==null) {
        tryAdd(`(${da}${o1}(${db}${o2}${dc}))${o3}${dd}`, applyOp(applyOp(a,o1,bc),o3,d));
        // Pattern 4: a o1 ((b o2 c) o3 d)
        const bcd=applyOp(bc,o3,d);
        tryAdd(`${da}${o1}((${db}${o2}${dc})${o3}${dd})`, applyOp(a,o1,bcd));
      }
      // Pattern 5: a o1 (b o2 (c o3 d))
      if (cd!==null) {
        tryAdd(`${da}${o1}(${db}${o2}(${dc}${o3}${dd}))`, applyOp(a,o1,applyOp(b,o2,cd)));
      }
    }
  }

  // Deduplicate by canonical form — keeps one representative per equivalence class
  const canonMap = new Map();
  for (const expr of raw) {
    try {
      const canon = canonicalize(expr);
      if (!canonMap.has(canon)) canonMap.set(canon, expr);
    } catch { /* skip malformed */ }
  }

  // Format for display: add spaces around operators
  return [...canonMap.values()]
    .map(s => s.replace(/([+−×÷])/g, " $1 ").replace(/\s+/g," ").trim())
    .sort();
}

// ── Daily puzzle seed (8 AM ET rollover) ──────────────────────────────
function getPuzzleDateKey() {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  if (et.getHours() < 8) et.setDate(et.getDate() - 1);
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const d = String(et.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function strToSeed(str) {
  let hash = 0;
  for (const c of str) hash = (Math.imul(31, hash) + c.charCodeAt(0)) | 0;
  return hash >>> 0;
}

function makeRng(seed) {
  // Mulberry32 — fast, deterministic, good distribution
  let s = seed;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawDailyHand() {
  const dateKey = getPuzzleDateKey();
  const rng = makeRng(strToSeed(dateKey));
  const deck = seededShuffle(buildDeck(), rng);
  // Try consecutive windows of 4 until we find a solvable hand
  for (let start = 0; start < deck.length - 3; start++) {
    const hand = deck.slice(start, start + 4);
    if (canMake24(hand.map(c => c.value))) return hand;
  }
  // Absolute fallback
  return [
    {suit:"♠",display:"4",value:4,isRed:false},
    {suit:"♥",display:"6",value:6,isRed:true},
    {suit:"♦",display:"6",value:6,isRed:true},
    {suit:"♣",display:"A",value:1,isRed:false},
  ];
}

// ── Expression evaluator ───────────────────────────────────────
function evalTokens(tokens) {
  const expr = tokens.map(t=>t.val).join("")
    .replace(/×/g,"*").replace(/÷/g,"/").replace(/−/g,"-");
  try {
    // eslint-disable-next-line no-new-func
    const r = new Function(`"use strict"; return (${expr})`)();
    return typeof r==="number"&&isFinite(r) ? r : null;
  } catch { return null; }
}

// ── Percentile helpers ─────────────────────────────────────────
function pctLabel(p) {
  if (p>=95) return "Top 5%";
  if (p>=90) return "Top 10%";
  if (p>=75) return "Top 25%";
  if (p>=50) return "Top 50%";
  return `${p}th percentile`;
}
function pctColor(p) {
  if (p>=75) return "#b45309";
  if (p>=50) return "#15803d";
  return "#6b7280";
}

// ── CSS ────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#f9f7f4;--bg2:#f2efe9;--surface:#ffffff;--border:#e5e0d8;--border2:#d4cdc2;
  --ink:#1a1714;--ink2:#4a4540;--ink3:#9a9088;
  --gold:#b45309;--gold-bg:#fef3c7;--gold-br:#fcd34d;
  --red:#b91c1c;--green:#15803d;--green-bg:#f0fdf4;--green-br:#86efac;
  --warn:#d97706;--danger:#dc2626;
  --shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.04);
  --shadow-md:0 4px 12px rgba(0,0,0,.10),0 2px 4px rgba(0,0,0,.06);
  --r:10px;
}
body{background:var(--bg);font-family:'DM Sans',sans-serif;color:var(--ink);overscroll-behavior:none}
.wrap{display:flex;flex-direction:column;height:100dvh;max-width:430px;margin:0 auto;position:relative;overflow:hidden;background:var(--bg)}

/* IDLE */
.idle{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100dvh;padding:40px 28px;text-align:center}
.idle-suit-row{display:flex;gap:8px;margin-bottom:28px}
.idle-suit{width:40px;height:56px;background:var(--surface);border:1.5px solid var(--border);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:var(--shadow)}
.logo-eyebrow{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:4px;color:var(--ink3);text-transform:uppercase;margin-bottom:4px}
.logo{font-family:'Libre Baskerville',serif;font-size:80px;font-weight:700;line-height:1;color:var(--gold);letter-spacing:-4px;margin-bottom:2px}
.logo-sub{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:4px;color:var(--ink3);text-transform:uppercase;margin-bottom:28px}
.tagline{font-size:15px;color:var(--ink2);line-height:1.75;margin-bottom:32px;font-weight:300;max-width:260px}
.idle-btns{display:flex;flex-direction:column;gap:10px;width:100%;max-width:260px}
.start-btn{background:var(--gold);color:#fff;border:none;padding:15px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;border-radius:var(--r);cursor:pointer;box-shadow:var(--shadow-md);touch-action:manipulation}
.start-btn:active{transform:scale(.97)}
.how-btn{background:transparent;color:var(--ink3);border:1.5px solid var(--border2);padding:12px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:500;border-radius:var(--r);cursor:pointer;touch-action:manipulation}
.how-btn:active{background:var(--bg2)}
.idle-date{font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);letter-spacing:1px;margin-top:24px}

/* MODAL */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;animation:fadeIn .18s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{background:var(--surface);border-radius:16px;width:100%;max-width:390px;max-height:88dvh;overflow-y:auto;animation:popUp .22s cubic-bezier(.34,1.3,.64,1);scrollbar-width:none}
.modal::-webkit-scrollbar{display:none}
@keyframes popUp{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}
.modal-hdr{display:flex;align-items:center;justify-content:space-between;padding:20px 20px 0;position:sticky;top:0;background:var(--surface);z-index:1;border-radius:16px 16px 0 0}
.modal-title{font-family:'Libre Baskerville',serif;font-size:20px;font-weight:700;color:var(--ink)}
.modal-close{background:var(--bg2);border:none;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;color:var(--ink2);touch-action:manipulation;flex-shrink:0}
.modal-body{padding:16px 20px 24px;display:flex;flex-direction:column;gap:14px}
.modal-intro{font-size:14px;color:var(--ink2);line-height:1.7}
.how-steps{display:flex;flex-direction:column;gap:11px}
.how-step{display:flex;gap:12px;align-items:flex-start}
.step-num{width:26px;height:26px;border-radius:50%;background:var(--gold-bg);border:1.5px solid var(--gold-br);display:flex;align-items:center;justify-content:center;font-family:'DM Mono',monospace;font-size:11px;font-weight:500;color:var(--gold);flex-shrink:0;margin-top:2px}
.step-body{flex:1}
.step-title{font-size:13px;font-weight:600;color:var(--ink);margin-bottom:2px}
.step-desc{font-size:12px;color:var(--ink2);line-height:1.6}
.ops-row{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
.op-chip{background:var(--bg2);border:1.5px solid var(--border);border-radius:6px;padding:5px 10px;font-family:'DM Mono',monospace;font-size:15px;color:var(--ink)}
.example-expr{background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;padding:11px 14px;font-family:'DM Mono',monospace;font-size:13px;color:var(--ink)}
.example-expr span{color:var(--gold);font-weight:500}
.score-pills{display:flex;flex-direction:column;gap:7px}
.score-pill{display:flex;align-items:center;gap:10px;background:var(--bg2);border-radius:8px;padding:9px 12px}
.score-pill-icon{font-size:16px;flex-shrink:0}
.score-pill-text{font-size:12px;color:var(--ink2);line-height:1.4}
.score-pill-text strong{color:var(--ink)}
.modal-divider{height:1px;background:var(--border)}
.modal-fine{font-size:11px;color:var(--ink3);line-height:1.6}
.modal-cta{background:var(--gold);color:#fff;border:none;padding:14px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;border-radius:var(--r);cursor:pointer;width:100%;box-shadow:var(--shadow-md);touch-action:manipulation}
.modal-cta:active{transform:scale(.98)}

/* HEADER */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:8px 14px 7px;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--surface)}
.hdr-left{display:flex;align-items:center;gap:10px}
.hdr-logo{font-family:'Libre Baskerville',serif;font-size:22px;font-weight:700;color:var(--gold)}
.hdr-date{font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3)}
.hdr-right{display:flex;align-items:center;gap:8px}
.hdr-how{background:none;border:1.5px solid var(--border2);border-radius:20px;padding:4px 11px;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;color:var(--ink2);cursor:pointer;touch-action:manipulation}.hdr-giveup{background:none;border:none;font-family:'DM Sans',sans-serif;font-size:11px;font-weight:500;color:var(--ink3);cursor:pointer;touch-action:manipulation;text-decoration:underline;text-underline-offset:2px;padding:4px 2px}
.timer{font-family:'DM Mono',monospace;font-size:26px;font-weight:500;letter-spacing:-.5px;transition:color .4s;min-width:62px;text-align:right}
.timer.ok{color:var(--green)}.timer.warn{color:var(--warn)}.timer.danger{color:var(--danger);animation:pulse .5s infinite}.timer.idle-t{color:var(--ink3);font-size:18px;letter-spacing:2px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

/* CARD GRID */
.card-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:7px 12px;flex-shrink:0}
.card-scene{perspective:900px;aspect-ratio:1/1}
.card-3d{width:100%;height:100%;position:relative;transform-style:preserve-3d;transition:transform .6s cubic-bezier(.4,0,.2,1)}
.card-3d.flipped{transform:rotateY(180deg)}
.card-back,.card-front{position:absolute;inset:0;border-radius:12px;backface-visibility:hidden;-webkit-backface-visibility:hidden}
.card-back{background:var(--bg2);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow)}
.card-back-inner{width:calc(100% - 16px);height:calc(100% - 16px);border:1.5px dashed var(--border2);border-radius:7px;display:flex;align-items:center;justify-content:center}
.card-back-lbl{font-family:'Libre Baskerville',serif;font-size:18px;font-weight:700;color:var(--border2)}
.card-front{background:var(--surface);border:2px solid var(--border);transform:rotateY(180deg);display:flex;flex-direction:column;padding:6px 8px;cursor:pointer;box-shadow:var(--shadow-md);user-select:none;touch-action:manipulation}
.card-front.red{color:var(--red)}.card-front.black{color:var(--ink)}
.card-front.used{opacity:.28;cursor:default;background:var(--bg2)}
.card-front:not(.used):active{transform:rotateY(180deg) scale(.94);border-color:var(--gold-br);box-shadow:0 0 0 3px var(--gold-bg),var(--shadow)}
.card-tl{display:flex;flex-direction:column;align-items:center;line-height:1;gap:2px;padding:5px 0 0 5px}
.card-br{display:flex;flex-direction:column;align-items:center;line-height:1;gap:2px;align-self:flex-end;padding:0 5px 5px 0}
.cv{font-family:'Libre Baskerville',serif;font-size:clamp(22px,6.5vw,32px);font-weight:700;line-height:1}
.cs{font-size:clamp(14px,4vw,20px);line-height:1}
.card-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px}
.suit-big{font-size:clamp(24px,8vw,36px);line-height:1}
.card-num-badge{font-family:'DM Mono',monospace;font-size:clamp(9px,2.2vw,11px);font-weight:500;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:1px 5px}
.card-front.red .card-num-badge{color:var(--red)}.card-front.black .card-num-badge{color:var(--ink2)}

/* SOLS STRIP */
.sols-strip{padding:2px 12px 0;display:flex;gap:5px;overflow-x:auto;flex-shrink:0;scrollbar-width:none;height:24px;align-items:center}
.sols-strip::-webkit-scrollbar{display:none}
.sol-pill{background:var(--green-bg);border:1.5px solid var(--green-br);border-radius:20px;padding:2px 8px;font-family:'DM Mono',monospace;font-size:9px;color:var(--green);white-space:nowrap;flex-shrink:0;animation:popIn .28s cubic-bezier(.34,1.56,.64,1) both}
@keyframes popIn{from{transform:scale(.5);opacity:0}to{transform:scale(1);opacity:1}}

/* EXPRESSION */
.expr-wrap{padding:3px 12px 1px;flex-shrink:0}
.expr-box{background:var(--surface);border:2px solid var(--border);border-radius:var(--r);padding:7px 11px;min-height:42px;display:flex;align-items:center;flex-wrap:wrap;gap:3px;box-shadow:var(--shadow)}
.expr-ph{font-family:'DM Mono',monospace;font-size:13px;color:var(--ink3)}
.tok{font-family:'DM Mono',monospace;font-size:18px;font-weight:500}
.tok.num{color:var(--gold)}.tok.op{color:var(--ink2)}.tok.paren{color:var(--ink3)}
.caret{display:inline-block;width:2px;height:20px;background:var(--gold);border-radius:1px;animation:blink 1s infinite;margin-left:1px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.feedback{font-family:'DM Mono',monospace;font-size:10px;padding:2px 12px;height:18px;letter-spacing:.5px;transition:color .15s}
.feedback.ok{color:var(--green)}.feedback.err{color:var(--danger)}

/* CONTROLS */
.ctrl{padding:2px 12px 6px;flex-shrink:0}
.btn-row{display:grid;gap:6px;margin-bottom:6px}
.br4{grid-template-columns:repeat(4,1fr)}
.btn{border:none;border-radius:8px;cursor:pointer;font-family:'DM Mono',monospace;font-weight:500;transition:all .1s;display:flex;align-items:center;justify-content:center;touch-action:manipulation}
.btn:active{transform:scale(.92)}
.btn-op{background:var(--surface);border:1.5px solid var(--border);color:var(--ink);font-size:22px;font-weight:700;padding:9px 0;box-shadow:var(--shadow)}
.btn-op:active{background:var(--gold-bg);border-color:var(--gold-br)}
.btn-paren{background:var(--bg2);border:1.5px solid var(--border);color:var(--ink2);font-size:19px;font-weight:600;padding:7px 0}
.btn-bksp{background:var(--bg2);border:1.5px solid var(--border);color:var(--ink2);font-size:19px;font-weight:600;padding:7px 0}
.btn-clr{background:var(--bg2);border:1.5px solid var(--border);color:var(--ink3);font-size:11px;font-weight:700;letter-spacing:1px;padding:7px 0}
.btn-solve{background:var(--gold);color:#fff;font-size:13px;letter-spacing:1.5px;padding:11px 0;border-radius:var(--r);box-shadow:var(--shadow-md);font-weight:600;width:100%}
.btn-solve:active{opacity:.9}
.btn-giveup{background:transparent;border:none;color:var(--ink3);font-size:11px;letter-spacing:.5px;padding:3px 20px;border-radius:var(--r);text-decoration:underline;text-underline-offset:2px}
.btn-giveup:active{color:var(--ink2)}
.solve-row{display:flex;flex-direction:column;align-items:center;gap:0}

/* RESULTS */
.results{display:flex;flex-direction:column;height:100dvh;overflow-y:auto;padding:22px 16px 48px;gap:12px;scrollbar-width:none;background:var(--bg)}
.results::-webkit-scrollbar{display:none}
.res-hero{text-align:center;padding-bottom:2px}
.res-emoji{font-size:40px;margin-bottom:8px}
.res-title{font-family:'Libre Baskerville',serif;font-size:26px;font-weight:700;color:var(--ink);line-height:1.15;margin-bottom:3px}
.res-date{font-family:'DM Mono',monospace;font-size:10px;color:var(--ink3);letter-spacing:2px;text-transform:uppercase}
.res-giveup-badge{display:inline-block;background:#fff3f3;border:1px solid #fca5a5;color:#dc2626;font-family:'DM Mono',monospace;font-size:9px;letter-spacing:1px;border-radius:20px;padding:2px 9px;margin-top:5px}
.today-cards{display:flex;gap:6px;justify-content:center}
.mini-card{width:34px;height:48px;border-radius:6px;background:var(--surface);border:1.5px solid var(--border);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Libre Baskerville',serif;font-size:13px;font-weight:700;line-height:1;box-shadow:var(--shadow);animation:fadeUp .4s ease both}
.mini-suit{font-size:9px;margin-top:2px}
.stat-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.stat-box{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--r);padding:14px;text-align:center;box-shadow:var(--shadow);animation:fadeUp .4s ease both}
.stat-icon{font-size:18px;margin-bottom:4px}
.stat-val{font-family:'DM Mono',monospace;font-size:26px;font-weight:500;color:var(--gold)}
.stat-lbl{font-size:10px;color:var(--ink3);letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;font-weight:500}
.pct-section{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--r);padding:14px;display:flex;flex-direction:column;gap:13px;box-shadow:var(--shadow);animation:fadeUp .4s .08s ease both}
.pct-hdr{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:3px;color:var(--ink3);text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}
.pct-players{color:var(--ink3);font-size:9px}
.pct-row{display:flex;flex-direction:column;gap:5px}
.pct-meta{display:flex;justify-content:space-between;align-items:baseline}
.pct-metric{font-size:13px;color:var(--ink2);font-weight:500}
.pct-badge{font-family:'DM Mono',monospace;font-size:12px;font-weight:500}
.pct-track{height:6px;background:var(--bg2);border-radius:3px;overflow:hidden;border:1px solid var(--border)}
.pct-fill{height:100%;border-radius:3px;transition:width 1.3s cubic-bezier(.34,1.2,.64,1)}
.pct-sub{font-family:'DM Mono',monospace;font-size:9px;color:var(--ink3);letter-spacing:.5px}
.pct-skeleton{height:6px;background:var(--bg2);border-radius:3px;overflow:hidden;position:relative;border:1px solid var(--border)}
.pct-skeleton::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(180,83,9,.15),transparent);animation:shimmer 1.4s infinite}
@keyframes shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.pct-loading{font-family:'DM Mono',monospace;font-size:9px;color:var(--ink3);letter-spacing:1px}
.sol-list{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--r);padding:14px;box-shadow:var(--shadow);animation:fadeUp .4s .12s ease both}
.sol-list-hdr{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:3px;color:var(--ink3);text-transform:uppercase;margin-bottom:10px}
.sol-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-family:'DM Mono',monospace;font-size:11px}
.sol-row:last-child{border-bottom:none}
.sol-expr{color:var(--ink)}.sol-t{color:var(--ink3);font-size:10px}
.sol-first{color:var(--gold) !important}
.all-sols{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--r);padding:14px;box-shadow:var(--shadow);animation:fadeUp .4s .16s ease both}
.all-sols-hdr{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:3px;color:var(--ink3);text-transform:uppercase;margin-bottom:3px}
.all-sols-count{font-size:11px;color:var(--ink3);margin-bottom:10px}
.all-sols-count strong{color:var(--gold)}
.all-sol-item{font-family:'DM Mono',monospace;font-size:11px;color:var(--ink2);padding:5px 0;border-bottom:1px solid var(--border);line-height:1.4}
.all-sol-item:last-child{border-bottom:none}
.all-sol-item.found{color:var(--green);font-weight:500}
.share-box{background:var(--bg2);border:1.5px solid var(--border);border-radius:var(--r);padding:14px;font-family:'DM Mono',monospace;font-size:11px;line-height:2.1;white-space:pre;color:var(--ink2);animation:fadeUp .4s .2s ease both}
.share-btn{background:var(--gold);color:#fff;border:none;padding:15px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;border-radius:var(--r);cursor:pointer;width:100%;transition:all .15s;box-shadow:var(--shadow-md);animation:fadeUp .4s .24s ease both;touch-action:manipulation}
.share-btn:active{transform:scale(.97)}.share-btn.copied{background:var(--green)}
.again-btn{background:transparent;color:var(--ink3);border:1.5px solid var(--border);padding:12px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:500;border-radius:var(--r);cursor:pointer;width:100%;touch-action:manipulation}
.again-btn:active{background:var(--bg2)}
.player-id{font-family:'DM Mono',monospace;font-size:8px;color:var(--ink3);text-align:center;letter-spacing:1px}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
`;

// ── HowToPlay Modal ────────────────────────────────────────────
function HowToPlay({ onClose, onPlay }) {
  return (
    <div className="modal-overlay" onClick={e=>{ if(e.target.className==="modal-overlay") onClose(); }}>
      <div className="modal">
        <div className="modal-hdr">
          <span className="modal-title">How to Play</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="modal-intro">
            Four cards are revealed one by one. Use all four numbers and arithmetic to make <strong>24</strong>. You have <strong>60 seconds</strong> — find as many solutions as you can.
          </p>
          <div className="how-steps">
            <div className="how-step">
              <div className="step-num">1</div>
              <div className="step-body">
                <div className="step-title">Tap the cards</div>
                <div className="step-desc">Tap each card to add its value to your expression. Each card can only be used once per solution.</div>
              </div>
            </div>
            <div className="how-step">
              <div className="step-num">2</div>
              <div className="step-body">
                <div className="step-title">Add operators &amp; parentheses</div>
                <div className="ops-row">
                  {["+","−","×","÷","(",")"].map(o=><span className="op-chip" key={o}>{o}</span>)}
                </div>
              </div>
            </div>
            <div className="how-step">
              <div className="step-num">3</div>
              <div className="step-body">
                <div className="step-title">Hit SOLVE</div>
                <div className="step-desc">If it equals 24, it counts! Clear and try a different arrangement for more solutions.</div>
              </div>
            </div>
          </div>
          <div className="example-expr">
            ( <span>8</span> − <span>2</span> ) × ( <span>3</span> + <span>1</span> ) = <span>24</span> ✓
          </div>
          <div className="score-pills">
            <div className="score-pill">
              <span className="score-pill-icon">⚡</span>
              <span className="score-pill-text"><strong>Speed Score</strong> — time to your first valid solution</span>
            </div>
            <div className="score-pill">
              <span className="score-pill-icon">🧮</span>
              <span className="score-pill-text"><strong>Volume Score</strong> — total unique solutions found</span>
            </div>
            <div className="score-pill">
              <span className="score-pill-icon">🃏</span>
              <span className="score-pill-text"><strong>J = 11, Q = 12, K = 13, A = 1</strong></span>
            </div>
          </div>
          <div className="modal-divider"/>
          <p className="modal-fine">Every puzzle is guaranteed to have at least one solution. A new puzzle drops at midnight.</p>
          {onPlay && <button className="modal-cta" onClick={onPlay}>Let&apos;s Play →</button>}
        </div>
      </div>
    </div>
  );
}

// ── PercentileBar ──────────────────────────────────────────────
function PercentileBar({ label, icon, value, loading, sublabel }) {
  const [filled, setFilled] = useState(0);
  useEffect(()=>{
    if (value!=null) { const t=setTimeout(()=>setFilled(value),200); return ()=>clearTimeout(t); }
  },[value]);
  const color = value!=null ? pctColor(value) : "var(--gold)";
  return (
    <div className="pct-row">
      <div className="pct-meta">
        <span className="pct-metric">{icon} {label}</span>
        {loading ? <span className="pct-loading">calculating…</span>
          : value!=null ? <span className="pct-badge" style={{color}}>{pctLabel(value)}</span>
          : <span className="pct-loading">—</span>}
      </div>
      {loading ? <div className="pct-skeleton"/>
        : <div className="pct-track"><div className="pct-fill" style={{width:`${filled}%`,background:color}}/></div>}
      {!loading && value!=null && sublabel && <span className="pct-sub">{sublabel}</span>}
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────
export default function App() {
  const [anonId]              = useState(()=>getOrCreateAnonId());
  const [phase, setPhase]     = useState("idle");
  const [showHow, setShowHow] = useState(false);
  const [gaveUp, setGaveUp]   = useState(false);
  const [cards, setCards]     = useState([]);
  const [allSols, setAllSols] = useState([]);
  const [allCanons, setAllCanons] = useState(new Set());
  const [flipped, setFlipped] = useState([false,false,false,false]);
  const [tokens, setTokens]   = useState([]);
  const [usedIdx, setUsedIdx] = useState(new Set());
  const [solutions, setSols]  = useState([]);
  const [firstTime, setFirst] = useState(null);
  const [timeLeft, setTime]   = useState(60);
  const [feedback, setFB]     = useState({msg:"",ok:false});
  const [copied, setCopied]   = useState(false);
  const [pct, setPct]         = useState({speedPct:null,solutionsPct:null,totalPlayers:null,loading:false});

  const t0        = useRef(null);
  const timerRef  = useRef(null);
  const solsRef   = useRef([]);
  const firstRef  = useRef(null);
  // Track found canonical forms to detect duplicates
  const foundCanonsRef = useRef(new Set());

  const dateStr    = new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
  const fullDate   = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"});
  const puzzleDate = getPuzzleDateKey();

  useEffect(()=>{ solsRef.current=solutions; },[solutions]);
  useEffect(()=>{ firstRef.current=firstTime; },[firstTime]);

  const endGame = useCallback(async (finalSols, finalFirst, didGiveUp=false)=>{
    clearInterval(timerRef.current);
    setGaveUp(didGiveUp);
    setPhase("results");
    setPct({speedPct:null,solutionsPct:null,totalPlayers:null,loading:true});
    try {
      const res = await submitSession({
        anonId, puzzleDate,
        firstSolveTime: finalFirst,
        solutionCount: finalSols.length,
        solutions: finalSols.map(s=>s.str),
      });
      setPct({...res,loading:false});
    } catch {
      setPct({speedPct:null,solutionsPct:null,totalPlayers:null,loading:false});
    }
  },[anonId,puzzleDate]);

  const startGame = useCallback(()=>{
    clearInterval(timerRef.current);
    const drawn = drawDailyHand();
    const sols   = findAllSolutions(drawn);
    // Pre-compute canonical forms of all solutions for cross-checking
    const canons = new Set(sols.map(s=>{ try{ return canonicalize(s.replace(/\s/g,"")); }catch{return s;} }));
    setCards(drawn); setAllSols(sols); setAllCanons(canons);
    setFlipped([false,false,false,false]);
    setTokens([]); setUsedIdx(new Set()); setSols([]); setFirst(null);
    setTime(60); setFB({msg:"",ok:false}); setCopied(false); setGaveUp(false);
    setPct({speedPct:null,solutionsPct:null,totalPlayers:null,loading:false});
    solsRef.current=[]; firstRef.current=null; foundCanonsRef.current=new Set();
    setShowHow(false);
    setPhase("revealing");
    [0,1,2,3].forEach(i=>setTimeout(()=>{
      setFlipped(p=>{ const n=[...p]; n[i]=true; return n; });
      if(i===3) setTimeout(()=>{ t0.current=Date.now(); setPhase("playing"); },850);
    },450+i*660));
  },[]);

  useEffect(()=>{
    if(phase!=="playing") return;
    timerRef.current=setInterval(()=>{
      setTime(t=>{
        if(t<=1){ clearInterval(timerRef.current); endGame(solsRef.current,firstRef.current); return 0; }
        return t-1;
      });
    },1000);
    return ()=>clearInterval(timerRef.current);
  },[phase,endGame]);

  const addNum = useCallback((i)=>{
    if(phase!=="playing"||usedIdx.has(i)) return;
    setTokens(p=>[...p,{type:"num",val:String(cards[i].value),cardIdx:i}]);
    setUsedIdx(p=>new Set([...p,i])); setFB({msg:"",ok:false});
  },[phase,usedIdx,cards]);

  const addOp    = useCallback((op)=>{ if(phase!=="playing") return; setTokens(p=>[...p,{type:"op",val:op}]); setFB({msg:"",ok:false}); },[phase]);
  const addParen = useCallback((v)=>{ if(phase!=="playing") return; setTokens(p=>[...p,{type:"paren",val:v}]); setFB({msg:"",ok:false}); },[phase]);

  const bksp = useCallback(()=>{
    setTokens(p=>{
      if(!p.length) return p;
      const last=p[p.length-1];
      if(last.type==="num") setUsedIdx(u=>{ const n=new Set(u); n.delete(last.cardIdx); return n; });
      return p.slice(0,-1);
    }); setFB({msg:"",ok:false});
  },[]);

  const clr = useCallback(()=>{ setTokens([]); setUsedIdx(new Set()); setFB({msg:"",ok:false}); },[]);

  const submit = useCallback(()=>{
    if(tokens.filter(t=>t.type==="num").length!==4){ setFB({msg:"Use all 4 cards first",ok:false}); return; }
    const r=evalTokens(tokens);
    if(r===null){ setFB({msg:"Invalid expression",ok:false}); return; }
    if(Math.abs(r-24)>0.0001){ setFB({msg:`= ${+r.toFixed(2)}, not 24`,ok:false}); return; }

    // Build display string, then canonicalize for duplicate check
    const str = tokens.map(t=>t.val).join(" ");
    let canon;
    try { canon = canonicalize(str.replace(/\s/g,"")); }
    catch { canon = str; }

    if(foundCanonsRef.current.has(canon)){ setFB({msg:"Already found!",ok:false}); return; }

    const elapsed=(Date.now()-t0.current)/1000;
    const sol={str,canon,time:elapsed};
    setSols(p=>[...p,sol]); solsRef.current=[...solsRef.current,sol];
    foundCanonsRef.current=new Set([...foundCanonsRef.current,canon]);
    if(!firstRef.current){ setFirst(elapsed); firstRef.current=elapsed; }
    setFB({msg:"✓  Solution found!",ok:true}); setTokens([]); setUsedIdx(new Set());
  },[tokens]);

  const giveUp = useCallback(()=>{
    clearInterval(timerRef.current);
    endGame(solsRef.current,firstRef.current,true);
  },[endGame]);

  const buildShareText = ()=>[
    `24 Daily — ${dateStr}`,
    gaveUp ? `🏳️ Gave up` : firstTime ? `⚡ First solve: ${firstTime.toFixed(1)}s` : `😓 No solves`,
    `🧮 Solutions: ${solutions.length} / ${allSols.length}`,
    pct.speedPct!=null ? `🏆 Speed: ${pctLabel(pct.speedPct)}` : null,
    pct.solutionsPct!=null ? `📊 Volume: ${pctLabel(pct.solutionsPct)}` : null,
    ``,`24daily.app`,
  ].filter(l=>l!==null).join("\n");

  const copyShare = ()=>{
    navigator.clipboard.writeText(buildShareText())
      .then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2500); }).catch(()=>{});
  };

  const timerClass=timeLeft>30?"ok":timeLeft>10?"warn":"danger";
  const fmt=s=>`${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  // ── IDLE ──────────────────────────────────────────────────────
  if(phase==="idle") return (
    <><style>{CSS}</style>
    <div className="wrap">
      <div className="idle">
        <div className="idle-suit-row">{["♠","♥","♦","♣"].map(s=><div className="idle-suit" key={s}>{s}</div>)}</div>
        <div className="logo-eyebrow">Daily</div>
        <div className="logo">24</div>
        <div className="logo-sub">Card Game</div>
        <p className="tagline">Four cards. One minute.<br/>How many ways can you make 24?</p>
        <div className="idle-btns">
          <button className="start-btn" onClick={startGame}>Play Today&apos;s Puzzle →</button>
          <button className="how-btn" onClick={()=>setShowHow(true)}>How to Play</button>
        </div>
        <p className="idle-date">{fullDate}</p>
      </div>
      {showHow && <HowToPlay onClose={()=>setShowHow(false)} onPlay={startGame}/>}
    </div></>
  );

  // ── RESULTS ───────────────────────────────────────────────────
  if(phase==="results") {
    // For highlighting found solutions in the "all solutions" list,
    // compare by canonical form
    const foundCanons = new Set(solutions.map(s=>s.canon));

    return (
      <><style>{CSS}</style>
      <div className="wrap">
        <div className="results">
          <div className="res-hero">
            <div className="res-emoji">{gaveUp?"🏳️":solutions.length===0?"😓":solutions.length>=4?"🔥":solutions.length>=2?"✨":"👍"}</div>
            <div className="res-title">{gaveUp?"Better luck tomorrow!":solutions.length===0?"No solves today":solutions.length>=4?"On fire!":solutions.length>=2?"Nice work!":"Good start!"}</div>
            <div className="res-date">{fullDate}</div>
            {gaveUp && <div className="res-giveup-badge">gave up</div>}
          </div>

          <div className="today-cards">
            {cards.map((c,i)=>(
              <div className="mini-card" key={i} style={{color:c.isRed?"var(--red)":"var(--ink)"}}>
                <span>{c.display}</span><span className="mini-suit">{c.suit}</span>
              </div>
            ))}
          </div>

          <div className="stat-row">
            <div className="stat-box">
              <div className="stat-icon">⚡</div>
              <div className="stat-val">{firstTime?`${firstTime.toFixed(1)}s`:"—"}</div>
              <div className="stat-lbl">First Solve</div>
            </div>
            <div className="stat-box" style={{animationDelay:"0.06s"}}>
              <div className="stat-icon">🧮</div>
              <div className="stat-val">
                {solutions.length}
                <span style={{fontSize:13,color:"var(--ink3)",fontFamily:"'DM Sans',sans-serif"}}> / {allSols.length}</span>
              </div>
              <div className="stat-lbl">Solutions</div>
            </div>
          </div>

          {!gaveUp && (
            <div className="pct-section">
              <div className="pct-hdr">
                Today&apos;s Rankings
                {pct.totalPlayers&&!pct.loading&&<span className="pct-players">{pct.totalPlayers.toLocaleString()} players</span>}
              </div>
              <PercentileBar icon="⚡" label="Speed"
                value={pct.loading?null:pct.speedPct} loading={pct.loading}
                sublabel={pct.speedPct!=null&&firstTime?`Faster than ${pct.speedPct}% of players today`:null}/>
              <PercentileBar icon="🧮" label="Volume"
                value={pct.loading?null:pct.solutionsPct} loading={pct.loading}
                sublabel={pct.solutionsPct!=null&&solutions.length>0?`More solutions than ${pct.solutionsPct}% of players today`:null}/>
            </div>
          )}

          {solutions.length>0 && (
            <div className="sol-list">
              <div className="sol-list-hdr">Your solutions</div>
              {solutions.map((s,i)=>(
                <div className="sol-row" key={i}>
                  <span className={`sol-expr ${i===0?"sol-first":""}`}>{s.str} = 24</span>
                  <span className={`sol-t ${i===0?"sol-first":""}`}>{s.time.toFixed(1)}s{i===0?" ⚡":""}</span>
                </div>
              ))}
            </div>
          )}

          <div className="share-box">{buildShareText()}</div>
          <button className={`share-btn ${copied?"copied":""}`} onClick={copyShare}>
            {copied?"✓  Copied to clipboard":"Copy & Share Results"}
          </button>

          <div className="all-sols">
            <div className="all-sols-hdr">All Possible Solutions</div>
            <div className="all-sols-count"><strong>{allSols.length}</strong> unique solutions for this puzzle</div>
            {allSols.map((s,i)=>{
              let canon; try{ canon=canonicalize(s.replace(/\s/g,"")); }catch{ canon=s; }
              const isFound = foundCanons.has(canon);
              return (
                <div className={`all-sol-item ${isFound?"found":""}`} key={i}>
                  {s} = 24{isFound?" ✓":""}
                </div>
              );
            })}
          </div>

          <div className="player-id">ID: {anonId}</div>
        </div>
      </div></>
    );
  }

  // ── GAME ──────────────────────────────────────────────────────
  return (
    <><style>{CSS}</style>
    <div className="wrap">
      {showHow && <HowToPlay onClose={()=>setShowHow(false)}/>}
      <div className="hdr">
        <div className="hdr-left">
          <div className="hdr-logo">24</div>
          <div className="hdr-date">{dateStr}</div>
        </div>
        <div className="hdr-right">
          {phase==="playing" && <button className="hdr-giveup" onClick={giveUp}>Give Up</button>}
          <button className="hdr-how" onClick={()=>setShowHow(true)}>?</button>
          <div className={`timer ${phase==="revealing"?"idle-t":timerClass}`}>
            {phase==="revealing"?"· · ·":fmt(timeLeft)}
          </div>
        </div>
      </div>

      <div className="card-grid">
        {cards.map((card,i)=>(
          <div className="card-scene" key={i}>
            <div className={`card-3d ${flipped[i]?"flipped":""}`}>
              <div className="card-back">
                <div className="card-back-inner"><span className="card-back-lbl">24</span></div>
              </div>
              <div className={`card-front ${card.isRed?"red":"black"} ${usedIdx.has(i)?"used":""}`} onClick={()=>addNum(i)}>
                <div className="card-tl">
                  <span className="cv">{card.display}</span>
                  <span className="cs">{card.suit}</span>
                </div>
                <div className="card-center">
                  <span className="suit-big">{card.suit}</span>
                  {["A","J","Q","K"].includes(card.display)&&<span className="card-num-badge">= {card.value}</span>}
                </div>
                <div className="card-br">
                  <span className="cv">{card.display}</span>
                  <span className="cs">{card.suit}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="sols-strip">
        {solutions.map((_,i)=><div className="sol-pill" key={i}>✓ #{i+1}{i===0?" ⚡":""}</div>)}
      </div>

      <div className="expr-wrap">
        <div className="expr-box">
          {tokens.length===0
            ? <span className="expr-ph">tap a card to start…</span>
            : tokens.map((t,i)=><span key={i} className={`tok ${t.type}`}>{t.val}</span>)
          }
          <span className="caret"/>
        </div>
        <div className={`feedback ${feedback.ok?"ok":"err"}`}>{feedback.msg}</div>
      </div>

      <div className="ctrl">
        <div className="btn-row br4">
          {["+","−","×","÷"].map(op=><button key={op} className="btn btn-op" onClick={()=>addOp(op)}>{op}</button>)}
        </div>
        <div className="btn-row br4">
          <button className="btn btn-paren" onClick={()=>addParen("(")}>(</button>
          <button className="btn btn-paren" onClick={()=>addParen(")")}>)</button>
          <button className="btn btn-bksp" onClick={bksp}>⌫</button>
          <button className="btn btn-clr" onClick={clr}>CLR</button>
        </div>
        <div className="solve-row">
          <button className="btn btn-solve" onClick={submit}>SOLVE →</button>
        </div>
      </div>
    </div></>
  );
}
