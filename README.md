# 桌面便签（Desktop Sticky Notes）

多便签、可换色、支持截图粘贴与 Mermaid 图表的 Windows 桌面便签。默认置顶，隐藏后内容依旧保存在本地，可随时从托盘或「便签中心」找回。

---

## 一、技术方案

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Electron 33** | 唯一能同时满足「无边框透明窗口 + 多窗口独立置顶 + 剪贴板图片 + 系统托盘 + 本地文件持久化」的方案；渲染层用 Web 技术，Mermaid 可直接复用官方库 |
| 界面 | 原生 HTML / CSS / JS（无构建步骤） | 便签体量小，省掉 Vite/Rollup，改完即生效；不引入框架避免透明窗口下的重绘开销 |
| 图表 | **Mermaid 11**（本地 `src/vendor/mermaid.min.js`，离线可用） | 文本即图表，支持流程图/时序图/甘特图/饼图，SVG 输出可无损缩放 |
| 通信 | contextIsolation + preload `contextBridge` | 渲染层无 Node 权限，所有系统能力（截图、选文件、写盘）走主进程 IPC |
| 存储 | JSON 原子写 + attachments 目录 | 图片一次落盘后以稳定引用保存；完整备份同时包含 JSON 与附件目录 |

**为什么不是 Tauri / WPF / 纯 Web**
- Tauri 需要 Rust 工具链，且多窗口置顶 + 截图权限在 Windows 上更绕；
- WPF 无法直接渲染 Mermaid（需自建 WebView 宿主），等于把复杂度翻倍；
- 纯 Web 页面做不到"永远浮在桌面最上层"和"隐藏到托盘"。

---

## 二、运行

```bash
# 方式一：双击 start.bat（Windows 一键，自动装依赖）
# 方式二：命令行
npm install
npm start

# 静态门禁（全量语法 + 零循环依赖 + IPC 对齐 + 安全红线）
npm run lint
# 回归网（node:test 纯函数，无需启动 GUI）
npm test
# 带覆盖率统计的单元测试
npm run test:coverage
# 静态源码审计（防回归检查）
npm run qa:audit
# 端到端（真实 Electron + 隔离 userData + 真正的 before-quit 退出路径）
npm run test:e2e
# 串行执行全部端到端脚本
npm run test:e2e:all
```

> `test:e2e` 用 `--user-data-dir` 指向 OS 临时目录并预置 fixture，**不会碰真实便签数据**；
> 退出走主进程 `app.quit()`（`before-quit`），不用强杀代替托盘「退出」。
> 首次启动会自动生成一张带示例流程图的欢迎便签。
> 若命令行报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`，说明当前 shell 被注入了 `ELECTRON_RUN_AS_NODE=1`，用 `start.bat` 启动即可（脚本里已清除该变量）。

---

## 三、目录结构

```
sticky-notes/
├── main.js                       # 主进程引导：生命周期、落盘调度、模块装配与退出收口
├── main/                         # 主进程领域子模块
│   ├── ai-service.js             # AI 供应商配置、safeStorage 加密、流式问答与看门狗
│   ├── capture.js                # 全屏截屏选区、缩略图抓屏与全局 Esc 护栏
│   ├── edge-collapse.js          # 贴边收纳状态机与窗口几何计算
│   ├── explorer-verb.js          # Windows 右键菜单动词安装/查询（异步 PowerShell）
│   ├── global-overlay.js         # Python 鼠标钩子取词与系统级悬浮条
│   ├── ipc.js                    # 核心业务 IPC（便签、便签中心、画板、选图、日志上报）
│   ├── tray.js                   # 系统托盘菜单与状态同步
│   └── windows.js                # 多窗口生命周期管理
├── preload.js                    # 业务窗口安全桥（contextBridge 最小权限，不含 worker/读文件接口）
├── preload-worker.js             # 隐藏转换工作器专用安全桥（最小权限隔离）
├── start.bat                     # Windows 一键启动
├── jsconfig.json                 # JSDoc 静态类型检查配置
├── lib/                          # 不依赖 Electron 的纯逻辑模块（可被 node:test 直接驱动）
│   ├── utils.js                  # 双环境公共工具（escapeHtml / clamp / SAFE_NAME）
│   ├── cli-args.js               # --convert 命令行参数解析
│   ├── dom-snapshot.js           # 渲染层单次 DOM 克隆快照（前后端共用）
│   ├── explorer-verb.js          # 注册表动词 PowerShell 脚本生成器与状态解析
│   ├── geometry.js               # 展开态 bounds 断言 / captureBounds / 污染自愈
│   ├── migrations.js             # state 版本迁移注册表 + 归一化（保留未知字段）
│   ├── persistence.js            # 原子写 / 串行写队列 / 损坏备份 / 升级前快照 / 按天快照
│   ├── save-worker.js            # worker_threads 写盘工作线程
│   ├── save-writer.js            # 异步落盘调度器（generation 语义防乱序）
│   ├── secret-codec.js           # AI API Key 加密编解码（safeStorage 包装）
│   ├── watchdog.js               # 流式请求看门狗（空闲超时 + 总时长上限）
│   └── convert/                  # 可插拔格式转换引擎
│       ├── filee-cli.js          # Filee CLI 适配层（可选增强）
│       ├── main-bridge.js        # Electron sticky-att:// 协议与 convert:* IPC 胶水
│       ├── plugins.js            # 插件发现、契约校验与加载
│       ├── provider.js           # provider 契约与注册表
│       ├── router.js             # 多引擎格式路由
│       ├── service.js            # 转换服务编排与临时工作目录隔离
│       ├── worker-host.js        # 转换工作器窗口宿主与 reqId 并发匹配
│       └── providers/            # 内置 provider（图片/PDF/文本数据/动图判定/Filee）
├── examples/convert-plugins/     # 示例转换插件（svg.js）
├── test/                         # 单元测试套件（npm test）
├── scripts/                      # 静态门禁（lint.js）、审计（qa-audit.js）与 Electron E2E 脚本
├── docs/                         # 架构评估、PRD 与性能报告文档
├── assets/                       # 应用图标与 sel-probe.py（全局鼠标钩子探针）
└── src/                          # 多窗口渲染层页面与样式（含 guard.js 全局异常兜底与 vendor/）
```

数据落在 `%APPDATA%\desktop-sticky-notes\sticky-notes.json`（托盘菜单 →「打开数据目录」可直接跳转）。
同目录下的 `app-errors.log` 记录主进程 / 渲染层异常（超过 512KB 滚动为 `.1`），排查问题时可先看它。

---

## 四、需求 → 实现对照
### 1. 多个不同颜色的便签

- 每张便签是**独立的 `BrowserWindow`**（`frame:false` + `transparent:true`），互不干扰，可各自置顶/移动/缩放。
- 8 组预设色 + 任意自定义色（`main.js` → `createNote`，`note.js` → `PALETTE`）。
- 换色时自动推导前景色：

```js
const lum = luminance(rgb)                       // WCAG 相对亮度
const dark = lum < 0.42                          // 深色便签走浅色文字
const fg = dark ? mix(rgb, WHITE, 0.10) : mix(rgb, BLACK, 0.09)
```

所以选深灰 `#2C2E33` 会自动变成"深色便签 + 浅色字"，选浅黄则相反——不需要为每个主题手写两套样式。

### 2. 文字输入

`contenteditable` 编辑器 + 工具栏（`document.execCommand`）：

加粗 / 斜体 / 下划线 / 删除线 / 字号增减 / 文字颜色 / 有序·无序列表 / 清除格式。

粘贴外部 HTML 会先过白名单清洗（`sanitizeHtml`），只保留 `p/ul/li/b/img/table` 等结构标签，剥掉外部 class、style、脚本，避免把网页样式带进便签。

### 3. 粘贴 / 插入截图

| 入口 | 实现 |
|---|---|
| `Ctrl+V` 粘贴 | `paste` 事件读 `clipboardData.items` 里的 `image/*` → `FileReader` → 压缩 → 插入 |
| 拖拽图片文件 | `drop` 事件 → 同一处理链路 |
| 选择本地图片 | 主进程 `dialog.showOpenDialog` → 读文件转 dataURL |
| 截屏 | 打开独立的截图编辑器（框选 + 标注），详见第 10 节 |

插入前统一压缩（`compressImage`）：

```js
const scale = Math.min(1, 1600 / Math.max(w, h))   // 最长边 1600
if (!needResize && dataUrl.length < 700 * 1024) return dataUrl
// 大图重编码：PNG 优先，压不下来退 JPEG 0.86
```

截屏走独立编辑器：先隐藏便签、打开选区层，**确认选区后**才抓取该区域，所以不会把便签自己拍进去（见第 10 节）。

### 4. Mermaid 图表组件

图表以「块」的形式存在正文里，而不是单纯的图片：

```html
<div class="mmd" contenteditable="false" data-code="graph LR&#10;A-->B">
  <div class="mmd-tools">✎ ✕</div>
  <div class="mmd-body"><!-- 渲染出的 SVG --></div>
</div>
```

- 工具栏「图表」→ 弹窗写代码 → **实时预览** → 插入；
- hover 图块出现「编辑 / 删除」，改完代码重新渲染；
- 落盘时**只存 `data-code`，不存 SVG**（`serializeHtml` 会清空 `.mmd-body`），JSON 不会被几 MB 的 SVG 撑爆，重新打开时按源码重渲染；
- SVG 按 `viewBox` 计算 `max-width: min(100%, 原始宽度)`：小图保持原尺寸，大图等比缩到便签宽度，不会横向溢出；
- 图表配色跟随便签：`mermaid.initialize({ theme:'base', themeVariables:{ ... } })` 里把 `primaryColor / edgeLabelBackground / textColor` 全部换成当前便签的色系，深色便签上图也会自动变成深底浅字。

### 5. 字体 / 字号 / 尺寸 / 外观

每张便签独立保存一份 `theme`，全部通过 CSS 变量落到 `.note` 上：

