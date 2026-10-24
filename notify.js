/**
 * notify.js —— 隧道地址变更时的手机推送
 *
 * 设计原则：
 *   - 零依赖，只用 node 内置模块，随 launch.js 一起跑
 *   - 多渠道可插拔，全部在 private/config.json 的 notify 段落里配置
 *   - 任何一个渠道失败都不影响隧道本身，只记一行日志
 *
 * 支持的渠道（配哪个用哪个，配多个就都发）：
 *   ntfyTopic      ntfy.sh 主题名，手机装 ntfy App 订阅同名主题即可，免注册
 *   barkUrl        Bark 推送地址，如 https://api.day.app/你的Key（iOS）
 *   pushplusToken  PushPlus 的 token，推送到微信（pushplus.plus）
 *   serverchanKey  Server酱 SendKey，推送到微信服务号
 *   webhookUrl     自定义 webhook，POST JSON { text, url, lan, at }
 *
 * 注意：这里故意不走系统代理（node 原生请求本来也不读 http_proxy），
 * 校园网若直连 ntfy.sh 不通，改用 webhook 或 Bark 即可。
 */
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const TIMEOUT = 10000;

function post(target, body, headers) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(target);
    } catch (e) {
      return resolve({ ok: false, detail: "地址不合法" });
    }
    const mod = u.protocol === "https:" ? https : http;
    const data = Buffer.from(body, "utf8");
    const req = mod.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: Object.assign({ "Content-Length": data.length }, headers),
        timeout: TIMEOUT
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve({ ok, detail: "HTTP " + res.statusCode + (ok ? "" : " " + buf.slice(0, 120)) });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, detail: "超时" });
    });
    req.on("error", (e) => resolve({ ok: false, detail: e.code || e.message }));
    req.write(data);
    req.end();
  });
}

function get(target) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(target);
    } catch (e) {
      return resolve({ ok: false, detail: "地址不合法" });
    }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        method: "GET",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        timeout: TIMEOUT
      },
      (res) => {
        res.resume();
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, detail: "HTTP " + res.statusCode });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, detail: "超时" });
    });
    req.on("error", (e) => resolve({ ok: false, detail: e.code || e.message }));
    req.end();
  });
}

function buildMessage(base, link, lan) {
  const t = new Date().toLocaleString("zh-CN", { hour12: false });
  return (
    "公网：" + link + "\n" +
    "局域网：" + (lan || "（未知）") + "\n" +
    "更新时间：" + t + "\n" +
    "提示：电脑关机或睡眠后公网地址失效。"
  );
}

/**
 * @param {{base:string, link:string, lan:string, notify:object}} p
 * @returns {Promise<Array<{channel:string, ok:boolean, detail:string}>>}
 */
async function send(p) {
  const cfg = p.notify || {};
  const msg = buildMessage(p.base, p.link, p.lan);
  const title = "学业台账 · 隧道地址已更新";
  const jobs = [];

  if (cfg.ntfyTopic) {
    const server = (cfg.ntfyServer || "https://ntfy.sh").replace(/\/+$/, "");
    const payload = {
      topic: cfg.ntfyTopic,
      title: title,
      message: msg,
      click: p.link,
      tags: ["books"],
      priority: 3
    };
    jobs.push(
      post(server + "/", JSON.stringify(payload), { "Content-Type": "application/json" })
        .then((r) => Object.assign({ channel: "ntfy" }, r))
    );
  }

  if (cfg.barkUrl) {
    const b = cfg.barkUrl.replace(/\/+$/, "");
    const url = b + "/" + encodeURIComponent(title) + "/" + encodeURIComponent(msg.split("\n")[0]) +
      "?url=" + encodeURIComponent(p.link);
    jobs.push(get(url).then((r) => Object.assign({ channel: "bark" }, r)));
  }

  if (cfg.pushplusToken) {
    const body = JSON.stringify({
      token: cfg.pushplusToken,
      title: title,
      content: '<b>公网：</b><a href="' + p.link + '">' + p.link + "</a><br><b>局域网：</b>" +
        (p.lan || "") + "<br>电脑关机后失效。",
      template: "html"
    });
    jobs.push(
      post("https://www.pushplus.plus/send", body, { "Content-Type": "application/json" })
        .then((r) => Object.assign({ channel: "pushplus" }, r))
    );
  }

  if (cfg.serverchanKey) {
    const body = "title=" + encodeURIComponent(title) + "&desp=" + encodeURIComponent(msg);
    jobs.push(
      post("https://sctapi.ftqq.com/" + cfg.serverchanKey + ".send", body, {
        "Content-Type": "application/x-www-form-urlencoded"
      }).then((r) => Object.assign({ channel: "serverchan" }, r))
    );
  }

  if (cfg.webhookUrl) {
    const body = JSON.stringify({ text: title + "\n" + msg, url: p.link, lan: p.lan, at: new Date().toISOString() });
    const headers = { "Content-Type": "application/json" };
    if (cfg.webhookToken) headers["Authorization"] = "Bearer " + cfg.webhookToken;
    jobs.push(post(cfg.webhookUrl, body, headers).then((r) => Object.assign({ channel: "webhook" }, r)));
  }

  if (!jobs.length) return [];
  return Promise.all(jobs);
}

module.exports = { send: send };

/**
 * 自检：node notify.js
 * 拿当前配置把每个渠道都打一遍，直接看哪个通道通、哪个不通。
 * 手机上收不到推送时，先跑这个，能立刻区分「通道坏了」还是「地址本身是死的」。
 */
if (require.main === module) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "private", "config.json"), "utf8")).notify || {};
  } catch (e) {
    console.log("读不到 private/config.json：" + e.message);
  }
  const demo = process.argv[2] || "https://example.com/?k=test";
  console.log("测试渠道：" + Object.keys(cfg).filter((k) => cfg[k] && k !== "note" && k !== "ntfyServer").join(", "));
  send({ base: demo, link: demo, lan: "", notify: cfg }).then((res) => {
    if (!res.length) return console.log("notify 段里没有启用任何渠道");
    res.forEach((r) => console.log((r.ok ? "[OK]   " : "[FAIL] ") + r.channel + "  " + r.detail));
  });
}
