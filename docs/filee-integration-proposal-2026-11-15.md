# Filee 集成调研与方案评审（待确认，尚未开发）

日期：2026-11-15　状态：**方案阶段，未写任何产品代码**
调研对象：Filee（GitHub `KnifeLemon/Filee`，官网 filee.sh，v2.4.1）

---

## 0. 结论摘要

1. **Filee 不是文件管理器，是 .NET 10 + Avalonia 的离线格式转换器**（MIT）。它的交互核心（拖拽圆环、资源管理器右键菜单、进度环）**无法嵌入 Electron**；能编程调用的只有它的 **CLI**。
2. **Filee 官方自己给出了一条 AI 集成路径**：`skills/filee/SKILL.md`（Agent Skill），明确教 AI 用 `filee convert --json --quiet` 调用。**这是官方背书的集成方式**，我们的实现照它写就对了。
3. **但直接"引入 Filee"是错误抽象。** 更优方案是：先立一个**可插拔的转换适配层**（`lib/convert/`），Filee CLI 只是**第一个 provider**；并且**先用 Chromium 自带能力覆盖大部分图片/PDF 场景**，只把 Chromium 做不到的长尾（HEIC / Office / HWP / 音视频）交给 Filee。
4. **与上一轮未决事项强耦合**：附件"外置"改造（上一轮治本方案）与本需求是**同一条管线**，必须合并设计，否则做两遍甚至返工。建议**先拍板外置方案，再动 Filee**。
5. **如果你的真实目标是"用户拖文件时弹出格式圆环"** —— 那结论是**不该集成**，两个应用并行即可（见 §3 歧义点 Q1）。

---

## 1. 调研结论：Filee 是什么（事实）

### 1.1 身份与技术栈

| 项 | 事实 | 来源 |
|---|---|---|
| 定位 | 本地离线格式转换器，非文件管理器、非网盘 | README / filee.sh |
| 技术栈 | .NET 10 + Avalonia + C#；xUnit v3 测试 | 仓库 `global.json` / README |
| 许可 | **MIT**（本体） | LICENSE / 官网 FAQ |
| 版本 | v2.4.1（win x64 Setup 约 **132 MB**） | filee.sh 下载区 |
| 建仓 | **2026-09-29**（约 7 周前），最新提交 2026-11-15 | 仓库提交历史 |
| 维护 | 单人主导（KnifeLemon / Myeonggu Kim），提交记录含大量 `Co-Authored-By: Claude Opus 5.5` | 仓库提交历史 |
| 成熟度信号 | macOS 仍 preview 且**未 notarize**；**无代码签名**（Windows SmartScreen 会告警）；引擎按需下载 | README / filee.sh |
| 分层 | `Filee.Core`（无 UI/OS API）/ `Filee.Engines`（一引擎一 `IConverter`）/ `Filee.Platform.{Windows,MacOS,Linux}` / `Filee.App` / `Filee.Cli` | README Architecture |

### 1.2 能力边界

- **255 种格式 / 18 大类**，其中 **147 种开箱即用**，其余需按需下载可选引擎。
- 可选引擎与体量：**FFmpeg ≈100 MB**、**LibreOffice ≈420 MB**、**Pandoc ≈42 MB**、Calibre、Ghostscript。**安装器里不含**，需在 App 里 Settings → Engines 下载，或它检测到 PATH / Program Files 已有则直接复用。

### 1.3 唯一可编程接口：CLI

```
filee convert <files/glob/dirs> (--to <fmt> | --preset <id>) [options]
filee watch <folder> (--to <fmt> | --preset <id>) [options]
filee formats [<fmt>]
filee presets
filee help [<cmd>] | filee version
```

`convert` 关键选项：`-t/--to`、`-p/--preset`、`-o/--output`、`-r/--recursive`、`-q/--quality`、`--pages`、`--overwrite`、`--skip`、`--keep-dates`、`--json`、`--quiet`。

`--json` 输出契约（**官方 SKILL.md 原文**）：

