# Filee 转换代码复用可行性核验 + 方案对比

> 日期：2026-11-16　｜　核验对象：Filee v2.4.1（tag `v2.4.1`, published 2026-11-14）
> 源码来源：`https://codeload.github.com/KnifeLemon/Filee/tar.gz/refs/heads/main`（本地解压于 `%TEMP%/Filee-main`）
> 触发原因：用户明确要求「我不想安装 filee，我想直接使用他们格式转换的代码」

---

## 0. 一句话结论

**技术上可以复用，但"直接复用"在工程上要付的代价，比"让用户装个 Filee"高一个数量级。**
推荐路线是 **B′：只把 Filee 当 CLI 依赖，不改调用方式，把"安装"变成我方的静默旁挂**；
**不建议**走 A（整包嵌入 C# 代码）。

---

## 1. 事实核验（全部来自源码/发布物，非推测）

### 1.1 代码体量与工程结构

| 工程 | .cs 文件 | 行数 | 职责 |
|---|---:|---:|---|
| `Filee.Core` | 80 | 18,056 | 领域模型：格式注册表、路由规划、转换队列 |
| `Filee.Engines` | 340 | **98,722** | 44 个 `IConverter` 实现 + 基础设施 |
| `Filee.App` | 205 | 51,244 | Avalonia UI（托盘/圆环/设置） |
| `Filee.Cli` | 8 | 1,715 | 命令行入口 |
| `Filee.Platform.Windows` | 16 | 2,344 | Explorer 检测/右键菜单/回收站 |

`Filee.Core` 明确注释「must not reference Avalonia or any OS-specific API」——
**说明 Core 是可复用的纯逻辑层，但 Core 只有 1.8 万行，真正干活的是 Engines 的 9.8 万行。**

### 1.2 转换引擎是 NuGet 包依赖，不是自研纯代码

`src/Filee.Engines/Filee.Engines.csproj` 的 `PackageReference` 列表（部分）：

```
Magick.NET-Q8-AnyCPU   PDFsharp   PDFtoImage   SkiaSharp   Svg.Skia
SharpCompress   ExcelDataReader   PdfPig   ACadSharp   AngleSharp
YamlDotNet   Tomlyn   MsgReader   SharpGLTF.Core   Unhwp   Markdig
LTRData.DiscUtils.Iso9660/Udf   System.Formats.Nrbf   MimeKitLite
```

**结论：Filee 的「零引擎档」也不是纯 C# 自研**，它靠一整条 .NET 原生/托管 NuGet 生态实现
（ImageMagick、PDFium、Skia、PDFsharp…）。要"直接用它的代码"，等于要同时分发这条生态。

### 1.3 依赖外部程序（真·需要用户装的引擎）

`src/Filee.Engines/Infrastructure/engines.json` 记录了全部可下载引擎：

| 组件 | 大小 | 性质 |
|---|---:|---|
| libreoffice | **373 MB** | 外部程序 |
| calibre | 240 MB | 外部程序 |
| ffmpeg | 100 MB | 外部程序 |
| tesseract | 50 MB | 外部程序 |
| whisper-model | 148 MB | 模型 |
| pandoc | 43 MB | 外部程序 |
| jre (Temurin 21) | 49 MB | 外部程序 |
| ghostscript | 19 MB | 外部程序（**AGPL**） |
| weasyprint | 32 MB | 外部程序（Python） |
| rhwp | 20 MB | 外部程序 |
| 7zip / exiftool / tesseract / upscayl / h2orestart / vcruntime | 1–11 MB | 外部程序 |

**这些是"不装引擎就转不了"的那部分，与"复用代码"无关** —— 用户说的"不想安装 Filee"
针对的是 **Filee 本体（132 MB 安装包）**，这些引擎是另一回事。

### 1.4 许可边界（逐个查过上游）

| 组件 | 许可 | 能否随我方安装包再分发 |
|---|---|---|
| Filee 本体 | **MIT** | ✅ 可以，须附版权声明 |
| Magick.NET / ImageMagick | Apache 2.0 | ✅ |
| PDFsharp 6.2 | MIT（**注释明确说 6.5 是 AGPL-only，锁在 6.2**） | ✅ |
| PdfPig | MIT | ✅ |
| ACadSharp | MIT | ✅ |
| SkiaSharp | MIT | ✅ |
| SharpCompress | MS-PL / MIT | ✅ |
| **Ghostscript** | **AGPL-3.0** | ❌ |
| **Pandoc** | **GPL-2.0** | ❌ |
| **calibre** | **GPL-3.0** | ❌ |
| **FFmpeg** | LGPL/GPL（构建变体各异） | ⚠️ 视构建选项 |

