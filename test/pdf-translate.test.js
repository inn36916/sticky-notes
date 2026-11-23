'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

const { normalizeSettings } = require('../lib/migrations')
const {
  DEFAULT_CONFIG,
  sanitizePageRange,
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
const { createPdfTranslateService } = require('../main/pdf-translate')

function makeTempDir (t, prefix = 'sticky-pdf-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {} })
  return dir
}

test('normalizeTranslateConfig sanitizes pageRange, threads, and migrations settings', () => {
  const clean = normalizeTranslateConfig({
    backend: 'invalid',
    service: 'evil',
    mode: 'other',
    threads: 99,
    pageRange: '1-5 --exec rm',
    serverUrl: 'ftp://bad.example.com'
  })
  assert.equal(clean.backend, 'cli')
  assert.equal(clean.service, 'active-ai')
  assert.equal(clean.mode, 'dual')
  assert.equal(clean.threads, 16)
  assert.equal(clean.pageRange, '')
  assert.equal(clean.serverUrl, 'http://127.0.0.1:8888')
  assert.equal(DEFAULT_CONFIG.skipTermExtraction, true)
  assert.equal(clean.skipTermExtraction, true)
  assert.equal(normalizeTranslateConfig({ skipTermExtraction: false }).skipTermExtraction, false)

  assert.equal(sanitizePageRange('1-3, 5, 8-10'), '1-3,5,8-10')
  const migrated = normalizeSettings({ pdfTranslate: { langOut: 'zh-TW', mode: 'mono', threads: 2 } })
  assert.equal(migrated.pdfTranslate.langOut, 'zh-TW')
  assert.equal(migrated.pdfTranslate.mode, 'mono')
  assert.equal(migrated.pdfTranslate.threads, 2)
})

test('detectCliCandidates and classifyCliKind prioritize override and uv paths', () => {
  const list = detectCliCandidates({
    env: { STICKY_PDF2ZH: 'C:\\custom\\pdf2zh_next.exe', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    customPath: 'D:\\tools\\pdf2zh.exe'
  })
  assert.equal(list[0], 'C:\\custom\\pdf2zh_next.exe')
  assert.equal(list[1], 'D:\\tools\\pdf2zh.exe')
  assert.ok(list.includes('pdf2zh_next'))
  assert.ok(list.some(p => p.includes('uv') && p.endsWith('pdf2zh_next.exe')))

  assert.equal(classifyCliKind('C:\\bin\\pdf2zh.exe', 'pdf2zh_next 2.1.0'), 'pdf2zh_next')
  assert.equal(classifyCliKind('/usr/bin/pdf2zh_next', ''), 'pdf2zh_next')
  assert.equal(classifyCliKind('C:\\bin\\pdf2zh.exe', 'pdf2zh 1.9.10'), 'pdf2zh')
})

test('buildCliInvocation passes only ephemeral proxy token via env and never exposes secrets in args', () => {
  const realSecret = 'sk-super-secret-plaintext'
  const proxy = { baseUrl: 'http://127.0.0.1:51234/v1', token: 'stk-ephemeral-1234', model: 'gpt-4o-mini' }

  const nextInv = buildCliInvocation({
    kind: 'pdf2zh_next',
    binPath: 'pdf2zh_next',
    inputPdf: 'D:\\papers\\demo.pdf',
    outputDir: 'D:\\tmp\\out',
    config: { service: 'active-ai', langIn: 'en', langOut: 'zh', mode: 'dual', threads: 3, pageRange: '1-2', ignoreCache: true },
    proxy
  })
  assert.ok(nextInv.args.includes('--openai'))
  assert.ok(nextInv.args.includes('--no-mono'))
  assert.ok(nextInv.args.includes('--ignore-cache'))
  assert.ok(nextInv.args.includes('--no-auto-extract-glossary'))
  assert.equal(nextInv.args[nextInv.args.indexOf('--openai-timeout') + 1], '60')
  assert.ok(nextInv.args.includes('--report-interval'))
  assert.equal(nextInv.env.FORCE_COLOR, '1')
  assert.equal(nextInv.env.COLUMNS, '200')
  assert.equal(nextInv.env.OPENAI_API_KEY, 'stk-ephemeral-1234')
  assert.equal(nextInv.env.OPENAI_BASE_URL, 'http://127.0.0.1:51234/v1')
  assert.equal(nextInv.env.PDF2ZH_OPENAI_API_KEY, 'stk-ephemeral-1234')
  assert.equal(nextInv.env.PDF2ZH_OPENAI_BASE_URL, 'http://127.0.0.1:51234/v1')
  assert.equal(nextInv.env.PDF2ZH_OPENAI_MODEL, 'gpt-4o-mini')
  assert.equal(nextInv.args.join(' ').includes(realSecret), false)
  assert.equal(nextInv.args.join(' ').includes('stk-ephemeral-1234'), false)

  const withTermInv = buildCliInvocation({
    kind: 'pdf2zh_next',
    binPath: 'pdf2zh_next',
    inputPdf: 'D:\\papers\\demo.pdf',
    outputDir: 'D:\\tmp\\out',
    config: { service: 'active-ai', skipTermExtraction: false },
    proxy
  })
  assert.equal(withTermInv.args.includes('--no-auto-extract-glossary'), false)

  const v1Inv = buildCliInvocation({
    kind: 'pdf2zh',
    binPath: 'pdf2zh',
    inputPdf: 'D:\\papers\\demo.pdf',
    outputDir: 'D:\\tmp\\out',
    config: { service: 'active-ai', langIn: 'auto', langOut: 'zh', mode: 'mono', threads: 2 },
    proxy
  })
  assert.ok(v1Inv.args.includes('-li'))
  assert.ok(v1Inv.args.includes('-s'))
  assert.equal(v1Inv.env.OPENAI_API_KEY, 'stk-ephemeral-1234')
  assert.equal(v1Inv.args.join(' ').includes('stk-ephemeral-1234'), false)
})

test('parseProgressLine parses percentage, ratios, and stages', () => {
  const p1 = parseProgressLine('\x1b[32mTranslating pages: 48%|████|\x1b[0m')
  assert.equal(p1.percent, 48)
  assert.equal(p1.stage, 'translating')

  const p2 = parseProgressLine('[3/10] Layout parsing')
  assert.equal(p2.percent, 30)
  assert.equal(p2.stage, 'parsing')

  // pdf2zh_next 2.10.2 Rich 进度条与生命周期节点解析（分片 (1/1) 不得误判为 100%）
  const richMain = parseProgressLine('translate ---------------------------------------- 42/100 0:00:12')
  assert.equal(richMain.percent, 42)
  assert.equal(richMain.stage, 'translating')
  assert.match(richMain.message, /42%/)

  const richLayout = parseProgressLine('Parse Page Layout (1/1) ---- 1/1')
  assert.equal(richLayout.percent, null)
  assert.equal(richLayout.stage, 'parsing')

  const richPara = parseProgressLine('Translate Paragraphs (1/1) ---- 3/12')
  assert.equal(richPara.percent, 37)
  assert.deepEqual(richPara.ratio, { cur: 3, total: 12 })
  assert.match(richPara.message, /3\/12/)

  assert.equal(parseProgressLine('Typesetting (1/1) ---- 0/1').percent, 89)
  assert.equal(parseProgressLine('Add Fonts (1/1) ---- 0/1').percent, 91)
  assert.equal(parseProgressLine('Generate drawing instructions (1/1) ---- 0/1').percent, 92)
  assert.equal(parseProgressLine('Subset font (1/1) ---- 0/1').percent, 93)
  assert.equal(parseProgressLine('Save PDF (1/1) ---- 0/1').percent, 95)

  assert.equal(parseProgressLine('Warmup babeldoc assets').percent, 8)
  assert.equal(parseProgressLine('Loading ONNX model...').percent, 14)
  assert.equal(parseProgressLine('Font subsetting completed successfully').percent, 94)

  assert.equal(parseProgressLine('translate'), null)
  assert.equal(parseProgressLine('----------------------------------------'), null)
  assert.equal(parseProgressLine('WARNING:lopdf::reader:Size entry of trailer dictionary is 9'), null)
  assert.equal(parseProgressLine('WARNING:lopdf::reader:Size'), null)
})

test('collectTranslatedPdfs validates %PDF- magic and publishTranslatedFiles avoids collisions with rollback', (t) => {
  const dir = makeTempDir(t)
  const staging = path.join(dir, 'staging')
  const target = path.join(dir, 'target')
  fs.mkdirSync(staging, { recursive: true })
  fs.mkdirSync(target, { recursive: true })

  const inPdf = path.join(target, 'paper.pdf')
  fs.writeFileSync(inPdf, '%PDF-1.4 input')

  // 无效魔数的伪 PDF 应被忽略
  fs.writeFileSync(path.join(staging, 'paper-dual.pdf'), 'not a pdf')
  assert.deepEqual(collectTranslatedPdfs(staging, inPdf, 'dual'), [])

  // 写入有效 dual + mono
  const validDual = path.join(staging, 'paper.zh.dual.pdf')
  const validMono = path.join(staging, 'paper.zh.mono.pdf')
  fs.writeFileSync(validDual, '%PDF-1.4\nvalid-dual')
  fs.writeFileSync(validMono, '%PDF-1.4\nvalid-mono')

  assert.equal(hasPdfMagic(validDual), true)
  const foundDual = collectTranslatedPdfs(staging, inPdf, 'dual')
  assert.equal(foundDual.length, 1)
  assert.equal(foundDual[0].suggestedName, 'paper-dual.pdf')

  // 第一次发布 -> paper-dual.pdf
  const out1 = publishTranslatedFiles(foundDual, target)
  assert.equal(out1[0].name, 'paper-dual.pdf')

  // 第二次发布不覆盖 -> paper-dual (1).pdf
  const out2 = publishTranslatedFiles(foundDual, target)
  assert.equal(out2[0].name, 'paper-dual (1).pdf')
  assert.equal(fs.existsSync(out1[0].path), true)
  assert.equal(fs.existsSync(out2[0].path), true)

  // 批量中第 2 个失败时应整批回滚第 1 个新写入文件
  assert.throws(() => {
    publishTranslatedFiles([
      { srcPath: validMono, role: 'mono', suggestedName: 'batch-a.pdf' },
      { srcPath: path.join(staging, 'missing.pdf'), role: 'dual', suggestedName: 'batch-b.pdf' }
    ], target)
  }, /无效的输出 PDF/)
  assert.equal(fs.existsSync(path.join(target, 'batch-a.pdf')), false)
})

test('createPdfTranslateService runs CLI translation via local proxy and cleans up', async (t) => {
  const dir = makeTempDir(t)
  const inPdf = path.join(dir, 'sample paper.pdf')
  fs.writeFileSync(inPdf, '%PDF-1.4\nsample-input')

  const realSecret = 'sk-real-secret-never-passed-to-child'
  const progressEvents = []
  let capturedSpawn = null

  const state = { settings: { pdfTranslate: { langIn: 'en', langOut: 'zh', mode: 'dual' } } }

  const service = createPdfTranslateService({
    app: { getPath: () => dir },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (_ch, payload) => progressEvents.push(payload)
        }
      }]
    },
    execFileAsync: async (bin) => {
      if (bin === 'pdf2zh_next') return { stdout: 'pdf2zh_next 2.0.0', stderr: '' }
      throw new Error('ENOENT')
    },
    fetchImpl: async (url, init) => {
      assert.match(String(url), /\/v1\/chat\/completions$/)
      assert.equal(init.headers.Authorization, `Bearer ${realSecret}`)
      return new Response(JSON.stringify({ id: 'mock', choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    spawnImpl: (_bin, args, opts) => {
      capturedSpawn = { args, env: opts.env }
      const child = new EventEmitter()
      child.pid = 99999
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}

      setTimeout(async () => {
        // 子进程经由本地代理调用上游并屏蔽明文密钥
        const proxyRes = await fetch(`${opts.env.OPENAI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
        })
        assert.equal(proxyRes.status, 200)
        child.stdout.emit('data', Buffer.from(`Using token ${opts.env.OPENAI_API_KEY}\nTranslating: 60%\n`))
        const outIdx = args.indexOf('--output')
        const stagingDir = args[outIdx + 1]
        fs.writeFileSync(path.join(stagingDir, 'sample paper.zh.dual.pdf'), '%PDF-1.4\ntranslated-dual')
        child.emit('close', 0, null)
      }, 20)

      return child
    },
    getState: () => state,
    scheduleSave: () => {},
    aiService: {
      getActiveProviderCredentials: () => ({
        id: 'p1',
        name: 'MockAI',
        baseUrl: 'https://mock-upstream.example.com/v1',
        apiKey: realSecret,
        defaultModel: 'gpt-4o-mini'
      })
    }
  })
  t.after(() => service.dispose())

  const res = await service.runTranslation({ filePath: inPdf })
  assert.equal(res.ok, true)
  assert.equal(res.outputs.length, 1)
  assert.equal(res.outputs[0].name, 'sample paper-dual.pdf')
  assert.equal(fs.existsSync(res.outputs[0].path), true)

  // 安全与脱敏校验：明文 key 从未出现在 child args / env / 进度事件；代理 Token 也被脱敏
  assert.equal(capturedSpawn.args.join(' ').includes(realSecret), false)
  assert.equal(capturedSpawn.env.OPENAI_API_KEY.startsWith('stk-'), true)
  assert.equal(Object.values(capturedSpawn.env).some(v => String(v).includes(realSecret)), false)
  assert.equal(progressEvents.some(e => e.percent === 60), true)
  assert.equal(progressEvents.some(e => String(e.message).includes('stk-')), false)

  // 验证代理在结束后已关闭
  await assert.rejects(fetch(capturedSpawn.env.OPENAI_BASE_URL + '/models'))
})

test('createPdfTranslateService supports cancel, timeout, concurrency lock, and server mode', async (t) => {
  const dir = makeTempDir(t)
  const inPdf = path.join(dir, 'doc.pdf')
  fs.writeFileSync(inPdf, '%PDF-1.4\ncontent')

  // 无效文件被拒绝
  const badSvc = createPdfTranslateService({ app: { getPath: () => dir }, getState: () => ({}) })
  await assert.rejects(
    badSvc.runTranslation({ filePath: path.join(dir, 'missing.pdf') }),
    /仅支持有效的/
  )

  // 取消与并发锁测试
  let killed = false
  const cancelSvc = createPdfTranslateService({
    app: { getPath: () => dir },
    execFileAsync: async (bin) => {
      if (bin === 'pdf2zh_next') return { stdout: 'pdf2zh_next 2.0', stderr: '' }
      if (bin === 'taskkill') { killed = true; return { stdout: '', stderr: '' } }
      throw new Error('not found')
    },
    spawnImpl: () => {
      const child = new EventEmitter()
      child.pid = 42424
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => { killed = true; child.emit('close', null, 'SIGTERM') }
      setTimeout(() => child.emit('close', null, 'SIGTERM'), 60)
      return child
    },
    getState: () => ({ settings: { pdfTranslate: { service: 'bing' } } })
  })

  const runP = cancelSvc.runTranslation({ filePath: inPdf })
  await new Promise(r => setTimeout(r, 15))
  await assert.rejects(cancelSvc.runTranslation({ filePath: inPdf }), /已有文献翻译任务正在运行/)
  const cancelRes = await cancelSvc.cancelTranslation()
  assert.equal(cancelRes.ok, true)
  const finalRes = await runP
  assert.equal(finalRes.ok, false)
  assert.equal(finalRes.canceled, true)
  assert.equal(killed, true)

  // 超时中止测试
  const timeoutSvc = createPdfTranslateService({
    app: { getPath: () => dir },
    timeoutMs: 60,
    execFileAsync: async (bin) => {
      if (bin === 'pdf2zh_next') return { stdout: 'pdf2zh_next 2.0', stderr: '' }
      return { stdout: '', stderr: '' }
    },
    spawnImpl: () => {
      const child = new EventEmitter()
      child.pid = 55555
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      return child
    },
    getState: () => ({ settings: { pdfTranslate: { service: 'bing' } } })
  })
  const tOutRes = await timeoutSvc.runTranslation({ filePath: inPdf })
  assert.equal(tOutRes.ok, false)
  assert.match(tOutRes.error, /超时/)

  // server 模式（zotero-pdf2zh）测试
  const serverSvc = createPdfTranslateService({
    app: { getPath: () => dir },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/translate')) {
        return new Response(JSON.stringify({
          fileContent: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\nserver-dual').toString('base64')
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200 })
    },
    getState: () => ({ settings: { pdfTranslate: { backend: 'server', service: 'bing', mode: 'dual' } } })
  })
  const srvRes = await serverSvc.runTranslation({ filePath: inPdf })
  assert.equal(srvRes.ok, true)
  assert.equal(hasPdfMagic(srvRes.outputs[0].path), true)

  // 非零退出码的 execFileAsync（如 main/explorer-verb.js）不得误判 CLI 存在
  const missingCliSvc = createPdfTranslateService({
    app: { getPath: () => dir },
    execFileAsync: async () => ({ status: 1, stdout: '', stderr: 'ENOENT' }),
    getState: () => ({ settings: { pdfTranslate: {} } })
  })
  const probeMiss = await missingCliSvc.probeEnvironment({ checkServer: false })
  assert.equal(probeMiss.cli.found, false)
  assert.equal(probeMiss.uv.found, false)
})

test('detectUvCandidates, buildUvInstallInvocation, and parseInstallLine validate inputs safely', () => {
  const uvList = detectUvCandidates({
    env: { STICKY_UV: 'D:\\tools\\uv.exe', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    platform: 'win32',
    homeDir: 'C:\\Users\\u'
  })
  assert.equal(uvList[0], 'D:\\tools\\uv.exe')
  assert.ok(uvList.includes('uv'))
  assert.ok(uvList.some((p) => p.endsWith('.local\\bin\\uv.exe')))

  const invDefault = buildUvInstallInvocation({ uvPath: 'uv' })
  assert.deepEqual(invDefault.args, ['tool', 'install', '--python', '3.12', '--upgrade', 'pdf2zh-next'])
  assert.equal(invDefault.env.NO_COLOR, '1')

  const invMirror = buildUvInstallInvocation({
    uvPath: 'uv',
    upgrade: false,
    pythonVersion: '3.11',
    indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple'
  })
  assert.deepEqual(invMirror.args, [
    'tool', 'install', '--python', '3.11', '--default-index', 'https://pypi.tuna.tsinghua.edu.cn/simple', 'pdf2zh-next'
  ])

  assert.throws(() => buildUvInstallInvocation({ uvPath: 'uv', indexUrl: 'file:///tmp/evil' }), /不支持的镜像源协议/)

  assert.equal(parseInstallLine('\x1b[32mResolved 14 packages\x1b[0m').stage, 'resolving')
  assert.equal(parseInstallLine('Downloading pdf2zh-next (1.2MB)').stage, 'downloading')
  assert.equal(parseInstallLine('Installed 1 executable: pdf2zh_next').stage, 'installed')
  assert.equal(parseInstallLine('error: Failed to build wheel').stage, 'error')
  assert.equal(parseInstallLine('   '), null)
})

test('createPdfTranslateService.installEnvironment streams logs, re-probes cli, supports cancel and overlap lock', async (t) => {
  const dir = makeTempDir(t)
  const inPdf = path.join(dir, 'doc.pdf')
  fs.writeFileSync(inPdf, '%PDF-1.4\ncontent')

  // 1. 无 uv 时明确失败
  const noUvSvc = createPdfTranslateService({
    app: { getPath: () => dir },
    execFileAsync: async () => ({ status: 1, stdout: '', stderr: 'ENOENT' }),
    getState: () => ({ settings: { pdfTranslate: {} } })
  })
  const noUvRes = await noUvSvc.installEnvironment()
  assert.equal(noUvRes.ok, false)
  assert.match(noUvRes.error, /未检测到 uv/)

  // 2. 正常一键安装：推流日志并重新探测出 pdf2zh_next
  let cliInstalled = false
  let capturedInstallArgs = null
  const installEvents = []
  const okSvc = createPdfTranslateService({
    app: { getPath: () => dir },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (ch, payload) => {
            if (ch === 'pdf-translate:install-progress') installEvents.push(payload)
          }
        }
      }]
    },
    execFileAsync: async (bin) => {
      if (bin === 'uv') return { status: 0, stdout: 'uv 0.5.14', stderr: '' }
      if (bin === 'pdf2zh_next' && cliInstalled) return { status: 0, stdout: 'pdf2zh_next 2.0.1', stderr: '' }
      return { status: 1, stdout: '', stderr: 'ENOENT' }
    },
    spawnImpl: (_bin, args) => {
      capturedInstallArgs = args
      const child = new EventEmitter()
      child.pid = 77777
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('Resolved 18 packages in 90ms\nDownloading pdf2zh-next\n'))
        cliInstalled = true
        child.stdout.emit('data', Buffer.from('Installed 1 executable: pdf2zh_next\n'))
        child.emit('close', 0, null)
      }, 20)
      return child
    },
    getState: () => ({ settings: { pdfTranslate: {} } })
  })

  const instRes = await okSvc.installEnvironment({ useMirror: true })
  assert.equal(instRes.ok, true)
  assert.ok(capturedInstallArgs.includes('--default-index'))
  assert.equal(instRes.env.cli.found, true)
  assert.equal(installEvents.some((e) => e.stage === 'resolving'), true)
  assert.equal(installEvents.some((e) => e.stage === 'installed' && e.status === 'done'), true)

  // 3. 安装中并发锁 + 取消安装
  let killedInstall = false
  const cancelSvc = createPdfTranslateService({
    app: { getPath: () => dir },
    execFileAsync: async (bin) => {
      if (bin === 'uv') return { status: 0, stdout: 'uv 0.5.14', stderr: '' }
      if (bin === 'taskkill') { killedInstall = true; return { status: 0, stdout: '', stderr: '' } }
      return { status: 1, stdout: '', stderr: 'ENOENT' }
    },
    spawnImpl: () => {
      const child = new EventEmitter()
      child.pid = 88888
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => { killedInstall = true; child.emit('close', null, 'SIGTERM') }
      setTimeout(() => child.emit('close', null, 'SIGTERM'), 80)
      return child
    },
    getState: () => ({ settings: { pdfTranslate: {} } })
  })

  const instP = cancelSvc.installEnvironment()
  await new Promise((r) => setTimeout(r, 15))
  const overlapRes = await cancelSvc.installEnvironment()
  assert.equal(overlapRes.ok, false)
  assert.match(overlapRes.error, /正在进行中/)
  await assert.rejects(cancelSvc.runTranslation({ filePath: inPdf }), /正在安装或更新翻译环境/)

  const stopRes = await cancelSvc.cancelInstall()
  assert.equal(stopRes.ok, true)
  const instCanceled = await instP
  assert.equal(instCanceled.ok, false)
  assert.equal(instCanceled.canceled, true)
  assert.equal(killedInstall, true)
})

test('probeEnvironment extracts version after warning banner, merges NO_PROXY, and surfaces root error line', async (t) => {
  const dir = makeTempDir(t)
  const inPdf = path.join(dir, 'err.pdf')
  fs.writeFileSync(inPdf, '%PDF-1.4\ncontent')

  let capturedChildEnv = null
  const svc = createPdfTranslateService({
    app: { getPath: () => dir },
    execFileAsync: async (bin) => {
      if (bin === 'pdf2zh_next') {
        return {
          status: 0,
          stdout: [
            '[11/23/26 14:34:21] WARNING  WARNING:pdf2zh_next.config.cli:No engine selected',
            'INFO: Using SiliconFlowFree',
            'pdf2zh-next version: 2.10.2'
          ].join('\n'),
          stderr: ''
        }
      }
      return { status: 1, stdout: '', stderr: 'ENOENT' }
    },
    spawnImpl: (_bin, _args, opts) => {
      capturedChildEnv = opts.env
      const child = new EventEmitter()
      child.pid = 61616
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from([
          'Traceback (most recent call last):',
          '  File "C:\\Users\\test\\AppData\\Roaming\\uv\\tools\\pdf2zh-next\\main.py", line 10, in cli',
          '    raise ValueError("OpenAI API key is required")',
          'ValueError: OpenAI API key is required',
          '  File "C:\\Users\\test\\tail.py", line 1'
        ].join('\n')))
        child.emit('close', 1, null)
      }, 15)
      return child
    },
    getState: () => ({ settings: { pdfTranslate: { service: 'active-ai' } } }),
    aiService: {
      getActiveProviderCredentials: () => ({
        id: 'p1',
        name: 'MockAI',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret-key-xyz',
        defaultModel: 'gpt-4o-mini'
      })
    }
  })

  const probed = await svc.probeEnvironment({ checkServer: false, checkUv: false })
  assert.equal(probed.cli.found, true)
  assert.equal(probed.cli.kind, 'pdf2zh_next')
  assert.equal(probed.cli.version, 'pdf2zh-next version: 2.10.2')

  const failRes = await svc.runTranslation({ filePath: inPdf })
  assert.equal(failRes.ok, false)
  assert.match(failRes.error, /ValueError: OpenAI API key is required/)
  assert.doesNotMatch(failRes.error, /File "C:\\/)

  assert.equal(capturedChildEnv.PDF2ZH_OPENAI_API_KEY.startsWith('stk-'), true)
  assert.equal(capturedChildEnv.PDF2ZH_OPENAI_BASE_URL, capturedChildEnv.OPENAI_BASE_URL)
  assert.equal(capturedChildEnv.PDF2ZH_OPENAI_MODEL, 'gpt-4o-mini')
  assert.ok(capturedChildEnv.NO_PROXY.includes('127.0.0.1'))
  assert.ok(capturedChildEnv.NO_PROXY.includes('localhost'))
  assert.ok(capturedChildEnv.no_proxy.includes('127.0.0.1'))
})

test('createPdfTranslateService uses asymptotic floor and preserves real cur/total paragraph progress', async (t) => {
  const dir = makeTempDir(t)
  const inPdf = path.join(dir, 'long-paper.pdf')
  fs.writeFileSync(inPdf, '%PDF-1.4\ncontent')

  const events = []
  const svc = createPdfTranslateService({
    app: { getPath: () => dir },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (_ch, payload) => events.push(payload)
        }
      }]
    },
    execFileAsync: async (bin) => {
      if (bin === 'pdf2zh_next') return { status: 0, stdout: 'pdf2zh_next version: 2.10.2', stderr: '' }
      return { status: 1, stdout: '', stderr: 'ENOENT' }
    },
    fetchImpl: async () => new Response(JSON.stringify({ id: 'mock', choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }),
    spawnImpl: (_bin, args, opts) => {
      const child = new EventEmitter()
      child.pid = 71717
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}

      setTimeout(async () => {
        const callProxy = () => fetch(`${opts.env.OPENAI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
        })

        // 连续完成 25 次代理请求且尚未收到 CLI 真实进度：进度条不得提前冲到 88%
        for (let i = 0; i < 25; i++) {
          const r = await callProxy()
          assert.equal(r.status, 200)
        }
        const beforeReal = events.filter((e) => e.status === 'running').map((e) => e.percent)
        assert.ok(Math.max(...beforeReal) < 45, `expected <45% after 25 proxy calls, got ${Math.max(...beforeReal)}`)

        // 收到 CLI 真实段落进度 45/200 后，后续代理请求不得抹掉 45/200 分母；再推送 100/200 与 180/200 按真实比例推进
        child.stdout.emit('data', Buffer.from('Translate Paragraphs (1/1) ---- 45/200\n'))
        await new Promise((r) => setTimeout(r, 15))
        for (let i = 0; i < 5; i++) {
          await callProxy()
        }
        const afterParaMsgs = events.slice(-6).map((e) => e.message)
        assert.equal(afterParaMsgs.some((m) => m.includes('45/200')), true)
        assert.equal(afterParaMsgs.every((m) => !m.includes('正在调用 AI 模型翻译')), true)

        // 继续收到 100/200 -> 54%，180/200 -> 81%，以及排版节点 Typesetting -> 89%
        child.stdout.emit('data', Buffer.from('Translate Paragraphs (1/1) ---- 100/200\nTranslate Paragraphs (1/1) ---- 180/200\nTypesetting (1/1) ---- 0/1\n'))
        const outIdx = args.indexOf('--output')
        const stagingDir = args[outIdx + 1]
        fs.writeFileSync(path.join(stagingDir, 'long-paper.zh.dual.pdf'), '%PDF-1.4\ntranslated')
        child.emit('close', 0, null)
      }, 20)

      return child
    },
    getState: () => ({ settings: { pdfTranslate: { service: 'active-ai', mode: 'dual' } } }),
    aiService: {
      getActiveProviderCredentials: () => ({
        id: 'p1',
        name: 'MockAI',
        baseUrl: 'https://mock-upstream.example.com/v1',
        apiKey: 'sk-secret-key',
        defaultModel: 'gpt-4o-mini'
      })
    }
  })
  t.after(() => svc.dispose())

  const res = await svc.runTranslation({ filePath: inPdf })
  assert.equal(res.ok, true)
  assert.equal(events.some((e) => e.message.includes('45/200')), true)
  assert.equal(events.some((e) => e.percent === 54 && e.message.includes('100/200')), true)
  assert.equal(events.some((e) => e.percent === 81 && e.message.includes('180/200')), true)
  assert.equal(events.some((e) => e.percent === 89), true)
})
