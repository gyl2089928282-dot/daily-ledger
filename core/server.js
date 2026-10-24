/**
 * daily-ledger 服务端（公用部分）
 *
 * 一条边界：core/ 里只有代码和通用默认配置，private/ 里只有使用者的真实数据。
 *   core/server.js            ← 本文件：不含个人信息的通用服务
 *   core/domain/              ← 规则与数据模型的唯一实现（纯函数，浏览器也用同一个）
 *   core/web/                 ← 通用页面（index.html / app.css / app.js）
 *   core/default-profile.json ← 公开的占位配置（谁都能拿去改成自己的）
 *   private/profile.json      ← 使用者的方案：课程、考期、目标、里程碑
 *   private/records.json      ← 使用者的记录：打卡、周复盘、作业
 *   private/brief.json        ← 定时任务每晚生成的提醒正文（数据，不是代码）
 *
 * 两层访问范围：
 *   公开  —— core/web 下的静态页面、/domain 下的模块、/api/health（不含路径与内容）
 *   需口令 —— /profile.js、/brief.js、/api/data、/api/profile、/api/analysis
 * 口令来自 private/config.json 的 token 或环境变量 LEDGER_TOKEN。
 * 没配口令时视为「开放模式」：适合别人克隆 core/ 自己试用，不适合放真实数据。
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import url from "node:url";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { emptyDB, normalizeDB, normalizeProfile, mergeProfile, mergeDBs, emptyProfile, validateDB, validateProfile, fixCourseIds } from "./domain/schema.js";
import { buildAnalysis } from "./domain/rules.js";
import { stripTags } from "./domain/text.js";

const CORE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(CORE, "..");
const WEB = path.join(CORE, "web");
const DOMAIN = path.join(CORE, "domain");

// 私有目录可用环境变量指到别处（默认放在项目根的 private/）
const PRIVATE = process.env.LEDGER_PRIVATE_DIR
  ? path.resolve(process.env.LEDGER_PRIVATE_DIR)
  : path.join(APP, "private");

const F = {
  data: path.join(PRIVATE, "records.json"),
  profile: path.join(PRIVATE, "profile.json"),
  brief: path.join(PRIVATE, "brief.json"),
  briefLegacy: path.join(PRIVATE, "brief.js"),
  config: path.join(PRIVATE, "config.json"),
  defaultProfile: path.join(CORE, "default-profile.json"),
  legacyData: path.join(APP, "data", "records.json")
};

const PORT = Number(process.env.PORT) || 3000;
// 默认只听本机：公网隧道只需要 127.0.0.1。要给同一 WiFi 的手机直接访问，
// 显式设 LEDGER_HOST=0.0.0.0（等于把服务暴露给整个局域网，口令是唯一的门）。
const HOST = process.env.LEDGER_HOST || "127.0.0.1";
const MAX_BODY = 2 * 1024 * 1024;
const COOKIE = "ledger_key";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

/* ───────── 日志 ───────── */

const LOG_DIR = path.join(PRIVATE, "logs");

/** 统一格式：时间 级别 说明。同时写 private/logs/app-YYYY-MM-DD.log，保留 7 天。 */
function log(level, msg, extra) {
  const t = new Date().toISOString().slice(11, 19);
  const line = "[" + t + "] " + level + " " + msg + (extra ? " | " + extra : "");
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toLocaleDateString("sv-SE");
    fs.appendFileSync(path.join(LOG_DIR, "app-" + day + ".log"), line + "\n", "utf8");
  } catch (e) {
    /* 日志写不进去不能影响服务 */
  }
}

/** 启动时清一次过期日志，避免长期跑下来堆成山 */
function rotateLogs(keepDays) {
  try {
    const cutoff = Date.now() - keepDays * 86400000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      const m = name.match(/^app-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      const t = new Date(m[1] + "T00:00:00").getTime();
      if (t < cutoff) fs.unlinkSync(path.join(LOG_DIR, name));
    }
  } catch (e) {
    /* 目录还不存在就算了 */
  }
}

/* ───────── 读写工具 ───────── */

// 结构定义与校验统一来自 core/domain/schema.js，服务端不再自己维护一份。
const normalize = normalizeDB;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readData() {
  return normalize(readJson(F.data, null));
}

function writeData(obj) {
  writeJson(F.data, obj);
}

/** 私有方案优先；没有就用公用默认配置，别人克隆 core/ 也能直接跑 */
function readProfile() {
  const p = readJson(F.profile, null);
  if (p && Array.isArray(p.courses)) return { profile: normalizeProfile(p), source: "private" };
  const d = readJson(F.defaultProfile, null);
  if (d && Array.isArray(d.courses)) return { profile: normalizeProfile(d), source: "default" };
  return { profile: emptyProfile(), source: "empty" };
}

