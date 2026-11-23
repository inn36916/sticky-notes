'use strict'

/**
 * worker-host 权限收口、sender 校验与安全契约回归测试
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createWorkerHost } = require('../lib/convert/worker-host')

const ROOT = path.join(__dirname, '..')

function createFakeEnv () {
  const ipc = new EventEmitter()
  const sent = []
  let createdOpts = null

  class FakeWebContents extends EventEmitter {
    send (channel, ...args) {
      sent.push({ channel, args })
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    constructor (opts) {
      super()
      createdOpts = opts
      this.webContents = new FakeWebContents()
      this._destroyed = false
    }
    isDestroyed () { return this._destroyed }
    destroy () { this._destroyed = true; this.emit('closed') }
    loadFile () { queueMicrotask(() => this.webContents.emit('did-finish-load')) }
  }

  return {
    ipc,
    sent,
    getCreatedOpts: () => createdOpts,
    BrowserWindow: FakeBrowserWindow
  }
}

test('workerHost 使用最小权限 preload-worker.js 并在 decode 时主进程读字节下发', async () => {
  const env = createFakeEnv()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-wh-sec-'))
  const imgFile = path.join(dir, 'sample.png')
  const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  fs.writeFileSync(imgFile, rawBytes)

  const host = createWorkerHost({
    BrowserWindow: env.BrowserWindow,
    ipcMain: env.ipc,
    srcDir: path.join(ROOT, 'src')
  })

  let pendingDecode = null
  try {
    const w = await host.ensure()
    const opts = env.getCreatedOpts()
    assert.ok(opts.webPreferences.preload.endsWith('preload-worker.js'), '应使用专属最小权限 preload-worker.js')

    pendingDecode = host.decode(imgFile)
    for (let i = 0; i < 50 && env.sent.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5))
    }

    assert.equal(env.sent.length, 1)
    assert.equal(env.sent[0].channel, 'convert:worker-decode')
    const [reqId, payloadBytes, mime] = env.sent[0].args
    assert.ok(payloadBytes instanceof Uint8Array, '主进程应直接下发 Uint8Array 字节')
    assert.deepEqual(Buffer.from(payloadBytes), rawBytes)
    assert.equal(mime, 'image/png')

    // 伪造其他 webContents 回信应被忽略
    const attackerSender = { id: 999 }
    env.ipc.emit('convert:worker-decoded', { sender: attackerSender }, reqId, { ok: false, error: 'spoofed' })

    // 真实 worker 窗口回信才结算
    env.ipc.emit('convert:worker-decoded', { sender: w.webContents }, reqId, { ok: true, width: 1, height: 1, canvasId: 'c1' })
    const res = await pendingDecode
    assert.deepEqual(res, { ok: true, width: 1, height: 1, canvasId: 'c1' })
  } finally {
    host.dispose()
    if (pendingDecode) await pendingDecode.catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('workerHost.decode 对不存在文件直接返回明确错误而不挂起 IPC', async () => {
  const env = createFakeEnv()
  const host = createWorkerHost({
    BrowserWindow: env.BrowserWindow,
    ipcMain: env.ipc,
    srcDir: path.join(ROOT, 'src')
  })
  try {
    const res = await host.decode(path.join(os.tmpdir(), 'definitely-missing-' + Date.now() + '.png'))
    assert.equal(res.ok, false)
    assert.ok(res.error)
    assert.equal(env.sent.length, 0)
  } finally {
    host.dispose()
  }
})

test('workerHost.dispose 清理 ipcMain 监听并拒绝在途请求', async () => {
  const env = createFakeEnv()
  const host = createWorkerHost({
    BrowserWindow: env.BrowserWindow,
    ipcMain: env.ipc,
    srcDir: path.join(ROOT, 'src')
  })
  assert.equal(env.ipc.listenerCount('convert:worker-decoded'), 1)
  assert.equal(env.ipc.listenerCount('convert:worker-encoded'), 1)

  const pendingReq = host.encode('c1', 'image/png')
  await new Promise(r => setImmediate(r))
  host.dispose()

  await assert.rejects(pendingReq, /释放|关闭/)
  assert.equal(env.ipc.listenerCount('convert:worker-decoded'), 0)
  assert.equal(env.ipc.listenerCount('convert:worker-encoded'), 0)
})

test('静态安全契约：业务 preload 与 worker preload 严格隔离，CSP 与主进程修补到位', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  const preloadWorker = fs.readFileSync(path.join(ROOT, 'preload-worker.js'), 'utf8')
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const mainSubModules = fs.readdirSync(path.join(ROOT, 'main'))
    .filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(ROOT, 'main', f), 'utf8'))
  const allMainCode = [mainJs, ...mainSubModules].join('\n')
  const windowsJs = fs.readFileSync(path.join(ROOT, 'main', 'windows.js'), 'utf8')

  assert.equal(/readFileBytes|convert:read-bytes|onWorkerDecode|workerDecoded|workerEncoded/.test(preload), false,
    '普通窗口 preload.js 不得暴露任意读文件或 worker IPC')

  assert.ok(/onWorkerDecode/.test(preloadWorker) && /workerDecoded/.test(preloadWorker))
  assert.equal(/readFileBytes|note:update|ai:config|explorer-verb/.test(preloadWorker), false,
    'preload-worker.js 不得包含业务或高权限 IPC')

  assert.equal(/convert:read-bytes/.test(allMainCode), false, '主进程不得继续注册 convert:read-bytes')
  assert.equal(/\bspawnSync\s*\(|require\(['"]child_process['"]\)[^\n]*\bspawnSync\b/.test(allMainCode), false,
    '主进程不得使用阻塞主线程的 spawnSync')
  assert.ok(/win\.webContents\.on\('did-finish-load'/.test(windowsJs), 'createNoteWindow 应监听 webContents.did-finish-load')
  assert.ok(/convertRuntime\.handleArgv\(launchArgv\)\)/.test(mainJs), 'second-instance 应按 handleArgv 返回值决定是否 return')

  const htmlFiles = fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.html'))
  assert.equal(htmlFiles.length, 10)
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')
    const m = html.match(/Content-Security-Policy[\s\S]*?content="([^"]+)"/i)
    assert.ok(m, `${f} 缺少 CSP`)
    assert.ok(/connect-src\s+'none'/.test(m[1]), `${f} 的 CSP 必须包含 connect-src 'none'`)
    if (f === 'note.html' || f === 'preview.html') {
      assert.ok(/sticky-att:/.test(m[1]), `${f} 的 img-src 必须放行 sticky-att:`)
    }
  }

  const workerHtml = fs.readFileSync(path.join(ROOT, 'src', 'convert-worker.html'), 'utf8')
  assert.ok(/<script\s+src="guard\.js"\s*><\/script>/.test(workerHtml), 'convert-worker.html 应接入 guard.js')
})
