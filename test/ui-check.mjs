/**
 * 界面开关端到端。
 *
 * 单元测试（rules.test.mjs）能证明「关掉的模块不再出结论」；
 * 这个脚本证明的是另一半，也是更容易坏的那一半：
 *   1. 勾选框真的把页面上的东西收走了（页签、模块、状态条格子、打卡字段）
 *   2. 改动立刻生效，不等刷新也不等重启
 *   3. 写进了 private/profile.json，刷新之后还在
 *   4. 分析结论跟着改：没记睡眠就不再被判睡眠不足
 *
 * 全程用临时私有目录 + 临时端口，不碰使用者的 private/。
 *
 * 用法：node test/ui-check.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9600 + Math.floor(Math.random() * 200);
const PRIVATE = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ui-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 起一个只写临时目录的服务端 ---------- */
const server = spawn(process.execPath, [path.join(ROOT, "core", "server.js")], {
  // LEDGER_OPEN=1：本脚本验的是界面与主题开关，不是鉴权。不显式声明的话，
  // 服务端首启会自动生成口令，浏览器裸访问首页就是 401，看着像页面坏了。
  env: Object.assign({}, process.env, { PORT: String(PORT), LEDGER_PRIVATE_DIR: PRIVATE, LEDGER_OPEN: "1" }),
  stdio: "ignore"
});
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(800) });
    up = r.ok;
  } catch (e) { /* 还没起来 */ }
  if (!up) await sleep(250);
}
if (!up) {
  console.error("服务端没起来（端口 " + PORT + "）");
  server.kill();
  process.exit(2);
}

/* ---------- 2. 开浏览器 ---------- */
const chromePort = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  "--remote-debugging-port=" + chromePort,
  "--user-data-dir=" + fs.mkdtempSync(path.join(os.tmpdir(), "ledger-cdp-")),
  "about:blank"
], { stdio: "ignore" });

function cleanup(code) {
  try { chrome.kill(); } catch (e) {}
  try { server.kill(); } catch (e) {}
  try { fs.rmSync(PRIVATE, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
}

let list = null;
for (let i = 0; i < 40 && !list; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${chromePort}/json/list`, { signal: AbortSignal.timeout(800) });
    const l = await r.json();
    if (l.find((t) => t.type === "page")) list = l;
  } catch (e) { /* 还没起来 */ }
  if (!list) await sleep(250);
}
if (!list) { console.error("Chrome 没起来，检查 CHROME_PATH"); cleanup(2); }

const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error("ws 失败"))); });

let seq = 0;
const pending = new Map();
const pageErrors = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    pageErrors.push("异常：" + (d.exception && d.exception.description ? d.exception.description.split("\n")[0] : d.text));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    pageErrors.push("console.error：" + m.params.args.map((a) => a.value || a.description || "").join(" "));
  }
});
const send = (method, params) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params: params || {} })); });

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    const d = r.result.exceptionDetails;
    throw new Error(d.exception ? String(d.exception.description).split("\n")[0] : d.text);
  }
  return r.result ? r.result.result.value : undefined;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const BASE = `http://127.0.0.1:${PORT}/`;
await send("Page.navigate", { url: BASE });
await sleep(1800);

/* ---------- 3. 检查项 ---------- */
const checks = [];
async function check(name, fn) {
  try {
    const v = await fn();
    checks.push({ name, ok: v === true, detail: typeof v === "string" ? v : "" });
  } catch (e) { checks.push({ name, ok: false, detail: e.message }); }
}

/** 等某个条件成立（最多 ms 毫秒），用于等异步保存落地 */
async function until(ms, expr) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(expr)) return true;
    await sleep(150);
  }
  return false;
}

const vis = (sel) => `(() => { const el = document.querySelector('${sel}'); return !!el && getComputedStyle(el).display !== 'none'; })()`;

/** 等服务端把方案落盘（保存是异步的，直接读文件会和写盘赛跑） */
async function readProfileFile(ms) {
  const end = Date.now() + (ms || 5000);
  let last = null;
  while (Date.now() < end) {
    try { last = JSON.parse(fs.readFileSync(path.join(PRIVATE, "profile.json"), "utf8")); return last; }
    catch (e) { await sleep(200); }
  }
  throw new Error("profile.json 迟迟没落盘：" + (last ? "内容异常" : "文件不存在"));
}

