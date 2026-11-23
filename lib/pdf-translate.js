'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_CONFIG = Object.freeze({
  backend: 'cli', // 'cli' | 'server'
  cliPath: '',
  serverUrl: 'http://127.0.0.1:8888',
  service: 'active-ai', // 'active-ai' | 'bing' | 'google' | 'deepl'
  langIn: 'en',
  langOut: 'zh',
  mode: 'dual', // 'dual' | 'mono'
  threads: 4,
  pageRange: '',
  ignoreCache: false,
  skipTermExtraction: true
})

const VALID_BACKENDS = new Set(['cli', 'server'])
const VALID_SERVICES = new Set(['active-ai', 'bing', 'google', 'deepl'])
const VALID_MODES = new Set(['dual', 'mono'])
const VALID_LANG_CODE_RE = /^[a-zA-Z]{2,5}(?:-[a-zA-Z0-9]{2,4})?$/
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g

/**
 * 清理页码范围字符串，仅保留数字、逗号、连字符和空格，避免 CLI 参数注入
 */
function sanitizePageRange (raw) {
  const cleaned = String(raw || '').trim()
  if (!cleaned) return ''
  // 允许形如 "1-3, 5, 8-10" 的页码范围
  const compact = cleaned.replace(/\s+/g, '')
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(compact)) {
    return ''
  }
  return compact
}

/**
 * 规范化 server URL，无效时回落默认值
 */
function normalizeServerUrl (raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return DEFAULT_CONFIG.serverUrl
  try {
    const u = new URL(s)
    if (u.protocol === 'http:' || u.protocol === 'https:') return s
  } catch (_) {}
  return DEFAULT_CONFIG.serverUrl
}

function normalizeLangCode (raw, fallback, allowAuto) {
  const s = String(raw || '').trim()
  if (!s) return fallback
  if (allowAuto && s.toLowerCase() === 'auto') return 'auto'
  return VALID_LANG_CODE_RE.test(s) ? s : fallback
}

/**
 * 规范化文献翻译设置，兼容缺失/脏数据
 */
function normalizeTranslateConfig (raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const threadsNum = Number(src.threads)
  const threads = Number.isFinite(threadsNum)
    ? Math.max(1, Math.min(16, Math.round(threadsNum)))
    : DEFAULT_CONFIG.threads

  return {
    backend: VALID_BACKENDS.has(src.backend) ? src.backend : DEFAULT_CONFIG.backend,
    cliPath: typeof src.cliPath === 'string' ? src.cliPath.trim() : DEFAULT_CONFIG.cliPath,
    serverUrl: normalizeServerUrl(src.serverUrl),
    service: VALID_SERVICES.has(src.service) ? src.service : DEFAULT_CONFIG.service,
    langIn: normalizeLangCode(src.langIn, DEFAULT_CONFIG.langIn, true),
    langOut: normalizeLangCode(src.langOut, DEFAULT_CONFIG.langOut, false),
    mode: VALID_MODES.has(src.mode) ? src.mode : DEFAULT_CONFIG.mode,
    threads,
    pageRange: sanitizePageRange(src.pageRange),
    ignoreCache: src.ignoreCache === true,
    skipTermExtraction: src.skipTermExtraction !== false
  }
}

/**
 * 枚举本地可能的 pdf2zh_next / pdf2zh 可执行路径
 */
function detectCliCandidates ({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  customPath = ''
} = {}) {
  const seen = new Set()
  const list = []
  const push = (v) => {
    const s = String(v || '').trim()
    if (!s || seen.has(s)) return
    seen.add(s)
    list.push(s)
  }

  if (env && env.STICKY_PDF2ZH) push(env.STICKY_PDF2ZH)
  if (customPath) push(customPath)

  push('pdf2zh_next')
  push('pdf2zh')

  if (platform === 'win32') {
    const appData = (env && env.APPDATA) || path.join(homeDir, 'AppData', 'Roaming')
    const localAppData = (env && env.LOCALAPPDATA) || path.join(homeDir, 'AppData', 'Local')
    push(path.join(homeDir, '.local', 'bin', 'pdf2zh_next.exe'))
    push(path.join(homeDir, '.local', 'bin', 'pdf2zh.exe'))
    push(path.join(appData, 'uv', 'tools', 'pdf2zh-next', 'Scripts', 'pdf2zh_next.exe'))
    push(path.join(localAppData, 'uv', 'tools', 'pdf2zh-next', 'Scripts', 'pdf2zh_next.exe'))
    push(path.join(homeDir, '.local', 'share', 'uv', 'tools', 'pdf2zh-next', 'Scripts', 'pdf2zh_next.exe'))
    push(path.join(appData, 'uv', 'tools', 'pdf2zh', 'Scripts', 'pdf2zh.exe'))
    push(path.join(localAppData, 'uv', 'tools', 'pdf2zh', 'Scripts', 'pdf2zh.exe'))
  } else {
    push(path.join(homeDir, '.local', 'bin', 'pdf2zh_next'))
    push(path.join(homeDir, '.local', 'bin', 'pdf2zh'))
    push('/opt/homebrew/bin/pdf2zh_next')
    push('/opt/homebrew/bin/pdf2zh')
    push('/usr/local/bin/pdf2zh_next')
    push('/usr/local/bin/pdf2zh')
  }

  return list
}

