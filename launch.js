/**
 * daily-ledger 一键启动器
 *
 * 做三件事：
 *   1. 本地服务没在跑就在 127.0.0.1:3000 起一个
 *   2. 通过 serveo 建一条 SSH 反向隧道，把 3000 端口暴露成公网 https 地址
 *   3. 把当前公网地址（含访问口令）写进 private/tunnel-url.txt，手机照着打开就行
 *
 * 为什么用 serveo 而不是平台自带的「发布为应用」：
 *   平台返回的分享链接被网关判定为「缺少访问参数」，返回 403，外部无法访问；
 *   而 cloudflared 的 trycloudflare 隧道在本机被代理（TUN 模式）打断 TLS 握手，连不上。
 *   serveo 走标准 SSH 443/22，实测可以穿透。
 *
 * 局限（必须知道）：
 *   - 隧道地址每次重启都会变，因为免费版不允许固定子域名
 *   - 依赖 serveo.net 这个第三方中转，TLS 在它那里解密
 *   - 本机关机或休眠，公网地址就打不开
 */
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const notify = require("./notify");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
// 默认直连模式：服务监听所有网卡（手机同 WiFi 直接访问），不建公网隧道。
// 要公网访问再显式开：LEDGER_TUNNEL=1 node launch.js
const HOST = process.env.LEDGER_HOST || "0.0.0.0";
const LAN_OPEN = HOST === "0.0.0.0" || HOST === "::";
const TUNNEL = process.env.LEDGER_TUNNEL === "1" && !process.env.LEDGER_NO_TUNNEL;
// 私有数据目录：默认在项目内，可用 LEDGER_PRIVATE_DIR 指到项目外。
// 这条对「代码在公开仓库、数据在私人目录」的用法是必需的——否则 private/ 会跟着仓库走。
const PRIVATE_DIR = process.env.LEDGER_PRIVATE_DIR
  ? path.resolve(process.env.LEDGER_PRIVATE_DIR)
  : path.join(ROOT, "private");
const URL_FILE = path.join(PRIVATE_DIR, "tunnel-url.txt");
const CONFIG_FILE = path.join(PRIVATE_DIR, "config.json");
const LOCK_FILE = path.join(PRIVATE_DIR, "launch.lock");
// 暂停标记：用户主动关闭黑框时写入，守护检测到就不再自动拉起（尊重「暂停」意图）。
// 意外崩溃不写这个标记，守护照常拉起。
const PAUSE_FILE = path.join(PRIVATE_DIR, "paused.flag");
const SERVER = path.join(ROOT, "core", "server.js");
const NODE_BIN = process.execPath;

let serverProc = null;
let sshProc = null;
let shuttingDown = false;
let retry = 0;
let restartCount = 0;
let lastUrl = "";
// 已经推给手机的地址：同一个地址不重复推，避免一晚上刷十几条
let lastPushedUrl = "";
// 健康看门狗的连续失败计数
let healthFails = 0;

function log(msg) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log("[" + t + "] " + msg);
}

/** 读私有口令：有就拼进链接，没有就是开放模式 */
function readToken() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return typeof c.token === "string" ? c.token.trim() : "";
  } catch (e) {
    return "";
  }
}

/** 读推送渠道配置 */
function readNotify() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return c.notify && typeof c.notify === "object" ? c.notify : {};
  } catch (e) {
    return {};
  }
}

/** 上一次写进文件的地址，用来判断「这条是不是已经推过了」 */
function readPushedUrl() {
  try {
    const s = fs.readFileSync(URL_FILE, "utf8");
    const m = s.match(/^url=(.+)$/m);
    return m ? m[1].trim() : "";
  } catch (e) {
    return "";
  }
}

/** 取本机局域网 IPv4，优先常见内网段 */
function lanAddress() {
  const nets = os.networkInterfaces();
  const all = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) all.push(ni.address);
    }
  }
  const prefer = all.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  return prefer || all[0] || "";
}

/**
 * 单实例锁：开机自启 + 手动双击可能同时发生，第二个进程应当直接退出，
 * 否则会多建一条隧道、把地址文件写成互相覆盖的两份。
 */
