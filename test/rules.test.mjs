/**
 * 规则回归：抽取后的 core/domain/rules.js 必须与重构前的行为逐字一致。
 *
 * golden 由 test/characterize.mjs 从旧的内联脚本跑出来，是不可变基线。
 * 如果这里挂了，只有两种可能：
 *   1. 抽取时把规则改错了 —— 修 rules.js
 *   2. 你确实想改规则 —— 改完 rules.js 后重新审 golden，并同步 README 的规则表
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAnalysis, T } from "../core/domain/rules.js";
import { focusOf } from "../core/domain/focus.js";
import { semWeek, overdueDays, dueIn, streakNoRest } from "../core/domain/stats.js";
import { normalizeDB, mergeProfile, mergeDBs, validateDB, validateProfile, fixCourseIds } from "../core/domain/schema.js";
import { addDays, daysBetween, weekStartOf, fmtMD, parseD, ymd } from "../core/domain/dates.js";
import { esc, stripTags } from "../core/domain/text.js";
import { fillUi, uiOf, TABS, MODULES } from "../core/domain/ui.js";
import { CASES, FIXED_TODAY, PROFILE_MIN, db, rec, rel } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(HERE, "golden", "analysis.json"), "utf8"));

test("日期工具：跨月、周一归属、差值", () => {
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(daysBetween("2026-10-01", "2026-11-01"), 31);
  assert.equal(weekStartOf("2026-10-22"), "2026-10-19"); // 周四 → 周一
  assert.equal(weekStartOf("2026-10-25"), "2026-10-19"); // 周日算上一周最后一天
  assert.equal(fmtMD("2026-10-05"), "10/5");
  assert.equal(ymd(parseD("2026-02-29")), "2026-03-01"); // 非闰年顺延，不自造日期
});

test("文本：esc 与 stripTags 互为逆操作（对纯文本）", () => {
  assert.equal(esc("<b>&\"'"), "&lt;b&gt;&amp;&quot;'");
  assert.equal(stripTags("已投入 <b>3.5h</b> &amp; 继续"), "已投入 3.5h & 继续");
  assert.equal(stripTags(esc("a<b")), "a<b");
});

test("schema：normalizeDB 容忍脏数据但不吞数组", () => {
  assert.deepEqual(normalizeDB(null).days, {});
  assert.deepEqual(normalizeDB({ days: [] }).days, {});
  assert.deepEqual(normalizeDB({ days: { "2026-10-22": {} }, extra: 1 }).extra, 1);
  assert.deepEqual(validateDB(db()), []);
  assert.ok(validateDB(db({ days: { "10/22": {} } })).length > 0);
});

test("schema：mergeProfile 保留助手维护的字段", () => {
  const cur = { courses: [{ id: "c9", name: "旧课" }], milestones: [{ id: "m1" }], weekTasks: { w: 1 }, gaps: ["x"], cet: { date: rel(10) } };
  const next = mergeProfile(cur, { weeklyBudget: 20, courses: [{ name: "新课" }] }, "2026-10-22T12:00:00.000Z");
  assert.equal(next.weeklyBudget, 20);
  assert.equal(next.milestones.length, 1);
  assert.deepEqual(next.weekTasks, { w: 1 });
  assert.deepEqual(next.gaps, ["x"]);
  assert.equal(next.cet.date, rel(10));
  assert.equal(next.meta.updatedAt, "2026-10-22T12:00:00.000Z");
});

test("schema：fixCourseIds 保留已有 id，只给缺的补", () => {
  const out = fixCourseIds([{ id: "c7", name: "甲" }, { name: "乙" }, { full: "丙" }, null, { note: "无名" }]);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, "c7");
  assert.equal(out[1].id, "c2");
  assert.equal(out[2].id, "c3");
});

test("schema：validateProfile 拦得住明显错的值", () => {
  assert.deepEqual(validateProfile(PROFILE_MIN), []);
  assert.ok(validateProfile({ courses: "x" }).length > 0);
  assert.ok(validateProfile({ weeklyBudget: 200 }).length > 0);
  assert.ok(validateProfile({ courses: [{ name: "甲", exam: "2026/1/9" }] }).length > 0);
});

test("stats：逾期与到期的边界", () => {
  const a = { due: rel(-1), status: "todo" };
  assert.equal(overdueDays(a, FIXED_TODAY), 1);
  assert.equal(dueIn(a, FIXED_TODAY), -1);
  assert.equal(overdueDays({ due: rel(0), status: "todo" }, FIXED_TODAY), null); // 今天到期不算逾期
  assert.equal(overdueDays({ due: rel(-3), status: "done" }, FIXED_TODAY), null); // 已完成不算
  assert.equal(dueIn({ status: "todo" }, FIXED_TODAY), null); // 无截止不算
});

test("stats：连续无休在遇到空档时中断", () => {
  const days = {};
  days[rel(0)] = rec({ date: rel(0), hours: 2 });
  days[rel(-1)] = rec({ date: rel(-1), hours: 2 });
  days[rel(-3)] = rec({ date: rel(-3), hours: 2 }); // 断在 -2
  assert.equal(streakNoRest(db({ days }), rel(0)), 2);
});

test("规则：12 个用例与重构前逐字一致", () => {
  for (const c of CASES) {
    const base = golden.cases.find((g) => g.name === c.name);
    assert.ok(base, "golden 里缺少用例 " + c.name);
    assert.ok(!base.error, "golden 里该用例本身就是失败的：" + base.name);

    const got = buildAnalysis(c.db, c.profile, c.rec, FIXED_TODAY);
    assert.deepEqual(
      { analyses: got.analyses, acts: got.acts },
      { analyses: base.analyses, acts: base.acts },
      "用例不一致：" + c.name
    );
    assert.equal(semWeek(c.profile, FIXED_TODAY), base.semWeekToday, "教学周不一致：" + c.name);
  }
});

test("规则：输出上限与结构约束", () => {
  for (const c of CASES) {
    const r = buildAnalysis(c.db, c.profile, c.rec, FIXED_TODAY);
    assert.ok(r.analyses.length <= T.maxAnalyses, "结论超过上限：" + c.name);
    assert.ok(r.acts.length <= T.maxActs, "行动超过上限：" + c.name);
    r.analyses.forEach((a) => {
      assert.equal(typeof a.title, "string");
      assert.equal(typeof a.body, "string");
      assert.ok(["bad", "warn", "", "good"].includes(a.type), "未知类型：" + a.type);
    });
    r.acts.forEach((a) => {
      assert.ok(a.text && a.why, "行动必须同时有 text 与 why");
    });
  }
});

test("规则：逾期项必然占一个行动名额", () => {
  const c = CASES.find((x) => x.name === "02-作业逾期两项");
  const r = buildAnalysis(c.db, c.profile, c.rec, FIXED_TODAY);
  assert.ok(r.acts.some((a) => a.text.includes("先处理")), "逾期时第一条行动应当处理逾期作业");
  assert.equal(r.analyses[0].type, "bad", "逾期结论应当排在最前");
});

test("规则：没有方案时不崩、不猜", () => {
  const empty = { courses: [], weeklyBudget: 15, cet: {}, nodes: {}, weekTasks: {} };
  const r = buildAnalysis(db(), empty, rec({ hours: 1 }), FIXED_TODAY);
  assert.ok(Array.isArray(r.analyses));
  assert.ok(Array.isArray(r.acts));
  r.analyses.forEach((a) => assert.ok(!/undefined|NaN/.test(a.title + a.body), "输出里出现了 undefined/NaN"));
});

/* ───────── 专项通用化：同一套规则，专业 / 年级 / 考什么都不该被写死 ─────────
   fixtures 里的 cet（旧键）+「英语考试」是有意保留的：它同时充当「老方案仍可读」的回归。 */

