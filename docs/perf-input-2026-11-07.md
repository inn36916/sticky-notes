# 便签输入延迟实测报告（2026-11-07 · 第 5 版 · 冻结版本实测）

> 📌 **后续复测**：本文档为「改动前」基线，**内容保持不变**以供对照。
> 低风险三件（DOM 克隆合并 + preview 复用 + 落盘紧凑 JSON/异步入 worker）改动后的复测见
> **[`docs/perf-input-2026-11-08-after-lowrisk.md`](./perf-input-2026-11-08-after-lowrisk.md)**（同脚本 SHA，三轮）。

> ## 版本登记（本报告**所有**数字只对应下面这个 SHA；脚本此后冻结）
>
> | 项 | 值 |
> |---|---|
> | 脚本 | `scripts/perf-input.js` |
> | **SHA256** | **`8CA3984E29A4BC6C3E05753C1A4BC56CCEE818704A8A6EA20CB1C76F88018A7B`** |
> | mtime | `2026-11-07 22:02:59.715 (+08)` = `2026-11-07T14:02:59.715Z` |
> | size | 54,429 bytes |
> | `node --check` | PASS |
> | 跑前 / 跑后 SHA256 | **完全一致**（`8CA3984E…` / `8CA3984E…`），mtime/size 也未变 → 两轮用的就是磁盘上这份文件，测量期间无任何改动 |
>
> **两轮运行**（附录 A 是这两轮的原始 JSON 关键字段；正文每个数字都能对回去）：
>
> | 轮 | `script.startedAt` | `script.finishedAt` | `elapsedSec` | DevTools 端口 | `dataOk` |
> |---|---|---|---|---|---|
> | 1 | `2026-11-07T14:07:11.744Z` | `2026-11-07T14:08:03.307Z` | 52 | 50281 | true |
> | 2 | `2026-11-07T14:08:06.905Z` | `2026-11-07T14:08:58.524Z` | 52 | 61962 | true |
>
> 两轮 JSON 内 `script.sha256` 均为 `8ca3984e29a4bc6c3e05753c1a4bc56ccee818704a8a6ea20cb1c76f88018a7b`、`script.mtime` 均为 `2026-11-07T14:02:59.715Z`。
>
> **运行机器**：i9-12900H（20 逻辑核，P/E 混合），**共享桌面非独占**（同期 wps / WorkBuddy×3 / sandbox-center / douyin / Weixin / playwright MCP 常驻），采样 `% Processor Performance` ≈117% 相对基频。
> **单机无控环境 → 不给紧区间**：只给「定性档位 + 两轮实测值 + 外部复跑的同量级值」。
>
> **被测对象**：`sticky-notes`（Electron 33.4.11）现有实现，**未改动任何产品代码**。

---

## 0. 数据来源与历史版本声明

- **本报告的"本版数据"= 上面那两轮**，SHA 见表格。正文凡未标注来源的数字，均出自附录 A。
- **历史轮次（R14–R25）不再作为本版数据**：它们来自被覆盖的脚本版本，磁盘上已不存在对应文件，**本报告不引用它们的任何数值**。
- **外部复跑**（QA，另一台更慢的机器，`elapsedSec` 51/55）的数字已单独标注"外部复跑"，不并入本版表格。
- 之前几版报告里出现过的 `112ms flush`、S3 中位 `89.18 / 106.55ms` 等，均属于其他 SHA / 其他机器状态，**一律作废，不要再引用**。

---

## 1. 结论

### 1.1 主表：每键阻塞（`inputHandlerMs`）

