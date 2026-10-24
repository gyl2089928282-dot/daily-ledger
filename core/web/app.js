/* 界面脚本：只管渲染与交互，规则和统计全部来自 core/domain/（纯函数，可单测）。
   由 index.html 以 <script type="module"> 加载，所以这里的顶层作用域是模块作用域，
   HTML 里那 14 处内联 onclick 需要的函数在文件末尾显式挂到 window 上。 */
import * as domainStats from "../domain/stats.js";
import * as domainRules from "../domain/rules.js";
import { focusOf, focusName } from "../domain/focus.js";
import { pad, ymd, todayStr, parseD, daysBetween, addDays, weekStartOf, fmtMD, WK, fmtCn } from "../domain/dates.js";
import { esc } from "../domain/text.js";
import { uiOf, TABS, MODULES } from "../domain/ui.js";
import { THEMES, DEFAULT_THEME, isTheme, themeDef, themeOf } from "../domain/theme.js";

/* ══════════ 计划数据 ══════════
   公用页面不含任何个人常量——不看学校、不看专业、不看年级、不看考什么证。
   所有属于使用者的东西都来自 /profile.js：服务端读 private/profile.json；
   没有私有目录时回落到 core/default-profile.json。
   这里的 DEFAULT_PLAN 是兜底：/profile.js 没加载出来（未授权、或服务端没有 private 目录）时保证页面不白屏。
   注意：本文件是 ES 模块，file:// 直接双击 index.html 会被浏览器按同源策略拒绝，
   要用就起服务（start.bat）或 python -m http.server。
*/
const DEFAULT_PLAN = {
  meta:{ owner:"", school:"", major:"", grade:"", semester:"" },
  weeklyBudget:15,
  weekAnchor:null, weekAnchorNo:1,
  courseTarget:null,
  courses:[
    { id:"c1", name:"课程一", full:"课程一", exam:null, status:"未知", slot:"" },
    { id:"c2", name:"课程二", full:"课程二", exam:null, status:"未知", slot:"" },
    { id:"c3", name:"课程三", full:"课程三", exam:null, status:"未知", slot:"" }
  ],
  focus:{},
  nodes:{ examWindowStart:null, mentorMail:null, gapInventory:null },
  milestones:[], weekTasks:{},
  gaps:["还没有填写任何课程、考期与目标 —— 这些属于使用者自己的方案，系统不替你猜"]
};
const PLAN = (window.__PLAN__ && Array.isArray(window.__PLAN__.courses) && window.__PLAN__.courses.length)
  ? window.__PLAN__ : DEFAULT_PLAN;
const CNAME = {};
PLAN.courses.forEach(c=>CNAME[c.id]=c.name);

/* 专项（第二战场）的完整配置：三项计数的名字、周目标、考期、分数都由方案决定。
   没有配置就是 enabled:false，界面上不会出现「六级」「单词」这类假设。 */
let FOCUS = focusOf(PLAN);
const focusLabel = ()=>focusName(FOCUS);

/* 以下三个取数函数把"个人常量"收敛到一处，规则里不再出现具体日期 */
function focusDate(){ return FOCUS.date; }
function nodeDate(key){ return (PLAN.nodes && PLAN.nodes[key]) || null; }
function firstExamCourse(){
  const list = PLAN.courses.filter(c=>c.exam).sort((a,b)=>a.exam.localeCompare(b.exam));
  return list.length ? list[0] : null;
}
function examWindowStart(){ return nodeDate("examWindowStart") || (firstExamCourse() && firstExamCourse().exam) || null; }

/* ══════════ 界面开关（功能选择） ══════════
   「都用得上」是公用代码的假设，不是使用者的事实：
   有人不记作业、有人没有考期、有人不想每天打睡眠分。
   所以哪些页签、哪些模块出现，写在 profile.ui 里由使用者决定；
   关掉的模块在页面、分析结论、行动建议里一起消失（rules.js 第五个参数同步传下去）。 */
let UI = uiOf(PLAN);
const tabOn = (id) => UI.tabs[id] !== false;
const modOn = (id) => UI.modules[id] !== false;
/** 专项是否参与本次渲染：既要在方案里配过，也要开关没关 */
const focusVisible = () => modOn("focus") && FOCUS.enabled;

/* ══════════ 标题栏 ══════════
   学校 / 专业 / 年级 / 学期是「身份信息」，不是工具本身需要的东西：
   默认不显示，只有在方案里显式打开 showIdentity 时才拼到标题下面。
   关掉时这行只是一句中性的功能说明，谁拿到这份代码都不会看到别人的学校与专业。 */
function renderBrand(){
  const el = document.getElementById("brandSub");
  if(!el) return;
  const m = PLAN.meta || {};
  const parts = [m.school, m.major, m.grade, m.semester]
    .map(v=>String(v==null?"":v).trim()).filter(Boolean);
  if(m.showIdentity === true && parts.length){
    el.textContent = parts.join(" · ");
    el.classList.remove("is-empty");
  }else{
    el.textContent = "学习计划 · 每日打卡 · 周复盘";
    el.classList.add("is-empty");
  }
}

/* ══════════ 存储 ══════════ */
const KEY = "energy_planner_v2";
let DB = { days:{}, weeks:{}, assignments:[], meta:{} };

function load(){
  // 先读 v2，再尝试从 v1 迁移旧打卡记录
  try{
    let raw = localStorage.getItem(KEY);
    if(!raw){
      const old = localStorage.getItem("energy_planner_v1");
      if(old){
        const o = JSON.parse(old);
        DB = { days:o.days||{}, weeks:o.weeks||{}, assignments:[] };
      }
    }else{
      DB = JSON.parse(raw);
    }
  }catch(e){ console.warn("读取失败", e); }
  if(!DB.days) DB.days = {};
  if(!DB.weeks) DB.weeks = {};
  if(!DB.meta) DB.meta = {};
  if(!Array.isArray(DB.assignments)) DB.assignments = [];
  DB.assignments.forEach(a=>{ if(!a.id) a.id = uid(); if(!a.status) a.status = "todo"; });
}
function save(){
  if(!DB.meta) DB.meta = {};
  DB.meta.updatedAt = new Date().toISOString();
  try{ localStorage.setItem(KEY, JSON.stringify(DB)); }
  catch(e){ toast("保存失败：浏览器存储被限制或已满", "warn"); }
  pushRemote();
}

/* ══════════ 云端同步 ══════════
   通过 http(s) 打开时，数据同时写到服务端 private/records.json（与定时任务读的是同一份）；
   没有服务端时（API 为 null）退化为纯本地存储。
   注意 brief 现在是 /brief.js 包一层 JSON 赋值，底层文件是 private/brief.json。
*/
const API = (location.protocol === "http:" || location.protocol === "https:") ? "api/data" : null;
let pushTimer = null, pushSeq = 0;
/* 上一次成功同步时服务端返回的 updatedAt —— 也就是「我这份底稿是基于哪一版改的」。
   提交时带上它，服务端才能判断该不该合并：
   底稿一致 → 直接整份覆盖（快路径）；
   底稿已被另一端改过 → 按日期、按条目逐条合并，谁新算谁的，不再整份互相覆盖。 */
let apiBase = "";

/* 把一份远端文档接管为本地状态（统一做一遍字段兜底） */
function adopt(remote){
  DB = remote;
  if(!DB.days) DB.days = {};
  if(!DB.weeks) DB.weeks = {};
  if(!DB.meta) DB.meta = {};
  if(!Array.isArray(DB.assignments)) DB.assignments = [];
  DB.assignments.forEach(a=>{ if(!a.id) a.id = uid(); if(!a.status) a.status = "todo"; });
  try{ localStorage.setItem(KEY, JSON.stringify(DB)); }catch(e){}
}

function pushRemote(){
  if(!API) return;
  const seq = ++pushSeq;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(()=>{
    fetch(API, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify(Object.assign({}, DB, { baseUpdatedAt: apiBase }))
    }).then(r=> r.ok ? r.json() : null).then(j=>{
      if(j && j.ok){
        apiBase = j.updatedAt || apiBase;
        // 服务端发现底稿过期，已经做过合并：以合并结果为准，别把结果丢掉。
        if(j.merged && j.db && seq === pushSeq){
          adopt(j.db);
          markSync("已合并");
          refreshAll();
          return;
        }
        if(seq === pushSeq) markSync("已同步");
      }
      else if(j && j.reason === "stale"){ markSync("云端更新"); pullRemote(true); }
      else if(seq === pushSeq) markSync("未同步");
    }).catch(()=>{ if(seq === pushSeq) markSync("离线"); });
  }, 180);
}

function pullRemote(force){
  if(!API) return Promise.resolve(false);
  return fetch(API, { cache:"no-store" }).then(r=> r.ok ? r.json() : null).then(remote=>{
    if(!remote || !remote.days) return false;
    const localT = (DB.meta && DB.meta.updatedAt) || "";
    const remoteT = (remote.meta && remote.meta.updatedAt) || "";
    const remoteN = Object.keys(remote.days).length + Object.keys(remote.weeks).length + (remote.assignments || []).length;
    const localN = Object.keys(DB.days).length + Object.keys(DB.weeks).length + DB.assignments.length;

    // 服务端空了但本地有：把本地推回去（部署环境重建时靠这一步自动恢复）
    if(remoteN === 0 && localN > 0){ pushRemote(); markSync("本地为准"); return false; }
    // 远端有数据且不旧于本地：采用远端
    if(remoteN > 0 && (force || remoteT >= localT)){
      adopt(remote);
      apiBase = remoteT;
      markSync("已同步");
      return true;
    }
    // 本地更新：推上去
    if(localN > 0){ pushRemote(); }
    markSync("已同步");
    return false;
  }).catch(()=>{ markSync("离线"); return false; });
}

/* 同步状态：颜色即状态，文字只是补充 */
function markSync(txt){
  const el = document.getElementById("syncState");
  if(!el) return;
  if(!API){ el.hidden = true; return; }
  el.hidden = false;
  const map = { "已同步":"ok", "连接中":"busy", "离线":"off", "未同步":"warn", "云端更新":"warn", "本地为准":"warn", "已合并":"warn" };
  el.dataset.state = map[txt] || "ok";
  const b = el.querySelector("b");
  if(b) b.textContent = txt;
}

function refreshAll(){
  FOCUS = focusOf(PLAN);
  applyUI();        // 远端方案可能同时改了界面开关，先按新开关收一遍再渲染
  renderBrand();
  renderGoalNote();
  renderFocusForm();
  fillForm(TODAY);
  renderBrief();
  renderStrip();
  renderAsg();
  renderWeek(); renderDebt(); renderTrend(); renderHistory(); renderWeekArchive();
  renderMilestones();
}