| 可调项 | 实现 |
|---|---|
| 字体 | `--font-family`（内置雅黑/宋体/楷体/黑体/等线/Consolas/Segoe UI） |
| 字号 | `--fs`（11–34px，工具栏 A+/A- 同步） |
| 行距 | `--lh`（1.2–2.6） |
| 圆角 | `--radius`（0–26px） |
| 不透明度 | 节点 `opacity`（55%–100%，窗口本身透明，透出桌面） |
| 外阴影 | `data-shadow` 切 `box-shadow` |
| 尺寸 | 面板直接输入宽×高，或拖拽**八个方向**的缩放手柄 |
| 工具栏显隐 | `data-toolbar` |

窗口没有系统边框，缩放由 8 个 `pointerdown` 手柄 + `setPointerCapture` 实现，`requestAnimationFrame` 节流后调 IPC `setBounds`，松手即落盘。

### 6. 默认置顶

```js
alwaysOnTop: true                                    // 新建便签默认 true
win.setAlwaysOnTop(note.alwaysOnTop, 'screen-saver')  // 层级高于普通窗口
```

- 层级用 `screen-saver`，全屏应用之上也压得住；
- `skipTaskbar: true`，便签不占任务栏；
- 顶栏图钉可随时取消置顶（状态逐张便签保存）；
- 取消置顶后便签仍是一个无边框独立窗口，只是不再压住其他程序。

### 7. 隐藏 ≠ 丢失

这是整个应用的核心状态机：

```
新建 → visible:true ──「—」/关闭按钮──▶ visible:false（窗口 hide，数据保留）
                    ◀── 托盘项 / 便签中心「显示」── 重新 show 或重建窗口
```

- 点「—」或窗口关闭按钮 → **只 `win.hide()` + 写 `visible:false`**，进程和页面都还在，定时保存继续跑；
- 系统托盘常驻，右键菜单列出所有便签（`● 已显示 / ○ 已隐藏`），点一下即切换；
- 「便签中心」窗口以卡片网格列出**全部**便签：标题、内容预览、最后修改时间、显示/隐藏状态，隐藏的便签卡片会置灰但**内容预览照常可见**；
- 所有改动 350ms 防抖写盘，写盘用 `写临时文件 → rename` 原子替换，断电不会写坏 JSON；
- 应用重启时按 `visible` 字段恢复：该显示的重新创建窗口，该隐藏的保持不显示。

**数据不会被"隐藏"动作删除**，只有显式点「删除便签」并从确认框确认才会移出数据文件。

### 8. 可视化画板（类似 draw.io）

工具栏倒数第二个图钉状虚线框按钮 → 打开独立的 **Mermaid 画板**窗口（`src/diagram.html`）。

```
┌──────────────────────────────────────────────────────────┐
│ 画板   [选择][连线]  [撤销][重做]  方向▾  清空    取消 应用 │
├────────┬─────────────────────────────────┬───────────────┤
│ 组件    │                                 │ 属性           │
│ 矩形    │        拖拽画布（2400×1600）      │ 文字 / 形状     │
│ 圆角    │        节点 + 箭头连线            │ 填充 / 边框     │
│ 判断    │                                 │ 宽高 / 删除     │
│ …8 种   │                                 │               │
├────────┴─────────────────────────────────┴───────────────┤
│ Mermaid 代码（实时生成，可复制/折叠）                       │
└──────────────────────────────────────────────────────────┘
```

**画布实现**：纯 SVG（`<g>` + `<rect>/<polygon>/<path>` + `<foreignObject>` 文字），不引第三方图形库。

- **拖组件**：`pointerdown` 在组件面板 → 跟随幽灵 → `pointerup` 落在画布上创建节点（落点即中心，自动弹出文字输入框）
- **移动节点**：`pointerdown` 节点 → `setPointerCapture` → 每帧更新 `transform`，只重绘连线不重绘节点
- **连线**：节点 hover 出 4 个端口圆点，从任意端口拖到另一个节点即建边；也可切「连线」模式整块拖
- **坐标换算**：`svg.createSVGPoint().matrixTransform(svg.getScreenCTM().inverse())`，自动兼容画布缩放（`zoom` 0.4–1.6）
- **撤销/重做**：每次变更前 `JSON.stringify({nodes,edges,dir})` 入栈（上限 80 步）

**生成代码**：按方向（TD/LR）对节点排序后输出 `graph TD` + 形状语法：

| 组件 | Mermaid 语法 |
|---|---|
| 矩形 / 圆角 / 胶囊 | `A[文字]` / `A(文字)` / `A([文字])` |
| 判断 / 圆形 / 六边形 | `A{文字}` / `A((文字))` / `A{{文字}}` |
| 数据库 / 子程序 | `A[(文字)]` / `A[[文字]]` |
| 连线（实/虚/粗） | `-->` / `-.->` / `==>`，带标签 `-->|是|` |

> 节点坐标不进入代码——Mermaid 是自动布局引擎，画板负责**拓扑与顺序**，最终排版交给 Mermaid。这是"所见即所得"和"合法 Mermaid 代码"之间必须做的取舍。

**双向回写**：
- 便签里已有图表 → 图块 hover 出 `▦` → 带着 `data-code` 打开画板，自动**反解析**成图形（`parseMermaid` 支持节点/边/形状/标签）
- 点「应用到便签」→ IPC 回传 `{code, blockId}` → **有 blockId 原地替换，没有则插入新块**，画板自动关闭
- 打开画板时便签临时取消置顶（`suppressNoteTop`），关闭后按各自设置恢复，避免画板被便签压住

### 9. 阅读模式

顶栏最左的**眼睛按钮**切换，状态存在 `note.mode`（`'edit' | 'read'`），重启保持。

| | 编辑模式 | 阅读模式 |
|---|---|---|
| 工具栏 / 状态栏 | 常显 | **完全隐藏** |
| 正文 `contenteditable` | `true` | `false`（可选中复制，不可改） |
| 图表块 `✎ ▦ ✕` | 显示 | 隐藏 |
| 顶栏按钮 | 常显 | **默认 opacity:0 + pointer-events:none**，鼠标进入便签才浮出 |
| 标题 | 可编辑 | 只读 |

浮出的按钮组带半透明底 + `backdrop-filter: blur()` + 阴影，压在内容上也不影响阅读；按钮里有：编辑（铅笔）、置顶、设置、隐藏。

一致性保障：

```js
// 唯一入口：dataset / contentEditable / 持久化 三者永远同步
function setMode (mode) {
  NOTE.mode = m                     // 1. 内存
  applyMode()                       // 2. DOM（data-mode + contenteditable）
  queueSave({ mode: m })            // 3. 落盘
}
```
- 切阅读模式时自动收起设置面板和图表弹窗，避免"隐藏了按钮却留着弹窗"
- 阅读模式下**双击正文**也能回到编辑，不用先找按钮
- 外部（便签中心/多窗口）改动的 mode 通过 `notes:changed` 回灌，同一函数收口
- hover 除了 CSS `:hover`，另加 `mouseenter/mouseleave` 打的 `.hovering` 类兜底，覆盖"未聚焦窗口不更新 `:hover`"的个别环境

### 10. 截图工具（框选 + 标注）

便签工具栏的**相机按钮** → 打开独立截图编辑器（`src/capture.html`，覆盖当前显示器的全屏无边框窗口）。

#### 10.1 交互流程

**鼠标移到哪就预选哪块窗口；点一下就截，拖一下就自定义，松手即出工具栏。**

```
点相机
  ↓
主进程：开全屏透明选区层 → show 后 setBounds 铺满整块屏幕（含任务栏）
        → 拿到前台焦点 → 再隐藏便签（顺序反了前台会掉给别的应用）
        → 抓一张 1/2 缩略图，只用于算边缘（1 采样点 = 2 DIP）
  ↓
[框选阶段]
  · 鼠标移动    → 实时识别光标下的窗口块，青色虚线预选 + 尺寸标签
  · 单击        → 采用预选区域，立即抓取
  · 拖拽        → 自定义区域，松手立即抓取
  · 拖手柄/内部 → 调整已有选区，松手重新抓取
  ↓（抓取：隐藏 UI → 抓整屏 → 按选区裁剪 → 贴回选区位置）
[标注阶段] 工具栏立即出现
  ↓
插入便签 / 复制到剪贴板 / 保存到文件 —— 三者都是终态动作，执行后关闭窗口
Esc /「取消」→ 关闭、恢复便签
```

全程没有"确认选区"这一步：**松手（或单击）就是确认**。想改就再点/再拖，或者点工具栏的「重新框选」。

#### 10.2 状态管理

两层状态：`phase` 管大阶段，`stage` 管当前手势。

| phase | 含义 | 界面 |
|---|---|---|
| `select` | 框选阶段 | 无工具栏；有青色虚线预选框 + 尺寸标签 |
| `grabbing` | 抓取中（约 150ms）| 所有 UI `visibility:hidden`，让桌面以原样被拍到 |
| `annotate` | 标注阶段 | 裁剪图贴回选区，工具栏全功能，手柄隐藏 |

| stage | 含义 | 进入条件 | 退出 |
|---|---|---|---|
| `idle` | 无有效选区 | 初始 / 选区 < 8px / 点空白 | 拖出有效选区 / 单击采用候选 |
| `pending` | 按下但还没移动 | `select` 阶段在选区外按下 | 位移 > 6px 转 `new`；松手转抓取 |
| `new` | 正在拖拽框选 | 由 `pending` 升级 | 松手 → 抓取 |
| `move` / `resize` | 调整已有选区 | 在选区内按下 / 按住手柄 | 松手 → 重新抓取 |
| `ready` | 选区已抓取 | 抓取完成 | 开始绘制或输入文字 |
| `drawing` | 正在拖一个标注 | 标注阶段在选区内按下 | 松手提交 |
| `texting` | 文字输入框激活 | 文字工具点击选区 | Enter / 失焦 / Esc |

