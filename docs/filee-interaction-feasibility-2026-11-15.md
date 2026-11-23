# 「圆环 + 右键 + 进度环」能否复刻进本项目 —— 技术可行性判定

日期：2026-11-15　状态：**可行性判定 + 方案，尚未写产品代码**
我方栈：Electron 33.4.11（Node + Chromium），Windows 桌面便签
参照实现：Filee v2.4.1（.NET 10 + Avalonia），已完整读其源码

---

## 0. 直接结论

| Filee 的三个交互 | 能否复刻 | 难度 | 关键约束 |
|---|---|---|---|
| **① 光标处浮出圆环（Ctrl 拖拽）** | ✅ **能** | 🔴 高 | 需**原生 Win32 代码**：全局低级钩子 + OLE 拖放接收。Electron 无对应 API |
| **② 资源管理器右键菜单** | ⚠️ **能但很重** | 🔴 高 | 需**原生 DLL 注入 explorer.exe + MSIX 包**，Electron 完全无此能力 |
| **③ 进度环** | ✅ **能（且更简单）** | 🟢 中 | Electron 有 `progressBar` + 透明置顶窗口天然支持；Filee 还要处理 Avalonia 的 backdrop 污染问题 |

**总判定：技术上可行，但不是"给 Electron 加个功能"，而是要在 Electron 里塞进一个原生 Win32 插件层。**

⚠️ **一条重要更正**：上一份文档里我写「集成 Filee = 只拿到转换能力，拿不到交互」——**这个结论只针对"调用 Filee CLI"这一条路径**。如果改为**自己实现交互层**（只用 Filee 做转换后端，或干脆不用 Filee），三个交互都能做。**代价是原生代码量。**

---

## 1. 证据：Filee 的圆环到底怎么实现的

我完整读了 Filee 源码（`src/Filee.App/Services/RadialController.cs`、`Views/RadialWindow.axaml.cs`、`Services/Triggers/*`）。它的圆环是**两步配合**，缺一不可：

### 第一步：全局低级钩子检测手势

- `TriggerService.cs` → `QueuedGlobalHook.cs`：基于 **SharpHook**（libuiohook 的 .NET 封装）的 `EventLoopGlobalHook`，装 `WH_MOUSE_LL` 低级鼠标钩子 + 键盘钩子。
- `GestureDetector.cs` 是**纯状态机**（不依赖 SharpHook/Avalonia，可单测）：
  ```
  按下（带精确修饰键）→ armed
    → 移动超过阈值 → DragStarted（圆环出现）
    → 或原地不动 HoldElapsed → HoldTriggered
    → 抬起 → DragEnded
  ```
- 关键细节（Filee 自己踩过的坑，值得抄）：
  - **钩子回调必须极快**：`TriggerService.cs` 注释明确写「Windows silently removes a low-level hook whose callback takes longer than ~1 s」→ 所以 `QueuedGlobalHook` 只做入队，实际处理放到独立线程。
  - **钩子线程优先级 `Highest`**：「Windows holds every mouse move until this thread has queued it」。
  - 支持「late modifier」：先拖后按 Ctrl（Explorer 里常见）也能触发。
  - **作用域过滤**：鼠标手势按「指针下的窗口」判定（`_platform.ProcessNameAt(x,y)` / `IsFileManagerAt`），排除自身与用户排除的进程。

### 第二步：透明置顶窗口等待 OLE `DragEnter`

- `RadialWindow.axaml.cs` 注册 `DragDrop.AddDragEnterHandler(Root, OnDragEnter)` —— **文件列表是靠 OLE 拖放事件送进来的，不是靠钩子**。
- `RadialController.ShowForDrag(x, y)` 的注释写得很清楚：
  > gesture detected → an invisible window waits at the cursor (not activated) → **DragEnter brings the file list** → the donut pops out