test("专项：完全没配置时，不产生任何专项结论或行动", () => {
  const p = { courses: PROFILE_MIN.courses, weeklyBudget: 15, nodes: {}, weekTasks: {}, focus: {} };
  const record = rec({ hours: 3, courses: { c1: 1, c2: 1, c3: 1 } });
  const r = buildAnalysis(db({ days: { [FIXED_TODAY]: record } }), p, record, FIXED_TODAY);
  const text = r.analyses.map((a) => a.title + a.body).join("") + r.acts.map((a) => a.text + a.why).join("");
  assert.ok(!/专项|六级|真题|单词|精听|英语/.test(text), "没配专项却出现了专项文案：" + text);
});

test("专项：换专业 / 换证书只换配置，规则里不出现英语前提", () => {
  const focus = {
    label: "计算机二级",
    date: rel(40),
    target: 90,
    scoreMax: 100,
    duration: "2h",
    units: { words: "题量", listen: "错题复盘", paper: "模考" },
    goals: { words: 200, listen: 3 }
  };
  const p = Object.assign({}, PROFILE_MIN, { focus });
  delete p.cet;
  const record = rec({ hours: 3, courses: { c1: 1, c2: 1, c3: 1 }, words: 120, listen: 1, paper: 0 });
  const r = buildAnalysis(db({ days: { [FIXED_TODAY]: record } }), p, record, FIXED_TODAY);
  const text = r.analyses.map((a) => a.title + a.body).join("") + r.acts.map((a) => a.text).join("");
  assert.match(text, /计算机二级/);
  assert.match(text, /题量/);
  assert.ok(!/六级|单词|精听|英语/.test(text), "仍出现了英语专属文案：" + text);
});