`pending` 是关键一环：**同一个按下动作，位移小于 6px 算"点选窗口"，大于 6px 算"拖拽框选"**，靠位移阈值区分，不需要用户先选模式。

派生规则集中在 `updateUI()` + `setPhase()`：工具栏仅 `annotate` 阶段显示、提示语、撤销按钮状态。

#### 10.3 框选与吸附

- **8 向手柄**：`nw/n/ne/w/e/sw/se`，拖拽时按方向改对应的两条边，交叉方向允许翻转（自动 `Math.min` 归一化）
- **反向拖**：从右下往左上拖同样有效，记录的是 `min/max` 而不是起点终点
- **尺寸提示**：右上角实时显示 `宽 × 高`，选区贴到屏幕顶部时标签自动翻到下方（`.sel-size.below`）
- **坐标提示**：光标本位坐标，选区就绪后改为**选区内相对坐标**，跟随光标并自动避让屏幕边缘
- **遮罩**：`.sel` 用 `box-shadow: 0 0 0 100vmax rgba(8,10,14,.48)` 压暗外部，无需额外的 mask 元素

**边界检测**（无 OS API，纯图像分析）。三步各自对应一个曾经把边界算歪的原因：

1. **采样用 1/2 缩略图，不是 1/4**
   1/4 时一个采样点覆盖 4 DIP，边缘位置只能落在 4 的倍数上，视觉上"一格一格跳"。现在 1 采样点 = 2 DIP，配合亚像素定位，实测误差 ≤1 DIP。

2. **打分用「连续长度」，不是「梯度总和」**

```js
// 对每一列：统计垂直方向上"连续是边缘"的最长长度
for (let y = 0; y < h; y++) {
  if (Math.abs(gray[x+1, y] - gray[x-1, y]) >= 12) { run++; best = Math.max(best, run) }
  else run = 0
}
colScore[x] = best / h          // 归一化到 0..1
```

梯度总和的旧做法里，一段密集文字（几十行短横线）累加起来能盖过窗口边框 —— 这正是"吸到内部分隔线而不是窗口边界"的根因。连续长度直接对应物理特征：

| 对象 | 连续长度 | 得分 |
|---|---|---|
| 窗口 / 面板外框 | 贯穿整窗 | 0.90 ~ 1.00 |
| 文字段落 | 一行字高 | 0.30 ~ 0.40 |
| 图标、按钮 | 十几像素 | < 0.10 |

3. **取点用「平台中心」，不是「平台首值」**
一条 2px 的边框经过中心差分，会在 4 个采样点上得到**相同的最大值**。取第一个索引会稳定偏 -1.5px；取平台中点正好回到边框中央。单点峰则退回抛物线插值。

**阈值**：只认"连续长度 ≥ 全局最强边 55%"的线（文字行约占 33%~50%，能被干净滤掉）。

**吸附**（`snapAxis`）：

- 容差固定 **10 DIP**（不是 10 个缩略图像素），换分辨率行为不变
- 容差内取**得分最高**的那条，不是最近的那条
- 命中后画一条青色全屏参考线（`.snap-line`）

**悬停识别**（`detectRect`）：从落点向四个方向各扫 420 DIP，取范围内**最强**的边围成矩形（不是"遇到第一条就停"）。

**悬停预选**：鼠标移动时（`requestAnimationFrame` 节流）用 `detectRect` 算出光标下的窗口块，画成青色虚线。判定规则：

- 宽 < 60 或 高 < 40 → 太小，不高亮
- 覆盖 ≥ 96% 屏幕 → 认为"没识别到窗口"，也不高亮（避免整屏虚线闪来闪去）
- 单击时按**落点**重新算一次，不复用可能过期的 `hoverRect`

**实测精度**（同一屏，与全分辨率真值比对）：

| 场景 | 检测值 | 全分辨率真值 | 偏差 |
|---|---|---|---|
| 悬停识别左边界 | 624.0 px | 624 px | **0.0 px** |
| 拖到 230 DIP 处吸附 | 223 DIP | 224 DIP | **1.0 DIP** |
| 合成图 2px 边框定位 | 99.5 / 698.5 | 100.5 / 699.5 | 1 px（边框半宽） |

最后一项的 1px 是"平台中心 vs 边框左缘"的定义差，不是漂移 —— 真机上的窗口边框多为 1px，实际偏差 < 1 DIP。

自检入口：`window.__captureDebug` 暴露了 `computeEdgeScores / refinePeak / detectRect / snapAxis`，可以在 DevTools 里用构造灰度图直接验证。

#### 10.4 标注能力

| 工具 | 数据结构 | 绘制 |
|---|---|---|
| 矩形 | `{x,y,w,h,color,width}` | `strokeRect` |
| 椭圆 | 同上 | `ctx.ellipse` |
| 箭头 | `{x1,y1,x2,y2}` | 线段 + 两条按 `atan2` 算出的箭头边 |
| 画笔 | `{points:[{x,y}...]}` | 折线路径，采样点随 `pointermove` 追加 |
| 马赛克 | `{x,y,w,h}` | 从**原图**取该区域 → 缩到 1/9 分辨率 → 关闭插值放大回填 |
| 文字 | `{x,y,text,color,size}` | `fillText` + 半透明描边保证深浅背景都可读 |

马赛克这一项有个容易踩的坑：**不能从当前 canvas 取样**（会取到已画的标注），必须从原始截图 `img` 按 `(sel + shape) × dpr` 偏移取样。

颜色 8 色 + 自定义取色；粗细 1–14px；字号 12–56px（切到文字工具时显示字号、隐藏粗细）。

**文字输入**：点选区内位置 → 在该处浮出 `textarea`（字号/颜色实时跟随）→ Enter 提交、Shift+Enter 换行、Esc 放弃、失焦也提交。提交前先把 `stage` 切走，避免 `hide()` 触发的 blur 二次提交造成文字重影。

#### 10.5 撤销 / 重做

矢量快照栈（不是像素快照）：

```js
history.push(JSON.stringify(shapes))   // 上限 60 步
undo / redo 只移动 hIdx 指针并恢复 shapes，再整体重绘
```
只有"提交一个标注"才入栈，拖动过程中的中间态不入栈，所以撤销粒度 = 一个标注。

#### 10.6 截图时机与坐标一致性

确认选区后，渲染层先把窗口内容全部 `visibility:hidden`，等两帧 + 120ms 让合成器刷新，再由主进程抓屏裁剪：

```js
// 渲染层：选区相对窗口 → 相对显示器
const rect = { x: sel.x + align.dx, y: sel.y + align.dy, w: sel.w, h: sel.h }
// 主进程：DIP → 物理像素，并 clamp 到图像边界
const img = full.crop({
  x: Math.round(rect.x * scale),  y: Math.round(rect.y * scale),
  width: Math.round(rect.w * scale), height: Math.round(rect.h * scale)
})
```

- `align` = 窗口实际 `getBounds()` 与显示器 `bounds` 的差值，抵消任务栏/DPI 取整带来的偏移
- 窗口是透明无边框的，内容隐藏后完全透明，抓到的就是干净桌面，**不会把遮罩和选框拍进去**
- 裁剪在 `nativeImage.crop` 里完成（物理像素），所以导出必然是**屏幕原生分辨率**：实测 480×360 的选区得到 600×450（125% 缩放）
- 裁剪图再贴回选区位置做标注背景，标注坐标系与框选时完全一致

#### 10.7 三个输出动作

工具栏右侧三个按钮，都是"完成"语义，执行后关闭截图窗口并恢复便签：

| 动作 | 快捷键 | 实现 | 结果 |
|---|---|---|---|
| 插入便签 | `Enter` | `capture:done` → 便签 `insertImageDataUrl` | 便签里多一张图，自动切到编辑模式 |
| 复制到剪贴板 | `Ctrl+C` | 主进程 `nativeImage.createFromDataURL` → `clipboard.writeImage` | 可直接粘到微信/文档/画图 |
| 保存到文件 | `Ctrl+S` | `dialog.showSaveDialog`（默认落在图片目录，文件名 `截图_时间戳.png`）→ `fs.writeFileSync` | 保存对话框里取消则不关闭窗口，可继续操作 |

三者共用同一条导出链路：

```js
function exportPng () {
  if (draft) { shapes.push(draft); draft = null }   // 把未提交的笔画也算进去
  renderAll()
  return canvas.toDataURL('image/png')
}
```

「重新框选」（工具栏左侧第一个图标）回到 `select` 阶段并清空标注，用于选错了想重来。

#### 10.8 边界情况处理

| 情况 | 处理 |
|---|---|
| 选区 < 8×8 | 视为无效：隐藏选区、隐藏工具栏、回到 `idle`，完成时给提示 |
| 拖出屏幕外 | `setSel` 里对 x/y/w/h 全部 `clamp`，不会出现负坐标 |
| 反向拖拽 | `min/max` 归一化，方向不影响结果 |
| 拖动中鼠标移出窗口 | `setPointerCapture` 到 `body`，事件不丢 |
| 文字为空 | 只关闭输入框，不产生 shape |
| Esc 分级响应 | 输入中 → 取消输入；绘制中 → 丢弃当前笔；否则 → 关闭截图窗口（窗口无焦点时由全局 Esc 兜底转发） |
| 空选区按 Enter | `annotate` 阶段才响应；`select` 阶段松手即抓取，不存在"空选区确认" |
| 点在空白处 / 识别失败 | 清除选区回到 `idle`，重新移动鼠标或拖拽即可 |
| 悬停识别不到窗口 | 不显示虚线预选，直接拖拽框选，功能不受影响 |
| 抓取失败 / 图为空 | 回到框选阶段并 toast 提示，选区保留，可直接重试 |
| 缩略图抓取失败 | 只打一条告警，吸附与双击识别退化，框选和截图仍可用 |
| 抓取瞬间的遮挡 | 窗口内容此刻已隐藏，拍到的就是真实桌面（不含遮罩与选框）|
| 选区贴边 / 超出屏幕 | 主进程裁剪前把源矩形 clamp 到图像范围，不会抛错也不会出黑边 |
| 便签原本隐藏 | 截图完成后把它置为可见并显示，否则用户"截完图什么都没看到" |
| 便签是阅读模式 | 回插后自动切回编辑模式，否则看不到插入结果 |
| 隐藏窗口里插入图片 | `execCommand` 在无焦点窗口会静默失败，改用 Range API 直接操作 DOM |
| 多显示器 | 只截鼠标所在的那块屏（`getDisplayNearestPoint`），覆盖层与该屏 bounds 对齐 |
| 高 DPI | 全程 DIP 坐标 + `dpr` 换算，导出为物理像素 |
| 截图期间再次点相机 | 主进程返回 `{error:'截图正在进行中'}`，不会开第二个窗口 |