| 档 | 内容 | html 字符 | 轮1 p50 / p95 / max | 轮2 p50 / p95 / max | 定性 |
|---|---|---|---|---|---|
| S0 | 10 段纯文本 ≈2KB | 2,070 | **3.00 / 4.32 / 4.70** | **3.50 / 5.31 / 7.50** | 流畅 |
| S1 | 200 段纯文本 ≈200KB | 201,400 | **4.95 / 9.07 / 14.30** | **5.40 / 7.23 / 7.70** | 流畅 |
| S2 | 20 张 JPEG（≈200KB/张）+10 段文本 ≈4MB | 4,060,336 | **37.95 / 47.00 / 49.00** | **30.80 / 35.15 / 39.90** | 60ms 连打是**下界**，见 §1.6 |
| **S2N** | **S2 同内容，键间隔 200ms（真人节奏），10 键** | 4,060,336 | **31.30 / 36.49 / 37.30** | **34.25 / 42.45 / 46.00** | **明显卡顿**（§1.6） |
| S3 | 40 张 JPEG（≈300KB/张）+10 段文本 ≈12MB | 12,159,168 | **109.05 / 118.78 / 122.10** | **98.40 / 120.03 / 128.20** | **明显卡顿~不可用** |

单位 ms。
**外部复跑的同量级值**（QA，更慢的机器）：S3 p50 `133.90 / 126.60`、S0 p50 `6.85`、S2N p50 `53.25 / 52.15`。
→ 同一份代码从"快机器/空负载"到"慢机器/忙负载"，S3 p50 落在 **≈98–134ms**、S0 落在 **≈3–7ms**。这就是本报告给出的全部区间承诺。

### 1.2 三组成本（严格分开）

| 组 | 何时付 | 指标 | S0 (轮1/轮2) | S1 | S2 | S3 |
|---|---|---|---|---|---|---|
| **A 每键同步路径** | 每个 `input`，每键 1 次 | `innerHtmlReadMs` | 0 / 0 | 0.3 / 0.3 | 15.7 / 14.1 | **49.4 / 62.1** |
| | | `updateIpcMs`（安静窗） | 1.2 / 0.9 | 2.0 / 2.0 | 14.5 / 12.1 | **40.3 / 60.0** |
| **B 停手 180ms 路径** | 每次打字停顿 1 次 | `tailPathMs`（3 克隆 + 1 次 sync IPC） | 0.3 / 0.4 | 6.5 / 5.0 | 74.1 / 65.8 | **217.5 / 233.1** |
| **C 停手 350ms 落盘** | 每次打字停顿 1 次 | `flushMs`（前测） | 5.7 / 4.8 | 7.1 / 6.6 | 27.5 / 24.8 | **78.7 / 67.7** |
| **C′ 落盘对按键的影响** | 写盘在飞时的**第一键** | `updateIpcUnderFlushMs` | 0.5 / 0.5 | 1.1 / 1.8 | 27.7 / 21.5 | **97.7 / 95.2** |

**A 组的拆分必须谨慎读**：轮1 的序列化+IPC = 49.4+40.3 = **89.7ms**（p50 109.05 的 82%）；轮2 = 62.1+60.0 = **122.1ms**，**反而超过 p50 98.40**。原因是分项测量跑在打字结束之后，那一小段时间机器状态可能更差（轮2 的 `ser1` 也从 84.8 跳到 107.2）。
→ **所以"序列化 vs IPC 各占多少"只能做量级对比（两者同量级、谁也压不倒谁），不能把分项相加当成严格的账。** 残余项（`textContent` 扫描 + 事件派发 + 定时器跳转 + GC）同理只作量级参考（`textContentReadMs` 实测 0）。

**B 组的构成**（`note.js:431-437`）= **3 次整棵 DOM 克隆 + 1 次全量 sync IPC**：

```
updateStats()  → 内部 plainText()   → cloneNode #1 + 换 mmd/img + textContent   （只为算"X 字"）
serializeHtml()                     → cloneNode #2 + 清 Mermaid + innerHTML
plainText().slice(0,160)            → cloneNode #3 + 换 mmd/img + textContent   （只为 160 字 preview）
queueSave()    → api.update(patch)  → 1 次 12MB sendSync
```

- 渲染层实测的"停手长任务"：S3 **230ms（轮1，1 个）**、轮2 未采到（`tailLongTask` 0）；外部复跑（QA）测到 **153 / 235ms**。→ **量级 169–235ms 这一档有独立佐证**。
- `serializePairMs`（S3：121.8 / 122.6）是**下界**——只复刻 #2+#3，**少算 `updateStats()` 内那次克隆**。
- `serializePairMs − serializeProxyMs`（S3：121.8−84.8 = 37.0；122.6−107.2 = 15.4）**不含 HTML 序列化**：`plainText()` 只走到 `textContent`，别再读成"序列化变便宜了"。

