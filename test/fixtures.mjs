/**
 * 分析规则的固定输入。
 *
 * 设计原则：
 *   - 不含任何真实姓名 / 真实课程 / 真实考期，全部是占位数据
 *   - 日期一律相对 FIXED_TODAY 表达，跑多久都不会过期
 *   - 每个用例只针对一到两条规则，出问题能直接定位
 *
 * 这些数据同时被两处使用：
 *   test/characterize.mjs  从当前 index.html 的内联脚本里跑出 golden
 *   test/rules.test.mjs    跑抽取后的 core/domain/rules.mjs，与 golden 逐字比对
 */

export const FIXED_TODAY = "2026-10-22";

/** 相对 FIXED_TODAY 偏移 n 天的日期串 */
export function rel(n) {
  const [y, m, d] = FIXED_TODAY.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const p = (v) => String(v).padStart(2, "0");
  return dt.getFullYear() + "-" + p(dt.getMonth() + 1) + "-" + p(dt.getDate());
}

/** 三门课的最小方案，用于「什么都还没开始」这类基础判断 */
export const PROFILE_MIN = {
  meta: { owner: "", semester: "" },
  weeklyBudget: 15,
  weekAnchor: rel(-49),
  weekAnchorNo: 8,
  courseTarget: 80,
  courses: [
    { id: "c1", name: "课程一", full: "课程一", exam: rel(74), status: "未知", slot: "" },
    { id: "c2", name: "课程二", full: "课程二", exam: rel(74), status: "未知", slot: "" },
    { id: "c3", name: "课程三", full: "课程三", exam: rel(80), status: "未知", slot: "" }
  ],
  cet: { label: "英语考试", date: rel(51), target: 500, wordsPerWeek: 300, listenPerWeek: 5 },
  nodes: { examWindowStart: rel(74), mentorMail: rel(41), gapInventory: rel(8), mentorLabel: "外部材料" },
  milestones: [],
  weekTasks: {},
  gaps: [],
  project: { options: [] }
};

/** 五门课 + 同一周多门考试，用于期末挤压与断层 */
export const PROFILE_FIVE = {
  meta: { owner: "", semester: "" },
  weeklyBudget: 15,
  weekAnchor: rel(-49),
  weekAnchorNo: 8,
  courseTarget: 80,
  courses: [
    { id: "c1", name: "课程一", full: "课程一", exam: rel(20), status: "未知", slot: "" },
    { id: "c2", name: "课程二", full: "课程二", exam: rel(22), status: "未知", slot: "" },
    { id: "c3", name: "课程三", full: "课程三", exam: rel(24), status: "未知", slot: "" },
    { id: "c4", name: "课程四", full: "课程四", exam: rel(60), status: "未知", slot: "" },
    { id: "c5", name: "课程五", full: "课程五", exam: rel(66), status: "未知", slot: "" }
  ],
  cet: { label: "英语考试", date: rel(30), target: 500, wordsPerWeek: 300, listenPerWeek: 5 },
  nodes: { examWindowStart: rel(20), mentorMail: rel(30), gapInventory: rel(9), mentorLabel: "外部材料" },
  milestones: [],
  weekTasks: {},
  gaps: [],
  project: { options: ["候选甲", "候选乙"] }
};

/** 一条打卡记录 */
export function rec(o) {
  return Object.assign(
    {
      date: FIXED_TODAY,
      hours: 0,
      focus: "hard",
      courses: {},
      words: 0,
      listen: 0,
      paper: 0,
      score: null,
      sleep: null,
      blocker: "",
      ts: FIXED_TODAY + "T12:00:00.000Z"
    },
    o
  );
}

/** 作业项 */
export function asg(o) {
  return Object.assign(
    { id: "a1", course: "c1", title: "习题一", due: rel(3), status: "todo", est: 2, pri: 2, note: "" },
    o
  );
}

/** 空数据库 */
export function db(o) {
  return Object.assign({ meta: { version: 1, updatedAt: FIXED_TODAY }, days: {}, weeks: {}, assignments: [] }, o);
}

/** 生成「连续 n 天都有投入」的 days 映射 */
export function streakDays(n, hours) {
  const days = {};
  for (let i = 0; i < n; i++) {
    const d = rel(-i);
    days[d] = rec({ date: d, hours: hours, focus: "hard", courses: { c1: 2, c2: 1, c3: 1, c4: 1, c5: 1 } });
  }
  return days;
}

/**
 * 用例矩阵。name 会出现在 golden 里，改名等于换基线，别随手改。
 */