#### 10.9 两个必须知道的平台坑

**① 底部那条空白 = 窗口被裁到工作区**

Windows 会把「隐藏状态下创建的无边框透明窗口」的高度压到**工作区**（`workArea`），而不是显示器 `bounds`。实测 1536×864 的屏幕，创建出来只有 1536×816 —— 正好少一条 48 DIP 的任务栏。表现就是屏幕最下面一条既没有遮罩、也框选不到，看着像一块空白。

`enableLargerThanScreen` 只对 macOS 生效，救不了。唯一可靠的做法是 **show 之后再 setBounds 一次**：

```js
win.show()
win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })  // 此时才生效
win.setAlwaysOnTop(true, 'screen-saver')   // 盖住任务栏
win.moveTop(); win.focus()
```

渲染进程那边 `viewW/viewH` 也不能只在 init 时读一次，改成 `syncViewport()` + `resize` 监听，`updateUI()` 和 `onDown()` 入口各同步一次，避免"窗口已经 864 高、逻辑还按 816 算"。

**② Esc 收不到 = 窗口根本没键盘焦点**

透明无边框窗口铺满全屏，看着像"当前窗口"，但 `document.hasFocus()` 可能是 `false`：如果先隐藏便签再开选区层，前台会掉给别的应用（如浏览器），此时 `win.focus()` 被 Windows 的前台锁拒绝，所有按键都进了别的应用。

三层解决：

| 层 | 做法 |
|---|---|
| 顺序 | **先 show 选区层、拿到前台，再隐藏便签**，前台不会中途易主 |
| 兜底 | 会话期间 `globalShortcut.register('Escape')`，主进程收到后 `send('capture:escape')` 转发给渲染进程 |
| 分级 | 渲染进程 `handleEscape()` 是唯一出口：输入中 → 取消输入；绘制中 → 丢弃当前笔；否则 → 退出 |

主进程只转发、不直接关窗，是为了保住"打字时 Esc 只取消输入"这层分级。两条路径（窗口内 `keydown` 与全局转发）走同一个 `handleEscape()`，行为不会分叉。

保存对话框打开前要 `releaseEscGuard()`，否则「Esc 关掉保存框」会被我们截走；取消后再注册回来。

**事件绑定时机**：`bindEvents()` 必须在脚本加载时立刻执行，不能等 `capture:init` —— 主进程要等缩略图解码完才发 init，那之前按键是死的。

### 11. 图片放大查看

便签里的图片点一下就能放大到独立窗口里看，不受便签小窗口的限制。

#### 触发条件

| 模式 | 操作 | 说明 |
|---|---|---|
| 阅读模式 | **单击**图片 | 阅读态下单击不涉及选中，直接放大 |
| 编辑模式 | **双击**图片 | 单击是选中图片（准备删除），所以用双击 |

两种模式下图片光标都是 `zoom-in`。

#### 预览窗口

- 独立 `BrowserWindow`（最大 1120×840，居中），置顶于便签之上
- 初始按窗口"适应"，且不会放大小图（`scale ≤ 1`）
- **滚轮缩放** 10%–800%，以光标位置为锚点
- **拖拽平移**
- **双击**在"适应窗口"与"1:1"之间切换
- `Esc` / 「关闭」退出；`0` 适应窗口，`1` 原始尺寸
- 底部状态栏显示原始像素尺寸与当前缩放比例

#### 实现要点

- 复用同一个窗口：连续点不同图片只换图（`preview:init`），不叠一堆窗口
- 变换用 `transform: translate() scale()`，`transform-origin: center`，平移缩放不触发重排
- 缩放锚点保持光标下的像素不动：

```js
tx = cx - (cx - tx) * (next / old)
ty = cy - (cy - ty) * (next / old)
```

---

### 12. 自定义 AI 供应商 + 划词操作

便签中心右上角「AI 供应商」打开配置页，填完就能在任意页面划词用 AI。

#### 12.1 配置页

| 字段 | 说明 |
|---|---|
| 名称 | 可选；留空用域名兜底 |
| Base URL | `https://api.xxx.com/v1`。不带 `/v1` 会自动再试一次；误把整条 `/chat/completions` 贴进来也会被裁掉 |
| API Key | **只存在主进程**，渲染进程只拿到 `sk-••••••7890` 这样的掩码；留空表示不修改 |
| 默认模型 | 拉取成功后从下拉里选；拉不到也可以手填模型 ID |
| 设为当前使用 | 划词时调用哪个供应商；左侧列表里绿点即当前使用 |

- 填完 Base URL + API Key 后 **800ms 防抖自动拉取**（也保留了「重新拉取」按钮）
- 支持多个供应商，左侧列表切换，右侧表单随之切换

#### 12.2 拉取模型：地址和返回格式都不猜死

```js
const 候选 = [base + '/models']
if (!/\/v\d+$/.test(base)) 候选.push(base + '/v1/models')   // 用户少写 /v1 时兜底
// 401/403 直接停（换地址也没用）；404/405/网络错误才试下一个
```

返回结构兼容三种：

| 来源 | 结构 |
|---|---|
| OpenAI / 兼容网关 | `{ "data": [{ "id": "gpt-4o-mini" }] }` |
| Ollama | `{ "models": [{ "name": "qwen2.5" }] }` |
| Gemini 兼容层 | `{ "models": [{ "name": "models/gemini-2.0-flash" }] }`（`models/` 前缀会剥掉） |

去重 + 字典序排序后回填下拉。

#### 12.3 划词工具条

选中 ≥ 2 个字符 → 选区上方（空间不够就下方）浮出「AI 搜索 / 解释 / 翻译」；点击任一项 → 选区下方展开结果卡片，逐字流式输出。

| 触发 | 行为 |
|---|---|
| `mouseup` / `Shift+方向键` | 延迟一帧读选区，避免读到折叠前的旧值 |
| 选区在 `input` / `textarea` 内 | 不弹（避免干扰输入） |
| 选区在工具条 / 卡片内部 | 不弹 |
| 点击页面其它地方、滚动、`Esc` | 收起工具条 |
| 卡片打开时 | 不再弹工具条，避免互相遮挡 |

关键细节：工具条上的 `mousedown` 被 `preventDefault()` 掉了 —— 否则在 `contenteditable` 里按下按钮会先折叠选区，等到 `click` 时已经拿不到文本。所以文本在**浮出时快照**，点击后用的是快照。

#### 12.4 三个动作的 prompt 策略

| 动作 | system 提示要点 | 输出形态 |
|---|---|---|
| AI 搜索 | 检索式问答：先 1-2 句结论，再列 2-4 条关键事实；不确定必须明说，不编造来源 | ≤ 320 字 |
| 解释 | 先一句话说"是什么"，再拆概念与因果，必要时给例子；外文先给中文释义 | ≤ 350 字 |
| 翻译 | 中文→英文、其他→简体中文；只输出译文，保留换行与列表 | 纯译文 |

三个动作都由**当前使用**的供应商 + 默认模型完成，请求体是标准 `POST {base}/chat/completions`。

#### 12.5 流式与错误

- 主进程 `fetch` + `ReadableStream` 解析 SSE（`data: {...}` / `data: [DONE]`），按 `ai:event {type:'start'|'delta'|'done'|'error'}` 推给发起窗口
- 网关忽略 `stream:true` 直接回整包 JSON 时，自动降级整包解析
- 请求带 `AbortController`：关卡片 / 点「停止」立刻断流

错误统一翻译成人话：

| 底层 | 展示 |
|---|---|
| 401 / 403 | 鉴权失败（401/403），请检查 API Key |
| 404 | 接口不存在（404），请确认 Base URL 是否正确（多数服务需要带 /v1） |
| 429 | 请求过于频繁（429）… |
| `ECONNREFUSED` | 连接被拒绝，请确认服务地址与端口 |
| `ENOTFOUND` | 域名解析失败… |

#### 12.6 结果卡片：置顶 / 拖拽 / 重新生成

卡片标题栏有四个元素：拖拽把手（六点阵）、标题、模型名、📌 置顶、✕ 关闭；
底部是「复制 / 重新生成 / 插入便签 / 停止」。

| 能力 | 页面内（便签 / 便签中心） | 系统级悬浮层 |
|---|---|---|
| 拖拽 | 卡片自身 `left/top`，存 `localStorage['sticky.aiCard.layout']` | 移动整个 BrowserWindow，主进程维护 `overlayUserPos` |
| 置顶 | 钉在窗口顶部（`top: 10px`），横向优先沿用用户拖过的 x | 钉在屏幕顶部（`workArea.y + 8`） |
| 重新生成 | 用同一份输入、同一个位置重跑流式 | 同左 |
| 停止 | 断流（`AbortController`） | 同左 |

**位置优先级**：置顶 > 用户拖过的位置 > 跟随选区。三种来源都走同一个 `applyLayout()`，
保证拖拽、置顶、自动定位三者不会互相覆盖。