- 窗口特性：
  - `PlaceAndShow(window, x, y, activate: false)` —— **OS 拖拽期间不能抢焦点**，否则会打断 Explorer 的拖拽（注释：*"taking focus would break Explorer's drag"*）。
  - 每次显示都 `platform.RaiseTopmost(handle)`：因为 *"Showing a window that is already marked topmost does not move it in the z-order"*，Windows 会把它压到普通窗口下面 → 拖放就送不到圆环。实现是 `SetWindowPos(HWND_TOPMOST, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE|SWP_NOOWNERZORDER)`（`WindowsPlatformServices.cs:47`）。
  - `OnDragOver` 里 **`DragEffects` 永远报 `Copy`**：`RadialWindow.axaml.cs:85` 注释——*"Reporting MOVE would make Explorer delete the source files after the drop."* ⚠️ **这是个能删用户文件的坑。**
  - 拖了但没文件（框选、拖文本）→ 10 秒后自动关闭（`EmptyDragLimit`）。
  - `DragDropEffects.None` 表示不接受时，Explorer 会显示禁止光标。

### 第三步：进度环

`DonutMenu.Progress.cs` + `RadialController`：圆环在原位变成进度环，5 秒（`HandOffAfter`）还没完就交给 toast 窗口。Filee 为此专门处理了 Avalonia 的透明窗口背景污染（`TransparentWindows.cs`：别的"美化工具"会给所有窗口加 backdrop，导致透明区变成模糊矩形 → 检测并清掉）。

---

## 2. 我方现状盘点（好消息）

| 需要的能力 | 我方已有 | 位置 |
|---|---|---|
| **全局低级鼠标钩子** | ✅ **已有** | `assets/sel-probe.py`：`WH_MOUSE_LL = 14`、`SetWindowsHookExW`、`_hook_proc`、`install_hook()` |
| **全局鼠标坐标** | ✅ 已有 | `sel-probe.py` 钩子里能拿到物理像素坐标 |
| **透明置顶无边框窗口** | ✅ **已有现成范式** | `main.js:1631 ensureOverlay()`：`frame:false, transparent:true, backgroundColor:'#00000000', hasShadow:false, skipTaskbar:true` + `setAlwaysOnTop(true,'screen-saver')` |
| **悬浮层 IPC 通道** | ✅ 已有 | `overlay:show` / `onOverlayShow` / `layoutOverlay(w,h,mode)`（主进程按内容尺寸定位+改窗口大小） |
| **文件拖入管道** | ✅ 部分 | `src/note.js` 的 `drop`/`paste` 已处理图片（`handleFiles`），但**只收 `/^image\//`** |
| **OLE 拖放接收（Electron 侧）** | ✅ Chromium 原生支持 | Electron 的 `dragenter/dragover/drop` 事件对 Explorer 文件拖拽有效；`webUtils.getPathForFile(file)` 取真实路径（Electron 32+，替代已移除的 `File.path`） |

**结论：我方已有 2/3 的地基**（钩子 + overlay 窗口），最缺的是「Electron 窗口在 OLE 拖拽中作为 drop target 接收文件列表」这一环的验证，以及「圆环 UI」本身。

---

## 3. 三个交互逐项判定

### ① 光标处圆环 —— ✅ 可行，但需要一个原生桥

**Electron 侧能做的**：
- 透明置顶窗口跟随光标（`setIgnoreMouseEvents(true, {forward:true})` + `mousemove` 定位，或像 Filee 那样由钩子直接报坐标）。
- **圆环 UI 用 HTML/CSS/SVG 画**（我方已有 `src/vendor/mermaid.min.js` 走 vendored 路线，`DonutGeometry.cs` 的扇形布局逻辑可参考）。
- 接收 `dragenter` → 拿到文件列表 → 渲染扇形 → `dragover` 高亮 → `drop` 转换。