function acquireLock() {
  try {
    const old = Number((fs.readFileSync(LOCK_FILE, "utf8") || "").trim());
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0);
        return old;
      } catch (e) {
        /* 旧进程已死，锁是残留的 */
      }
    }
  } catch (e) {
    /* 没有锁文件，正常 */
  }
  try {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, String(process.pid), "utf8");
  } catch (e) {
    log("写锁文件失败：" + e.message);
  }
  return 0;
}

function releaseLock() {
  try {
    const cur = (fs.readFileSync(LOCK_FILE, "utf8") || "").trim();
    if (cur === String(process.pid)) fs.unlinkSync(LOCK_FILE);
  } catch (e) {
    /* 无所谓 */
  }
}

/** 写入暂停标记：告诉守护「这次是用户主动暂停，别拉我」 */
function markPaused(reason) {
  try {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(
      PAUSE_FILE,
      "reason=" + (reason || "user-close") + "\n" +
        "at=" + new Date().toISOString() + "\n",
      "utf8"
    );
  } catch (e) {
    log("写暂停标记失败：" + e.message);
  }
}

/** 清除暂停标记：本次启动本身即代表「恢复运行」 */
function clearPaused() {
  try {
    if (fs.existsSync(PAUSE_FILE)) fs.unlinkSync(PAUSE_FILE);
  } catch (e) {
    /* 无所谓 */
  }
}

/** 探测本地服务是否已经可用 */
function probe(cb) {
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/health", timeout: 1500 }, (res) => {
    res.resume();
    cb(res.statusCode === 200);
  });
  req.on("error", () => cb(false));
  req.on("timeout", () => {
    req.destroy();
    cb(false);
  });
}

function waitPort(tries, cb) {
  probe((ok) => {
    if (ok) return cb(true);
    if (tries <= 0) return cb(false);
    setTimeout(() => waitPort(tries - 1, cb), 400);
  });
}

function startServer(done) {
  probe((running) => {
    if (running) {
      log("本地服务已在 " + PORT + " 端口运行，跳过启动");
      return done();
    }
    log("启动本地服务…");
    serverProc = spawn(NODE_BIN, [SERVER], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(PORT), LEDGER_HOST: HOST }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    serverProc.stdout.on("data", (d) => process.stdout.write("  server| " + d));
    serverProc.stderr.on("data", (d) => process.stdout.write("  server! " + d));
    serverProc.on("exit", (code) => {
      if (shuttingDown) return;
      // 服务挂了不应该连隧道一起关——隧道好好的，重启服务就行。
      // 但也不能无脑重试：连续失败就退避，避免日志刷屏。
      restartCount++;
      const wait = Math.min(3000 * restartCount, 15000);
      log("本地服务退出（code=" + code + "），" + Math.round(wait / 1000) + " 秒后重启");
      setTimeout(() => {
        if (shuttingDown) return;
        startServer(() => {});
      }, wait);
    });
    waitPort(25, (ok) => {
      if (ok) restartCount = 0;
      log(ok ? "本地服务就绪" : "本地服务 10 秒内没有响应，继续尝试建隧道");
      done();
    });
  });
}

/** 公网自检：新地址真的返回 200 才算数（serveo 的 502 就是「地址在、后端没了」） */
function verifyOnce(base, cb) {
  let host, pathname;
  try {
    const u = new URL(base);
    host = u.hostname;
    pathname = "/api/health";
  } catch (e) {
    return cb(false);
  }
  const req = https.get(
    {
      hostname: host,
      port: 443,
      path: pathname,
      timeout: 12000,
      headers: { "User-Agent": "daily-ledger-launcher", Accept: "application/json" }
    },
    (res) => {
      res.resume();
      cb(res.statusCode === 200);
    }
  );
  req.on("error", () => cb(false));
  req.on("timeout", () => {
    req.destroy();
    cb(false);
  });
}

function verifyPublic(base, tries, cb) {
  verifyOnce(base, (ok) => {
    if (ok) return cb(true);
    if (tries <= 1) return cb(false);
    setTimeout(() => verifyPublic(base, tries - 1, cb), 2500);
  });
}

/**
 * 自检通过才落盘、才推送。
 * 这一步是「手机上打不开」的根治点：以前拿到地址就推，后端一死就变成推一堆 502。
 */