/* ───────── 口令 ───────── */

/** 口令字母表：去掉 0/O/1/l/I，手机上手输不出歧义 */
const TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

function makeToken(len) {
  const n = len || 16;
  const bytes = crypto.randomBytes(n * 2);
  let out = "";
  for (let i = 0; i < bytes.length && out.length < n; i++) {
    if (bytes[i] >= 248) continue; // 248 = 62×4，丢掉尾部余数，避免取模偏差
    out += TOKEN_CHARS[bytes[i] % TOKEN_CHARS.length];
  }
  return out.length === n ? out : makeToken(n);
}

/**
 * 口令来源优先级：环境变量 LEDGER_TOKEN > private/config.json 的 token > 首次运行自动生成。
 *
 * 为什么首启要自动生成：发布包里不带 private/，如果「没配口令 = 开放模式」，
 * 那么任何人第一次解压启动，服务都是裸的——局域网或隧道里谁拿到地址谁就能读写。
 * 所以这里改成「没有口令就生成一个写进 config.json」，宁可多一步复制口令，
 * 也不让它在使用者不知情的情况下开放。
 *
 * 确实想开放（只在本机自用、或给别人试用空库）时，用 LEDGER_OPEN=1 显式声明。
 * 写在启动时只读一次：改 config.json 后必须重启才生效。
 */
const TOKEN_SOURCE = { from: "open", note: "" };

function loadToken() {
  const env = String(process.env.LEDGER_TOKEN || "").trim();
  if (env) {
    TOKEN_SOURCE.from = "env";
    return env;
  }
  const c = readJson(F.config, null);
  if (c && typeof c.token === "string" && c.token.trim()) {
    TOKEN_SOURCE.from = "file";
    return c.token.trim();
  }
  if (process.env.LEDGER_OPEN === "1") {
    TOKEN_SOURCE.from = "open";
    TOKEN_SOURCE.note = "LEDGER_OPEN=1，按你的要求开放访问";
    return "";
  }
  const token = makeToken(16);
  try {
    writeJson(
      F.config,
      Object.assign({}, c || {}, {
        token,
        createdAt: new Date().toISOString(),
        note: "首次运行自动生成的口令。改这里可以换口令，改完要重启服务才生效。",
      })
    );
    TOKEN_SOURCE.from = "generated";
    TOKEN_SOURCE.note = "首次运行，已自动生成口令并写入 " + F.config;
    return token;
  } catch (e) {
    // 目录只读时不能拿「静默开放」兜底，退回到需要口令但谁也进不去更安全
    TOKEN_SOURCE.from = "blocked";
    TOKEN_SOURCE.note = "生成了口令但写不进 config.json：" + e.message;
    return token;
  }
}

const TOKEN = loadToken();

function cookieValue(req, name) {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : "";
}

