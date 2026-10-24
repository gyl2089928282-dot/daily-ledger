/**
 * 日期工具。纯函数，无全局状态，浏览器与 Node 共用。
 *
 * 约定：所有对外交换的日期都是 "YYYY-MM-DD" 字符串，只在需要做算术时才转 Date。
 * 不要用 toISOString() 取日期——它按 UTC 截断，东八区晚上会差一天。
 */

export function pad(n) {
  return String(n).padStart(2, "0");
}

/** Date → "YYYY-MM-DD"（本地时区） */
export function ymd(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** 今天 */
export function todayStr() {
  return ymd(new Date());
}

/** "YYYY-MM-DD" → Date（本地零点） */
export function parseD(s) {
  const p = String(s).split("-").map(Number);
  return new Date(p[0], p[1] - 1, p[2]);
}

/** b - a 的天数差。用四舍五入吃掉夏令时造成的一小时抖动。 */
export function daysBetween(a, b) {
  return Math.round((parseD(b) - parseD(a)) / 86400000);
}

export function addDays(s, n) {
  const d = parseD(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** 所在周的周一（周日算上一周的最后一天） */
export function weekStartOf(s) {
  const d = parseD(s);
  const wd = d.getDay();
  d.setDate(d.getDate() + (wd === 0 ? -6 : 1 - wd));
  return ymd(d);
}

export function fmtMD(s) {
  const d = parseD(s);
  return d.getMonth() + 1 + "/" + d.getDate();
}

export const WK = ["日", "一", "二", "三", "四", "五", "六"];

export function fmtCn(s) {
  const d = parseD(s);
  return d.getMonth() + 1 + " 月 " + d.getDate() + " 日 · 周" + WK[d.getDay()];
}
