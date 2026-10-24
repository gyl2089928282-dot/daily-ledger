/**
 * 浏览器冒烟：真的开一个 Chrome，把页面加载起来，点一遍页签，看有没有报错。
 *
 * 单元测试只能证明规则对；这个脚本证明「页面还能用」——模块化改造最容易踩的坑
 * （作用域变了、内联 onclick 找不到函数、CSS 没加载、资源 404）都在这一层暴露。
 *
 * 用法：node test/browser-check.mjs [url] [--shot 输出.png]
 * 依赖：本机已安装 Chrome（路径见 CHROME，可用 CHROME_PATH 覆盖）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 没显式给地址就默认本机 3000；口令从 private/config.json 自动补上，
// 否则开了口令模式必然 401，看着像页面坏了。
const URL_ = (() => {
  const given = process.argv.find((a, i) => i > 1 && !a.startsWith("--"));
  let u = given || "http://127.0.0.1:3000/";
  if (given && /[?&]k=/.test(u)) return u;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(ROOT, "private", "config.json"), "utf8"));
    if (cfg && cfg.token) u += (u.includes("?") ? "&" : "?") + "k=" + encodeURIComponent(cfg.token);
  } catch (e) {}
  return u;
})();
const SHOT = (() => {
  const i = process.argv.indexOf("--shot");
  return i > 0 ? process.argv[i + 1] : "";
})();
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9400 + Math.floor(Math.random() * 300);
const PROFILE = path.join(os.tmpdir(), "ledger-cdp-" + Date.now());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonGet(u) {
  const r = await fetch(u);
  return r.json();
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE,
    "about:blank"
  ],
  { stdio: "ignore" }
);

function cleanup(code) {
  try { chrome.kill(); } catch (e) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
}

let wsUrl = "";
for (let i = 0; i < 40 && !wsUrl; i++) {
  try {
    const list = await jsonGet("http://127.0.0.1:" + PORT + "/json/list");
    const page = list.find((t) => t.type === "page");
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch (e) {
    /* 还没起来 */
  }
  if (!wsUrl) await sleep(250);
}
if (!wsUrl) {
  console.error("Chrome 没起来，检查 CHROME_PATH");
  cleanup(2);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("ws 连接失败"));
});

let seq = 0;
const pending = new Map();
const errors = [];
const warnings = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
    return;
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    errors.push("异常：" + (d.exception && d.exception.description ? d.exception.description.split("\n")[0] : d.text));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push("console.error：" + m.params.args.map((a) => a.value || a.description || a.type).join(" "));
  }
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    const e = m.params.entry;
    // 隧道/离线环境常见的网络噪声不算页面问题
    if (!/favicon|ERR_INTERNET|ERR_NAME/.test(e.text)) errors.push("log：" + e.text + " " + (e.url || ""));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "warning") {
    warnings.push(m.params.args.map((a) => a.value || a.description || "").join(" "));
  }
};

function send(method, params) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception ? d.exception.description.split("\n")[0] : d.text);
  }
  return r.result.value;
}

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL_ });
await sleep(1800);

const checks = [];
function check(name, fn) {
  return (async () => {
    try {
      const v = await fn();
      // 约定：返回 true = 通过；返回字符串 = 失败原因（细节会打印出来）。
      // 别写成 `typeof v === "string" && v`——那样任何错误说明都会被当成通过。
      checks.push({ name, ok: v === true, detail: typeof v === "string" ? v : "" });
    } catch (e) {
      checks.push({ name, ok: false, detail: e.message });
    }
  })();
}

await check("页面标题正常", () => evaluate(`document.title.length > 0 || "标题为空"`));
await check("样式表已生效（app.css）", () =>
  evaluate(`
    const sheets = [...document.styleSheets].map(s => (s.href || "inline").split("/").pop());
    sheets.includes("app.css") ? true : "已加载：" + sheets.join(",")
  `));
await check("模块脚本已执行（app.js）", () =>
  evaluate(`typeof window.__PLAN__ === "object" && document.querySelectorAll(".tab, [data-tab]").length >= 6`));
await check("内联 onclick 函数已挂到 window", () =>
  evaluate(`
    const need = ["exportAll","resetForm","saveDay","copyReminder","exportAsg","addAsg","saveWeek","setLv","toggleAsg","openEdit","closeEdit","saveEdit","delAsg","editDay"];
    const miss = need.filter(n => typeof window[n] !== "function");
    miss.length ? "缺失：" + miss.join(",") : true
  `));
await check("课程名来自 /profile.js（不是写死常量）", () =>
  evaluate(`
    const rows = document.querySelectorAll("#courseRows .course-line, #courseRows [class*=course]");
    const plan = window.__PLAN__ || {};
    const n = (plan.courses || []).length;
    rows.length >= n && n > 0 ? true : "课程行 " + rows.length + " / 方案 " + n
  `));
