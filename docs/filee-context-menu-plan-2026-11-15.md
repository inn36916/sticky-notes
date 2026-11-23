# 右键菜单 + 简单格式转换 —— 实现方案（待确认，尚未写产品代码）

日期：2026-11-15　状态：**方案阶段，未写产品代码**
我方栈：Electron 33.4.11 / Windows 桌面便签
参照：Filee v2.4.1 源码（已通读其 Explorer 集成与 CLI 实现）

---

## 0. 直接结论

**能做，而且比"圆环"方案便宜得多。** 关键突破点：

> Filee 的**经典右键菜单**（Win10 / 未装 MSIX 时的那条）**不是 DLL 注入，是纯注册表写入**。我方不需要写任何原生代码。

但有两个必须先定的岔路：

| 岔路 | 选项 | 影响 |
|---|---|---|
| **右键菜单里出什么？** | (a) 一条「用便签转换」→ 弹我方窗口选目标格式<br>(b) 一堆「转换为 JPG / PNG / PDF…」直接项 | (b) 需预注册 N 个动词，格式多了会爆炸；(a) 只需 1 个动词 ✅ |
| **"简单格式转换"指什么？** | (a) 只做 **Filee 零引擎档**（图片互转 + PDF）<br>(b) 全量 255 格式 | 建议 (a) 起步 |

---

## 1. 证据：Filee 的右键菜单到底怎么做的

我读了三处源码，结论明确 —— **它有两条路，我们只需抄便宜的那条**：

### 路线 A：现代 Win11 菜单（❌ 我们不做）

- `build/build-explorer-menu.ps1`：用 **Zig 0.16.0** 交叉编译 `src/Filee.ExplorerMenu` 的**纯 C** 源码 → `FileeExplorerMenu.dll`（`-nostdlib`，不带 C 运行时）。
- 该 DLL **被加载进 `explorer.exe`**（进程内注入），提供「Convert with Filee」菜单项。
- `build/tools/make-explorer-package.cs` 打包成 **`FileeExplorerMenu.msix`**（Windows 打包 API）。
- `src/Filee.Platform.Windows/ExplorerMenuRegistration.cs`：`Add-AppxPackage` **需要管理员权限**（一次 UAC 提示），装给所有用户；`AddAsync` 超时 3 分钟；`ERROR_CANCELLED = 1223` 表示用户拒绝。
- 未签名的稀疏包（sparse package）Windows 也接受（管理员权限下）。
- ⚠️ 代价：原生构建链 + MSIX + 签名 + Explorer 兼容 + arm64 ≈ 独立产品。**放弃。**

### 路线 B：经典右键菜单（✅ 我们走这条）

`src/Filee.Platform.Windows/WindowsPlatformServices.cs:352 WriteClassicVerb()`：

```csharp
private const string ContextMenuKey = @"Software\Classes\*\shell\Filee";

private static void WriteClassicVerb(string executablePath, string label)
{
    using var verb = Registry.CurrentUser.CreateSubKey(ContextMenuKey);
    verb.SetValue("MUIVerb", label);
    verb.SetValue("Icon", $"\"{executablePath}\",0");
    // "Player": Explorer invokes the verb once per selected file, and offers it for up to 100 files instead of 15;
    // the running instance makes one request of the calls (see SelectionLaunches).
    verb.SetValue("MultiSelectModel", "Player");
    using var command = verb.CreateSubKey("command");
    command.SetValue(null, $"\"{executablePath}\" --convert \"%1\"");
}
```

**完整机制（全部是注册表 + 快捷方式，零原生代码）：**

| 要素 | 值 | 说明 |
|---|---|---|
| 键路径 | `HKCU\Software\Classes\*\shell\<VerbName>` | `*` = 对**所有文件类型**生效；`HKCU` = **不需要管理员** |
| 菜单文字 | `MUIVerb` | 用 `MUIVerb` 而非 `(默认)` ⇒ **无需按语言做资源 DLL** |
| 图标 | `Icon` = `"<exe路径>",0` | 直接取 exe 的第 0 号图标 |
| 多选模型 | `MultiSelectModel` = `Player` | ⚠️ 见下方「坑 1」 |
| 执行命令 | `command\(默认)` = `"<exe>" --convert "%1"` | `%1` = 被右键的文件 |
| 附带入口 | `CreateShortcut(SendToShortcutPath, executablePath, "--convert", label)` | 顺便在「发送到」菜单也放一个 `.lnk` |