export const CASES = [
  {
    name: "01-全空白-三门课",
    profile: PROFILE_MIN,
    db: db({ days: { [FIXED_TODAY]: rec({ hours: 3.5, sleep: 6.2, words: 120, listen: 1, paper: 0, courses: { c1: 0, c2: 0, c3: 0 } }) } }),
    rec: rec({ hours: 3.5, sleep: 6.2, words: 120, listen: 1, paper: 0, courses: { c1: 0, c2: 0, c3: 0 } })
  },
  {
    name: "02-作业逾期两项",
    profile: PROFILE_FIVE,
    db: db({
      days: { [FIXED_TODAY]: rec({ hours: 3, courses: { c1: 2, c2: 0, c3: 0, c4: 0, c5: 0 } }) },
      assignments: [
        asg({ id: "a1", title: "习题一", due: rel(-4), status: "todo" }),
        asg({ id: "a2", course: "c2", title: "报告二", due: rel(-1), status: "doing" }),
        asg({ id: "a3", course: "c3", title: "作业三", due: rel(0), status: "todo" })
      ]
    }),
    rec: rec({ hours: 3, courses: { c1: 2, c2: 0, c3: 0, c4: 0, c5: 0 } })
  },
  {
    name: "03-三天内到期",
    profile: PROFILE_FIVE,
    db: db({
      days: { [FIXED_TODAY]: rec({ hours: 2, courses: { c1: 1, c2: 1, c3: 1, c4: 1, c5: 1 } }) },
      assignments: [asg({ id: "a1", title: "习题一", due: rel(1), status: "todo" }), asg({ id: "a2", title: "习题二", due: rel(3), status: "todo" })]
    }),
    rec: rec({ hours: 2, courses: { c1: 1, c2: 1, c3: 1, c4: 1, c5: 1 } })
  },
  {
    name: "04-期末挤压+断层",
    profile: PROFILE_FIVE,
    db: db({
      days: {
        [FIXED_TODAY]: rec({ hours: 2, courses: { c1: 0, c2: 2, c3: 1, c4: 1, c5: 1 } }),
        [rel(-7)]: rec({ date: rel(-7), hours: 3, courses: { c1: 1, c2: 0, c3: 0, c4: 0, c5: 0 } })
      }
    }),
    rec: rec({ hours: 2, courses: { c1: 0, c2: 2, c3: 1, c4: 1, c5: 1 } })
  },
  {
    name: "05-本周超预算",
    profile: PROFILE_MIN,
    db: db({
      days: {
        [rel(-1)]: rec({ date: rel(-1), hours: 6, courses: { c1: 2, c2: 2, c3: 2 } }),
        [rel(-2)]: rec({ date: rel(-2), hours: 6, courses: { c1: 2, c2: 2, c3: 2 } }),
        [rel(-3)]: rec({ date: rel(-3), hours: 6, courses: { c1: 2, c2: 2, c3: 2 } }),
        [FIXED_TODAY]: rec({ hours: 2, focus: "software", courses: { c1: 1, c2: 1, c3: 1 } })
      }
    }),
    rec: rec({ hours: 2, focus: "software", courses: { c1: 1, c2: 1, c3: 1 } })
  },
  {
    name: "06-睡眠不足+单日超6h",
    profile: PROFILE_MIN,
    db: db({ days: { [FIXED_TODAY]: rec({ hours: 7, sleep: 5.5, courses: { c1: 2, c2: 2, c3: 2 } }) } }),
    rec: rec({ hours: 7, sleep: 5.5, courses: { c1: 2, c2: 2, c3: 2 } })
  },
  {
    name: "07-连续10天无休",
    profile: PROFILE_MIN,
    db: db({ days: streakDays(12, 3) }),
    rec: rec({ hours: 3, courses: { c1: 2, c2: 1, c3: 1 } })
  },
  {
    name: "08-方向偏差-软件投入",
    profile: PROFILE_MIN,
    db: db({ days: { [FIXED_TODAY]: rec({ hours: 4, focus: "software", courses: { c1: 0, c2: 0, c3: 0 } }) } }),
    rec: rec({ hours: 4, focus: "software", courses: { c1: 0, c2: 0, c3: 0 } })
  },
  {
    name: "09-项目停在候选",
    profile: PROFILE_FIVE,
    db: db({ days: { [FIXED_TODAY]: rec({ hours: 3, focus: "project", courses: { c1: 1, c2: 1, c3: 1, c4: 1, c5: 1 } }) } }),
    rec: rec({ hours: 3, focus: "project", courses: { c1: 1, c2: 1, c3: 1, c4: 1, c5: 1 } })
  },
  {
    name: "10-真题分数与目标",
    profile: PROFILE_MIN,
    db: db({ days: { [FIXED_TODAY]: rec({ hours: 3, score: 452, words: 100, listen: 2, paper: 1, courses: { c1: 1, c2: 1, c3: 1 } }) } }),
    rec: rec({ hours: 3, score: 452, words: 100, listen: 2, paper: 1, courses: { c1: 1, c2: 1, c3: 1 } })
  },
  {
    name: "11-完成作业当天",
    profile: PROFILE_FIVE,
    db: db({
      days: { [FIXED_TODAY]: rec({ hours: 3, courses: { c1: 2, c2: 1, c3: 1, c4: 1, c5: 1 } }) },
      assignments: [asg({ id: "a1", title: "习题一", due: rel(0), status: "done", doneDate: FIXED_TODAY })]
    }),
    rec: rec({ hours: 3, courses: { c1: 2, c2: 1, c3: 1, c4: 1, c5: 1 } })
  },
  {
    name: "12-周末复盘日",
    profile: PROFILE_MIN,
    db: db({ days: { [rel(1)]: rec({ date: rel(1), hours: 4, courses: { c1: 2, c2: 1, c3: 1 } }) } }),
    rec: rec({ date: rel(1), hours: 4, courses: { c1: 2, c2: 1, c3: 1 } })
  }
];