await check("默认：七个页签、睡眠字段、状态条三格都在", async () => {
  const before = await evaluate(`(() => ({
      tabs: [...document.querySelectorAll('[data-tab]')].filter(b => getComputedStyle(b).display !== 'none').length,
      sleep: getComputedStyle(document.getElementById('sleepField')).display !== 'none',
      cells: document.querySelectorAll('#todayStrip .ts-cell').length
    }))()`);
  if (before.tabs !== 7) return "可见页签 " + before.tabs + "（应为 7）";
  if (!before.sleep) return "睡眠字段默认应当是显示的";
  if (before.cells !== 3) return "状态条格子 " + before.cells + "（默认 hero + 作业 + 考期 = 3）";
  return true;
});

await check("取消勾选并保存：页签、模块、状态条格子当场收起", async () => {
  await evaluate(`(() => {
      document.querySelector('[data-tab=settings]').click();
      document.getElementById('uit-asg').checked = false;      // 作业台账整页不要
      document.getElementById('uim-sleep').checked = false;    // 不记睡眠
      document.getElementById('uim-stripExam').checked = false;// 状态条不显示考期格
      document.getElementById('uiSave').click();
      return 1;
    })()`);
  const okApply = await until(4000, `getComputedStyle(document.querySelector('[data-tab=asg]')).display === 'none'`);
  if (!okApply) return "点了保存之后页签没收起来";
  const after = await evaluate(`(() => ({
      tabs: [...document.querySelectorAll('[data-tab]')].filter(b => getComputedStyle(b).display !== 'none').length,
      panelAsg: getComputedStyle(document.getElementById('panel-asg')).display !== 'none',
      sleep: getComputedStyle(document.getElementById('sleepField')).display !== 'none',
      cells: document.querySelectorAll('#todayStrip .ts-cell').length
    }))()`);
  if (after.tabs !== 6) return "页签还剩 " + after.tabs + " 个（应为 6）";
  if (after.panelAsg) return "作业台账面板还在显示";
  if (after.sleep) return "睡眠字段没收起来";
  if (after.cells !== 2) return "状态条还剩 " + after.cells + " 格（应为 2）";
  return true;
});

await check("改动写进了 private/profile.json", async () => {
  const p = await readProfileFile();
  if (!p.ui || !p.ui.tabs || p.ui.tabs.asg !== false) return "profile.ui.tabs.asg 不是 false";
  if (p.ui.modules.sleep !== false) return "profile.ui.modules.sleep 不是 false";
  if (p.ui.modules.stripExam !== false) return "profile.ui.modules.stripExam 不是 false";
  return true;
});

await check("刷新后依然按新开关显示（持久化生效）", async () => {
  await send("Page.navigate", { url: BASE });
  await sleep(1600);
  const after = await evaluate(`(() => ({
      tabs: [...document.querySelectorAll('[data-tab]')].filter(b => getComputedStyle(b).display !== 'none').length,
      sleep: getComputedStyle(document.getElementById('sleepField')).display !== 'none',
      asgBoxChecked: document.getElementById('uit-asg') ? document.getElementById('uit-asg').checked : null
    }))()`);
  if (after.tabs !== 6) return "刷新后页签 " + after.tabs + " 个（应为 6）";
  if (after.sleep) return "刷新后睡眠字段又出现了";
  await evaluate(`document.querySelector('[data-tab=settings]').click()`);
  await sleep(400);
  const checked = await evaluate(`document.getElementById('uit-asg').checked`);
  if (checked !== false) return "设置页里作业台账那一格刷新后是勾上的，说明没存住";
  return true;
});

await check("关掉的模块不再写进记录、也不再出结论", async () => {
  // 睡眠字段虽然被藏起来了，还是硬塞一个低数值进去——规则不该因为藏了字段就偷偷改口径：
  // collect() 在模块关闭时不读它，所以保存后的分析里不会出现「睡眠不足」
  const okSaved = await until(5000, `(() => {
      document.querySelector('[data-tab=checkin]').click();
      document.getElementById('d-hours').value = '6.5';
      document.getElementById('d-sleep').value = '4';   // 藏起来的字段，硬写也应当被忽略
      document.getElementById('saveBtn').click();
      const t = document.getElementById('analysisOut').innerText || '';
      return t.length > 0 ? 1 : 0;
    })()`);
  if (!okSaved) return "打卡没有产生分析输出";
  const hasSleep = await evaluate(`(document.getElementById('analysisOut').innerText || '').includes('睡眠')`);
  if (hasSleep) return "关掉睡眠之后，分析里还是出现了睡眠结论";
  // 打卡记录经 /api/data 异步落盘，给它一点时间
  let stored = null;
  for (let i = 0; i < 20 && !stored; i++) {
    try { stored = JSON.parse(fs.readFileSync(path.join(PRIVATE, "records.json"), "utf8")); } catch (e) { await sleep(200); }
  }
  if (!stored) return "records.json 迟迟没落盘";
  const day = Object.values(stored.days)[0];
  if (day.sleep !== null && day.sleep !== undefined) return "睡眠被写进了记录：" + day.sleep;
  return true;
});

