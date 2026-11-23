# 转换引擎插件开发指南

> 日期：2026-11-16
> 适用版本：桌面便签（sticky-notes）转换框架 v1
> 关联文档：`docs/convert-engine-framework-2026-11-16.md`、`docs/filee-code-reuse-feasibility-2026-11-16.md`

---

## 1. 这份文档解决什么问题

用户拍板的方向是「**先搭好框架，后续使用其他格式转换代码**」。

框架第一版做完后，还差最后一环：**新增转换引擎必须改核心文件** `lib/convert/providers/index.js`。
那只是多态，不是可插拔 —— 每接一个新引擎都要动核心代码、动版本控制、走一遍发版。

插件机制补上这一环：

> **把一个 `.js` 文件丢进插件目录 ⇒ 框架自动发现、校验、注册、参与路由。**
> **不需要改任何核心文件。**

---

## 2. 快速上手

### 2.1 投放位置

按优先级（第一个存在且有文件的即生效，可多个并存）：

| 顺序 | 位置 | 用途 |
|---|---|---|
| 1 | 环境变量 `STICKY_CONVERT_PLUGINS` 指定的路径（`;` 分隔多个） | 临时测试 / 团队分发 |
| 2 | `<userData>/convert-plugins/` | **用户自己投放**（设置页里会显示这个路径） |
| 3 | `<应用目录>/convert-plugins/` | 随安装分发的引擎 |

`<userData>` 在 Windows 上是 `%APPDATA%/<应用名>`。

### 2.2 最小可用插件

```js
// convert-plugins/my-engine.js
module.exports = {
  id: 'my-engine',              // 唯一 id（日志与测试断言用）
  name: '我的引擎',               // 设置页展示名

  async available () {
    return true                  // 引擎是否就绪（探测依赖是否存在）
  },

  async capabilities (ext) {
    // ext 是源扩展名（小写、不含点）
    return {
      ok: true,
      reason: 'ok',
      targets: ['pdf'],          // 现在就能转的目标
      withEngines: ['docx'],     // 需要额外组件才能转的目标（UI 会置灰）
      displayName: '我的格式',
      error: null
    }
  },

  async convert (files, target, outDir) {
    // files: 绝对路径数组；target: 目标扩展名；outDir: 产物目录
    const outputs = []
    for (const f of files) {
      const dest = path.join(outDir, path.basename(f) + '.' + target)
      fs.writeFileSync(dest, doConvert(f, target))
      outputs.push({ source: f, output: dest })
    }
    return {
      ok: true, reason: 'ok',
      outputs,                    // [{source, output}]
      failures: [],               // [{source, state:'failed', outputs:[], error}]
      files: [],
      error: null
    }
  }
}
```

投放后重启应用，在「设置 → 格式转换 → 当前可用的转换引擎」里就能看到它。

### 2.3 三种导出形态（都被支持）

```js
// ① 直接导出 provider 对象
module.exports = { id, name, available, capabilities, convert }

// ② 包一层
module.exports = { provider: { id, name, available, capabilities, convert } }

// ③ 工厂函数（推荐：能拿到上下文）
module.exports = function (deps) {
  // deps = { appDir, userDataDir, workerHost, log }
  return { id, name, available, capabilities, convert }
}
```

### 2.4 `canHandle`（可选）

不实现则默认「什么都能处理」。实现它可以表达「我只擅长这一类」，
路由会据此挑 provider：

```js
async canHandle (ext, target) {
  return ['doc', 'docx'].includes(ext) && target === 'pdf'
}
```

---

## 3. 契约

### 3.1 必需方法

| 方法 | 签名 | 说明 |
|---|---|---|
| `id` | `string` | 唯一标识 |
| `name` | `string` | 展示名 |
| `available()` | `→ Promise<boolean>` | 依赖是否就绪。**会带缓存**，需要实时探测就别在这里做重活 |
| `capabilities(ext)` | `→ Promise<caps>` | 某扩展名能转成什么 |
| `convert(files, target, outDir)` | `→ Promise<result>` | 执行转换 |

`canHandle(ext, target)` 可选。

### 3.2 返回结构

**capabilities**

```js
{
  ok: boolean,
  reason: 'ok' | 'usage' | 'not-installed' | 'needs-engine' | 'failed',
  targets: string[],      // 现在就能转
  withEngines: string[],  // 需要额外组件
  displayName: string | null,
  error: string | null
}
```

**convert**

