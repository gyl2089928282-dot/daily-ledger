/**
 * 生成页面底的像素方块贴图（32×32，可无缝平铺）。
 *
 * 为什么是程序生成而不是手画：一张 32×32 里有 30+ 块石头、几百个像素，
 * 手画既改不动也保证不了四套主题的「同一套骨架、只换材质」——
 * 换个调色板重跑一遍，块形与接缝位置完全一致，主题之间才像是同一个世界。
 *
 * 算法：随机铺石块（宽 7–13、高 5–9），右/下留 1px 石缝；石块允许跨出边界，
 * 用取模回卷写回，否则每个 tile 边缘会出现一条贯通的缝，一眼看出平铺。
 * 每块随机取 4 档色之一，逐像素 17% 概率 ±1 档，底边压暗一档。
 *
 * 用法：
 *   node tools/make-textures.mjs              → 生成全部缺失/过期的贴图
 *   node tools/make-textures.mjs nether snow  → 只生成指定主题
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "core", "web", "textures");

/**
 * 调色板：joint = 石缝，tones = 由暗到亮的 4 档石色。
 * stone / deepslate 就是线上一直在用的那两张，改这里等于改全站底色，慎动。
 */
const PALETTES = {
  stone:      { file: "cobble.svg",      joint: "#6B6B6B", tones: ["#7D7D7D", "#888888", "#939393", "#9E9E9E"] },
  deepslate:  { file: "cobble-dark.svg", joint: "#252A31", tones: ["#2E343B", "#353B43", "#3C434B", "#444C55"] },
  // 下界：玄武岩，几乎全黑，缝里透一点红褐
  nether:     { file: "basalt.svg",      joint: "#17100F", tones: ["#2A1D1A", "#322320", "#3A2A26", "#43312C"] },
  // 雪原：雪块与浮冰，冷灰蓝，缝比石色深一档
  snow:       { file: "snow.svg",        joint: "#AFC2D0", tones: ["#CFDDE7", "#DAE6EF", "#E4EEF5", "#EFF6FB"] },
  // 沙漠：砂岩，暖黄褐，缝是浅赭
  sand:       { file: "sand.svg",        joint: "#B99F6E", tones: ["#D3BE92", "#DCC9A0", "#E5D5B0", "#EFE2C2"] }
};

const W = 32, H = 32;
const SEED = 20261022;      // 固定种子：四套贴图的块形完全一样

function build(palette) {
  let seed = SEED;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const occ = Array.from({ length: H }, () => Array(W).fill(0));   // 0 空 / 1 石 / -1 缝
  const tone = Array.from({ length: H }, () => Array(W).fill(-1));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (occ[y][x] !== 0) continue;
      const w = 7 + Math.floor(rnd() * 7);
      const h = 5 + Math.floor(rnd() * 5);
      const base = Math.floor(rnd() * 4);

      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const gy = (y + yy) % H, gx = (x + xx) % W;
          if (occ[gy][gx] !== 0) continue;
          let t = base;
          const n = rnd();
          if (n < 0.17) t = Math.max(0, t - 1);
          else if (n > 0.85) t = Math.min(3, t + 1);
          if (yy === h - 1) t = Math.max(0, base - 1);   // 只压暗底边，右缘不压，否则像砖
          occ[gy][gx] = 1;
          tone[gy][gx] = t;
        }
      }
      for (let yy = 0; yy < h; yy++) {
        const gy = (y + yy) % H, gx = (x + w) % W;
        if (occ[gy][gx] === 0) occ[gy][gx] = -1;
      }
      for (let xx = 0; xx <= w; xx++) {
        const gy = (y + h) % H, gx = (x + xx) % W;
        if (occ[gy][gx] === 0) occ[gy][gx] = -1;
      }
    }
  }

  // 水平游程压缩：整行同色合成一条 path，体积从 ~30KB 降到 ~6KB
  const byTone = new Map();
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      const t = tone[y][x];
      let w = 1;
      while (x + w < W && tone[y][x + w] === t) w++;
      if (!byTone.has(t)) byTone.set(t, []);
      byTone.get(t).push(`M${x} ${y}h${w}v1H${x}z`);
      x += w;
    }
  }
  const paths = [...byTone.entries()]
    .map(([t, ps]) => `<path fill='${t < 0 ? palette.joint : palette.tones[t]}' d='${ps.join("")}'/>`)
    .join("");

  return `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32' shape-rendering='crispEdges'>${paths}</svg>`;
}

const want = process.argv.slice(2);
const names = want.length ? want : Object.keys(PALETTES);
let n = 0;
for (const name of names) {
  const p = PALETTES[name];
  if (!p) { console.error("没有这个调色板：" + name); process.exitCode = 1; continue; }
  const svg = build(p);
  fs.writeFileSync(path.join(OUT, p.file), svg);
  console.log(p.file.padEnd(20) + svg.length + " bytes");
  n++;
}
console.log("写出 " + n + " 张到 core/web/textures/");
