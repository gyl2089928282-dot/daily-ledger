/**
 * 分析规则：唯一实现。
 *
 * 这个函数以前有三份副本（页面内联、小程序 utils/analysis.js、每晚定时任务的提示词），
 * 现在是唯一一份：页面 import 它，服务端 /api/analysis 也是同一个函数，
 * 定时任务改为消费接口，不再自己「理解」规则。
 *
 * 约束（改代码时请守住）：
 *   - 不读全局、不碰 DOM、不看当前时间——db / profile / rec / today 全部由参数传入
 *   - 输出是结构化数据 { analyses, acts }，不是 DOM 片段
 *   - body 里允许 <b> 这种轻量标记（页面直接插入）；纯文本消费者用 text.stripTags()
 *   - 所有阈值集中在 T，不要在分支里写裸数字
 */
import { daysBetween, weekStartOf, fmtMD, parseD } from "./dates.js";
import { esc } from "./text.js";
import { getWeekDays, sumHours, courseGapDays, focusWeek, streakNoRest, overdueDays, dueIn } from "./stats.js";
import { focusOf, focusName } from "./focus.js";
import { fillUi } from "./ui.js";

/** 阈值表。改这里等于改规则，README 的规则表要同步。 */
export const T = {
  weeklyOverload: 19.5,      // 周投入超过这个数视为超预算（budget × 1.3）
  weekLagRatio: 0.55,        // 周内进度低于线性预期的这个比例 → 落后
  weekOnTrackRatio: 0.9,     // 高于这个比例 → 节奏正常
  sleepLow: 6,               // 睡眠低于此值告警（小时）
  sleepGood: 7.5,            // 高于此值认可
  gapDays: 6,                // 某门课多少天没推进算断层
  examSwampDays: 90,         // 期末挤压只在考前这么多天内提示
  cetWindow: 75,             // 英语考试进入倒计时的窗口
  cetPaperUrgent: 55,        // 真题还是 0 套时的紧迫窗口
  nodeWindow: 45,            // 外部节点倒计时窗口
  inventoryWindow: 10,       // 材料盘点临期窗口
  noRestDays: 10,            // 连续多少天有投入算「没有休息」
  directionHours: 3,         // 单日投入超过此值才评价方向
  overloadDay: 6,            // 单日投入超过此值提示透支
  maxAnalyses: 5,            // 单日最多几条结论
  maxActs: 3                 // 最多几条行动
};

function examWindowStart(profile) {
  const nodes = profile.nodes || {};
  if (nodes.examWindowStart) return nodes.examWindowStart;
  const list = (profile.courses || []).filter((c) => c.exam).sort((a, b) => a.exam.localeCompare(b.exam));
  return list.length ? list[0].exam : null;
}

/**
 * @param {object} db      记录库 { days, weeks, assignments }
 * @param {object} profile 方案
 * @param {object} rec     当天记录
 * @param {string} today   "YYYY-MM-DD"
 * @param {object} [ui]    界面开关 {tabs,modules}；不传 = 全部打开（老调用方行为不变）
 * @returns {{analyses: Array, acts: Array}}
 */
