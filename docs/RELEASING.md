# 发布与版本管理

面向维护者。目标：**每次发版都走同一条路，不靠记性**——包括怎么准备、版本号怎么定、
发出去之后怎么通知用户、下个版本又该从哪儿开始。

---

## 零、先建立一个前提：仓库就是代码的唯一来源

这个项目天然有两个东西：**公开的代码** 和 **私人的数据**。发布管理的全部麻烦都来自混淆这两者。

约定：

```
公开仓库（GitHub）＝ 唯一代码源，任何改动都只能发生在这里
       │
       └─ private/（本地生成，.gitignore 已排除，永不出现在仓库里）
```

只要 `private/` 始终被 git 忽略，你怎么提交都不会泄露数据。**发布前唯一要确认的就是这一点。**

### 两种运行位置，选一个

| | 方案 A：就地运行（推荐新手） | 方案 B：数据外置（推荐长期） |
| --- | --- | --- |
| 做法 | 就在仓库目录里跑，`private/` 落在仓库内但被忽略 | 数据放仓库外，用环境变量指过去 |
| 迁移成本 | 零 | 要移动一次数据 + 设一个环境变量 |
| 风险 | 误用 `git add -f` 会强行把 `private/` 提交上去 | 基本没有 |
| 适合 | 单人、图省事 | 想彻底隔离，或机器上有多份数据 |

方案 B 的做法：

```bat
:: 1. 把数据搬出去（先关服务）
move "F:\go work\daily-ledger\private" "D:\ledger-data"

:: 2. 设用户级环境变量（新开的进程都会继承）
setx LEDGER_PRIVATE_DIR "D:\ledger-data"

:: 3. 重新打开终端/重启资源管理器后生效，再启动服务
```

`launch.js` 与 `core/server.js` 都认这个变量，优先级高于默认的 `<项目>/private`。

---

## 一、首次发布：一次性准备

### 1. 发布前自检（四条命令，全空才算过）

在仓库根目录执行。**这一步不能跳**，它是唯一能兜住「手滑提交了私人东西」的环节。

```bash
# ① 被跟踪的文件里不该有私有目录和日志
git ls-files | grep -E '(^|/)private/|\.log$'        # 期望：无输出

# ② 不该有本机用户名、盘符、邮箱、手机号
git grep -nE 'C:\\Users|/Users/|F:\\|@[a-z0-9.-]+\.[a-z]{2,4}' -- . ':!*.md'   # 期望：无输出

# ③ 不该有令牌、口令、私钥
git grep -niE 'token["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9_-]{6,}|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key'

# ④ 不该有内网 IP
git grep -nE '\b(10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b'
```

命中不一定是问题（比如文档里的示例 IP），但**每一条命中都要看一眼再放行**。

### 2. 建 GitHub 仓库

1. GitHub → New repository
2. 填仓库名 `daily-ledger`，描述用 README 里那句简介
3. 选 **Public**
4. **不要**勾 "Add a README / .gitignore / license"——本地已经有了，勾了会产生冲突

### 3. 本地初始化并推送

```bash
cd daily-ledger
git init
git add -A
git status                      # ← 再看一眼，确认没有 private/ 和 *.log
git commit -m "chore: initial commit"
git branch -M main
git remote add origin https://github.com/<你的用户名>/daily-ledger.git
git push -u origin main
```

### 4. 把 README 里的占位换掉

```bash
grep -n "<仓库地址>" README.md      # 换成真实地址
grep -n "<your-name>" README.md    # 若有，一并换掉
```

### 5. 仓库设置（发布前顺手做完）

| 位置 | 设置 |
| --- | --- |
| About（右上齿轮） | 描述 + Topics：`study-tracker` `self-hosted` `zero-dependency` |
| Settings → General | 默认分支确认为 `main` |
| Settings → General → Features | 关掉 Wiki / Projects（用不上就别留入口），保留 Issues |
| 分支保护（可选） | `main` 要求 PR + CI 通过，防止自己手滑直推 |

