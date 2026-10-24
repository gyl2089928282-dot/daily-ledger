/**
 * 界面开关：哪些模块显示，由使用者决定。
 *
 * 公用代码不预设「每个人都用得上作业台账、专项、睡眠记录」——
 * 大一可能只想要每日打卡，研究生可能只想记进度不想记作业，脱产备考的人可能没有课程。
 * 所以把「显示什么」也做成配置，关掉的模块在页面、分析结论、每晚提醒里都不出现。
 *
 * 数据存在 profile.ui：
 *   { tabs: {checkin:true, asg:false, ...}, modules: {sleep:true, focus:false, ...} }
 * 只写明确设过的项，没写的一律按默认（全开）——老方案不用迁移。
 */

/** 可关闭的页签。设置页本身不在这个表里：它必须始终可达，否则关完就找不回来了。 */
export const TABS = [
  { id: "checkin", name: "今日打卡", desc: "每天填一次，是整套东西的入口" },
  { id: "asg", name: "作业台账", desc: "记作业的布置、截止、完成情况" },
  { id: "week", name: "本周复盘", desc: "周负荷、三项优先任务、五问复盘" },
  { id: "history", name: "记录趋势", desc: "近 14 天投入、全部打卡、周复盘存档" },
  { id: "milestones", name: "节点", desc: "接下来会发生什么、已知信息缺口" },
  { id: "plan", name: "我的方案", desc: "课程、考期、专项、预算" }
];

/** 页面内部的模块开关（不影响页签，只影响某一块内容） */
export const MODULES = [
  { id: "brief", name: "今晚提醒条", desc: "页面顶部每晚那条提醒" },
  { id: "focus", name: "专项栏目", desc: "状态条、本周统计、历史表里的专项部分；没配专项时本来也不显示" },
  { id: "sleep", name: "睡眠记录", desc: "打卡页的睡眠小时数，参与「睡眠不足」判断" },
  { id: "blocker", name: "卡点记录", desc: "打卡页「今天卡在哪」" },
  { id: "courseProgress", name: "课程推进打分", desc: "打卡页每门课 0–3 级的推进；关掉后课程类判断不再触发" },
  { id: "stripAsg", name: "状态条 · 待做作业", desc: "顶部那一格，关掉作业台账时可一起关" },
  { id: "stripExam", name: "状态条 · 距期末首科", desc: "顶部那一格，没有考期的人可以关" }
];

/** 说明只读的是 profile.ui，不需要额外的本地存储键 */

export function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 全开：没配置、没这个键、写了 true，都等于开 */
export function defaultUi() {
  const tabs = {};
  const modules = {};
  TABS.forEach((t) => { tabs[t.id] = true; });
  MODULES.forEach((m) => { modules[m.id] = true; });
  return { tabs, modules };
}

/**
 * 把任意形态的 ui 补成完整开关表。
 * 入参可以是 profile.ui，也可以是现成的 {tabs,modules}；undefined / null / 非对象都按全开处理。
 */
export function fillUi(raw) {
  const def = defaultUi();
  const r = isObj(raw) ? raw : {};
  const rt = isObj(r.tabs) ? r.tabs : {};
  const rm = isObj(r.modules) ? r.modules : {};
  TABS.forEach((t) => { if (rt[t.id] === false) def.tabs[t.id] = false; });
  MODULES.forEach((m) => { if (rm[m.id] === false) def.modules[m.id] = false; });
  return def;
}

/**
 * 把方案里的 ui 段读成完整开关表。
 * 缺省全开；显式的 false 才算关。
 * @param {object} profile
 * @returns {{tabs:Object<string,boolean>, modules:Object<string,boolean>}}
 */
export function uiOf(profile) {
  return fillUi(isObj(profile) ? profile.ui : null);
}

/** 有哪个页签是开着的（用于「全关了就回退到设置页」） */
export function anyTabOn(ui) {
  return TABS.some((t) => ui.tabs[t.id] !== false);
}