test("专项：旧方案（cet 键、无 units）仍可读，文案退回中性词", () => {
  const f = focusOf({ cet: { label: "旧专项", date: rel(30), wordsPerWeek: 300, listenPerWeek: 5 } });
  assert.equal(f.enabled, true);
  assert.equal(f.goals.words, 300);
  assert.equal(f.goals.listen, 5);
  assert.equal(f.units.words, "数量");
  assert.equal(focusOf({}).enabled, false);
  assert.equal(focusOf({ focus: { date: rel(10) } }).enabled, true);
  assert.equal(focusOf({ focus: { label: "四级", units: { words: "单词" } } }).units.listen, "次数");
});

/* ───────── 并发写入：整份覆盖 → 按日期/条目合并 ─────────
   场景：手机记今天、电脑补昨天，两边几乎同时提交。
   旧的整份覆盖会让后提交的那份把另一份整天抹掉；合并后两边都留下。 */

const day = (hours, ts) => ({ date: "", hours, focus: "", words: 0, listen: 0, paper: 0, courses: {}, blocker: "", ts });

test("合并：两台设备各记一天，两天都要在", () => {
  const disk = { days: { "2026-10-21": day(2, 1000) }, weeks: {}, assignments: [], meta: { version: 1, updatedAt: "2026-10-21T10:00:00.000Z" } };
  const mine = { days: { "2026-10-22": day(3, 2000) }, weeks: {}, assignments: [], meta: { version: 1, updatedAt: "2026-10-22T10:00:00.000Z" } };
  const m = mergeDBs(disk, mine);
  assert.deepEqual(Object.keys(m.days).sort(), ["2026-10-21", "2026-10-22"], "合并后丢了一天");
  assert.equal(m.days["2026-10-21"].hours, 2);
  assert.equal(m.days["2026-10-22"].hours, 3);
});

test("合并：同一天两边都改，ts 新的胜", () => {
  const disk = { days: { "2026-10-22": day(2, 2000) }, weeks: {}, assignments: [], meta: { version: 1, updatedAt: "" } };
  const mine = { days: { "2026-10-22": day(5, 1000) }, weeks: {}, assignments: [], meta: { version: 1, updatedAt: "" } };
  assert.equal(mergeDBs(disk, mine).days["2026-10-22"].hours, 2, "应当保留 ts 更大的那份");
  const newer = { days: { "2026-10-22": day(5, 3000) }, weeks: {}, assignments: [], meta: { version: 1, updatedAt: "" } };
  assert.equal(mergeDBs(disk, newer).days["2026-10-22"].hours, 5, "新提交应当胜出");
});

