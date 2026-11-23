'use strict'

/**
 * Filee CLI 适配层（纯逻辑 + spawn 封装，可被 node:test 驱动）。
 *
 * 官方口径来自 Filee 自带的 Agent Skill（skills/filee/SKILL.md），逐条遵守：
 *
 *  1. 转换命令**永远**带 `--json --quiet`：
 *     - `--json` 让结果是一份 JSON 文档；
 *     - `--quiet` 必需，因为不加时 `--json` 会把进度事件也写进 **stderr**
 *       （Filee 源码 Cli.cs:84 `JobEvents(errors, ..., progress: true)`），
 *       合并 stdout/stderr 会把结果打坏。
 *     ★ 本实现**主动分流 stdout 与 stderr**（不合并），所以即便将来要增量进度
 *       也能拿到，不与官方口径冲突。
 *  2. **不能只看退出码**。退出码 0 只表示「没有文件失败或被取消」，
 *     可能有文件是 skipped。必须读 JSON 里每个文件的 `state` 与 `outputs`。
 *  3. 一个文件只有在 `state === 'done'` 且 `outputs` 非空时才算转换成功。
 *
 * 退出码（官方）：
 *   0 无失败/取消（可能有 skipped）   1 部分失败或取消
 *   2 参数错/未知格式/缺输入（**无 JSON**）   3 无可转换项（**无 JSON**）
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ---------------------------------------------------------------- 退出码

const EXIT_OK = 0
const EXIT_SOME_FAILED = 1
const EXIT_USAGE = 2
const EXIT_NOTHING_TO_DO = 3

// ---------------------------------------------------------------- 错误分类

/** 转换没能完成的原因分类；UI 按这个给不同的文案 */
const REASON = {
  OK: 'ok',
  NEEDS_ENGINE: 'needs-engine',
  USAGE: 'usage',
  NOTHING_TO_DO: 'nothing-to-do',
  NOT_INSTALLED: 'not-installed',
  TIMEOUT: 'timeout',
  SPAWN_FAILED: 'spawn-failed',
  FAILED: 'failed'
}

/** 失败详情里的稳定标识（便于 UI 与测试断言） */
const ERROR_KEY = {
  NO_ROUTE: 'error.no_route',
  ENGINE: 'error.engine'
}

// ---------------------------------------------------------------- 纯逻辑部分

/**
 * 解析 `filee formats <fmt> --json` 的输出。
 *
 * 实际结构（Filee 源码 Cli.cs:429 核实）：
 *   { id, displayName, extensions:[...], targets:[...], withEngines:[...] }
 *   - targets     现在就能转（不需要额外引擎）
 *   - withEngines 装了对应引擎才能转
 *
 * @param {string} stdout
 * @returns {{ok: boolean, targets: string[], withEngines: string[], displayName: string|null, extensions: string[], error: string|null}}
 */
function parseFormats (stdout) {
  const empty = { ok: false, targets: [], withEngines: [], displayName: null, extensions: [], error: '无法解析格式表' }
  let data
  try {
    data = JSON.parse(String(stdout || '').trim())
  } catch (e) {
    return Object.assign({}, empty, { error: '无法解析格式表：' + e.message })
  }
  if (!data || typeof data !== 'object') return empty
  const toArr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
  return {
    ok: true,
    targets: toArr(data.targets),
    withEngines: toArr(data.withEngines),
    displayName: typeof data.displayName === 'string' ? data.displayName : null,
    extensions: toArr(data.extensions),
    error: null
  }
}

/**
 * 解析 `filee convert --json` 的输出。
 *
 * 结构（Cli.cs:216 WriteJson 核实）：
 *   { preset, target, converted, skipped, failed,
 *     files:[ { source, state, outputs:[], error?, errorKey?, needsEngines?[] } ] }
 * state ∈ done | skipped | failed | cancelled
 *
 * @param {string} stdout
 * @param {number} code 进程退出码
 * @param {string} stderr
 * @returns {{ok: boolean, reason: string, target: string|null, converted: number,
 *            skipped: number, failed: number, files: Array, error: string|null}}
 */
