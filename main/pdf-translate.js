'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const { createTranslationProxy } = require('../lib/pdf-translate-proxy')
const {
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
} = require('../lib/pdf-translate')

const DEFAULT_TRANSLATE_TIMEOUT_MS = 45 * 60 * 1000 // 45 分钟
const DEFAULT_INSTALL_TIMEOUT_MS = 15 * 60 * 1000 // 15 分钟
const TSINGHUA_PYPI_INDEX = 'https://pypi.tuna.tsinghua.edu.cn/simple'
const ANSI_ESCAPE_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g

function extractVersionLine (stdout, stderr) {
  const combined = `${stdout || ''}\n${stderr || ''}`.replace(ANSI_ESCAPE_RE, '')
  const lines = combined.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/(?:pdf2zh[_-]?next|pdf2zh|uv)\s*(?:version[:\s]+)?v?\d+\.\d+/i.test(lines[i])) {
      return lines[i]
    }
  }
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

function mergeNoProxy (envObj) {
  const existing = String(envObj.NO_PROXY || envObj.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const host of ['127.0.0.1', 'localhost']) {
    if (!existing.includes(host)) existing.push(host)
  }
  const joined = existing.join(',')
  envObj.NO_PROXY = joined
  envObj.no_proxy = joined
}

function formatExitErrorDetail (recentLogs) {
  if (!Array.isArray(recentLogs) || recentLogs.length === 0) return ''
  const errLineRe = /(?:Error|Exception|ValueError|RuntimeError|TypeError|KeyError|ConnectionError|TimeoutError|CRITICAL|ERROR)\s*:/i
  for (let i = recentLogs.length - 1; i >= 0; i--) {
    if (errLineRe.test(recentLogs[i])) return recentLogs[i]
  }
  for (let i = recentLogs.length - 1; i >= 0; i--) {
    const line = String(recentLogs[i] || '').trim()
    if (line && !/^File\s+"/i.test(line) && !/^\^+$/.test(line)) return line
  }
  return String(recentLogs[recentLogs.length - 1] || '')
}

function isLocalUrl (rawUrl) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(rawUrl || '').trim())
}

function quoteCmdArg (arg) {
  const s = String(arg ?? '').replace(/[\r\n\0]/g, ' ')
  // 对 cmd.exe 参数用双引号包裹，内部双引号转义
  return `"${s.replace(/"/g, '\\"')}"`
}

function isBatchFile (binPath) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(binPath || '').trim())
}

function scrubSecrets (text, secrets) {
  let out = String(text || '')
  for (const s of secrets) {
    if (!s || typeof s !== 'string' || s.length < 4) continue
    out = out.split(s).join('[REDACTED]')
  }
  return out
}

function createLineDecoder (onLine) {
  let buf = ''
  return {
    push (chunk) {
      buf += String(chunk || '')
      const parts = buf.split(/[\r\n]+/)
      buf = parts.pop() || ''
      for (const p of parts) {
        if (p) onLine(p)
      }
    },
    flush () {
      if (buf) {
        onLine(buf)
        buf = ''
      }
    }
  }
}

/**
 * 创建文献翻译主进程服务
 */