**必须写原生代码的部分**：
| 需求 | Electron 无 API | 解决方案 |
|---|---|---|
| 检测「Ctrl + 拖拽」这类全局手势 | 无 | **已有** `sel-probe.py` 的 `WH_MOUSE_LL` 钩子，扩展即可 |
| 钩子线程不能卡（>1s 会被 Windows 摘钩） | — | Python 侧只入队，工作交主进程 |
| 拖拽期间窗口不能抢焦点 | `focusable:false` 在 Windows 上会导致按钮点不动（`main.js:1654` 注释已记录） | 用 `show:false` + 手动 `showInactive()`；Filee 用 Avalonia 的 `ShowActivated=false` |
| 拖放时窗口必须真置顶 | `setAlwaysOnTop` 标记不保证 z-order | 需 `SetWindowPos(HWND_TOPMOST, ..., SWP_NOACTIVATE)` —— **我方需加一个原生小模块** |
| 拖放时 `DragEffects` 必须报 Copy | Electron 的 `event.preventDefault()` 即可控制 accept | 需实测确认；**报错会导致 Explorer 删除源文件** |

**⚠️ 最大不确定性（必须先做 POC）**：
**Electron 的透明置顶窗口，在 Explorer 的 OLE 拖拽过程中，能否稳定收到 `dragenter`/`dragover`？**
- Chromium 的拖放实现依赖窗口的 drop target 注册；透明 + 置顶 + `setIgnoreMouseEvents` 的组合可能让 OLE 命中测试失败。
- Filee 用的是 Avalonia 的原生 OLE 注册（`RegisterDragDrop` 语义），Electron 走的是 Chromium 内部实现 —— **行为可能不同**。
- **这是整个方案的第一号风险，必须先验证再投入。**

### ② 资源管理器右键菜单 —— ⚠️ 可行，但代价远超想象

Filee 的右键菜单**不是**普通注册表项，而是：

- `build/build-explorer-menu.ps1`：用 **Zig 0.16.0** 交叉编译 `src/Filee.ExplorerMenu` 下的**纯 C 源码**为 `FileeExplorerMenu.dll`（`-nostdlib` 不带 C 运行时），再用 `build/tools/make-explorer-package.cs` 打成 **`FileeExplorerMenu.msix`**（Windows 打包 API）。
- **DLL 会被加载进 `explorer.exe`**（即 Explorer 进程内注入），提供「Convert with Filee」菜单项。
- 另有 `build/build-installer.ps1` → `src/Filee.Setup`（自研安装器）：负责 Explorer 菜单注册、Windows 11 顶级菜单包、开机启动、`filee` 命令加入 PATH、引擎页面、卸载器等。**这些全是安装器能力，从源码构建拿不到。**
- 另有 `ExplorerMenuRegistration.cs`（注册表方式的老路）与 `ExplorerMenuPackage.cs`（MSIX 新路）。

**我方若要复刻**：
1. 写一个原生 C/C++ 的 Explorer 扩展 DLL（**不能用 Node/Electron 写**）→ 需要引入 Zig 或 MSVC 构建链；
2. 打成 MSIX 或写注册表；
3. 写安装器（或提供一段 PowerShell 脚本让用户手动装）；
4. 还要处理 **Explorer 版本兼容、arm64、代码签名**（未签名的 DLL 注入 explorer.exe 可能被安全软件拦）。

**我的判断：这条路的成本 ≈ 单独做一个产品。** 而它带来的价值只是"多一个右键菜单项"。

**更优的替代方案（强烈推荐）**：
- **不做 Explorer 扩展 DLL，改用「注册表 + shell 图标覆盖」**（轻量、纯脚本、无需注入 explorer.exe），或
- **完全放弃 Explorer 右键，改成「便签内拖入 + 全局快捷键唤起圆环」**：
  - 用 `sel-probe.py` 已有的钩子，扩展一个**快捷键手势**（Filee 的 `KeyChordTriggered` 就是干这个的）→ 在任何地方按快捷键，弹出圆环，输入/粘贴路径或从剪贴板取文件。
  - **复用度最高、风险最低、完全避开 Explorer 注入**。

### ③ 进度环 —— ✅ 能，且比 Filee 简单