/** 定长比较，避免逐字符短路带来的时序差异 */
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""), "utf8");
  const B = Buffer.from(String(b || ""), "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/* ───────── 失败限流 ─────────
   口令是唯一凭证，公网上必须挡住无脑爆破。
   按来源 IP 计数：10 分钟内错 30 次就锁 10 分钟。
   隧道进来时来源都是 127.0.0.1，等于对「经隧道来的所有请求」合并计数——
   正好是我们要防的那条路径；局域网直连则按真实 IP 各算各的。 */
const FAIL_WINDOW = 10 * 60 * 1000;
const FAIL_LIMIT = 30;
const fails = new Map(); // ip -> { n, since, until }

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function blocked(req) {
  const rec = fails.get(clientIp(req));
  return !!(rec && rec.until && rec.until > Date.now());
}

function noteFail(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let rec = fails.get(ip);
  if (!rec || now - rec.since > FAIL_WINDOW) rec = { n: 0, since: now, until: 0 };
  rec.n++;
  if (rec.n >= FAIL_LIMIT) rec.until = now + FAIL_WINDOW;
  fails.set(ip, rec);
  if (rec.n === FAIL_LIMIT) log("warn", "口令连续失败，已临时封禁来源 " + ip);
}

/**
 * 口令校验。三种携带方式：查询串 ?k=、请求头 x-ledger-key、Cookie。
 * 注意 Cookie 的值就是口令本身——它不是会话令牌，没有独立生命周期。
 *
 * 顺序很关键：先认口令，再谈封禁。封禁只用来挡「猜」，
 * 不能让拿着正确口令的人被别人的失败次数连坐——否则一个共用的出口 IP
 * 就能把使用者自己锁在门外。封禁期内的重复尝试也不再顺延封禁窗口。
 */
function authed(req, parsed) {
  if (!TOKEN) return true; // 开放模式
  const q = parsed && parsed.query ? parsed.query.k : "";
  const h = req.headers["x-ledger-key"] || "";
  const c = cookieValue(req, COOKIE);
  if ((q && safeEqual(q, TOKEN)) || (h && safeEqual(h, TOKEN)) || (c && safeEqual(c, TOKEN))) return true;
  if (!blocked(req)) noteFail(req);
  return false;
}

/* ───────── 老数据迁移 ─────────
   旧版把记录放在 data/records.json。若私有文件不存在或为空，就把旧记录并进来。
   只增不覆盖：私有已有的日期一律保留。
   迁移是一次性动作，做完写 .migrated-v1 标记，之后启动直接跳过——
   不靠「比较条数」猜（旧文件哪天被恢复回来会被二次合并）。 */
function migrateLegacy() {
  const MARK = path.join(PRIVATE, ".migrated-v1");
  // 决策一旦做出就落标记，哪怕是「不用合并」。否则旧文件哪天被恢复回来，
  // 又会被当成待迁移数据二次合并一遍。
  const markDone = () => {
    try {
      fs.writeFileSync(MARK, new Date().toISOString() + "\n", "utf8");
    } catch (e) {}
  };
  try {
    if (fs.existsSync(MARK)) return;
    if (!fs.existsSync(F.legacyData)) return;
    const legacy = readJson(F.legacyData, null);
    if (!legacy || !legacy.days) return;
    const cur = readJson(F.data, null) || emptyDB();
    const curDays = Object.keys(cur.days || {}).length;
    const legDays = Object.keys(legacy.days || {}).length;
    if (curDays >= legDays && curDays > 0) return markDone();
    if (curDays === legDays && curDays === 0) return markDone();

    const merged = {
      meta: Object.assign({ version: 1 }, cur.meta || {}),
      days: Object.assign({}, legacy.days || {}, cur.days || {}),
      weeks: Object.assign({}, legacy.weeks || {}, cur.weeks || {}),
      assignments: []
    };
    const seen = new Set();
    [...(cur.assignments || []), ...(legacy.assignments || [])].forEach((a) => {
      const k = a.id || [a.course, a.title, a.due].join("|");
      if (seen.has(k)) return;
      seen.add(k);
      merged.assignments.push(a);
    });
    const lt = (legacy.meta || {}).updatedAt || "";
    const ct = (cur.meta || {}).updatedAt || "";
    merged.meta.updatedAt = ct > lt ? ct : lt;
    writeJson(F.data, merged);
    markDone();
    log("info", "已合并 data/records.json 到 private/records.json（旧文件保留，可自行删除）");
  } catch (e) {
    log("error", "迁移旧数据失败", e.message);
  }
}

/* ───────── HTTP 小工具 ───────── */

/** 值得压缩的类型（woff2/png 已经压过，再压是浪费 CPU） */
function compressible(type) {
  return /^text\/|^application\/(javascript|json|manifest)/.test(type) || type === "image/svg+xml";
}

function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
}

/**
 * 发响应。静态资源走这里才有压缩与缓存；接口数据一律 no-store。
 *
 * 缓存策略（刻意的选择，别随手改成"全都不缓存"）：
 *   - 字体/贴图：30 天。它们基本不变，改了就改 CSS 里的 url，浏览器自然重新取。
 *   - js/css/html：no-cache + ETag。每次回一个 304（约 200 字节），比重新传 200KB 便宜得多，
 *     而且改代码立刻生效，不会出现"手机上还是旧版"。
 */