**结论：MIT 覆盖的是 Filee 自研部分。第三方引擎一律不能打包进我方安装包。**
`Directory.Packages.props` 里 Filee 自己已经做过这个决策（PDFsharp 锁 6.2 避开 AGPL）。

### 1.5 运行与发布形态

- `global.json`: SDK `10.0.100`（**本机只有 8.0.127 ⇒ 我方若要编译，必须装 .NET 10 SDK**）
- `build/build-installer.ps1`: `dotnet publish --self-contained -p:PublishReadyToRun=true`
  ⇒ **发布产物是 self-contained，含完整 .NET 运行时**
- 官方发布物实测：`Filee-2.4.1-win-Setup.exe` = **132.2 MB**，`win-Portable.zip` = **155.2 MB**

### 1.6 CLI 是否 headless

`src/Filee.Cli/Program.cs` → `Cli.cs` → `CliHost.cs`，**不引用 Avalonia**
（`Filee.Cli.csproj` 只引用 Core/Engines/Platform.*，无 Avalonia PackageReference）。
⇒ **CLI 可以完全无 UI 运行**，这正是我方现在调用的那条路径。

### 1.7 我方现状

```
sticky-notes/
  package.json  → electron ^33.4.11, 唯一依赖 mermaid
  无 electron-builder / 无打包配置 / 无 CI 发布流水线
```

**我方目前连自己的 Electron 安装包都没打**，直接引入一个 132MB 的 .NET 侧车，
会同时引入：.NET 10 SDK 依赖 + 交叉编译链 + 132MB 体积 + 三平台构建矩阵。

---

## 2. 路线对比

| 维度 | A. 嵌入 Filee C# 代码 | B. 保留 CLI 调用（现状） | **B′. 推荐：静默旁挂** | C. 自研零引擎档 |
|---|---|---|---|---|
| 用户要装东西 | ❌ 不用 | ⚠️ 装 Filee | ❌ **不用感知** | ❌ 不用 |
| 我方要装东西 | ⚠️ .NET 10 SDK + 交叉编译链 | ❌ | ⚠️ 下载器 | ❌ |
| 产物体积 | +132 MB（self-contained .NET） | 0 | 0（按需下载） | +2~5 MB |
| 格式覆盖 | 147 零引擎档全同 | 全同 | 全同 | 🔻 **远小于**（需自己选 10~20 个高频） |
| 跨平台 | ✅ | ✅ | ✅ | ✅ |
| 许可风险 | ⚠️ 需逐包审 NuGet 传递依赖 | ✅ 干净 | ✅ 干净（不重分发） | ✅ 干净 |
| 维护负担 | 🔴 高（要跟 .NET/Avalonia 升级） | 🟢 低 | 🟡 中 | 🟡 中 |
| 与已有代码的关系 | `lib/convert/filee-cli.js` **全部重写** | 现状 | **只改探测/引导逻辑** | 换实现层 |

---

## 3. 对用户需求的正面回应与反问

### 3.1 您的诉求是对的
"不想让用户额外装一个 132MB 的软件"是**真实痛点**，右键菜单场景尤其致命：
用户不会为了转个图先装个新工具。

### 3.2 但"直接用他们的代码"不等于"文件小"
- 要嵌入 Filee 的 C# 源码 ⇒ 我方要引入 **.NET 10 SDK**（本机现在没有）、
  **self-contained .NET 运行时（~70MB）+ SkiaSharp/ImageMagick/PDFium 原生库（~60MB）**，
  合计 **+132 MB**，与「装 Filee」的体积**完全一样**。
- 而且 Filee 的 `Filee.Core` + `Filee.Engines` 是 **11.7 万行 C#**，
  我方要新增：C# 编译链、.NET↔Node IPC 桥、跨平台 RID 矩阵、native 库打包、
  .NET 版本升级跟进。**维护成本远超省下的那一次安装动作。**

### 3.3 我的推荐：B′ 静默旁挂（保留现状架构，只改安装体验）
把「需要用户自己装 Filee」变成「**我方按需静默下载 Filee 便携版到自己的数据目录**」：