**🔴 关键约束**：置顶**不能**把「置顶后的屏幕位置」写回用户位置字段，否则取消置顶就回不去了。
`layout.x/y` 只表示「用户自己拖出来的位置」，`pinned` 只表示「是否钉在顶部」，两个概念必须分开。

**拖拽实现**：用 Pointer Events（`pointerdown` / `pointermove` / `pointerup` + `setPointerCapture`）。
- 位移 < 3px 视为点击，不触发拖拽
- 触屏只允许从标题栏拖动，正文保留 `touch-action: pan-y` 供上下滚动
- 系统级用 `screenX/screenY` 而非 `clientX/clientY`——窗口一动，指针的相对坐标也跟着变，会算成原地不动

**生成期间**：正文显示加载点，「重新生成」禁用，「停止」保留可点，输出正常追加。

#### 12.7 安全边界

- API Key 只落在主进程内存与本地 `sticky-notes.json`，从不经 IPC 回传明文；页面 CSP 是 `connect-src 'none'`，渲染层也无法直连外部
- 卡片底部「插入便签」只在便签窗口出现（探测 `window.__aiInsertText`），插入前若处于阅读模式会自动切回编辑
- 便签中心的 `body` 原本是 `user-select: none`，为支持划词，已经把 `.brand / .card-body / .statusbar` 等正文容器放开

#### 12.8 配置页状态机

| 状态 | 表现 |
|---|---|
| 新建（未选供应商） | 表单清空、删除按钮隐藏、「设为当前使用」默认勾选（首个供应商） |
| 编辑已有 | 回填名称/URL，Key 显示掩码提示，模型下拉定位到已保存值 |
| 拉取中 | 状态行「正在拉取模型列表…」，按钮禁用，序号防抖（旧请求回来不覆盖新结果） |
| 拉取成功 | 「已获取 N 个模型」（绿），自动选中第一个或保留当前 |
| 拉取失败 | 「拉取失败：HTTP 401 {…}」（红），仍可手填模型 ID 保存 |
| 保存 | 写盘 + 刷新列表 + 状态栏提示 |

---

### 13. 系统级划词（任何软件里选中就能用）

第 12 节的划词只作用于本应用的两个页面；这一节是「任何软件 / 网页里选中文字都能弹工具条」。

#### 13.1 三层结构

```
sel-probe.py（独立进程，常驻）
  ├ WH_MOUSE_LL 全局鼠标钩子
  ├ 检测到「拖拽选中」→ SendInput 发 Ctrl+C → 读剪贴板 → 还原剪贴板
  └ stdout 每行一个 JSON：{"t":"sel","text":...,"x":...,"x0":...,"hwnd":...}
        ↓
主进程 main.js
  ├ 过滤：hwnd 属于自家窗口 → 丢弃（页面内已有自己的工具条）
  ├ 换算：物理像素 → DIP（按所在显示器的 scaleFactor）
  └ 定位：选区两点中点 → 开一个「只有工具条那么大」的透明窗口
        ↓
overlay.html（250×50 起步，随内容长高）
  ├ bar 模式：AI 搜索 / 解释 / 翻译 / ✕
  └ card 模式：标题 + 模型名 + 流式正文 + 复制 / 停止
```

#### 13.2 为什么用「模拟 Ctrl+C」而不是 UI Automation

| 方案 | 覆盖 | 代价 |
|---|---|---|
| UIA TextPattern | Chrome/Edge、Office、多数 Electron 应用 | 需要 COM（comtypes/pywin32），终端、自绘控件仍拿不到；Python 侧无依赖可用 |
| **Ctrl+C + 剪贴板**（本实现） | 所有支持复制的应用：浏览器、Office、编辑器、IDE | 短暂占用剪贴板；终端类会被跳过 |

所以取词链路是：`保存剪贴板 → SendInput Ctrl+C → 等 GetClipboardSequenceNumber 变化 → 读文本 → 还原剪贴板`。
只还原文本格式，原本是图片/文件时会丢——这是这个方案的固有代价，已在限制里说明。

**必须先 SendInput**：`keybd_event` 注入的按键在这类环境里到不了目标窗口（实测序列号不变），SendInput 才行。

#### 13.3 只认「拖拽」不认「单击」

钩子在 `LBUTTONDOWN` 记下起点，`LBUTTONUP` 时算位移：
- 位移 ≤ 6px → 当普通点击，**不碰剪贴板**
- 位移 > 6px → 当划词，才走复制链路

否则每次点击都改一次剪贴板，副作用太大。

#### 13.4 定位规则

钩子只给点，不给选区矩形，所以用「按下点 + 抬起点」的中点近似选区中心：

| 模式 | 位置 | 越界处理 |
|---|---|---|
| bar | 锚点上方 12px，水平居中 | 上方放不下 → 翻到锚点下方 22px |
| card | 锚点下方 18px | 下方放不下 → 翻到锚点上方 |

再统一 `clamp` 到该显示器的 `workArea`，不会跑出屏幕。

#### 13.5 显示与隐藏

| 事件 | 行为 |
|---|---|
| 钩子报 `sel` | 显示/复用同一个悬浮窗，重置为 bar 模式 |
| 左键按下（坐标不在悬浮窗内） | 隐藏 |
| 左键按下（在悬浮窗内） | 不隐藏，交给页面处理按钮 |
| 点 ✕ / 按 Esc（窗口有焦点时） | 隐藏 |
| 托盘 →「全局划词」取消勾选 | 杀掉探针 + 隐藏悬浮窗，页面内划词不受影响 |

判断「在悬浮窗内」用的是窗口自身的 `bounds × scaleFactor` 与钩子给的物理坐标比较，避免「点自己反而关掉」的死循环。

#### 13.6 兼容性处理

| 场景 | 处理 |
|---|---|
| 高 DPI | 探针先 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`，坐标才是物理像素；主进程再按显示器 scaleFactor 换 DIP |
| 多显示器 | 按「物理点落在哪个显示器」反查，不用主屏比例 |
| 控制台 / 终端 | 类名在黑名单里（`ConsoleWindowClass`、`CASCADIA_HOSTING_WINDOW_CLASS`、`mintty`、`PuTTY`），否则 Ctrl+C 会打断进程 |
| 自有窗口 | 探针在 **Python 侧**就按 `--owner-pid` 跳过（注入按键之前），主进程侧的 hwnd 比对只作双保险 |
| 悬浮窗本身 | `Transparent + alwaysOnTop('screen-saver') + skipTaskbar`，尺寸随内容走，不遮挡选区 |
| 没有 Python | 启动时按 `STICKY_PYTHON` → `python` → `python3` → `py` 逐个探测，全失败就只保留页面内划词 |
| 探针崩溃 | 退出后 1.5s 自动重启，最多 3 次 |

#### 13.7 边界与已知限制

1. **取词依赖复制**：终端、部分游戏、自绘控件（如某些 IM 的聊天区）不响应 Ctrl+C，选不中就不会弹。
2. **剪贴板副作用**：只还原文本；原本是图片/文件时会被替换掉。
2b. **取词期间剪贴板是独占的**：`OpenClipboard` 全局独占，探针取词的那几百毫秒内，
   其它程序的 Ctrl+C 可能失败。**自家窗口已完全排除**（见 8.5），但其他应用里仍存在这个窗口期。
3. **选区矩形是估算的**：用两点中点近似，竖排选区（从上往下拖）会偏一点。
4. **悬浮窗可聚焦**：Windows 上 `focusable:false` 的窗口收不到鼠标点击（按钮点不动），所以用 `showInactive()` 显示、点击后才拿焦点。
5. **没有 Python 3 就不可用**：这是当前实现的硬依赖，写成 C# 原生助手可以去掉，但需要编译工具链。
6. **不做 OCR**：图片里的文字、PDF 扫描件选不中。

### 14. 边缘收缩（贴边收纳）

便签贴到屏幕边缘时自动缩成一条窄边，鼠标靠近再展开——给桌面腾地方，又不丢内容。

#### 14.1 交互

| 动作 | 结果 |
|---|---|
| 把便签拖到屏幕边缘（18 DIP 内） | 自动收缩成贴边窄条 |
| 窄条上悬停 | 自动展开回原尺寸 |
| 鼠标离开展开态便签 1.2s | 重新收起（若仍贴边且无焦点） |
| 拖动窄条 | 换边收纳；拖离边缘则就地展开 |
| 设置面板「贴边收缩 / 展开便签」 | 手动切换；远离边缘也会吸到最近的一条边 |
| 设置面板「拖到屏幕边缘自动收缩」 | 关闭后不再自动收纳（悬停展开仍然可用） |
| 点窄条 | 展开并聚焦 |

收缩形态：贴左右边 → 竖条（宽 50 DIP，高度沿用便签高度）；贴上下边 → 横条（高 50 DIP）。
窄条上画三道 grip + 竖排/横排标题，一眼能认出是哪张便签。

#### 14.2 几何真值：`bounds` 永远是"展开态"

这是整个功能最关键的一条约定：

```js
note.bounds        // 永远是展开态几何（用户想要的尺寸/位置）
note.collapsed     // 当前是否收纳
note.collapseEdge  // 收在哪条边（left/right/top/bottom）
```

运行时窗口几何是算出来的，不落盘：

```js
运行时 = note.collapsed
  ? collapsedBounds(note.collapseEdge, note.bounds, workArea)   // 窄条
  : note.bounds                                                 // 原样