function publish(base) {
  const token = readToken();
  const link = token ? base + "/?k=" + encodeURIComponent(token) : base + "/";
  const lan = LAN_OPEN ? lanAddress() : "";
  const lanUrl = lan ? "http://" + lan + ":" + PORT : "";

  verifyPublic(base, 3, (ok) => {
    if (!ok) {
      log("新地址自检未通过，不落盘也不推送（后端可能没起来）：" + base);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(URL_FILE), { recursive: true });
      fs.writeFileSync(
        URL_FILE,
        "# 当前公网地址（每次重启隧道都会变）\n" +
          "url=" + base + "\n" +
          "link=" + link + "\n" +
          (lanUrl ? "lan=" + lanUrl + "\n" : "") +
          "updatedAt=" + new Date().toISOString() + "\n",
        "utf8"
      );
    } catch (e) {
      log("写地址文件失败：" + e.message);
    }
    log("公网地址（已自检 200）：" + base);
    log("手机打开这条（带口令，打开一次就记住）：");
    log("  " + link);
    if (lanUrl) log("局域网（同一 WiFi 内可访问）：" + lanUrl);
    if (!token) log("提示：没有配置口令，任何拿到地址的人都能看数据");

    if (base === lastPushedUrl) {
      log("这个地址之前推过了，跳过重复推送");
      return;
    }
    lastPushedUrl = base;

    const ncfg = readNotify();
    notify
      .send({ base: base, link: link, lan: lanUrl, notify: ncfg })
      .then((res) => {
        if (!res.length) return log("未配置推送渠道，只写了 private/tunnel-url.txt");
        res.forEach((r) =>
          log("推送 " + r.channel + "：" + (r.ok ? "成功" : "失败 " + r.detail))
        );
      })
      .catch((e) => log("推送异常：" + e.message));
  });
}

/**
 * 把当前局域网地址写到文件、打印到屏幕（直连模式）。
 * 校园网是 DHCP，笔记本一重连/换 WiFi，IP 就会变——手机书签里那个旧 IP 就再也打不开。
 * 所以这里既要启动时写一次，也要周期性地复查，变了就立刻更新文件并醒目提示。
 */
let lastLan = "";
let bootedLan = false;
function syncLanUrl() {
  if (!LAN_OPEN || TUNNEL) return;
  const lan = lanAddress();
  if (!lan) return;
  if (lan === lastLan) return;
  const first = !bootedLan;
  const prev = lastLan;
  const changed = bootedLan && prev && prev !== lan;
  lastLan = lan;
  bootedLan = true;
  const tk = readToken();
  const lanUrl = "http://" + lan + ":" + PORT;
  const link = lanUrl + (tk ? "/?k=" + encodeURIComponent(tk) : "/");
  log("当前手机直连地址：" + link);
  try {
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(
      URL_FILE,
      "# 直连模式地址（电脑 IP 变了这里会跟着更新；手机以这个为准）\n" +
        "url=" + lanUrl + "\n" +
        "link=" + link + "\n" +
        "lan=" + lanUrl + "\n" +
        "updatedAt=" + new Date().toISOString() + "\n",
      "utf8"
    );
  } catch (e) {
    log("写地址文件失败：" + e.message);
  }
  // IP 变了才推送（首次启动不打扰）：手机书签旧了是「有时打不开」的头号原因
  if (changed) {
    log("检测到本机 IP 变化（" + prev + " → " + lan + "），推送到手机");
    notify
      .send({ base: lanUrl, link: link, lan: lanUrl, notify: readNotify() })
      .then((res) => {
        res.forEach((r) => log("推送 " + r.channel + "：" + (r.ok ? "成功" : "失败 " + r.detail)));
      })
      .catch((e) => log("推送异常：" + e.message));
  } else if (first) {
    log("首次记录直连地址，不推送（只有 IP 变了才推）");
  }
}

/**
 * 健康看门狗：服务进程还在、但已经不响应的情况它抓不到 exit，只能靠轮询。
 * 连续 3 次不通才动手，避免偶发慢请求造成误杀。
 * 顺带每次都复查一遍局域网 IP——电脑换网段后手机书签要跟着换。
 */