// 说明：本项目不附带字体文件（见 NOTICE.md），所以这里不检查「像素字体已加载」——
// 字体缺失属于预期的回退情况，不是故障。只断言页面自己的字体栈没被断开。
await check("字体栈未失效（有回退字体可用）", () =>
  evaluate(`
    (() => {
      const f = getComputedStyle(document.body).fontFamily || "";
      // 要么命中像素字体，要么至少落到一个通用族（monospace / sans-serif / 系统中文字体）
      return /Zpix/i.test(f) || /monospace|sans-serif|PingFang|YaHei|system-ui/i.test(f)
        ? true
        : "字体栈异常：" + f.slice(0, 80);
    })()
  `));
// 7 个页签 = ui.js 的 TABS（6 个业务页）+ 始终存在的「设置」
await check("七个页签都能切换且面板唯一可见", () =>
  evaluate(`
    (() => {
      const tabs = [...document.querySelectorAll("[data-tab]")];
      if (tabs.length !== 7) return "页签数量 " + tabs.length;
      const bad = [];
      for (const t of tabs) {
        t.click();
        const panels = [...document.querySelectorAll(".panel")].filter(p => getComputedStyle(p).display !== "none");
        if (panels.length !== 1) bad.push(t.dataset.tab + "→可见面板 " + panels.length);
      }
      return bad.length ? bad.join("；") : true;
    })()
  `));
// 以前选中态是一条红石滑块在按钮底下挪；现在改成按钮自己高亮 + 点击闪一下。
// 这条只守「滑块不许回来」和「选中必须看得出来」，不锁死具体是用背景还是字色。
await check("页签选中态靠自身高亮表达（没有滑动红块）", async () => {
  // 上一条检查刚把所有页签点了一遍，最后一下的点击闪烁还在播——等它走完再量常态样式
  await sleep(450);
  return evaluate(`
    (() => {
      if (document.getElementById("tabInd")) return "tab-ind 滑块又回来了";
      const on = document.querySelector(".tabs button.on");
      const off = [...document.querySelectorAll(".tabs button")].find(b => !b.classList.contains("on"));
      if (!on || !off) return "页签结构异常";
      const a = getComputedStyle(on), b = getComputedStyle(off);
      return (a.color !== b.color || a.backgroundColor !== b.backgroundColor) ? true : "选中与未选中看不出区别";
    })()
  `);
});
await check("设置页：个人资料表单存在且默认全空", () =>
  evaluate(`
    (() => {
      document.querySelector('[data-tab=settings]').click();
      const ids = ["m-owner","m-school","m-major","m-grade","m-semester","m-goal"];
      const miss = ids.filter(id => !document.getElementById(id));
      if (miss.length) return "缺字段：" + miss.join(",");
      const filled = ids.filter(id => (document.getElementById(id).value || "").trim());
      // 用公用默认配置跑时不该有任何预置值；用私有方案跑时允许已经有值（那是使用者自己填的）
      return filled.length && window.__PLAN_SOURCE__ === "default" ? "默认配置里出现了预置内容：" + filled.join(",") : true;
    })()
  `));
await check("设置页：功能选择清单与 domain/ui.js 的清单一致", () =>
  evaluate(`
    (() => {
      const tabs = document.querySelectorAll("#uiTabList input[type=checkbox]").length;
      const mods = document.querySelectorAll("#uiModList input[type=checkbox]").length;
      if (tabs !== 6) return "页签开关 " + tabs + " 个（应为 6）";
      if (mods !== 7) return "模块开关 " + mods + " 个（应为 7）";
      const unchecked = [...document.querySelectorAll("#uiTabList input, #uiModList input")].filter(i => !i.checked).length;
      return unchecked ? unchecked + " 项默认没勾上（缺省应全开）" : true;
    })()
  `));
await check("保存按钮可点且未禁用", () =>
  evaluate(`
    const b = document.getElementById("saveBtn");
    b && !b.disabled ? true : "saveBtn 缺失或禁用"
  `));
await check("无横向溢出（1280 宽）", () =>
  evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1 ? true : "scrollWidth=" + document.documentElement.scrollWidth`));

await sleep(300);
if (SHOT) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(SHOT, Buffer.from(r.data, "base64"));
}

const failed = checks.filter((c) => !c.ok);
console.log("检查项 " + checks.length + " 个，失败 " + failed.length + " 个");
checks.forEach((c) => console.log("  " + (c.ok ? "✓ " : "✗ ") + c.name + (c.detail ? "  — " + c.detail : "")));
if (warnings.length) console.log("警告 " + warnings.length + " 条：" + warnings.slice(0, 3).join(" | "));
if (errors.length) {
  console.log("页面报错 " + errors.length + " 条：");
  [...new Set(errors)].slice(0, 8).forEach((e) => console.log("  ! " + e));
}
if (SHOT) console.log("截图：" + SHOT);

cleanup(failed.length || errors.length ? 1 : 0);