**卸干净只需一行**：`Registry.CurrentUser.DeleteSubKeyTree(ContextMenuKey, throwOnMissingSubKey: false)` + 删 SendTo 快捷方式。

### ⚠️ 坑 1：`MultiSelectModel=Player` 是有代价的

`src/Filee.App/Services/SelectionLaunches.cs` 的注释写得很清楚：

> One selection in Explorer can reach Filee as many launches: the classic menu entry ("%1" with MultiSelectModel "Player", the only entry on Windows 10) **starts one Filee per selected file**, in no fixed order and **over many seconds** (with 100 files, gaps of up to 0.7 s on a fast computer). No wait can tell which one is the last.

- `Player` 的收益：Explorer 对它**最多支持 100 个文件**（默认只有 15）。
- `Player` 的代价：**每个文件启动一次进程**。选 100 个 = 100 次启动，间隔可达 0.7s。
- Filee 的解法（`SelectionLaunches`）：
  - 记住 `NewRequestAfter = 1s`：`1 秒内到达的启动算同一批`；
  - `ExpectFor = 15s`：等最后一批；
  - **第一次启动时主动问文件管理器「当前选中了什么」**（`readSelection()`）→ 一次性拿到全部。
- ⚠️ 这套「问选区」的机制依赖 `IShellBrowser`/`IShellView` COM（`src/Filee.Platform.Windows/ExplorerTabs.cs`、`ShellInterop.cs`）——**我方要复刻，得写 COM 查询，复杂度不低**。
- **我方的更简替代**：单实例 + 参数聚合。第二次及以后的启动把路径传给已有实例（`second-instance` 的 argv），由主进程在 1.5s 静默窗口内聚合成一批。**不需要 COM。** ✅

### ⚠️ 坑 2：Filee 自己也把这条路由标记为"旧"吗？

`WindowsPlatformServices.cs:299`：
```csharp
if (GetModernContextMenuState(executablePath) == ModernContextMenuState.On)
    RemoveClassicVerb();     // 两条不共存
else
    WriteClassicVerb(executablePath, label);
```
**两条路线互斥**，现代菜单可用时删掉经典动词。我们只做经典动词，**不冲突**（Win11 上经典动词仍然出现在「显示更多选项」里）。

### ⚠️ 坑 3：注册表动词在 Win11 上是「次级菜单」

`HKCU\Software\Classes\*\shell\X` 注册的项，在 Win11 右键菜单里落在**「显示更多选项」**（Shift+右键 或 点"显示更多选项"）下。这不是 bug，是 Win11 的设计。**必须在 UI 里明确告诉用户"右键 → 显示更多选项"。**

---

## 2. 我方落地所需的基础设施（现状盘点）

| 需求 | 我方现状 | 缺口 |
|---|---|---|
| **主进程解析命令行参数** | ❌ **完全没有** —— `main.js:2360` 的 `second-instance` 回调是 `() => {...}`，**丢弃 argv** | 需实现 argv 解析 |
| **单实例聚合多文件** | ✅ `app.requestSingleInstanceLock()` 已有 | 需把 argv 转发给已有实例 |
| **写注册表** | ❌ 无 —— Electron **没有** registry 模块（已核实 `Object.keys(require('electron'))` 无 reg 相关） | 需 `reg.exe` 或 PowerShell |
| **Filee CLI 调用** | ⚠️ 有 `spawn`/`spawnSync` 范式（`main.js:1489 pythonBin()` 候选探测 + 缓存 + 优雅降级）✅ | 照抄写 `fileeBin()` |
| **能力表（目标格式列表）** | — | `filee formats <fmt> --json` → `{targets:[], withEngines:[]}`（已核实 `Cli.cs:429`） |
| **转换执行** | — | `filee convert --to <fmt> -o <dir> --json --quiet` |
| **便签创建** | ✅ `createNote(seed)` / `notes:create` IPC | — |
| **文件插入便签** | ⚠️ `src/note.js` `handleFiles()` **只收 `/^image\//`** | 需扩展 + 图片外置（D1 未拍板） |