function parseConvertResult (stdout, code, stderr = '') {
  const errText = String(stderr || '').trim()
  const fail = (reason, error) => ({
    ok: false, reason, target: null, converted: 0, skipped: 0, failed: 0, files: [], error: error || null
  })

  // 退出码 2 / 3 时官方约定「没有 JSON」，原因在 stderr
  if (code === EXIT_USAGE) return fail(REASON.USAGE, errText || '参数错误或缺少输入')
  if (code === EXIT_NOTHING_TO_DO) return fail(REASON.NOTHING_TO_DO, errText || '没有可转换的内容')

  let data
  try {
    data = JSON.parse(String(stdout || '').trim())
  } catch (e) {
    // 有 JSON 预期却解析不了：算整体失败，但保留 stderr 以便排查
    return fail(REASON.FAILED, errText || ('无法解析转换结果：' + e.message))
  }
  if (!data || typeof data !== 'object') return fail(REASON.FAILED, '转换结果格式异常')

  const files = Array.isArray(data.files) ? data.files : []
  const normalized = files.map(f => ({
    source: typeof f.source === 'string' ? f.source : '',
    state: typeof f.state === 'string' ? f.state : 'failed',
    outputs: Array.isArray(f.outputs) ? f.outputs.filter(x => typeof x === 'string') : [],
    error: typeof f.error === 'string' ? f.error : null,
    errorKey: typeof f.errorKey === 'string' ? f.errorKey : null,
    needsEngines: Array.isArray(f.needsEngines) ? f.needsEngines.filter(x => typeof x === 'string') : []
  }))

  const converted = typeof data.converted === 'number'
    ? data.converted
    : normalized.filter(f => f.state === 'done').length
  const skipped = typeof data.skipped === 'number'
    ? data.skipped
    : normalized.filter(f => f.state === 'skipped').length
  const failed = typeof data.failed === 'number'
    ? data.failed
    : normalized.filter(f => f.state === 'failed' || f.state === 'cancelled').length

  // 缺引擎是**可引导**的失败：告诉用户去 Filee 的 Settings → Engines 装
  const needsEngine = normalized.find(f =>
    (Array.isArray(f.needsEngines) && f.needsEngines.length > 0) ||
    f.errorKey === ERROR_KEY.NO_ROUTE ||
    f.errorKey === ERROR_KEY.ENGINE)

  // ★ 判定：只有 state==='done' 且 outputs 非空才算成功（官方口径）
  const succeeded = normalized.filter(f => f.state === 'done' && f.outputs.length > 0)

  if (succeeded.length === 0) {
    const reason = needsEngine ? REASON.NEEDS_ENGINE : REASON.FAILED
    const firstBad = normalized.find(f => f.state === 'failed' || f.state === 'cancelled')
    return {
      ok: false,
      reason,
      target: typeof data.target === 'string' ? data.target : null,
      converted: 0,
      skipped,
      failed,
      files: normalized,
      error: needsEngine
        ? ('需要引擎：' + needsEngine.needsEngines.join(', '))
        : ((firstBad && firstBad.error) || errText || '转换失败')
    }
  }

  return {
    ok: true,
    reason: REASON.OK,
    target: typeof data.target === 'string' ? data.target : null,
    converted,
    skipped,
    failed,
    files: normalized,
    error: null
  }
}

/**
 * 把一次转换的结果归并成「产物列表 + 失败列表」。
 * 只有 state==='done' 且 outputs 非空的才进产物。
 */
function collectOutputs (result) {
  const outputs = []
  const failures = []
  for (const f of (result && result.files) || []) {
    if (f.state === 'done' && f.outputs.length) {
      for (const o of f.outputs) outputs.push({ source: f.source, output: o })
    } else if (f.state === 'failed' || f.state === 'cancelled') {
      failures.push(f)
    }
  }
  return { outputs, failures }
}

/**
 * 从文件路径取扩展名（小写、不含点），用作 `filee formats <ext>` 的查询键。
 */