function startWatchdog() {
  setInterval(() => {
    if (shuttingDown) return;
    syncLanUrl();
    probe((ok) => {
      if (ok) {
        healthFails = 0;
        return;
      }
      healthFails++;
      log("健康检查失败 " + healthFails + "/3");
      if (healthFails >= 3) {
        healthFails = 0;
        log("本地服务连续无响应，重启它");
        try { if (serverProc) serverProc.kill(); } catch (e) {}
        serverProc = null;
        restartCount = 0;
        startServer(() => {});
      }
    });
  }, 30000);
}

function startTunnel() {
  if (shuttingDown) return;
  // 直连模式（默认）：不开公网隧道，手机走局域网 IP，地址一辈子不变。
  if (!TUNNEL) {
    log("直连模式：未建立公网隧道（手机用局域网地址，地址固定不变）");
    log("要公网访问时改用：set LEDGER_TUNNEL=1 && node launch.js");
    return;
  }
  log("建立公网隧道…");
  sshProc = spawn(
    "ssh",
    [
      "-F", "/dev/null",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "ExitOnForwardFailure=yes",
      "-R", "80:127.0.0.1:" + PORT,
      "serveo.net"
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );

  const onData = (buf) => {
    const s = String(buf);
    const m = s.match(/https:\/\/[a-z0-9.\-]+/i);
    if (m && m[0] !== lastUrl) {
      lastUrl = m[0];
      retry = 0;
      publish(m[0]);
    }
  };

  sshProc.stdout.on("data", onData);
  sshProc.stderr.on("data", (d) => {
    const s = String(d);
    if (s.trim() && !/Permission denied|Pseudo-terminal/.test(s)) {
      process.stdout.write("  tunnel! " + s);
    }
  });

  sshProc.on("exit", (code) => {
    if (shuttingDown) return;
    retry = Math.min(retry + 1, 6);
    const wait = Math.min(5000 * retry, 30000);
    log("隧道断开（code=" + code + "），" + Math.round(wait / 1000) + " 秒后重连");
    // 重连前先确认后端活着，否则连上了也还是 502
    setTimeout(() => startServer(() => startTunnel()), wait);
  });
}

/**
 * 关闭（用户主动关闭黑框 = 暂停）。
 *
 * paused=true 表示「用户主动暂停」：写暂停标记，守护检测到就不再拉起。
 * 这里只处理主动关闭；意外崩溃走不到这里，自然不留标记，守护照常拉起。
 */
function shutdown(code, paused) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(paused ? "用户关闭黑框，进入暂停状态（守护不会再自动拉起）" : "正在停止…");
  if (paused) markPaused("user-close");
  // 公网隧道要干净断开：杀掉 ssh 进程，避免留孤儿隧道让地址看似可用实则 502。
  try { if (sshProc) sshProc.kill(); } catch (e) {}
  try { if (serverProc) serverProc.kill(); } catch (e) {}
  setTimeout(() => process.exit(code || 0), 300);
}

process.on("SIGINT", () => shutdown(0, true));
process.on("SIGTERM", () => shutdown(0, true));
// Windows 下点黑框的 X / 关闭按钮，控制台发出的是 SIGHUP（Node 会收到），
// 明确接住它走「暂停」路径，而不是让进程被粗暴杀掉、留一堆孤儿进程和锁。
process.on("SIGHUP", () => shutdown(0, true));
process.on("exit", releaseLock);
// 启动器本身不该因为一个漏网异常就死掉：它死了隧道和锁文件都会留成孤儿。
process.on("uncaughtException", (e) => log("未捕获异常（已忽略）：" + ((e && e.message) || e)));

const holder = acquireLock();
if (holder) {
  log("已有启动器在运行（pid=" + holder + "），本窗口可以关掉了");
  setTimeout(() => process.exit(0), 3000);
  return;
}

lastPushedUrl = readPushedUrl();
clearPaused();
log("工作目录：" + ROOT);
log("模式：" + (TUNNEL ? "公网隧道（地址会变）" : "局域网直连（地址固定）"));
log("本机：http://127.0.0.1:" + PORT);
if (!LAN_OPEN) log("提示：局域网未开放（要手机同 WiFi 直连，设 LEDGER_HOST=0.0.0.0 再启动）");
startServer(() => {
  syncLanUrl();
  startTunnel();
  startWatchdog();
});