/**
 * 枚举本地可能的 uv 可执行路径
 */
function detectUvCandidates ({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir()
} = {}) {
  const seen = new Set()
  const list = []
  const push = (v) => {
    const s = String(v || '').trim()
    if (!s || seen.has(s)) return
    seen.add(s)
    list.push(s)
  }

  if (env && env.STICKY_UV) push(env.STICKY_UV)
  push('uv')

  if (platform === 'win32') {
    const appData = (env && env.APPDATA) || path.join(homeDir, 'AppData', 'Roaming')
    const localAppData = (env && env.LOCALAPPDATA) || path.join(homeDir, 'AppData', 'Local')
    push(path.join(homeDir, '.local', 'bin', 'uv.exe'))
    push(path.join(homeDir, '.cargo', 'bin', 'uv.exe'))
    push(path.join(localAppData, 'Programs', 'uv', 'uv.exe'))
    push(path.join(appData, 'uv', 'uv.exe'))
  } else {
    push(path.join(homeDir, '.local', 'bin', 'uv'))
    push(path.join(homeDir, '.cargo', 'bin', 'uv'))
    push('/opt/homebrew/bin/uv')
    push('/usr/local/bin/uv')
  }

  return list
}

/**
 * 构建 uv tool install 调用参数（仅传递安全白名单参数）
 */
function buildUvInstallInvocation ({
  uvPath,
  upgrade = true,
  pythonVersion = '3.12',
  packageName = 'pdf2zh-next',
  indexUrl = ''
} = {}) {
  const binPath = String(uvPath || '').trim()
  if (!binPath) throw new Error('缺少 uv 可执行文件路径')

  const rawPy = String(pythonVersion || '').trim()
  const pyVer = /^\d+\.\d+(?:\.\d+)?$/.test(rawPy) ? rawPy : '3.12'
  const rawPkg = String(packageName || '').trim()
  const pkg = /^[a-zA-Z0-9._-]+$/.test(rawPkg) ? rawPkg : 'pdf2zh-next'

  const args = ['tool', 'install', '--python', pyVer]
  if (upgrade) args.push('--upgrade')

  const cleanedIndex = String(indexUrl || '').trim()
  if (cleanedIndex) {
    let parsed
    try {
      parsed = new URL(cleanedIndex)
    } catch (_) {
      throw new Error('镜像源地址格式无效')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`不支持的镜像源协议: ${parsed.protocol}`)
    }
    args.push('--default-index', cleanedIndex)
  }

  args.push(pkg)
  return {
    binPath,
    args,
    env: {
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      NO_COLOR: '1'
    }
  }
}

/**
 * 解析 uv 安装输出行，提取阶段与安全截断消息
 */
function parseInstallLine (line) {
  const text = String(line || '').replace(ANSI_RE, '').trim()
  if (!text) return null

  let stage = 'running'
  if (/error:|failed|traceback/i.test(text)) stage = 'error'
  else if (/installed\b|already installed|已安装/i.test(text)) stage = 'installed'
  else if (/download|fetching|built\b|prepared\b/i.test(text)) stage = 'downloading'
  else if (/resolv/i.test(text)) stage = 'resolving'

  return {
    stage,
    message: text.slice(0, 260)
  }
}

/**
 * 识别 CLI 属于 pdf2zh_next (2.x) 还是经典 pdf2zh (1.x)
 */
function classifyCliKind (binPath, versionText = '') {
  const base = path.basename(String(binPath || ''))
  const ver = String(versionText || '')
  if (/pdf2zh[_-]?next|babeldoc/i.test(ver) || /pdf2zh[_-]?next/i.test(base)) {
    return 'pdf2zh_next'
  }
  return 'pdf2zh'
}

/**
 * 构建子进程调用参数与隔离环境变量
 * 安全约定：active-ai 模式下绝不传入真实 API Key，仅经由 env.OPENAI_API_KEY 传递一次性代理 Token
 */
