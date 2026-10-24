/**
 * healthcheck.js —— 服务器状态定时检查 + 守护
 *
 * 两种用法：
 *   node healthcheck.js           跑一次，把结果打到屏幕（也追加到 health.log）
 *   node healthcheck.js --daemon  常驻：每 CHECK_MS 检查一次，服务不活就拉起 launch.js
 *
 * 它和 launch.js 的看门狗是两回事、互为补充：
 *   - launch.js 的看门狗：launch.js 活着时，盯着「服务进程崩了」自动重启。
 *   - 本脚本的守护：盯着「launch.js 本身还活着吗」，没了就把它拉起来。
 *     这样即使黑窗口被误关，最多 5 分钟服务又回来。
 *
 * 判定逻辑（每轮）：
 *   1. 服务在不在（GET /api/health == 200）？
 *   2. 不在 → launch.js 在不在（锁文件 pid 是否存活）？
 *   3. 也不在 → 后台拉起 launch.js，写日志。
 *   每次结果追加一行到 health.log：时间 + 状态 + 动作。
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const LOG = path.join(ROOT, "health.log");
const LOCK = path.join(ROOT, "private", "launch.lock");
const PAUSE = path.join(ROOT, "private", "paused.flag");
const LAUNCH = path.join(ROOT, "launch.js");
const NODE = process.execPath;
const CHECK_MS = 5 * 60 * 1000; // 每 5 分钟查一次

const DAEMON = process.argv.includes("--daemon");

function ts() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function line(msg) {
  console.log("[" + ts() + "] " + msg);
  try {
    fs.appendFileSync(LOG, "[" + ts() + "] " + msg + "\n", "utf8");
  } catch (e) {
    /* 日志写不进就算了，别让守护崩 */
  }
}

function probeHealth(cb) {
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/health", timeout: 2000 }, (res) => {
    res.resume();
    cb(res.statusCode === 200);
  });
  req.on("error", () => cb(false));
  req.on("timeout", () => {
    req.destroy();
    cb(false);
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function readLockPid() {
  try {
    const n = Number((fs.readFileSync(LOCK, "utf8") || "").trim());
    return n > 0 ? n : 0;
  } catch (e) {
    return 0;
  }
}

/** 用户是否主动暂停：存在 paused.flag 就是「用户关了黑框，别拉我」 */
function isPaused() {
  try {
    return fs.existsSync(PAUSE);
  } catch (e) {
    return false;
  }
}

/** 后台拉起 launch.js：独立进程组、不管父进程，保证守护自己退的时候它还在 */
function startLauncher() {
  try {
    const child = spawn(NODE, [LAUNCH], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return child.pid;
  } catch (e) {
    line("拉起 launch.js 失败：" + (e && e.message));
    return 0;
  }
}

function once() {
  probeHealth((ok) => {
    if (ok) {
      line("服务正常（127.0.0.1:" + PORT + " 返回 200）");
      process.exit(0);
    }
    const pid = readLockPid();
    const alive = pidAlive(pid);
    line("服务无响应" + (pid ? "，launch 锁 pid=" + pid + (alive ? "（存活）" : "（已死）") : "，无锁文件"));
    process.exit(1);
  });
}

function tick() {
  probeHealth((ok) => {
    if (ok) return; // 正常就不刷日志，避免 health.log 无限增长
    // 用户主动暂停：不拉起，尊重「关黑框 = 暂停」的意图。
    if (isPaused()) {
      line("已暂停（用户关闭了黑框），本轮不拉起；重新启动 start.bat 即恢复");
      return;
    }
    const pid = readLockPid();
    if (pidAlive(pid)) {
      line("服务无响应，但 launch.js 还在（pid=" + pid + "），交给它自己的看门狗处理");
      return;
    }
    line("服务无响应且 launch.js 已不在，重新拉起…");
    const np = startLauncher();
    line(np ? "已后台拉起 launch.js（新 pid=" + np + "）" : "拉起失败，下一轮再试");
  });
}

if (DAEMON) {
  line("守护启动：每 " + Math.round(CHECK_MS / 1000) + " 秒检查一次服务器状态");
  tick();
  setInterval(tick, CHECK_MS);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
} else {
  once();
}
