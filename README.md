# 桌面便签（Desktop Sticky Notes）

基于 **Electron 33** 的轻量级 Windows 桌面便签与本地效率工作台。无构建步骤、完全离线优先，集成了 Obsidian 风格 **Markdown + KaTeX LaTeX 实时编辑**、**Mermaid 图表与流程图画板**、**全局/多窗 AI 划词问答**、**学术 PDF 双语文献翻译**、**多格式本地文件转换** 以及 **框选标注截图**，所有数据均以原子写方式安全保存在本地。

---

## 核心特性

### 1. 多彩独立便签 · Markdown 实时预览与 LaTeX 公式
- **独立透明无边框窗口**：每张便签都是独立的 `BrowserWindow`，支持 8 组预设色 + 任意自定义背景色，并依据 WCAG 相对亮度自动切换浅色/深色文字。
- **Obsidian 风格 Live Preview**：
  - 实时支持标题（`#`–`######`）、粗体/斜体/删除线/高亮、行内代码、代码块、引用、分隔线、链接、有序/无序列表与可点击复选任务列表（`- [ ]`）。
  - 光标移入或点击已渲染的格式块时自动展开 `.md-raw` 源码微调，失焦或离开后无缝折叠回渲染态；支持纯文本粘贴自动识别渲染与单步撤销（`Ctrl+Z`）。
  - 支持「全文 Markdown 源码模式」与 Live Preview 无损互切（工具栏按钮或 `Ctrl+Shift+M`）。
- **KaTeX LaTeX 数学公式**：
  - 原生支持 `$...$` 行内公式与 `$$...$$` / `\[...\]` 块级公式，内置公式编辑器与实时预览弹窗（`Ctrl+Enter` 插入），智能避开 `$10` 金额与代码块内美元符号误触发。
  - 划词复制公式时自动还原为标准 `$...$` / `$$...$$` 源码，避免 KaTeX 辅助 DOM 造成重复文本或乱码。
- **阅读模式、外观定制与定时提醒**：
  - 一键切换只读锁定防误触；自定义字体、字号、行距、圆角与透明度；支持单次提醒（退出期间到期会在下次启动补发）。
- **Markdown / 纯文本导入导出与配对备份**：
  - 图片附件自动外置到 `attachments/` 并通过 `sticky-att://` 安全加载；一键导入/导出 Markdown（含图片、任务列表、Mermaid 与公式），支持 `sticky-notes.json` + 附件目录配对备份。

### 2. 自定义 AI 助手 · 全局划词 & 无限多开独立回答窗口
- **OpenAI 兼容接口**：自由配置多组模型供应商与默认模型，API Key 通过 Electron `safeStorage` 加密存储（`enc:v1:...`），不落明文、不进日志、不暴露给渲染层。
- **独立悬浮回答窗口（支持无限多开与窗内递归划词）**：
  - 无论从便签正文、便签中心、系统级全局划词还是回答窗口内部触发 **AI 搜索 / 解释 / 翻译 / 提问 / 复制**，统一弹出独立悬浮回答窗口（多开自动错位排列）。
  - **回答窗内自由划词**：直接在 AI 回答正文（含已渲染的 KaTeX 公式）中拖选文字，即可再次呼出 AI 工具条继续追问或解释，层层开启新回答窗；从便签发起的回答窗支持点击「**插入便签**」将结果回写到原便签。
  - **多轮追问与视觉定制**：支持携带上下文的多轮追问、一键复制干净 Markdown/LaTeX、单窗置顶互不阻塞；未置顶窗口遵循焦点家族生命周期（切换回无关窗口或点击页面空白自动收起）；弹窗背景色与透明度可在「便签中心 → 弹窗外观」中独立配置并支持浅/深文字自动适配。
- **系统级全局划词**：在任意外部应用内选中文字即可触发悬浮工具条（需在便签中心按需开启，依赖本机 Python 3 的鼠标钩子探针 `assets/sel-probe.py`）。

### 3. 学术 PDF 文献翻译（`pdf2zh_next` + 本地一次性代理）
- **AIdea 风格一次性 Token 代理（`lib/pdf-translate-proxy.js`）**：真实 API Key 仅保留在主进程内存闭包中，子进程只接收临时环回地址 `127.0.0.1` 与一次性随机 Token；内置 400 不支持参数自动剔除记忆与 429/5xx 退避重试。
- **一键环境部署与更新**：集成 `uv` 检测与弹窗内一键安装/更新 `pdf2zh_next`（支持国内镜像加速与实时日志/取消），支持 CLI 模式及外部 `zotero-pdf2zh` 服务模式。
- **真实段落进度映射**：解析 `pdf2zh_next` 的段落完成计数（`cur/total`）、并发请求数与排版子阶段，输出双语对照（`dual`）或纯译文（`mono`）PDF，原子发布至源文件同目录且不覆盖同名文件。