- 下载源：官方 `Filee-2.4.1-win-Portable.zip`（155 MB）或 `win-Setup.exe`（132 MB）
- 存放：`%APPDATA%/desktop-sticky-notes/tools/filee/`（用户可删，不写 Program Files）
- 探测顺序：① 已装系统 Filee → ② 我方旁挂的便携版 → ③ 提示安装
- **仍然只调 CLI** ⇒ `lib/convert/filee-cli.js` **零改动**
- 用户感知：**零**（右键 → 选格式 → 完成）

代价：首次使用需下载 132MB（可做成"设置 → 格式转换 → 立即下载"显式触发，不静默偷流量）。

### 3.4 还有一个更省的选择：C′ 缩小到"够用"的子集
如果目标只是"右键把常见格式转一下"，**未必需要 147 个格式**。
可只做**零引擎档里最常用的 15~25 个**（png/jpg/webp/gif/svg ↔ pdf、txt↔md/json/csv/xml/yaml…），
用 Node 生态的成熟库实现（sharp / pdf-lib / pdfjs…），体积 +2~5MB，无 .NET，无外部引擎。

但这会**偏离"复用 Filee"**，且效果不如 Filee 全量（版面保真度尤其）。

---

## 4. 需要您拍板的决策点

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| D1 | 是否放弃"调用 CLI"，改为嵌入 C# 代码 | (a) 放弃，走 B′；(b) 坚持嵌入，走 A | **(a)**，体积与维护都不划算 |
| D2 | Filee 本体由谁安装 | (a) 用户手动；(b) 我方静默旁挂；(c) 完全不依赖 | **(b)**，兼顾"不用装"与"不重分发" |
| D3 | 旁挂下载是否显式触发 | (a) 设置里显式点"下载"；(b) 首次右键时提示后下载 | **(a)**，不偷流量 |
| D4 | 是否同时做 C′（自研高频子集） | (a) 只做 B′；(b) B′ + C′ 并存 | **(a)** 先做 B′，C′ 作为后续可选项 |

---

## 5. 若选 B′，具体改动清单（预估）

| 文件 | 改动 | 风险 |
|---|---|---|
| `lib/convert/filee-cli.js` | **零改动**（CLI 契约不变） | 🟢 无 |
| `lib/convert/filee-cli.js`（探测函数） | 新增 `resolveFileeExe()`：系统 → 旁挂 → 空 | 🟢 低 |
| 新增 `lib/convert/filee-installer.js` | 下载便携版 + SHA256 校验 + 解压 + 原子切换 | 🟡 中 |
| `src/dashboard.html/js` | 「格式转换」弹窗加"下载转换引擎（约 132 MB）"按钮 | 🟢 低 |
| `main.js` | 接线 | 🟢 低 |
| `scripts/fake-filee.js` | 不变（测试用假 CLI） | 🟢 无 |
| 测试 | 新增 installer 单测（下载/校验/失败回退） | 🟢 低 |

**同时保留**：系统已装 Filee 时优先用系统的（用户自己的环境更可控）。

---

## 6. 关键文件位置（本地已解压源码）

```
%TEMP%/Filee-main/
  src/Filee.Core/Formats/FormatRegistry.cs        # 296 条格式定义（Known）
  src/Filee.Core/Conversion/ConverterCatalog.cs   # 引擎注册 + 可用性缓存
  src/Filee.Engines/Filee.Engines.csproj          # NuGet 依赖清单
  src/Filee.Engines/Infrastructure/engines.json   # 可下载引擎清单（含 sha256/size）
  src/Filee.Cli/Program.cs, Cli.cs, CliHost.cs    # headless CLI 入口
  build/build-installer.ps1                        # self-contained publish 证据
  Directory.Packages.props                         # 许可相关版本锁定证据
  LICENSE                                          # MIT
  skills/filee/SKILL.md                            # 官方 Agent Skill 口径
```

---

## 7. 尚未核验 / 明确未知

- **未实测**：从源码编译 Filee（缺 .NET 10 SDK，本机仅 8.0.127）⇒ 编译可行性未实证
- **未实测**：静默旁挂的下载/解压/原子切换流程（本方案新增，需实现后验证）
- **未实测**：Electron 侧调用"旁挂路径下的 filee-cli.exe"是否与当前 `filee-cli.js` 完全兼容（预计兼容，CLI 契约稳定）
- **未评估**：Filee 未来版本若改 CLI 契约的兼容策略（建议锁定版本号 + 记录 SHA256）