await check("个人资料：填什么就显示什么，不填就不显示", async () => {
  await evaluate(`(() => {
      document.querySelector('[data-tab=settings]').click();
      document.getElementById('m-owner').value = '测试同学';
      document.getElementById('m-goal').value = '把这学期三门课推到能做题';
      document.getElementById('profileSave').click();
      return 1;
    })()`);
  const okGoal = await until(5000, `(() => {
      const n = document.getElementById('goalNote');
      return n && getComputedStyle(n).display !== 'none' && n.innerText.includes('推到能做题') ? 1 : 0;
    })()`);
  if (!okGoal) return "学习目标没显示到打卡页顶上";
  const p = await readProfileFile();
  if (p.meta.owner !== "测试同学") return "资料没写进 profile.json";
  if (p.meta.goal !== "把这学期三门课推到能做题") return "学习目标没写进 profile.json";
  if (p.meta.showIdentity !== false) return "身份显示默认应当是关的";
  // 没勾「在标题栏显示」，所以标题栏不许出现学校/专业
  const sub = await evaluate(`document.getElementById('brandSub').textContent`);
  if (/测试同学|课程|20\d\d/.test(sub)) return "标题栏泄漏了身份信息：" + sub;
  return true;
});

await check("「全部打开」能把收起来的东西一次性恢复", async () => {
  await evaluate(`(() => {
      document.querySelector('[data-tab=settings]').click();
      document.getElementById('uiAllOn').click();
      return 1;
    })()`);
  const ok = await until(4000, `(() => {
      const t = [...document.querySelectorAll('[data-tab]')].filter(b => getComputedStyle(b).display !== 'none').length;
      return t === 7 ? 1 : 0;
    })()`);
  if (!ok) return "全部打开之后页签没回到 7 个";
  // 注意：这里不能用 sleep 当变量名——它会遮蔽上面那个延时函数，
  // 一旦下面的重试循环被进入就会报 "sleep is not a function"（写盘偶发慢时必现）
  const sleepFieldBack = await evaluate(vis("#sleepField"));
  if (!sleepFieldBack) return "睡眠字段没恢复";
  // 全部打开之后，磁盘上的开关要逐项变成 true
  const end = Date.now() + 5000;
  let p = null;
  while (Date.now() < end) {
    p = await readProfileFile(2000);
    const allOn = p.ui && p.ui.tabs.asg === true && p.ui.modules.sleep === true && p.ui.modules.stripExam === true;
    if (allOn) return true;
    await sleep(200);
  }
  return "profile.json 里的开关没有全部改回 true：" + JSON.stringify(p && p.ui);
});

/* ---------- 说明文字是否真的收进了图标 ---------- */
await check("页面上没有残留的长段落说明", async () => {
  const bad = await evaluate(`(() => {
    return [...document.querySelectorAll('.hint, .note')]
      .filter(el => el.offsetParent)
      .map(el => el.textContent.replace(/\\s/g, ''))
      .filter(t => t.length > 46);
  })()`);
  if (bad.length) return "还有 " + bad.length + " 段超过 46 字：" + bad.map(t => t.slice(0, 20)).join(" / ");
  return true;
});

await check("每个说明图标都带 aria-label，且与悬停内容一致", async () => {
  const bad = await evaluate(`(() => {
    return [...document.querySelectorAll('.info')].filter(el => {
      const tip = el.getAttribute('data-tip') || '';
      const aria = el.getAttribute('aria-label') || '';
      return !tip || !aria || aria !== tip;
    }).map(el => (el.getAttribute('data-tip') || '(空)').slice(0, 16));
  })()`);
  if (bad.length) return bad.length + " 个图标缺 aria-label 或与 data-tip 不一致：" + bad.join(" / ");
  return true;
});