### 1.3 落盘争用：机制成立，范围仅限「停顿后第一键」

- 安静窗 `updateIpcMs`（S3）：**40.3 / 60.0ms**；写盘在飞时 `updateIpcUnderFlushMs`（固定相位 +10ms、5 样本）：**97.7 / 95.2ms**，`max` 达 **126.7 / 99.3ms**。
- 相对增量：**+57.4 / +35.2ms**；S2 是 27.7 / 21.5 vs 14.5 / 12.1 → **+13.2 / +9.4ms**。
- 外部复跑（QA）测得 S3 **+61.3ms**、S2 **+21.8ms**，并给出相位扫描（+10ms 106.8/116.0 → +40ms 66.1/72.4 → +70ms 61.2/48.7，空闲 48.4）——单调衰减、量级≈落盘剩余时间。
- **范围限定**：这只影响**停顿后紧接着按下的头 1–2 个键**，**不是每个键**、更不是"每一次 sync IPC"。
- 另外：**这个机制不能用来解释 `updateIpcMs` 的波动**。`measureIpc` 跑在打字结束后的安静窗（每次采样前 `flush()` + 静置 300ms），那时并没有落盘在飞。

### 1.4 长任务（渲染层 `PerformanceObserver`，只记 ≥50ms）

| 档 | 按键窗口内（轮1 / 轮2） |
|---|---|
| S0 / S1 | 0 / 0 |
| S2（60ms 连打） | **0 / 0** —— 但**不是稳定结论**：慢档/更慢机器上会非 0，只能说"本次快档为 0" |
| **S2N（200ms 真人节奏）** | **10 个 / 697ms / max 93ms**；**10 个 / 661ms / max 70ms** |
| S3（60ms 连打） | **20 个 / 2153ms / max 120ms**；**20 个 / 1977ms / max 118ms** |

渲染层看不到主进程的 `JSON.stringify`，落盘只能在 `flushMs` 里量。S3 的 20 个**全部是按键 handler**，不含落盘。

### 1.5 键速与吞吐上限（两个不同的量）

| 档 | 名义间隔 | `keysPerSec`（实测节拍 = keyCount/typingMs） | `capacityPerSec` = 1/p50（上限估计） |
|---|---|---|---|
| S0 | 60ms | 11.06 / 11.30 | 333.3 / 285.7 |
| S1 | 60ms | 10.19 / 10.68 | 202.0 / 185.2 |
| S2 | 60ms | 7.75 / 8.62 | 26.4 / 32.5 |
| S2N | 200ms | 3.41 / 3.41 | 32.0 / 29.2 |
| S3 | 60ms | 5.09 / 5.30 | **9.2 / 10.2** |

- `keysPerSec` 是**本轮实际打出来的节拍**（含名义 `sleep` + 每键阻塞 + CDP 往返），**不是** `1/p50`。
- `capacityPerSec = 1/inputHandlerMs.p50` 是**上限估计，偏乐观**；严格上限应看 `1/E[每次按键阻塞]`（E 要含长任务尾巴，值更低）。
- 真人速率参照：**极速爆发 ≈200 wpm ≈16.7 键/秒**（几乎不可持续）；**常态 5–8 键/秒 + 词间/句间 150–400ms 停顿**。后者正是 B/C 组的触发器（见 S2N）。
- S3 的上限 9.2–10.2 键/秒 **低于极速爆发** → 极速输入会积压；同时又**贴着常态 5–8 键/秒**，意味着平时打字就在上限附近，任何停顿都要额外付 B+C。

### 1.6 ⚠️ S2 的定级：60ms 连打是下界，真人节奏下退化

`S2N` 与 S2 **内容完全相同**，只把键间隔换成 200ms、10 键：

