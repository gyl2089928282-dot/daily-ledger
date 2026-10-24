/**
 * 数据模型：唯一真相。
 *
 * 以前这份结构在四个地方各写了一遍（server.js 的 emptyDB/normalize、
 * default-profile.json、index.html 的 DEFAULT_PLAN、README 的字段表）。
 * 改字段漏一处就是线上 bug，而且谁也说不清哪份才算标准。
 * 现在所有读写都从这里过。
 */

/** 空记录库 */
export function emptyDB() {
  return { meta: { version: 1, updatedAt: "" }, days: {}, weeks: {}, assignments: [] };
}

/** 空方案（服务端在没有任何配置时的兜底） */
export function emptyProfile() {
  return {
    courses: [],
    weeklyBudget: 15,
    gaps: [],
    milestones: [],
    weekTasks: {},
    focus: {},
    nodes: {}
  };
}

/**
 * 方案读盘时的归一化：只做一件事——把早前版本的 cet 段改名为 focus。
 *
 * 那一段从来就不是「英语六级专用」，只是当年按自己的考试起的名字；
 * 现在它承载任意专项（四级/考研单科/证书/竞赛/作品集），继续叫 cet 会误导使用者。
 * 旧方案不必手改：读的时候自动改名，写回去就是新结构。
 */
export function normalizeProfile(p) {
  if (!isPlainObject(p)) return p;
  const out = Object.assign({}, p);
  if (!isPlainObject(out.focus) && isPlainObject(out.cet)) out.focus = out.cet;
  if ("cet" in out) delete out.cet;
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * 把任意来路不明的记录整理成可用结构。
 * 只补结构、不改内容；数组当成非法值处理（早前 typeof [] === "object" 会放行）。
 */
export function normalizeDB(d) {
  if (!isPlainObject(d)) return emptyDB();
  const out = Object.assign({}, d);
  if (!isPlainObject(out.days)) out.days = {};
  if (!isPlainObject(out.weeks)) out.weeks = {};
  if (!Array.isArray(out.assignments)) out.assignments = [];
  if (!isPlainObject(out.meta)) out.meta = { version: 1, updatedAt: "" };
  return out;
}

/** 课程：去掉没有名字的项，并保证每门课都有 id（前端到处拿 c.id 当键） */
export function fixCourseIds(courses) {
  if (!Array.isArray(courses)) return [];
  return courses
    .filter((c) => c && (c.name || c.full))
    .map((c, i) => Object.assign({ id: "c" + (i + 1) }, c));
}

/**
 * 方案的表单保存：合并而不是覆盖。
 *
 * milestones / weekTasks / gaps 由助手维护，表单不提交它们，
 * 所以必须保留磁盘上的原值——这是刻意的，见 docs/架构说明.md §4.2。
 *
 * @param {object} cur   磁盘上的现有方案
 * @param {object} patch 前端提交的字段
 * @param {string} nowIso 服务端时间戳
 */
export function mergeProfile(cur, patch, nowIso) {
  const base = isPlainObject(cur) ? cur : {};
  const src = isPlainObject(patch) ? patch : {};
  const next = Object.assign({}, base, src);
  next.meta = Object.assign({}, base.meta || {}, src.meta || {}, { updatedAt: nowIso });
  if (Array.isArray(next.courses)) next.courses = fixCourseIds(next.courses);
  return next;
}

/**
 * 轻量校验：返回问题描述数组，空数组表示通过。
 * 只在写入口用，读的时候一律宽容（旧数据可能缺字段，不该因此打不开页面）。
 */
export function validateProfile(p) {
  const errs = [];
  if (!isPlainObject(p)) return ["profile 必须是对象"];
  if ("courses" in p && !Array.isArray(p.courses)) errs.push("courses 必须是数组");
  if ("weeklyBudget" in p && p.weeklyBudget != null) {
    const n = Number(p.weeklyBudget);
    if (!Number.isFinite(n) || n < 0 || n > 168) errs.push("weeklyBudget 必须是 0–168 之间的数字");
  }
  if (Array.isArray(p.courses)) {
    p.courses.forEach((c, i) => {
      if (!isPlainObject(c)) return errs.push("courses[" + i + "] 必须是对象");
      if (c.exam != null && c.exam !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.exam))) {
        errs.push("courses[" + i + "].exam 必须是 YYYY-MM-DD");
      }
    });
  }
  return errs;
}

/** 记录库的写入校验 */
export function validateDB(d) {
  const errs = [];
  if (!isPlainObject(d)) return ["db 必须是对象"];
  ["days", "weeks"].forEach((k) => {
    if (!isPlainObject(d[k])) {
      errs.push(k + " 必须是对象");
      return;
    }
    const bad = Object.keys(d[k]).filter((key) => !/^\d{4}-\d{2}-\d{2}$/.test(key));
    if (bad.length) errs.push(k + " 的键必须是日期，非法：" + bad.slice(0, 3).join(", "));
  });
  if (!Array.isArray(d.assignments)) errs.push("assignments 必须是数组");
  return errs;
}

function asgKey(a) {
  return a && a.id ? a.id : [a && a.course, a && a.title, a && a.due].join("|");
}

/**
 * 合并两份记录库。用于「两个端各自改过」的情况：
 * 手机上打卡、电脑上补作业，各自提交时都不知道对方改了什么。
 *
 * 规则：
 *   - days / weeks 以日期为键，同一天取 `ts` 较新的一份（ts 是写入时打的，不是前端编的）
 *   - assignments 以 id 合并，同 id 取 incoming（较晚提交的一方）
 *   - 只有一边有的键原样保留
 *
 * 说明：这套规则保不住「删除」。A 端删掉一条、B 端没删，合并后它还在。
 * 这是刻意的取舍——对个人台账来说，"删掉的东西又回来了" 比 "打卡记录莫名消失" 好处理。
 *
 * @param {object} base 磁盘上现有的
 * @param {object} patch 刚提交上来的
 */
export function mergeDBs(base, patch) {
  const A = normalizeDB(base);
  const B = normalizeDB(patch);

  const pick = (x, y) => {
    if (!x) return y;
    if (!y) return x;
    const tx = String(x.ts || x.updatedAt || "");
    const ty = String(y.ts || y.updatedAt || "");
    return ty >= tx ? y : x;
  };

  const mergeMap = (a, b) => {
    const out = Object.assign({}, a);
    Object.keys(b).forEach((k) => {
      out[k] = pick(out[k], b[k]);
    });
    return out;
  };

  const days = mergeMap(A.days, B.days);
  const weeks = mergeMap(A.weeks, B.weeks);

  const byKey = new Map();
  const order = [];
  A.assignments.concat(B.assignments).forEach((a) => {
    const k = asgKey(a);
    if (!byKey.has(k)) {
      order.push(k);
      byKey.set(k, a);
    } else {
      // 两边都有这条作业：有 ts 就按 ts 新者胜，都没 ts（老数据）则客户端提交的版本胜。
      byKey.set(k, pick(byKey.get(k), a));
    }
  });

  const ta = A.meta.updatedAt || "";
  const tb = B.meta.updatedAt || "";
  return {
    meta: Object.assign({ version: 1 }, A.meta, B.meta, { updatedAt: tb >= ta ? tb : ta }),
    days,
    weeks,
    assignments: order.map((k) => byKey.get(k))
  };
}