```json
{ "preset": "WEBP", "target": "webp",
  "converted": 2, "skipped": 0, "failed": 1,
  "files": [ { "source": "...\\cover.png", "state": "done",
               "outputs": [ "...\\cover.webp" ] },
             { "source": "...\\broken.png", "state": "failed",
               "outputs": [], "error": "..." } ] }
```

`files[].state` ∈ `done | skipped | failed | cancelled`；失败项可能带 `needsEngines: ["pandoc"]`。

退出码：`0` 无失败/取消（**可能有 skipped，不等于全转成功**）、`1` 部分失败或取消、`2` 参数/格式错或缺输入（**无 JSON**）、`3` 无可转项（**无 JSON**）。

### 1.4 官方 AI 集成口径（`skills/filee/SKILL.md`，已取回全文）

官方要求逐条照做：

- 先 `filee version` 确认安装；
- **先 `filee formats <fmt> --json` 预检**，看 `targets`（现在就能转）与 `withEngines`（装了引擎才能转）；
- 转换**永远带 `--json --quiet -o <folder>`**——原因：`--json` 不加 `--quiet` 会把进度事件也写进 **stderr**（每行一个 JSON），合并 stdout/stderr 会把结果打坏；
- **不能只看退出码**，必须读 `files[].state` 与 `files[].outputs`；
- 缺引擎时（`needsEngines`）**唯一出路是让用户去 Filee 的 Settings → Engines 装**，然后重试。

> 这条 SKILL.md 直接可作为我们实现的规格来源，省掉一轮试错。

### 1.5 安装路径与发现方式

| 形态 | CLI 位置 |
|---|---|
| Setup 安装（勾选 "Add the filee command to PATH"，默认勾） | PATH 上的 `filee` |
| Windows 免安装 zip | `<Filee目录>\cli\filee.cmd` 或 `filee-cli.exe` |
| Linux / macOS `install.sh` | `$HOME/.local/bin/filee`（**该目录必须在 PATH**） |

另：`filee` 是 Filee 自己的安装器安装时**可选的附带项**（连同 Explorer 右键菜单、开机启动、Windows 11 顶级菜单包）——**从源码构建不会获得这些**。

---

## 2. 我理解的目标（复述）

**我的读法**：让**非图片文件也能进便签**——用户把 HEIC / HWP / DOCX / PDF 拖进便签，应用自动转换成可展示的形式并附到便签上，Filee 负责转换。

依据来自我方现有代码，这个读法有直接支撑：

- `src/note.js` `handleFiles()` 目前只收 `/^image\//`，其余一律 `toast('仅支持图片文件')` —— **这就是当前的能力缺口**；
- `src/note.js` 已有 `insertHtml()`（:335）、`insertImageDataUrl()`（:533）、`paste` / `drop` 事件管线（:553 起），接入点清晰；
- README 明确记录产品边界："多便签、可换色、支持截图粘贴与 Mermaid 图表"。

**Filee 与本项目的匹配度**：Filee 强在"长尾格式"（HEIC、HWP/HWPX 无需 Hancom Office、DOCX 无需 Office、PDF/电子书/音视频），而本项目强在"轻量随身记录"。二者是**能力互补**，不是同类替代。

---

## 3. 歧义点：需要你确认（3 选 1，直接影响方案）

**Q1. "添加进我们项目"具体指哪一层？**

| 选项 | 含义 | 我的判断 |
|---|---|---|
| **A** | **在便签里做"拖入文件 → 转换 → 附到便签"** | ⭐ 最可能。但要接受"拿不到圆环交互" |
| **B** | **把 Filee 当外部工具调用**（便签里右键"用 Filee 打开/转换"，两个应用并行） | 成本最低，**如果 B 就别做适配层** |
| **C** | **把 Filee 代码 vendor/fork 进 Electron** | ❌ 我认为这是错的方向，见 §4.2 |

**Q2. 目标格式与文件类型？** 是"任意格式→便签可展示"，还是只做几类（HEIC/HWP/DOCX/PDF → 图片或 PDF）？

