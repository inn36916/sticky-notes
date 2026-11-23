'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const { CDP, waitFor } = require('./e2e-snapshot-semantics')
const root = path.join(__dirname, '..')
const version = require('../package.json').version
const source = path.join(root, 'dist', 'StickyNotes-' + version + '-win-x64')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-portable-smoke-'))
const dataDir = path.join(temporary, 'data')
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const requireExpr = "process.getBuiltinModule('module').createRequire(" + JSON.stringify(path.join(temporary, 'resources', 'app', 'main.js')) + " )"
async function launch (first) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)) delete env[key]
  env.Path = path.join(process.env.SystemRoot, 'System32')
  const child = spawn(path.join(temporary, 'StickyNotes.exe'), ['--remote-debugging-port=0', '--inspect=0'], { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let log = ''
  child.stdout.on('data', data => { log += data })
  child.stderr.on('data', data => { log += data })
  let main
  let page
  try {
    const inspector = await waitFor(() => (log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/) || [])[1], 20000, '便携版主进程')
    const devtools = await waitFor(() => (log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/) || [])[1], 20000, '便携版渲染进程')
    main = new CDP(inspector); await main.connect()
    console.log('[portable-smoke] inspector connected')
    const appPathResult = await main.send('Runtime.evaluate', { expression: "(() => { const req = " + requireExpr + "; return req('electron').app.getPath('userData') })()", returnByValue: true })
    if (appPathResult.exceptionDetails) throw new Error(JSON.stringify(appPathResult.exceptionDetails))
    const appPath = appPathResult.result.value
    console.log('[portable-smoke] user data path checked')
    assert.equal(path.resolve(appPath), path.resolve(dataDir), '便携版数据目录不在程序旁')
    const target = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + devtools + '/json/list')).json()).find(t => /note\.html/.test(t.url)), 15000, '便携便签')
    page = new CDP(target.webSocketDebuggerUrl); await page.connect()
    await waitFor(() => page.evaluate('document.querySelector("#editor .mmd svg") && document.querySelector("#editor img").naturalWidth === 1'), 15000, '便携图片与 Mermaid')
    console.log('[portable-smoke] image and Mermaid ready')
    if (first) {
      await page.evaluate(`(async () => { await insertImageDataUrl(${JSON.stringify(png)}); const p = document.createElement('p'); p.textContent='PORTABLE-RESTART-MARK'; editor.appendChild(p); onEditorChanged(); await flushSave() })()`)
    } else assert.ok(await page.evaluate('document.querySelector("#editor").textContent.includes("PORTABLE-RESTART-MARK")'))
    console.log('[portable-smoke] content saved; quitting')
    await main.send('Runtime.evaluate', { expression: '(() => { ' + requireExpr + "('electron').app.quit(); return { ok: true } })()", returnByValue: true })
    main.close(); main = null
    await waitFor(() => child.exitCode !== null, 15000, '便携版自然退出')
    assert.equal(child.exitCode, 0)
    const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'sticky-notes.json'), 'utf8'))
    assert.ok(disk.notes[0].html.includes('PORTABLE-RESTART-MARK'))
    assert.ok(disk.notes[0].html.includes('sticky-att://local/'))
    console.log('PASS 便携版 ' + (first ? '无 Node/npm/Python PATH 启动、图片插入、Mermaid、自然退出' : '重启后图文恢复和程序旁数据目录'))
  } catch (err) { console.error(log.slice(-3000)); throw err }
  finally {
    if (page) page.close()
    if (main) main.close()
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)) }
  }
}
async function main () {
  try {
    fs.cpSync(source, temporary, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'sticky-notes.json'), JSON.stringify({ version: 2, settings: { globalSelect: false }, notes: [{ id: 'portable-test', title: '便携版验证', visible: true, bounds: { x: 200, y: 150, width: 420, height: 520 }, html: '<p>便携版图文</p><img src="' + png + '"><div class="mmd" contenteditable="false" data-code="graph TD; A--&gt;B"><div class="mmd-body"></div></div>' }] }))
    await launch(true)
    await launch(false)
  } finally {
    const resolved = path.resolve(temporary)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('sticky-portable-smoke-')) throw new Error('拒绝清理非测试目录')
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
}
main().catch(err => { console.error(err); process.exitCode = 1 })
