/**
 * 统计聚合。全部参数化：不读任何全局变量，也不看当前时间。
 *
 * 「今天」一律由调用方传进来——这样测试可以冻结时钟，
 * 定时任务算的是「当晚」，页面算的是「打开那天的今天」。
 */
import { addDays, daysBetween } from "./dates.js";

/** 某一周（周一起）里有记录的天数，只返回存在的记录 */
export function getWeekDays(db, ws) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    if (db.days[d]) out.push(db.days[d]);
  }
  return out;
}

export function sumHours(list) {
  return list.reduce((s, d) => s + (d.hours || 0), 0);
}

/** 某门课最后一次有推进（等级 ≥1）距今多少天；从来没推进过返回 null */
export function courseGapDays(db, cid, today) {
  const ds = Object.keys(db.days)
    .filter((k) => db.days[k].courses && db.days[k].courses[cid] >= 1)
    .sort()
    .reverse();
  if (!ds.length) return null;
  return daysBetween(ds[0], today);
}

/**
 * 本周的专项投入：计数 A / 计数 B / 整卷数 / 本周记录的分数。
 * 字段名沿用 early 版本的 words / listen / paper（记录里已经这么存了，改键要迁移全部历史数据），
 * 但语义就是「三个计数器」，具体叫什么由方案的 focus.units 决定。
 */
export function focusWeek(db, ws) {
  const ds = getWeekDays(db, ws);
  return {
    words: ds.reduce((s, d) => s + (d.words || 0), 0),
    listen: ds.reduce((s, d) => s + (d.listen || 0), 0),
    paper: ds.reduce((s, d) => s + (d.paper || 0), 0),
    scores: ds.filter((d) => d.score).map((d) => ({ date: d.date, score: d.score }))
  };
}

/** 旧名，留作兼容：外部脚本/旧页面可能还在 import cetWeek */
export const cetWeek = focusWeek;

/** 从今天往前数，连续多少天都有投入（休息日或空记录即中断，最多看 30 天） */
export function streakNoRest(db, today) {
  let n = 0;
  let cur = today;
  for (let i = 0; i < 30; i++) {
    const r = db.days[cur];
    if (!r) break;
    if (r.focus === "rest" || (r.hours || 0) === 0) break;
    n++;
    cur = addDays(cur, -1);
  }
  return n;
}

/**
 * 教学周次。没有锚点日期时不自造周次，直接沿用配置里的周数。
 */
export function semWeek(profile, s) {
  if (!profile.weekAnchor) return profile.weekAnchorNo || 1;
  return profile.weekAnchorNo + Math.floor(daysBetween(profile.weekAnchor, s) / 7);
}

/* ───────── 作业 ───────── */

export function isOpen(a) {
  return a.status === "todo" || a.status === "doing";
}

/** 逾期天数；未逾期或已结束返回 null */
export function overdueDays(a, today) {
  if (!a.due || !isOpen(a)) return null;
  const d = daysBetween(a.due, today);
  return d > 0 ? d : null;
}

/** 距截止还有几天（可以为负）；已结束返回 null */
export function dueIn(a, today) {
  if (!a.due || !isOpen(a)) return null;
  return daysBetween(today, a.due);
}

/** 未完成的作业，按截止日期升序、无截止的排最后、同日期按优先级降序 */
export function pendAsg(db) {
  return db.assignments
    .filter((a) => isOpen(a))
    .sort((x, y) => {
      if (!x.due && !y.due) return (y.pri || 1) - (x.pri || 1);
      if (!x.due) return 1;
      if (!y.due) return -1;
      if (x.due !== y.due) return x.due.localeCompare(y.due);
      return (y.pri || 1) - (x.pri || 1);
    });
}

/** 已完成 / 已批改，按完成日期倒序 */
export function doneAsg(db) {
  return db.assignments
    .filter((a) => !isOpen(a))
    .sort((x, y) => (y.doneDate || y.due || "").localeCompare(x.doneDate || x.due || ""));
}