function extOf (filePath) {
  const base = path.basename(String(filePath || ''))
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

// ---------------------------------------------------------------- spawn 封装

/** 默认超时（毫秒）。转换大文件可能要很久，但不能无限等。 */
const DEFAULT_TIMEOUT_MS = 120000

/**
 * 找到 Filee 的 CLI 可执行文件。
 *
 * 安装形态决定 CLI 位置（官方 SKILL.md 明确）：
 *   - Setup 安装且勾了「Add the filee command to PATH」→ PATH 上的 `filee`
 *   - Windows 免安装 zip → <Filee目录>\cli\filee.cmd 或 filee-cli.exe
 *   - Linux / macOS install.sh → $HOME/.local/bin/filee（该目录须在 PATH）
 *
 * 探测范式照抄 main.js 的 pythonBin()：逐候选试、缓存结果、失败就退化成空串。
 *
 * @param {object} [opts]
 * @param {string} [opts.envVar] 环境变量覆盖（STICKY_FILEE）
 * @param {string} [opts.appDir] 应用安装目录（用于找 cli\filee.cmd）
 * @returns {string} 找到则返回可执行路径/命令名；找不到返回空串
 */
function findFileeBin (opts = {}) {
  const envVar = opts.envVar || 'STICKY_FILEE'
  const cands = []

  const fromEnv = process.env[envVar]
  if (fromEnv) cands.push(fromEnv)

  // PATH 上的 filee（Setup 安装的默认形态）
  cands.push('filee', 'filee-cli')

  // 便携 zip 形态：<安装目录>\cli\filee.cmd 或 filee-cli.exe
  const appDir = opts.appDir || ''
  if (appDir) {
    cands.push(path.join(appDir, 'cli', 'filee.cmd'))
    cands.push(path.join(appDir, 'cli', 'filee-cli.exe'))
    cands.push(path.join(appDir, 'filee-cli.exe'))
  }

  // Linux / macOS 的默认安装位置
  const home = os.homedir()
  if (home) {
    cands.push(path.join(home, '.local', 'bin', 'filee'))
  }

  for (const c of cands) {
    try {
      if (path.isAbsolute(c)) {
        // 绝对路径候选：文件必须存在，且要真的能跑起来（防止指向一个同名的坏文件）
        if (!fs.existsSync(c)) continue
        if (probeVersion(c)) return c
        continue
      }
      // PATH 上的命令：跑一下 version，退出码 0 才算可用
      if (probeVersion(c)) return c
    } catch (_) {}
  }
  return ''
}

/**
 * 探测某个候选是不是可用的 Filee CLI：跑 `version`，退出码 0 即可。
 *
 * ★ Windows 硬约束：`.cmd`/`.bat` 不能被 CreateProcess 直接执行（会 EINVAL），
 *   必须经 `cmd.exe /d /s /c`。便携 zip 形态的 filee.cmd 正是这种文件，
 *   所以这里必须复用 resolveRunner，不能直接 spawnSync。
 */
function probeVersion (bin) {
  try {
    const runner = resolveRunner(bin)
    const r = spawnSync(runner.cmd, runner.args.concat(['version']), {
      timeout: 5000, windowsHide: true, encoding: 'utf8'
    })
    return !!(r && r.status === 0)
  } catch (_) {
    return false
  }
}

/**
 * 把「命令」解析成可 spawn 的执行器。
 *
 * Windows 硬约束：`.cmd` / `.bat` **不能**被 CreateProcess 直接执行，
 * 必须经 `cmd.exe /c`（官方 SKILL.md 提到 Windows 形态是 `cli\filee.cmd`）。
 * 走 cmd.exe 时要注意：
 *   - `/d` 关掉 AutoRun，避免用户注册表里的 AutoRun 劫持命令；
 *   - `/s` 让引号按 cmd 的规则整体处理；
 *   - 参数里的特殊字符需要 cmd 层面的转义，否则路径中的 & | > ^ 会被 shell 解释。
 *
 * @param {string|{cmd:string,args?:string[]}} bin
 * @returns {{cmd:string, args:string[]}}
 */
function resolveRunner (bin) {
  if (bin && typeof bin === 'object' && typeof bin.cmd === 'string') {
    return { cmd: bin.cmd, args: Array.isArray(bin.args) ? bin.args.slice() : [] }
  }
  const cmd = String(bin || '')
  if (/\.(cmd|bat)$/i.test(cmd)) {
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', cmd] }
  }
  return { cmd, args: [] }
}

/**
 * 跑一次 filee 命令，拿到 stdout / stderr / 退出码。
 * **stdout 与 stderr 分流，不合并**（见文件头说明）。
 *
 * @param {string|{cmd:string,args?:string[]}} bin 命令，或执行器描述
 *        （执行器用于「用 node 跑一个脚本」这类形态：{cmd: process.execPath, args:['x.js']}）
 * @param {string[]} args
 * @param {object} [opts]
 * @param {number} [opts.timeout]
 * @param {string} [opts.cwd]
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean, spawnError:Error|null}>}
 */
function runFilee (bin, args, opts = {}) {
  return new Promise(resolve => {
    // Windows 上 .cmd/.bat 不能被 CreateProcess 直接执行，必须经 cmd.exe /c
    const runner = resolveRunner(bin)
    const finalArgs = runner.args.concat(args)

    let child
    try {
      child = spawn(runner.cmd, finalArgs, {
        windowsHide: true,
        cwd: opts.cwd || undefined,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: '', timedOut: false, spawnError: err })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch (_) {}
    }, opts.timeout || DEFAULT_TIMEOUT_MS)

    child.stdout.on('data', d => { stdout += String(d) })
    child.stderr.on('data', d => { stderr += String(d) })

    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr, timedOut, spawnError: err })
    })

    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr, timedOut, spawnError: null })
    })
  })
}