**好消息：主体骨架都有，缺的是「argv 解析 + 注册表 + Filee 适配层」三块。**

---

## 3. 方案设计

### 3.1 交互形态（推荐：**单动词 + 我方窗口选格式**）

```
用户右键文件
   └─ 「显示更多选项」→ 「用桌面便签转换…」
        └─ 启动/唤醒我方便签应用，传入选中文件路径
             └─ 弹一个小窗口：显示该文件可转的目标格式
                  （来自 filee formats <ext> --json 的 targets）
                  ├─ 缺引擎的格式置灰 + 提示
                  └─ 选一个 → filee convert → 结果落到附件目录 → 建新便签并插入
```

**为什么只注册 1 个动词而不是 N 个**：
- 经典动词要**每个目标格式注册一个键**（`...\shell\ConvertToJpg`、`...\shell\ConvertToPng`…）。格式多了右键菜单会被塞爆，且注册/卸载逻辑复杂。
- 单动词 = 注册表只有 1 个键、卸载只有 1 次删除、UI 里的格式列表可**动态从能力表生成**（Filee 升级了、用户装了新引擎，菜单自动跟着变）。
- ⭐ **且我们能做得比 Filee 更好**：Filee 的经典菜单只能直接打开它的 donut；我们可以在小窗口里**按文件类型过滤**（拖进来的是 PNG 就只列图片格式）。

### 3.2 架构

```
main.js (主进程)
 ├─ argv 解析（新增）           lib/cli-args.js（纯函数，可单测）
 │    └─ 识别 --convert <paths...>
 ├─ 单实例聚合（改 second-instance）
 │    └─ 把 argv 转发给已有实例 + 1.5s 静默窗口聚合成批
 ├─ 注册表管理（新增）           lib/explorer-verb.js
 │    └─ install/uninstall + 状态查询；用 reg.exe（免管理员）
 ├─ Filee 适配层（新增）         lib/convert/filee-cli.js
 │    ├─ fileeBin() 候选探测（照 pythonBin() 范式）
 │    ├─ capabilities(ext) → {targets, withEngines}
 │    └─ convert(paths, target) → 解析 --json --quiet 结果
 └─ IPC：app:convert-capabilities / app:convert / app:install-verb
preload.js（新增桥）
 └─ installExplorerVerb() / uninstallExplorerVerb() / convertFile() / convertCapabilities()
src/convert.html + convert.js（新增小窗口）
 └─ 格式列表 UI
```

### 3.3 注册表细节（照抄 Filee，但用 `reg.exe` 实现）

**安装**（`HKCU`，**不需要管理员**）：
```
reg add "HKCU\Software\Classes\*\shell\StickyNotesConvert" /v MUIVerb /t REG_SZ /d "用桌面便签转换…" /f
reg add "HKCU\Software\Classes\*\shell\StickyNotesConvert" /v Icon /t REG_SZ /d "\"<exe路径>\",0" /f
reg add "HKCU\Software\Classes\*\shell\StickyNotesConvert" /v MultiSelectModel /t REG_SZ /d "Player" /f
reg add "HKCU\Software\Classes\*\shell\StickyNotesConvert\command" /ve /t REG_SZ /d "\"<exe>\" --convert \"%1\"" /f
```

⚠️ **Windows 的命令行转义地狱**：`reg.exe` 的引号参数极易出错。**建议改用 PowerShell `Set-ItemProperty`**（`New-Item -Path` / `New-ItemProperty`），路径和值都是独立参数，不需要嵌套引号。
⚠️ `MultiSelectModel=Player` 会导致**每个文件启动一次进程**。若我们自己有单实例聚合，**也可以先不设**（默认 `Single` → Explorer 只传第一个文件，最多 15 个），但那样多选体验差。**建议设 `Player` + 自己做 argv 聚合**（避开 Filee 的 COM 方案）。

**卸载**：
```
reg delete "HKCU\Software\Classes\*\shell\StickyNotesConvert" /f
```
（`reg delete` 递归删子树，`/f` 免确认。）

**SendTo 快捷方式**：可选增强。Filee 也做了。价值一般（右键已够），**首版可跳过**。

### 3.4 转换后端：Filee 零引擎档 vs 全量