```js
{
  ok: boolean,
  reason: string,
  outputs: [{
    source, output,              // 产物绝对路径
    warnings?: [{ code, message }]  // 产物级警告（见 3.2.1）
  }],
  failures: [{ source, state, outputs, error }],
  files: [],
  error: string | null,
  warnings?: [{ code, message }]   // 整体级警告（可选，多数场景用产物级就够）
}
```

#### 3.2.1 产物级 warnings：成功 ≠ 符合预期

有些情况**不该判失败，但用户必须知道**：

- 源 SVG 是空的 ⇒ 转出全透明 PNG（`ok:true` 是对的，但用户拿到空白图毫不知情）
- SVG 引用了外部图片，浏览器不加载 ⇒ 产物对应位置是空白
- 尺寸超过上限被等比缩小 ⇒ 产物比源图小

这类情况请挂 `outputs[i].warnings`，而不是只 `console.log` —— 日志用户看不到：

```js
const out = { source: src, output: dest }
if (rendered.blank) {
  out.warnings = [{
    code: 'blank',                // 稳定的分类，测试断言用
    message: '产物是全透明的空白图：源 SVG 没有可见内容'
  }]
}
```

框架会把警告一路带到 `attachments[i].warnings`，最后在状态栏显示橙黄色提示。
`code` 目前约定三种：`blank` / `external-ref` / `scaled`；`message` 是给用户看的中文。

> 插件在 `<userData>` 下没法 `require('../lib/convert/provider')`，
> 所以这些常量要在插件里本地维护一份副本，值必须与框架一致。

### 3.3 失败分类的语义（重要）

框架靠 `reason` 区分两类「做不到」，对用户的提示完全不同：

| reason | 含义 | 典型场景 |
|---|---|---|
| `not-installed` | **引擎没装** | 依赖缺失，探测阶段就失败 |
| `usage` | 引擎在，但**不支持这个组合** | 格式没实现、目标格式不支持 |
| `needs-engine` | 需要额外组件 | 装了某个第三方工具就能做 |

判错的后果很实际：`not-installed` 会提示用户「去装」，`usage` 提示「不支持」。
搞混会让用户白折腾。

---

## 3.5 完整示例：SVG 矢量插件

仓库里有一份可直接参考的**完整实现**：`examples/convert-plugins/svg.js`（424 行）。
它把 svg 转成 png/jpg/webp，是"投放即生效"这条链路的实证 —— **核心代码一行没改**。

```bash
# 试一下
cp examples/convert-plugins/svg.js "%APPDATA%/desktop-sticky-notes/convert-plugins/"
# 重启应用 → 设置 → 格式转换 → 当前可用的转换引擎 → 应看到「SVG 矢量（示例插件）」
```

从这个示例能学到的关键做法：

| 做法 | 为什么 |
|---|---|
| 用 `deps.workerHost.renderSvg()` 拿画布 | 插件运行在**主进程**，没有 DOM。canvas 只能在隐藏渲染窗口里用，必须走框架注入的 worker |
| 本地抄一份 `REASON` / `fail()` | 插件在 `<userData>` 下，`require('../lib/convert/provider')` 这种相对路径**必然失败**。常量值必须与框架一致（`ok`/`usage`/`not-installed`/`failed`），否则路由会判错失败分类 |
| 落盘前做**魔数校验** | 编码器可能"成功"但格式不对。宁可判失败也不产假文件 —— 假成功比报错危险得多 |
| 循环里用 `usedDest` 集合防同名 | 同批两个同名源文件会互相覆盖，产出 `ok:true` 但内容错位。这是最难发现的假成功 |
| 产物命名要可预期 + 防冲突 | 见上 |

**该示例的已知限制**（如实告知，别指望它做更多）：

| 限制 | 原因 |
|---|---|
| 外部资源（`<image href="http://...">`）不渲染 | Chromium 对 SVG-as-image 的安全策略，**根本不发请求**；产物对应位置为空白（插件会记 `externalRef` 日志） |
| `<foreignObject>` 明确失败 | HTML 内容会污染画布，`getImageData`/`toBlob` 抛 SecurityError |
| 只做 png/jpg/jpeg/webp | canvas 实测能编的就这三种；gif/bmp/avif/tiff 会**静默回退成 PNG**，所以不列出 |
| 最长边上限 8192 | 超出等比缩小并标 `scaled:true`；不做总像素限制（8192×8192 约 268MB 画布，实测能扛） |
| `%`/`em`/`cm` 等相对单位不做换算 | 回落 `viewBox`；**只有能解析成绝对像素的 width/height 才优先于 viewBox** |