**Q3. 是否接受"用户需自行安装 Filee"？** 这决定分发模型：
- 接受 → 零打包负担、许可干净（§4.3）；
- 不接受 → 要我们打包 Filee + 引擎 = 132 MB + 最高 420 MB，且触发引擎许可义务（§4.3）。

---

## 4. 我主动指出的问题（9 条，不迎合）

### 4.1 技术栈不兼容，"嵌入"这个词不成立
Avalonia/.NET 10 无法进 Electron 运行时。只有两条路：**进程边界**（spawn CLI）或**重写 UI**。任何"把 Filee 界面嵌进便签"的想法都要付出重写代价。

### 4.2 vendor/fork 是逆向工程选择
把 .NET 库塞进 Node 运行时意味着：仓库要带 .NET SDK 构建链、要交叉编译、要维护两套依赖与 CI、产物要手工与 Electron 打包链路对齐。**收益是零**——Filee 的价值在交互与引擎，不在代码可读性。**建议直接排除选项 C。**

### 4.3 许可边界：本体 MIT ≠ 依赖树 MIT
| 组件 | 许可 | 风险 |
|---|---|---|
| Filee 本体 | MIT | 无 |
| Ghostscript | **AGPL** | ⚠️ 最锋利的一个 |
| Pandoc / calibre | GPL | 分发即需附源码/提供对应条款 |
| FFmpeg | LGPL / GPL（取决于构建） | 同上 |
| LibreOffice | MPL 2.0 | 弱著佐权，相对安全 |

**规避策略**：只**调用**用户自行安装的 Filee，**不重分发** Filee 与引擎（"指路不发货"）。此时义务留在 Filee 侧，我们干净。**一旦打包进安装器，就必须逐个处理引擎许可。** 这是 §3-Q3 必须先定的根因。

### 4.4 走 CLI 就丢掉了 Filee 的核心价值
Filee 的差异化是"按住 Ctrl 拖文件，光标处浮出圆环"+"资源管理器右键 Convert with Filee"+"进度环"。**这三样 CLI 全都没有**（右键菜单还是安装器选项，源码构建拿不到）。
**结论：集成 Filee = 拿到"格式转换能力"，拿不到"交互"。** 如果用户要的是后者，集成是白做。

### 4.5 工程成熟度：把路线绑在单人项目上
建仓仅 7 周、单人主导、无代码签名、大量 AI 生成提交、macOS 仍在 preview。
**⇒ 绝不能把便签的核心能力建在 Filee 上**。这直接推出 §5 的"适配层 + 多 provider"设计。

### 4.6 CLI 调用的现实坑（清单）
| 坑 | 应对 |
|---|---|
| PATH 不一定有 `filee`（安装器选项/便携 zip 形态不同） | 仿 `main.js:1489 pythonBin()` 写 `fileeBin()` 候选探测 + 缓存 + 优雅降级 |
| `--json` 不加 `--quiet` 会污染 stdout | **强制 `--quiet`**，且 spawn 时 stdout/stderr 分流不合并 |
| 退出码 0 ≠ 全部成功（可能 skipped） | 只认 `state === 'done' && outputs.length > 0` |
| 退出码 2/3 时**没有 JSON** | 解析失败要回落到 stderr 文本，UI 要分别提示"参数/格式错"与"无可转项" |
| 缺引擎（`needsEngines`）**只能跳去 Filee GUI 装** | ⚠️ 硬 UX 断点：Electron 侧无法代装。需明确文案与引导 |
| **无增量进度**：`convert` 是一次性 JSON 文档 | UI 只能是"转式中"不确定态，**不能假装有进度条** |
| **取消**：`convert` 无取消协议 | 只能 kill 子进程 → 有**产出半截文件**的风险，需要清理逻辑 |
| `watch` 是常驻进程 | 不适合嵌入，最多做"单次 convert" |
| 默认不加数字后缀而非覆盖（`--overwrite`/`--skip`） | 临时目录每次干净即可，但仍要显式传 `--overwrite` |
| `filee formats <fmt> --json` 返回 `targets` / `withEngines` | 用它做**能力预检**，别等转换失败才报错 |