`filee formats heic --json` 的实际输出结构（已从 `Cli.cs:429` 核实）：
```json
{ "id": "...", "displayName": "...", "extensions": [...],
  "targets": ["jpg","png","pdf",...],       // 现在就能转
  "withEngines": ["hevc","mkv",...] }       // 装了引擎才能转
```

**建议首发范围**：

| 档 | 覆盖 | 引擎依赖 | 评价 |
|---|---|---|---|
| ⭐ **零引擎档** | 图片互转（PNG/JPG/WEBP/AVIF/TIFF/BMP…）、PDF 相关、HWP/HWPX、DOCX/XLSX/PPTX | 无（147/255 格式） | Filee **内建引擎**就能做，不需下载任何东西 ✅ |
| 长尾档 | HEIC 读写、音视频、电子书、CAD/3D/字体 | FFmpeg ≈100MB / Calibre / Ghostscript | 放"需引擎"分组，引导用户去 Filee 装 |

**⚠️ 零引擎档已经覆盖了绝大多数真实诉求**（手机照片 HEIC 是例外，HEIC 读写要 FFmpeg）。这是个好消息 —— **首版不要求用户装任何引擎**。

### 3.5 结果落地：与 D1 附件外置方案的耦合（老问题，再强调一次）

上一轮性能结论：**图片必须外置**（内联 dataURL 会把 JSON 撑大，把我们刚优化掉的性能请回来）。
所以转换产物**应该直接落到附件目录 + 便签存引用**，而不是读成 dataURL 内联。

但 **D1 外置方案还没拍板**。这里有个务实的解法：

> **转换产物一律落到「附件目录」，但便签里先以「外置引用」方式存**——这正好是 D1 的第一步。
> 也就是说：**这个功能可以成为推动 D1 落地的第一个真实用例**，而不是它的障碍。

### 3.6 多文件与进度

- **多文件**：单实例聚合后一次性交给 Filee（`filee convert a.png b.png --to jpg` 支持多输入）。✅
- **进度**：⚠️ `filee convert` **无增量进度**（只有一次性 JSON）。首版只能做**不确定态动画**（转式中 spinner），不能假装有百分比。
  - 若要真实进度 → 得用 `--json` 不加 `--quiet` 时写到 **stderr** 的进度事件流（`Cli.cs:84` 的 `JobEvents(errors, ..., progress: true)`）！**这是一个可行的解法**：stderr 逐行 JSON 进度事件，可以流式解析。⚠️ 但官方 SKILL.md 特意强调要加 `--quiet`——因为它会把进度写进 stderr 干扰 stdout。我们**可以主动分流 stdout/stderr**（不合并），这样两者都能拿到。**这是个值得做的增强。**

---

## 4. 我要指出的问题

### 4.1 「右键菜单出格式选项」有个真实的取舍

你原话是"右键文件时出现转换不同文件格式的选项"。有两种做法：

| 做法 | 注册表条目数 | 优点 | 缺点 |
|---|---|---|---|
| (a) **一条「用便签转换…」→ 弹窗口选** | 1 | 菜单干净；格式列表动态；可按文件类型过滤 | 多一次点击 |
| (b) **N 条「转换为 JPG/PNG/PDF…」** | N | 一步到位 | 格式一多菜单爆炸；注册/卸载复杂；**无法按文件类型过滤**（Explorer 不支持按文件类型动态注册动词） |

**(b) 有个硬伤**：Explorer 的动词是**静态注册**的，不能根据被右键文件的类型动态变化。选一个 HEIC 右键，同样会列出「转换为 PNG」，但可能因缺引擎失败。所以 **(b) 天然会有一堆无效项**。
⇒ **强烈建议 (a)**：右键一条 → 我方窗口按该文件实际能力动态列格式 + 缺引擎的置灰提示。**这恰好是 Filee 做不到的（它的经典菜单只有一条）。**

### 4.2 Win11 上体验有折损（必须提前告知用户）

- 经典动词在 **Win11 落在「显示更多选项」**下，不是首层菜单。
- 对比：Filee 在 Win11 用的是 MSIX 现代菜单，能进首层 —— 但那是 DLL 注入路线（我们不做）。
- ⇒ **代价换来的好处**：零原生代码、零管理员权限、零签名、零 Explorer 兼容风险。
- 可以在文档/UI 里教一句："右键 → 显示更多选项"。