| 轮 | p50 | p95 | 窗口 | 长任务 | 总时长 | 最长 | 仅长任务占空比 | 等效每键† |
|---|---|---|---|---|---|---|---|---|
| 1 | 31.30 | 36.49 | 2.93s（3.41 键/秒） | **10 个** | **697ms** | 93ms | **23.8%** | **101ms** |
| 2 | 34.25 | 42.45 | 2.93s（3.41 键/秒） | **10 个** | **661ms** | 70ms | **22.5%** | **100ms** |

† 等效每键 = (keyCount × p50 + 长任务总时长) / keyCount。
窗口 = keyCount / keysPerSec = 10/3.41 = 2.93s。

外部复跑（QA，更慢机器）：S2N p50 **53.25 / 52.15**，按键窗口 **16–18 个长任务、1427 / 1568ms**，占窗口约 **40%**。

**结论**：
- S2 在 60ms 连打时的 30.8–38.0ms 是**下界**——`clearTimeout` 每键重排，B/C 组根本不触发。
- 真人 200ms 节奏下它退化为 **等效每键 ~100ms、约 22–24% 的时间在长任务里**（QA 机器上 ~40%），**与 S3 在 60ms 连打时的 98–109ms 同量级**。
- 因此 S2 的定级从"可感知"下调为 **"明显卡顿"**。**"小体积还能忍"不成立**：只要正文里塞了图片，正常打字就已经在长任务里泡着。

### 1.7 每 MB 成本（O(字节) 的证据）

| 每 MB | S2（4.06MB）轮1/轮2 | S3（12.16MB）轮1/轮2 |
|---|---|---|
| `innerHtmlReadMs` | 3.87 / 3.47 | 4.06 / 5.11 |
| `updateIpcMs` | 3.57 / 2.98 | 3.31 / 4.93 |
| `tailPathMs`（3 克隆 + IPC） | 18.25 / 16.20 | 17.89 / 19.17 |
| `flushMs` | 6.77 / 6.11 | 6.47 / 5.57 |

两档同量级（虽然轮2 的机器状态偏差把 S3 的分项抬高了）→ 成本随字节线性增长，**不是某档的特例**。每键 ≈ **3.5–5.1ms/MB（序列化）+ 3.0–4.9ms/MB（IPC）**。

---

## 2. 三处被测行为的具体考证

### 2.1 `updateIpcUnderFlushMs` 的口径

固定相位：`flush()` 发出后 **`sleep(10)`** 再打这一枪；5 样本，报中位 + **max**；样本之间等这次写盘落地再继续。不 await 的 `flush()` 一定 `.catch(()=>{})`——否则 rejection 会触发 `src/guard.js` 的 `unhandledrejection` 处理并写进 `app-errors.log`，等于污染被测应用。
**这是「停顿后第一键」的典型值，不是写入峰值**（峰值看 `max`）。

### 2.2 `flushMs`：前 ≈ 后，所以不是"预热"

每档前测 3 样本 + 后测 3 样本：

| 档 | 前（轮1 / 轮2） | 后（轮1 / 轮2） | 后−前 |
|---|---|---|---|
| S0 | 5.7 [5.3,5.7,6.0] / 4.8 [5.1,4.8,4.2] | 5.3 [4.3,5.6,5.3] / 3.9 [3.5,3.9,4.8] | −0.4 / −0.9 |
| S1 | 7.1 [7.2,7.1,5.5] / 6.6 [6.6,4.3,6.7] | 6.6 [6.6,9.1,6.3] / 7.5 [7.5,7.5,6.3] | −0.5 / +0.9 |
| S2 | 27.5 [27.5,26.5,28.1] / 24.8 [23.5,25,24.8] | 28.5 [28.5,24.2,29.1] / 23.6 [23.6,24.9,23.1] | +1.0 / −1.2 |
| S3 | 78.7 [78.7,70.2,80.2] / 67.7 [73.4,64.9,67.7] | 71.9 [71.9,68.5,74.9] / 80.6 [78.8,80.6,85.5] | −6.8 / +12.9 |

**前 ≈ 后，方向不一致、幅度在噪声内 → 「写路径预热 / 杀软摊销」不成立。**
早前版本报告过的 112ms 我无法在本 SHA 上复现（本 SHA 的 S3 是 67.7–78.7ms），推测是当时 `measureIpc` 5 次连打让主进程 250ms 兜底落盘 pending、`measureFlush` 排在另一笔写盘后面所致——**这条只有旁证，不能完全证明，且该数字已作废，不再引用**。