### 4.7 引擎缺失是一个我们无法自愈的断点
FFmpeg ≈100 MB、LibreOffice ≈420 MB。让用户为了转一张 HEIC 去装 100 MB 引擎，体验上很可能劝退。**必须在设计阶段就决定**：哪些格式"零引擎即可用"作为首发支持范围。

### 4.8 与本项目自身演进的冲突（最需要你拍板的一条）
- README 现记："图片以 dataURL 内联，避免文件丢失导致便签空白"。
- 上一轮性能结论已定：**治本方案是"图片外置 + 每键小 patch"**（尚未拍板）。
- **Filee 转换产物若进便签，同样面临"内联 dataURL vs 外置文件"的选择。**
  - 若走内联：大图会再次放大 JSON 落盘体积，**把我们刚优化掉的性能问题请回来**；
  - 若走外置：就应**直接产出外置文件 + 引用**，而不是绕一圈转 dataURL。
- ⇒ **附件外置管线与 Filee 集成是同一条管线，必须一起设计。** 建议顺序：**先定外置方案 → 再做 Filee**，否则大概率返工。

### 4.9 性能耦合：转换进程绝不能进关键路径
主进程 spawn 一个 .NET 进程做 HEIC→PNG / PDF→PNG，会占 CPU 与磁盘 IO。我们上一轮刚为"每键输入延迟"做完一轮优化。**约束**：转换必须走独立子进程 + 独立工作目录，主进程只做编排，转换期间**不得阻塞任何 IPC**（尤其 `note:update` 的 `sendSync` 路径）。

---

## 5. 方案对比

| | A. 外部 CLI 可选集成 | B. vendor/fork Filee | C. 自研最小转换子集 | **D. 适配层 + Filee provider（推荐）** |
|---|---|---|---|---|
| 做法 | 主进程 spawn 已安装的 `filee` | 把 .NET 代码搬进仓库 | 用 JS 库自己转 | 先立 `lib/convert/` 统一契约；Filee 只是其中一个 provider；Chromium/JS provider 覆盖能自做的部分 |
| 分发负担 | 0（用户自装） | 极高（双构建链） | 中（native 依赖） | 0（起步同 A，但可扩展） |
| 许可 | 干净（只调用） | ⚠️ 引擎义务 | 需逐库审计 | 干净（provider 可插拔、可替换） |
| 覆盖格式 | 全（受引擎限制） | 全 | 长尾受限 | 起步全，**并随 provider 增加** |
| Filee 挂掉 | 只失去长尾转换 | 项目烂掉 | 无影响 | **只失去一个 provider，其余能力保留** |
| 拿到交互 | ❌ | ✅（重写后） | ❌ | ❌（可另做 B 路线互通） |
| 工程量 | 小 | 极大 | 中 | 小→中 |
| 耦合度 | 高（直连 Filee） | 最高 | 无 | 低 |

### 5.1 推荐：D —— 但要先做 §5.2 的分层

**核心洞察：Chromium 已经能做掉大部分常见诉求，Filee 只该负责长尾。**

| 场景 | Chromium/JS 自做 | 需 Filee（外部引擎） |
|---|---|---|
| PNG/JPG/WEBP 互转 | ✅ `canvas.toDataURL('image/webp'|'image/jpeg')` —— **我方 `compressImage()` 已在用 canvas** | — |
| PDF → 图片 / 抽文本 | ✅ vendored **pdf.js**（纯 JS，本项目已有 `src/vendor/` 先例，Mermaid 11 即如此） | — |
| 图片压缩 / 尺寸 / 灰度 | ✅ Canvas + WebGL | — |
| HEIC → JPG | ❌ Chromium 不支持 | ✅（需 FFmpeg） |
| DOCX/XLSX/PPTX → PDF | ❌ | ✅（Filee 内建） |
| HWP/HWPX → PDF | ❌ | ✅（Filee 内建，无需 Hancom Office） |
| 音视频转码 | ❌ | ✅（需 FFmpeg ≈100 MB） |