### 4.3 我方完全缺 argv 处理，这是个隐性大坑

`main.js:2360`：
```js
app.on('second-instance', () => {
  for (const w of noteWindows.values()) if (!w.isDestroyed()) w.show()
  openDashboard()
})
```
**回调签名是 `() => {}`，argv 被丢弃。** 而且 `app.requestSingleInstanceLock()` 拿锁时也**没有传 additionalData**。

要做右键功能，**必须先改这一层**：
- 拿锁时传附加数据，或在 `second-instance` 的 `(event, argv, workingDirectory)` 里解析 argv；
- 首实例启动时也要解析 `process.argv`（因为右键时应用可能已经开着）。

⚠️ 还有一个 Electron 细节：`process.argv` 在打包后（`app.isPackaged`）的第一个元素行为不同，且 dev 模式下是 `electron . --convert x` 形态。**要写纯函数解析器 + 单测覆盖各种 argv 形态。**

### 4.4 注册表写操作会污染用户系统，必须可控可回滚

- 我们目前**没有任何注册表操作能力**，Electron 也不提供 ⇒ 只能起 `reg.exe` / `powershell.exe` 子进程。
- **必须**：
  - **默认关闭**，由用户在设置里显式开启（并能一键卸载）；
  - 写之前**先检查是否已存在**（避免覆盖别人的同名键）；
  - **卸载必须干净**（含 SendTo 快捷方式）；
  - 写操作**失败不能崩应用**（`reg.exe` 可能被策略拦、被杀软拦）。
- 我方现成的优雅降级范式：`main.js:1489 pythonBin()`（逐候选试 + 缓存 + 失败降级 + console.warn）。**照抄这个模式。**

### 4.5 仍有 3 个产品定位问题要你想清楚

1. **「桌面便签」为什么要做格式转换？** 上一轮我提过定位冲突，现在更具体了：**右键菜单里的"便签"是一个别扭的存在** —— 用户期待的是"转换器"，不是"记笔记的东西"。Filee 在右键菜单里叫「Convert with Filee」是自然的；叫「用桌面便签转换…」就很怪。
   ⇒ **更自然的名字：「用 StickyNotes 转换…」/「StickyNotes 格式转换」**，或者干脆**把它当成独立小工具**（`sticky-notes convert` 子命令），右键菜单只是它的入口。
2. **要不要独立成一个 CLI 子命令？** 这会让它更自然：
   ```
   sticky-notes --convert file.heic          # 直接转（CI/脚本可用）
   sticky-notes --convert file.heic --to jpg  # 指定目标
   ```
   **而且这顺带解决了多文件聚合问题** —— 不依赖 Explorer 的 `MultiSelectModel` 行为。
3. **用户装不装 Filee？** 右键菜单的"转换"能力**完全依赖 Filee CLI 存在**。用户在 Explorer 里看到菜单项 → 点了 → 提示"请先安装 Filee"—— **这个体验断点很致命**。
   ⇒ **要么把 Filee 作为可选依赖并明确引导，要么改用 Electron 自带的 CLI 工具链**，**绝不能做成"点了没反应"。**

### 4.6 另一条更简单的备选：直接注册多条动词调 Filee CLI

如果连我方窗口都嫌重，最简版是：**注册表动词直接调 `filee convert "%1" --to jpg`**，完全不经过我方应用。
- 优点：零 UI、零 argv 解析、零单实例聚合，**几十行代码就能做完**。
- 缺点：目标格式写死在注册表里（就是 4.1 的 (b) 问题）；没有"按文件能力过滤"；没有"转完进便签"。
- ⭐ **但这有一个致命缺陷：需要用户在 PATH 里有 filee，且路径硬编码在注册表里**（用户换安装位置就失效）。
- ⇒ **可以作为"技术验证版"**，但不是最终形态。

---

## 5. 推荐方案与实施切片

### 推荐：**T1 —— 子命令优先 + 右键菜单接入**