- Electron 天然支持 `win.setProgressBar(fraction)`（Windows 任务栏进度条）。
- 圆环内的进度动画用 CSS/SVG 即可。
- **我方比 Filee 简单的地方**：不需要处理 Avalonia 的 backdrop 污染（那是 Avalonia 特有坑）。
- 但要注意：**`filee convert` 无增量进度**（见上一份文档），只有一次性 JSON → 进度环只能做**不确定态动画**（旋转/扫描），不能做真实百分比。要真实百分比，得自己实现转换（Chromium provider）或让 Filee 暴露进度。

---

## 4. 一个我必须指出的方向性问题

**这个功能和「桌面便签」的产品定位是冲突的。**

1. **便签是"随手记"的轻量工具；圆环转换器是"生产力工具"。** Filee 花了 7 周 + 上万行代码（`Donut*.cs` 有 9 个文件 + 20 个测试文件）才做出这个交互，且有专职 UI/动画/几何团队工作量。我方把它塞进一个便签应用，会让便签变成第二个文件管理器。

2. **上一轮性能结论刚落地**（`docs/perf-input-2026-11-08-after-lowrisk.md`）：我们为「每键输入延迟」做了整整一轮优化（克隆 3→1、落盘异步化）。**全局低级鼠标钩子 + 常驻透明置顶窗口 + OLE 拖放接收，是持续性的系统级开销**，会引入新的性能变量，恰好在我们刚优化完的地方埋雷。

3. **上一轮还有一个未拍板的治本方案**（图片外置 + 每键小 patch）。**附件外置管线还没定，就先上"拖文件转格式"，等于在没打地基的地方盖三楼。**

4. **交互的唯一性代价**：Filee 的圆环要能"识别文件类型 → 给出该类型能转的目标格式"，这需要它那套 `formats` 引擎矩阵。我们若自己实现，等于把 Filee 的核心资产（255 格式的路由图）重新做一遍 —— **不如直接用 Filee 的 CLI**。

---

## 5. 方案对比

| | S1. 纯自研圆环（不依赖 Filee） | **S2. 自研交互 + Filee CLI 做后端（推荐）** | S3. 复刻 Filee Explorer 扩展 DLL | S4. 完整 fork Filee |
|---|---|---|---|---|
| 圆环交互 | ✅ 自做 | ✅ 自做 | ✅ 自做 | ✅ 直接用 |
| 格式矩阵 | ❌ 自己实现 255 格式路由 | ✅ 用 Filee 的 | ✅ 用 Filee 的 | ✅ |
| 原生代码量 | 中（钩子已有，需 OLE 桥 + 置顶） | 中（同左） | **高**（Zig/MSVC + MSIX + 签名 + 兼容） | 0（但要 fork .NET） |
| Explorer 注入 | ❌ 不做 | ❌ 不做（改快捷键/注册表） | ✅ | ✅ |
| 与便签定位冲突 | 高 | 中 | 中 | 高 |
| 依赖 Filee 单人项目 | ❌ | ⚠️ 仅后端可替换 | ⚠️ | ❌ |
| 我方工作量 | 大 | **中** | 极大 | 极大 |

### 推荐：**S2** —— 自研交互层，Filee 只做转换后端

具体形态：

```
[sel-probe.py 全局钩子]  ← 已有，扩展手势
        ↓ 手势（Ctrl+拖 / 快捷键）
[主进程]  → 置顶透明圆环窗口（新增 src/radial.html）
        ↓ OLE dragenter → 文件列表（Electron 原生，需 POC 验证）
[圆环 UI]  → 渲染可用目标格式（来自 filee formats --json）
        ↓ 用户选扇形 → drop
[Filee CLI / Chromium provider]  → 转换
        ↓
[结果]  → 附件外置目录 + 便签引用（依赖 D1 外置方案）
```

**关键设计决策**：
- **交互层自己写**（几何/动画/命中测试用 SVG + CSS，成本可控）；
- **格式矩阵与转换后端用 Filee**（`filee formats --json` 给能力，`filee convert --json --quiet` 给结果）；
- **Explorer 右键不做 DLL 注入**，改用**注册表 + 图标覆盖**（纯脚本，0 原生代码）或**全局快捷键**；
- **进度环只做不确定态**（因为 CLI 无增量进度），或用 Chromium provider 的格式做真实进度。

