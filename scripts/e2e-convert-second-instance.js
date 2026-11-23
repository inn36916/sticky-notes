'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { runOnce, CDP, waitFor } = require('./e2e-snapshot-semantics')
const ROOT = path.join(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/electron.exe')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

async function main () {
  const result = await runOnce('真实二次进程：右键 PNG 只识别图片并转换 JPG', async ({ mainCdp, userData, cdpPort, steps }) => {
    const file = path.join(userData, '来自资源管理器 1.PNG')
    fs.writeFileSync(file, Buffer.from(PNG, 'base64'))
    await mainCdp.evaluate(`(() => {
      const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(ROOT, 'main.js'))})
      req('electron').app.on('second-instance', (_e, argv, _cwd, data) => { globalThis.__rightClickLaunch = { argv, data } })
    })()`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const secondary = spawn(ELECTRON, [ROOT, '--convert', file, '--user-data-dir=' + userData], { cwd: ROOT, env, windowsHide: true, stdio: 'ignore' })
    try {
      await waitFor(() => secondary.exitCode !== null, 15000, '二次进程退出')
      assert.equal(secondary.exitCode, 0)
      const target = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find(t => /convert\.html/.test(t.url)), 10000, '实际格式选择窗')
      const convert = new CDP(target.webSocketDebuggerUrl)
      await convert.connect()
      try {
        const info = await waitFor(async () => {
          const state = await convert.evaluate(`({ files: document.getElementById('files').textContent, status: document.getElementById('status').textContent, targets: [...document.querySelectorAll('#available .fmt')].map(el => el.dataset.fmt) })`)
          return state.targets.length || state.status.includes('无法识别') ? state : null
        }, 10000, '识别结果')
        assert.equal(info.files, path.basename(file), '实际文件列表不应混入程序目录：' + JSON.stringify(info))
        assert.ok(info.targets.includes('jpg'), JSON.stringify(info))
        const launch = await mainCdp.evaluate('globalThis.__rightClickLaunch')
        assert.ok(launch.argv.includes('--convert'))
        steps.push('真实 second-instance 事件产生；格式窗只列出 ' + path.basename(file))
        await convert.evaluate(`document.querySelector('#available .fmt[data-fmt="jpg"]').click()`)
        const jpg = path.join(userData, '来自资源管理器 1.jpg')
        await waitFor(() => fs.existsSync(jpg), 15000, '源目录转换文件落盘')
        const bytes = fs.readFileSync(jpg)
        assert.equal(bytes.readUInt16BE(0), 0xffd8)
        const disk = JSON.parse(fs.readFileSync(path.join(userData, 'sticky-notes.json'), 'utf8'))
        assert.equal(disk.notes.length, 1, '转换不应生成结果便签')
        assert.equal(fs.existsSync(path.join(userData, 'attachments')), false)
        steps.push('PNG → JPG 已保存到源目录，未生成新便签')
      } finally { convert.close() }
    } finally { if (secondary.exitCode === null) secondary.kill() }
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