function send(res, code, body, type, opts) {
  const o = opts || {};
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const headers = {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": o.cache || "no-cache, no-store, must-revalidate"
  };
  if (o.etag) headers.ETag = o.etag;
  if (o.vary) headers.Vary = "Accept-Encoding";

  let payload = buf;
  if (o.gzip && code === 200 && compressible(headers["Content-Type"])) {
    payload = o.gzip;
    headers["Content-Encoding"] = "gzip";
  }
  if (code !== 304) headers["Content-Length"] = payload.length;

  res.writeHead(code, headers);
  res.end(code === 304 ? undefined : payload);
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

/**
 * 读请求体。超限时**不要** destroy——那样客户端只会看到连接重置，
 * 拿不到任何解释；这里保留连接，回一个体面的 413。
 */
function readBody(req, cb) {
  let size = 0;
  let dead = false;
  const chunks = [];
  req.on("data", (c) => {
    if (dead) return;
    size += c.length;
    if (size > MAX_BODY) {
      dead = true;
      chunks.length = 0;
      cb(new Error("too large"));
      req.resume(); // 把剩下的数据读完丢掉，才能正常结束这次请求
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (dead) return;
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (e) {
      cb(new Error("bad json"));
    }
  });
}

/** gzip 结果按「文件 + mtime + 大小」缓存在内存里，避免每次请求都压一遍 */
const gzCache = new Map();

/** 发一个静态文件：带 ETag、条件请求 304、文本类自动 gzip */
function sendFile(req, res, target) {
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "not found");
    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    const etag = '"' + st.size.toString(16) + "-" + Math.floor(st.mtimeMs).toString(16) + '"';
    const frozen = /\.(woff2|svg|png|jpg|ico)$/i.test(target);
    const cache = frozen ? "public, max-age=2592000" : "no-cache";
    const opts = { etag, cache, vary: true };

    if (req.headers["if-none-match"] === etag) return send(res, 304, "", type, opts);

    fs.readFile(target, (e2, buf) => {
      if (e2) return send(res, 404, "not found");
      if (compressible(type) && acceptsGzip(req)) {
        const hit = gzCache.get(target);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          opts.gzip = hit.gz;
        } else {
          try {
            const gz = zlib.gzipSync(buf, { level: 6 });
            gzCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, gz });
            opts.gzip = gz;
          } catch (e3) {
            log("warn", "gzip 失败，按原文发送", target);
          }
        }
      }
      send(res, 200, buf, type, opts);
    });
  });
}

/**
 * 把一个目录里的文件安全地吐出去。越界（../、绝对路径）一律 403。
 * @param {boolean} softHome 找不到文件时是否回落到 index.html——只给页面目录用
 */
function sendFromDir(req, res, baseDir, relPath, softHome) {
  const target = path.normalize(path.join(baseDir, relPath));
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) return send(res, 403, "forbidden");
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      if (!softHome) return send(res, 404, "not found");
      return sendFile(req, res, path.join(baseDir, "index.html"));
    }
    sendFile(req, res, target);
  });
}

/** 只服务 core/web 与 core/domain；private/ 不可能被静态读到 */
function serveStatic(req, res, pathname) {
  // 畸形百分号转义（如 /%）会让 decodeURIComponent 抛 URIError。
  // 异常若穿出请求回调，会直接终结整个进程——所以这里必须兜住。
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    return send(res, 400, "bad request");
  }
  // 含 NUL 的路径在部分平台会抛错，提前挡掉
  if (rel.indexOf("\u0000") >= 0) return send(res, 400, "bad request");

  // 页面模块要从 /domain/ 拿共享规则（app.js 里 import "../domain/rules.js"）
  if (rel === "/domain" || rel.startsWith("/domain/")) {
    return sendFromDir(req, res, DOMAIN, rel.slice("/domain".length) || "/", false);
  }

  if (rel === "/" || rel === "") rel = "/index.html";
  sendFromDir(req, res, WEB, rel, true);
}

/* ───────── 接口 ───────── */

/**
 * 记录接口：GET 读，POST 写。
 *
 * 并发处理分三种情况（这是本次改动的重点，之前只有整份覆盖）：
 *   1. 客户端带上来的 baseUpdatedAt 等于磁盘 → 它看到的就是最新版，整份写入（删除也能生效）
 *   2. 不等于（另一端已经改过）→ 合并：按日期/按 id 取较新的，双方改动都不丢
 *   3. 没带 baseUpdatedAt（老客户端）→ 退回原来的时间戳比较，旧版本写了 409
 */
