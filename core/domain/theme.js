/**
 * 外观主题：四套配色，同一套「方块世界」的骨架。
 *
 * 主题只决定材质与强调色，不决定结构：
 * 页签位置、卡片尺寸、字号、间距、图表柱宽都不随主题变化，
 * 所以换主题不会引起重排，也不存在「某个主题把布局撑坏了」。
 *
 * 数据存在 profile.appearance.theme（字符串），没写就是默认主题。
 * 为什么不用 profile.ui：那一段是「显示/隐藏」的布尔开关表，
 * 混进一个字符串会让 fillUi 的语义变模糊，也让「全开/全关」失去意义。
 */

/**
 * id 与 app.css 里的 html[data-theme="…"] 一一对应。
 * swatch 是设置页缩略图用的三个颜色：世界底色 / 卡片色 / 强调色。
 */
export const THEMES = [
  {
    id: "stone",
    name: "圆石 · 书页",
    desc: "默认。灰色圆石底、米色书页、红石强调，白天夜里都稳",
    tex: "textures/cobble.svg",
    swatch: { bg: "#6C6C6C", paper: "#F3E9CE", accent: "#B8342A" }
  },
  {
    id: "nether",
    name: "下界 · 熔岩",
    desc: "深玄武岩配岩浆橙，整体偏暗，晚上盯着不刺眼",
    tex: "textures/basalt.svg",
    swatch: { bg: "#2B1A17", paper: "#2E211D", accent: "#E04A1A" }
  },
  {
    id: "snow",
    name: "雪原 · 云杉",
    desc: "雪块与浮冰的冷色调，强调色换成冰蓝，最清爽的一套",
    tex: "textures/snow.svg",
    swatch: { bg: "#C7D5DF", paper: "#FBFDFF", accent: "#2A6FA8" }
  },
  {
    id: "sand",
    name: "沙漠 · 砂岩",
    desc: "砂岩暖黄配陶土橙，纸感最重，像摊在桌上的笔记本",
    tex: "textures/sand.svg",
    swatch: { bg: "#D6C49C", paper: "#FCF6E4", accent: "#B4552A" }
  }
];

export const DEFAULT_THEME = "stone";

/** 是不是已知主题（外来方案里写了不存在的 id 时用它兜底） */
export function isTheme(id) {
  return THEMES.some((t) => t.id === id);
}

/** 主题的完整定义，找不到就给默认的 */
export function themeDef(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/**
 * 从方案里读出主题 id。
 * 缺省、写错、写成别的类型，一律回退到默认——页面永远有一套完整配色。
 * @param {object} profile
 * @returns {string}
 */
export function themeOf(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const a = p.appearance && typeof p.appearance === "object" ? p.appearance : {};
  return isTheme(a.theme) ? a.theme : DEFAULT_THEME;
}
