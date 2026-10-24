/**
 * 特征化测试：把「重构前」的行为固化成 golden。
 *
 * 做法：从 core/web/index.html 里抠出内联 <script>，用 DOM 桩跑起来，
 * 冻结时钟到 FIXED_TODAY，对 test/fixtures.mjs 里的每个用例算一遍 buildAnalysis，
 * 结果写进 test/golden/analysis.json。
 *
 * 重构之后由 test/rules.test.mjs 对比 —— 逐字相等才算「只是搬家，没改行为」。
 *
 * 只在拆分前跑一次；拆完把它留着当「旧实现参照」，但它依赖 index.html 里还有内联脚本，
 * 一旦脚本迁到 app.js，这个脚本会明确报错退出，那时基线已经在 golden 里了。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, FIXED_TODAY } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HTML = path.join(ROOT, "core", "web", "index.html");
const OUT = path.join(HERE, "golden", "analysis.json");

/* ───────── DOM 桩 ───────── */

function mkEl(id) {
  const o = {
    id,
    value: "",
    textContent: "",
    _html: "",
    dataset: {},
    style: {},
    files: null,
    title: "",
    checked: false,
    hidden: false,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { f ? this._s.add(c) : this._s.delete(c); } },
      contains(c) { return this._s.has(c); }
    },
    addEventListener() {},
    focus() {},
    appendChild(c) { (o._kids = o._kids || []).push(c); return c; },
    remove() {},
    select() {},
    closest() { return null; },
    click() {},
    insertBefore(c) { (o._kids = o._kids || []).unshift(c); return c; },
    querySelector() { return mkEl("sel"); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 40, height: 30 }; },
    offsetLeft: 0,
    offsetWidth: 40,
    firstChild: null
  };
  Object.defineProperty(o, "innerHTML", {
    get() { return o._html; },
    set(v) { o._html = String(v); o._kids = []; }
  });
  return o;
}

function mkDoc() {
  const cache = {};
  return {
    _cache: cache,
    getElementById(id) { if (!cache[id]) cache[id] = mkEl(id); return cache[id]; },
    querySelector() { return mkEl("q"); },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(t) { return mkEl(t); },
    body: { appendChild() {}, removeChild() {} },
    execCommand() { throw new Error("no"); }
  };
}

/* ───────── 冻结时钟 ───────── */

function makeFrozenDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const fixed = new Date(y, m - 1, d, 12, 0, 0);
  return class FrozenDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(fixed.getTime());
      else super(...args);
    }
    static now() { return fixed.getTime(); }
  };
}

/* ───────── 抽取内联脚本 ───────── */

const html = fs.readFileSync(HTML, "utf8");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!blocks.length) {
  console.error("index.html 里没有内联 <script> 了 —— 说明脚本已迁出，基线应该已经在 golden 里。");
  process.exit(2);
}
const JS = blocks.join("\n");

function runCase(c) {
  const doc = mkDoc();
  const store = {};
  const sandbox = {
    document: doc,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    navigator: {},
    confirm: () => true,
    alert: () => {},
    console: { log() {}, warn() {}, error() {} },
    requestAnimationFrame: (f) => f(),
    addEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    location: { protocol: "https:", search: "", href: "https://example.test/" },
    Date: makeFrozenDate(FIXED_TODAY),
    __PLAN__: c.profile,
    __PLAN_SOURCE__: "test",
    __BRIEF__: null,
    __AUTH__: true
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const keys = Object.keys(sandbox);
  const api = new Function(
    ...keys,
    JS + "\nreturn { buildAnalysis, setDB: (d) => { DB = d; }, semWeek, TODAY };"
  )(...keys.map((k) => sandbox[k]));

  api.setDB(c.db);
  const r = api.buildAnalysis(c.rec);
  return {
    name: c.name,
    today: api.TODAY,
    semWeekToday: api.semWeek(api.TODAY),
    analyses: r.analyses.map((a) => ({ type: a.type, title: a.title, body: a.body })),
    acts: r.acts.map((a) => ({ text: a.text, why: a.why }))
  };
}

const cases = CASES.map((c) => {
  try {
    return runCase(c);
  } catch (e) {
    console.error("用例失败：" + c.name + " → " + e.message);
    return { name: c.name, error: e.message };
  }
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ fixedToday: FIXED_TODAY, source: "index.html 内联脚本", cases }, null, 2), "utf8");

const bad = cases.filter((c) => c.error);
console.log("基线已写入 " + path.relative(ROOT, OUT));
console.log("用例 " + cases.length + " 个，失败 " + bad.length + " 个");
cases.forEach((c) => {
  const n = c.analyses ? c.analyses.length : 0;
  const m = c.acts ? c.acts.length : 0;
  console.log("  " + (c.error ? "✗ " : "· ") + c.name + "  分析 " + n + " / 行动 " + m);
});
process.exit(bad.length ? 1 : 0);