function handleData(req, res) {
  if (req.method === "GET" || req.method === "HEAD") return json(res, 200, readData());
  if (req.method !== "POST") return json(res, 405, { ok: false, reason: "method not allowed" });

  readBody(req, (err, incoming) => {
    if (err) return json(res, err.message === "too large" ? 413 : 400, { ok: false, reason: err.message });
    const base = typeof incoming.baseUpdatedAt === "string" ? incoming.baseUpdatedAt : null;
    delete incoming.baseUpdatedAt;
    incoming = normalize(incoming);
    const problems = validateDB(incoming);
    if (problems.length) return json(res, 400, { ok: false, reason: "bad db", problems });

    const current = readData();
    const diskT = current.meta.updatedAt || "";
    const nowIso = new Date().toISOString();

    // 兜底：磁盘上有记录，提交的却整份是空的——不许抹掉。
    // 真实成因通常是本地存储被清、或页面还没拉到云端数据就先提交了一次；
    // 这时候按「合并」处理，磁盘上的日期原样保留。
    const looksWiped = Object.keys(current.days).length > 0 && Object.keys(incoming.days).length === 0;
    if (looksWiped) log("warn", "收到整份空提交，已拒绝抹除，改为合并");

    try {
      if (base !== null) {
        if (base === diskT && !looksWiped) {
          incoming.meta.updatedAt = nowIso;
          writeData(incoming);
          return json(res, 200, { ok: true, updatedAt: nowIso, days: Object.keys(incoming.days).length });
        }
        const merged = mergeDBs(current, incoming);
        merged.meta.updatedAt = nowIso;
        writeData(merged);
        log("info", "写入时发现另一端已改过，已按日期合并", "days=" + Object.keys(merged.days).length);
        return json(res, 200, {
          ok: true,
          merged: true,
          updatedAt: nowIso,
          days: Object.keys(merged.days).length,
          db: merged
        });
      }

      // 老客户端：只防「更旧的回写」
      const newT = incoming.meta.updatedAt || "";
      if (diskT && newT && newT < diskT) {
        return json(res, 409, { ok: false, reason: "stale", updatedAt: diskT });
      }
      if (looksWiped) {
        // 空提交同样不许覆盖，走合并并回传结果
        const merged = mergeDBs(current, incoming);
        merged.meta.updatedAt = nowIso;
        writeData(merged);
        return json(res, 200, { ok: true, merged: true, updatedAt: nowIso, days: Object.keys(merged.days).length, db: merged });
      }
      incoming.meta.updatedAt = newT || nowIso;
      writeData(incoming);
      json(res, 200, { ok: true, updatedAt: incoming.meta.updatedAt, days: Object.keys(incoming.days).length });
    } catch (e) {
      log("error", "写入 records.json 失败", e.message);
      json(res, 500, { ok: false, reason: "write failed" });
    }
  });
}

/**
 * 方案接口：GET 读，POST 写。
 * 写的时候只覆盖前端提交的字段，里程碑、周任务、信息缺口这些「助手维护」的部分原样保留。
 */
function handleProfile(req, res) {
  if (req.method === "GET" || req.method === "HEAD") return json(res, 200, readProfile());

  if (req.method !== "POST") return json(res, 405, { ok: false, reason: "method not allowed" });

  readBody(req, (err, body) => {
    if (err) return json(res, err.message === "too large" ? 413 : 400, { ok: false, reason: err.message });
    const src = body && body.profile ? body.profile : body;
    if (!src || typeof src !== "object") return json(res, 400, { ok: false, reason: "bad profile" });
    const problems = validateProfile(src);
    if (problems.length) return json(res, 400, { ok: false, reason: "bad profile", problems });

    const cur = readJson(F.profile, null) || readJson(F.defaultProfile, {}) || {};
    const next = mergeProfile(normalizeProfile(cur), src, new Date().toISOString());
    next.courses = fixCourseIds(next.courses);
    try {
      writeJson(F.profile, next);
      json(res, 200, { ok: true, updatedAt: next.meta.updatedAt, courses: (next.courses || []).length });
    } catch (e) {
      json(res, 500, { ok: false, reason: "write failed" });
    }
  });
}

/** 方案以 JS 返回，页面用 <script src="/profile.js"> 同步拿到，不必等异步请求 */
function handleProfileJs(res, ok) {
  if (!ok) {
    return send(res, 200, "window.__AUTH__ = false;\n", MIME[".js"]);
  }
  const r = readProfile();
  const body =
    "window.__AUTH__ = true;\n" +
    "window.__PLAN__ = " + JSON.stringify(r.profile) + ";\n" +
    "window.__PLAN_SOURCE__ = " + JSON.stringify(r.source) + ";";
  send(res, 200, body, MIME[".js"]);
}

/**
 * 提醒正文：定时任务写 private/brief.json（数据，不是代码），这里包成赋值语句给页面。
 * 旧的 private/brief.js（整段 JS）仍然兼容——它当初就是这么设计的，不能一改就让当晚提醒消失。
 */
function readBrief() {
  const j = readJson(F.brief, null);
  if (j && typeof j === "object") return j;
  // 兼容旧文件：把 "window.__BRIEF__ = {...};" 里的对象抠出来
  try {
    if (fs.existsSync(F.briefLegacy)) {
      const raw = fs.readFileSync(F.briefLegacy, "utf8").trim();
      const m = raw.match(/^window\.__BRIEF__\s*=\s*([\s\S]*?);?\s*$/);
      if (m) return JSON.parse(m[1]);
    }
  } catch (e) {
    log("warn", "旧 brief.js 解析失败，按空处理", e.message);
  }
  return null;
}

function handleBriefJs(res, ok) {
  if (!ok) return send(res, 200, "window.__BRIEF__ = null;", MIME[".js"]);
  const brief = readBrief();
  send(res, 200, "window.__BRIEF__ = " + JSON.stringify(brief) + ";", MIME[".js"]);
}