### 4. 可插拔本地格式转换引擎与 Windows 右键集成
- **全本地隔离工作器转换**：通过最小权限 `preload-worker.js` 隐藏窗口完成重计算转换，支持自定义转换插件（参见 [examples/convert-plugins/svg.js](examples/convert-plugins/svg.js)）及可选 Filee CLI 增强。
- **多格式互转**：
  - **图片 / 动图 / SVG**：PNG / JPEG / WebP / GIF（含动图首帧提示）/ BMP / SVG ↔ PNG / JPEG / WebP / PDF
  - **文档 / 表格 / 数据**：PDF → PNG / TXT / Markdown / HTML / DOCX；DOCX ↔ Markdown / HTML / TXT / PDF；Markdown ↔ HTML / PDF / DOCX；CSV / JSON / YAML / TOML / INI / XLSX 互转
- **CLI 与右键菜单**：支持 `StickyNotes.exe --convert <files> --to <ext>` 命令行/二次实例唤起，以及便签中心一键注册/卸载 Windows 资源管理器右键菜单。

### 5. 图表、可视化画板、截图、贴边收纳与搜索中心
- **离线 Mermaid 11 + 可视化画板**：内置 `src/vendor/mermaid.min.js`，支持直接编写 Mermaid 代码或打开交互式拖拽流程图画板（`diagram.html`），仅持久化 `data-code` 源码以防膨胀。
- **框选标注截图工具**：独立全屏覆盖层（`capture.html`），支持窗口边缘吸附、矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字标注，确认选区后再抓屏。
- **图片灯箱预览**：支持滚轮缩放、拖拽平移、`0`/`1` 原始尺寸与适应窗口切换。
- **多屏贴边收纳与边缘卡组**：单张便签靠屏幕边缘自动收起，并支持将多张便签归组为按屏幕记忆的「边缘卡组」（`Ctrl+Alt+G`）；跨屏/拔掉副屏时自动自愈位置。
- **便签中心（Dashboard）**：全局视图管理、归档恢复、定时提醒清单与忽略空格的实时正文/LaTeX 公式搜索（如搜 `E=mc^2` 可命中 `$E = mc^2$`）。

---

## 快速开始

### 环境要求
- **操作系统**：Windows 10 / 11
- **Node.js**：v18 及以上（推荐 v20+，内置 `node:test` 与原生 `fetch`）
- **可选依赖**：
  - 开启系统级全局划词时需本机有可用的 **Python 3**
  - 使用本地学术 PDF 文献翻译需安装 **uv**（之后可在应用弹窗内一键安装 `pdf2zh_next`）

### 安装与运行

```bash
# 方式一（Windows 推荐）：双击根目录 start.bat，会自动检查依赖并启动

# 方式二：命令行
npm install
npm start
```

> **提示**：若命令行报错 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`，说明当前终端环境变量中残留了 `ELECTRON_RUN_AS_NODE=1`。使用 `start.bat` 启动或执行 `set ELECTRON_RUN_AS_NODE=` 清除该变量即可。

### 构建 Windows 便携版（Portable）

```bash
npm run build:portable    # 打包便携目录与压缩包到 dist/
npm run test:portable     # 冒烟验证便携包可执行文件与离线资源
```

便携版数据位于程序同级 `data/` 目录，完整备份与迁移说明见 [docs/PORTABLE.md](docs/PORTABLE.md)。

---

## 快捷键与托盘操作

| 作用域 | 快捷键 / 操作 | 功能说明 |
|---|---|---|
| **全局** | `Ctrl+Alt+N` | 新建便签（任意窗口均生效） |
| **全局** | `Ctrl+Alt+H` | 打开/唤起便签中心 |
| **全局** | `Ctrl+Alt+G` | 打开当前屏幕的边缘卡组（`Esc` 收起） |
| **系统托盘** | 左键单击 / 右键 | 左键打开便签中心，右键弹出快捷菜单与便签列表 |
| **便签内** | `Ctrl+Shift+M` | 切换 Markdown Live Preview / 全文源码模式 |
| **便签内** | `Ctrl+Shift+N` | 新建便签 |
| **便签内** | `Ctrl+S` | 立即落盘保存（平时输入停手自动保存） |
| **便签内** | `Ctrl+B / I / U` | 加粗 / 斜体 / 下划线 |
| **便签内** | `Ctrl+\` | 清除选中文字格式 |
| **便签内** | `Ctrl+V` | 粘贴（支持剪贴板截图直接压缩落盘、纯文本 Markdown 自动识别） |
| **便签内** | `Esc` | 关闭当前展开的公式/图表/设置面板或折叠 `.md-raw` |
| **便签内（阅读模式）** | 双击正文 | 切换回编辑模式 |
| **公式 / 图表弹窗** | `Ctrl+Enter` / `Esc` | 确认插入或更新 / 关闭弹窗 |
| **可视化画板** | `V` / `L` / `Delete` | 选择模式 / 连线模式 / 删除选中节点与连线 |
| **可视化画板** | `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| **截图工具** | `R` / `O` / `A` / `P` / `M` / `T` | 矩形 / 椭圆 / 箭头 / 画笔 / 马赛克 / 文字标注 |
| **截图工具** | `Enter` / `Ctrl+C` / `Ctrl+S` / `Esc` | 插入便签 / 复制到剪贴板 / 存为文件 / 分级取消与退出 |
| **图片预览窗** | 滚轮 / 拖拽 / `0` / `1` / `Esc` | 缩放 / 平移 / 适应窗口 / 原始尺寸 / 关闭 |

