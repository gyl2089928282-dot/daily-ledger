/**
 * 接口契约测试：合并语义 + 防护行为。
 *
 * 单元测试证明规则对，browser-check 证明页面能点；
 * 这个脚本证明「接口在并发和恶意输入下不出事」——这几条正是审查里定的 P0/P1：
 *   · 两台设备各记一天，不许互相抹掉（整份覆盖 → 按日期合并）
 *   · 空提交不许清库
 *   · 老客户端更旧的回写被拒
 *   · 超大请求体给 413，不是断连
 *   · 连续猜口令触发限流，但口令正确的人不受连坐
 *   · 畸形 URL 不许把进程搞死
 *
 * 用法：node test/api-e2e.mjs
 * 用临时私有目录和随机端口，绝不碰 private/ 里的真实记录。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRIV = path.join(os.tmpdir(), "ledger-api-e2e-" + Date.now());
const PORT = 3300 + Math.floor(Math.random() * 400);
const B = `http://127.0.0.1:${PORT}`;
const TOKEN = "testtok";
const H = { "Content-Type": "application/json", "x-ledger-key": TOKEN };

fs.mkdirSync(PRIV, { recursive: true });
fs.writeFileSync(path.join(PRIV, "config.json"), JSON.stringify({ token: TOKEN }));
fs.writeFileSync(
  path.join(PRIV, "records.json"),
  JSON.stringify({
    days: { "2026-10-20": { date: "2026-10-20", hours: 1, ts: 500 } },
    weeks: {},
    assignments: [],
    meta: { version: 1, updatedAt: "2026-10-20T00:00:00.000Z" }
  })
);

const srv = spawn(process.execPath, [path.join(ROOT, "core", "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), LEDGER_PRIVATE_DIR: PRIV, LEDGER_NO_TUNNEL: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
await new Promise((r) => setTimeout(r, 1500));

const api = async (method, body) => {
  const r = await fetch(B + "/api/data", { method, headers: H, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const day = (d, hours, ts) => ({ date: d, hours, ts });

let pass = 0;
const fails = [];
const ck = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fails.push(name);
    console.log("  ✗ " + name + (extra ? "  → " + extra : ""));
  }
};

try {
  const g0 = await api("GET");
  const T0 = g0.json.meta.updatedAt;

  // 快路径：底稿一致时整份覆盖，不做多余合并
  const p1 = await api("POST", {
    baseUpdatedAt: T0,
    days: { ...g0.json.days, "2026-10-21": day("2026-10-21", 3, 1000) },
    weeks: {},
    assignments: [],
    meta: { version: 1, updatedAt: "client-local" }
  });
  ck("底稿一致时走快路径（不触发合并）", p1.status === 200 && p1.json.ok && !p1.json.merged, JSON.stringify(p1.json).slice(0, 120));

  // 并发：另一台设备仍拿 T0 当底稿，提交了另一天
  const stale = await api("POST", {
    baseUpdatedAt: T0,
    days: { "2026-10-22": day("2026-10-22", 5, 2000) },
    weeks: {},
    assignments: [{ id: "a9", title: "报告", course: "c1", due: "2026-10-30", status: "todo" }],
    meta: { version: 1, updatedAt: "client-local" }
  });
  ck("底稿过期时服务端返回 merged", stale.status === 200 && stale.json.merged === true, JSON.stringify(stale.json).slice(0, 160));
  ck(
    "合并结果里两端的数据都在",
    !!(stale.json.db && stale.json.db.days["2026-10-21"] && stale.json.db.days["2026-10-22"]),
    stale.json.db ? Object.keys(stale.json.db.days).join(",") : "no db"
  );
  ck("合并结果保留了另一端的记录", stale.json.db && stale.json.db.days["2026-10-21"].hours === 3);

  const g1 = await api("GET");
  ck(
    "落盘后两个日期都在",
    Object.keys(g1.json.days).includes("2026-10-21") && Object.keys(g1.json.days).includes("2026-10-22"),
    Object.keys(g1.json.days).join(",")
  );
  ck("作业也合并进来了", (g1.json.assignments || []).some((a) => a.id === "a9"));

  // 空提交：底稿时间对得上，但内容是空的 —— 不许抹库
  const p3 = await api("POST", { baseUpdatedAt: g1.json.meta.updatedAt, days: {}, weeks: {}, assignments: [], meta: {} });
  const g2 = await api("GET");
  ck("整份空提交不会清掉数据", p3.status === 200 && Object.keys(g2.json.days).length >= 2, "days=" + Object.keys(g2.json.days).length);

  // 老客户端（不带 baseUpdatedAt）仍按时间戳防倒退
  const p4 = await api("POST", { days: {}, weeks: {}, assignments: [], meta: { version: 1, updatedAt: "2000-01-01T00:00:00.000Z" } });
  ck("老客户端更旧的回写被拒（409 stale）", p4.status === 409 && p4.json.reason === "stale", p4.status + " " + JSON.stringify(p4.json).slice(0, 80));

  // 超大请求体
  const big = await fetch(B + "/api/data", { method: "POST", headers: H, body: JSON.stringify({ days: { x: "y".repeat(3 * 1024 * 1024) } }) });
  ck("超大请求体返回 413 而不是断连", big.status === 413, String(big.status));

  // 口令爆破 → 限流；但口令正确的人不受连坐
  let last = 0;
  for (let i = 0; i < 35; i++) {
    const r = await fetch(B + "/api/data", { headers: { "x-ledger-key": "wrong" + i } });
    last = r.status;
  }
  ck("连续错误口令触发限流 429", last === 429, String(last));
  const ok1 = await fetch(B + "/api/data", { headers: H });
  ck("限流不影响口令正确的请求", ok1.status === 200, String(ok1.status));

  // 畸形 URL
  for (const p of ["/%", "/%zz", "/%E0%A4%A", "/a%00b"]) await fetch(B + p).catch(() => {});
  const alive = await fetch(B + "/api/data", { headers: H });
  ck("畸形 URL 之后进程仍然存活", alive.status === 200, String(alive.status));
} finally {
  srv.kill();
  fs.rmSync(PRIV, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}` + (fails.length ? "：" + fails.join("；") : ""));
process.exit(fails.length ? 1 : 0);