/**
 * 分析结论：规则的唯一实现（core/domain/rules.js），页面与定时任务都从这里取。
 * 定时任务不该再「读懂一遍规则」，它只负责把结果排版成提醒。
 */
function handleAnalysis(res, query) {
  const db = readData();
  const { profile } = readProfile();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(query.date || ""))
    ? String(query.date)
    : new Date().toLocaleDateString("sv-SE"); // sv-SE 输出 YYYY-MM-DD
  const rec = db.days[date];
  if (!rec) {
    return json(res, 404, { ok: false, reason: "no record for " + date, date });
  }
  const r = buildAnalysis(db, profile, rec, date);
  json(res, 200, {
    ok: true,
    date,
    counts: { days: Object.keys(db.days).length, courses: (profile.courses || []).length },
    analyses: r.analyses.map((a) => ({ type: a.type, title: a.title, body: a.body, text: stripTags(a.body) })),
    acts: r.acts.map((a) => ({ text: a.text, why: a.why }))
  });
}

/* ───────── 服务器操作界面（管理接口） ─────────
   给管理员看「服务现在什么状态」，不写数据、不动配置。
   比普通数据更敏感（能看到进程、日志、地址），所以同样要过口令。 */

/** 读文件尾部若干行（日志预览用），最多 200 行、每行截 200 字符 */
function tailFile(file, maxLines) {
  try {
    const data = fs.readFileSync(file, "utf8");
    const lines = data.split(/\r?\n/).filter((l) => l.length > 0);
    const last = lines.slice(-(maxLines || 80));
    return last.map((l) => (l.length > 200 ? l.slice(0, 200) + "…" : l));
  } catch (e) {
    return [];
  }
}

/** pid 是否存活（发 0 号信号探测） */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/** 读 private/tunnel-url.txt，抽出 url / link / lan / updatedAt */
function readTunnelInfo() {
  try {
    const s = fs.readFileSync(path.join(PRIVATE, "tunnel-url.txt"), "utf8");
    const out = {};
    for (const key of ["url", "link", "lan", "updatedAt"]) {
      const m = s.match(new RegExp("^" + key + "=(.+)$", "m"));
      if (m) out[key] = m[1].trim();
    }
    return out;
  } catch (e) {
    return {};
  }
}