---

## 目录结构

```text
sticky-notes/
├── main.js                       # 主进程入口：生命周期、单实例、快捷键、写盘调度与退出收口
├── preload.js                    # 业务窗口 contextBridge 安全桥（最小权限）
├── preload-worker.js             # 隐藏格式转换工作器专用隔离桥
├── start.bat                     # Windows 一键启动脚本（自动清除 ELECTRON_RUN_AS_NODE）
├── jsconfig.json                 # JSDoc 静态类型与语法检查配置
├── main/                         # 主进程业务模块
│   ├── windows.js                # 多窗口生命周期、自定义 sticky-att:// 协议与样式广播
│   ├── ipc.js                    # 核心 IPC 路由（便签 CRUD、导入导出、备份、转换、AI 设置等）
│   ├── ai-service.js             # 多供应商管理、safeStorage 加密、SSE 流式请求与看门狗
│   ├── global-overlay.js         # 悬浮划词工具条、多开独立回答窗、Focus Family 生命周期与全局探针
│   ├── pdf-translate.js          # pdf2zh_next CLI / Server / uv 安装更新与进度推送服务
│   ├── capture.js                # 截图选区窗管理、抓屏与全局 Esc 兜底
│   ├── edge-collapse.js          # 单窗贴边收纳状态机
│   ├── edge-groups.js            # 多屏边缘卡组管理
│   ├── explorer-verb.js          # Windows 资源管理器右键菜单安装/卸载/状态探测
│   ├── note-search.js            # 主进程索引搜索维护
│   ├── reminders.js              # 定时提醒调度、补发与通知清理
│   └── tray.js                   # 系统托盘图标、快捷菜单与状态同步
├── lib/                          # 纯逻辑层（无 Electron 依赖，可直接由 node:test 单测）
│   ├── note-markdown.js          # Obsidian 风格 Markdown + KaTeX LaTeX 编解码与清洗
│   ├── dom-snapshot.js           # 渲染/序列化统一 DOM 快照与字符/公式分离统计
│   ├── note-exchange.js          # Markdown / 纯文本无损导入导出与附件搬迁
│   ├── exchange-dom.js           # HTML ↔ Markdown 结构转换辅助
│   ├── note-search.js            # 忽略空格与公式语法归一化的搜索索引与摘要预览
│   ├── pdf-translate.js          # pdf2zh 参数构建、环境变量隔离、Rich 段落进度解析与输出收集
│   ├── pdf-translate-proxy.js    # 127.0.0.1 本地一次性 Token 代理与 400/429/5xx 自适应重试
│   ├── persistence.js            # .tmp + rename 原子写、串行队列、损坏备份、按天与升级前快照
│   ├── save-worker.js            # worker_threads 异步写盘工作线程
│   ├── save-writer.js            # 带 generation 防乱序与 drain 语义的写盘调度器
│   ├── migrations.js             # 多版本状态迁移与几何边界校验
│   ├── geometry.js               # 屏幕工作区自愈与收纳/展开 bounds 断言
│   ├── image-store.js            # 图片外置落盘、去重与配对备份
│   ├── popup-appearance.js       # 弹窗背景色、透明度钳制与明暗对比度自适应
│   ├── secret-codec.js           # safeStorage 加密编解码包装
│   ├── watchdog.js               # 流式请求空闲超时与总时长看门狗
│   ├── cli-args.js               # --convert 命令行与二次实例参数解析
│   ├── explorer-verb.js          # 注册表动词 PowerShell 脚本生成
│   ├── utils.js                  # 公共工具函数（escapeHtml / clamp / SAFE_NAME 等）
│   └── convert/                  # 可插拔格式转换核心（service / router / plugins / worker-host / providers）
├── src/                          # 渲染层多页面与样式（无构建步骤）
│   ├── note.{html,css,js}        # 便签编辑/阅读窗口
│   ├── dashboard.{html,css,js}   # 便签中心、搜索、AI/翻译设置与弹窗外观面板
│   ├── overlay.{html,css,js}     # 全局/页内划词悬浮条与多开独立回答窗口（通过 query role 区分）
│   ├── ai-toolbar.{css,js}       # 页内划词触发条与独立回答窗调度
│   ├── ai-render.js              # AI 回答 Markdown + KaTeX 流式渲染
│   ├── capture.{html,css,js}     # 框选标注截图器
│   ├── diagram.{html,css,js}     # 交互式流程图画板
│   ├── convert.{html,css,js}     # 格式转换中心 UI（含 convert-worker.{html,js} 隐藏工作器）
│   ├── preview.{html,css,js}     # 图片放大预览窗
│   ├── edge-group.{html,css,js}  # 边缘卡组浮层
│   ├── search.html               # 快速搜索窗口
│   ├── guard.js                  # 渲染层未捕获异常上报兜底
│   └── vendor/                   # 本地离线第三方脚本（mermaid.min.js、pdfjs-dist）
├── assets/                       # 应用图标与全局鼠标取词探针 sel-probe.py
├── examples/convert-plugins/     # 格式转换插件示例
├── test/                         # 单元测试套件（node:test，480+ 用例）
├── scripts/                      # 静态门禁 lint.js、反回归审计 qa-audit.js、打包与各专项 Electron E2E
└── docs/                         # 便携版指南、架构评估与性能基准报告
```