test("合并：作业按 id 求并集，不因另一端文档里没有就消失", () => {
  const disk = { days: {}, weeks: {}, assignments: [{ id: "a1", title: "报告", course: "c1", due: "2026-10-25", status: "todo" }], meta: { version: 1, updatedAt: "" } };
  const mine = { days: {}, weeks: {}, assignments: [
    { id: "a1", title: "报告", course: "c1", due: "2026-10-25", status: "done" },
    { id: "a2", title: "习题", course: "c1", due: "2026-10-26", status: "todo" }
  ], meta: { version: 1, updatedAt: "" } };
  const m = mergeDBs(disk, mine);
  assert.equal(m.assignments.length, 2, "并集应保留两条");
  assert.equal(m.assignments.find((a) => a.id === "a1").status, "done", "状态更新应当生效");
});

test("合并：周任务按周键求并集，同键取 ts 新的", () => {
  const disk = { days: {}, weeks: { w1: { next: "盘库", ts: 1000 } }, assignments: [], meta: { version: 1, updatedAt: "" } };
  const mine = { days: {}, weeks: { w1: { next: "改方案", ts: 2000 }, w2: { next: "写总结", ts: 1500 } }, assignments: [], meta: { version: 1, updatedAt: "" } };
  const m = mergeDBs(disk, mine);
  assert.deepEqual(Object.keys(m.weeks).sort(), ["w1", "w2"]);
  assert.equal(m.weeks.w1.next, "改方案", "同周应取 ts 新的");
});

test("合并：任一侧为空都不破坏另一侧，且不修改入参", () => {
  const disk = { days: { "2026-10-22": day(2, 1000) }, weeks: {}, assignments: [], meta: { version: 1, updatedAt: "T1" } };
  const empty = { days: {}, weeks: {}, assignments: [], meta: { version: 1, updatedAt: "T0" } };
  const snapshot = JSON.stringify(disk);
  const m = mergeDBs(disk, empty);
  assert.equal(Object.keys(m.days).length, 1, "空提交不应清空磁盘数据");
  assert.equal(m.meta.updatedAt, "T1", "meta.updatedAt 应取较新一侧");
  assert.equal(JSON.stringify(disk), snapshot, "mergeDBs 不应当改写入参");
  assert.equal(Object.keys(mergeDBs(emptyDBish(), disk).days).length, 1);
});

function emptyDBish() {
  return { days: {}, weeks: {}, assignments: [], meta: { version: 1, updatedAt: "" } };
}

/* ────────────────── 界面开关（功能选择） ──────────────────
   这些用例守住一条：关掉的模块不许再出结论。
   否则「取消勾选」只是把输入框藏起来，第二天照旧被催 —— 那不是开关，是欺骗。 */

test("ui：缺省全开，只有显式 false 才算关", () => {
  const d = fillUi(undefined);
  assert.equal(d.tabs.checkin, true);
  assert.equal(d.modules.sleep, true);
  assert.equal(fillUi({ modules: { sleep: false } }).modules.sleep, false);
  assert.equal(fillUi({ modules: { sleep: "false" } }).modules.sleep, true, "只认真假值 false，字符串不算");
  assert.equal(fillUi(null).tabs.plan, true);
  assert.equal(uiOf({ ui: { tabs: { asg: false } } }).tabs.asg, false);
  assert.equal(uiOf({}).tabs.asg, true, "老方案没有 ui 段时一切照旧");
  assert.equal(uiOf({ ui: { tabs: { asg: false } } }).modules.blocker, true, "没写到的模块保持全开");
});

test("ui：TABS / MODULES 清单里的 id 与代码里的判断一致", () => {
  const ids = TABS.map((t) => t.id);
  ["checkin", "asg", "week", "history", "milestones", "plan"].forEach((id) => assert.ok(ids.includes(id), "缺少页签 " + id));
  TABS.concat(MODULES).forEach((x) => assert.ok(x.name && x.desc, x.id + " 要有显示名与说明"));
});

