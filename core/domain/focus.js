/**
 * 专项：课程之外的「第二战场」。
 *
 * 为什么单独抽一层：
 *   原来这块叫 cet，硬编码假设使用者考六级——三个计数器叫「单词 / 精听 / 真题」，
 *   分数上限写死 710，兜底文案写「六级」。但大学里这条线可能是四级、考研数学、
 *   计算机二级、教师资格证、执业医师、法考、作品集、竞赛题库……也可能压根没有。
 *
 * 所以这里只定义结构，不定义内容：
 *   · 三个计数器（A / B / C）的名字与周目标由使用者填，留空用中性词兜底
 *   · 分数是「可选」的：不填 target 就不谈分数，不谈分项结构
 *   · 整个专项是「可选」的：label 与 date 都空 → enabled=false，页面不显示该栏目
 *
 * 兼容：老方案里这块叫 profile.cet，带 wordsPerWeek / listenPerWeek。
 * 新写法是 profile.focus + goals/units，两者都能读，老数据不用手动迁移。
 */

/** 中性命名的兜底：不是英语也能读通 */
export const UNIT_FALLBACK = { words: "数量", listen: "次数", paper: "套卷" };

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v) {
  return v == null ? "" : String(v).trim();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pick(...vals) {
  for (const v of vals) if (v != null && v !== "") return v;
  return null;
}

/**
 * 把方案里的专项配置读成一份完整的、可直接渲染的对象。
 * 任何字段缺失都不会抛错——旧方案、空对象、乱七八糟的输入都退化成「未启用」。
 *
 * @param {object} profile 方案
 * @returns {{label:string,date:string|null,time:string,target:number|null,scoreMax:number|null,
 *            duration:string,units:{words:string,listen:string,paper:string},
 *            goals:{words:number,listen:number,paper:number},enabled:boolean}}
 */
export function focusOf(profile) {
  const p = isObj(profile) ? profile : {};
  const raw = isObj(p.focus) ? p.focus : isObj(p.cet) ? p.cet : {};
  const units = isObj(raw.units) ? raw.units : {};
  const goals = isObj(raw.goals) ? raw.goals : {};

  const out = {
    label: str(raw.label),
    date: str(raw.date) || null,
    time: str(raw.time),
    target: numOrNull(raw.target),
    scoreMax: numOrNull(raw.scoreMax),
    duration: str(raw.duration),
    units: {
      words: str(units.words) || UNIT_FALLBACK.words,
      listen: str(units.listen) || UNIT_FALLBACK.listen,
      paper: str(units.paper) || UNIT_FALLBACK.paper
    },
    goals: {
      // 旧键 wordsPerWeek / listenPerWeek 继续生效
      words: num(pick(goals.words, raw.wordsPerWeek, 0)),
      listen: num(pick(goals.listen, raw.listenPerWeek, 0)),
      paper: num(pick(goals.paper, 0))
    }
  };
  // 有名字或考期才算配置过；只填了周目标没有名字的，视作没配 —— 否则界面上会出现「专项 0 天」
  out.enabled = !!(out.label || out.date);
  return out;
}

/** 界面上的称呼：没配名字时统一叫「专项」，不要退回某个具体考试 */
export function focusName(f) {
  return (f && f.label) || "专项";
}