### 2.3 归因边界

- **「测量窗与落盘重叠」只适用于 `updateIpcMs`**（5 次连续采样，会与 pending 兜底落盘重叠）。
- **`inputHandlerMs` 不能用同一条解释**：它的探针挂在 `document` **捕获阶段**、`t0/t1` 都在同一轮事件派发内取，**快照时点不影响单个样本**；它的波动只能来自机器状态。

---

## 3. 方法

### 3.1 三道闸（防"驱动别人的实例把 12MB 写进真实便签"）

1. `--remote-debugging-port=0`，端口只从 stderr 的 `DevTools listening on ws://127.0.0.1:<PORT>/` 解析（本轮 50281 / 61962）；解析不到即 fail-fast，**代码里没有固定端口常量**。
2. spawn 前父进程与子进程 env 都删 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`（大小写共 6 个），保留并补 `NO_PROXY`。本机确实存在 `HTTP_PROXY=http://127.0.0.1:52899`。
3. fixture 标题写 `PERF-NONCE-<uuid>`，连上后 `window.sticky.list()` 断言 nonce + `#title` 同值，**在写入任何字符之前**执行。

### 3.2 测量口径

- `input` 监听挂 **`document` 捕获阶段**（DOM 事实：捕获阶段永远早于 target 阶段，**与注册顺序无关**）；`t0` 在捕获监听里取，`t1` 在 `setTimeout(0)` 里取 → `t1-t0` = 业务 handler + sync IPC 占住渲染层的时长（含一次定时器跳转；S0 的 3.00/3.50ms 说明这部分 <4ms）。
- 每档先灌 `editor.innerHTML` + `dispatchEvent(new InputEvent('input'))`，**等 2.5s** 再 `reset()` 打点。
- 每键前 focus + 选区 collapse 到末尾；`Input.insertText` 每次 1 个 ASCII 字符；**每键后回读 `textContent` 校验长度+1 且末字符正确**，不合格则 `execCommand('insertText')` 兜底；连续 4 次失败 → 该档报错退出。两轮全部 `keysOk=true / insertMode=cdp`。
- `updateIpcMs`：html 只序列化一次，5 次「`flush()` + 静置 300ms」后计时一次 `update`，取中位。
- `serializeProxyMs / serializePairMs / tailPathMs`：分别复刻 1 / 2 / 3 次整克隆（后者含 1 次 12MB sync IPC），逐行重写（不能改产品代码）。
- `longTasks` / `tailLongTask`：`PerformanceObserver` 按 `markTail()` 分桶，只记 ≥50ms。
- 图片：canvas 随机噪点（每张不同 seed）→ `toDataURL('image/jpeg', 0.72)` → **`Image.decode()` 真解码并断言 `naturalWidth>0`** → 按实测长度迭代到目标 ±30%（S2/S2N 单张 202,651–203,019 字符、605×454；S3 303,635–304,251 字符、741×556）。
- 数据正确性：最后一档（S3, 12MB）测完再敲 `PERFTAIL` → 显式 `flush()` → `app.quit()` → 读盘断言 `html` 含标记。两轮均通过（`html 长度 = 12,159,196`）。

### 3.3 隔离与清理

- 每轮 `mkdtempSync(os.tmpdir()/sticky-perf-*)` 作 `--user-data-dir`；不读写真实 `%APPDATA%\desktop-sticky-notes`。
- 结束走主进程 inspector 的 `app.quit()`（真实 `before-quit → flushSave`）；只有兜底才 `child.kill()` 自己的子进程。
- 清理：按**本次隔离目录的精确路径**清掉自己那棵树里的残留进程（**绝不按进程名批量杀**）→ 退避重试删除 → `existsSync` 校验；失败则打印告警路径。

---

## 4. 与产品代码的对应关系（只陈述事实，未做任何修改）