function buildCliInvocation ({ kind, binPath, inputPdf, outputDir, config, proxy }) {
  if (!binPath) throw new Error('未检测到 pdf2zh_next / pdf2zh 可执行程序')
  if (!inputPdf) throw new Error('缺少待翻译 PDF 文件路径')
  if (!outputDir) throw new Error('缺少翻译输出暂存目录')

  const cfg = normalizeTranslateConfig(config)
  const resolvedKind = kind || classifyCliKind(binPath)
  const args = [inputPdf]
  const env = {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1'
  }

  if (cfg.service === 'active-ai') {
    if (!proxy || !proxy.baseUrl || !proxy.token || !proxy.model) {
      throw new Error('缺少本地一次性代理信息，无法安全传递模型凭据')
    }
    env.OPENAI_API_KEY = proxy.token
    env.OPENAI_BASE_URL = proxy.baseUrl
    env.OPENAI_MODEL = proxy.model
    // pdf2zh_next 2.x (pydantic-settings env_prefix='PDF2ZH_') 仅识别 PDF2ZH_ 前缀环境变量
    env.PDF2ZH_OPENAI_API_KEY = proxy.token
    env.PDF2ZH_OPENAI_BASE_URL = proxy.baseUrl
    env.PDF2ZH_OPENAI_MODEL = proxy.model
  }

  if (resolvedKind === 'pdf2zh_next') {
    // 强制开启 Rich 宽列进度条刷新，避免非 TTY 管道吞掉实时进度或 80 列折行
    env.COLUMNS = '200'
    env.FORCE_COLOR = '1'
    if (cfg.langIn && cfg.langIn !== 'auto') args.push('--lang-in', cfg.langIn)
    args.push('--lang-out', cfg.langOut)
    args.push('--output', outputDir)
    args.push('--qps', String(cfg.threads))
    args.push('--report-interval', '0.5')
    if (cfg.mode === 'dual') args.push('--no-mono')
    else if (cfg.mode === 'mono') args.push('--no-dual')
    if (cfg.pageRange) args.push('--pages', cfg.pageRange)
    if (cfg.ignoreCache) args.push('--ignore-cache')
    if (cfg.skipTermExtraction) args.push('--no-auto-extract-glossary')

    if (cfg.service === 'active-ai') {
      args.push('--openai', '--openai-model', proxy.model, '--openai-base-url', proxy.baseUrl, '--openai-timeout', '60')
    } else if (cfg.service === 'bing') {
      args.push('--bing')
    } else if (cfg.service === 'google') {
      args.push('--google')
    } else if (cfg.service === 'deepl') {
      args.push('--deepl')
    }
  } else {
    args.push('-li', cfg.langIn === 'auto' ? 'en' : cfg.langIn)
    args.push('-lo', cfg.langOut)
    args.push('-o', outputDir)
    args.push('-t', String(cfg.threads))
    if (cfg.pageRange) args.push('-p', cfg.pageRange)
    if (cfg.ignoreCache) args.push('--ignore-cache')

    if (cfg.service === 'active-ai') {
      args.push('-s', 'openai')
    } else {
      args.push('-s', cfg.service)
    }
  }

  return {
    binPath,
    kind: resolvedKind,
    args,
    env
  }
}

const RICH_STAGE_RULES = [
  { re: /^Parse PDF and Create Intermediate Representation\b/i, stage: 'parsing', label: '正在解析 PDF 文档结构', percent: null },
  { re: /^DetectScannedFile\b/i, stage: 'parsing', label: '正在检测是否为扫描版 PDF', percent: null },
  { re: /^Parse Page Layout\b/i, stage: 'parsing', label: '正在识别页面版面与公式区域', percent: null },
  { re: /^Parse Paragraphs\b/i, stage: 'parsing', label: '正在切分正文段落', percent: null },
  { re: /^Parse Formulas and Styles\b/i, stage: 'parsing', label: '正在识别公式与排版样式', percent: null },
  { re: /^Automatic Term Extraction\b/i, stage: 'translating', label: '正在提取专业术语表', percent: null },
  { key: 'translate-paragraphs', re: /^Translate Paragraphs\b/i, stage: 'translating', label: '正在翻译正文段落', percent: null },
  { re: /^Typesetting\b/i, stage: 'rendering', label: '正在重排译文版式', percent: 89 },
  { re: /^Add Fonts\b/i, stage: 'rendering', label: '正在加载中文字体资源', percent: 91 },
  { re: /^Generate drawing instructions\b/i, stage: 'rendering', label: '正在生成页面绘制指令', percent: 92 },
  { re: /^Subset font\b/i, stage: 'rendering', label: '正在优化并压缩字体子集', percent: 93 },
  { re: /^Save PDF\b/i, stage: 'rendering', label: '正在保存输出译文 PDF', percent: 95 }
]