```

好处：

- 重启后不会因为窄条宽度小于 `MIN_W(260)` 而把尺寸写坏；
- 展开/收起可以反复来回，尺寸不会漂移；
- 窄条的位置/尺寸是"派生值"，任何时候都能由 `bounds + edge` 复原。

反例（上一版的坑）：把窄条几何直接写回 `bounds`，结果 `clampBounds()` 把宽度拉回 260，
展开后便签变成一条 260×500 的面条。

#### 14.3 为什么不用 `moved` 事件驱动

第一版打算在 `win.on('moved')` 里判定"拖到边缘了"。实测（Windows + Electron 33）：

```text
外部 MoveWindow(hwnd) / win.setPosition()  →  moved 事件【不触发】
```

于是改成**位置轮询**兜底（120ms 一次），`moved` 只作为"更快一步"的补充：

```js
setInterval(() => {
  const pt = screen.getCursorScreenPoint()
  for (const [id, win] of noteWindows) {
    const b = win.getBounds()
    if (note.collapsed) { /* 离开→展开 / 被拖走→换边 */ }
    else { /* 贴边 + 鼠标不在上面 + 没在用它 → 1.2s 后收起 */ }
  }
}, 120)
```

轮询比事件贵一点，但 120ms 一次、只读一个光标坐标，开销可以忽略。

#### 14.4 三个防抖动/防循环的开关

1. **`win.__rearm`**：刚收起时鼠标通常就停在窄条上（用户是把便签拖到边缘的）。
   必须先离开窄条一次、再回来才允许展开，否则"收起 → 立刻弹开 → 再收起"会无限循环。
2. **`programmaticGuard(win)`**：程序性 `setBounds` 也会触发 `moved/resized`。
   用一个 400ms 的时间窗把"程序改的几何"和"用户拖的几何"区分开，
   否则每次收起都会把窄条几何当成用户拖动结果落盘。
3. **`win.__userDragged`**：只有"用户主动拖过"或"窗口没有焦点"时才自动收起，
   避免正在便签里打字时被抽走。用户在便签里按下鼠标（`note:engage`）会立刻清掉这个标记。

#### 14.5 和其它功能的关系

- **缩放**：收纳态下 `setMinimumSize(COLLAPSE_MIN, COLLAPSE_MIN)`，展开时恢复 `MIN_W/MIN_H`；
  收纳态下渲染层的改尺寸请求（`note:set-bounds`）直接拒绝，避免窄条几何污染 `bounds`。
- **置顶**：`alwaysOnTop` 不受影响，窄条照样置顶。
- **阅读模式**：可以叠加——先切成阅读模式再贴边，展开后仍是阅读模式。
- **全局划词**：窄条只有 50 DIP 宽，划不到词；展开后行为不变。

---

## 五、数据结构

```jsonc
{
  "version": 4,                    // 当前 schema 版本；旧文件自动迁移并保留升级前快照
  "notes": [
    {
      "id": "uuid",
      "title": "欢迎使用桌面便签",
      "html": "<p>…</p><div class=\"mmd\" data-code=\"graph LR…\">…</div>",
      "preview": "纯文本前 160 字，供便签中心列表用",
      "color": "#FFF3B0",
      "theme": {
        "fontFamily": "\"Microsoft YaHei\", sans-serif",
        "fontSize": 15,
        "lineHeight": 1.75,
        "radius": 14,
        "opacity": 1,
        "shadow": true,
        "showToolbar": true
      },
      "bounds": { "x": 1096, "y": 40, "width": 400, "height": 500 },
      "alwaysOnTop": true,
      "visible": true,
      "mode": "edit",                 // edit | read
      "edgeCollapse": true,           // 是否允许拖到屏幕边缘自动收缩
      "collapsed": false,             // 当前是否处于收纳态（贴边窄条）
      "collapseEdge": null,           // left | right | top | bottom | null
      "boundsRecovered": true,        // 可选：迁移时修复过被写坏的 bounds（原值留在升级前快照）
      "createdAt": 1730000000000,
      "updatedAt": 1730000000000
    }
  ],

  // AI 供应商（API Key 只存在这里，不回传渲染进程）
  "settings": {
    "globalSelect": false,          // 主动启用；取词会使用系统剪贴板
    "edgeGroups": false             // 可选的按屏收纳卡组
  },

  "ai": {
    "activeId": "provider-uuid",
    "providers": [
      {
        "id": "provider-uuid",
        "name": "OpenAI 官方",
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-…",
        "models": ["gpt-4o-mini", "gpt-4o"],
        "defaultModel": "gpt-4o-mini",
        "createdAt": 1730000000000,
        "updatedAt": 1730000000000
      }
    ]
  }
}
```

> **版本与迁移**：`version > 2` 的文件会被**拒绝加载**并弹窗提示，原文件字节不变（不再静默降级丢字段）；
> `version: 1` 首次启动自动迁移到 2，迁移前生成 `sticky-notes.json.pre-v2-<时间戳>` 快照，
> 把被写坏的 50 DIP `bounds` 自愈为合法展开态，保留 `collapsed` / `collapseEdge`，
> 并给该便签打 `boundsRecovered` 标记。`normalizeNote` 现在保留未知字段，不再吞掉未来字段。
>
> **快照**：每次运行首次写盘前生成一份按天快照 `sticky-notes.json.bak-YYYYMMDD`（同一天只写一份，
> 避免 350ms 写盘产生快照爆炸）；JSON 损坏时另生成 `.bak-<时间戳>`，且**先备份再回退空库**，
> 正式文件在备份前后都不被改写。原子写一律 `.tmp` + `renameSync`，强杀只会留下 `.tmp`，
> 不会被当成正式数据读取。
>
> **兼容性**：v2 未改动字段结构，旧版程序读 v2 文件仍能正常显示（只是不认识新标记字段）。

---

## 六、快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Alt+N` | 全局新建便签（应用未聚焦也生效） |
| `Ctrl+Alt+H` | 全局打开便签中心 |
| `Ctrl+Alt+G` | 打开已启用的边缘卡组（Esc 收起） |
| `Ctrl+V` | 便签内粘贴（图片直接插入，文字保留基础格式） |
| `Ctrl+B / I / U` | 加粗 / 斜体 / 下划线 |
| `Ctrl+\` | 清除选中文字格式 |
| `Ctrl+S` | 立即保存（平时自动保存） |
| `Esc` | 关闭设置面板 / 图表弹窗 |
| **画板内** `V` / `L` | 选择模式 / 连线模式 |
| **画板内** `Delete` | 删除选中的节点或连线（连同其边） |
| **画板内** `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| **截图内** `R`/`O`/`A`/`P`/`M`/`T` | 矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字 |
| **截图内** `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做标注 |
| **截图内** `Enter` | 插入便签 |
| **截图内** `Ctrl+C` / `Ctrl+S` | 复制到剪贴板 / 保存到文件 |
| **截图内** `Esc` | 取消输入 → 取消当前笔画 → 退出截图（分级） |
| **预览窗口** 滚轮 / 拖拽 | 缩放 / 平移 |
| **预览窗口** `0` / `1` | 适应窗口 / 原始尺寸 |
| **预览窗口** `Esc` | 关闭 |
| **便签内** 双击正文（阅读模式） | 回到编辑模式 |

托盘图标：**左键单击**打开便签中心，**右键**弹出便签列表菜单。

---

## 七、已知限制与可扩展方向

1. **图片附件存储**：新截图写入 `userData/attachments/` 并以 `sticky-att://` 引用；旧内联图打开时在配对快照后迁移，写入失败保留原内容。备份和搬迁必须同时带上 JSON 与附件目录。
2. **透明窗口的系统行为**：Windows 下透明无边框窗口不支持 Aero Snap 分屏；拖动缩放手柄已覆盖需求。
3. **画板只画 flowchart**：生成的是 `graph TD/LR`，时序图、甘特图、饼图仍走"图表"弹窗写代码。画板里的节点位置只用于决定声明顺序，最终排版由 Mermaid 自动布局（这也是为什么不把坐标写进代码）。
4. **反解析是"尽力而为"**：`parseMermaid` 只覆盖 flowchart 的常见写法（节点 + 边 + 形状 + 边标签），遇到 `subgraph`、`classDef`、`style` 等会忽略——图形可能简化，但不会崩。
5. **阅读模式只作用于便签本身**：便签中心的卡片列表不区分模式，因为那里本来就是只读预览。
6. **截图工具的边界**：先框选、确认后才抓取该区域（不是先截全屏再裁）；一次只截鼠标所在的那块屏（不做跨屏拼接）；窗口吸附靠图像边缘分析，纯色背景、无边框窗口、大面积渐变可能识别不到，此时手动拖拽即可；不支持滚屏长截图和"贴图钉在桌面"。
7. **打包**：目前是源码直跑。要出 exe 可加 `electron-builder`，并在 `package.json` 补 `build.appId` / `build.nsis` 配置；`src/vendor/mermaid.min.js` 与 `assets/` 需打进 `files`。
8. **图片预览是只读的**：不支持旋转、裁剪、另存为，也不支持多图左右翻页；连续点不同图片会复用同一个窗口换图。
9. **AI 只支持 OpenAI 兼容协议**：`GET {base}/models` + `POST {base}/chat/completions`。Anthropic Messages、Gemini 原生 `generateContent` 这类协议不同，需要各自适配（或用它们提供的 OpenAI 兼容层）。
10. **「AI 搜索」不是真的联网搜索**：它是对选中内容发起检索式问答，靠模型自身知识作答，不接第三方搜索 API。要实时结果得再接一个搜索服务（或搜索类 MCP），把摘要塞进 prompt。
11. **划词的覆盖范围**：便签窗口与便签中心生效；截图、画板、图片预览窗口没有正文可划，所以没接。
12. **API Key 加密存储**：已接入 Electron `safeStorage`（落盘前缀 `enc:v1:...`，仅本机用户上下文可解密、不进日志、不回传渲染进程），并兼容历史明文配置的启动期就地升级；仅在系统加密后端不可用时降级提示。
13. **待扩展**：便签分组、Markdown 快捷输入（`# ` 自动转标题）、导出为 PDF、开机自启（`app.setLoginItemSettings`）、画板支持 subgraph 与自动对齐参考线、截图支持序号标记与 OCR 取字。

---

## 八、本轮修复记录

### 8.1 🔴 窗口不可见时 rAF 不触发，流式内容渲染不出来