---

## 6. 最小可验证切片（先验证风险，不做功能）

### 🔴 POC-1（最高优先，1 天内出结论）：**Electron 窗口能否在 OLE 拖拽中收到 `dragenter`？**

这是整条路的**第一号风险**，不通过则 S2/S3 都要改设计。

**验证方法**（**纯实验脚本，不碰产品代码**）：
1. 起一个 Electron 窗口：`transparent: true, frame: false, alwaysOnTop: true, focusable: true`，`setIgnoreMouseEvents(true, {forward:true})`。
2. 渲染层监听 `dragenter` / `dragover` / `drop`，用 `webUtils.getPathForFile()` 取路径并打印。
3. 人工从 Explorer 拖一个文件到该窗口上，看是否触发。
4. **对照实验**：
   - (a) 普通 `focusable:true` 不 ignore mouse；
   - (b) `setIgnoreMouseEvents(true)` 不带 forward；
   - (c) 带 forward；
   - (d) `show:false` + `showInactive()`；
   - (e) 拖拽期间是否抢焦点导致 Explorer 拖拽中断。
5. 记录哪些组合能稳定收到 `dragenter` + 文件路径。

**产出**：`docs/poc-ole-drag-2026-11-15.md`（结论 + 最佳参数组合）。

### POC-2：全局手势钩子扩展
- 在**现有** `sel-probe.py` 上加「Ctrl + 左键按下 → 移动超阈值 → 报出坐标与按键状态」。
- ⚠️ 注意现有钩子有 `--owner-pid` 机制（防止模拟的 Ctrl+C 打到自家窗口），扩展时别破坏它。
- 验证：拖 Explorer 文件时能稳定报出坐标；**不影响 Explorer 正常拖拽**（不能吞事件、不能改光标）。

### POC-3：置顶 z-order 原生桥
- 我方需要 `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)`（Electron 的 `setAlwaysOnTop` 不保证 z-order，Filee 注释明确吃过这个亏）。
- 用 Node FFI？**不推荐**（要引 `koffi`/`ffi-napi` 原生依赖）。**建议：和 POC-2 合并进 `sel-probe.py`**（它已经在调 Win32 API 了），由 Python 侧发 IPC 指挥主进程置顶。

---

## 7. 需要你拍板

| # | 问题 | 我的建议 |
|---|---|---|
| **Q1** | 是否接受**自己写交互层**（原生钩子 + OLE 桥 + SVG 圆环）？ | 接受才谈得上实现 |
| **Q2** | **Explorer 右键菜单**走哪条路？<br>(a) DLL 注入（贵，≈ 独立产品）<br>(b) 注册表 + 图标覆盖（轻）<br>(c) **放弃**，改全局快捷键 | **⭐ (c) 或 (b)**；(a) 不建议 |
| **Q3** | 圆环触发方式？<br>(a) Ctrl+拖拽（对齐 Filee）<br>(b) **快捷键唤起**（更简单，可靠）<br>(c) 两者都要 | **先 (b)，(a) 作为增强** |
| **Q4** | 格式范围？用 Filee 全量 255 格式，还是先做常用几十种？ | 先做常用档，能力表驱动 |
| **Q5** | 是否等 **D1 附件外置方案**拍板后再开工？ | **建议先做 POC（不改产品代码），外置方案定了再实现** |

---

## 8. 我的建议路线（分三步，每步可独立中止）

```
第 0 步（现在，无产品代码改动）
   POC-1 OLE 拖放可行性 + POC-2 钩子扩展 + POC-3 置顶桥
   → 出一份「Electron 能做到哪一步」的实测结论

第 1 步（确认可行后）
   最小圆环：钩子/快捷键唤起 → 透明置顶窗口 → SVG 扇形
   → 目标格式来自 filee formats --json
   → drop 后调 filee convert → 结果回便签

第 2 步
   附件外置管线（D1）落地 → 转换产物走外置引用
   → 进度环 / 批量 / 预设
```

**第 0 步不碰任何产品代码，可以立刻做，且结论直接决定后面值不值得做。**
