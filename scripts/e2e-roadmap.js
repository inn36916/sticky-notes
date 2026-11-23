'use strict'
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { runOnce, CDP, waitFor } = require('./e2e-snapshot-semantics')
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
function fixture (state) {
  state.notes = state.notes.slice(0, 1)
  state.notes[0].html = '<p>SEED-MARK</p><img src="' + PNG + '"><div class="mmd" contenteditable="false" data-code="graph TD; A--&gt;B"><div class="mmd-tools"><button data-mmd="edit">✎</button></div><div class="mmd-body"></div></div>'
  return state
}
async function main () {
  const results = []
  results.push(await runOnce('图片迁移、任务勾选/撤销、阅读模式、文本工具', async ({ editorCdp, mainCdp, cdpPort, userData, steps }) => {
    await editorCdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const image = await editorCdp.evaluate('document.querySelector("#editor img").getAttribute("src")')
    assert.ok(image.startsWith('sticky-att://local/'))
    await mainCdp.evaluate("(() => { const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(process.cwd() + '/'); req('electron').clipboard.writeImage = image => { globalThis.__copiedImageSize = image.getSize() } })()")
    assert.equal((await editorCdp.evaluate('window.sticky.copyImage(' + JSON.stringify(image) + ')')).ok, true)
    assert.equal((await mainCdp.evaluate('globalThis.__copiedImageSize')).width, 1)
    await editorCdp.evaluate('setMode("read"); document.querySelector("#editor img").click()')
    const previewTarget = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find(t => /preview\.html/.test(t.url)), 10000, '图片预览')
    const preview = new CDP(previewTarget.webSocketDebuggerUrl); await preview.connect()
    try { await waitFor(() => preview.evaluate('document.querySelector("#img").naturalWidth === 1'), 10000, '预览解码') }
    finally { preview.close() }
    await editorCdp.evaluate('setMode("edit")')
    assert.ok(fs.readdirSync(path.join(userData, 'backups')).length)
    await waitFor(() => editorCdp.evaluate('document.querySelector("#editor img").naturalWidth === 1'), 10000, '外置图片加载')
    await editorCdp.evaluate(`(() => { const ed = document.querySelector('#editor'); ed.focus(); const range = document.createRange(); range.selectNodeContents(ed); range.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(range); document.querySelector('[data-act="task"]').click(); })()`)
    assert.equal(await editorCdp.evaluate('document.querySelectorAll("#editor input[type=checkbox]").length'), 1, await editorCdp.evaluate('document.querySelector("#editor").innerHTML.slice(-700)'))
    await editorCdp.evaluate('document.querySelector("#editor input[type=checkbox]").click()')
    assert.equal(await editorCdp.evaluate('document.querySelector("#editor input[type=checkbox]").hasAttribute("checked")'), true)
    await editorCdp.evaluate('document.execCommand("undo"); onEditorChanged()')
    assert.equal(await editorCdp.evaluate('document.querySelector("#editor input[type=checkbox]").hasAttribute("checked")'), false)
    await editorCdp.evaluate('document.querySelector("#editor input[type=checkbox]").click(); setMode("read")')
    await editorCdp.evaluate('document.querySelector("#editor input[type=checkbox]").click()')
    assert.equal(await editorCdp.evaluate('document.querySelector("#editor input[type=checkbox]").hasAttribute("checked")'), true)
    await editorCdp.evaluate('setMode("edit")')
    async function tool (text, action) {
      return editorCdp.evaluate(`(() => { const p = document.createElement('p'); p.id = 'tool-test'; p.textContent = ${JSON.stringify(text)}; document.querySelector('#editor').appendChild(p); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); p.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 50 })); document.querySelector('[data-tool="${action}"]').click(); return p.textContent; })()`)
    }
    assert.equal(await tool('  hello  ', 'trim'), 'hello')
    await editorCdp.evaluate('document.execCommand("undo"); onEditorChanged()')
    assert.equal(await editorCdp.evaluate('document.querySelector("#tool-test").textContent'), '  hello  ')
    await editorCdp.evaluate('document.querySelector("#tool-test").remove()')
    await tool('{"a":1}', 'json')
    assert.ok((await editorCdp.evaluate('document.querySelector("#editor").innerText')).includes('{\n  "a": 1\n}'))
    await editorCdp.evaluate('document.querySelector("#tool-test").remove()')
    assert.equal(await tool('{broken', 'json'), '{broken')
    await editorCdp.evaluate('document.querySelector("#tool-test").remove()')
    assert.equal(await tool('%E0%A4', 'decode'), '%E0%A4')
    await editorCdp.evaluate('document.querySelector("#tool-test").remove()')
    assert.equal(await tool('中文 a', 'encode'), encodeURIComponent('中文 a'))
    await editorCdp.evaluate('document.querySelector("#tool-test").remove()')
    assert.equal(await tool(encodeURIComponent('中文 a'), 'decode'), '中文 a')
    await editorCdp.evaluate('document.querySelector("#tool-test").remove(); onEditorChanged(); flushSave()')
    const boundaries = await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor')
      const block = document.createElement('div'); block.innerHTML = '<p> alpha</p><p>beta </p>'; ed.appendChild(block)
      ed.focus()
      const range = document.createRange(); range.selectNodeContents(block)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
      const expected = selection.toString().trim()
      block.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      document.querySelector('[data-tool="trim"]').click()
      const multiline = block.innerText
      document.execCommand('undo'); onEditorChanged(); block.remove()
      const table = document.createElement('table'); table.innerHTML = '<tr><td>first</td><td>second</td></tr>'; ed.appendChild(table)
      const cells = table.querySelectorAll('td')
      range.setStart(cells[0].firstChild, 0); range.setEnd(cells[1].firstChild, 6)
      selection.removeAllRanges(); selection.addRange(range)
      table.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      const tableBlocked = document.querySelector('.text-tools').hidden
      range.collapse(true); selection.removeAllRanges(); selection.addRange(range)
      table.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      const emptyBlocked = document.querySelector('.text-tools').hidden
      table.remove(); onEditorChanged()
      return { expected, multiline, tableBlocked, emptyBlocked }
    })()`)
    assert.equal(boundaries.multiline, boundaries.expected)
    assert.equal(boundaries.tableBlocked, true)
    assert.equal(boundaries.emptyBlocked, true)
    await editorCdp.evaluate(`(() => {
      const ed = document.querySelector('#editor'); ed.focus()
      const range = document.createRange(); range.selectNodeContents(ed); range.collapse(false)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
      const data = new DataTransfer(); data.setData('text/html', '<ul><li><input type="checkbox" checked>粘贴任务</li></ul>')
      ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }))
      onEditorChanged()
    })()`)
    assert.equal(await editorCdp.evaluate('document.querySelectorAll("#editor input[checked]").length'), 2)
    await editorCdp.evaluate('flushSave()')
    steps.push('外置图片解码、任务完成属性、撤销、阅读模式防修改、文本工具正常/无效输入通过')
  }, (disk) => {
    assert.ok(disk.notes[0].html.includes('checked'))
    assert.ok(disk.notes[0].html.includes('sticky-att://'))
    assert.ok(disk.notes[0].html.includes('data-code'))
  }, fixture))

  results.push(await runOnce('提醒与归档恢复、隐藏到期、禁止显示归档', async ({ editorCdp, mainCdp, steps }) => {
    await mainCdp.evaluate("(() => { const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(process.cwd() + '/'); req('electron').Notification.prototype.show = function () { globalThis.__testNotification = this }; })()")
    const result = await editorCdp.evaluate(`(async () => {
      const api = window.sticky
      const id = (await api.getNote()).id
      await api.action(id, 'reminder', Date.now() + 700)
      await api.hide()
      await new Promise(r => setTimeout(r, 1200))
      const due = (await api.list()).find(n => n.id === id)
      const before = await api.getNote()
      await api.action(id, 'archive')
      await api.showAll()
      const denied = await api.action(id, 'show')
      const archived = (await api.list()).find(n => n.id === id)
      await api.action(id, 'restore')
      const restored = await api.getNote()
      return { due, before, denied, archived, restored }
    })()`)
    assert.equal(result.due.reminder.status, 'delivered')
    assert.ok(result.archived.archivedAt)
    assert.equal(result.archived.visible, false)
    assert.equal(result.archived.reminder, null)
    assert.equal(result.denied, false)
    assert.equal(result.restored.archivedAt, null)
    assert.equal(result.restored.visible, false)
    await mainCdp.evaluate("globalThis.__testNotification.emit('click')")
    assert.equal(await editorCdp.evaluate('window.sticky.getNote().then(n => n.visible)'), true)
    assert.equal(result.restored.html, result.before.html)
    assert.deepEqual(result.restored.bounds, result.before.bounds)
    steps.push('隐藏便签到期状态、归档取消提醒、全部显示不打开归档、恢复正文与位置通过')
  }, null, fixture))

  results.push(await runOnce('Markdown 图文附件往返与安全边界', async ({ mainCdp, userData, steps }) => {
    const result = await mainCdp.evaluate(`(async () => {
      const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(process.cwd() + '/')
      const fs = req('fs'), path = req('path')
      const root = ${JSON.stringify(userData)}
      const exchange = req('./lib/note-exchange')
      const parser = req('./main/note-search').createSearchService(req('electron').BrowserWindow)
      const image = req('./lib/image-store').storeImage(root, ${JSON.stringify(PNG)})
      const attachment = path.join(root, 'attachments', '测试.txt'); fs.writeFileSync(attachment, '转换附件内容')
      const html = '<p>中文<strong>正文</strong></p><ul><li><input type="checkbox" checked> 已完成</li><li><input type="checkbox"> 待办</li></ul><div class="mmd" data-code="graph TD; A--&gt;B"><div class="mmd-body"></div></div><img src="' + image + '"><p class="attachment" data-attachment="测试.txt" data-path="' + attachment + '">附件</p>'
      const target = path.join(root, '往返.md')
      const exported = await exchange.exportFile({ title: '标题', html }, target, root, parser.convert)
      const imported = await exchange.importFile(target, root, parser.convert)
      const round = await parser.convert('exportNote', imported)
      const old = fs.readFileSync(target, 'utf8')
      const failed = await exchange.exportFile({ title: '坏图', html: '<img src="sticky-att://local/missing.png">' }, target, root, parser.convert)
      const unchanged = fs.readFileSync(target, 'utf8') === old
      fs.writeFileSync(path.join(root, 'bad.md'), '![缺失](missing.png)')
      let missing = false
      try { await exchange.importFile(path.join(root, 'bad.md'), root, parser.convert) } catch (_) { missing = true }
      fs.writeFileSync(path.join(root, 'unsafe.md'), '![越界](../private.png)')
      let unsafe = false
      try { await exchange.importFile(path.join(root, 'unsafe.md'), root, parser.convert) } catch (_) { unsafe = true }
      fs.writeFileSync(path.join(root, 'plain.txt'), '纯文本\\n第二行')
      const plain = await exchange.importFile(path.join(root, 'plain.txt'), root, parser.convert)
      const sanitized = await parser.convert('importHtml', { title: '安全', html: '<div class="mmd"><script>alert(1)</script><img src="x" onerror="alert(1)"></div>' })
      return { exported, imported, round, failed, unchanged, missing, unsafe, plain, sanitized }
    })()`)
    assert.equal(result.exported.ok, true)
    assert.equal(result.imported.title, '标题')
    assert.ok(result.imported.html.includes('checked'))
    assert.ok(result.round.markdown.includes('graph TD; A-->B'))
    assert.ok(result.round.markdown.includes('- [x]'))
    assert.equal(result.round.resources.length, 2)
    assert.equal(result.failed.ok, false)
    assert.equal(result.unchanged, true)
    assert.equal(result.missing, true)
    assert.equal(result.unsafe, true)
    assert.ok(result.plain.html.includes('第二行'))
    assert.ok(!result.sanitized.html.includes('onerror') && !result.sanitized.html.includes('<script'))
    steps.push('Markdown 标题、任务、Mermaid、截图和转换附件往返；缺失/越界资源与失败保留旧导出通过')
  }, null, fixture))

  results.push(await runOnce('边缘卡组入口、恢复与 Esc', async ({ editorCdp, cdpPort, steps }) => {
    await editorCdp.evaluate(`(async () => { const api = window.sticky; await api.edgeGroups(true); for (const title of ['卡组二', '卡组三']) { const n = await api.createFromCenter({ title }); await api.action(n.id, 'collapse') } const b = await api.getBounds(); await api.setBounds({ ...b, x: 0, y: 150 }); await api.collapse('left'); })()`)
    const target = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find(t => /edge-group\.html/.test(t.url)), 10000, '卡组入口')
    const group = new CDP(target.webSocketDebuggerUrl); await group.connect()
    try {
      await waitFor(() => group.evaluate('document.querySelector("#toggle").textContent.includes("3")'), 10000, '卡组数据')
      await group.evaluate('document.querySelector("#toggle").click()')
      await waitFor(() => group.evaluate('!document.querySelector("#cards").hidden'), 5000, '卡组展开')
      await group.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))')
      assert.equal(await group.evaluate('document.querySelector("#cards").hidden'), true)
      await group.evaluate('document.querySelector("#toggle").click()')
      await waitFor(() => group.evaluate('!document.querySelector("#cards").hidden'), 5000, '再次展开')
      await group.evaluate('document.querySelector("#cards button[data-id=e2e-snap-note]").click()')
      await waitFor(() => editorCdp.evaluate('window.sticky.collapseState().then(s => !s.collapsed)'), 5000, '正确便签恢复')
      await editorCdp.evaluate('window.sticky.edgeGroups(false)')
      steps.push('卡组聚合、键盘 Esc 收起、点击恢复原便签通过')
    } finally { group.close() }
  }, null, fixture))
  results.push(await runOnce('正常导入导出入口与取消、批量失败回滚', async ({ editorCdp, mainCdp, cdpPort, userData, steps }) => {
    const target = path.join(userData, '入口导出.md')
    await mainCdp.evaluate(`(() => { const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(process.cwd() + '/'); req('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(target)} }); })()`)
    await editorCdp.evaluate('document.getElementById("exportMarkdown").click()')
    await waitFor(() => fs.existsSync(target), 10000, '便签菜单导出')
    const before = fs.readFileSync(target, 'utf8')
    const textFile = path.join(userData, '批量文本.txt')
    fs.writeFileSync(textFile, '批量导入第二张')
    await mainCdp.evaluate(`(() => { const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(process.cwd() + '/'); req('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ${JSON.stringify([target, textFile])} }); })()`)
    await editorCdp.evaluate('window.sticky.openDashboard()')
    const targetPage = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find(t => /dashboard\.html/.test(t.url)), 10000, '便签中心导入入口')
    const dashboard = new CDP(targetPage.webSocketDebuggerUrl); await dashboard.connect()
    try {
      await waitFor(() => dashboard.evaluate('!!document.getElementById("importNotes")'), 5000, '导入按钮')
      await dashboard.evaluate('document.getElementById("importNotes").click()')
      await waitFor(() => editorCdp.evaluate('window.sticky.list().then(notes => notes.length === 3)'), 10000, '批量导入创建新便签')
    } finally { dashboard.close() }
    await mainCdp.evaluate(`(() => { const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(process.cwd() + '/'); req('electron').dialog.showSaveDialog = async () => ({ canceled: true }); req('electron').dialog.showOpenDialog = async () => ({ canceled: true }); })()`)
    assert.equal((await editorCdp.evaluate('window.sticky.exportNote("md")')).canceled, true)
    assert.equal((await editorCdp.evaluate('window.sticky.importNotes()')).canceled, true)
    assert.equal(fs.readFileSync(target, 'utf8'), before)
    const bad = path.join(userData, '缺失资源.md'); fs.writeFileSync(bad, '![missing](missing.png)')
    const oldAttachments = fs.readdirSync(path.join(userData, 'attachments')).sort()
    await mainCdp.evaluate(`(() => { const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(process.cwd() + '/'); req('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ${JSON.stringify([target, bad])} }); })()`)
    assert.equal((await editorCdp.evaluate('window.sticky.importNotes()')).ok, false)
    assert.equal((await editorCdp.evaluate('window.sticky.list()')).length, 3)
    assert.deepEqual(fs.readdirSync(path.join(userData, 'attachments')).sort(), oldAttachments)
    steps.push('菜单导出、中心批量导入、取消不改文件、失败不创建便签或遗留附件通过')
  }, null, fixture))

  let archivedDisk
  let archivedAttachments
  results.push(await runOnce('归档退出后的配对数据', async ({ editorCdp, cdpPort, userData }) => {
    const converted = path.join(userData, 'attachments', '转换附件.txt')
    fs.writeFileSync(converted, '归档附件内容')
    await editorCdp.evaluate(`(async () => {
      const ed = document.querySelector('#editor')
      ed.insertAdjacentHTML('beforeend', '<ul><li><input type="checkbox" checked>已完成</li></ul>')
      const attachment = document.createElement('p'); attachment.className = 'attachment'; attachment.dataset.attachment = '转换附件.txt'; attachment.dataset.path = ${JSON.stringify(converted)}; attachment.textContent = '📎 转换附件.txt'; ed.appendChild(attachment)
      onEditorChanged(); await flushSave()
      await window.sticky.action((await window.sticky.getNote()).id, 'archive')
    })()`)
    await editorCdp.evaluate('window.sticky.openDashboard()')
    const target = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()).find(t => /dashboard\.html/.test(t.url)), 10000, '归档页')
    const dashboard = new CDP(target.webSocketDebuggerUrl); await dashboard.connect()
    try {
      await waitFor(() => dashboard.evaluate('document.getElementById("cArchived").textContent === "1"'), 5000, '归档计数')
      await dashboard.evaluate("document.querySelector(\"[data-filter=archived]\").click(); const search = document.getElementById(\"search\"); search.value = \"SEED-MARK\"; search.dispatchEvent(new Event(\"input\"))")
      await waitFor(() => dashboard.evaluate('document.querySelectorAll(".card").length === 1 && document.querySelector(".preview").textContent.includes("SEED-MARK")'), 5000, '归档全文搜索')
    } finally { dashboard.close() }
    archivedAttachments = fs.readdirSync(path.join(userData, 'attachments')).map(name => [name, fs.readFileSync(path.join(userData, 'attachments', name))])
  }, disk => { archivedDisk = disk; assert.ok(disk.notes[0].archivedAt); assert.equal(disk.notes[0].visible, false) }, fixture))
  if (archivedDisk) results.push(await runOnce('重启恢复归档图文和任务', async ({ editorCdp, mainCdp, cdpPort, userData, steps }) => {
    fs.mkdirSync(path.join(userData, 'attachments'), { recursive: true })
    for (const [name, bytes] of archivedAttachments) fs.writeFileSync(path.join(userData, 'attachments', name), bytes)
    const archivedId = archivedDisk.notes[0].id
    const before = await editorCdp.evaluate('window.sticky.list()')
    assert.equal(before.find(n => n.id === archivedId).visible, false)
    await editorCdp.evaluate('window.sticky.action(' + JSON.stringify(archivedId) + ', "restore").then(() => window.sticky.action(' + JSON.stringify(archivedId) + ', "show"))')
    const target = await waitFor(async () => {
      const targets = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/list')).json()
      for (const candidate of targets.filter(t => /note\.html/.test(t.url))) {
        const c = new CDP(candidate.webSocketDebuggerUrl); await c.connect()
        const id = await c.evaluate('window.sticky.getNote().then(n => n && n.id)'); c.close()
        if (id === archivedId) return candidate
      }
    }, 10000, '重启恢复的便签窗口')
    const restored = new CDP(target.webSocketDebuggerUrl); await restored.connect()
    try {
      await waitFor(() => restored.evaluate('document.querySelector("#editor img") && document.querySelector("#editor img").naturalWidth === 1'), 10000, '重启后图片解码')
      assert.equal(await restored.evaluate('document.querySelector("#editor input[type=checkbox]").hasAttribute("checked")'), true)
      assert.equal(await restored.evaluate('document.querySelector("#editor .mmd").dataset.code'), 'graph TD; A-->B')
      const note = await restored.evaluate('window.sticky.getNote()')
      assert.deepEqual(note.bounds, archivedDisk.notes[0].bounds)
      const resource = await restored.evaluate('document.querySelector("#editor .attachment").dataset.path')
      const attachmentText = await mainCdp.evaluate("(() => { const req = typeof require === 'function' ? require : process.getBuiltinModule('module').createRequire(process.cwd() + '/'); return req('fs').readFileSync(req('./lib/note-exchange').attachmentFile(" + JSON.stringify(userData) + ', ' + JSON.stringify(resource) + "), 'utf8') })()")
      assert.equal(attachmentText, '归档附件内容')
      steps.push('配对数据跨进程启动、归档隐藏、恢复后图片/任务/Mermaid/位置保持')
    } finally { restored.close() }
  }, null, state => {
    state.notes = archivedDisk.notes.concat([{ ...state.notes[0], id: 'restart-control', title: '重启控制便签', html: '<p>SEED-MARK</p>', visible: true }])
    return state
  }))
  for (const result of results) {
    console.log((result.ok ? 'PASS ' : 'FAIL ') + result.name)
    for (const step of result.steps) console.log('  ' + step)
    if (!result.ok) console.log(result.error + '\n' + result.logTail)
  }
  if (results.some(r => !r.ok)) process.exitCode = 1
}
main().catch(err => { console.error(err); process.exitCode = 1 })