function createPdfTranslateService ({
  app,
  BrowserWindow,
  dialog,
  shell,
  execFileAsync,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  getState,
  scheduleSave,
  aiService,
  log,
  timeoutMs,
  installTimeoutMs
} = {}) {
  let activeJob = null
  let activeInstall = null
  let disposed = false

  function getCurrentConfig () {
    const state = typeof getState === 'function' ? getState() : {}
    const raw = state && state.settings ? state.settings.pdfTranslate : {}
    return normalizeTranslateConfig(raw)
  }

  function saveConfig (patch) {
    const state = typeof getState === 'function' ? getState() : null
    if (!state) return normalizeTranslateConfig(patch)
    if (!state.settings || typeof state.settings !== 'object') state.settings = {}
    const merged = Object.assign({}, getCurrentConfig(), patch || {})
    const normalized = normalizeTranslateConfig(merged)
    state.settings.pdfTranslate = normalized
    if (typeof scheduleSave === 'function') scheduleSave()
    return normalized
  }

  function forEachLiveWebContents (fn) {
    if (disposed) return
    const wins = BrowserWindow && typeof BrowserWindow.getAllWindows === 'function'
      ? BrowserWindow.getAllWindows()
      : []
    for (const win of wins) {
      if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) continue
      const wc = win.webContents
      if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) continue
      try { fn(wc) } catch (_) {}
    }
  }

  function emitProgress (payload) {
    forEachLiveWebContents((wc) => wc.send('pdf-translate:progress', payload))
  }

  function emitInstallProgress (payload) {
    forEachLiveWebContents((wc) => wc.send('pdf-translate:install-progress', payload))
  }

  function spawnBinary (binPath, args, { env, cwd } = {}) {
    if (isBatchFile(binPath)) {
      const comspec = process.env.ComSpec || 'cmd.exe'
      const fullCmdLine = `"${[quoteCmdArg(binPath), ...args.map(quoteCmdArg)].join(' ')}"`
      return spawnImpl(comspec, ['/d', '/s', '/c', fullCmdLine], {
        env,
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: true,
        shell: false
      })
    }
    return spawnImpl(binPath, args, {
      env,
      cwd,
      windowsHide: true,
      shell: false
    })
  }

  async function probeExecutableVersion (candidate) {
    if (typeof execFileAsync !== 'function') return null
    const looksLikePath = path.isAbsolute(candidate) || /[\\/]/.test(candidate)
    if (looksLikePath && !fs.existsSync(candidate)) return null

    try {
      let res = null
      if (isBatchFile(candidate)) {
        const comspec = process.env.ComSpec || 'cmd.exe'
        const cmdLine = `"${quoteCmdArg(candidate)} --version"`
        res = await execFileAsync(comspec, ['/d', '/s', '/c', cmdLine], {
          timeout: 6000,
          windowsHide: true,
          windowsVerbatimArguments: true
        })
      } else {
        res = await execFileAsync(candidate, ['--version'], {
          timeout: 6000,
          windowsHide: true
        })
      }
      // main/explorer-verb.js 的 execFileAsync 不 reject，失败时通过非零 status 上报
      if (!res || (typeof res.status === 'number' && res.status !== 0)) return null
      const verText = extractVersionLine(res.stdout, res.stderr)
      return { path: candidate, version: verText }
    } catch (_) {
      return null
    }
  }

  async function runVersionProbe (candidate) {
    const res = await probeExecutableVersion(candidate)
    if (!res) return null
    const kind = classifyCliKind(candidate, res.version)
    return {
      found: true,
      path: res.path,
      kind,
      version: res.version || kind
    }
  }

  async function runUvProbe (candidate) {
    const res = await probeExecutableVersion(candidate)
    if (!res) return null
    return {
      found: true,
      path: res.path,
      version: res.version || 'uv'
    }
  }

  async function probeServerHealth (serverUrl) {
    if (typeof fetchImpl !== 'function') return { url: serverUrl, reachable: false }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 700)
    try {
      const res = await fetchImpl(`${serverUrl}/`, { method: 'GET', signal: controller.signal })
      try { await res.body?.cancel?.() } catch (_) {}
      return { url: serverUrl, reachable: res.status < 500 }
    } catch (_) {
      return { url: serverUrl, reachable: false }
    } finally {
      clearTimeout(timer)
    }
  }

  async function probeEnvironment ({ checkServer = true, checkUv = true } = {}) {
    const config = getCurrentConfig()
    const candidates = detectCliCandidates({
      env: process.env,
      platform: process.platform,
      homeDir: os.homedir(),
      customPath: config.cliPath
    })

    let cli = { found: false, path: '', kind: '', version: '' }
    for (const candidate of candidates) {
      const hit = await runVersionProbe(candidate)
      if (hit) {
        cli = hit
        break
      }
    }

    let uv = { found: false, path: '', version: '' }
    if (checkUv) {
      const uvCandidates = detectUvCandidates({
        env: process.env,
        platform: process.platform,
        homeDir: os.homedir()
      })
      for (const candidate of uvCandidates) {
        const hit = await runUvProbe(candidate)
        if (hit) {
          uv = hit
          break
        }
      }
    }

    const server = checkServer
      ? await probeServerHealth(config.serverUrl)
      : { url: config.serverUrl, reachable: false }

    const creds = aiService && typeof aiService.getActiveProviderCredentials === 'function'
      ? aiService.getActiveProviderCredentials()
      : null

    return {
      config,
      cli,
      uv,
      server,
      activeAi: {
        configured: !!(creds && creds.baseUrl && (creds.apiKey || isLocalUrl(creds.baseUrl))),
        providerName: creds ? creds.name : '',
        model: creds ? creds.defaultModel : ''
      },
      activeJob: activeJob
        ? { jobId: activeJob.id, filePath: activeJob.filePath, startedAt: activeJob.startedAt }
        : null,
      activeInstall: activeInstall
        ? { installId: activeInstall.id, startedAt: activeInstall.startedAt }
        : null
    }
  }

  async function killChildTree (child) {
    if (!child) return
    const pid = child.pid
    if (process.platform === 'win32' && pid && typeof execFileAsync === 'function') {
      try {
        const res = await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 5000,
          windowsHide: true
        })
        if (res && (typeof res.status !== 'number' || res.status === 0)) return
      } catch (_) {}
    }
    try { child.kill('SIGTERM') } catch (_) {}
    setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL')
      } catch (_) {}
    }, 600)
  }

  async function runViaServer ({ jobId, inputPdf, stagingDir, cfg, abortController }) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('当前运行时缺少 fetch，无法连接 zotero-pdf2zh 服务')
    }
    emitProgress({
      jobId,
      status: 'running',
      percent: 12,
      stage: 'connecting',
      message: `正在连接服务 ${cfg.serverUrl}…`,
      filePath: inputPdf
    })

    const pdfB64 = fs.readFileSync(inputPdf).toString('base64')
    const serviceName = cfg.service === 'active-ai' ? 'openai' : cfg.service
    const body = {
      fileContent: `data:application/pdf;base64,${pdfB64}`,
      filename: path.basename(inputPdf),
      engine: 'pdf2zh_next',
      service: serviceName,
      langIn: cfg.langIn,
      langOut: cfg.langOut,
      qps: cfg.threads,
      outputPath: stagingDir
    }
    if (cfg.pageRange) body.pages = cfg.pageRange

    let res
    try {
      res = await fetchImpl(`${cfg.serverUrl}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortController.signal
      })
    } catch (err) {
      if (abortController.signal.aborted) throw new Error('文献翻译已取消')
      throw new Error(`无法连接 zotero-pdf2zh 服务 (${cfg.serverUrl}): ${err && err.message ? err.message : err}`)
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`zotero-pdf2zh 服务返回 HTTP ${res.status}: ${txt.slice(0, 180)}`)
    }

    const ctype = String(res.headers?.get?.('content-type') || '').toLowerCase()
    const stem = path.basename(inputPdf, path.extname(inputPdf))

    if (ctype.includes('application/pdf')) {
      const buf = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(path.join(stagingDir, `${stem}-${cfg.mode}.pdf`), buf)
      return
    }

    const data = await res.json().catch(() => ({}))
    if (data && typeof data.fileContent === 'string') {
      const b64 = data.fileContent.replace(/^data:[^,]+,/, '')
      fs.writeFileSync(path.join(stagingDir, `${stem}-${cfg.mode}.pdf`), Buffer.from(b64, 'base64'))
      return
    }

    // 若服务端返回异步 taskId，轮询任务状态直至完成
    if (data && data.taskId) {
      const taskId = String(data.taskId)
      while (!abortController.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (abortController.signal.aborted) throw new Error('文献翻译已取消')
        const pollRes = await fetchImpl(`${cfg.serverUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
          signal: abortController.signal
        })
        if (!pollRes.ok) continue
        const task = await pollRes.json().catch(() => ({}))
        const pct = Number.isFinite(Number(task.progress)) ? Math.round(Number(task.progress)) : null
        emitProgress({
          jobId,
          status: 'running',
          percent: pct,
          stage: 'translating',
          message: task.message || '服务端正在翻译…',
          filePath: inputPdf
        })
        if (task.status === 'failed' || task.status === 'error') {
          throw new Error(task.error || task.message || '服务端翻译失败')
        }
        if (task.status === 'completed' || task.status === 'done' || task.status === 'finished') {
          if (typeof task.fileContent === 'string') {
            const b64 = task.fileContent.replace(/^data:[^,]+,/, '')
            fs.writeFileSync(path.join(stagingDir, `${stem}-${cfg.mode}.pdf`), Buffer.from(b64, 'base64'))
          }
          break
        }
      }
    }
  }

  async function runViaCli ({ job, inputPdf, stagingDir, cfg, abortController, effectiveTimeoutMs }) {
    const envStatus = await probeEnvironment({ checkServer: false, checkUv: false })
    if (job.canceled || abortController.signal.aborted) {
      throw new Error('文献翻译已取消')
    }
    if (!envStatus.cli.found) {
      throw new Error('未检测到 pdf2zh_next 或 pdf2zh，请先通过 uv tool install pdf2zh_next 安装或手动指定可执行路径')
    }

    let creds = null
    const secrets = []
    if (cfg.service === 'active-ai') {
      creds = aiService && typeof aiService.getActiveProviderCredentials === 'function'
        ? aiService.getActiveProviderCredentials()
        : null
      if (!creds || !creds.baseUrl) {
        throw new Error('请先在“AI 设置”中配置模型服务后再使用活跃 AI 翻译')
      }
      if (!creds.apiKey && !isLocalUrl(creds.baseUrl)) {
        throw new Error('当前活跃 AI 配置缺少 API Key，请先在“AI 设置”中补全')
      }
      if (creds.apiKey) secrets.push(creds.apiKey)

      job.proxy = await createTranslationProxy({
        provider: creds,
        fetchImpl,
        signal: abortController.signal,
        timeoutMs: 120000,
        log,
        onEvent: (ev) => {
          if (typeof job._onProxyEvent === 'function') job._onProxyEvent(ev)
        }
      })
      secrets.push(job.proxy.token)
      if (job.canceled || abortController.signal.aborted) {
        throw new Error('文献翻译已取消')
      }
    }

    const inv = buildCliInvocation({
      kind: envStatus.cli.kind,
      binPath: envStatus.cli.path,
      inputPdf,
      outputDir: stagingDir,
      config: cfg,
      proxy: job.proxy
    })

    // 剥离宿主环境可能残留的 OpenAI 凭据，仅保留 Python 运行必需变量与一次性代理环境变量
    const childEnv = Object.assign({}, process.env)
    delete childEnv.OPENAI_API_KEY
    delete childEnv.OPENAI_BASE_URL
    delete childEnv.OPENAI_MODEL
    delete childEnv.PDF2ZH_OPENAI_API_KEY
    delete childEnv.PDF2ZH_OPENAI_BASE_URL
    delete childEnv.PDF2ZH_OPENAI_MODEL
    Object.assign(childEnv, inv.env)
    mergeNoProxy(childEnv)

    emitProgress({
      jobId: job.id,
      status: 'running',
      percent: 5,
      stage: 'starting',
      message: `正在启动 ${inv.kind}…`,
      filePath: inputPdf
    })

    const child = spawnBinary(inv.binPath, inv.args, {
      env: childEnv,
      cwd: stagingDir
    })
    job.child = child
    if (job.canceled || abortController.signal.aborted) {
      await killChildTree(child)
      throw new Error('文献翻译已取消')
    }

    const recentLogs = []
    let lastPercent = 5
    let lastEmitKey = ''
    let lastStage = 'starting'
    let lastStatusMsg = `正在启动 ${inv.kind}…`
    let lastLogLine = ''
    let inFlightLlm = 0
    let completedLlmCalls = 0
    let proxyRetries = 0
    let lastProxyWarning = ''
    let hasRealTranslateProgress = false
    let lastParaRatio = null

    function formatTranslatingMessage () {
      if (lastParaRatio && lastParaRatio.total > 0) {
        return `正在翻译正文段落 (${lastParaRatio.cur}/${lastParaRatio.total} · 进行中 ${inFlightLlm} · 已完成请求 ${completedLlmCalls})…`
      }
      return `正在调用 AI 模型翻译（进行中 ${inFlightLlm} · 已完成 ${completedLlmCalls}）…`
    }

    function pushUiProgress ({ percent = null, stage, message = '', logLine = '', force = false }) {
      if (typeof percent === 'number' && percent > lastPercent) {
        lastPercent = Math.max(0, Math.min(100, Math.round(percent)))
      }
      if (stage) lastStage = stage
      const cleanMsg = String(message || '').trim() || lastStatusMsg
      lastStatusMsg = cleanMsg
      let cleanLog = String(logLine || '').trim()
      if (cleanLog && cleanLog === lastLogLine) cleanLog = ''
      if (cleanLog) lastLogLine = cleanLog

      const proxyLive = {
        inFlight: inFlightLlm,
        completed: completedLlmCalls,
        retries: proxyRetries
      }
      const emitKey = `${lastPercent}|${lastStage}|${cleanMsg}|${inFlightLlm}|${completedLlmCalls}|${proxyRetries}|${lastProxyWarning}|${cleanLog}`
      if (!force && emitKey === lastEmitKey) return
      lastEmitKey = emitKey

      emitProgress({
        jobId: job.id,
        status: 'running',
        percent: lastPercent,
        stage: lastStage,
        message: cleanMsg,
        proxyLive,
        warning: lastProxyWarning,
        ...(cleanLog ? { logLine: cleanLog } : {}),
        filePath: inputPdf
      })
    }

    if (cfg.service === 'active-ai' && job.proxy) {
      // Proxy 已在前置创建；这里将实时观测回调与并发计数器绑定到 UI 推送
      job._onProxyEvent = (ev) => {
        if (!ev || job.canceled || abortController.signal.aborted) return
        if (ev.type === 'request') {
          inFlightLlm = Number(ev.inFlight) || 0
          pushUiProgress({
            stage: 'translating',
            message: (lastStage === 'translating' || lastParaRatio) ? formatTranslatingMessage() : lastStatusMsg
          })
        } else if (ev.type === 'response') {
          inFlightLlm = typeof ev.inFlight === 'number' ? ev.inFlight : Math.max(0, inFlightLlm - 1)
          if (ev.status >= 200 && ev.status < 300) {
            lastProxyWarning = ''
            completedLlmCalls = ev.completedCalls || (completedLlmCalls + 1)
            // 仅在未收到 CLI 真实进度前提供渐近保底，避免 20 余次请求就冲到 88%
            const floor = hasRealTranslateProgress
              ? null
              : Math.min(85, Math.round(20 + 65 * (1 - Math.exp(-completedLlmCalls / 80))))
            const milestoneLog = (completedLlmCalls === 1 || completedLlmCalls % 5 === 0)
              ? `[AI 代理] 已完成 ${completedLlmCalls} 次模型翻译请求`
              : ''
            pushUiProgress({
              percent: floor,
              stage: 'translating',
              message: formatTranslatingMessage(),
              logLine: milestoneLog
            })
          } else {
            const detail = ev.errorSnippet ? `：${scrubSecrets(ev.errorSnippet, secrets)}` : ''
            lastProxyWarning = `上游 AI 返回 HTTP ${ev.status}${detail}`
            pushUiProgress({
              stage: 'translating',
              message: lastProxyWarning,
              logLine: `[AI 异常] ${lastProxyWarning}`,
              force: true
            })
          }
        } else if (ev.type === 'retry') {
          proxyRetries++
          if (ev.reason === '400-drop-params') {
            lastProxyWarning = `上游不支持 ${(ev.dropped || []).join(',')}，代理已自动兼容重试（第 ${proxyRetries} 次）`
          } else {
            lastProxyWarning = ev.status
              ? `上游返回 HTTP ${ev.status}，代理正在自动重试（第 ${proxyRetries} 次）`
              : `上游连接波动或超时，代理正在自动重试（第 ${proxyRetries} 次）`
          }
          pushUiProgress({
            stage: 'translating',
            message: lastProxyWarning,
            logLine: `[AI 重试] ${lastProxyWarning}`,
            force: true
          })
        } else if (ev.type === 'error') {
          inFlightLlm = typeof ev.inFlight === 'number' ? ev.inFlight : Math.max(0, inFlightLlm - 1)
          lastProxyWarning = `上游 AI 连接失败：${scrubSecrets(ev.message, secrets)}`
          pushUiProgress({
            stage: 'error',
            message: lastProxyWarning,
            logLine: `[AI 错误] ${lastProxyWarning}`,
            force: true
          })
        }
      }
    }

    const handleRawLine = (rawLine) => {
      const cleanLine = scrubSecrets(rawLine, secrets)
      const parsed = parseProgressLine(cleanLine)
      if (!parsed) return
      // 跳过过时的 0% 总条重绘，既避免覆盖更高进度下的阶段文案，也防止挤掉错误堆栈上下文
      if (parsed.message === '正在翻译学术文献（0%）') {
        if (lastPercent > 15) return
      } else if (recentLogs[recentLogs.length - 1] !== cleanLine.trim()) {
        recentLogs.push(cleanLine.trim())
        if (recentLogs.length > 30) recentLogs.shift()
      }

      if (parsed.stageKey === 'translate-paragraphs' && parsed.ratio && parsed.ratio.total > 0) {
        hasRealTranslateProgress = true
        lastParaRatio = parsed.ratio
      } else if (typeof parsed.percent === 'number' && parsed.percent > 0 && parsed.stage === 'translating') {
        hasRealTranslateProgress = true
      }

      const displayMsg = (parsed.stageKey === 'translate-paragraphs' && lastParaRatio)
        ? formatTranslatingMessage()
        : parsed.message

      const prevPctBucket = Math.floor(lastPercent / 10)
      const nextPct = typeof parsed.percent === 'number' ? Math.max(lastPercent, parsed.percent) : lastPercent
      const stageChanged = parsed.stage && parsed.stage !== lastStage
      const crossedBucket = Math.floor(nextPct / 10) > prevPctBucket
      const isInterestingMsg = !/^正在翻译学术文献（/.test(displayMsg) || crossedBucket
      const logLine = (stageChanged || crossedBucket || (isInterestingMsg && typeof parsed.percent === 'number'))
        ? `[${nextPct}%] ${displayMsg}`
        : ''

      pushUiProgress({
        percent: parsed.percent,
        stage: parsed.stage,
        message: displayMsg,
        logLine
      })
    }

    const stdoutDec = createLineDecoder(handleRawLine)
    const stderrDec = createLineDecoder(handleRawLine)
    if (child.stdout) child.stdout.on('data', (d) => stdoutDec.push(d))
    if (child.stderr) child.stderr.on('data', (d) => stderrDec.push(d))

    await new Promise((resolve, reject) => {
      let settled = false
      let timedOut = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stdoutDec.flush()
        stderrDec.flush()
        if (err) reject(err)
        else resolve()
      }

      const timer = effectiveTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            killChildTree(child).catch(() => {})
            finish(new Error(`文献翻译超时（>${Math.round(effectiveTimeoutMs / 1000)}s），已中止`))
          }, effectiveTimeoutMs)
        : null

      child.once('error', (err) => {
        finish(new Error(`启动翻译进程失败: ${scrubSecrets(err && err.message, secrets)}`))
      })

      child.once('close', (code, sig) => {
        if (timedOut) return
        if (job.canceled || abortController.signal.aborted) {
          finish(new Error('文献翻译已取消'))
          return
        }
        if (code !== 0) {
          const tail = formatExitErrorDetail(recentLogs)
          finish(new Error(`翻译进程异常退出 (code=${code}${sig ? `, sig=${sig}` : ''})${tail ? `: ${tail}` : ''}`))
          return
        }
        finish()
      })
    })
  }

  async function runTranslation (opts = {}) {
    if (disposed) throw new Error('服务已关闭')
    if (activeJob) {
      throw new Error('已有文献翻译任务正在运行，请等待完成或先取消')
    }
    if (activeInstall) {
      throw new Error('正在安装或更新翻译环境，请稍候完成或先停止安装')
    }

    const inputPdf = String(opts.filePath || '').trim()
    if (!inputPdf) throw new Error('请选择要翻译的 PDF 文件')
    if (!/\.pdf$/i.test(inputPdf) || !fs.existsSync(inputPdf) || !hasPdfMagic(inputPdf)) {
      throw new Error('仅支持有效的 .pdf 文件（文件头校验失败或文件不存在）')
    }

    const cfg = normalizeTranslateConfig(Object.assign({}, getCurrentConfig(), opts))
    const jobId = crypto.randomUUID()
    const abortController = new AbortController()
    const stagingBase = app && typeof app.getPath === 'function' ? app.getPath('temp') : os.tmpdir()
    const stagingDir = fs.mkdtempSync(path.join(stagingBase, 'sticky-pdf-translate-'))
    const effectiveTimeoutMs = Number(timeoutMs || process.env.STICKY_PDF2ZH_TIMEOUT_MS || DEFAULT_TRANSLATE_TIMEOUT_MS)

    const job = {
      id: jobId,
      filePath: inputPdf,
      startedAt: Date.now(),
      canceled: false,
      abortController,
      child: null,
      proxy: null
    }
    activeJob = job

    try {
      if (cfg.backend === 'server') {
        await runViaServer({ jobId, inputPdf, stagingDir, cfg, abortController })
      } else {
        await runViaCli({ job, inputPdf, stagingDir, cfg, abortController, effectiveTimeoutMs })
      }

      if (job.canceled || abortController.signal.aborted) {
        throw new Error('文献翻译已取消')
      }

      const collected = collectTranslatedPdfs(stagingDir, inputPdf, cfg.mode)
      if (collected.length === 0) {
        throw new Error('翻译已完成但未产出有效 PDF 文件，请检查语言方向或页码设置')
      }

      const targetDir = path.dirname(inputPdf)
      const outputs = publishTranslatedFiles(collected, targetDir)
      const proxyStats = job.proxy ? job.proxy.getStats() : null

      emitProgress({
        jobId,
        status: 'done',
        percent: 100,
        stage: 'done',
        message: '翻译完成',
        filePath: inputPdf,
        outputs
      })

      return {
        ok: true,
        jobId,
        outputs,
        proxyStats
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      emitProgress({
        jobId,
        status: job.canceled ? 'canceled' : 'error',
        percent: null,
        stage: job.canceled ? 'canceled' : 'error',
        message: msg,
        filePath: inputPdf
      })
      return {
        ok: false,
        canceled: job.canceled,
        jobId,
        error: msg
      }
    } finally {
      activeJob = null
      if (job.proxy) {
        try { await job.proxy.close() } catch (_) {}
        job.proxy = null
      }
      try { fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 120 }) } catch (_) {}
    }
  }

  async function cancelTranslation (jobId) {
    if (!activeJob) return { ok: false, reason: 'no_active_job' }
    if (jobId && activeJob.id !== jobId) return { ok: false, reason: 'job_mismatch' }
    const job = activeJob
    job.canceled = true
    try { job.abortController.abort() } catch (_) {}
    if (job.child) await killChildTree(job.child)
    if (job.proxy) {
      try { await job.proxy.close() } catch (_) {}
    }
    return { ok: true, jobId: job.id }
  }

  /**
   * 调用本机 uv 一键安装或更新 pdf2zh-next，并实时推送日志
   */
  async function installEnvironment (opts = {}) {
    if (disposed) return { ok: false, error: '服务已关闭', logs: [] }
    if (activeJob) return { ok: false, error: '已有文献翻译任务正在运行，请先完成或取消', logs: [] }
    if (activeInstall) return { ok: false, error: '已有环境安装/更新任务正在进行中', logs: [] }

    const installId = crypto.randomUUID()
    const envBefore = await probeEnvironment({ checkServer: false })
    if (!envBefore.uv || !envBefore.uv.found) {
      return {
        ok: false,
        installId,
        error: '未检测到 uv，请先在终端安装 uv 后再一键部署翻译环境',
        logs: []
      }
    }

    const indexUrl = opts.useMirror === true && !opts.indexUrl
      ? TSINGHUA_PYPI_INDEX
      : String(opts.indexUrl || '').trim()

    let inv
    try {
      inv = buildUvInstallInvocation({
        uvPath: envBefore.uv.path,
        upgrade: opts.upgrade !== false,
        indexUrl
      })
    } catch (err) {
      return { ok: false, installId, error: err && err.message ? err.message : String(err), logs: [] }
    }

    const logs = []
    const pushLog = (stage, message) => {
      if (!message) return
      logs.push(message)
      if (logs.length > 80) logs.shift()
      emitInstallProgress({
        installId,
        status: 'running',
        stage,
        message
      })
    }

    const install = {
      id: installId,
      startedAt: Date.now(),
      canceled: false,
      child: null
    }
    activeInstall = install

    emitInstallProgress({
      installId,
      status: 'running',
      stage: 'starting',
      message: `正在调用 uv 安装/更新 pdf2zh-next${indexUrl ? '（使用镜像源）' : ''}…`
    })

    try {
      const childEnv = Object.assign({}, process.env, inv.env)
      const child = spawnBinary(inv.binPath, inv.args, {
        env: childEnv,
        cwd: app && typeof app.getPath === 'function' ? app.getPath('temp') : os.tmpdir()
      })
      install.child = child

      const handleLine = (rawLine) => {
        const parsed = parseInstallLine(rawLine)
        if (!parsed) return
        pushLog(parsed.stage, parsed.message)
      }
      const stdoutDec = createLineDecoder(handleLine)
      const stderrDec = createLineDecoder(handleLine)
      if (child.stdout) child.stdout.on('data', (d) => stdoutDec.push(d))
      if (child.stderr) child.stderr.on('data', (d) => stderrDec.push(d))

      const effectiveTimeoutMs = Number(
        installTimeoutMs || process.env.STICKY_PDF2ZH_INSTALL_TIMEOUT_MS || DEFAULT_INSTALL_TIMEOUT_MS
      )

      await new Promise((resolve, reject) => {
        let settled = false
        let timedOut = false
        const finish = (err) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          stdoutDec.flush()
          stderrDec.flush()
          if (err) reject(err)
          else resolve()
        }

        const timer = effectiveTimeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              killChildTree(child).catch(() => {})
              finish(new Error(`安装/更新超时（>${Math.round(effectiveTimeoutMs / 1000)}s），已中止`))
            }, effectiveTimeoutMs)
          : null

        child.once('error', (err) => {
          finish(new Error(`启动 uv 失败: ${err && err.message ? err.message : String(err)}`))
        })

        child.once('close', (code, sig) => {
          if (timedOut) return
          if (install.canceled) {
            finish(new Error('已停止环境安装/更新'))
            return
          }
          if (code !== 0) {
            const tail = logs.slice(-3).join(' | ')
            finish(new Error(`uv 执行失败 (code=${code}${sig ? `, sig=${sig}` : ''})${tail ? `: ${tail}` : ''}`))
            return
          }
          finish()
        })
      })

      activeInstall = null
      const envAfter = await probeEnvironment({ checkServer: true })
      if (envAfter.cli && envAfter.cli.found) {
        emitInstallProgress({
          installId,
          status: 'done',
          stage: 'installed',
          message: 'pdf2zh_next 安装/更新完成，已自动就绪',
          env: envAfter
        })
        return { ok: true, installId, env: envAfter, logs }
      }

      const warnMsg = 'uv 安装已结束，但未探测到 pdf2zh_next，请点击重新检测或手动指定路径'
      emitInstallProgress({
        installId,
        status: 'error',
        stage: 'error',
        message: warnMsg,
        env: envAfter
      })
      return { ok: false, installId, env: envAfter, logs, error: warnMsg }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      emitInstallProgress({
        installId,
        status: install.canceled ? 'canceled' : 'error',
        stage: install.canceled ? 'canceled' : 'error',
        message: msg
      })
      return {
        ok: false,
        canceled: install.canceled,
        installId,
        error: msg,
        logs
      }
    } finally {
      activeInstall = null
    }
  }

  async function cancelInstall (installId) {
    if (!activeInstall) return { ok: false, reason: 'no_active_install' }
    if (installId && activeInstall.id !== installId) return { ok: false, reason: 'install_mismatch' }
    const install = activeInstall
    install.canceled = true
    if (install.child) await killChildTree(install.child)
    return { ok: true, installId: install.id }
  }

  async function dispose () {
    disposed = true
    if (activeJob) {
      try { await cancelTranslation() } catch (_) {}
    }
    if (activeInstall) {
      try { await cancelInstall() } catch (_) {}
    }
  }

  function registerIpc (ipcMain) {
    ipcMain.handle('pdf-translate:status', () => probeEnvironment({ checkServer: true }))

    ipcMain.handle('pdf-translate:save-config', (_e, patch) => {
      const saved = saveConfig(patch)
      return { ok: true, config: saved }
    })

    ipcMain.handle('pdf-translate:pick-pdf', async (e) => {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') {
        return { canceled: true, filePath: '' }
      }
      const owner = BrowserWindow && typeof BrowserWindow.fromWebContents === 'function'
        ? BrowserWindow.fromWebContents(e.sender)
        : undefined
      const res = await dialog.showOpenDialog(owner || undefined, {
        title: '选择要翻译的学术 PDF 文献',
        properties: ['openFile'],
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
      })
      if (!res || res.canceled || !Array.isArray(res.filePaths) || !res.filePaths[0]) {
        return { canceled: true, filePath: '' }
      }
      return { canceled: false, filePath: res.filePaths[0] }
    })

    ipcMain.handle('pdf-translate:open-folder', (_e, filePath) => {
      const target = String(filePath || '').trim()
      if (!target || !shell) return { ok: false }
      if (fs.existsSync(target) && typeof shell.showItemInFolder === 'function') {
        shell.showItemInFolder(target)
        return { ok: true }
      }
      const dir = path.dirname(target)
      if (dir && fs.existsSync(dir) && typeof shell.openPath === 'function') {
        shell.openPath(dir)
        return { ok: true }
      }
      return { ok: false }
    })

    ipcMain.handle('pdf-translate:run', (_e, opts) => runTranslation(opts))
    ipcMain.handle('pdf-translate:cancel', (_e, jobId) => cancelTranslation(jobId))
    ipcMain.handle('pdf-translate:install-env', (_e, opts) => installEnvironment(opts))
    ipcMain.handle('pdf-translate:cancel-install', (_e, installId) => cancelInstall(installId))
  }

  return {
    probeEnvironment,
    runTranslation,
    cancelTranslation,
    installEnvironment,
    cancelInstall,
    dispose,
    registerIpc
  }
}

module.exports = {
  createPdfTranslateService
}