| 组 | 成本 | 位置 | 频率 |
|---|---|---|---|
| A | 每键 `innerHTML` 全量序列化 | `src/note.js:420-429` `onEditorChanged()` 的 `api.update({ html: editor.innerHTML, ... })` | 每个 `input` |
| A | 每键 sync IPC | `preload.js:14` `ipcRenderer.sendSync('note:update', patch)`；`main.js:1708` 直接 `returnValue` | 每个 `input` |
| B | 180ms 后克隆 1 | `note.js:402-403` `updateStats()` → `note.js:394-400` `plainText()` | 停顿 180ms 后 |
| B | 180ms 后克隆 2 | `note.js:378-386` `serializeHtml()` | 同上 |
| B | 180ms 后克隆 3 | `note.js:394-400` `plainText()`（preview） | 同上 |
| B | 180ms 后又一轮全量 sync IPC | `note.js:88-108` `queueSave()` 的 `api.update(patch)` | 同上 |
| C | 整库落盘 | `note.js:110-134` → `main.js:134` `flushSave()` → `lib/persistence.js:103` `writeState()` | 停顿 350ms 后 |
| C | 第二路整库写盘 | `main.js:1748` `applyNotePatch()` 末尾 `scheduleSave()`（250ms 兜底） | 每个 patch 重排一次 |

---

## 5. 定级口径

`inputHandlerMs.p95` 的分档（≤16 流畅 / 16–50 可感知 / 50–100 明显卡顿 / >100 不可用）**只覆盖 A 组**；60ms 连打会把 B/C 组整体压掉，所以定级必须同时看"每次停顿摊销"和 `S2N`。

| 档 | A 组 p95（轮1 / 轮2） | 每次停顿摊销* | S2N（真人节奏） | 定级 |
|---|---|---|---|---|
| S0 | 4.32 / 5.31 | 6.0 / 5.2ms | — | 流畅 |
| S1 | 9.07 / 7.23 | 13.6 / 11.6ms | — | 流畅 |
| S2 | 47.00 / 35.15 | **101.6 / 90.6ms** | **等效 ~100ms/键、22–24% 时长在长任务里** | **明显卡顿**（原"可感知"偏乐观） |
| S3 | 118.78 / 120.03 | **296.2 / 300.8ms** | 极速输入会积压（上限 9.2–10.2 键/秒） | **明显卡顿~不可用** |

\* 摊销 = `tailPathMs` + `flushMs`（前测）。短停顿（<530ms）只触发前者：S2 74.1 / 65.8ms、S3 217.5 / 233.1ms。

---

## 6. 局限

1. **单机、共享桌面、非独占**：同期多个常驻进程，CPU ≈117% 基频。两轮 `elapsedSec` 都是 52s，但外部复跑在更慢机器上绝对值更高（S0 6.85 vs 本机 3.00/3.50；S3 133.90 vs 本机 98.40/109.05）。**只给"定性 + 典型值 + 双向观测值"，不给紧区间。**
2. **分项与主指标不是同一时刻取样**：轮2 的 `read+ipc`（122.1ms）超过了同轮 `inputHandlerMs.p50`（98.40ms）。→ 分项只能做**量级对比**，不能严格加总。
3. **`cdpMs` 不可作结论依据**：`Input.insertText` 要等渲染层处理完才回，本身就含阻塞。
4. **`longTasks` 只登记 ≥50ms**；S2 两轮为 0 **只代表"本次快档没有"**。
5. **`serializeProxyMs` / `serializePairMs` / `tailPathMs` 都是逐行复刻**；`serializePairMs` 是下界；`pair − proxy` 不含 HTML 序列化。
6. **`updateIpcUnderFlushMs` 是固定相位（+10ms）的典型值**，非峰值；它同时含"主进程被 `writeFileSync` 占住"与"IPC 排队顺序"，不宜再细分。
7. **`capacityPerSec` 用中位数**，偏乐观；严格上限应看 `1/E[每次按键阻塞]`。
8. **图片是 canvas 噪点 JPEG**：字符量精确；编解码成本只是量级参考。
9. **未覆盖**：不同 DPI/屏幕缩放、真实键盘与 IME、最小化/完全遮挡、多便签争抢、非 Windows。