function uid(){ return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

/* ══════════ 日期工具 ══════════ */
const TODAY = todayStr();

/* 页面侧绑定：domain 要的是参数，这里把全局 DB / PLAN / TODAY 绑上去。
   名字与签名和抽取前完全一致，所以下面一千多行渲染代码一行都不用改。 */
const getWeekDays   = (ws) => domainStats.getWeekDays(DB, ws);
const sumHours      = (a) => domainStats.sumHours(a);
const courseGapDays = (cid) => domainStats.courseGapDays(DB, cid, TODAY);
const focusWeek     = (ws) => domainStats.focusWeek(DB, ws);
const streakNoRest  = () => domainStats.streakNoRest(DB, TODAY);
const semWeek       = (s) => domainStats.semWeek(PLAN, s);
const isOpen        = (a) => domainStats.isOpen(a);
const overdueDays   = (a) => domainStats.overdueDays(a, TODAY);
const dueIn         = (a) => domainStats.dueIn(a, TODAY);
const pendAsg       = () => domainStats.pendAsg(DB);
const doneAsg       = () => domainStats.doneAsg(DB);
const buildAnalysis = (rec) => domainRules.buildAnalysis(DB, PLAN, rec, TODAY, UI);
/* ══════════ 作业：状态与工具 ══════════ */
const ST = { todo:"未开始", doing:"进行中", done:"已完成", graded:"已批改" };
/* ══════════ 顶部状态条 ══════════ */
function renderStrip(){
  const cDate = focusDate();
  const dCet = cDate ? daysBetween(TODAY, cDate) : null;
  const exDate = examWindowStart();
  const exCourse = firstExamCourse();
  const dExam = exDate ? daysBetween(TODAY, exDate) : null;
  const od = DB.assignments.filter(a=>overdueDays(a) !== null).length;
  const pend = pendAsg().length;
  const cls = v => (v == null) ? "" : (v <= 7 ? "alert" : (v <= 30 ? "soon" : ""));
  const ws = weekStartOf(TODAY);
  const wh = sumHours(getWeekDays(ws));
  const pct = Math.min(100, Math.round(wh / PLAN.weeklyBudget * 100));
  const dw = parseD(TODAY);
  const strip = document.getElementById("todayStrip");
  // 没配专项（或被关掉了）就少一格，栅格跟着收一列，别留个空洞
  const showFocus = focusVisible();
  const showAsg = modOn("stripAsg");
  const showExam = modOn("stripExam");
  strip.classList.toggle("no-focus", !showFocus);

  strip.innerHTML = `
    <div class="ts-cell hero">
      <div>
        <div class="ts-k">今天 · 第 ${semWeek(TODAY)} 教学周</div>
        <div class="ts-date num">${dw.getMonth()+1}<span class="sl">/</span>${dw.getDate()}</div>
        <div class="ts-hero-sub">周${WK[dw.getDay()]}${(dCet==null||!showFocus)?"":" · 距"+focusLabel()+" "+dCet+" 天"}</div>
      </div>
      <div class="ts-usage">
        <div class="ts-usage-row"><span>本周投入</span><b class="num">${wh.toFixed(1)}<small>/${PLAN.weeklyBudget}h</small></b></div>
        <div class="bar"><span style="width:${pct}%"></span></div>
      </div>
    </div>
    ${showAsg ? `<div class="ts-cell">
      <div class="ts-k">待做作业</div>
      <div class="ts-v ${od?'alert':''}">${pend}<small>项</small></div>
      <div class="ts-d">${od?`<i class="dot bad"></i><span style="color:var(--bad)">${od} 项已逾期</span>`:'<i class="dot ok"></i>无逾期'}</div>
    </div>` : ""}
    ${showFocus ? `<div class="ts-cell">
      <div class="ts-k">距${focusLabel()}</div>
      <div class="ts-v ${cls(dCet)}">${dCet==null?"—":dCet}${dCet==null?"":"<small>天</small>"}</div>
      <div class="ts-d">${cDate ? fmtMD(cDate)+(FOCUS.time?" · "+esc(FOCUS.time):"") : "未设日期"}</div>
    </div>` : ""}
    ${showExam ? `<div class="ts-cell">
      <div class="ts-k">距期末首科</div>
      <div class="ts-v ${cls(dExam)}">${dExam==null?"—":dExam}${dExam==null?"":"<small>天</small>"}</div>
      <div class="ts-d">${exCourse ? exCourse.name+" · "+(exCourse.status||"待核实") : "未设置"}</div>
    </div>` : ""}`;

  const badge = document.getElementById("asgBadge");
  const urgent = od + DB.assignments.filter(a=>{ const d = dueIn(a); return d !== null && d >= 0 && d <= 3; }).length;
  if(urgent > 0){ badge.textContent = urgent; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");
}

/* ══════════ 打卡表单 ══════════ */
const LV = ["没动","看了一点","复习做题","完整推进"];

function renderCourseRows(saved){
  document.getElementById("courseRows").innerHTML = PLAN.courses.map(c=>{
    const v = saved && saved.courses && saved.courses[c.id] != null ? saved.courses[c.id] : 0;
    return `<div class="course-line" data-cid="${c.id}">
      <div class="nm">
        <b>${c.name}</b>
        <div class="meta">${PLAN.courseTarget ? "目标 "+PLAN.courseTarget+" · " : ""}${c.slot || ""}</div>
      </div>
      <div class="seg" role="group" aria-label="${c.name} 推进程度">
        ${LV.map((l,i)=>`<button type="button" class="lv${i} ${v===i?'on':''}" onclick="setLv(this,${i})">${l}</button>`).join("")}
      </div>
    </div>`;
  }).join("");
}
function setLv(btn, v){
  const seg = btn.parentNode;
  Array.prototype.forEach.call(seg.children, b=>b.classList.remove("on"));
  btn.classList.add("on");
  setSaveState("未保存的改动", "dirty");
}
function getLv(cid){
  const line = document.querySelector('.course-line[data-cid="'+cid+'"]');
  if(!line) return 0;
  const btns = line.querySelectorAll(".seg button");
  for(let i=0;i<btns.length;i++) if(btns[i].classList.contains("on")) return i;
  return 0;
}

/* 保存状态提示：idle / dirty / ok */
function setSaveState(text, state){
  const el = document.getElementById("saveHint");
  if(!el) return;
  el.textContent = text || "";
  el.dataset.state = state || "";
}

/* ══════════ 打卡表单里的专项块：显不显示、叫什么名字，都跟着方案走 ══════════
   这里以前写死「CET-6 今天 / 单词数 / 精听段」。使用者可能考四级、考研单科、
   计算机二级，也可能压根没有专项，所以文案一律从 plan.focus 取。 */
function renderFocusForm(){
  const block = document.getElementById("focusCounts");
  const scoreField = document.getElementById("focusScoreField");
  if(!block) return;
  if(!focusVisible()){
    block.classList.add("hidden");
    if(scoreField) scoreField.classList.add("hidden");
    return;
  }
  block.classList.remove("hidden");
  if(scoreField) scoreField.classList.remove("hidden");

  const U = FOCUS.units;
  const title = document.getElementById("focusTitle");
  if(title) title.textContent = focusLabel() + " · 今天";
  const dw = document.getElementById("d-words");
  if(dw) dw.placeholder = U.words;
  const dl = document.getElementById("d-listen");
  if(dl) dl.placeholder = U.listen;
  const dp = document.getElementById("d-paper");
  if(dp && dp.options.length > 1) dp.options[1].textContent = `完成 1 次${U.paper}`;
  const sl = document.getElementById("focusScoreLabel");
  if(sl) sl.textContent = "本次得分（可空）";
  const ds = document.getElementById("d-score");
  if(ds){
    if(FOCUS.scoreMax != null) ds.setAttribute("max", String(FOCUS.scoreMax));
    else ds.removeAttribute("max");
    ds.placeholder = FOCUS.target != null ? "目标 " + FOCUS.target + " · 留空=未出分" : "留空=未出分";
  }
}

function fillForm(dateStr){
  const rec = DB.days[dateStr];
  document.getElementById("d-date").value = dateStr;
  const set = (id,val)=>{ document.getElementById(id).value = (val==null?"":val); };
  set("d-hours", rec ? (rec.hours || "") : "");
  set("d-focus", rec ? (rec.focus||"") : "");
  set("d-words", rec && rec.words ? rec.words : "");
  set("d-listen", rec && rec.listen ? rec.listen : "");
  set("d-paper", rec && rec.paper ? String(rec.paper) : "0");
  set("d-score", rec && rec.score ? rec.score : "");
  set("d-sleep", rec && rec.sleep ? rec.sleep : "");
  set("d-blocker", rec ? (rec.blocker||"") : "");
  renderCourseRows(rec);
  setSaveState(rec ? "已载入该日记录" : "", "idle");
  if(rec) showAnalysis(rec, false);
  else document.getElementById("analysisOut").innerHTML = "";
}

function collect(){
  const courses = {};
  // 关掉的模块不写进记录：省得以后有人对着一堵墙似的字段犯嘀咕
  PLAN.courses.forEach(c=>{ courses[c.id] = modOn("courseProgress") ? getLv(c.id) : 0; });
  const g = id => document.getElementById(id).value;
  const fOn = modOn("focus");
  return {
    date: g("d-date") || TODAY,
    hours: parseFloat(g("d-hours")) || 0,
    focus: g("d-focus"),
    words: fOn ? (parseInt(g("d-words")) || 0) : 0,
    listen: fOn ? (parseInt(g("d-listen")) || 0) : 0,
    paper: fOn ? (parseInt(g("d-paper")) || 0) : 0,
    score: fOn && g("d-score") ? parseInt(g("d-score")) : null,
    sleep: modOn("sleep") && g("d-sleep") ? parseFloat(g("d-sleep")) : null,
    courses,
    blocker: modOn("blocker") ? g("d-blocker").trim() : "",
    ts: Date.now()
  };
}

function saveDay(){
  const rec = collect();
  const empty = !rec.hours && !rec.words && !rec.listen && !rec.paper && !rec.blocker
    && Object.keys(rec.courses).every(k=>rec.courses[k]===0);
  if(empty){ toast("什么都没填。先记一点真实进展，哪怕只是一门课「看了一点」", "warn"); fxFlash(document.getElementById("saveBtn"), "err"); return; }
  DB.days[rec.date] = rec;
  save();
  setSaveState("已保存 " + fmtMD(rec.date), "ok");
  showAnalysis(rec, true);
  flashSaveBtn();
  toast("已保存");
  renderStrip(); renderWeek(); renderHistory(); renderTrend(); renderDebt();
}

/* 主按钮短暂变绿，给一次「已落地」的确认 */
function flashSaveBtn(){
  const btn = document.getElementById("saveBtn");
  if(!btn) return;
  const label = btn.textContent;
  btn.classList.add("flashing");
  btn.textContent = "已保存 ✓";
  clearTimeout(btn._t);
  btn._t = setTimeout(()=>{ btn.classList.remove("flashing"); btn.textContent = label; }, 1300);
}

function resetForm(){
  const d = document.getElementById("d-date").value || TODAY;
  fillForm(d);
  document.getElementById("analysisOut").innerHTML = "";
  toast("已恢复为该日已保存的状态");
}

/* 规则实现见 core/domain/rules.js */
function showAnalysis(rec, fresh){
  const r = buildAnalysis(rec);
  const out = document.getElementById("analysisOut");
  if(!r.analyses.length && !r.acts.length){ out.innerHTML = ""; return; }
  let html = `<div class="card">
    <div class="card-h"><h2>${fresh ? "今天的分析" : "该日记录的分析"}<button class="info" data-tip="判断全部基于你填的数字；没填的部分不会替你假设。" aria-label="判断全部基于你填的数字；没填的部分不会替你假设。"></button></h2>
      <span class="tag acc">${fmtCn(rec.date)}</span></div>`;
  r.analyses.forEach(a=>{
    html += `<div class="analysis ${a.type}"><div class="t">${a.title}</div><div class="b">${a.body}</div></div>`;
  });
  if(r.acts.length){
    html += `<div class="sub-h">下一步（最多三项）</div>
      <ul class="acts">${r.acts.map(a=>`<li>${a.text}<span class="why">${a.why||""}</span></li>`).join("")}</ul>`;
  }
  html += `</div>`;
  out.innerHTML = html;
  if(fresh) out.scrollIntoView({behavior:"smooth", block:"nearest"});
}

/* ══════════ 作业台账渲染 ══════════ */
let ASG_FILTER = "all";

function renderAsgStats(){
  const open = DB.assignments.filter(isOpen);
  const od = open.filter(a=>overdueDays(a) !== null);
  const week = open.filter(a=>{ const d = dueIn(a); return d !== null && d >= 0 && d <= 7; });
  const est = open.reduce((s,a)=>s+(parseFloat(a.est)||0),0);
  const done7 = DB.assignments.filter(a=>a.doneDate && daysBetween(a.doneDate, TODAY) <= 6 && daysBetween(a.doneDate, TODAY) >= 0).length;
  const noDue = open.filter(a=>!a.due).length;

  let h = `<div class="stat"><div class="k">待做</div><div class="v">${open.length}<small>项</small></div><div class="d">预计 ${est.toFixed(1)}h</div></div>`;
  h += `<div class="stat ${od.length?'bad':''}"><div class="k">已逾期</div><div class="v">${od.length}<small>项</small></div><div class="d">${od.length?'需要今天处理':'无'}</div></div>`;
  h += `<div class="stat ${week.length?'warn':''}"><div class="k">7 天内到期</div><div class="v">${week.length}<small>项</small></div><div class="d">${week.length? '最近 '+fmtMD(week[0].due) : '无'}</div></div>`;
  h += `<div class="stat hl"><div class="k">近 7 天完成</div><div class="v">${done7}<small>项</small></div><div class="d">含已批改</div></div>`;
  h += `<div class="stat"><div class="k">未定截止</div><div class="v">${noDue}<small>项</small></div><div class="d">${noDue?'建议补上日期':'无'}</div></div>`;
  document.getElementById("asgStats").innerHTML = h;
}

function asgRow(a, isDoneRow){
  const od = overdueDays(a);
  const din = dueIn(a);
  const meta = [];
  if(a.due){
    meta.push(`截止 ${fmtMD(a.due)}`);
    if(od) meta.push(`<span class="od-t">逾期 ${od} 天</span>`);
    else if(din === 0) meta.push(`<span class="soon-t">今天交</span>`);
    else if(din !== null && din <= 3) meta.push(`<span class="soon-t">${din} 天后</span>`);
  }else meta.push(`<span class="dim">未定截止</span>`);
  if(a.est) meta.push(`预计 ${a.est}h`);
  if(a.pri === 2) meta.push(`<span class="pill acc">重要</span>`);
  if(isDoneRow){
    if(a.doneDate) meta.push(`完成 ${fmtMD(a.doneDate)}`);
    if(a.act) meta.push(`实耗 ${a.act}h`);
    if(a.score != null && a.score !== "") meta.push(`得分 ${esc(a.score)}`);
  }
  if(a.note) meta.push(`<span class="muted">${esc(a.note)}</span>`);

  return `<div class="asg ${od?'od':''} ${isDoneRow?'done-row':''}" data-aid="${a.id}">
    <button class="chk ${isDoneRow?'done':''}" onclick="toggleAsg('${a.id}')" aria-label="${isDoneRow?'标记为待做':'标记为已完成'}"></button>
    <div class="asg-main">
      <div class="asg-title">${esc(a.title)}</div>
      <div class="asg-meta">${meta.join('<span class="sep">·</span>')}</div>
    </div>
    <div class="asg-acts">
      <button class="btn xs ghost" onclick="openEdit('${a.id}')">改</button>
      <button class="btn xs ghost" onclick="delAsg('${a.id}')" style="color:var(--bad)">删</button>
    </div>
  </div>
  <div class="asg-edit hidden" id="edit-${a.id}">
    <div class="grid3">
      <div><label class="lbl">作业名</label><input type="text" id="e-title-${a.id}" value="${esc(a.title)}"></div>
      <div><label class="lbl">截止日期</label><input type="date" id="e-due-${a.id}" value="${a.due||''}"></div>
      <div><label class="lbl">状态</label><select id="e-status-${a.id}">
        ${Object.keys(ST).map(k=>`<option value="${k}" ${a.status===k?'selected':''}>${ST[k]}</option>`).join("")}
      </select></div>
    </div>
    <div class="grid3" style="margin-bottom:10px">
      <div><label class="lbl">预计 h</label><input type="number" step="0.5" min="0" id="e-est-${a.id}" value="${a.est||''}"></div>
      <div><label class="lbl">实际 h</label><input type="number" step="0.25" min="0" id="e-act-${a.id}" value="${a.act||''}"></div>
      <div><label class="lbl">得分 / 评价</label><input type="text" id="e-score-${a.id}" value="${esc(a.score||'')}" placeholder="例：92 / 良好"></div>
    </div>
    <div><label class="lbl">备注</label><input type="text" id="e-note-${a.id}" value="${esc(a.note||'')}"></div>
    <div class="row" style="justify-content:flex-end;margin-top:10px">
      <button class="btn sm ghost" onclick="closeEdit('${a.id}')">取消</button>
      <button class="btn sm primary" onclick="saveEdit('${a.id}')">保存</button>
    </div>
  </div>`;
}

function renderAsg(){
  renderAsgStats();

  /* 待做 */
  let list = pendAsg();
  if(ASG_FILTER === "overdue") list = list.filter(a=>overdueDays(a) !== null);
  if(ASG_FILTER === "week") list = list.filter(a=>{ const d = dueIn(a); return d !== null && d >= 0 && d <= 7; });
  if(ASG_FILTER === "nohome") list = list.filter(a=>!a.due);

  document.getElementById("pendCount").textContent = list.length + " 项";
  const pendBox = document.getElementById("pendList");

  if(!list.length){
    pendBox.innerHTML = `<div class="empty"><b>${DB.assignments.length ? "这个筛选下没有作业" : "还没有登记任何作业"}</b>
      ${DB.assignments.length ? "换一个筛选看看，或者去上面添加。" : "把已知的作业先录进来——空着不等于没有作业，只是你还没记。"}</div>`;
  }else{
    // 按课程分组
    let html = "";
    PLAN.courses.forEach(c=>{
      const items = list.filter(a=>a.course === c.id);
      if(!items.length) return;
      const odc = items.filter(a=>overdueDays(a) !== null).length;
      html += `<div class="course-block">
        <div class="cb-head">
          <span class="dot"></span><span class="nm">${c.name}</span>
          <span class="cnt">
            ${odc?`<span class="pill b">${odc} 逾期</span>`:""}
            <span>${items.length} 项待做</span>
          </span>
        </div>
        ${items.map(a=>asgRow(a, false)).join("")}
      </div>`;
    });
    const others = list.filter(a=>!PLAN.courses.some(c=>c.id === a.course));
    if(others.length){
      html += `<div class="course-block">
        <div class="cb-head"><span class="dot" style="background:var(--ink-4)"></span><span class="nm">其他 / 未分类</span>
          <span class="cnt">${others.length} 项</span></div>
        ${others.map(a=>asgRow(a,false)).join("")}</div>`;
    }
    pendBox.innerHTML = html;
  }

  /* 已完成 */
  const done = doneAsg();
  document.getElementById("doneCount").textContent = done.length + " 项";
  const doneBox = document.getElementById("doneList");
  if(!done.length){
    doneBox.innerHTML = `<div class="empty"><b>还没有完成的作业</b>勾掉第一项后，这里会按课程归档，成为期末复盘和导师材料的原始记录。</div>`;
  }else{
    let html = "";
    PLAN.courses.forEach(c=>{
      const items = done.filter(a=>a.course === c.id);
      if(!items.length) return;
      html += `<div class="course-block">
        <div class="cb-head"><span class="dot" style="background:var(--good)"></span>
          <span class="nm">${c.name}</span>
          <span class="cnt"><span class="pill ok">${items.length} 项已完成</span></span>
        </div>
        ${items.map(a=>asgRow(a, true)).join("")}
      </div>`;
    });
    doneBox.innerHTML = html;
  }
  renderExportAge();
  renderStrip();
}

/* 导出时效提示：定时任务读的是导出的快照，太久没导出就会提醒 */
function renderExportAge(){
  const box = document.getElementById("exportAge");
  if(!box) return;
  const last = DB.meta && DB.meta.lastExport;
  if(!last){
    box.innerHTML = `<div class="note warn">
      <b>还没导出过。</b>每天 08:30 的定时任务现在读不到数据，去点上面的「导出作业清单」。</div>`;
    return;
  }
  const n = daysBetween(last, TODAY);
  if(n <= 0){
    box.innerHTML = `<div class="note good">
      上次导出：今天。定时任务明天早上读到的是最新数据。</div>`;
  }else if(n <= 3){
    box.innerHTML = `<div class="note">上次导出：<b>${n} 天前</b>（${fmtMD(last)}）。还有 ${3-n} 天宽限，别忘了更新。</div>`;
  }else{
    box.innerHTML = `<div class="note bad">
      上次导出：<b>${n} 天前</b>（${fmtMD(last)}）。定时任务已经在提醒你「清单过期」，现在点一次导出就恢复。</div>`;
  }
}

function addAsg(){
  const course = document.getElementById("a-course").value;
  const titleEl = document.getElementById("a-title");
  const title = titleEl.value.trim();
  const due = document.getElementById("a-due").value;
  const est = document.getElementById("a-est").value;
  const assigned = document.getElementById("a-assigned").value;
  const note = document.getElementById("a-note").value.trim();
  const pri = parseInt(document.getElementById("a-pri").value);
  const addBtn = document.getElementById("a-add");

  if(!title){
    toast("先写作业名。具体点，例：第5章习题 3/7/11", "warn");
    fxInvalid(titleEl, true);
    fxFlash(addBtn, "err");
    return;
  }
  if(!course){ toast("先选课程", "warn"); fxFlash(document.getElementById("a-course"), "err"); return; }

  const rec = {
    id:uid(), course, title, due:due||"", assigned:assigned||"",
    est: est ? parseFloat(est) : "", act:"", status:"todo",
    note, pri, doneDate:"", score:"", createdAt:Date.now()
  };
  DB.assignments.push(rec);
  save();
  titleEl.value = "";
  document.getElementById("a-est").value = "";
  document.getElementById("a-note").value = "";
  renderAsg();
  renderWeek();
  toast("已添加：" + title);
  fxFlash(addBtn, "ok");
  const rowEl = document.querySelector('.asg[data-aid="' + rec.id + '"]');
  if(rowEl) rowEl.classList.add("is-new");
  titleEl.focus();
}

function toggleAsg(id){
  const a = DB.assignments.find(x=>x.id === id);
  if(!a) return;
  if(isOpen(a)){
    a.status = "done";
    a.doneDate = TODAY;
  }else{
    a.status = "todo";
    a.doneDate = "";
  }
  save(); renderAsg(); renderWeek();
  // 重绘后让刚点的那盏红石灯亮一下，确认「这一下真的落库了」
  const chk = document.querySelector('.asg[data-aid="' + id + '"] .chk');
  if(chk) chk.classList.add("is-hit");
  toast(isOpen(a) ? "已恢复为待做" : "已标记完成 · " + fmtMD(TODAY));
}

function openEdit(id){
  const el = document.getElementById("edit-"+id);
  if(el) el.classList.toggle("hidden");
}
function closeEdit(id){
  const el = document.getElementById("edit-"+id);
  if(el) el.classList.add("hidden");
}
function saveEdit(id){
  const a = DB.assignments.find(x=>x.id === id);
  if(!a) return;
  const v = k => document.getElementById("e-"+k+"-"+id).value;
  a.title = v("title").trim() || a.title;
  a.due = v("due") || "";
  const st = v("status");
  if(st !== a.status){
    a.status = st;
    if(st === "done" || st === "graded"){
      if(!a.doneDate) a.doneDate = TODAY;
    }else{
      a.doneDate = "";
    }
  }
  a.est = v("est") ? parseFloat(v("est")) : "";
  a.act = v("act") ? parseFloat(v("act")) : "";
  a.score = v("score").trim();
  a.note = v("note").trim();
  save(); renderAsg(); renderWeek();
  const rowEl = document.querySelector('.asg[data-aid="' + id + '"]');
  if(rowEl) rowEl.classList.add("is-new");
  toast("已更新");
}

function delAsg(id){
  const a = DB.assignments.find(x=>x.id === id);
  if(!a) return;
  if(!confirm("删除「"+a.title+"」？\n删除后无法恢复，作业的历史记录也会一起消失。")) return;
  const commit = ()=>{
    DB.assignments = DB.assignments.filter(x=>x.id !== id);
    save(); renderAsg(); renderWeek();
    toast("已删除");
  };
  // 先原地收起来再重绘，不然列表会「跳一下」
  const rowEl = document.querySelector('.asg[data-aid="' + id + '"]');
  if(!rowEl || !rowEl.offsetHeight) return commit();
  rowEl.style.height = rowEl.offsetHeight + "px";
  rowEl.classList.add("is-removing");
  requestAnimationFrame(()=>{ rowEl.style.height = "0px"; });
  setTimeout(commit, 165);
}

function exportAsg(){
  const open = DB.assignments.filter(isOpen);
  const payload = {
    exportedAt: new Date().toISOString(),
    generatedFor: "能源动力学业台账",
    summary: {
      pending: open.length,
      overdue: open.filter(a=>overdueDays(a) !== null).length,
      dueIn3: open.filter(a=>{ const d = dueIn(a); return d !== null && d >= 0 && d <= 3; }).length,
      dueIn7: open.filter(a=>{ const d = dueIn(a); return d !== null && d >= 0 && d <= 7; }).length,
      estHours: +open.reduce((s,a)=>s+(parseFloat(a.est)||0),0).toFixed(1)
    },
    assignments: DB.assignments.map(a=>({
      id:a.id, course:a.course, courseName:CNAME[a.course]||"未分类",
      title:a.title, assigned:a.assigned||"", due:a.due||"",
      status:a.status, statusText:ST[a.status],
      overdueDays:overdueDays(a), daysLeft:dueIn(a),
      estHours:a.est||null, actHours:a.act||null,
      doneDate:a.doneDate||"", score:a.score||"", note:a.note||"", priority:a.pri
    }))
  };
  download(JSON.stringify(payload, null, 2), "assignments.json", "application/json");
  DB.meta.lastExport = TODAY;
  save();
  renderExportAge();
  toast("已导出 assignments.json。放到项目目录下（和 launch.js 同级），定时任务就能读");
}

function copyReminder(){
  const open = pendAsg();
  if(!open.length){ toast("当前没有待做作业", "warn"); return; }
  const od = open.filter(a=>overdueDays(a) !== null);
  const s3 = open.filter(a=>{ const d = dueIn(a); return d !== null && d >= 0 && d <= 3; });
  const s7 = open.filter(a=>{ const d = dueIn(a); return d !== null && d > 3 && d <= 7; });
  const est = open.reduce((s,a)=>s+(parseFloat(a.est)||0),0);

  let t = `【作业提醒】${TODAY}（第 ${semWeek(TODAY)} 教学周）\n`;
  if(od.length){
    t += `\n已逾期 ${od.length} 项：\n`;
    od.forEach(a=>{ t += `- [${CNAME[a.course]}] ${a.title}（截止 ${a.due}，逾期 ${overdueDays(a)} 天）\n`; });
  }
  if(s3.length){
    t += `\n3 天内到期 ${s3.length} 项：\n`;
    s3.forEach(a=>{ t += `- [${CNAME[a.course]}] ${a.title}（${dueIn(a)===0?"今天":"还剩 "+dueIn(a)+" 天"}，${a.due}）\n`; });
  }
  if(s7.length){
    t += `\n本周内到期 ${s7.length} 项：\n`;
    s7.forEach(a=>{ t += `- [${CNAME[a.course]}] ${a.title}（${a.due}）\n`; });
  }
  const noDue = open.filter(a=>!a.due);
  if(noDue.length){
    t += `\n未定截止 ${noDue.length} 项：\n`;
    noDue.forEach(a=>{ t += `- [${CNAME[a.course]}] ${a.title}\n`; });
  }
  t += `\n合计待做 ${open.length} 项，预计 ${est.toFixed(1)}h。\n`;

  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(()=>toast("提醒文本已复制"), ()=>fallbackCopy(t));
  }else fallbackCopy(t);
}
function fallbackCopy(t){
  const ta = document.createElement("textarea");
  ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); toast("提醒文本已复制"); }catch(e){ toast("复制失败，请手动选择", "warn"); }
  document.body.removeChild(ta);
}
function download(text, name, mime){
  const blob = new Blob([text], {type:mime||"text/plain;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1500);
}
function exportAll(){
  download(JSON.stringify(DB, null, 2), `台账全量-${TODAY}.json`, "application/json");
  toast("已导出全量记录（含个人数据，勿上传公开仓库）");
}

/* 导入：兼容「全量备份」和「作业清单」两种 JSON，用于换浏览器/换打开方式时搬数据 */
function importJSON(text){
  let o;
  try{ o = JSON.parse(text); }catch(e){ toast("文件不是有效的 JSON", "warn"); return; }
  let addDays_ = 0, addWeeks_ = 0, addAsg = 0, skipAsg = 0;

  const mergeDays = src => {
    if(!src || typeof src !== "object") return;
    Object.keys(src).forEach(k=>{
      if(!DB.days[k]){ DB.days[k] = src[k]; addDays_++; }
    });
  };
  const mergeWeeks = src => {
    if(!src || typeof src !== "object") return;
    Object.keys(src).forEach(k=>{
      if(!DB.weeks[k]){ DB.weeks[k] = src[k]; addWeeks_++; }
    });
  };
  const mergeAsg = src => {
    if(!Array.isArray(src)) return;
    const sig = a => [a.course, (a.title||"").trim(), a.due||""].join("|");
    const exist = new Set(DB.assignments.map(sig));
    src.forEach(a=>{
      if(!a || !a.title){ return; }
      if(a.id && DB.assignments.some(x=>x.id === a.id)){ skipAsg++; return; }
      if(exist.has(sig(a))){ skipAsg++; return; }
      DB.assignments.push({
        id: a.id || uid(), course: a.course || "other", title: a.title,
        due: a.due || "", assigned: a.assigned || "",
        est: a.estHours != null ? a.estHours : (a.est || ""),
        act: a.actHours != null ? a.actHours : (a.act || ""),
        status: a.status || "todo", pri: a.priority != null ? a.priority : (a.pri != null ? a.pri : 1),
        note: a.note || "", doneDate: a.doneDate || "", score: a.score || "",
        createdAt: a.createdAt || Date.now()
      });
      exist.add(sig(a)); addAsg++;
    });
  };

  mergeDays(o.days);
  mergeWeeks(o.weeks);
  mergeAsg(o.assignments);

  if(!addDays_ && !addWeeks_ && !addAsg && !skipAsg){
    toast("这个文件里没有可导入的记录", "warn");
    return;
  }
  save();
  renderStrip(); renderAsg(); renderWeek(); renderHistory(); renderTrend();
  renderDebt(); renderWeekArchive(); renderExportAge();
  toast(`导入完成：打卡 ${addDays_} 天 · 周复盘 ${addWeeks_} 条 · 作业 ${addAsg} 项` + (skipAsg?`（已存在跳过 ${skipAsg}）`:""));
}

/* ══════════ 本周 ══════════ */
function renderWeek(){
  const ws = weekStartOf(TODAY);
  const days = getWeekDays(ws);
  const hours = sumHours(days);
  const cw = focusWeek(ws);
  const pct = Math.min(100, Math.round(hours / PLAN.weeklyBudget * 100));
  const barCls = hours > 19.5 ? "over" : (hours < 7 ? "low" : "");

  const cw2 = focusWeek(ws);
  const wGoal = FOCUS.goals.words;
  const lGoal = FOCUS.goals.listen;
  const pGoal = FOCUS.goals.paper;
  const wDate = focusDate();
  const wLabel = focusLabel();
  const U = FOCUS.units;
  // 专项统计随开关显隐；作业那格也是——关了作业台账的人不该在周概览里被追问作业
  const showFocus = focusVisible();
  const showAsg = tabOn("asg");
  document.getElementById("weekTag").textContent = `${fmtMD(ws)} – ${fmtMD(addDays(ws,6))}`;
  const bh = document.getElementById("budgetHint");
  if(bh) bh.textContent = PLAN.weeklyBudget + " 小时/周";
  document.getElementById("weekStats").innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="k">本周投入</div><div class="v">${hours.toFixed(1)}<small>h</small></div>
        <div class="bar"><span class="${barCls}" style="width:${pct}%"></span></div>
        <div class="d">预算 ${PLAN.weeklyBudget}h · ${pct}%</div></div>
      <div class="stat"><div class="k">已打卡</div><div class="v">${days.length}<small>/7 天</small></div>
        <div class="d">日均 ${days.length?(hours/days.length).toFixed(1):"0"}h</div></div>
      ${showFocus ? `
      <div class="stat"><div class="k">${wLabel} · ${esc(U.words)}</div><div class="v">${cw2.words}${wGoal?`<small>/${wGoal}</small>`:""}</div>
        <div class="d">${wGoal?Math.round(cw2.words/wGoal*100)+"%":"未设目标"}</div></div>
      <div class="stat"><div class="k">${wLabel} · ${esc(U.listen)}</div><div class="v">${cw2.listen}${lGoal?`<small>/${lGoal}</small>`:""}</div>
        <div class="d">${U.paper} ${cw2.paper}${pGoal?` / ${pGoal}`:""}</div></div>` : ""}
      ${showAsg ? `<div class="stat"><div class="k">本周交作业</div><div class="v">${DB.assignments.filter(a=>a.doneDate && daysBetween(ws,a.doneDate) >= 0 && daysBetween(ws,a.doneDate) <= 6).length}<small>项</small></div>
        <div class="d">待做 ${pendAsg().length} 项</div></div>` : ""}
      ${showFocus ? `<div class="stat"><div class="k">距${wLabel}</div><div class="v">${wDate?Math.max(0,daysBetween(TODAY,wDate)):"—"}${wDate?"<small>天</small>":""}</div>
        <div class="d">${wDate?fmtMD(wDate)+(FOCUS.time?" "+esc(FOCUS.time):""):"未设日期"}</div></div>` : ""}
    </div>`;

  const tasks = (PLAN.weekTasks && PLAN.weekTasks[ws]) || [];
  const box = document.getElementById("weekTasks");
  if(!tasks.length){
    box.innerHTML = `<div class="empty"><b>这一周没有登记优先任务</b>告诉我本周的重点，我来排。</div>`;
    return;
  }
  let html = `<table><tbody>`;
  tasks.forEach((t,i)=>{
    let done = false, detail = "";
    if(t.type === "course"){
      const cnt = PLAN.courses.filter(c=>{ const g = courseGapDays(c.id); return g !== null && g <= 7; }).length;
      done = cnt >= t.need; detail = `${cnt}/${t.need} 门已启动`;
    }else if(t.type === "cet" || t.type === "focus"){
      // 达标线来自方案里的周目标；没设目标时，只要真做了任何一项就算达成
      const gA = FOCUS.goals.words, gB = FOCUS.goals.listen;
      const anyGoal = gA > 0 || gB > 0;
      done = cw.paper >= 1
        || (gA > 0 && cw.words >= gA)
        || (gB > 0 && cw.listen >= gB)
        || (!anyGoal && (cw.words > 0 || cw.listen > 0 || cw.paper > 0));
      detail = `${FOCUS.units.words} ${cw.words} · ${FOCUS.units.listen} ${cw.listen} · ${FOCUS.units.paper} ${cw.paper}`;
    }else{
      const tot = days.reduce((s,d)=>{
        const f = d.focus;
        return s + ((f === "mentor" || f === "project" || f === "software") ? (d.hours||0) : 0);
      },0);
      done = tot >= 1; detail = `相关投入 ${tot.toFixed(1)}h`;
    }
    html += `<tr>
      <td style="width:26px" class="dim num">${i+1}</td>
      <td>${t.text}<div class="t-detail">${detail}${t.est?` · 预算 ${t.est}h`:""}</div></td>
      <td style="width:82px;text-align:right"><span class="pill ${done?'ok':'no'}">${done?'已达成':'未达成'}</span></td>
    </tr>`;
  });
  html += `</tbody></table>
    <div class="note note-line">进度由打卡自动推算，「未达成」不等于没做<button class="info" data-tip="可能只是漏记；漏了就补记，别让记录失真。记录断档时所有建议都会退回「未知」。" aria-label="可能只是漏记；漏了就补记，别让记录失真。记录断档时所有建议都会退回「未知」。"></button></div>`;
  box.innerHTML = html;
}

function saveWeek(){
  const ws = weekStartOf(TODAY);
  const g = id => document.getElementById(id).value.trim();
  const rec = {
    ws, hours:g("w-hours"), progress:g("w-progress"),
    blocker:g("w-blocker"), reason:document.getElementById("w-reason").value,
    next:g("w-next"), ts:Date.now()
  };
  if(!rec.hours && !rec.progress && !rec.blocker){
    toast("至少填前两问再保存", "warn");
    fxFlash(document.getElementById("weekSaveBtn"), "err");
    const h = document.getElementById("w-hours");
    if(h) fxInvalid(h, true);
    return;
  }
  DB.weeks[ws] = rec; save();
  renderWeekReview(ws); renderWeekArchive(); renderDebt();
  toast("周复盘已保存");
  fxFlash(document.getElementById("weekSaveBtn"), "ok");
}

function labelReason(r){
  return {estimate:"估时错了",external:"外部约束",overload:"任务量超了",motivation:"执行问题",none:"没有未完成"}[r] || "未选原因";
}

function renderWeekReview(ws){
  const rec = DB.weeks[ws];
  const out = document.getElementById("weekOut");
  if(!rec){ out.innerHTML = ""; return; }

  const days = getWeekDays(ws);
  const actual = sumHours(days);
  const A = [], acts = [];
  const num = parseFloat((String(rec.hours).match(/[\d.]+/) || [])[0] || "");

  if(actual > 0){
    A.push({type:"", title:"记录 vs 感受",
      body:`打卡记录本周 <b>${actual.toFixed(1)}h</b>${isNaN(num)?"":`；你写的是 ${num}h`}。两者差距大时信记录——人对每周总时长的估计普遍偏高。`});
  }
  if(rec.reason === "overload"){
    A.push({type:"warn", title:"任务量超了，不是执行问题",
      body:`三项优先任务加起来超出了可用时间。按规则：<b>先缩任务，不缩睡眠、不全部顺延</b>。下周只留两项——一门最急的课${FOCUS.enabled?" + "+focusLabel():""}，第三项明确写「本周不做」。`});
    acts.push({text:"下周只列两项优先任务，第三项写「本周不做」", why:"连续超载说明任务量本身有误"});
  }else if(rec.reason === "external"){
    A.push({type:"", title:"外部约束，属于正常情况",
      body:`课多或突发事件导致的缺口，不该用「补回来」的方式处理。把未完成的那项<b>降级为下周的普通任务</b>，不要堆进下周三个优先名额里。`});
    acts.push({text:"未完成项降级，不占下周的三个优先名额", why:"队列管理比补偿心态有用"});
  }else if(rec.reason === "estimate"){
    A.push({type:"", title:"估时错了，要修正系数",
      body:`下一轮同类任务按 1.5 倍打时间。尤其是需要进入状态才能做的活（成套计时、写代码、写报告、整理笔记）：开头那几分钟不算进度，按 1.5 倍报才不会连续超时。`});
    acts.push({text:`下周每个任务写明预计小时数，累加不超过 ${PLAN.weeklyBudget}h`, why:"估时偏差是最容易修的一类问题"});
  }else if(rec.reason === "motivation"){
    A.push({type:"warn", title:"执行问题，先查任务颗粒度",
      body:`拖延常来自任务太大太模糊（「复习电路」没法开始）。改成 25 分钟能做完的具体动作（「做完电路第 3 章课后 5 道题」）。`});
    acts.push({text:"把下周任务改成 25 分钟内能开始的颗粒", why:"模糊任务是拖延的主要来源"});
  }

  const lastWs = addDays(ws,-7);
  const last = DB.weeks[lastWs];
  if(last && last.reason && last.reason !== "none"){
    A.push({type:"bad", title:"连续两周有未完成",
      body:`上周：${labelReason(last.reason)}；本周：${labelReason(rec.reason)||"未选"}。先查任务量和外部约束。<b>不要把两周的积压合并到下一周</b>——那会直接导致第三周也失败。`});
    acts.push({text:"把积压项直接删除或延期到期末后，不并入下周", why:"连续未完成时，扩容量是最差策略"});
  }
  if(actual < 10 && days.length >= 4){
    A.push({type:"warn", title:`实际投入明显低于 ${PLAN.weeklyBudget}h 预算`,
      body:`打满 ${days.length} 天记录只有 ${actual.toFixed(1)}h。可能是真实上限就这么高（那该把预算下调到现实水平），也可能是可用时段没被识别出来。下周先连着记 7 天，别猜。`});
  }
  if(actual > PLAN.weeklyBudget * 1.3){
    A.push({type:"warn", title:"本周明显超载",
      body:`${actual.toFixed(1)}h 超出 ${PLAN.weeklyBudget}h 预算不少。如果这是靠压缩睡眠换来的，下周必然反弹。查一下睡眠记录。`});
  }

  const prog = rec.progress || "";
  const unknownExam = PLAN.courses.filter(c=>!c.exam);
  if(unknownExam.length && /(考期|课名|考核|考试)/.test(prog) && /(没|未|还没|不清|不知)/.test(prog)){
    acts.push({text:`确认「${unknownExam[0].name}」的考期与考核方式`, why:"考期未知时，倒计时和复习排期都只是估值"});
  }
  if(!acts.length) acts.push({text:"保持当前三项，不改动", why:"没有明确问题时，改计划本身是成本"});

  let html = `<div class="hr"></div>`;
  A.forEach(a=>{ html += `<div class="analysis ${a.type}"><div class="t">${a.title}</div><div class="b">${a.body}</div></div>`; });
  html += `<div class="sub-h">下周建议（最多三项）</div>
    <ul class="acts">${acts.slice(0,3).map(a=>`<li>${a.text}<span class="why">${a.why||""}</span></li>`).join("")}</ul>`;
  out.innerHTML = html;
}

function renderDebt(){
  const box = document.getElementById("debtCheck");
  const weeks = Object.values(DB.weeks).sort((a,b)=>a.ws.localeCompare(b.ws)).slice(-3);
  if(!weeks.length){
    box.innerHTML = `<div class="empty"><b>还没有周复盘</b>第一次复盘后，这里开始跟踪连续未完成。</div>`;
    return;
  }
  const bad = weeks.filter(w=>w.reason && w.reason !== "none").length;
  if(bad >= 2){
    box.innerHTML = `<div class="analysis bad"><div class="t">已连续 ${bad} 周存在未完成</div>
      <div class="b">按规划原则：<b>先查任务量和外部约束，再缩小或延期</b>。当前三项优先任务里至少有一项超出真实可用时间。
      <br><br>下周执行：三项砍到两项，空出的时间不填满。被砍的任务写「延期到期末后」，不写「下周补」。</div></div>`;
  }else if(bad === 1){
    box.innerHTML = `<div class="analysis warn"><div class="t">有 1 周存在未完成</div>
      <div class="b">单周未完成是正常波动，不需要改计划。如果下周再出现，就按连续未完成处理，缩减任务量。</div></div>`;
  }else{
    box.innerHTML = `<div class="analysis good"><div class="t">近期没有连续未完成</div>
      <div class="b">最近 ${weeks.length} 周的原因记录都没有标记缺失。保持当前任务量，不要因为顺利就加码。</div></div>`;
  }
}

/* ══════════ 历史 ══════════ */
function renderHistory(){
  const box = document.getElementById("historyTable");
  const dates = Object.keys(DB.days).sort().reverse();
  if(!dates.length){
    box.innerHTML = `<div class="empty"><b>还没有打卡记录</b>去「今日打卡」记第一条。</div>`;
    return;
  }
  // 专项列只在配置了专项时出现——没用专项的人不该被迫看一列空白；卡点同理
  const showFocus = focusVisible();
  const showBlocker = modOn("blocker");
  const U = FOCUS.units;
  let html = `<table><thead><tr>
    <th style="width:88px">日期</th><th style="width:56px">时长</th>
    <th>课程推进</th>${showFocus?`<th style="width:126px">${esc(focusLabel())}</th>`:""}${showBlocker?`<th>卡点</th>`:""}<th style="width:44px"></th>
  </tr></thead><tbody>`;
  dates.forEach(d=>{
    const r = DB.days[d];
    const cs = PLAN.courses.filter(c=>r.courses && r.courses[c.id] >= 1)
      .map(c=>`${c.name} <span class="pill ${r.courses[c.id]>=2?'acc':'w'}">${LV[r.courses[c.id]]}</span>`).join(" ")
      || `<span class="dim">无</span>`;
    const fcell = [
      r.words?`${esc(U.words)} ${r.words}`:"",
      r.listen?`${esc(U.listen)} ${r.listen}`:"",
      r.paper?`${esc(U.paper)} ${r.paper}`:""
    ].filter(Boolean).join(" · ") || `<span class="dim">—</span>`;
    html += `<tr>
      <td class="num nowrap">${fmtMD(d)} <span class="dim" style="font-size:11px">周${WK[parseD(d).getDay()]}</span></td>
      <td class="num">${(r.hours||0).toFixed(1)}h</td>
      <td style="font-size:12px">${cs}</td>
      ${showFocus?`<td style="font-size:12px">${fcell}</td>`:""}
      ${showBlocker?`<td style="font-size:11.5px">${r.blocker?esc(r.blocker.slice(0,52))+(r.blocker.length>52?"…":""):""}</td>`:""}
      <td><button class="btn xs ghost" onclick="editDay('${d}')">改</button></td>
    </tr>`;
  });
  box.innerHTML = html + `</tbody></table>`;
}

function editDay(d){
  switchTab("checkin");
  document.getElementById("d-date").value = d;
  fillForm(d);
  window.scrollTo({top:0, behavior:"smooth"});
}

function renderTrend(){
  const box = document.getElementById("trendBox");
  const days = [];
  for(let i=13;i>=0;i--){ const d = addDays(TODAY,-i); days.push({date:d, rec:DB.days[d]}); }
  const maxH = Math.max(4, ...days.map(x=>x.rec?(x.rec.hours||0):0));
  const total = days.reduce((s,x)=>s+(x.rec?(x.rec.hours||0):0),0);
  const recorded = days.filter(x=>x.rec).length;

  let bars = `<div class="trend-wrap">`;
  days.forEach(x=>{
    const h = x.rec ? (x.rec.hours||0) : 0;
    const pct = Math.max(2, h / maxH * 100);
    const isToday = x.date === TODAY;
    const cls = !x.rec ? "zero" : (h > 5 ? "high" : "");
    bars += `<div class="trend-col">
      <div class="trend-val">${x.rec?(h||0).toFixed(1):""}</div>
      <div class="trend-bar ${cls} ${isToday?'today':''}" style="height:${pct}%" title="${x.date} · ${h}h"></div>
    </div>`;
  });
  bars += `</div><div class="trend-x">`;
  days.forEach(x=>{ bars += `<div>${fmtMD(x.date)}</div>`; });
  bars += `</div>`;

  box.innerHTML = `<div class="stat-grid" style="margin-bottom:4px">
      <div class="stat"><div class="k">14 天总投入</div><div class="v">${total.toFixed(1)}<small>h</small></div><div class="d">日均 ${(total/14).toFixed(1)}h</div></div>
      <div class="stat"><div class="k">打卡天数</div><div class="v">${recorded}<small>/14</small></div><div class="d">${Math.round(recorded/14*100)}%</div></div>
      <div class="stat"><div class="k">折算周均</div><div class="v">${recorded?(total/recorded*7).toFixed(1):"0"}<small>h</small></div><div class="d">对比预算 ${PLAN.weeklyBudget}h</div></div>
    </div>${bars}
    <div class="note note-line"><span class="legend"><i class="sw"></i>灰柱 = 当天没打卡</span><button class="info" data-tip="空白不等于没学，但也不进任何分析；记录断档时所有建议退回「未知」，不替你补数字。" aria-label="空白不等于没学，但也不进任何分析；记录断档时所有建议退回「未知」，不替你补数字。"></button></div>`;
}

function renderWeekArchive(){
  const box = document.getElementById("weekArchive");
  const ws = Object.keys(DB.weeks).sort().reverse();
  if(!ws.length){ box.innerHTML = `<div class="empty"><b>还没有周复盘</b>周日晚花 30 分钟填一次，两周后就能看出趋势。</div>`; return; }
  box.innerHTML = ws.map(w=>{
    const r = DB.weeks[w];
    return `<div class="wk-item">
      <div class="wk-head">
        <b>${fmtMD(w)} – ${fmtMD(addDays(w,6))}</b>
        <span class="pill ${r.reason==='none'?'ok':'w'}">${labelReason(r.reason)}</span>
      </div>
      <div class="wk-line"><span>投入</span>${esc(r.hours)||"—"}</div>
      ${r.progress?`<div class="wk-line"><span>进展</span>${esc(r.progress)}</div>`:""}
      ${r.blocker?`<div class="wk-line"><span>卡点</span>${esc(r.blocker)}</div>`:""}
      ${r.next?`<div class="wk-line"><span>下周</span>${esc(r.next)}</div>`:""}
    </div>`;
  }).join("");
}

/* ══════════ 节点 ══════════ */
function renderMilestones(){
  const items = [];
  PLAN.milestones.forEach(m=>items.push({date:m.date, title:m.title, meta:m.type, left:daysBetween(TODAY,m.date)}));
  PLAN.courses.forEach(c=>{
    items.push(c.exam
      ? {date:c.exam, title:c.name+" 期末", meta:`${c.slot} · ${c.status}`, left:daysBetween(TODAY,c.exam)}
      : {date:null, title:c.name+" 期末", meta:c.slot, left:null});
  });
  items.sort((a,b)=>{
    if(!a.date) return 1;
    if(!b.date) return -1;
    return a.date.localeCompare(b.date);
  });

  document.getElementById("msList").innerHTML = `<div class="timeline">` + items.map(it=>{
    let cls = "";
    if(it.left !== null){
      if(it.left < 0) cls = "past";
      else if(it.left <= 7) cls = "hot";
      else if(it.left <= 30) cls = "soon";
    }
    const lt = it.left === null ? "日期未知" : (it.left < 0 ? `已过 ${-it.left} 天` : `还有 ${it.left} 天`);
    return `<div class="tl-item ${cls}">
      <div class="dt">${it.date ? fmtMD(it.date) : "——"} · ${lt}</div>
      <div class="tt">${it.title}</div>
      <div class="meta">${it.meta}</div>
    </div>`;
  }).join("") + `</div>`;

  const noExam = PLAN.courses.filter(c=>!c.exam);
  const orderNote = noExam.length
    ? `<div class="note">补齐顺序：先查 ${noExam.map(c=>`<b>${c.name}</b>`).join("、")} 的考期与考核方式（可能是最早截止的大作业），其余在周复盘里慢慢填。</div>`
    : "";
  document.getElementById("gapList").innerHTML =
    `<ul class="plain">${PLAN.gaps.map(g=>`<li>${g}</li>`).join("")}</ul>` + orderNote;
}

/* ══════════ 导航 ══════════ */
function switchTab(name){
  // 在「功能选择」里被关掉的页签不接受跳转，否则会切到一个空白页
  const target = document.querySelector('.tabs button[data-tab="'+name+'"]');
  if(target && target.classList.contains("hidden")) return;
  // 已经在这一页就别重绘：否则重复点会把进场动画重播一遍，看着像闪了一下
  const cur = document.querySelector(".tabs button.on");
  if(cur && cur.dataset.tab === name) return;
  const btns = document.querySelectorAll(".tabs button");
  Array.prototype.forEach.call(btns, b=>{
    const on = b.dataset.tab === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  Array.prototype.forEach.call(document.querySelectorAll(".panel"), p=>{
    p.classList.toggle("on", p.id === "panel-"+name);
  });
  if(name === "asg") renderAsg();
  if(name === "week"){ renderWeek(); renderDebt(); renderWeekReview(weekStartOf(TODAY)); }
  if(name === "history"){ renderTrend(); renderHistory(); renderWeekArchive(); }
  if(name === "milestones") renderMilestones();
  if(name === "plan") renderPlanForm();
  // 设置页每次进入都按当前方案重画一次，免得显示的是上一次打开时的旧值
  if(name === "settings"){ renderProfileForm(); renderUiForm(); setHint("profileHint",""); }
}

/* 点击页签时给一次闪一下的反馈：滑块撤掉之后，按下去得有个回应，
   否则「我点到了没有」全靠猜。动画结束自己把类摘掉，不残留状态。 */
function flashTab(btn){
  if(!btn) return;
  btn.classList.remove("tap");
  void btn.offsetWidth;            // 强制重排，连点同一页时动画才会重新播
  btn.classList.add("tap");
  const off = ()=>{ btn.classList.remove("tap"); btn.removeEventListener("animationend", off); };
  btn.addEventListener("animationend", off);
}

/* ══════════ 我的方案（公用部分里唯一由使用者填写的地方） ══════════
   写回 private/profile.json；里程碑、周任务、缺口不在表单里，由助手维护，服务端会保留。
*/
function planVal(id){ const el = document.getElementById(id); return el ? el.value.trim() : ""; }
function planNum(id){ const s = planVal(id); return s === "" ? null : Number(s); }
function planHint(msg){
  const el = document.getElementById("planHint");
  if(el) el.textContent = msg;
}

function renderPlanForm(){
  const box = document.getElementById("planForm");
  if(!box) return;
  const p = PLAN || {};
  const n = p.nodes || {};
  const f = FOCUS;
  // 表单显示使用者「原样存了什么」，不要显示兜底值——否则会以为是自己填的
  const rawFocus = (p.focus && typeof p.focus === "object") ? p.focus
    : (p.cet && typeof p.cet === "object") ? p.cet : {};
  const rawUnits = (rawFocus.units && typeof rawFocus.units === "object") ? rawFocus.units : {};
  const locked = window.__AUTH__ === false;
  const courses = Array.isArray(p.courses) ? p.courses : [];

  const rows = courses.map((co,i)=>`
    <div class="plan-row" data-i="${i}">
      <input class="pi-name" value="${esc(co.name || co.full || "")}" placeholder="课程名">
      <input class="pi-exam" type="date" value="${co.exam || ""}">
      <input class="pi-slot" value="${esc(co.slot || "")}" placeholder="时段（可空）">
      <button class="btn sm ghost pi-del" type="button" aria-label="删除这门课">删</button>
    </div>`).join("");

  // 个人资料（姓名/学校/专业/年级/学期/目标）已经挪到「设置」页统一管理，这一页只留学习安排本身
  box.innerHTML = `
    <div class="note note-line" style="margin:0 0 12px">
      这一页只填<b>学习安排</b>，个人资料与显示开关在「设置」页
      <button class="info" data-tip="姓名、学校、专业、年级、学习目标属于个人资料；显示哪些页签与模块也在那里选。两边都没有预置值。" aria-label="姓名、学校、专业、年级、学习目标属于个人资料；显示哪些页签与模块也在那里选。两边都没有预置值。"></button>
    </div>
    <div class="grid2">
      <div class="field"><label for="p-budget">每周课外预算（小时）</label><input id="p-budget" type="number" min="0" max="80" step="0.5" value="${p.weeklyBudget!=null?p.weeklyBudget:""}"></div>
      <div class="field"><label for="p-target">单科目标分</label><input id="p-target" type="number" min="0" max="100" step="1" value="${p.courseTarget!=null?p.courseTarget:""}"></div>
      <div class="field"><label for="p-anchor">开学第一周的周一</label><input id="p-anchor" type="date" value="${p.weekAnchor||""}"></div>
      <div class="field"><label for="p-anchorno">那一周是第几教学周</label><input id="p-anchorno" type="number" min="1" max="30" step="1" value="${p.weekAnchorNo||1}"></div>
    </div>

    <div class="field">
      <label>课程（课程名 / 考试日期 / 时段）</label>
      <div id="planCourses">${rows || '<p class="hint" style="margin:0 0 8px">还没有课程，点下面「加一门课」。</p>'}</div>
      <button class="btn sm ghost" type="button" id="planAddCourse">加一门课</button>
    </div>

    <div class="hr"></div>
    <h2>专项 <span class="tag">可选</span></h2>
    <p class="hint">课程之外要推的那一条线，<b>名称留空 = 不启用</b><button class="info" data-tip="四六级、考研单科、计算机二级、教资、法考、竞赛题库、作品集都行。三个计数器的名字自己定，例如「单词 / 精听 / 真题」「题量 / 错题 / 模考」。" aria-label="四六级、考研单科、计算机二级、教资、法考、竞赛题库、作品集都行。三个计数器的名字自己定，例如「单词 / 精听 / 真题」「题量 / 错题 / 模考」。"></button></p>

    <div class="grid2">
      <div class="field"><label for="p-focuslabel">专项名称</label><input id="p-focuslabel" value="${esc(f.label||"")}" placeholder="例如 四级 / 考研数学 / 计算机二级（留空=不启用）"></div>
      <div class="field"><label for="p-focusdate">考期 / 截止日期</label><input id="p-focusdate" type="date" value="${f.date||""}"></div>
      <div class="field"><label for="p-focustarget">目标分（可空）</label><input id="p-focustarget" type="number" min="0" step="1" value="${f.target!=null?f.target:""}"></div>
      <div class="field"><label for="p-focusmax">分数上限（可空，如 710 / 150）</label><input id="p-focusmax" type="number" min="0" step="1" value="${f.scoreMax!=null?f.scoreMax:""}"></div>
      <div class="field"><label for="p-focustime">考试时间（可空）</label><input id="p-focustime" value="${esc(f.time||"")}" placeholder="例如 15:00–17:25"></div>
      <div class="field"><label for="p-focusdur">单次计时时长（可空）</label><input id="p-focusdur" value="${esc(f.duration||"")}" placeholder="例如 2h25min / 3h"></div>
    </div>

    <div class="grid3">
      <div class="field"><label for="p-unitA">计数一 · 名称与周目标</label>
        <div class="row" style="gap:8px">
          <input id="p-unitA" value="${esc(rawUnits.words||"")}" placeholder="例：单词 / 题量">
          <input id="p-goalA" type="number" min="0" step="10" placeholder="周目标" value="${f.goals.words||""}">
        </div>
      </div>
      <div class="field"><label for="p-unitB">计数二 · 名称与周目标</label>
        <div class="row" style="gap:8px">
          <input id="p-unitB" value="${esc(rawUnits.listen||"")}" placeholder="例：精听 / 错题复盘">
          <input id="p-goalB" type="number" min="0" step="1" placeholder="周目标" value="${f.goals.listen||""}">
        </div>
      </div>
      <div class="field"><label for="p-unitC">计数三 · 名称与周目标</label>
        <div class="row" style="gap:8px">
          <input id="p-unitC" value="${esc(rawUnits.paper||"")}" placeholder="例：真题 / 模考">
          <input id="p-goalC" type="number" min="0" step="1" placeholder="周目标" value="${f.goals.paper||""}">
        </div>
      </div>
    </div>

    <div class="grid2">
      <div class="field"><label for="p-examstart">考试周起始</label><input id="p-examstart" type="date" value="${n.examWindowStart||""}"></div>
      <div class="field"><label for="p-mentor">外部节点（材料 / 申请 / 提交）</label><input id="p-mentor" type="date" value="${n.mentorMail||""}"></div>
    </div>

    <div class="row" style="gap:8px;margin-top:4px">
      <button class="btn" type="button" id="planSave">保存方案</button>
      <button class="btn ghost" type="button" id="planReload">放弃修改</button>
    </div>
    ${locked ? '<p class="hint" style="color:var(--bad);margin-top:10px">当前没有读取私有数据的权限：用带口令的链接打开，或确认本地服务在运行。</p>' : ""}
  `;

  box.querySelectorAll(".pi-del").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const row = btn.closest(".plan-row");
      if(row) row.remove();
    });
  });
  const addBtn = document.getElementById("planAddCourse");
  if(addBtn) addBtn.addEventListener("click", ()=>{
    const wrap = document.getElementById("planCourses");
    const empty = wrap.querySelector("p.hint");
    if(empty) empty.remove();
    const div = document.createElement("div");
    div.className = "plan-row";
    div.innerHTML = '<input class="pi-name" placeholder="课程名"><input class="pi-exam" type="date"><input class="pi-slot" placeholder="时段（可空）"><button class="btn sm ghost pi-del" type="button">删</button>';
    div.querySelector(".pi-del").addEventListener("click", ()=>div.remove());
    wrap.appendChild(div);
  });
  const saveBtn = document.getElementById("planSave");
  if(saveBtn) saveBtn.addEventListener("click", savePlan);
  const reloadBtn = document.getElementById("planReload");
  if(reloadBtn) reloadBtn.addEventListener("click", renderPlanForm);

  const ms = document.getElementById("planMilestoneCount");
  if(ms) ms.textContent = (p.milestones||[]).length;
  const gp = document.getElementById("planGapCount");
  if(gp) gp.textContent = (p.gaps||[]).length;
  planHint(locked ? "只读" : "");
}

function savePlan(){
  const rows = [...document.querySelectorAll("#planCourses .plan-row")];
  const courses = rows.map((r,i)=>({
    id: (PLAN.courses && PLAN.courses[i] && PLAN.courses[i].id) || ("c" + (i+1)),
    name: (r.querySelector(".pi-name").value || "").trim(),
    full: (r.querySelector(".pi-name").value || "").trim(),
    exam: r.querySelector(".pi-exam").value || null,
    slot: (r.querySelector(".pi-slot").value || "").trim(),
    status: "使用者填写"
  })).filter(c=>c.name);

  if(!courses.length){
    toast("至少填一门课，否则分析规则没有对象", "warn");
    const first = document.querySelector("#planCourses .pi-name");
    if(first) fxInvalid(first, true);
    fxFlash(document.getElementById("planSave"), "err");
    return;
  }

  // meta 不从这里写：个人资料统一在「设置」页保存，避免两处表单互相覆盖
  const profile = {
    weeklyBudget: planNum("p-budget") == null ? 15 : planNum("p-budget"),
    courseTarget: planNum("p-target"),
    weekAnchor: planVal("p-anchor") || null,
    weekAnchorNo: planNum("p-anchorno") || 1,
    courses,
    // 专项完全由使用者定义：名称、考期、分数、三个计数器的名字与周目标。
    // 名称留空就是「不启用」，focusOf 会把 enabled 算成 false，界面自动收起这一栏。
    focus: {
      label: planVal("p-focuslabel"),
      date: planVal("p-focusdate") || null,
      target: planNum("p-focustarget"),
      scoreMax: planNum("p-focusmax"),
      time: planVal("p-focustime"),
      duration: planVal("p-focusdur"),
      units: {
        words: planVal("p-unitA"),
        listen: planVal("p-unitB"),
        paper: planVal("p-unitC")
      },
      goals: {
        words: planNum("p-goalA") || 0,
        listen: planNum("p-goalB") || 0,
        paper: planNum("p-goalC") || 0
      }
    },
    nodes: {
      examWindowStart: planVal("p-examstart") || null,
      mentorMail: planVal("p-mentor") || null
    }
  };

  const saveBtn = document.getElementById("planSave");
  if(!API){
    planHint("未保存");
    toast("当前是本地打开，没有服务端，方案存不进去", "warn");
    fxFlash(saveBtn, "err");
    return;
  }
  planHint("保存中…");
  fxBusy(saveBtn, true);
  fetch("api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile })
  }).then(r=> r.json().then(j=>({ ok: r.ok, j }))).then(({ ok, j })=>{
    if(!ok || !j.ok) throw j || { reason: "failed" };
    Object.assign(PLAN, profile);
    PLAN.meta = Object.assign({}, PLAN.meta, profile.meta);
    delete PLAN.cet;                       // 旧键不留在内存里，避免两套配置并存
    FOCUS = focusOf(PLAN);
    Object.keys(CNAME).forEach(k=>delete CNAME[k]);
    (PLAN.courses||[]).forEach(c=>CNAME[c.id] = c.name);
    toast("方案已保存：课程、考期、专项与标题栏都已更新");
    renderPlanForm();            // 表单会整体重绘，所以确认反馈要打在重绘之后
    planHint("已保存");
    renderBrand();
    renderFocusForm();
    renderStrip(); renderWeek(); renderHistory(); renderMilestones();
    fxFlash(document.getElementById("planSave"), "ok");
  }).catch(e=>{
    planHint("未保存");
    toast(e && e.reason === "unauthorized" ? "没有权限：请用带口令的链接打开" : "保存失败，确认本地服务在运行", "warn");
    fxFlash(saveBtn, "err");
  }).finally(()=>fxBusy(saveBtn, false));
}

/* ══════════ 设置：个人资料 + 功能选择 ══════════
   两件事放一起，是因为性质相同：都是「使用者决定它长什么样」，系统只负责照办。
   资料写 profile.meta，开关写 profile.ui，都走 /api/profile 合并回 private/profile.json。
   没有一项是代码里预置的：留空就是留空，不会出现「默认值假装是你填的」。 */

function setHint(id, msg, state){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = msg || "";
  el.dataset.state = state || "";
}

function profileFail(e, hintId, btn){
  setHint(hintId, "未保存", "dirty");
  toast(e && e.reason === "unauthorized" ? "没有权限：请用带口令的链接打开" : "保存失败，确认本地服务在运行", "warn");
  if(btn) fxFlash(btn, "err");
}

function postProfile(patch){
  return fetch("api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile: patch })
  }).then(r => r.json().then(j => ({ ok: r.ok, j })));
}

function renderProfileForm(){
  const box = document.getElementById("profileForm");
  if(!box) return;
  const m = (PLAN && PLAN.meta) || {};
  box.innerHTML = `
    <div class="grid2">
      <div class="field"><label for="m-owner">姓名 / 昵称</label><input id="m-owner" value="${esc(m.owner||"")}" placeholder="你怎么称呼自己（可空）"></div>
      <div class="field"><label for="m-school">学校</label><input id="m-school" value="${esc(m.school||"")}" placeholder="例如 ××大学（可空）"></div>
      <div class="field"><label for="m-major">专业</label><input id="m-major" value="${esc(m.major||"")}" placeholder="任何专业（可空）"></div>
      <div class="field"><label for="m-grade">年级</label><input id="m-grade" value="${esc(m.grade||"")}" placeholder="例如 大一 / 大三 / 研一"></div>
      <div class="field" style="grid-column:1/-1"><label for="m-semester">学期</label><input id="m-semester" value="${esc(m.semester||"")}" placeholder="例如 2026 秋（或 2026-2027 第 1 学期）"></div>
    </div>
    <div class="field">
      <label for="m-goal">学习目标（可选）</label>
      <textarea id="m-goal" rows="3" placeholder="例：这学期把三门课推到「能做题」，顺便把 ×× 考下来。留空就不显示。">${esc(m.goal||"")}</textarea>
    </div>
    <label class="row" style="gap:8px;align-items:center;margin:-2px 0 6px">
      <input type="checkbox" id="m-showid" ${m.showIdentity === true ? "checked" : ""}>
      <span style="font-size:12.5px">在标题栏显示「学校 · 专业 · 年级 · 学期」</span>
    </label>
    <p class="hint" style="margin:0 0 6px">只是给自己看的备注，规则不会因为学校或专业不同而有区别<button class="info" data-tip="默认不显示；填了但不勾选，标题栏上也不会出现。" aria-label="默认不显示；填了但不勾选，标题栏上也不会出现。"></button></p>`;
}

function saveProfile(){
  const btn = document.getElementById("profileSave");
  const meta = {
    owner: planVal("m-owner"),
    school: planVal("m-school"),
    major: planVal("m-major"),
    grade: planVal("m-grade"),
    semester: planVal("m-semester"),
    goal: (document.getElementById("m-goal") || {}).value || "",
    // 身份备注默认不往页面上摆；要用的人自己勾
    showIdentity: !!(document.getElementById("m-showid") || {}).checked
  };
  if(!API){
    setHint("profileHint", "未保存", "dirty");
    toast("当前是本地打开，没有服务端，资料存不进去", "warn");
    fxFlash(btn, "err");
    return;
  }
  setHint("profileHint", "保存中…");
  fxBusy(btn, true);
  postProfile({ meta }).then(({ ok, j })=>{
    if(!ok || !j.ok) throw j || { reason: "failed" };
    PLAN.meta = Object.assign({}, PLAN.meta, meta);
    renderBrand();
    renderGoalNote();
    setHint("profileHint", "已保存", "ok");
    toast("个人资料已保存");
    fxFlash(btn, "ok");
  }).catch(e=>profileFail(e, "profileHint", btn)).finally(()=>fxBusy(btn, false));
}

/** 学习目标：填了就挂在打卡页顶上，每次打开提醒自己一次；没填就整条不出现 */
function renderGoalNote(){
  const el = document.getElementById("goalNote");
  if(!el) return;
  const goal = String(((PLAN && PLAN.meta) || {}).goal || "").trim();
  if(!goal){ el.classList.add("hidden"); el.textContent = ""; return; }
  el.classList.remove("hidden");
  el.innerHTML = `<b>这学期你想做到的事：</b><span style="white-space:pre-wrap">${esc(goal)}</span>`;
}

/* 功能选择：勾选框由 core/domain/ui.js 的清单渲染，加新的可关项只需要改那一个文件 */
function pickRows(list, prefix, cur){
  return list.map(x=>`
    <label class="pick-row">
      <input type="checkbox" id="${prefix}-${x.id}" ${cur[x.id] !== false ? "checked" : ""}>
      <span class="pick-txt"><b>${esc(x.name)}</b><i>${esc(x.desc)}</i></span>
    </label>`).join("");
}

function renderUiForm(){
  const tb = document.getElementById("uiTabList");
  const mb = document.getElementById("uiModList");
  if(tb) tb.innerHTML = pickRows(TABS, "uit", UI.tabs);
  if(mb) mb.innerHTML = pickRows(MODULES, "uim", UI.modules);
}

function collectUi(){
  const tabs = {}, modules = {};
  TABS.forEach(t=>{ const el = document.getElementById("uit-"+t.id); tabs[t.id] = el ? el.checked : true; });
  MODULES.forEach(m=>{ const el = document.getElementById("uim-"+m.id); modules[m.id] = el ? el.checked : true; });
  return { tabs, modules };
}

/**
 * 按当前 UI 开关重排页面：收起页签、收起模块，并重画所有受影响的地方。
 * 调用时机：初始化、拉取到新方案后、功能选择保存后——只要开关可能变了都要跑。
 */
function applyUI(){
  UI = uiOf(PLAN);
  // 另一台设备改过主题：拉到新方案后跟着换（同一个入口，不另写一套）
  const pTheme = (PLAN.appearance || {}).theme;
  if(isTheme(pTheme) && pTheme !== themeNow()) applyTheme(pTheme);
  TABS.forEach(t=>{
    const btn = document.querySelector('.tabs button[data-tab="'+t.id+'"]');
    if(btn) btn.classList.toggle("hidden", !tabOn(t.id));
    const panel = document.getElementById("panel-"+t.id);
    if(panel) panel.classList.toggle("hidden", !tabOn(t.id));
  });
  // 模块级开关：打卡页里那几块，连带标题一起收
  const vis = (id, v)=>{ const el = document.getElementById(id); if(el) el.classList.toggle("hidden", !v); };
  vis("sleepField", modOn("sleep"));
  vis("blockerField", modOn("blocker"));
  vis("courseProgressBlock", modOn("courseProgress"));

  // 停在被关掉的页上就换个地方待着；全关了（可以这么选）就停在设置页
  const cur = document.querySelector(".tabs button.on:not(.hidden)");
  if(!cur){
    const first = TABS.filter(t=>tabOn(t.id))[0];
    switchTab(first ? first.id : "settings");
  }
  renderStrip(); renderBrief(); renderFocusForm(); renderWeek(); renderDebt(); renderHistory(); renderMilestones();
}

function saveUi(){
  const btn = document.getElementById("uiSave");
  const ui = collectUi();
  // 先当次立即改好：开关的含义是「现在就别再出现」，不该等一次网络往返
  PLAN.ui = ui;
  applyUI();
  renderUiForm();
  setHint("uiHint", "已按新设置重排页面", "dirty");
  if(!API){
    setHint("uiHint", "页面已改 · 没写入文件", "dirty");
    toast("当前是本地打开，没有服务端，刷新后会回到原样", "warn");
    fxFlash(btn, "err");
    return;
  }
  fxBusy(btn, true);
  postProfile({ ui }).then(({ ok, j })=>{
    if(!ok || !j.ok) throw j || { reason: "failed" };
    UI = uiOf(PLAN);
    applyUI();
    setHint("uiHint", "已保存并生效", "ok");
    toast("显示设置已保存");
    fxFlash(btn, "ok");
  }).catch(e=>{
    profileFail(e, "uiHint", btn);
  }).finally(()=>fxBusy(btn, false));
}

/* ══════════ 外观主题 ══════════
   四套配色、一套骨架：主题只改 CSS 令牌，不改任何结构/尺寸选择器，
   所以换主题不会引起一次重排，页签位置、卡片高度、图表柱宽全都不动。

   落盘写 profile.appearance.theme（跟别的设置一样走 /api/profile 合并写）；
   另外镜像一份到 localStorage，只为让 <head> 里的内联脚本在首屏绘制前把主题摆好——
   否则每次打开都会先闪一下默认配色。读的时候方案优先，本机记忆只是兜底。 */
const THEME_KEY = "ledger.theme";

/* <head> 里那两条 theme-color 的原始值（默认主题要还原，别把系统明暗判断改坏了） */
const THEME_META = Array.prototype.map.call(
  document.querySelectorAll('meta[name="theme-color"]'),
  m => ({ el: m, content: m.getAttribute("content") })
);

function localTheme(){
  try{ const v = localStorage.getItem(THEME_KEY); return isTheme(v) ? v : null; }catch(e){ return null; }
}
/** 页面上当前生效的主题 */
function themeNow(){
  const cur = document.documentElement.dataset.theme;
  return isTheme(cur) ? cur : DEFAULT_THEME;
}

/** 只负责把主题摆上去（缩略图、浏览器主题色一起跟上），不落盘 */
function applyTheme(id){
  const t = themeDef(id);
  document.documentElement.dataset.theme = t.id;
  try{ localStorage.setItem(THEME_KEY, t.id); }catch(e){}
  // 地址栏颜色：默认主题跟着系统明暗走（两套原值），其余主题是固定配色，两条都改成同一个色
  THEME_META.forEach(m=>{
    m.el.setAttribute("content", t.id === DEFAULT_THEME ? m.content : t.swatch.bg);
  });
  renderThemeList();
  return t;
}

/**
 * 统一切换入口：本地立即生效，再写文件。
 * 设置页点选、键盘选择、拉到别的设备的方案，都走这一个函数，
 * 所以「什么时候生效」「什么时候落盘」「失败怎么提示」只有一套说法。
 */
function setTheme(id){
  if(!isTheme(id)) return;
  if(themeNow() === id){ renderThemeList(); return; }
  const t = applyTheme(id);
  PLAN.appearance = Object.assign({}, PLAN.appearance, { theme: t.id });
  if(!API){
    setHint("themeHint", "已切换 · 只在本机浏览器", "dirty");
    toast("已切换到「" + t.name + "」（存在本机浏览器）");
    return;
  }
  setHint("themeHint", "写入中…");
  postProfile({ appearance: { theme: t.id } }).then(({ ok, j })=>{
    if(!ok || !j.ok) throw j || { reason: "failed" };
    setHint("themeHint", "已保存", "ok");
    toast("已切换到「" + t.name + "」，换设备打开也是这套");
  }).catch(()=>{
    setHint("themeHint", "只在本机生效 · 没写进文件", "dirty");
    toast("主题已切换，但没写进 profile.json：下次打开可能回到原来那套", "warn");
  });
}

function renderThemeList(){
  const box = document.getElementById("themeList");
  if(!box) return;
  const cur = themeNow();
  box.innerHTML = THEMES.map(t=>{
    const on = t.id === cur;
    return `<button type="button" class="theme-row${on ? " on" : ""}" data-theme-id="${t.id}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}">
      <span class="theme-sw" aria-hidden="true" style="--sw-bg:${t.swatch.bg};--sw-paper:${t.swatch.paper};--sw-accent:${t.swatch.accent};--sw-tex:url('${t.tex}')"></span>
      <span class="theme-txt"><b>${esc(t.name)}</b><i>${esc(t.desc)}</i></span>
    </button>`;
  }).join("");
}

/* 口令失效或没带口令时，顶部给一条明确提示，而不是静悄悄显示空数据 */
function renderAuth(){
  const bar = document.getElementById("authBar");
  if(!bar) return;
  if(window.__AUTH__ !== false){ bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.innerHTML = '<div class="bb-head">没有权限读取私有数据</div>' +
    '<div class="bb-body">这个页面是公用的，方案与记录在 <b>private/</b> 里，需要口令。请用带 <b>?k=</b> 的链接打开一次，浏览器会记住；或者确认本地服务正在运行。</div>';
}

let toastTimer;
function toast(msg, type){
  const t = document.getElementById("toast");
  if(!t) return;
  const was = t.classList.contains("show");
  t.textContent = msg;
  t.dataset.type = type || (/失败|错|离线|不能|请先/.test(msg) ? "warn" : "ok");
  t.classList.remove("show");
  // 连发时：已经在显示就只顶一下；否则重新进场（同时让底部进度条从头走）
  void t.offsetWidth;
  t.classList.add("show");
  if(was){
    t.classList.remove("bump");
    void t.offsetWidth;
    t.classList.add("bump");
    clearTimeout(t._bump);
    t._bump = setTimeout(()=>t.classList.remove("bump"), 220);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove("show"), 2800);
}

/* ══════════ 悬停说明（data-tip） ══════════
   页面上只留一个符号，完整解释放在 data-tip 里：
     · 鼠标悬停 110ms 后展开，移开即收；
     · 键盘 Tab 聚焦也会展开（.info 是 button，天然可聚焦），Esc 收起；
     · 触屏没有 hover，改成点一下展开、3.2 秒后自动收。
   单例 + fixed 定位，所以不会被吸顶页签条或 overflow 容器裁掉；
   文字内容同时写在 aria-label 上，读屏用户不依赖这个浮层。 */
let tipEl = null, tipTimer = 0, tipAnchor = null;

function tipBuild(){
  if(tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.id = "tip";
  tipEl.setAttribute("role", "tooltip");
  document.body.appendChild(tipEl);
  return tipEl;
}
function tipPlace(anchor){
  const el = tipBuild();
  const r = anchor.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  const gap = 8, pad = 10;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(pad, Math.min(left, innerWidth - t.width - pad));
  let top = r.bottom + gap;                       // 默认放下面：上面的位置常被吸顶页签条占着
  if(top + t.height > innerHeight - pad) top = Math.max(pad, r.top - t.height - gap);
  el.style.left = Math.round(left) + "px";
  el.style.top = Math.round(top) + "px";
}
function tipShow(anchor){
  const text = anchor && anchor.getAttribute("data-tip");
  if(!text) return;
  clearTimeout(tipTimer);
  tipAnchor = anchor;
  const el = tipBuild();
  el.textContent = text;
  el.classList.add("on");
  tipPlace(anchor);          // 先定位再显示，避免从 (0,0) 飞过来
}
function tipHide(){
  clearTimeout(tipTimer);
  if(tipAnchor && tipAnchor.blur && document.activeElement === tipAnchor) { /* 保持聚焦提示 */ }
  tipAnchor = null;
  if(tipEl) tipEl.classList.remove("on");
}
const tipFind = (node) => (node && node.closest ? node.closest("[data-tip]") : null);

document.addEventListener("pointerover", e=>{
  const a = tipFind(e.target);
  if(!a || a === tipAnchor) return;
  if(e.pointerType === "touch") return;      // 触屏走 click
  clearTimeout(tipTimer);
  tipTimer = setTimeout(()=>tipShow(a), 110);
});
document.addEventListener("pointerout", e=>{
  const a = tipFind(e.target);
  if(!a) return;
  if(e.relatedTarget && a.contains(e.relatedTarget)) return;
  tipHide();
});
document.addEventListener("focusin", e=>{
  const a = tipFind(e.target);
  if(a) tipShow(a);
});
document.addEventListener("focusout", ()=>tipHide());
document.addEventListener("click", e=>{
  const a = tipFind(e.target);
  if(!a) return;
  if(!matchMedia("(hover:none)").matches) return;
  tipShow(a);
  clearTimeout(tipTimer);
  tipTimer = setTimeout(tipHide, 3200);
});
addEventListener("scroll", ()=>tipHide(), true);
addEventListener("resize", ()=>tipHide());
document.addEventListener("keydown", e=>{ if(e.key === "Escape") tipHide(); });

/* ══════════ 交互反馈：等待 / 成功 / 失败 ══════════
   页面里所有异步动作都走这三招，别各写一套：
     fxBusy(el,bool)   —— 按钮底部跑像素进度带，期间点不动
     fxFlash(el,kind)  —— 成功绿环 / 失败红环 + 抖两下
     fxInvalid(el,bool)—— 字段红框，用户一改就自动清
*/
function fxBusy(el, on){
  if(!el) return;
  el.classList.toggle("is-busy", !!on);
  if(on) el.setAttribute("aria-busy", "true"); else el.removeAttribute("aria-busy");
}
function fxFlash(el, kind){
  if(!el) return;
  el.classList.remove("flash-ok", "flash-err");
  void el.offsetWidth;                     // 强制回流，连续触发也能重播
  el.classList.add(kind === "err" ? "flash-err" : "flash-ok");
  clearTimeout(el._fx);
  el._fx = setTimeout(()=>el.classList.remove("flash-ok", "flash-err"), 700);
}
function fxInvalid(el, on){
  if(!el) return;
  el.classList.toggle("is-invalid", !!on);
  if(on){ el.setAttribute("aria-invalid", "true"); el.focus({ preventScroll: true }); }
  else el.removeAttribute("aria-invalid");
}
/* 字段类控件一旦被改动，红框自己消失，不用用户去猜 */
document.addEventListener("input", e=>{
  const t = e.target;
  if(t && t.classList && t.classList.contains("is-invalid")) fxInvalid(t, false);
}, true);
/* 点击成功后的按钮，顺带把焦点还给用户按的那个，键盘操作不丢位置 */

/* ══════════ 今晚提醒：由定时任务写入同目录 brief.js ══════════ */
function copyText(t, okMsg){
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(
      ()=>toast(okMsg),
      ()=>fallbackCopyRaw(t, okMsg)
    );
  }else fallbackCopyRaw(t, okMsg);
}
function fallbackCopyRaw(t, okMsg){
  const ta = document.createElement("textarea");
  ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand("copy"); toast(okMsg); }
  catch(e){ window.prompt("浏览器拦了自动复制，按 Ctrl+C 复制下面这段：", t); }
  document.body.removeChild(ta);
}
function renderBrief(){
  const bar = document.getElementById("briefBar");
  if(!bar) return;
  // 模块关掉了就别再冒出来：这是页面级开关，与「有没有提醒内容」无关
  if(!modOn("brief")){ bar.classList.add("hidden"); return; }
  const b = window.__BRIEF__;
  // 只认当天的提醒；日期对不上就不显示，避免第二天早上打开看到昨晚的旧内容
  if(!b || !b.text || (b.date && b.date !== TODAY)){
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = "";
  const head = document.createElement("div"); head.className = "bb-head";
  const t = document.createElement("div"); t.className = "bb-t";
  t.textContent = "今晚的提醒 · " + fmtCn(b.date || TODAY);
  const acts = document.createElement("div"); acts.className = "bb-acts";
  const cbtn = document.createElement("button");
  cbtn.className = "btn sm ghost"; cbtn.textContent = "复制今日记录";
  cbtn.onclick = copyTodayRecord;
  const x = document.createElement("button");
  x.className = "bb-x"; x.textContent = "×"; x.title = "关掉这条提醒"; x.setAttribute("aria-label","关掉这条提醒");
  x.onclick = ()=>bar.classList.add("hidden");
  acts.appendChild(cbtn); acts.appendChild(x);
  head.appendChild(t); head.appendChild(acts);
  const body = document.createElement("div");
  body.className = "bb-body";
  body.textContent = b.text;   // 纯文本渲染，不解析 HTML
  bar.appendChild(head); bar.appendChild(body);
}
function copyTodayRecord(){
  const rec = DB.days[TODAY];
  if(!rec){ toast("今天还没保存，先点「保存并分析」", "warn"); return; }
  const o = {}; o[TODAY] = rec;
  copyText(JSON.stringify(o, null, 2), "已复制，粘到对话里我就能写进 records.json");
}

/* ══════════ 初始化 ══════════ */
(function init(){
  load();
  // 课程数来自方案配置，不在页面里写死
  const tag = document.getElementById("asgCourseTag");
  if(tag) tag.textContent = PLAN.courses.length ? `${PLAN.courses.length} 门课` : "未配置课程";
  if(window.__PLAN_SOURCE__ === "default"){
    // 用的是公用占位配置：明确告诉使用者这里是"待填"，而不是"系统认为你就这些课"
    const hint = document.createElement("div");
    hint.className = "note";
    hint.style.margin = "0 0 12px";
    hint.innerHTML = "当前是公用占位配置（课程一 / 课程二…）。填「我的方案」或改 <b>private/profile.json</b> 就会换成你自己的。";
    const first = document.getElementById("panel-checkin");
    if(first) first.insertBefore(hint, first.firstChild);
  }
  document.getElementById("d-date").value = TODAY;
  document.getElementById("d-date").addEventListener("change", e=>fillForm(e.target.value || TODAY));

  document.getElementById("a-course").innerHTML =
    PLAN.courses.map(c=>`<option value="${c.id}">${c.name}</option>`).join("")
    + `<option value="other">其他</option>`;
  document.getElementById("a-due").value = "";
  document.getElementById("a-assigned").value = TODAY;

  Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), b=>{
    // 先闪一下再切：已经在当前页时 switchTab 会直接返回，这时候闪的那一下就是唯一的回应
    b.addEventListener("click", ()=>{ flashTab(b); switchTab(b.dataset.tab); });
  });

  /* 设置页：两份表单各自一个保存按钮，改完立刻重画 */
  const bind = (id, fn)=>{ const el = document.getElementById(id); if(el) el.addEventListener("click", fn); };
  bind("profileSave", saveProfile);
  bind("profileReload", ()=>{ renderProfileForm(); setHint("profileHint", ""); });
  bind("uiSave", saveUi);
  bind("uiAllOn", ()=>{
    TABS.forEach(t=>{ const el = document.getElementById("uit-"+t.id); if(el) el.checked = true; });
    MODULES.forEach(m=>{ const el = document.getElementById("uim-"+m.id); if(el) el.checked = true; });
    saveUi();
  });

  /* 外观主题：点一下立即换；方向键也能在四套之间走（radiogroup 的常规键盘行为） */
  const themeBox = document.getElementById("themeList");
  if(themeBox){
    themeBox.addEventListener("click", e=>{
      const row = e.target.closest(".theme-row");
      if(row) setTheme(row.dataset.themeId);
    });
    themeBox.addEventListener("keydown", e=>{
      const step = { ArrowRight:1, ArrowDown:1, ArrowLeft:-1, ArrowUp:-1 }[e.key];
      if(!step) return;
      const rows = Array.prototype.slice.call(themeBox.querySelectorAll(".theme-row"));
      const i = rows.findIndex(r=>r.getAttribute("aria-checked") === "true");
      if(i < 0) return;
      e.preventDefault();
      const next = rows[(i + step + rows.length) % rows.length];
      rows.forEach(r=>{ r.tabIndex = -1; });
      next.tabIndex = 0;
      next.focus();
      setTheme(next.dataset.themeId);
    });
  }
  // 键盘也能走标签页
  document.getElementById("tabBar").addEventListener("keydown", e=>{
    if(e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const btns = Array.prototype.slice.call(document.querySelectorAll(".tabs button")).filter(b=>!b.classList.contains("hidden"));
    const i = btns.findIndex(b=>b.classList.contains("on"));
    if(i < 0) return;
    const next = btns[(i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length];
    if(next){ e.preventDefault(); next.click(); next.focus(); }
  });

  document.getElementById("filters").addEventListener("click", e=>{
    const chip = e.target.closest(".fchip");
    if(!chip) return;
    if(chip.classList.contains("on")) return;   // 已经是当前筛选，不用重绘
    Array.prototype.forEach.call(document.querySelectorAll(".fchip"), c=>c.classList.remove("on"));
    chip.classList.add("on");
    ASG_FILTER = chip.dataset.f;
    renderAsg();
  });
  // 筛选块是 span，键盘回车/空格也要能用
  document.getElementById("filters").addEventListener("keydown", e=>{
    if(e.key !== "Enter" && e.key !== " ") return;
    const chip = e.target.closest(".fchip");
    if(!chip) return;
    e.preventDefault();
    chip.click();
  });

  // 回车快速添加
  document.getElementById("a-title").addEventListener("keydown", e=>{
    if(e.key === "Enter") addAsg();
  });

  document.getElementById("importFile").addEventListener("change", e=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    const btn = document.getElementById("importBtn");
    const r = new FileReader();
    fxBusy(btn, true);
    r.onload = ()=>{
      try{ importJSON(String(r.result)); fxFlash(btn, "ok"); }
      catch(err){ fxFlash(btn, "err"); }
      fxBusy(btn, false);
      e.target.value = "";
    };
    r.onerror = ()=>{ toast("读取文件失败", "warn"); fxBusy(btn, false); fxFlash(btn, "err"); e.target.value = ""; };
    r.readAsText(f, "utf-8");
  });

  /* 表单有改动就提示未保存，避免填完直接关页面 */
  const panel = document.getElementById("panel-checkin");
  const markDirty = ()=>{
    const el = document.getElementById("saveHint");
    if(el && el.dataset.state !== "dirty") setSaveState("未保存的改动", "dirty");
  };
  panel.addEventListener("input", markDirty);
  panel.addEventListener("change", markDirty);

  /* 快捷键：Ctrl/⌘+S 保存打卡，Esc 收起作业编辑面板 */
  document.addEventListener("keydown", e=>{
    if((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "s"){
      e.preventDefault(); saveDay();
    }
    if(e.key === "Escape"){
      document.querySelectorAll(".asg-edit").forEach(el=>el.classList.add("hidden"));
    }
  });

  fillForm(TODAY);
  renderBrand();
  renderGoalNote();
  renderFocusForm();
  renderBrief();
  renderAuth();
  renderStrip();
  renderAsg();
  renderWeek(); renderDebt(); renderTrend(); renderHistory(); renderWeekArchive();
  renderMilestones();
  renderProfileForm();
  renderUiForm();
  // 主题：方案里明确写过就按方案，没写过就用这台机器上次选的，再没有才是默认
  const savedTheme = (PLAN.appearance || {}).theme;
  applyTheme(isTheme(savedTheme) ? savedTheme : (localTheme() || DEFAULT_THEME));
  applyUI();          // 最后按使用者的开关收一遍：前面这些渲染里的判断都依赖它

  // 有服务端时拉一次最新数据；拉到了就整体重绘
  if(API){
    markSync("连接中");
    pullRemote().then(changed=>{ if(changed) refreshAll(); });
  }
})();

/* ══════════ 内联事件绑定 ══════════
   HTML 与渲染片段里有 onclick="xxx()"，模块作用域下它们看不见，
   必须在 window 上显式暴露。新增内联 onclick 时记得同步这里。 */
Object.assign(window, {
  exportAll, resetForm, saveDay, copyReminder, exportAsg, addAsg, saveWeek,
  setLv, toggleAsg, openEdit, closeEdit, saveEdit, delAsg, editDay
});