| 层 | 内容 | 理由 |
|---|---|---|
| **核心** | `sticky-notes --convert <file> [--to <fmt>]` 子命令（可在 CLI 直接用） | 自然、可脚本化、不依赖 Explorer 行为 |
| **右键入口** | 1 个经典动词 → 启动我方 → 弹格式选择小窗 | 动态能力表 + 能按文件类型过滤 |
| **后端** | Filee CLI（`fileeBin()` 探测 + 优雅降级） | 复用其 255 格式与路由 |
| **兜底** | Filee 未装 → 提示 + 引导下载；**不静默失败** | 4.5.3 |

### 实施切片（每片独立可验收）

**Slice A — 纯地基（无用户可见变化，最先做）**
- `lib/cli-args.js`：**纯函数** argv 解析（`--convert` / `--to` / `--version`），`node:test` 直驱，覆盖：dev 模式 `electron . --convert x`、打包后 `app.exe --convert x`、路径含空格、多个文件、无参数。
- `lib/explorer-verb.js`：**纯函数** + 副作用分离 —— `verbKeyPath()` / `verbValues(exePath, label)` / `parseRegQuery()`；副作用层 `install()/uninstall()/status()` 用 PowerShell 调，失败降级不崩。
- 单测：注册表值拼装正确性（尤其引号转义）+ `status()` 对不存在键返回 false。

**Slice B — Filee 适配层（假 CLI 驱动，不依赖真装）**
- `lib/convert/filee-cli.js`：`fileeBin()`（照 `pythonBin()` 范式）+ `capabilities(ext)` + `convert(paths, target)`。
- **假 CLI**：写一个 Node 脚本模拟 `filee` 的三种退出码与 JSON 形态（成功 / 部分失败 / 缺引擎 `needsEngines` / exit 2 / exit 3），单测覆盖。
- ⚠️ 严格遵守官方口径：`--json --quiet`、stdout/stderr **分流不合并**、只认 `state==='done' && outputs.length>0`。

**Slice C — 子命令闭环（可 CLI 直接用）**
- 主进程接 `--convert`：解析 → 调适配层 → 结果落地 → 建便签并插入。
- e2e：用假 CLI 验证三态（成功 / 缺引擎 / 无输出）。

**Slice D — 右键菜单**
- 设置页开关（安装/卸载/状态查询）+ 首次开启的说明（含"右键 → 显示更多选项"提示）。
- 注册表写入用 PowerShell；写后**回读校验**。
- `second-instance` 改造：argv 转发 + 1.5s 聚合窗口（替代 Filee 的 COM 方案）。

**Slice E — 格式选择小窗**
- `src/convert.html/js`：按 `capabilities()` 动态列格式，缺引擎置灰 + 提示。

---

## 6. 需要你拍板

| # | 问题 | 我的建议 |
|---|---|---|
| **Q1** | 右键菜单形态：(a) 一条「用便签转换…」→ 弹窗选格式（b) N 条直接转换项 | ⭐ **(a)**（唯一能按文件能力动态过滤） |
| **Q2** | 是否同时提供 `--convert` 子命令（CLI/脚本可用）？ | ⭐ **要**（自然、可脚本化、解决多文件聚合） |
| **Q3** | 首发格式范围：零引擎档（147 种）还是全量 255？ | ⭐ **零引擎档**（不要求用户装任何引擎） |
| **Q4** | Filee 未安装时的体验：隐藏菜单项 / 点了提示引导 / 自动下载？ | ⭐ **点了明确提示 + 引导**（不做自动下载） |
| **Q5** | 是否要做**独立的小工具窗口**（不塞进便签 UI）？ | ⭐ **要**（便签里塞转换器很别扭，见 4.5.1） |
| **Q6** | D1 附件外置方案：这次一并落地还是先内联 dataURL（会退回性能问题）？ | ⭐ **一并落地外置**（这个功能正好是 D1 的第一个用例） |

---

## 7. 建议的推进顺序

```
Slice A（纯函数地基 + 单测）        ← 无用户可见变化，最安全
   ↓
Slice B（Filee 适配层 + 假 CLI）     ← 关键：不依赖用户真装 Filee
   ↓
Slice C（--convert 子命令闭环）      ← CLI 可用，验证端到端
   ↓
Slice D（右键菜单 + argv 聚合）      ← 依赖 C
   ↓
Slice E（格式选择小窗）
```

**Slice A+B 不碰任何现有行为，可以立刻开工。**