// ---------------------------------------------------------------- 对外接口

/**
 * 查询某扩展名能转成什么。
 *
 * @param {string} bin Filee CLI 路径
 * @param {string} ext 扩展名（如 'heic'）
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, reason:string, targets:string[], withEngines:string[], displayName:string|null, error:string|null}>}
 */
async function capabilities (bin, ext, opts = {}) {
  if (!bin) {
    return {
      ok: false, reason: REASON.NOT_INSTALLED, targets: [], withEngines: [],
      displayName: null, error: '未找到 Filee'
    }
  }
  const e = String(ext || '').replace(/^\./, '').toLowerCase()
  if (!e) {
    return {
      ok: false, reason: REASON.USAGE, targets: [], withEngines: [],
      displayName: null, error: '无法识别文件类型'
    }
  }
  const r = await runFilee(bin, ['formats', e, '--json'], opts)
  if (r.spawnError) {
    return {
      ok: false, reason: REASON.SPAWN_FAILED, targets: [], withEngines: [],
      displayName: null, error: r.spawnError.message
    }
  }
  if (r.timedOut) {
    return {
      ok: false, reason: REASON.TIMEOUT, targets: [], withEngines: [],
      displayName: null, error: '查询超时'
    }
  }
  // 退出码 2 = 未知格式（Filee 对不认识的扩展名就是这个码）
  if (r.code === EXIT_USAGE) {
    return {
      ok: false, reason: REASON.USAGE, targets: [], withEngines: [],
      displayName: null, error: (r.stderr || '').trim() || ('不支持的格式：' + e)
    }
  }
  const parsed = parseFormats(r.stdout)
  if (!parsed.ok) return Object.assign({}, parsed, { reason: REASON.FAILED })
  return {
    ok: true,
    reason: REASON.OK,
    targets: parsed.targets,
    withEngines: parsed.withEngines,
    displayName: parsed.displayName,
    error: null
  }
}

/**
 * 执行转换。
 *
 * @param {string} bin
 * @param {string[]} files 输入文件路径
 * @param {string} target 目标格式（如 'jpg'）
 * @param {string} outDir 输出目录
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, reason:string, outputs:Array, failures:Array, files:Array, error:string|null}>}
 */
async function convert (bin, files, target, outDir, opts = {}) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
  if (!bin) {
    return { ok: false, reason: REASON.NOT_INSTALLED, outputs: [], failures: [], files: [], error: '未找到 Filee' }
  }
  if (!list.length) {
    return { ok: false, reason: REASON.USAGE, outputs: [], failures: [], files: [], error: '没有待转换的文件' }
  }
  if (!target) {
    return { ok: false, reason: REASON.USAGE, outputs: [], failures: [], files: [], error: '未指定目标格式' }
  }

  const args = [
    'convert',
    ...list,
    '--to', String(target),
    '-o', String(outDir),
    '--overwrite',
    '--json',
    '--quiet'
  ]

  const r = await runFilee(bin, args, opts)
  if (r.spawnError) {
    return { ok: false, reason: REASON.SPAWN_FAILED, outputs: [], failures: [], files: [], error: r.spawnError.message }
  }
  if (r.timedOut) {
    return { ok: false, reason: REASON.TIMEOUT, outputs: [], failures: [], files: [], error: '转换超时' }
  }

  const result = parseConvertResult(r.stdout, r.code, r.stderr)
  const { outputs, failures } = collectOutputs(result)
  return {
    ok: result.ok,
    reason: result.reason,
    outputs,
    failures,
    files: result.files,
    error: result.error
  }
}

module.exports = {
  EXIT_OK,
  EXIT_SOME_FAILED,
  EXIT_USAGE,
  EXIT_NOTHING_TO_DO,
  REASON,
  ERROR_KEY,
  DEFAULT_TIMEOUT_MS,
  parseFormats,
  parseConvertResult,
  collectOutputs,
  extOf,
  resolveRunner,
  findFileeBin,
  probeVersion,
  runFilee,
  capabilities,
  convert
}