---

## 7. 复现

```bash
cd sticky-notes
node scripts/perf-input.js     # stdout 只有一个 JSON；进度日志走 stderr；单轮 52s
```

退出码：`0` = 五档测通且落盘含 `PERFTAIL`；非 0 = 档位超时/插字失败/落盘丢字/闸门失败（`stderr` 与 JSON 的 `error` 写明原因，`dataOk` 记 `null`）。

---

## 附录 A：两轮原始 JSON 关键字段

> 完整 JSON 由脚本直接输出到 stdout；以下为逐档关键字段的**原样摘录**，正文所有数字都出自这里。

### A.1 轮次 1

```
script: sha256=8ca3984e29a4bc6c3e05753c1a4bc56ccee818704a8a6ea20cb1c76f88018a7b
        mtime=2026-11-07T14:02:59.715Z  size=54429
        startedAt=2026-11-07T14:07:11.744Z  finishedAt=2026-11-07T14:08:03.307Z
        devtoolsPort=50281   elapsedSec=52   dataOk=true

S0   html=2070      file=3168      keys=20/60ms   p50=3.00   p95=4.32   max=4.70   keysOk=true mode=cdp
     read=0    ipc=1.2   ipcUF=0.5 (max 1.4, phase +10)    ser1=0    pair=0.1   tailPath=0.3
     flushF=5.7 [5.3,5.7,6.0]          flushE=5.3 [4.3,5.6,5.3]
     keysPerSec=11.06  capacity=333.33  LT=0/0/max0         tailLT=0/0
S1   html=201400    file=202498    keys=20/60ms   p50=4.95   p95=9.07   max=14.30  keysOk=true mode=cdp
     read=0.3  ipc=2.0   ipcUF=1.1 (max 1.7, phase +10)    ser1=0.5  pair=1.9   tailPath=6.5
     flushF=7.1 [7.2,7.1,5.5]          flushE=6.6 [6.6,9.1,6.3]
     keysPerSec=10.19  capacity=202.02  LT=0/0/max0         tailLT=0/0
S2   html=4060336   file=4061594   keys=20/60ms   p50=37.95  p95=47.00  max=49.00  keysOk=true mode=cdp
     read=15.7 ipc=14.5  ipcUF=27.7 (max 37.8, phase +10)   ser1=27.8 pair=37.6  tailPath=74.1
     flushF=27.5 [27.5,26.5,28.1]      flushE=28.5 [28.5,24.2,29.1]
     keysPerSec=7.75   capacity=26.35   LT=0/0/max0          tailLT=1/71
S2N  html=4060336   file=4061594   keys=10/200ms  p50=31.30  p95=36.49  max=37.30  keysOk=true mode=cdp
     （light：分项字段 null）
     keysPerSec=3.41   capacity=31.95   LT=10/697/max93      tailLT=0/0
S3   html=12159168  file=12160554  keys=20/60ms   p50=109.05 p95=118.78 max=122.10 keysOk=true mode=cdp
     read=49.4 ipc=40.3  ipcUF=97.7 (max 126.7, phase +10)  ser1=84.8 pair=121.8 tailPath=217.5
     flushF=78.7 [78.7,70.2,80.2]      flushE=71.9 [71.9,68.5,74.9]
     keysPerSec=5.09   capacity=9.17    LT=20/2153/max120    tailLT=1/230
```

### A.2 轮次 2