await check("悬停说明图标：浮层出现、内容正确、移开即收", async () => {
  await evaluate(`document.querySelector('[data-tab=settings]').click()`);
  await sleep(300);
  const box = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.info')].find(e => e.offsetParent);
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.getAttribute('data-tip') };
  })()`);
  // 先挪到旁边再挪过去：同一个坐标连发两次不会产生新的 pointerover
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none", clickCount: 0 });
  await sleep(60);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", clickCount: 0 });
  await sleep(400);
  const shown = await evaluate(`(() => {
    const t = document.getElementById('tip');
    return t ? { on: t.classList.contains('on'), text: t.textContent } : null;
  })()`);
  if (!shown || !shown.on) {
    const hit = await evaluate(`(() => { const e = document.elementFromPoint(${box.x}, ${box.y}); return e ? e.tagName + '.' + e.className : 'null'; })()`);
    return "悬停之后浮层没出现（光标下是 " + hit + "）";
  }
  if (shown.text !== box.text) return "浮层内容和 data-tip 不一致";
  // 移到空白处应当收起
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none", clickCount: 0 });
  await sleep(240);
  const hidden = await evaluate(`(() => { const t = document.getElementById('tip'); return !t || !t.classList.contains('on'); })()`);
  if (!hidden) return "移开鼠标后浮层没收起";
  return true;
});

/* ---------- 外观主题 ---------- */
await check("设置页有四套主题，默认选中第一套", async () => {
  await evaluate(`document.querySelector('[data-tab=settings]').click()`);
  const rows = await evaluate(`[...document.querySelectorAll('.theme-row')].map(r => r.dataset.themeId)`);
  if (!Array.isArray(rows) || rows.length !== 4) return "主题数量不对：" + JSON.stringify(rows);
  const on = await evaluate(`document.querySelectorAll('.theme-row.on').length`);
  if (on !== 1) return "选中的主题应当有且只有一个，实际 " + on;
  const cur = await evaluate(`document.documentElement.dataset.theme`);
  if (cur !== "stone") return "默认主题应为 stone，实际 " + cur;
  return true;
});

await check("换主题：变量与底纹立即跟着换，布局一动不动", async () => {
  const before = await evaluate(`(() => {
    const c = document.querySelector('.panel.on .card').getBoundingClientRect();
    const t = document.querySelector('.tabs button').getBoundingClientRect();
    return { w: Math.round(c.width), tabH: Math.round(t.height), paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() };
  })()`);
  await evaluate(`document.querySelector('.theme-row[data-theme-id="nether"]').click()`);
  const ok = await until(2000, `document.documentElement.dataset.theme === 'nether'`);
  if (!ok) return "点完之后 data-theme 没变";
  const after = await evaluate(`(() => {
    const c = document.querySelector('.panel.on .card').getBoundingClientRect();
    const t = document.querySelector('.tabs button').getBoundingClientRect();
    return {
      w: Math.round(c.width), tabH: Math.round(t.height),
      paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
      tex: (getComputedStyle(document.body).backgroundImage.match(/textures\\/([a-z-]+)\\.svg/) || [])[1]
    };
  })()`);
  if (after.paper === before.paper) return "纸色没变，主题没生效";
  if (after.tex !== "basalt") return "底纹没换：" + after.tex;
  // 只换令牌不换结构：尺寸必须一模一样
  if (after.w !== before.w || after.tabH !== before.tabH) {
    return "换主题引起了重排：卡片宽 " + before.w + "→" + after.w + "，页签高 " + before.tabH + "→" + after.tabH;
  }
  return true;
});

await check("主题写进 profile.json，刷新后还在", async () => {
  let p = null;
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    p = await readProfileFile(2000);
    if (p.appearance && p.appearance.theme === "nether") break;
    await sleep(200);
  }
  if (!p || !p.appearance || p.appearance.theme !== "nether") {
    return "磁盘上没记下来：" + JSON.stringify(p && p.appearance);
  }
  await send("Page.navigate", { url: BASE });
  await sleep(1600);
  const after = await evaluate(`document.documentElement.dataset.theme`);
  if (after !== "nether") return "刷新后主题没恢复，实际 " + after;
  // 换回来，别把主题留在下界影响后面的检查
  await evaluate(`document.querySelector('[data-tab=settings]').click()`);
  await sleep(200);
  await evaluate(`document.querySelector('.theme-row[data-theme-id="stone"]').click()`);
  await sleep(300);
  return true;
});

/* ---------- 4. 报告 ---------- */
const failed = checks.filter((c) => !c.ok);
console.log("界面开关检查 " + checks.length + " 项，失败 " + failed.length + " 项");
checks.forEach((c) => console.log("  " + (c.ok ? "✓ " : "✗ ") + c.name + (c.detail ? "  — " + c.detail : "")));
if (pageErrors.length) {
  console.log("页面报错 " + pageErrors.length + " 条：");
  [...new Set(pageErrors)].slice(0, 6).forEach((e) => console.log("  ! " + e));
}
console.log("临时私有目录：" + PRIVATE + "（已清理）");
cleanup(failed.length || pageErrors.length ? 1 : 0);