/**
 * 解析 pdf2zh_next / pdf2zh 标准输出中的进度信息
 */
function parseProgressLine (line) {
  const text = String(line || '').replace(ANSI_RE, '').trim()
  if (!text) return null

  // 忽略 Rich 进度条换行重绘碎片与无害 lopdf trailer 告警，防止覆盖可读状态
  if (
    /^translate$/i.test(text) ||
    /^[-━─\s]+$/.test(text) ||
    /^(?:\d{1,2}:\d{2}(?::\d{2})?|-:--:--|…|\s)+$/.test(text) ||
    /lopdf::reader|entry of trailer dictionary/i.test(text)
  ) {
    return null
  }

  // 1. pdf2zh_next 总进度条（translate ---- X/100）
  const overallMatch = text.match(/^translate\s+[-━─\s]*(\d{1,3})\s*\/\s*100\b/i)
  if (overallMatch) {
    const pct = Math.max(0, Math.min(100, Number(overallMatch[1])))
    return {
      percent: pct,
      stage: 'translating',
      message: `正在翻译学术文献（${pct}%）`
    }
  }

  // 2. pdf2zh_next Rich 子阶段行（忽略标题中的 (1/1) 分片号，仅提取进度条后的已完成计数）
  for (const rule of RICH_STAGE_RULES) {
    if (!rule.re.test(text)) continue
    const barCount = text.match(/[-━─]{2,}\s*(\d+)\s*\/\s*(\d+)/)
    let ratio = null
    let suffix = ''
    let percent = rule.percent
    if (barCount) {
      const cur = Number(barCount[1])
      const total = Number(barCount[2])
      suffix = ` (${cur}/${total})`
      if (total > 0 && cur >= 0 && cur <= total) {
        ratio = { cur, total }
        if (rule.key === 'translate-paragraphs') {
          percent = Math.max(20, Math.min(88, 20 + Math.round((cur / total) * 68)))
        }
      }
    }
    return {
      percent,
      stage: rule.stage,
      stageKey: rule.key || '',
      ratio,
      message: `${rule.label}${suffix}…`
    }
  }

  // 3. 生命周期关键节点
  if (/Warmup babeldoc assets|Downloading all assets/i.test(text)) {
    return { percent: 8, stage: 'parsing', message: '正在检查/下载排版模型与字体资源…' }
  }
  if (/Loading ONNX model|Available Provider:/i.test(text)) {
    return { percent: 14, stage: 'parsing', message: '正在加载版面分析模型（DocLayout）…' }
  }
  if (/start to translate:/i.test(text)) {
    return { percent: 18, stage: 'translating', message: '已开始解析 PDF 版面与公式结构…' }
  }
  if (/Font subsetting completed/i.test(text)) {
    return { percent: 94, stage: 'rendering', message: '字体子集化完成，正在写入输出 PDF…' }
  }
  if (/PDF save.*completed/i.test(text)) {
    return { percent: 98, stage: 'finalizing', message: 'PDF 生成完成，正在校验文件…' }
  }

  // 4. 通用百分比或 [cur/total] / 空格分隔分数（兼容 pdf2zh 1.x 与 tqdm，排除 (1/1) 括号）
  let percent = null
  const pctMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/)
  if (pctMatch) {
    const val = Number(pctMatch[1])
    if (Number.isFinite(val)) percent = Math.max(0, Math.min(100, Math.round(val)))
  } else {
    const ratioMatch = text.match(/(?:^|[\s\[]|[-━─]{2,}\s*)(\d{1,4})\s*\/\s*(\d{1,4})(?=$|[\s\]|])/)
    if (ratioMatch) {
      const cur = Number(ratioMatch[1])
      const total = Number(ratioMatch[2])
      if (total > 0 && cur >= 0 && cur <= total) {
        percent = Math.max(0, Math.min(100, Math.round((cur / total) * 100)))
      }
    }
  }

  let stage = 'running'
  if (/finish|complete|done|saved|输出完成/i.test(text)) stage = 'finalizing'
  else if (/translat|llm|openai|翻译/i.test(text)) stage = 'translating'
  else if (/layout|parse|ocr|load|模型|解析/i.test(text)) stage = 'parsing'
  else if (/render|save|export|写入|合成/i.test(text)) stage = 'rendering'

  if (percent === null && text.length > 220) {
    return { percent: null, stage, message: text.slice(0, 220) }
  }
  return { percent, stage, message: text }
}

/**
 * 检查文件头是否包含 %PDF- 魔数且非空
 */