**症状**：便签窗口或便签中心被其它窗口遮挡时，点「AI 搜索 / 解释 / 翻译」，
卡片一直停在「生成中…」的三个蓝点占位符上，正文一个字都没有。
但把窗口切到前台后，同一次请求的内容又正常显示了。

**根因**：`requestAnimationFrame` 在 `document.hidden === true`（窗口被遮挡 / 最小化 / 在别的显示器后面）时**根本不触发**。
而 `ai-toolbar.js` 的 `schedulePaint()` 与 `overlay.js` 的 `reportSize()` 都是纯 rAF 驱动：

```js
// 修复前
rafPaint = requestAnimationFrame(paint)
```

Chromium 对不可见文档会挂起 rAF 队列，所以回调永远排在队列里等不到执行。
这不是测试环境问题 —— 真实的「用户切到别的程序继续干活」场景一定会踩到。

**修复**：rAF + `setTimeout` 双保险，谁先到谁执行，并用 `fired` 标志保证只跑一次。

```js
const fire = () => {
  if (fired) return
  fired = true
  rafPaint = 0
  clearTimeout(paintTimer)
  paint()
}
rafPaint = requestAnimationFrame(fire)
paintTimer = setTimeout(fire, 60)
```

**受影响并已修复的四处**：

| 文件 | 位置 | 不修会怎样 |
|---|---|---|
| `src/ai-toolbar.js` | `schedulePaint()` | 流式正文永远不显示 |
| `src/overlay.js` | `reportSize()` | 悬浮窗尺寸不更新 → 定位/置顶失效 |
| `src/overlay.js` | 拖拽 `pointermove` | 拖动悬浮窗不跟手 |
| `src/note.js` | 缩放手柄 `move()` | 拖动便签边框不跟手 |

### 8.2 🔴 置顶会污染用户拖出来的位置

**症状**：把卡片拖到某个位置 → 点置顶 → 再取消置顶，卡片回不到原来的位置。

**根因**：`togglePin()` 在置顶时把当前屏幕坐标写回了 `layout.x/y`：

```js
// 修复前 —— 把「置顶态的临时位置」写进了「用户位置」
if (layout.pinned) {
  const r = panel.getBoundingClientRect()
  layout.x = Math.round(r.left)
}
```

置顶时卡片被移到顶部居中，这个坐标覆盖了用户拖出来的真实位置，取消置顶就回不去了。

**修复**：置顶只改 `pinned` 标志，位置一律由 `applyLayout()` 按 `pinned` 推导；
`layout.x/y` 只表示「用户自己拖出来的位置」，两个概念彻底分开。

```js
function togglePin () {
  layout.pinned = !layout.pinned
  saveLayout()
  syncPinUI()
  if (!panel.hidden) applyLayout((session && session.rect) || NO_RECT)
}
```

实测往返（便签窗口 392×376，卡片 380px 宽）：

| 步骤 | left / top | `sticky.aiCard.layout` |
|---|---|---|
| 初始（跟随选区） | `6px / 131px` | `null` |
| 拖拽 +40/+25 | `8px / 156px` | `{pinned:false,x:8,y:156}` |
| 点置顶 | `6px / 10px` | `{pinned:true,x:8,y:156}` ← **x/y 不变** |
| 取消置顶 | `8px / 156px` | `{pinned:false,x:8,y:156}` ← 精确回原位 |

### 8.3 其它

| 项 | 说明 |
|---|---|
| 置顶态下拖拽 | 自动脱离置顶（`pinned` 归 0），位置写入 `layout.x/y` |
| 系统级悬浮层置顶 | 主进程只改 `y`（钉屏幕顶部），`overlayUserPos.x` 保持不变，取消置顶后精确回原位 |
| 触屏 | 仅标题栏可拖动，正文保留 `touch-action: pan-y` 供上下滚动 |
| 抖动阈值 | 位移 < 3px 不算拖拽，避免点击被误判成拖动 |

### 8.4 回归验证

用 CDP（`--remote-debugging-port=9222`）直连渲染进程做的端到端验证：

| 场景 | 结果 |
|---|---|
| 便签窗口划词 → 工具条浮出 | ✅ 位置正确（选区上方） |
| 卡片流式输出 | ✅ MiniMax · MiniMax-M3.1-Flash，269 字 |
| 重新生成（页面内） | ✅ 新内容 240 字，标题保持「解释」 |
| 重新生成（系统级） | ✅ 收到 13 个 delta 事件 |
| 拖拽 → 置顶 → 取消置顶 往返 | ✅ 精确回到原位 |
| 置顶态拖拽 → 自动脱离置顶 | ✅ `pin 1→0` |
| 系统级工具条（搜索/解释/翻译/关闭） | ✅ 4 个按钮齐备 |
| 系统级卡片置顶 | ✅ `y` 变为 8（屏幕顶部） |
| 系统级卡片拖拽 | ✅ 窗口真实移动，pin 自动归 0 |
| 窗口遮挡下的流式渲染 | ✅（修复后） |

> ⚠️ 排查提示：用 CDP 给 `window.sticky.aiAsk` 挂 monkey-patch 统计调用次数是**无效的**——
> `contextBridge` 暴露的是冻结对象，属性赋值不生效。改用 `window.sticky.onAiEvent()` 数 delta 事件才准。

### 8.5 🔴 便签里 Ctrl+C「时不时失效」——全局划词探针抢剪贴板

**症状**：在便签里选中文字按 Ctrl+C，偶尔没反应、复制不出来；换个应用又正常。

**根因**：`assets/sel-probe.py` 的取词流程是「模拟 Ctrl+C → 读剪贴板 → 还原剪贴板」，
而 `OpenClipboard` 在 Windows 上是**全局独占**的：探针打开剪贴板期间，
其它进程拿不到它，用户的 Ctrl+C 自然复制失败。

更糟的是**过滤位置错了**：主进程有 `isOwnWindow(hwnd)` 判断，用来跳过自家窗口
（便签里本来就有页面内划词工具条，全局划词是多余的），但这个判断发生在
`sel` 事件**到达主进程之后**——而探针在 Python 侧**已经注入完 Ctrl+C、并且独占过剪贴板了**。

```python
# 修复前：探针无条件取词，主进程事后才过滤（已经晚了）
def grab_selection(x, y, x0, y0):
    ...
    send_copy()          # ← 已经注入了
    text = clipboard_get_text()   # ← 已经独占过剪贴板
    ...
    emit({'t': 'sel', ...})       # ← 这时主进程才判断 isOwnWindow
```

所以在便签里每拖选一次，就会：静默复制一次 → 抢走剪贴板 → 再还原回去。
你随后按 Ctrl+C 时若正好撞上这个窗口期，复制就失败了——表现为「时不时失效」。

**修复**：把过滤**前移到 Python 侧**，在注入按键之前就判断目标进程是不是自���的。
Electron 的所有用户可见窗口（便签、便签中心、悬浮层）HWND 都归属**主进程**，
所以用进程 pid 判断即可，比 hwnd 比对更省事。

```python
# 探针新增参数
owner_pid = 0
if '--owner-pid' in sys.argv:
    owner_pid = int(sys.argv[sys.argv.index('--owner-pid') + 1])

def grab_selection(x, y, x0, y0):
    hwnd, cls, pid = foreground_info()
    if not hwnd:
        return
    # 🔴 必须在注入按键之前跳过：一旦注入，探针会独占剪贴板
    if owner_pid and pid == owner_pid:
        emit({'t': 'skip-own', 'x': x, 'y': y, 'hwnd': hwnd, 'pid': pid})
        return
    ...
```

主进程把 Electron 主进程 pid 传进去：

```js
probeProc = spawn(py, ['-u', script, '--parent-pid', String(process.pid),
  '--owner-pid', String(process.pid)], { ... })
```

**顺带缩短剪贴板独占时间**：重试次数从 6 次降到 3 次、间隔从 20ms 降到 10ms。
剪贴板抢不到就直接放弃这次取词，不长时间纠缠。

**验证**（便签窗口内做真实鼠标拖选 + 持续采样剪贴板）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 主进程日志 | 无（取词静默发生） | `[probe] 跳过自家窗口的选择` |
| 剪贴板被独占 | 会发生 | **0 次 / 3134 次采样** |
| 剪贴板序列号变化 | 会变化 | **0 次** |

> 顺带确认：Electron 的 `Chrome_WidgetWin_1` 窗口（便签 / 便签中心 / 悬浮层）
> HWND 全部归属**主进程** pid；渲染进程只持有 GPU 进程的隐藏窗口
> `Chrome_WidgetWin_0`。所以 `--owner-pid` 判断不会漏。

### 8.6 全局划词仍然可用

`owner_pid` 只在「前台窗口 pid == 自家 pid」时跳过，其余路径（`SKIP_CLASSES` 黑名单、
窗口外拖拽、取词与还原）逻辑一字未改，其他应用里的全局划词行为不受影响。

新增可观测事件：`{"t":"skip-own"}` —— 主进程会打印 `[probe] 跳过自家窗口的选择`，
以后再怀疑「探针是不是动了我的剪贴板」，看这行日志就能确认。

### 8.7 竞态复现与修复前后对照

**复现方法**：在便签窗口里拖选 → 延迟 D 毫秒后按 Ctrl+C → 读剪贴板内容。
探针的取词窗口是「拖选抬起后 `[+120ms, +700ms]`」，用户的 Ctrl+C 落在这个区间就会失败。

| 轮次 | 修复前 | 修复后 |
|---|---|---|
| 1 | 5/8 (62%) | 8/8 (100%) |
| 2 | 7/8 (88%) | 8/8 (100%) |
| 3 | 7/8 (88%) | 8/8 (100%) |
| 4 | — | 8/8 (100%) |

修复前失败点**每轮随机漂移**（100ms / 120ms / 140ms 轮换），
这正是用户描述的「**时不时**失效」——不是必现，而是竞态。