test("规则：关掉睡眠就不再评价睡眠", () => {
  const recSleepy = rec({ hours: 4, sleep: 5, courses: { c1: 1, c2: 1, c3: 1 } });
  const d = db({ days: { [FIXED_TODAY]: recSleepy } });
  const base = buildAnalysis(d, PROFILE_MIN, recSleepy, FIXED_TODAY);
  assert.ok(base.analyses.some((a) => a.title.includes("睡眠不足")), "开着时应当报睡眠不足");
  const off = buildAnalysis(d, PROFILE_MIN, recSleepy, FIXED_TODAY, { modules: { sleep: false } });
  assert.ok(!off.analyses.some((a) => a.title.includes("睡眠")), "关掉后不该再提睡眠");
});

test("规则：关掉课程打分就不再催诊断、不再报断层", () => {
  const r = rec({ hours: 2, courses: { c1: 0, c2: 0, c3: 0 } });
  const d = db({
    days: { [FIXED_TODAY]: r, [rel(-9)]: rec({ date: rel(-9), hours: 3, courses: { c1: 1, c2: 0, c3: 0 } }) }
  });
  const ui = { modules: { courseProgress: false } };
  const on = buildAnalysis(d, PROFILE_MIN, r, FIXED_TODAY);
  const off = buildAnalysis(d, PROFILE_MIN, r, FIXED_TODAY, ui);
  assert.ok(on.analyses.some((a) => a.title.includes("没碰过") || a.title.includes("没开始")), "开着时应当催诊断");
  assert.ok(!off.analyses.some((a) => a.title.includes("没碰过") || a.title.includes("没开始")), "关掉后不再催");
  assert.ok(!off.analyses.some((a) => a.title.includes("没推进")), "断层判断也跟着停");
  assert.ok(!off.acts.some((a) => a.text.includes("摸底")), "行动项里也不该出现摸底");
});

test("规则：关掉专项就不再出专项结论与行动", () => {
  const r = rec({ hours: 3, words: 10, paper: 0, courses: { c1: 1, c2: 1, c3: 1 } });
  const d = db({ days: { [FIXED_TODAY]: r } });
  const on = buildAnalysis(d, PROFILE_MIN, r, FIXED_TODAY);
  const off = buildAnalysis(d, PROFILE_MIN, r, FIXED_TODAY, { modules: { focus: false } });
  assert.ok(on.analyses.some((a) => a.title.includes("英语考试")), "开着时应当有专项节奏结论");
  assert.ok(!off.analyses.some((a) => a.title.includes("英语考试")), "关掉后专项整段消失");
  assert.ok(!off.acts.some((a) => a.text.includes("真题") || a.text.includes("计时")), "行动项同样不再提");
});

test("规则：不传 ui 时行为与旧签名完全一致（向后兼容）", () => {
  const r = rec({ hours: 3, sleep: 5.5, words: 100, courses: { c1: 2, c2: 2, c3: 2 } });
  const d = db({ days: { [FIXED_TODAY]: r } });
  assert.deepEqual(
    buildAnalysis(d, PROFILE_MIN, r, FIXED_TODAY),
    buildAnalysis(d, PROFILE_MIN, r, FIXED_TODAY, undefined)
  );
});

test("schema：界面开关写得进 profile，也留得住", () => {
  const cur = { courses: [{ name: "课程一" }], ui: { tabs: { asg: false }, modules: { sleep: false } }, meta: {} };
  // 表单没提交 ui（改的是别的字段）→ 开关保持原样
  const keep = mergeProfile(cur, { weeklyBudget: 20 }, "T1");
  assert.equal(keep.ui.tabs.asg, false);
  assert.equal(keep.ui.modules.sleep, false);
  // 提交了全量 ui（设置页总是提交全量）→ 整体替换
  const set = mergeProfile(cur, { ui: { tabs: { asg: true }, modules: { sleep: true } } }, "T2");
  assert.equal(set.ui.tabs.asg, true);
  assert.equal(set.ui.modules.sleep, true);
  assert.deepEqual(validateProfile(set), [], "ui 不该被方案校验拦下");
});