export function buildAnalysis(db, profile, rec, today, ui) {
  const A = [];
  const acts = [];

  /* 使用者在「功能选择」里关掉的模块，规则里整段不参与——
     没记睡眠就不该被判睡眠不足，不打分就不该被催着给课做诊断。
     传 undefined / 缺字段都按全开处理，所以既有调用方不受影响。 */
  const U = fillUi(ui);
  const modOn = (id) => U.modules[id] !== false;

  const courses = profile.courses || [];
  const cname = {};
  courses.forEach((c) => { cname[c.id] = c.name; });
  const label = (id) => cname[id] || "未知课";

  const budget = profile.weeklyBudget;
  const ws = weekStartOf(rec.date);
  const weekDays = getWeekDays(db, ws);
  const weekHours = sumHours(weekDays);
  const nDays = Object.keys(db.days).length;
  const dow = parseD(rec.date).getDay();
  const dayIdx = dow === 0 ? 7 : dow;
  const expected = (budget / 7) * dayIdx;

  /* 0. 作业优先：逾期挤占一切 */
  const od = db.assignments
    .filter((a) => overdueDays(a, today) !== null)
    .sort((x, y) => overdueDays(y, today) - overdueDays(x, today));
  const soon = db.assignments
    .filter((a) => {
      const d = dueIn(a, today);
      return d !== null && d >= 0 && d <= 3;
    })
    .sort((x, y) => dueIn(x, today) - dueIn(y, today));
  const todayDone = db.assignments.filter((a) => a.doneDate === rec.date);

  if (od.length) {
    const top = od[0];
    A.push({
      type: "bad",
      title: `有 ${od.length} 项作业已逾期`,
      body:
        `最久的是 <b>${label(top.course)} · ${esc(top.title)}</b>，已逾期 <b>${overdueDays(top, today)} 天</b>` +
        (od.length > 1
          ? `；另外还有 ${od.map((x) => esc(x.title)).slice(1, 3).join("、")}${od.length > 3 ? " 等" : ""} 也在逾期。`
          : "。") +
        ` 逾期作业会挤掉本周三项优先任务里的一个名额——这是规则，不是惩罚。`
    });
    acts.push({
      text: `今天先处理「${label(top.course)} · ${esc(top.title)}」`,
      why: "逾期项每多一天，补起来的心理成本都在涨"
    });
  } else if (soon.length) {
    const top = soon[0];
    const d = dueIn(top, today);
    A.push({
      type: "warn",
      title: `${d === 0 ? "今天" : "这两天"}要交：${esc(top.title)}`,
      body:
        `<b>${label(top.course)}</b>，截止 ${fmtMD(top.due)}（${d === 0 ? "就是今天" : d + " 天后"}）` +
        (soon.length > 1 ? `。3 天内共 <b>${soon.length} 项</b>到期。` : "。")
    });
    acts.push({
      text: `今天先做完「${esc(top.title)}」`,
      why: "3 天内到期的作业优先于复习计划，复习可以顺延，截止不会"
    });
  }
  if (todayDone.length) {
    A.push({
      type: "good",
      title: `今天交掉 ${todayDone.length} 项作业`,
      body: todayDone.map((a) => `${label(a.course)} · ${esc(a.title)}`).join("；") + "。"
    });
  }

  /* 1. 负荷 */
  if (weekHours > T.weeklyOverload) {
    A.push({
      type: "warn",
      title: "本周已超预算",
      body: `本周已投入 <b>${weekHours.toFixed(1)}h</b>，超过 ${budget}h 预算 30% 以上。要么真实上限远高于这个数（需要你确认），要么在透支。先别加任务。`
    });
  } else if (dayIdx >= 4 && weekHours < expected * T.weekLagRatio) {
    A.push({
      type: "warn",
      title: "进度落后于本周节奏",
      body: `今天是本周第 ${dayIdx} 天，按 ${budget}h/周线性算应有约 <b>${expected.toFixed(1)}h</b>，实际 <b>${weekHours.toFixed(1)}h</b>。如果是外部约束（课多、有事），周复盘时把任务缩掉；如果是时间没找出来，明天补进度，不是补全部。`
    });
  } else if (weekHours >= expected * T.weekOnTrackRatio && weekHours <= T.weeklyOverload) {
    A.push({
      type: "good",
      title: "本周节奏正常",
      body: `本周已投入 <b>${weekHours.toFixed(1)}h</b>，与 ${budget}h/周的预算节奏相符。保持，不用加码。`
    });
  }

  /* 2. 睡眠：没开「睡眠记录」的话，rec.sleep 不会被人填进去，也不用评价 */
  if (modOn("sleep") && rec.sleep != null && rec.sleep > 0) {
    if (rec.sleep < T.sleepLow) {
      A.push({
        type: "bad",
        title: "睡眠不足 6 小时",
        body: `睡了 ${rec.sleep}h。低于 6 小时当天产出通常明显下降，还会连带影响第二天。今晚不做加时补偿，明天任务量按 2/3 排。`
      });
      acts.push({ text: "今晚按平时时间睡，不补进度", why: "少学一晚的损失小于连续三天状态下滑" });
    } else if (rec.sleep >= T.sleepGood) {
      A.push({ type: "good", title: "睡眠到位", body: `${rec.sleep}h。这是能长期维持强度的前提，继续保持。` });
    }
  }

  /* 3. 课程诊断空白：当天的记录本身也算一次推进，不能只看历史 */
  const cpOn = modOn("courseProgress");
  const gapOf = (cid) => (rec.courses[cid] >= 1 ? 0 : courseGapDays(db, cid, today));
  const never = cpOn ? courses.filter((c) => gapOf(c.id) === null) : [];
  const N = courses.length;
  if (never.length >= 4) {
    const exW = examWindowStart(profile);
    A.push({
      type: "warn",
      title: `${N} 门课里有 ${never.length} 门还没开始`,
      body: `已记录 ${nDays} 天，<b>${never.map((c) => c.name).join("、")}</b> 还没有任何推进记录。${
        exW ? `距期末首科约 <b>${daysBetween(rec.date, exW)} 天</b>，` : ""
      }现在补来得及，但诊断再拖就晚了。`
    });
    acts.push({
      text: `今天之内挑一门课做 30 分钟摸底（先从「${courses[0].name}」起）`,
      why: "全部空白时，随便开一门就能打破僵局"
    });
  } else if (never.length === 3) {
    A.push({
      type: "warn",
      title: "还有 3 门课没碰过",
      body: `<b>${never.map((c) => c.name).join("、")}</b> 仍无记录。${N} 门里有三门空白，这个比例撑不到期末。`
    });
    acts.push({ text: `给「${never[0].name}」排 30 分钟诊断，定在明天`, why: "未触碰的课会一直保持未知，考试日期不会推迟" });
  } else if (never.length > 0) {
    A.push({
      type: "warn",
      title: `还有 ${never.length} 门课没碰过`,
      body: `<b>${never.map((c) => c.name).join("、")}</b> 仍无记录。别等「有空再弄」，安排到具体某天。`
    });
  }

  /* 4. 课程断层 */
  const stale = cpOn
    ? courses
      .map((c) => ({ c: c, g: gapOf(c.id) }))
      .filter((x) => x.g !== null && x.g >= T.gapDays)
      .sort((a, b) => b.g - a.g)
    : [];
  if (stale.length) {
    A.push({
      type: "warn",
      title: `${stale[0].c.name} 已 ${stale[0].g} 天没推进`,
      body: `间隔超过一周的科目，重新捡起来通常要补一大段，成本比每天 20 分钟高得多。`
    });
    acts.push({ text: `给「${stale[0].c.name}」安排 20–30 分钟回补`, why: "断层越久，重新进入成本越高" });
  }

  /* 5. 期末挤压：只报同一周里塞了几门，不预设是哪门 */
  const exW = examWindowStart(profile);
  const dEx = exW ? daysBetween(rec.date, exW) : null;
  const sameWeek = exW ? courses.filter((c) => c.exam && Math.abs(daysBetween(exW, c.exam)) <= 6) : [];
  if (dEx > 0 && dEx <= T.examSwampDays && sameWeek.length >= 3 && stale.length === 0 && never.length === 0) {
    A.push({
      type: "",
      title: `期末有 ${sameWeek.length} 门挤在同一周`,
      body: `<b>${sameWeek.map((c) => c.name).join("、")}</b> 的考期相隔不到一周，最近一科只剩 <b>${dEx} 天</b>。这种排布没有临时抱佛脚的空间，必须提前推到"能做题"的状态。`
    });
  }

  /* 6. 专项：课程之外的单项推进目标
        四六级、考研单科、计算机二级、教资、法考、竞赛题库、作品集……都走这一条。
        三个计数器的名字、周目标、分数都由方案决定；没配（既无名称也无日期）就整段跳过——
        不假设任何专业、任何年级、任何证书。 */
  const F = focusOf(profile);
  const cDate = F.date;
  const focusLabel = focusName(F);
  const uA = F.units.words;   // 数量型指标：单词 / 题量 / 页数 …
  const uB = F.units.listen;  // 次数型指标：精听 / 复盘 / 章节 …
  const uC = F.units.paper;   // 整卷：真题 / 模考 / 套卷 …
  const dCet = cDate ? daysBetween(rec.date, cDate) : null;
  const focusOn = modOn("focus") && F.enabled;
  const wordsGoal = F.goals.words;
  const listenGoal = F.goals.listen;
  const scoreGoal = F.target;
  const cw = focusWeek(db, ws);
  if (focusOn && dCet > 0 && dCet <= T.cetWindow) {
    const pct = wordsGoal ? Math.round((cw.words / wordsGoal) * 100) : 0;
    const body =
      `距${focusLabel} <b>${dCet} 天</b>。本周${uA} <b>${cw.words}</b>${wordsGoal ? `（目标 ${wordsGoal}，${pct}%）` : ""}，` +
      `${uB} <b>${cw.listen}</b>${listenGoal ? `（目标 ${listenGoal}）` : ""}，${uC} <b>${cw.paper}</b>。`;
    if (cw.paper === 0 && dCet < T.cetPaperUrgent) {
      A.push({
        type: "warn",
        title: `${focusLabel}这周还没做过${uC}`,
        body: body + `完整跑一遍计时${uC}，是唯一能把分数和手感对齐的环节，只堆${uA}替代不了。`
      });
      acts.push({
        text: `本周排一次${focusLabel}计时${uC}${F.duration ? "（" + F.duration + "）" : ""}`,
        why: `不到 ${Math.round(T.cetPaperUrgent / 7)} 周，需要真实数据才能决定补哪块`
      });
    } else if (wordsGoal && pct < 50 && dayIdx >= 5) {
      A.push({ type: "warn", title: `${focusLabel}${uA}本周缺口较大`, body: body });
      acts.push({ text: `周末用碎片时间补${uA}缺口`, why: `${uA}这类低注意力任务，不该占硬课的整块时段` });
    } else {
      A.push({ type: "", title: `${focusLabel}节奏`, body: body });
    }
    if (rec.score != null && scoreGoal != null) {
      const gap = scoreGoal - rec.score;
      A.push({
        type: gap > 0 ? "warn" : "good",
        title: `本次 ${rec.score} 分，距目标${gap > 0 ? "差 " + gap : "超 " + -gap}`,
        body: `单次分数不能判断 ${scoreGoal} 分是否稳妥，但能看结构：先找出哪一部分在拖后腿，再决定下一轮补哪块。`
      });
    }
  }

  /* 7. 外部节点：节点由使用者自己配，没配就不提 */
  const nodes = profile.nodes || {};
  const mailDate = nodes.mentorMail || null;
  const gapDate = nodes.gapInventory || null;
  const nodeLabel = nodes.mentorLabel || "外部节点";
  const dM = mailDate ? daysBetween(rec.date, mailDate) : null;
  const d31 = gapDate ? daysBetween(rec.date, gapDate) : null;
  if (dM > 0 && dM <= T.nodeWindow) {
    A.push({
      type: d31 != null && d31 <= T.inventoryWindow ? "warn" : "",
      title: `${nodeLabel}倒计时`,
      body: `距 ${fmtMD(mailDate)} 这个节点还有 <b>${dM} 天</b>${
        d31 != null ? `；距 ${fmtMD(gapDate)} 的盘点 ${d31 > 0 ? `<b>${d31} 天</b>` : "已过期"}` : ""
      }。先把每项标成"已有 / 进行中 / 未开始"，再决定要不要缩范围。`
    });
    if (d31 != null && d31 > 0 && d31 <= T.inventoryWindow && !acts.some((a) => a.text.includes("作业"))) {
      acts.push({ text: "30 分钟把各项材料各标一次状态：已有 / 进行中 / 未开始", why: "盘点不需要成本，却能避免临期才发现凑不齐" });
    }
  }

  /* 8. 项目：只有配置里登记了候选才评价 */
  const proj = profile.project;
  if (proj && rec.focus === "project" && proj.options && proj.options.length) {
    A.push({
      type: "",
      title: "项目还停在候选阶段",
      body: `候选是 ${proj.options.map((o) => `「${o}」`).join("、")}，都还没立项，因为数据来源和验证方法没核实。${
        gapDate ? `${fmtMD(gapDate)} 前只需 45 分钟比较，` : ""
      }选出"继续查"的一个，不是选一个马上开工。`
    });
  }

  /* 9. 无休息 */
  const st = streakNoRest(db, today);
  if (st >= T.noRestDays) {
    A.push({
      type: "warn",
      title: `已连续 ${st} 天没有完整休息`,
      body: `记录里连续 ${st} 天都有投入，没有一天休息。短期可以，三周以上通常伴随效率下滑。建议周日复盘后留半天完全放空。`
    });
    acts.push({ text: "本周留半天完全不学习", why: "恢复是计划的一部分，不是计划失败的证据" });
  }

  /* 10. 方向偏差 */
  if (rec.hours >= T.directionHours && rec.focus === "software" && never.length >= 3) {
    A.push({
      type: "bad",
      title: "今天的投入方向有问题",
      body: `花了 ${rec.hours}h 在软件 / 工具上，而 <b>${never.length} 门课</b>连诊断都没做。工具练手不产生学分，也不解决「考试会考什么」这个未知。可以练，排在诊断之后。`
    });
    acts.push({ text: "明天第一件事：任选一门课做诊断", why: "课程全部未知时，工具学习是低回报投资" });
  }
  if (rec.hours >= T.directionHours && rec.focus === "homework" && never.length >= 3) {
    A.push({
      type: "warn",
      title: "在写作业，但课还没诊断过",
      body: `写作业本身没错，但 <b>${never.length} 门课</b>还不知道考什么。作业能拿平时分，诊断才能决定复习方向。两件事不冲突，但别只有前者。`
    });
  }
  if (rec.hours > T.overloadDay) {
    A.push({
      type: "warn",
      title: `单日 ${rec.hours}h，接近透支`,
      body: `如果是合并了几天的记录就不算；否则要留意可持续性，周复盘时换算成一周平均，看是否远超 ${budget}h 的预算。`
    });
  }

  /* 兜底：保证 1–3 条行动（按关键词去重，避免两条建议说同一件事） */
  const hasKw = (kw) => acts.some((a) => a.text.indexOf(kw) >= 0);
  const PREF = [
    {
      kw: "摸底",
      need: never.length > 0,
      text: never[0] ? `给「${never[0].name}」排 30 分钟摸底` : "任选一门课做 30 分钟摸底",
      why: "未触碰的课会一直保持未知，考试日期不会推迟"
    },
    {
      kw: "计时",
      need: focusOn && dCet > 0 && dCet <= T.cetWindow,
      text: `本周排一次${focusLabel}计时${uC}`,
      why: `${focusLabel}需要真实数据才能决定补哪块`
    },
    {
      kw: "材料",
      need: dM > 0 && dM <= T.nodeWindow,
      text: `给${nodeLabel}各项各标一次状态`,
      why: "把未知变成已知，是后面所有决策的前提"
    }
  ];
  if (acts.length < T.maxActs) {
    PREF.forEach((p) => {
      if (acts.length >= T.maxActs) return;
      if (!p.need) return;
      if (hasKw(p.kw)) return;
      // 同一门课已经出现在行动里，就不再换一种说法重复一次
      if (p.kw === "摸底" && never[0] && hasKw("「" + never[0].name + "」")) return;
      acts.push({ text: p.text, why: p.why });
    });
  }

  const order = { bad: 0, warn: 1, "": 2, good: 3 };
  A.sort((a, b) => (order[a.type] || 0) - (order[b.type] || 0));
  return { analyses: A.slice(0, T.maxAnalyses), acts: acts.slice(0, T.maxActs) };
}