/** 读 launch.lock 里的 pid */
function readLaunchPid() {
  try {
    const n = Number((fs.readFileSync(path.join(PRIVATE, "launch.lock"), "utf8") || "").trim());
    return n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

/** 探一下公网地址是否真的通（仅在存在 url 时） */
function pingPublic(urlStr) {
  return new Promise((resolve) => {
    if (!urlStr || !/^https:\/\//.test(urlStr)) return resolve(null);
    let u;
    try {
      u = new URL(urlStr + "/api/health");
    } catch (e) {
      return resolve(false);
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname, timeout: 8000, headers: { "User-Agent": "daily-ledger-admin" } },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 暂停标记路径 */
function pausedFlagPath() {
  return path.join(PRIVATE, "paused.flag");
}

/** 写暂停标记：守护(healthcheck --daemon)检测到就不再自动拉起 */
function writePausedFlag(reason) {
  try {
    fs.mkdirSync(PRIVATE, { recursive: true });
    fs.writeFileSync(pausedFlagPath(), "reason=" + (reason || "web") + "\nat=" + new Date().toISOString() + "\n", "utf8");
  } catch (e) {
    /* 写不进就继续，最坏情况是守护会拉起来 */
  }
}

/**
 * 重启辅助脚本（由本进程 spawn 出的独立进程执行，windowsHide 无窗口）：
 *   1. 若旧启动器还在，先优雅终止它（其 shutdown 会连带关掉本服务）；
 *   2. 轮询 /api/health 直到服务确实退出（最多 15 秒，避免「新启动器探到旧服务还在就跳过启动」的竞态）；
 *   3. 清掉暂停标记（本次重启本身即代表恢复运行）；
 *   4. 静默拉起新的 launch.js，然后退出。
 * 用 node -e 以字符串注入，ROOT/PORT 在生成时替换，避免再落一个脚本文件。
 */
function buildRestartHelper() {
  const root = JSON.stringify(APP);
  const port = String(PORT);
  return [
    'const { spawn } = require("child_process");',
    'const http = require("http");',
    'const fs = require("fs");',
    'const path = require("path");',
    "const ROOT = " + root + ";",
    "const PORT = " + port + ";",
    'const LOCK = path.join(ROOT, "private", "launch.lock");',
    'const PAUSE = path.join(ROOT, "private", "paused.flag");',
    "function pidAlive(p){try{process.kill(p,0);return true}catch(e){return false}}",
    "function readPid(){try{var n=Number((fs.readFileSync(LOCK,'utf8')||'').trim());return n>0?n:0}catch(e){return 0}}",
    "function healthOk(cb){var r=http.get({host:'127.0.0.1',port:PORT,path:'/api/health',timeout:1200},function(res){res.resume();cb(res.statusCode===200)});r.on('error',function(){cb(false)});r.on('timeout',function(){r.destroy();cb(false)})}",
    "var old=readPid();",
    "if(old&&pidAlive(old)){try{process.kill(old,'SIGTERM')}catch(e){}}",
    "var waited=0;",
    "(function waitDown(){healthOk(function(ok){",
    "  if(!ok||waited>=15000){setTimeout(function(){",
    "    try{if(fs.existsSync(PAUSE))fs.unlinkSync(PAUSE)}catch(e){}",
    "    var c=spawn(process.execPath,[path.join(ROOT,'launch.js')],{cwd:ROOT,detached:true,windowsHide:true,stdio:'ignore'});c.unref();",
    "    process.exit(0);",
    "  },ok?800:0);return;}",
    "  waited+=500;setTimeout(waitDown,500);",
    "});})();"
  ].join("\n");
}

/** 静默启动一个后台辅助进程来执行「重启」，脱离本服务独立存活 */
function spawnRestartHelper() {
  const child = spawn(process.execPath, ["-e", buildRestartHelper()], {
    cwd: APP,
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
  return child.pid;
}

/**
 * 服务器启停控制（受口令保护，见 onRequest 里的鉴权）。
 *   POST /api/admin/stop    —— 关闭：写暂停标记 → 优雅终止启动器（连带关服务）
 *   POST /api/admin/restart —— 重启：spawn 独立辅助进程接管「关旧起新」
 * 都先响应 200 再动作，保证网页能收到明确的结果，而不是连接被掐断。
 */
function handleAdminControl(res, pathname) {
  if (pathname === "/api/admin/stop") {
    json(res, 200, { ok: true, action: "stop", message: "正在停止服务…" });
    // 先写暂停标记：守护不会再把它自动拉起来
    writePausedFlag("web-stop");
    // 再优雅终止启动器：launch.js 收到 SIGTERM 会走 shutdown，连带杀掉本服务进程
    const lp = readLaunchPid();
    if (lp && pidAlive(lp)) {
      try { process.kill(lp, "SIGTERM"); } catch (e) { /* 已死，无所谓 */ }
    }
    // 兜底：2 秒后若还活着（启动器没成功带我们走），自己退出
    setTimeout(() => process.exit(0), 2000);
    return true;
  }

  if (pathname === "/api/admin/restart") {
    json(res, 200, { ok: true, action: "restart", message: "正在重启服务…" });
    try {
      const hp = spawnRestartHelper();
      log("warn", "管理员触发重启，辅助进程 pid=" + hp);
    } catch (e) {
      log("warn", "重启辅助进程启动失败：" + (e && e.message));
    }
    // 兜底：若辅助进程没能带我们走（比如启动器本来就没在跑），2.5 秒后自己退出让辅助进程接手
    setTimeout(() => process.exit(0), 2500);
    return true;
  }

  return false;
}

async function handleAdmin(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return json(res, 405, { ok: false, reason: "method not allowed" });
  }
  const d = readData();
  const p = readProfile();
  const launchPid = readLaunchPid();
  const tunnel = readTunnelInfo();
  const pubOk = await pingPublic(tunnel.url);
  const launchAlive = pidAlive(launchPid);
  const paused = fs.existsSync(pausedFlagPath());

  const today = new Date().toLocaleDateString("sv-SE");
  json(res, 200, {
    ok: true,
    state: launchAlive ? "running" : (paused ? "paused" : "degraded"),
    paused: paused,
    server: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      host: HOST,
      port: PORT,
      mode: TOKEN ? "locked" : "open",
      memMB: Math.round(process.memoryUsage().rss / 1048576),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
    },
    data: {
      days: Object.keys(d.days).length,
      weeks: Object.keys(d.weeks).length,
      assignments: d.assignments.length,
      updatedAt: d.meta.updatedAt || "",
      courses: (p.profile.courses || []).length,
      profileSource: p.source
    },
    launch: {
      pid: launchPid,
      alive: launchAlive
    },
    tunnel: Object.assign({ publicOk: pubOk }, tunnel),
    logs: {
      app: tailFile(path.join(LOG_DIR, "app-" + today + ".log"), 60),
      health: tailFile(path.join(APP, "health.log"), 40),
      launch: tailFile(path.join(APP, "launch.log"), 40)
    }
  });
}

function onRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  // 被封禁的来源：口令也没对上才挡。口令对的人照常放行（见 authed 的注释）
  const ok = authed(req, parsed);
  if (!ok && blocked(req)) return json(res, 429, { ok: false, reason: "too many attempts" });

  // 链接上带对口令就种一次 cookie，之后同一浏览器不用再带
  if (TOKEN && ok && parsed.query && safeEqual(parsed.query.k, TOKEN)) {
    // 只有确认走了 https 才加 Secure：本地 http 加了会导致 cookie 不被发送
    const secure = String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
    res.setHeader(
      "Set-Cookie",
      COOKIE + "=" + encodeURIComponent(TOKEN) + "; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax" +
        (secure ? "; Secure" : "")
    );
  }

  // 公用：静态页与健康检查（健康检查不暴露私有目录与内容）
  if (pathname === "/api/health") {
    const d = ok ? readData() : null;
    const p = ok ? readProfile() : null;
    return json(res, 200, {
      ok: true,
      mode: TOKEN ? "locked" : "open",
      days: d ? Object.keys(d.days).length : -1,
      weeks: d ? Object.keys(d.weeks).length : -1,
      assignments: d ? d.assignments.length : -1,
      updatedAt: d ? d.meta.updatedAt || "" : "",
      profileSource: p ? p.source : "hidden",
      courses: p ? (p.profile.courses || []).length : -1
    });
  }

  if (pathname === "/profile.js") return handleProfileJs(res, ok);
  if (pathname === "/brief.js") return handleBriefJs(res, ok);

  // 服务器操作界面：只读状态 + 日志预览，仍要过口令
  if (pathname === "/api/admin") {
    if (!ok) return json(res, 401, { ok: false, reason: "unauthorized" });
    return handleAdmin(req, res);
  }
  // 服务器启停控制（关闭 / 重启），同样要过口令，只接受 POST
  if (pathname === "/api/admin/stop" || pathname === "/api/admin/restart") {
    if (!ok) return json(res, 401, { ok: false, reason: "unauthorized" });
    if (req.method !== "POST") return json(res, 405, { ok: false, reason: "POST only" });
    if (handleAdminControl(res, pathname)) return;
  }

  // 私有接口：必须过口令
  if (pathname === "/api/data" || pathname === "/api/profile") {
    if (!ok) return json(res, 401, { ok: false, reason: "unauthorized" });
    return pathname === "/api/data" ? handleData(req, res) : handleProfile(req, res);
  }
  if (pathname === "/api/analysis") {
    if (!ok) return json(res, 401, { ok: false, reason: "unauthorized" });
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { ok: false, reason: "method not allowed" });
    return handleAnalysis(res, parsed.query || {});
  }

  if (pathname.startsWith("/private")) return send(res, 403, "forbidden");
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
  serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  // 单个请求出错只影响这一个请求，绝不终结进程。
  try {
    onRequest(req, res);
  } catch (e) {
    log("error", "请求处理异常 " + req.method + " " + req.url, e.message);
    try {
      if (!res.headersSent) json(res, 500, { ok: false, reason: "internal" });
      else res.end();
    } catch (e2) {}
  }
});

migrateLegacy();
rotateLogs(7);

/* 最后一道兜底：任何漏网的异常只记录，不让进程退出。
   服务停了等于手机端直接 502，代价比记一条日志大得多。 */
process.on("uncaughtException", (e) => {
  log("error", "未捕获异常（已忽略，服务继续）", (e && e.stack) || String(e));
});
process.on("unhandledRejection", (e) => {
  log("error", "未处理的 Promise 拒绝", (e && e.stack) || String(e));
});

server.listen(PORT, HOST, () => {
  log("info", "daily-ledger on " + HOST + ":" + PORT);
  if (HOST === "127.0.0.1" || HOST === "localhost") {
    log("info", "listen  仅本机（要局域网直连，设 LEDGER_HOST=0.0.0.0）");
  }
  log("info", "web " + WEB);
  log("info", "private " + PRIVATE);
  if (TOKEN) {
    const shown = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
    log("info", "access 需要口令；本机打开 http://" + shown + ":" + PORT + "/?k=" + TOKEN);
    if (TOKEN_SOURCE.from === "generated") log("info", "口令 " + TOKEN_SOURCE.note);
    if (TOKEN_SOURCE.from === "blocked") log("warn", "口令 " + TOKEN_SOURCE.note + "（本次只在内存里，重启会变）");
  } else {
    log("info", "access 开放模式（" + (TOKEN_SOURCE.note || "没有配置口令") + "）：任何拿到地址的人都能读写");
  }
});