```
script: sha256=8ca3984e29a4bc6c3e05753c1a4bc56ccee818704a8a6ea20cb1c76f88018a7b
        mtime=2026-11-07T14:02:59.715Z  size=54429
        startedAt=2026-11-07T14:08:06.905Z  finishedAt=2026-11-07T14:08:58.524Z
        devtoolsPort=61962   elapsedSec=52   dataOk=true

S0   html=2070      file=3168      keys=20/60ms   p50=3.50   p95=5.31   max=7.50   keysOk=true mode=cdp
     read=0    ipc=0.9   ipcUF=0.5 (max 1.6, phase +10)    ser1=0    pair=0     tailPath=0.4
     flushF=4.8 [5.1,4.8,4.2]          flushE=3.9 [3.5,3.9,4.8]
     keysPerSec=11.30  capacity=285.71  LT=0/0/max0         tailLT=0/0
S1   html=201400    file=202498    keys=20/60ms   p50=5.40   p95=7.23   max=7.70   keysOk=true mode=cdp
     read=0.3  ipc=2.0   ipcUF=1.8 (max 1.9, phase +10)    ser1=0.5  pair=1.8   tailPath=5.0
     flushF=6.6 [6.6,4.3,6.7]          flushE=7.5 [7.5,7.5,6.3]
     keysPerSec=10.68  capacity=185.19  LT=0/0/max0         tailLT=0/0
S2   html=4060336   file=4061594   keys=20/60ms   p50=30.80  p95=35.15  max=39.90  keysOk=true mode=cdp
     read=14.1 ipc=12.1  ipcUF=21.5 (max 31.5, phase +10)   ser1=24.5 pair=36.0  tailPath=65.8
     flushF=24.8 [23.5,25,24.8]        flushE=23.6 [23.6,24.9,23.1]
     keysPerSec=8.62   capacity=32.47   LT=0/0/max0          tailLT=0/0
S2N  html=4060336   file=4061594   keys=10/200ms  p50=34.25  p95=42.45  max=46.00  keysOk=true mode=cdp
     （light：分项字段 null）
     keysPerSec=3.41   capacity=29.20   LT=10/661/max70      tailLT=0/0
S3   html=12159168  file=12160554  keys=20/60ms   p50=98.40  p95=120.03 max=128.20 keysOk=true mode=cdp
     read=62.1 ipc=60.0  ipcUF=95.2 (max 99.3, phase +10)   ser1=107.2 pair=122.6 tailPath=233.1
     flushF=67.7 [73.4,64.9,67.7]      flushE=80.6 [78.8,80.6,85.5]
     keysPerSec=5.30   capacity=10.16   LT=20/1977/max118    tailLT=0/0
```

（`flushF` = `flushMs` 前测；`flushE` = `flushMsEndMs` 后测；`read` = `innerHtmlReadMs`；`ipc` = `updateIpcMs`；`ipcUF` = `updateIpcUnderFlushMs`；`ser1` = `serializeProxyMs`；`pair` = `serializePairMs`；`LT` = `longTasks.count/totalMs/maxMs`；`tailLT` = `tailLongTask.count/maxMs`。）

---

## 附录 B：本轮安全校验记录

| 项 | 跑前 | 跑后（两轮结束） |
|---|---|---|
| `%APPDATA%\desktop-sticky-notes\sticky-notes.json` SIZE | 34094 | **34094** |
| MTIME | `2026-11-07T18:21:11.4763730+08:00` | **同值** |
| SHA256 | `DCE42ACECD03442D66BD50B5052637B039E4E69C7EFC0B34F09A10B3A4DAB83D` | **同值 → 逐字节不变** |

| 项 | 结果 |
|---|---|
| 脚本 SHA256（跑前 / 跑后） | `8CA3984E…` / `8CA3984E…` **完全一致**；mtime 均 `22:02:59.715`、size 均 54,429 |
| 残留 `electron.exe` | NONE（跑前 / 跑后都查过） |
| 残留 `%TEMP%\sticky-perf-*` | NONE |
| 端口 | 50281 / 61962，均内核分配；代码内无固定端口常量 |
| 闸 3 nonce | 两轮 nonce 不同，`list()` 返回 1 张、标题 = nonce、`#title` 同值 |
| 闸 1 fail-fast | 用同一段守卫对**不打印 DevTools listening** 的子进程验证：端口解析为 `null` → 25103ms 后抛错，文案含"拒绝回落到任何固定端口"，未尝试任何其它端口 |
| 对抗测试 | 干扰实例（标题 `DECOY-NOT-MINE`）全程占着 9334：脚本用自选端口跑完全部档位，干扰实例跑前/跑后都活着、其数据 SHA256 逐字节不变；闸 3 谓词探它 → nonce 未命中 → 判"不是我的"立即退出 |