### 6. 打第一个版本

见下面 [三、单次发版流程](#三单次发版流程模板)。

---

## 二、版本号：怎么定、怎么加

采用 **语义化版本** `MAJOR.MINOR.PATCH`，tag 写成 `v1.2.3`（带 `v` 前缀，与 `package.json` 的
`version` 字段保持数字一致）。

### 判定表

| 你改了什么 | 加哪位 | 例子 |
| --- | --- | --- |
| 修 bug、改文案、调样式、改注释 | **PATCH** | 1.0.0 → 1.0.1 |
| 新增分析规则、新页签、新接口、新开关 | **MINOR** | 1.0.1 → 1.1.0 |
| 改变已有行为但不破坏数据（阈值调整、默认值变化） | **MINOR** | 1.1.0 → 1.2.0 |
| **数据结构变更**（`records.json` / `profile.json` 字段增删改） | **MAJOR** | 1.2.0 → 2.0.0 |
| 删接口、改接口语义、改鉴权方式、要用户手动操作才能升级 | **MAJOR** | 2.0.0 → 3.0.0 |

三条铁律：

1. **只增不减。** 版本号一旦发出去就不回退，即使发完发现有问题——发 PATCH 修，不要重发。
2. **数据结构变更一律视为 MAJOR。** 用户的 `private/records.json` 里是真实记录，
   悄悄改字段会让别人的数据读不出来。真要改，必须同时提供迁移代码 + CHANGELOG 里写明。
3. **`0.x` 阶段**（若将来有）可以随意破坏，但一旦到 `1.0.0` 就要守约。

### 预发布

修 beta、试用版用 `v1.3.0-beta.1`。GitHub 上勾 **Pre-release**，不会出现在 "Latest"。
正式发布时去掉后缀即可。

### 命名与 tag

```bash
# package.json 里的 version 必须与 tag 一致
npm version patch --no-git-tag-version   # 只改文件，不自动提交/打 tag（推荐，便于先改 CHANGELOG）
git commit -am "chore: release v1.0.1"
git tag -a v1.0.1 -m "v1.0.1"
git push origin main
git push origin v1.0.1
```

> 用 `--no-git-tag-version` 是为了**先改完 CHANGELOG 再提交**。
> 如果让 npm 自动打 tag，你会得到一个「tag 指向的提交里 CHANGELOG 还是旧的」的版本。

---

## 三、单次发版流程（模板）

以后每个版本都照这个走，10 步，顺序别换。

### 第 1 步　同步并开分支

```bash
git checkout main && git pull
git checkout -b release/v1.1.0
```

### 第 2 步　改代码

小改动可以直接在分支上改；大改动先开 feature 分支，合进来再发。

### 第 3 步　跑全量检查（必须全绿）

```bash
npm run verify      # 27 规则 + 12 接口 + 12 浏览器 + 13 界面开关 = 64 项
```

失败就不往下走。特别提醒：

- `smoke` / `ui` 需要本机有 Chrome，它们会自己起临时实例，**不会碰 `private/`**。
- 如果你动了 `core/domain/rules.js` 的判断逻辑，必须同步重新生成基线，并在提交说明里写清影响面：
  ```bash
  node test/characterize.mjs      # 重新生成 test/golden/analysis.json
  git diff --stat test/golden/analysis.json
  ```

### 第 4 步　定版本号

按 [第二节的判定表](#判定表) 加一位，然后：

```bash
npm version patch --no-git-tag-version     # 或 minor / major
```

### 第 5 步　写 CHANGELOG

在 `CHANGELOG.md` 顶部插入新版本小节，格式固定：

```markdown
## [1.1.0] - 2026-11-20

### 新增
- 某某功能（说清用户能看到什么变化）

### 变更
- 某个阈值从 X 改成 Y（说明为什么）

### 修复
- 修了什么 bug，什么条件下会触发

### 升级注意
- 需要用户做什么（没有就写「无，直接替换文件即可」）
```

**「升级注意」这一段不能省。** 用户升级只看这一节。

### 第 6 步　更新 README 里会过时的东西

至少检查三处：版本徽章、测试项数量、目录结构（新增/删除文件后）。

### 第 7 步　提交并合并

```bash
git add -A
git commit -m "release: v1.1.0"
git push -u origin release/v1.1.0
# 在 GitHub 上开 PR → 自己审一遍 diff → 合并到 main
git checkout main && git pull
```

PR 的意义不是流程好看，是**让你在网页上通读一遍完整 diff**——这是第二次发现误提交的机会。

### 第 8 步　打 tag 并推送

```bash
git tag -a v1.1.0 -m "v1.1.0"
git push origin v1.1.0
```

用 `-a`（附注 tag）而不是轻量 tag：它带作者、日期、说明，`git describe` 也能用。

### 第 9 步　做发布包

**推荐用 `git archive`**，而不是手工压缩——它只打包被 git 跟踪的文件，
`private/`、`*.log`、`runtime/node.exe` 这些被忽略的东西**天然进不去**，不需要维护排除清单。

```bash
VERSION=1.1.0
git archive --format=zip --prefix=daily-ledger-${VERSION}/ -o daily-ledger-${VERSION}.zip v${VERSION}

# 生成校验值（Windows 用 certutil，macOS 用 shasum -a 256）
certutil -hashfile daily-ledger-${VERSION}.zip SHA256 > SHA256SUMS.txt
```

命名固定为 `daily-ledger-<版本>.zip`，解压后得到 `daily-ledger-<版本>/` 一个顶层目录——
不要打成「一堆文件散在压缩包根目录」，那会让用户解压时污染下载文件夹。

### 第 10 步　创建 GitHub Release

1. 仓库 → Releases → **Draft a new release**
2. Tag 选刚才推的 `v1.1.0`，标题写 `v1.1.0`
3. 正文**直接粘贴 CHANGELOG 里这一节**（不用另写一遍，保持单一事实来源）
4. 上传两个附件：`daily-ledger-1.1.0.zip`、`SHA256SUMS.txt`
5. 勾不勾 Pre-release 见第二节
6. Publish release

### 发布后自查（3 分钟）

用**另一个目录**模拟陌生人下载：

```bash
# 1. 从 Release 页下载 zip，解压到空目录
# 2. 跑一遍
cd daily-ledger-1.1.0
npm test          # 规则用例
npm run api       # 接口契约
npm start         # 能起来吗（Ctrl+C 退出）
# 3. 浏览器打开 http://127.0.0.1:3000，看一眼页面和数据都正常
```

这一步是唯一能证明「发出去的东西是好的」的方法。本地测试通过 ≠ 发布包完整
（少一个文件、漏一个目录，只有解压后才看得出来）。

---

## 四、怎么通知和分发新版本

### 主渠道：GitHub Releases

这是唯一必须做的。它的价值在于**订阅**：

- 用户在仓库页点 **Watch → Custom → 只勾 Releases**，以后每次发版都会收到邮件。
- Release 页面本身就是一个可长期引用的版本档案，附带的 zip 永久可下载。

README 顶部放一个指向最新 Release 的链接，比写版本号更耐用：

```markdown
最新版本：[Releases](https://github.com/<用户名>/daily-ledger/releases/latest)
```

### 次要渠道（按需）

| 渠道 | 怎么做 | 适合 |
| --- | --- | --- |
| README 顶部的版本徽章 | `https://img.shields.io/github/v/release/<用户名>/daily-ledger` | 一眼看到版本 |
| 自己的手机提醒 | 项目自带 `notify.js`，配 ntfy / Bark 后发一条 | 自己用，顺手 |
| 群/朋友圈/博客 | 复用 Release 正文，加一句「这次解决了什么」 | 有人真的在用 |
| Issues / Discussions | 破坏性变更单独开一条置顶说明 | 用户较多的阶段 |

### 给使用者的一句话升级说明（可直接复用）

> **升级到 v1.1.0**：下载 `daily-ledger-1.1.0.zip`，解压后用新目录里的文件覆盖旧目录的代码
> （**保留你原来的 `private/` 目录**），然后重启服务。
> 本次无数据结构变更，`private/` 不用动。

有 MAJOR 变更时，这句话必须改成带迁移步骤的版本，并且**在 Release 正文第一段就说**，
不要埋在最后。

---

## 五、注意事项

### 绝对不能做

| 事项 | 为什么 |
| --- | --- |
| `git push --force` 到 `main` | 会改写别人已经拉下去的历史，`git pull` 直接冲突 |
| 重新给已发布的 tag 打新内容（`git tag -f` + 强推） | tag 被当成「某个版本的快照」，移动它等于让别人的校验失效；发错了就发下一个 PATCH |
| 把 `private/`、`*.log`、口令、密钥提交上去 | 一旦进了公开仓库的历史，删文件也没用，必须轮换凭证 |
| 在 CHANGELOG 里写「一些改进」 | 用户没法判断该不该升级 |
| 手动改 `test/golden/analysis.json` 让测试变绿 | 基线是行为契约，改它等于改规则 |

### 容易忘的

1. **`package.json` 的 version 与 tag 必须一致**，否则 `npm view` / 徽章会显示错。
2. **改数据结构时同时写迁移**，并在 `docs/ARCHITECTURE.md` 的「迁移与回滚」补一行。
3. **发布包只用 `git archive`**，别用「复制文件夹再压缩」——后者会把 `node_modules`、
   日志、甚至 `private/` 一起带进去。
4. **删除功能也是破坏性变更**，哪怕代码更干净，对用户就是「我的东西不见了」，记为 MAJOR。
5. 附件别超过 GitHub 单文件 2 GB 限制（本项目约 500 KB，不会碰到）。

### 凭证轮换（发生过泄露才需要）

如果某个口令/令牌不小心进过仓库（哪怕后来删了）：

```bash
# 1. 立刻在源头换掉（改 private/config.json 的 token，或重新生成第三方令牌）
# 2. 确认仓库里已经没有了
git grep -n "<旧口令>" $(git rev-list --all) -- .
# 3. 有远端且已公开的，历史里的记录只能用 git filter-repo 清理，或干脆换仓库
```

**换凭证比清洗历史便宜得多。** 先换，再考虑要不要清。

---

## 六、速查清单（发版时照着勾）

```
□ git checkout main && git pull
□ npm run verify  → 64 项全绿
□ 改了规则？→ node test/characterize.mjs 重新生成基线，diff 已看过
□ 定版本号：npm version <patch|minor|major> --no-git-tag-version
□ CHANGELOG.md 顶部加一节，含「升级注意」
□ README 的版本徽章 / 测试数量 / 目录结构已同步
□ git ls-files | grep -E 'private/|\.log$'  → 无输出
□ git grep 查过用户名 / 绝对路径 / 口令 / 内网 IP
□ 提交 → PR → 自己通读一遍 diff → 合并
□ git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
□ git archive 出 zip（带 daily-ledger-X.Y.Z/ 前缀）+ SHA256SUMS.txt
□ GitHub Release：粘 CHANGELOG 该节 + 上传两个附件
□ 下载自己的 zip，解压到空目录，npm test / npm run api / npm start 各跑一遍
```

---

## 七、这个版本的发布参数（v1.0.0 现成值）

| 项 | 值 |
| --- | --- |
| 仓库名 | `daily-ledger` |
| 描述 | Zero-dependency study ledger: daily check-in, assignments, weekly review, milestone countdown. |
| 首个 tag | `v1.0.0` |
| 包名 | `daily-ledger-1.0.0.zip` |
| 许可证 | MIT（无第三方字体随包分发） |
| 检查项 | 64 项（27 规则 + 12 接口 + 12 浏览器 + 13 界面） |