function hasPdfMagic (filePath) {
  let fd
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile() || st.size < 8) return false
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(5)
    const n = fs.readSync(fd, buf, 0, 5, 0)
    return n === 5 && buf.toString('ascii') === '%PDF-'
  } catch (_) {
    return false
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (_) {}
    }
  }
}

function classifyOutputRole (filename) {
  const lower = String(filename || '').toLowerCase()
  if (/(?:^|[._-])dual(?:[._-]|\.pdf$)/i.test(lower)) return 'dual'
  if (/(?:^|[._-])mono(?:[._-]|\.pdf$)/i.test(lower)) return 'mono'
  return 'other'
}

/**
 * 从暂存目录收集有效译文 PDF（校验 %PDF- 魔数并按模式排序筛选）
 */
function collectTranslatedPdfs (stagingDir, inputPdfPath, mode = 'dual') {
  if (!stagingDir || !fs.existsSync(stagingDir)) return []
  const inputResolved = inputPdfPath ? path.resolve(inputPdfPath) : ''
  const stem = inputPdfPath ? path.basename(inputPdfPath, path.extname(inputPdfPath)) : 'translated'

  const candidates = []
  function scan (dir, depth) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory() && depth < 1) {
        scan(full, depth + 1)
        continue
      }
      if (!ent.isFile() || !/\.pdf$/i.test(ent.name)) continue
      if (inputResolved && path.resolve(full) === inputResolved) continue
      if (!hasPdfMagic(full)) continue
      const role = classifyOutputRole(ent.name)
      candidates.push({ srcPath: full, role, baseName: ent.name })
    }
  }
  scan(stagingDir, 0)

  if (candidates.length === 0) return []

  const preferredMode = VALID_MODES.has(mode) ? mode : 'dual'
  const exactMatches = candidates.filter((c) => c.role === preferredMode)
  const chosen = exactMatches.length > 0 ? exactMatches : candidates

  chosen.sort((a, b) => a.baseName.localeCompare(b.baseName))

  return chosen.map((item, idx) => {
    const suffix = item.role === 'dual'
      ? '-dual'
      : item.role === 'mono'
        ? '-mono'
        : `-${preferredMode}`
    const indexTag = chosen.length > 1 && idx > 0 ? `-${idx + 1}` : ''
    return {
      srcPath: item.srcPath,
      role: item.role,
      suggestedName: `${stem}${suffix}${indexTag}.pdf`
    }
  })
}

/**
 * 无覆盖发布译文 PDF 到目标目录（COPYFILE_EXCL + 自动序号 + 失败整批回滚）
 */
function publishTranslatedFiles (files, targetDir) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('未找到有效的翻译输出 PDF 文件')
  }
  fs.mkdirSync(targetDir, { recursive: true })
  const created = []
  const published = []

  try {
    for (const item of files) {
      if (!item || !item.srcPath || !hasPdfMagic(item.srcPath)) {
        throw new Error(`无效的输出 PDF: ${item && item.srcPath}`)
      }
      const parsed = path.parse(item.suggestedName || path.basename(item.srcPath))
      const ext = parsed.ext || '.pdf'
      const base = parsed.name || 'translated'

      let destPath = null
      for (let i = 0; i < 999; i++) {
        const candidateName = i === 0 ? `${base}${ext}` : `${base} (${i})${ext}`
        const candidatePath = path.join(targetDir, candidateName)
        try {
          fs.copyFileSync(item.srcPath, candidatePath, fs.constants.COPYFILE_EXCL)
          destPath = candidatePath
          created.push(destPath)
          break
        } catch (err) {
          if (err && err.code === 'EEXIST') continue
          throw err
        }
      }
      if (!destPath) {
        throw new Error(`目标目录同名文件过多，无法保存 ${base}${ext}`)
      }
      if (!hasPdfMagic(destPath)) {
        throw new Error(`输出文件校验失败: ${destPath}`)
      }
      published.push({
        path: destPath,
        name: path.basename(destPath),
        role: item.role || 'other'
      })
    }
    return published
  } catch (err) {
    for (const p of created) {
      try { fs.unlinkSync(p) } catch (_) {}
    }
    throw err
  }
}

module.exports = {
  DEFAULT_CONFIG,
  sanitizePageRange,
  normalizeServerUrl,
  normalizeTranslateConfig,
  detectCliCandidates,
  detectUvCandidates,
  classifyCliKind,
  buildCliInvocation,
  buildUvInstallInvocation,
  parseProgressLine,
  parseInstallLine,
  hasPdfMagic,
  collectTranslatedPdfs,
  publishTranslatedFiles
}
