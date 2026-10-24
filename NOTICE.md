# NOTICE

## 第三方字体

**本仓库不包含任何字体文件。**

界面样式里引用了像素字体 *Zpix（最像素）*，但只是通过 CSS 的 `local()` 引用：

```css
@font-face{
  font-family:"Zpix";
  src:local("Zpix"),local("Zpix12"),local("Zpix Pixel"),local("Zpix Regular");
  font-display:swap;
}
```

含义是「**如果这台机器上装了 Zpix，就用它；没装就回退到系统字体**」——
不发起任何网络请求，也不分发字体文件本身。

### 为什么不分发

Zpix 由 **SolidZORO** 开发（<https://github.com/SolidZORO/zpix-pixel-font>），
不是开源字体，按使用场景授权：个人项目免费、教育项目免费、商业项目需付费。
其条款明确**禁止修改、反编译、转换、拆分**以及未经许可的传播。

因此本项目选择不分发它的任何形态（包括子集）。这样：

- 代码许可证（MIT）与字体授权完全解耦，使用者不必为字体授权担心；
- 需要商业使用时，不存在「包里带了别人的字体」这种隐患。

### 想恢复像素外观怎么办

自己装一份 Zpix（作者提供 ttf / woff2 / bdf 下载），装好后刷新页面即可自动生效——
CSS 的 `local()` 会命中系统里已安装的字体，不需要改任何代码。

> 注意：安装字体属于你与字体作者之间的授权关系，与本项目无关。

### 界面在没有 Zpix 时是什么样

回退到 `--font` 变量里的系统字体栈：`"PingFang SC"` / `"Microsoft YaHei"` / `monospace`。
**功能、布局、配色完全一致**，只是字形不再是像素风。

---

## 运行时依赖

本项目**没有**任何 npm 运行时依赖：`package.json` 中不存在 `dependencies` / `devDependencies`，
用到的全部是 Node.js 内置模块（`http` / `fs` / `path` / `crypto` / `zlib` / `child_process`）。

测试只用两个东西，都是「本机已有」而不是「要装包」：

- `node:test` —— Node.js 内置测试框架。
- 本机已安装的 Chrome —— 供 `test/browser-check.mjs`、`test/ui-check.mjs` 通过 CDP 驱动。
  没有 Chrome 时，`npm test` 与 `npm run api` 仍可独立运行。

## 图形资源

`core/web/textures/*.svg` 是本项目自行生成的背景纹理，随代码以 MIT 授权发布。