**⇒ 首发支持范围建议 = "零引擎即可用"的那一档**（图片互转 + PDF 处理用 Chromium），Filee 作为**可选增强**（装了就多支持 HEIC/Office/HWP，没装完全不影响核心功能）。这样：
- 不需要用户先装 132 MB 的东西就能用；
- Filee 缺失时**优雅降级**而非功能坏掉；
- 也顺带 §4.5（不被单人项目绑定）。

---

## 6. 推荐方案的最小可验证切片

> 严格按 §4.6 的官方 SKILL 口径实现。所有产出落在仓库外（`TEMP`），不污染仓库。

### Slice 0 —— 探针与能力表（零风险，不改任何现有行为）
- `lib/convert/contract.js`：纯函数契约（`capabilities` 归一化、`parseFileeJson`、`classifyError`），`node:test` 直接驱动。
- `lib/convert/filee-cli.js`：`fileeBin()` 候选探测（照 `pythonBin()` 范式：`PATH` 的 `filee` → Windows 安装目录 `cli\filee.cmd` → `filee-cli.exe` → `%LOCALAPPDATA%`），缓存结果；`runFilee(args)` 统一 spawn 封装（**stdout/stderr 分流、windowsHide、超时、kill 取消**）。
- 主进程 IPC：`app:convert-capabilities` → 跑 `filee formats --json`，归一化成 `{ targets, withEngines }` 并缓存。
- UI：设置页显示 `Filee：已安装 v2.4.1 / 未安装（可选）`。
- **验收**：无 Filee 时全部功能不变、有提示；不引入任何对便签数据的行为变更。

### Slice 1 —— 单文件转换闭环
- 主进程 `app:convert`：`{ filePath, target }` → `filee convert <path> --to <target> -o <TEMP> --overwrite --json --quiet` → 解析 JSON → 只认 `state==='done'`。
- 产物落到**附件目录（外置）**并回传引用，渲染层 `insertHtml()` 插入引用。
- 失败分类：`needsEngines` → 引导去 Filee 装引擎；exit 2 → 参数/格式错；exit 3 → 无可转项；其它 → 透传 `error`。
- **验收**：用**假 CLI**（Node 脚本模拟 filee 的三种退出码与 JSON 形态）跑单测，**不依赖用户真装 Filee**。

### Slice 2 —— 能力驱动 UI + 附件外置
- 拖入文件时按能力表决定可选目标格式；缺引擎的格式给出明确引导而非静默失败。
- **附件外置**（与 §4.8 的治本方案合并设计、统一落地）。

### Slice 3 —— 后续（视反馈）
`watch` 目录模式、批量转换、预设（`filee presets --json`）、Chromium provider 补 PDF 能力。

---

## 7. 前置依赖（必须先决，否则返工）

| # | 事项 | 状态 |
|---|---|---|
| D1 | **附件/图片外置方案**（上一轮治本方案） | ⏳ 未拍板 —— **建议先定这个** |
| D2 | Filee 是否随我们分发（决定许可路径，§4.3） | ⏳ 待你回答（Q3） |
| D3 | 首发支持格式范围（是否只做"零引擎"档，§5.1） | ⏳ 待你回答（Q2） |
| D4 | 交互深度：只做"拖入→转换"（A），还是也做"右键用 Filee 打开"（B） | ⏳ 待你回答（Q1） |

---

## 8. 请你确认的 4 件事

1. **Q1**：目标是 A（便签内拖入转换）/ B（仅外部互通）/ C（vendor）？—— 我推荐 **A**，并按 §5.1 分层首发。
2. **Q2**：首发支持哪些格式？我建议**"零引擎档"优先**（图片互转 + PDF），Filee 装了就多支持 HEIC/Office/HWP。
3. **Q3**：是否接受**用户自行安装 Filee**（我们不打包、不重分发引擎）？这是许可干净的唯一路径。
4. **D1**：附件外置方案何时拍板？**建议先定它**，再开工 Filee。

> 收到确认后我会：① 落 `lib/convert/` 契约与假 CLI 单测（Slice 0+1 骨架）→ ② 接 IPC 与 UI → ③ e2e 用假 CLI 验证三态（成功/缺引擎/无输出）→ ④ 真实 Filee 冒烟（若本机已装）。