> 验证时踩的坑（都记在这了）：
> - `SetForegroundWindow` 在 Windows 上受限，别的前台窗口会抢焦点。
>   强制前台必须用 `AttachThreadInput`；`GetCurrentThreadId` 在 **kernel32** 不在 user32。
> - CDP 注入的 DOM 选区**不产生鼠标事件**，`WH_MOUSE_LL` 钩子收不到，
>   验证全局划词必须用真实鼠标输入（`mouse_event` + `SetCursorPos`）。
> - 拿窗口物理矩形用 `GetWindowRect`，别拿 `window.screenX`（DIP）硬算。

### 8.8 🔴 数据正确性 P0 止血（L-1 / N-01 / N-04 / N-02 / G-14）

依据 `docs/assessment-2026-11-07.md` 的阶段 0 → E-03 → E-02 路线，**E-03 与 E-02 同一批次合入**
（若只发迁移自愈，旧 `before-quit` 会在下一次托盘退出把合法 bounds 再次写坏）。

| 问题 | 根因 | 修复 |
|---|---|---|
| L-1 收纳态退出把 50 DIP 窄条写回 `bounds` | `before-quit` 无条件 `note.bounds = w.getBounds()`，绕开 `commitBounds` 已有的尺寸/collapsed 双 guard | 抽 `collectBoundsForQuit()`（内部走 `captureBounds`），收纳态一律跳过；`before-quit` 成为几何唯一收口 |
| G-14 存量污染自我传播 | `:626/:687/:753/:1895` 等 10 处以脏 `bounds` 为 base 派生新值，其中几处无尺寸校验 | 抽 `safeExpandedBounds(candidate, fallback)` 覆盖全部写回点；非法尺寸**直接拒绝**，不做 `Math.max(MIN_W, …)` 钳制 |
| N-01 编辑后立刻退出丢末段文字 | 三级防抖（180ms + 350ms + 250ms）；`blur`/`beforeunload` 三处裸调 `flushSave()` | 正文在 `input` 事件里用同步 IPC 立刻写进主进程内存；三处改 `await flushSave()`；`before-quit` 强制落盘 |
| N-04 「已保存」是错误确认 | `note:update` 只 `scheduleSave()` 就 `return true`，写盘失败只 `console.error` | 改两段式：`update` 写内存返回 `{ok,persisted:false}`，新增 `note:flush` 真正落盘并返回 `{ok,error}`；**只有 ok 才显示「已保存」**，失败显示「保存失败 · 请稍后重试或先备份内容」 |
| N-02 高 version 静默降级丢字段 | `loadState` 硬编码 `version:1`，`normalizeNote` 白名单吞未知字段 | `migrateState` 注册表 + `version > 2` 明确拒绝并弹窗（原文件字节不变）；归一化改为保留未知字段 |

**三段式**：防新增（`captureBounds` / `assertExpandedBounds`）→ 治存量（迁移期 `recoverBounds` 自愈 +
升级前快照，保留 `collapsed`/`collapseEdge`，打 `boundsRecovered` 标记）→ 防复发（28 条回归用例 +
落盘负向断言 + 真实 Electron 退出用例）。

**关键设计决策**

1. **不用「退出等待屏障」**：Electron 的 `app.quit()` 是**先触发主进程 `before-quit`、再销毁窗口**，
   渲染层 `beforeunload`/`blur` 根本来不及把 180ms 防抖里的内容送出去；做屏障又必须由产品给定
   最大等待上限（评估里的 AQ-07 待确认项）。改成「`input` 事件同步写主进程内存」后，
   `before-quit` 的 `flushSave()` 写的必然是最新正文，**不需要任何超时常量**。
2. **不用 `clampBounds` 修 50 DIP**：它会把 50 钳成 260，生成「260×500 的面条」尺寸，等于承认污染。
   `assertExpandedBounds` 对过小尺寸直接判非法，由调用方拒绝写回或交给迁移自愈。
3. **快照按天而非按写盘**：写盘最短 350ms 一次，每次快照会瞬间产生大量文件；
   `dailySnapshot()` 同一天只写一份 `.bak-YYYYMMDD`，升级前另留一份 `pre-v2-<时间戳>`。

**验证**（2026-11-07）

- `npm test`：28/28（几何 / 迁移 / 落盘三层，含 TC-01 负向断言、TC-04 原子写、TC-10 高版本
  原文件字节不变、TC-13 损坏先备份、TC-14 自愈幂等）。
- `npm run test:e2e`：真实 Electron 两个便签窗口 + 隔离 `--user-data-dir` + 主进程 `app.quit()`
  （等价托盘退出，非强杀），自然退出 `exitCode=0`。结果：
  `TC-01` 收纳态 `274×473` 逐字段不变、`collapsed/collapseEdge` 保留；
  `TC-07` 编辑后 <350ms 退出正文与 `preview` 均未丢；落盘无 ≤60 宽高、无 260 钳制；
  `version=2`、升级前快照存在；日志 `[quit] 跳过几何写回: [{"id":"e2e-collapsed","reason":"collapsed"}]`。

**残余 / 待确认**

- 每次按键一次同步 IPC + 轻量 `innerHTML`/`textContent` 序列化；含大量内联图片的超大便签输入手感
  需实测。180ms 后的 `queueSave` 仍会用 `serializeHtml()` 覆盖为规范版本（清掉 Mermaid 渲染产物）。
- 完整版本历史（E-01）后置；当前只有按天快照 + 升级前快照 + 损坏备份。
- 评估报告里的 QA-Q06（真实数据中 2 张 `width=260` 是否历史污染）由迁移层判定：
  260 属合法下限，不会被改动；是否曾受污染需用户确认。

### 8.9 E-13 契约 / 异常兜底（AI 超时 / 剪贴板假成功 / 渲染层异常 / 启动失败）

P0 止血之后剩下的四条「失败不可见」问题，本轮一并收口。

| 问题 | 根因 | 修复 |
|---|---|---|
| AI 流式请求没有超时 | `ai:ask` 只在用户点「停止」时 abort；服务端建连后不吐字时，界面永远停在「生成中…」 | 新增 `lib/watchdog.js`：空闲 45s + 单轮 180s 双红线，到点主动 abort；用 `timeoutReason` 区分超时与取消，文案为「响应超时：45 秒没有收到新内容…」 |
| `app:copy-text` 假成功 | `try { clipboard.writeText() } catch (_) {}` 后无条件 `return true` | 返回 `{ok,error}`；≤200KB 文本回读校验（剪贴板可能被其它程序独占）；悬浮层按真实结果显示「已复制 / 复制失败」并给出原因 |
| 渲染层零全局异常兜底 | 没有 `error` / `unhandledrejection` 监听；打包后没有控制台，报错等于丢失 | 新增 `src/guard.js`（六个页面最先加载）：捕获脚本错误 / 未处理 Promise / 资源加载失败 → 屏幕下方可见提示（0.5s 节流、6s 自动消失）+ 上报主进程落 `app-errors.log` |
| 启动链失败静默 | `app.whenReady().then(...)` 没有 `catch` | 补 `.catch`：写日志 + `dialog.showErrorBox` 明确告知 + 退出；`uncaughtException` / `unhandledRejection` 也落同一份日志 |

**设计取舍**

- **超时可调**：`STICKY_AI_IDLE_MS` / `STICKY_AI_TOTAL_MS`（毫秒，下限 1s）可覆盖默认值——
  本地跑推理慢的模型时可放宽；端到端用例用它把 45s 压到 1.5s，避免测试干等 45 秒。
- **必须区分超时与取消**：两者都抛 `AbortError`。若只看 `signal.aborted`，超时会被显示成
  「已取消」，用户无法判断是服务端卡住还是自己点了停止，所以用 `timeoutReason` 显式标记。
- **日志而非弹窗**：渲染层异常只做页面内提示 + 日志，不弹 `dialog`——一个第三方脚本告警不该打断
  正在写的内容；只有「启动失败」这种无法继续的场景才用系统弹窗。
- **日志滚动**：`app-errors.log` 超过 512KB 滚动为 `.1`，只保留一份历史，避免无限膨胀。

**验证**（2026-11-07）

- `npm test`：**37/37**。新增 `test/watchdog.test.js` 9 条：空闲重置、总时长上限、只触发一次、
  `stop` 后不触发、`start` 幂等、参数回落、文案。
- `npm run test:e2e`：新增四条真实 Electron 断言，全过：
  - 挂死网关（接受连接后永不响应）→ **1618ms 收尾**，文案 `响应超时：…`，未被误报为「已取消」；
  - 正常 SSE（8 个增量）→ 正常结束、无 error，看门狗不误杀；
  - `app:copy-text` → `{ok:true}`（用主进程剪贴板备份/还原，不弄脏用户剪贴板）；
  - 页面内故意抛错 → 出现可见提示，且退出后 `app-errors.log` 中能查到 `E2E-GUARD-MARK`。
- 原有数据正确性用例（TC-01 / TC-07 / 负向断言 / 快照）保持全绿。

**残余**

- 渲染层异常只做「提示 + 记录」，没有错误边界自动恢复（例如重建窗口）；单页上报上限 20 条，
  高频循环错误仍会重复记录。
- 剪贴板回读校验只覆盖 ≤200KB 的文本；更大文本仅以「写入未抛异常」为准。

### 1.1.2 实机验收修复

当前 125% 单屏三卡收纳、重启恢复、外部应用划词与剪贴板恢复已实测；修复关闭浮窗后迟到尺寸回报使其重现，以及收纳入口文字拥挤。真实通知已进入 Windows 历史，忙碌状态下横幅点击仍待验证。详见 [实机验收报告](docs/verification/2026-11-21/NATIVE-ACCEPTANCE.md)。

### 转换文件的保存位置

从资源管理器右键转换后，结果直接保存在各自源文件所在目录，不生成结果便签。文件名为“原文件名.目标格式”；已有同名文件时追加“ (1)”“ (2)”等编号，保留原文件。多张图片合并为一份 PDF 时，结果保存在第一张源图片的目录。