> ⚠️ 最后一条踩过坑：曾经把"只要写了 width/height 就算作者声明了尺寸"当成判定条件，
> 于是 `<svg width="100%" viewBox="0 0 24 24">`（Figma/Illustrator 导出图标的高频写法）
> 被浏览器算出的默认盒值顶掉，24×24 变成 150×150 —— 6.25 倍放大。
> 教训：**"写了个属性"不等于"声明了绝对尺寸"**，相对单位必须让位给 viewBox。

---

## 4. 框架行为（插件作者需要知道的）

### 4.1 优先级

```
内置图片（canvas） → 内置文本/数据 → 插件 → Filee
```

插件排在 Filee 之前：插件是用户**显式投放**的，通常比 Filee 更贴合当前需求；
Filee 是最外层的兜底。

### 4.2 能力是**合并**的

用户看到的是所有可用引擎的 targets **并集**（去重、保序），
不是某一个引擎的子集。实际转换时路由会挑第一个能处理 `(ext → target)` 的引擎。

### 4.3 失败会自动兜底

一个引擎失败（抛异常或返回 `ok:false`）⇒ 自动试下一个候选引擎。
所以插件不必追求"覆盖所有情况"，覆盖不好会自然落到下一个。

### 4.4 加载失败不影响应用

- 语法错误 → 跳过，记日志
- 契约不满足 → 跳过，记日志（**会明确报出缺哪个方法**）
- 工厂函数抛错 → 跳过，记日志
- 加载异常 → 跳过，记日志

**任何一种都不会让应用起不来。** 日志在 `app-errors.log`。

---

## 5. 安全边界

插件代码是**本地任意 JS**，等价于往应用里插了一段代码 —— 它能做的事，
就是这个 Electron 主进程本来就能做的事。

本机制假设插件来源可信（用户自己放的 / 组织内部分发）。已做的防护：

- 加载失败只记日志、跳过，绝不 crash 应用
- 契约校验不通过的直接丢弃，不进注册表
- 插件只被 `require`，不获得任何额外特权通道

**不该做的事**：不要从网络下载并执行插件；不要把插件目录放在用户可写的共享位置。

---

## 6. 调试

插件没生效时，按这个顺序查：

1. **设置页 → 当前可用的转换引擎** 里有没有它？
   - 没有 ⇒ 发现阶段就没找到（目录放错？文件名不是 `.js`？以 `.`/`_` 开头会被跳过？）
2. 有，但显示「未启用」⇒ `available()` 返回了 false
3. 有且「已就绪」，但目标格式不出现 ⇒ `capabilities()` 返回的 `targets` 没包含它
4. 都不对 ⇒ 看 `app-errors.log`，里面会有 `[convert-plugins]` 开头的行

日志格式：`[convert-plugins] 契约校验失败：<file> —— <原因>`

---

## 7. 已验证

| 验证项 | 结果 |
|---|---|
| 单测 `test/convert-plugins.test.js` | 18/18 |
| 单测 `test/convert-svg-plugin.test.js`（示例插件） | 37/37 |
| 单测 `test/convert-service-workdir.test.js`（落盘） | 9/9 |
| e2e `scripts/e2e-convert-plugins.js`（真实启动） | 13/13 |
| e2e `scripts/e2e-convert-svg.js`（示例插件全链路） | 40/40 |
| 全量单测 | 291/291 |
| 全量 e2e + qa:audit | 全绿 |

e2e 覆盖的关键路径：插件被自动发现 → 能力并入 targets → 转换真的由插件执行 →
产物落盘且内容正确 → 坏插件不影响应用启动。

示例插件的 e2e 还额外覆盖了这些**负向**路径（比正向断言更能说明问题）：

| 负向场景 | 期望 | 为什么必须验 |
|---|---|---|
| 无尺寸信息的 SVG | 明确失败 + **产物目录零文件** | 否则会静默出一个 300×150 的默认盒假图 |
| `<foreignObject>` | 明确失败 + 零文件 + 文案可读 | 污染画布时必须报错，不能吞 |
| 0 字节 / 非 SVG 文本 | 明确失败 | 输入校验 |
| 同批同名源文件 | 两个不同路径、内容各自正确 | 防"内容错位"型假成功 |
| 编码器回退格式（如声称 webp 实际给 AVI） | 不落盘 | 魔数防线必须真硬 |

> 这些用例是**变异验证过**的：把修复改回 bug 写法，6 条会变红；
> 为了让回归通过而过度收窄，另 3 条会变红（其中一条是双向护栏）。
> 只有会红的断言才算护栏。