---

## 技术栈与安全设计

| 维度 | 选型与实现说明 |
|---|---|
| **运行时与界面** | Electron 33 + 原生 HTML / CSS / JS（零打包构建开销，透明多窗口低重绘成本） |
| **排版与图表** | 本地 `node_modules/katex` 离线渲染 LaTeX 公式；`src/vendor/mermaid.min.js` 离线渲染 Mermaid 11 |
| **沙箱与桥接** | 全窗口开启 `contextIsolation: true`、`nodeIntegration: false`；业务桥（`preload.js`）与转换工作器桥（`preload-worker.js`）严格隔离，离线 CSP 禁止外链脚本 |
| **密钥与代理安全** | AI API Key 使用系统 `safeStorage` 加密存储；PDF 翻译子进程通过 `127.0.0.1` 一次性 Token 代理通信，真实密钥永不进入子进程参数、环境变量或日志 |
| **持久化可靠性** | `worker_threads` 独立写盘 + 同文件串行队列 + `.tmp` 原子替换 + 每日首次写盘备份 + 跨版本升级前自动快照 + `before-quit` 异步等待写盘落盘 |

---

## 开发测试与质量门禁

代码库内置完整的静态门禁、源码反回归审计、纯函数单元测试与隔离用户目录的真实 Electron 端到端测试：

```bash
# 1. 静态门禁（133 文件语法检查 + 53 模块零循环依赖 + IPC 双向通道 100% 对齐 + 10 个页面 CSP/安全红线）
npm run lint

# 2. 源码反回归抽查（cloneNode 限额、写盘原子性与串行化、退出落盘收口）
npm run qa:audit

# 3. 全部单元测试（node:test，无需 GUI）
npm test
npm run test:coverage

# 4. 真实 Electron 端到端测试（使用独立临时 --user-data-dir，不会影响真实便签数据）
npm run test:e2e                  # 主生命周期与异步退出写盘回归
npm run test:e2e:markdown         # Markdown 实时编辑 + KaTeX LaTeX 专项回归
npm run test:e2e:answer           # 独立回答窗多开与窗内划词专项回归
npm run test:e2e:popup            # 弹窗外观、拖动与置顶专项回归
npm run test:e2e:followup         # 多轮追问与 LaTeX 渲染回归
npm run test:e2e:overlay:ask      # 划词浮窗「向 AI 提问 / 复制」回归
npm run test:e2e:pdf-translate    # 学术 PDF 翻译与代理流程回归
npm run test:e2e:all              # 串行执行全套 E2E 回归（请勿并发运行 E2E，窗口焦点与剪贴板互斥）
```

---

## 数据存储与故障排查

- **默认数据目录**：`%APPDATA%\desktop-sticky-notes\`（便携版位于可执行程序同级 `data/`），可通过系统托盘菜单「打开数据目录」或便签中心直达。
- **核心数据文件**：`sticky-notes.json`（状态与笔记配置）及 `attachments/`（外置图片与资源）。
- **日志排查**：同目录下的 `app-errors.log` 会记录主进程与渲染层的未捕获异常（超过 512KB 自动滚动归档为 `.1`）。

---

## 开源协议

[MIT License](LICENSE)
