'use strict'

/** 便签中心：列表 / 过滤 / 显示隐藏 / 置顶 / 删除 */

const api = window.sticky
const grid = document.getElementById('grid')
const emptyEl = document.getElementById('empty')
const searchEl = document.getElementById('search')
const statusEl = document.getElementById('status')
const subtitleEl = document.getElementById('subtitle')

const globalSelectEl = document.getElementById('globalSelect')
async function refreshGlobalSelect () {
  globalSelectEl.checked = await api.globalSelect()
}
globalSelectEl.addEventListener('change', async () => {
  globalSelectEl.disabled = true
  try { globalSelectEl.checked = await api.globalSelect(globalSelectEl.checked) }
  finally { globalSelectEl.disabled = false }
})
window.addEventListener('focus', refreshGlobalSelect)
void refreshGlobalSelect()

let notes = []
let filter = 'all'
let keyword = ''
let matches = new Map()
let searchVersion = 0

async function searchNotes () {
  const version = ++searchVersion
  const result = keyword.trim() ? await api.search(keyword) : []
  if (version !== searchVersion) return
  matches = new Map(result.map(hit => [hit.id, hit.context]))
  render()
}

const ICONS = {
  eye: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.8 10S4.9 4.6 10 4.6 18.2 10 18.2 10 15.1 15.4 10 15.4 1.8 10 1.8 10Z" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.5"/></svg>',
  eyeOff: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l14 14" stroke-linecap="round"/><path d="M8.3 5.2A7.6 7.6 0 0 1 10 5c5.1 0 8.2 5 8.2 5a15 15 0 0 1-3 3.4M5.1 6.6A15.3 15.3 0 0 0 1.8 10S4.9 15 10 15a8 8 0 0 0 2.6-.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pin: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M7.5 3.2h5l-.9 4.2 3 3v1.5H5.4v-1.5l3-3-.9-4.2Z"/><path d="M10 12.4v4.4" stroke-linecap="round"/></svg>',
  center: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="3"/><path d="M10 2.5v2.6M10 14.9v2.6M2.5 10h2.6M14.9 10h2.6" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.6 5.4h12.8M8 5.4V3.8h4v1.6M5.4 5.4l.7 10.2h7.8l.7-10.2M8.4 8.6v4.4M11.6 8.6v4.4"/></svg>'
}

function timeAgo (ts) {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60 * 1000) return '刚刚'
  if (d < 60 * 60 * 1000) return Math.floor(d / 60000) + ' 分钟前'
  if (d < 24 * 60 * 60 * 1000) return Math.floor(d / 3600000) + ' 小时前'
  if (d < 7 * 24 * 60 * 60 * 1000) return Math.floor(d / 86400000) + ' 天前'
  const dt = new Date(ts)
  return `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
}

function isLight (hex) {
  const h = String(hex).replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55
}

function render () {
  const kw = keyword.trim().toLowerCase()
  const list = notes.filter(n => {
    if (filter === 'archived' ? !n.archivedAt : !!n.archivedAt) return false
    if (filter === 'due' && !(n.reminder && n.reminder.at <= Date.now())) return false
    if (filter === 'visible' && !n.visible) return false
    if (filter === 'hidden' && n.visible) return false
    if (!kw) return true
    return matches.has(n.id)
  })

  document.getElementById('cAll').textContent = notes.filter(n => !n.archivedAt).length
  document.getElementById('cArchived').textContent = notes.filter(n => n.archivedAt).length
  document.getElementById('cDue').textContent = notes.filter(n => !n.archivedAt && n.reminder && n.reminder.at <= Date.now()).length
  document.getElementById('cVisible').textContent = notes.filter(n => n.visible).length
  document.getElementById('cHidden').textContent = notes.filter(n => !n.visible && !n.archivedAt).length
  document.querySelectorAll('.chip').forEach(c => {
    c.dataset.active = c.dataset.filter === filter ? '1' : '0'
  })

  grid.innerHTML = list.map(n => {
    const title = (n.title || '').trim()
    const preview = (kw ? matches.get(n.id) || '' : n.preview || '').trim()
    return `
    <article class="card" data-id="${n.id}" data-hidden="${n.visible ? 0 : 1}">
      <div class="card-stripe" style="background:${n.color}"></div>
      <div class="card-body">
        <div class="card-head">
          <h3>${title ? escapeHtml(title) : '<span class="placeholder">未命名便签</span>'}</h3>
          <span class="badge ${n.visible ? 'on' : ''}">${n.visible ? '桌面显示' : '已隐藏'}</span>
          ${n.reminder ? '<span class="badge">' + (n.reminder.at <= Date.now() ? '已到期 ' : '提醒 ') + new Date(n.reminder.at).toLocaleString() + '</span>' : ''}
          ${n.alwaysOnTop ? '<span class="badge pin">置顶</span>' : ''}
        </div>
        <p class="preview ${preview ? '' : 'empty'}">${preview ? escapeHtml(preview) : '（空白便签）'}</p>
        <div class="card-foot">
          <span class="time">${timeAgo(n.updatedAt)}</span>
          <div class="acts">
            <button data-a="archive">${n.archivedAt ? '恢复' : '归档'}</button>
            ${!n.archivedAt ? '<button data-a="reminder">提醒</button>' : ''}
            <button data-a="toggle" ${n.archivedAt ? 'disabled' : ''} title="${n.visible ? '隐藏' : '显示到桌面'}">${n.visible ? ICONS.eyeOff : ICONS.eye}</button>
            <button data-a="pin" ${n.archivedAt ? 'disabled' : ''} data-on="${n.alwaysOnTop ? 1 : 0}" title="置顶开关">${ICONS.pin}</button>
            <button data-a="center" ${n.archivedAt ? 'disabled' : ''} title="移到屏幕中央">${ICONS.center}</button>
            <button data-a="delete" data-danger="1" title="删除">${ICONS.trash}</button>
          </div>
        </div>
      </div>
    </article>`
  }).join('')

  emptyEl.hidden = list.length > 0
  emptyEl.querySelector('h2').textContent = notes.length === 0 ? '还没有便签' : '没有匹配的便签'
  emptyEl.querySelector('p').textContent = notes.length === 0
    ? '点击右上角「新建便签」，开始记录第一条想法'
    : '换个关键词，或切换上方的筛选项试试'

  statusEl.textContent = `共 ${notes.length} 张便签 · 桌面显示 ${notes.filter(n => n.visible).length} 张 · 隐藏 ${notes.filter(n => !n.visible).length} 张`
}

const escapeHtml = (window.StickyUtils && window.StickyUtils.escapeHtml) ||
  (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

async function reload () {
  notes = await api.list()
  await searchNotes()
}

// ---------------- 事件 ----------------
grid.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-a]')
  if (!btn) return
  const card = btn.closest('.card')
  const id = card.dataset.id
  const act = btn.dataset.a
  if (act === 'archive') {
    const result = await api.action(id, notes.find(n => n.id === id).archivedAt ? 'restore' : 'archive')
    if (result && result.error) window.alert(result.error)
  }
  if (act === 'reminder') openReminder(id)
  if (act === 'toggle') {
    const note = notes.find(n => n.id === id)
    await api.action(id, note && note.visible ? 'hide' : 'show')
  }
  if (act === 'pin') await api.action(id, 'pin')
  if (act === 'center') {
    await api.action(id, 'show')
    await api.action(id, 'center')
  }
  if (act === 'delete') {
    if (!window.confirm('删除后无法恢复，确定删除这张便签？')) return
    await api.action(id, 'delete')
  }
  await reload()
})

grid.addEventListener('dblclick', async (e) => {
  const card = e.target.closest('.card')
  if (!card || notes.find(n => n.id === card.dataset.id)?.archivedAt) return
  await api.action(card.dataset.id, 'show')
  await api.action(card.dataset.id, 'center')
  await reload()
})

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    filter = chip.dataset.filter
    render()
  })
})

searchEl.addEventListener('input', () => {
  keyword = searchEl.value
  void searchNotes()
})

document.getElementById('newNote').addEventListener('click', async () => {
  await api.createFromCenter({})
  await reload()
})

document.getElementById('showAll').addEventListener('click', async () => {
  await api.showAll()
  await reload()
})
document.getElementById('hideAll').addEventListener('click', async () => {
  await api.hideAll()
  await reload()
})
document.getElementById('openDir').addEventListener('click', () => api.openDataDir())

api.onNotesChanged((list) => {
  notes = list
  void searchNotes()
  updateSubtitle()
})

function updateSubtitle () {
  subtitleEl.textContent = notes.length
    ? '全部便签集中管理，隐藏的便签内容依旧保存在本地'
    : '还没有便签，先新建一张吧'
}

reload().then(updateSubtitle)

// ---------------------------------------------------------------- AI 供应商配置
const aiModal = document.getElementById('aiModal')
const aiProvidersEl = document.getElementById('aiProviders')
const aiEmptyEl = document.getElementById('aiEmpty')
const aiNameEl = document.getElementById('aiName')
const aiBaseEl = document.getElementById('aiBase')
const aiKeyEl = document.getElementById('aiKey')
const aiKeyTipEl = document.getElementById('aiKeyTip')
const aiKeyEyeEl = document.getElementById('aiKeyEye')
const aiModelEl = document.getElementById('aiModel')
const aiManualEl = document.getElementById('aiModelManual')
const aiStatusEl = document.getElementById('aiModelStatus')
const aiFetchBtn = document.getElementById('aiFetch')
const aiActiveEl = document.getElementById('aiActive')
const aiDeleteBtn = document.getElementById('aiDelete')

let aiCfg = { activeId: '', providers: [] }
let editingId = null            // null = 正在新建
let modelList = []
let aiFetchTimer = 0
let aiFetchSeq = 0

function setModelStatus (msg, tone) {
  aiStatusEl.textContent = msg
  if (tone) aiStatusEl.dataset.tone = tone
  else delete aiStatusEl.dataset.tone
}

function setKeyTip (hint) {
  if (!hint) { aiKeyTipEl.hidden = true; aiKeyTipEl.querySelector('b').textContent = ''; return }
  aiKeyTipEl.hidden = false
  aiKeyTipEl.querySelector('b').textContent = hint
}

function renderProviders () {
  aiEmptyEl.hidden = aiCfg.providers.length > 0
  aiProvidersEl.innerHTML = aiCfg.providers.map(p => `
    <li data-id="${p.id}" data-on="${p.id === editingId ? 1 : 0}" data-active="${p.id === aiCfg.activeId ? 1 : 0}">
      <span class="pdot"></span>
      <span class="pname" title="${escapeHtml(p.baseUrl)}">${escapeHtml(p.name || p.baseUrl)}</span>
    </li>`).join('')
}

function renderModelSelect (current) {
  if (!modelList.length) {
    aiModelEl.hidden = true
    aiManualEl.hidden = false
    aiManualEl.value = current || ''
    return
  }
  aiModelEl.hidden = false
  aiManualEl.hidden = true
  const list = modelList.slice()
  if (current && !list.includes(current)) list.unshift(current)
  aiModelEl.innerHTML = list
    .map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
    .join('')
  aiModelEl.value = current && list.includes(current) ? current : list[0]
}

function currentModelValue () {
  return aiModelEl.hidden ? aiManualEl.value.trim() : aiModelEl.value
}

function newProviderForm () {
  editingId = null
  aiNameEl.value = ''
  aiBaseEl.value = ''
  aiKeyEl.value = ''
  aiKeyEl.type = 'password'
  aiKeyEyeEl.textContent = '显示'
  aiKeyEl.placeholder = 'sk-…'
  setKeyTip(null)
  modelList = []
  renderModelSelect('')
  aiActiveEl.checked = aiCfg.providers.length === 0
  aiDeleteBtn.hidden = true
  setModelStatus('填写 Base URL 与 API Key 后会自动拉取', '')
  renderProviders()
}

function selectProvider (id) {
  const p = aiCfg.providers.find(x => x.id === id)
  if (!p) { newProviderForm(); return }
  editingId = p.id
  aiNameEl.value = p.name || ''
  aiBaseEl.value = p.baseUrl || ''
  aiKeyEl.value = ''
  aiKeyEl.type = 'password'
  aiKeyEyeEl.textContent = '显示'
  aiKeyEl.placeholder = p.hasKey ? '留空则不修改' : 'sk-…'
  setKeyTip(p.hasKey ? p.keyHint : null)
  modelList = Array.isArray(p.models) ? p.models.slice() : []
  renderModelSelect(p.defaultModel)
  aiActiveEl.checked = aiCfg.activeId === p.id
  aiDeleteBtn.hidden = false
  if (modelList.length) setModelStatus(`本地已保存 ${modelList.length} 个模型`, 'ok')
  else setModelStatus('点「重新拉取」获取模型列表，或直接手填模型 ID', '')
  renderProviders()
}

async function loadAiConfig () {
  try {
    aiCfg = await api.aiConfig()
  } catch (_) {
    aiCfg = { activeId: '', providers: [] }
  }
  renderProviders()
  return aiCfg
}

async function fetchModels (auto) {
  const baseUrl = aiBaseEl.value.trim()
  if (!baseUrl) { if (!auto) setModelStatus('请先填写 Base URL', 'err'); return }
  const apiKey = aiKeyEl.value.trim()
  if (!apiKey && !editingId) { if (!auto) setModelStatus('请先填写 API Key', 'err'); return }
  if (!/^https?:\/\/[^/\s]+/i.test(/^https?:\/\//i.test(baseUrl) ? baseUrl : 'https://' + baseUrl)) {
    if (!auto) setModelStatus('Base URL 格式不正确', 'err')
    return
  }

  const seq = ++aiFetchSeq
  aiFetchBtn.disabled = true
  setModelStatus('正在拉取模型列表…', 'busy')
  try {
    const res = await api.aiFetchModels({ id: editingId, baseUrl, apiKey })
    if (seq !== aiFetchSeq) return
    if (res && res.error) { setModelStatus('拉取失败：' + res.error, 'err'); return }
    const list = (res && res.models) || []
    if (!list.length) { setModelStatus('该地址没有返回任何模型', 'err'); return }
    const keep = currentModelValue()
    modelList = list
    renderModelSelect(keep && list.includes(keep) ? keep : list[0])
    setModelStatus(`已获取 ${list.length} 个模型`, 'ok')
  } catch (err) {
    if (seq === aiFetchSeq) setModelStatus('拉取失败：' + ((err && err.message) || err), 'err')
  } finally {
    if (seq === aiFetchSeq) aiFetchBtn.disabled = false
  }
}

function scheduleAutoFetch () {
  clearTimeout(aiFetchTimer)
  const baseUrl = aiBaseEl.value.trim()
  const apiKey = aiKeyEl.value.trim()
  if (!baseUrl || (!apiKey && !editingId)) return
  aiFetchTimer = setTimeout(() => fetchModels(true), 800)
}

async function saveProvider () {
  const baseUrl = aiBaseEl.value.trim()
  if (!baseUrl) { setModelStatus('请填写 Base URL', 'err'); aiBaseEl.focus(); return }
  const defaultModel = currentModelValue()
  if (!defaultModel) { setModelStatus('请先拉取并选择默认模型，或手动填写模型 ID', 'err'); return }

  const payload = {
    id: editingId || undefined,
    name: aiNameEl.value.trim(),
    baseUrl,
    apiKey: aiKeyEl.value.trim(),
    models: modelList.length ? modelList : [defaultModel],
    defaultModel,
    activate: aiActiveEl.checked
  }
  const res = await api.aiSaveProvider(payload)
  if (res && res.error) { setModelStatus(res.error, 'err'); return }

  aiCfg = res.config
  selectProvider(res.id)
  setModelStatus('已保存，划词即可使用', 'ok')
  statusEl.textContent = `AI 供应商「${(aiCfg.providers.find(p => p.id === res.id) || {}).name || ''}」已保存`
}

async function deleteProvider () {
  if (!editingId) return
  const p = aiCfg.providers.find(x => x.id === editingId)
  if (!window.confirm(`删除供应商「${(p && p.name) || ''}」？已保存的 API Key 也会一并移除。`)) return
  const res = await api.aiDeleteProvider(editingId)
  aiCfg = (res && res.config) || { activeId: '', providers: [] }
  editingId = null
  renderProviders()
  if (aiCfg.providers.length) selectProvider(aiCfg.activeId || aiCfg.providers[0].id)
  else newProviderForm()
  statusEl.textContent = '供应商已删除'
}

function openAiModal () {
  aiModal.hidden = false
  newProviderForm()
  loadAiConfig().then(() => {
    if (aiCfg.providers.length) selectProvider(aiCfg.activeId || aiCfg.providers[0].id)
  })
}

function closeAiModal () {
  aiModal.hidden = true
}

document.getElementById('aiConfig').addEventListener('click', openAiModal)
document.getElementById('aiClose').addEventListener('click', closeAiModal)
document.getElementById('aiCancel').addEventListener('click', closeAiModal)
document.getElementById('aiSave').addEventListener('click', saveProvider)
document.getElementById('aiDelete').addEventListener('click', deleteProvider)
document.getElementById('aiAdd').addEventListener('click', newProviderForm)
aiFetchBtn.addEventListener('click', () => fetchModels(false))

aiProvidersEl.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]')
  if (li) selectProvider(li.dataset.id)
})

aiKeyEyeEl.addEventListener('click', () => {
  const show = aiKeyEl.type === 'password'
  aiKeyEl.type = show ? 'text' : 'password'
  aiKeyEyeEl.textContent = show ? '隐藏' : '显示'
})

aiBaseEl.addEventListener('input', scheduleAutoFetch)
aiKeyEl.addEventListener('input', scheduleAutoFetch)
aiBaseEl.addEventListener('blur', () => { if (!modelList.length) scheduleAutoFetch() })
aiKeyEl.addEventListener('blur', () => { if (!modelList.length) scheduleAutoFetch() })

aiModal.addEventListener('mousedown', (e) => {
  if (e.target === aiModal) closeAiModal()
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !aiModal.hidden) closeAiModal()
})

// ---------------------------------------------------------------- 格式转换设置

/**
 * 资源管理器右键菜单入口（经典注册表动词）的开关。
 *
 * 为什么单独一个弹窗而不是塞进「AI 供应商」那类弹窗：
 * 这是**系统级**改动（写 HKCU 注册表），得让用户明确看到自己在改什么。
 */
const convertModal = document.getElementById('convertModal')
const verbToggle = document.getElementById('verbToggle')
const verbStatusEl = document.getElementById('verbStatus')
const verbHintEl = document.getElementById('verbHint')
const verbUninstallBtn = document.getElementById('verbUninstall')
const engineListEl = document.getElementById('engineList')
const pluginDirEl = document.getElementById('pluginDir')

/** 当前注册表里的真实状态（主进程回读） */
let verbInstalled = false

/**
 * 刷新状态显示。
 * @param {{installed:boolean}} st 主进程回读的状态
 */
function renderVerbStatus (st) {
  verbInstalled = !!(st && st.installed)
  verbToggle.checked = verbInstalled
  verbUninstallBtn.hidden = !verbInstalled
  if (verbInstalled) {
    verbStatusEl.textContent = '已启用：右键文件 → 显示更多选项 → 「用桌面便签转换…」'
    verbStatusEl.className = 'conv-note ok'
  } else {
    verbStatusEl.textContent = '未启用。勾选上面的开关即可添加。'
    verbStatusEl.className = 'conv-note'
  }
  // 提示只在「用户看过一眼之后」才显示：首次进来直接糊一脸说明反而吓人
  verbHintEl.hidden = false
}

/**
 * 渲染引擎清单。
 *
 * 目的是**透明化**：用户发现"没有 PDF"这类缺口时，
 * 能一眼看出是"引擎没装"还是"这个格式本来就不支持"，
 * 而不是怀疑应用坏了。
 *
 * @param {Array<{id:string,name:string,available:boolean}>} list
 */
function renderEngines (list) {
  if (!engineListEl) return
  const arr = Array.isArray(list) ? list : []
  if (!arr.length) {
    engineListEl.textContent = '没有可用的转换引擎。'
    engineListEl.className = 'conv-note err'
    return
  }
  engineListEl.innerHTML = ''
  engineListEl.className = 'conv-note'
  for (const e of arr) {
    const row = document.createElement('div')
    row.className = 'engine-item'

    const dot = document.createElement('span')
    dot.className = 'engine-dot' + (e.available ? ' on' : '')
    row.appendChild(dot)

    const name = document.createElement('span')
    name.className = 'engine-name'
    name.textContent = e.name || e.id
    row.appendChild(name)

    const state = document.createElement('span')
    state.className = 'engine-state'
    state.textContent = e.available ? '已就绪' : '未启用'
    row.appendChild(state)

    engineListEl.appendChild(row)
  }
}

/** 打开弹窗并回读当前状态 */
function openConvertModal () {
  convertModal.hidden = false
  verbStatusEl.textContent = '正在检查…'
  verbStatusEl.className = 'conv-note'
  api.explorerVerbStatus()
    .then(renderVerbStatus)
    .catch(() => {
      verbStatusEl.textContent = '无法读取状态，请重启应用后再试。'
      verbStatusEl.className = 'conv-note err'
    })
  // 引擎清单独立读取：失败不影响右键开关那部分
  if (engineListEl) {
    engineListEl.textContent = '正在读取…'
    engineListEl.className = 'conv-note'
  }
  if (api.convertEngines) {
    api.convertEngines()
      .then(r => {
        // 插件目录路径：告诉用户放哪，"可插拔"才不是开发者内部的秘密
        if (r && r.pluginDir && pluginDirEl) {
          pluginDirEl.textContent = r.pluginDir
        }
        if (!r || !r.ok) {
          renderEngines([])
          return
        }
        renderEngines(r.engines || [])
      })
      .catch(() => renderEngines([]))
  }
}

function closeConvertModal () {
  convertModal.hidden = true
}

/**
 * 切换右键菜单入口。
 * @param {boolean} want 目标状态
 */
async function setVerbEnabled (want) {
  verbToggle.disabled = true
  const prev = verbInstalled
  try {
    const r = want
      ? await api.explorerVerbInstall()
      : await api.explorerVerbUninstall()
    if (!r || !r.ok) {
      renderVerbStatus({ installed: prev })
      statusEl.textContent = (r && r.error) || '操作失败'
      return
    }
    // 装/卸完都回读一次：写入成功 ≠ 状态正确
    renderVerbStatus(await api.explorerVerbStatus())
    statusEl.textContent = want ? '已添加右键菜单入口' : '已移除右键菜单入口'
  } catch (err) {
    renderVerbStatus({ installed: prev })
    statusEl.textContent = '操作失败：' + (err && err.message ? err.message : String(err))
  } finally {
    verbToggle.disabled = false
  }
}

document.getElementById('convertConfig').addEventListener('click', openConvertModal)
document.getElementById('convertClose').addEventListener('click', closeConvertModal)
document.getElementById('verbCancel').addEventListener('click', closeConvertModal)

verbToggle.addEventListener('change', () => {
  setVerbEnabled(verbToggle.checked)
})

verbUninstallBtn.addEventListener('click', () => {
  verbToggle.checked = false
  setVerbEnabled(false)
})

convertModal.addEventListener('mousedown', (e) => {
  if (e.target === convertModal) closeConvertModal()
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !convertModal.hidden) closeConvertModal()
})

let reminderNoteId
const reminderDialog = document.getElementById('reminderDialog')
function openReminder (id) {
  reminderNoteId = id
  const note = notes.find(n => n.id === id)
  const date = new Date(note.reminder ? note.reminder.at : Date.now() + 3600000)
  document.getElementById('reminderAt').value = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  document.getElementById('reminderError').textContent = ''
  reminderDialog.showModal()
}
document.getElementById('saveReminder').addEventListener('click', async e => {
  e.preventDefault()
  const at = new Date(document.getElementById('reminderAt').value).getTime()
  const result = await api.action(reminderNoteId, 'reminder', at)
  if (!result.ok) { document.getElementById('reminderError').textContent = result.error; return }
  reminderDialog.close()
  await reload()
})
document.getElementById('cancelReminder').addEventListener('click', async () => {
  await api.action(reminderNoteId, 'reminder', null)
  reminderDialog.close()
  await reload()
})
setInterval(() => { if (filter === 'due') render() }, 30000)

document.getElementById('importNotes').addEventListener('click', async () => {
  const result = await api.importNotes()
  if (result.error) window.alert(result.error)
  await reload()
})

const edgeGroupsEl = document.getElementById('edgeGroups')
api.edgeGroups().then(enabled => { edgeGroupsEl.checked = enabled })
edgeGroupsEl.addEventListener('change', async () => { edgeGroupsEl.checked = await api.edgeGroups(edgeGroupsEl.checked) })

document.getElementById('backup').addEventListener('click', async () => {
  const result = await api.backup()
  window.alert(result.ok ? '备份完成：' + result.path : result.error)
})

// ---------------------------------------------------------------- 弹窗外观设置
const appearance = window.StickyPopupAppearance
const popupStyleModal = document.getElementById('popupStyleModal')
const tbDotEl = document.getElementById('tbDot')
const ansDotEl = document.getElementById('ansDot')
const toolbarSwatchesEl = document.getElementById('toolbarSwatches')
const answerSwatchesEl = document.getElementById('answerSwatches')
const toolbarColorEl = document.getElementById('toolbarColor')
const toolbarHexEl = document.getElementById('toolbarHex')
const toolbarOpacityEl = document.getElementById('toolbarOpacity')
const toolbarOpacityValEl = document.getElementById('toolbarOpacityVal')
const answerColorEl = document.getElementById('answerColor')
const answerHexEl = document.getElementById('answerHex')
const answerOpacityEl = document.getElementById('answerOpacity')
const answerOpacityValEl = document.getElementById('answerOpacityVal')

let popupCfg = appearance
  ? appearance.normalizePopupAppearance()
  : { toolbar: { color: '#23272f', opacity: 1 }, answer: { color: '#1e222a', opacity: 1 } }
let popupSaveSeq = 0

function initPopupSwatches (container, kind) {
  if (!container || !appearance) return
  container.innerHTML = appearance.PRESET_COLORS.map((hex) =>
    `<button type="button" class="style-swatch" data-kind="${kind}" data-color="${hex}" title="${hex}" style="background:${hex}"></button>`
  ).join('')
}

function syncSwatchSelection (container, activeHex) {
  if (!container) return
  const norm = String(activeHex || '').toLowerCase()
  for (const btn of container.querySelectorAll('.style-swatch')) {
    btn.dataset.on = String(btn.dataset.color || '').toLowerCase() === norm ? '1' : '0'
  }
}

function syncPopupUI (cfg) {
  popupCfg = appearance ? appearance.normalizePopupAppearance(cfg, popupCfg) : cfg
  if (appearance) appearance.applyPopupAppearance(document, popupCfg)

  const tbPct = Math.round(popupCfg.toolbar.opacity * 100)
  const ansPct = Math.round(popupCfg.answer.opacity * 100)
  if (tbDotEl && appearance) tbDotEl.style.background = appearance.rgbaString(popupCfg.toolbar.color, popupCfg.toolbar.opacity)
  if (ansDotEl && appearance) ansDotEl.style.background = appearance.rgbaString(popupCfg.answer.color, popupCfg.answer.opacity)

  if (toolbarColorEl) toolbarColorEl.value = popupCfg.toolbar.color
  if (toolbarHexEl) toolbarHexEl.textContent = popupCfg.toolbar.color
  if (toolbarOpacityEl) toolbarOpacityEl.value = String(tbPct)
  if (toolbarOpacityValEl) toolbarOpacityValEl.textContent = tbPct + '%'

  if (answerColorEl) answerColorEl.value = popupCfg.answer.color
  if (answerHexEl) answerHexEl.textContent = popupCfg.answer.color
  if (answerOpacityEl) answerOpacityEl.value = String(ansPct)
  if (answerOpacityValEl) answerOpacityValEl.textContent = ansPct + '%'

  syncSwatchSelection(toolbarSwatchesEl, popupCfg.toolbar.color)
  syncSwatchSelection(answerSwatchesEl, popupCfg.answer.color)
}

async function commitPopupPatch (patch) {
  const seq = ++popupSaveSeq
  if (appearance) syncPopupUI(appearance.normalizePopupAppearance(patch, popupCfg))
  if (typeof api.popupAppearance !== 'function') return
  const saved = await api.popupAppearance(patch)
  if (seq === popupSaveSeq && saved) syncPopupUI(saved)
}

function openPopupStyleModal () {
  popupStyleModal.hidden = false
  if (typeof api.popupAppearance === 'function') {
    api.popupAppearance().then((cfg) => { if (cfg) syncPopupUI(cfg) }).catch(() => {})
  }
}

function closePopupStyleModal () {
  popupStyleModal.hidden = true
}

initPopupSwatches(toolbarSwatchesEl, 'toolbar')
initPopupSwatches(answerSwatchesEl, 'answer')

if (typeof api.popupAppearance === 'function') {
  api.popupAppearance().then((cfg) => { if (cfg) syncPopupUI(cfg) }).catch(() => {})
} else {
  syncPopupUI(popupCfg)
}
if (typeof api.onPopupAppearanceChanged === 'function') {
  api.onPopupAppearanceChanged((cfg) => { if (cfg) syncPopupUI(cfg) })
}

document.getElementById('popupStyleBtn').addEventListener('click', openPopupStyleModal)
document.getElementById('popupStyleClose').addEventListener('click', closePopupStyleModal)
document.getElementById('popupStyleDone').addEventListener('click', closePopupStyleModal)

popupStyleModal.addEventListener('mousedown', (e) => {
  if (e.target === popupStyleModal) closePopupStyleModal()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !popupStyleModal.hidden) closePopupStyleModal()
})

popupStyleModal.addEventListener('click', (e) => {
  const sw = e.target.closest('.style-swatch')
  if (!sw) return
  const kind = sw.dataset.kind
  const color = sw.dataset.color
  if ((kind === 'toolbar' || kind === 'answer') && color) {
    void commitPopupPatch({ [kind]: { color } })
  }
})

toolbarColorEl.addEventListener('input', (e) => {
  void commitPopupPatch({ toolbar: { color: e.target.value } })
})
toolbarOpacityEl.addEventListener('input', (e) => {
  void commitPopupPatch({ toolbar: { opacity: Number(e.target.value) / 100 } })
})
answerColorEl.addEventListener('input', (e) => {
  void commitPopupPatch({ answer: { color: e.target.value } })
})
answerOpacityEl.addEventListener('input', (e) => {
  void commitPopupPatch({ answer: { opacity: Number(e.target.value) / 100 } })
})

document.getElementById('popupSyncAnswer').addEventListener('click', () => {
  void commitPopupPatch({ answer: { color: popupCfg.toolbar.color, opacity: popupCfg.toolbar.opacity } })
})
document.getElementById('popupResetStyle').addEventListener('click', () => {
  const def = appearance
    ? appearance.DEFAULT_POPUP_APPEARANCE
    : { toolbar: { color: '#23272f', opacity: 1 }, answer: { color: '#1e222a', opacity: 1 } }
  void commitPopupPatch(def)
  statusEl.textContent = '弹窗外观已恢复默认'
})

// ---------------- 学术文献 PDF 翻译弹层 ----------------
const pdfTranslateModal = document.getElementById('pdfTranslateModal')
const pdfTransEnvDot = document.getElementById('pdfTransEnvDot')
const pdfTransEnvStatus = document.getElementById('pdfTransEnvStatus')
const pdfTransInstallBtn = document.getElementById('pdfTransInstallBtn')
const pdfTransCancelInstallBtn = document.getElementById('pdfTransCancelInstallBtn')
const pdfTransRefreshEnvBtn = document.getElementById('pdfTransRefreshEnv')
const pdfTransUseMirrorEl = document.getElementById('pdfTransUseMirror')
const pdfTransUvHint = document.getElementById('pdfTransUvHint')
const pdfTransInstallGuide = document.getElementById('pdfTransInstallGuide')
const pdfTransInstallLogWrap = document.getElementById('pdfTransInstallLogWrap')
const pdfTransInstallMsg = document.getElementById('pdfTransInstallMsg')
const pdfTransInstallLog = document.getElementById('pdfTransInstallLog')
const pdfTransAiBadge = document.getElementById('pdfTransAiBadge')
const pdfTransDrop = document.getElementById('pdfTransDrop')
const pdfTransFileLabel = document.getElementById('pdfTransFileLabel')
const pdfTransFilePath = document.getElementById('pdfTransFilePath')
const pdfTransBackendEl = document.getElementById('pdfTransBackend')
const pdfTransServiceEl = document.getElementById('pdfTransService')
const pdfTransCliWrap = document.getElementById('pdfTransCliWrap')
const pdfTransCliPathEl = document.getElementById('pdfTransCliPath')
const pdfTransServerWrap = document.getElementById('pdfTransServerWrap')
const pdfTransServerUrlEl = document.getElementById('pdfTransServerUrl')
const pdfTransLangInEl = document.getElementById('pdfTransLangIn')
const pdfTransLangOutEl = document.getElementById('pdfTransLangOut')
const pdfTransModeEl = document.getElementById('pdfTransMode')
const pdfTransPagesEl = document.getElementById('pdfTransPages')
const pdfTransThreadsEl = document.getElementById('pdfTransThreads')
const pdfTransIgnoreCacheEl = document.getElementById('pdfTransIgnoreCache')
const pdfTransSkipTermEl = document.getElementById('pdfTransSkipTerm')
const pdfTransProgressWrap = document.getElementById('pdfTransProgressWrap')
const pdfTransStatusMsg = document.getElementById('pdfTransStatusMsg')
const pdfTransPct = document.getElementById('pdfTransPct')
const pdfTransBar = document.getElementById('pdfTransBar')
const pdfTransProxyLiveEl = document.getElementById('pdfTransProxyLive')
const pdfTransLogEl = document.getElementById('pdfTransLog')
const pdfTransOutputs = document.getElementById('pdfTransOutputs')
const pdfTransOutputList = document.getElementById('pdfTransOutputList')
const pdfTransStartBtn = document.getElementById('pdfTransStartBtn')
const pdfTransCancelBtn = document.getElementById('pdfTransCancelBtn')

let selectedPdfPath = ''
let activeTranslateJobId = ''
let pdfTranslateRunning = false
let lastTranslatedPath = ''
let pdfInstallRunning = false
let activeInstallId = ''
let installLogLines = []
let transLogLines = []
let uvAvailable = false

function syncTranslateBackendFields () {
  const isServer = pdfTransBackendEl.value === 'server'
  pdfTransCliWrap.hidden = isServer
  pdfTransServerWrap.hidden = !isServer
}

function readTranslateFormPatch () {
  return {
    backend: pdfTransBackendEl.value,
    service: pdfTransServiceEl.value,
    cliPath: pdfTransCliPathEl.value.trim(),
    serverUrl: pdfTransServerUrlEl.value.trim(),
    langIn: pdfTransLangInEl.value,
    langOut: pdfTransLangOutEl.value,
    mode: pdfTransModeEl.value,
    pageRange: pdfTransPagesEl.value.trim(),
    threads: Math.max(1, Math.min(16, Number(pdfTransThreadsEl.value) || 4)),
    ignoreCache: !!pdfTransIgnoreCacheEl.checked,
    skipTermExtraction: pdfTransSkipTermEl ? !!pdfTransSkipTermEl.checked : true
  }
}

function applyTranslateStatus (info) {
  if (!info) return
  const cfg = info.config || {}
  if (!pdfTranslateRunning) {
    if (cfg.backend) pdfTransBackendEl.value = cfg.backend
    if (cfg.service) pdfTransServiceEl.value = cfg.service
    pdfTransCliPathEl.value = cfg.cliPath || ''
    pdfTransServerUrlEl.value = cfg.serverUrl || 'http://127.0.0.1:8888'
    if (cfg.langIn) pdfTransLangInEl.value = cfg.langIn
    if (cfg.langOut) pdfTransLangOutEl.value = cfg.langOut
    if (cfg.mode) pdfTransModeEl.value = cfg.mode
    pdfTransPagesEl.value = cfg.pageRange || ''
    pdfTransThreadsEl.value = String(cfg.threads || 4)
    pdfTransIgnoreCacheEl.checked = !!cfg.ignoreCache
    if (pdfTransSkipTermEl) pdfTransSkipTermEl.checked = cfg.skipTermExtraction !== false
    syncTranslateBackendFields()
  }

  const cliReady = !!(info.cli && info.cli.found)
  const uvReady = !!(info.uv && info.uv.found)
  const serverReady = !!(info.server && info.server.reachable)
  uvAvailable = uvReady

  pdfTransEnvDot.classList.toggle('on', cliReady || serverReady)
  if (cliReady && serverReady) {
    pdfTransEnvStatus.textContent = `已就绪：${info.cli.version || info.cli.kind}（${info.cli.path}）· 本地服务在线`
  } else if (cliReady) {
    pdfTransEnvStatus.textContent = `已就绪：${info.cli.version || info.cli.kind}（${info.cli.path}）`
  } else if (serverReady) {
    pdfTransEnvStatus.textContent = `zotero-pdf2zh 本地服务在线（${info.server.url}）`
  } else {
    pdfTransEnvStatus.textContent = '未检测到本地 pdf2zh_next / pdf2zh，且 zotero-pdf2zh 服务未运行'
  }

  if (pdfTransInstallBtn) {
    pdfTransInstallBtn.textContent = cliReady ? '更新环境' : '一键安装环境'
    pdfTransInstallBtn.hidden = pdfInstallRunning
    pdfTransInstallBtn.disabled = !uvReady || pdfInstallRunning || pdfTranslateRunning
    pdfTransInstallBtn.title = uvReady ? '调用本机 uv 安装或更新 pdf2zh-next' : '请先安装 uv'
  }
  if (uvReady) {
    if (pdfTransUvHint) pdfTransUvHint.textContent = `已检测到 ${info.uv.version || 'uv'}，可一键自动安装/更新 pdf2zh-next`
    pdfTransInstallGuide.hidden = true
  } else {
    if (pdfTransUvHint) pdfTransUvHint.textContent = '未检测到 uv，需先安装 uv'
    pdfTransInstallGuide.hidden = false
  }

  if (info.activeAi && info.activeAi.configured) {
    pdfTransAiBadge.className = 'conv-note ok'
    pdfTransAiBadge.textContent = `当前活跃 AI：${info.activeAi.providerName || '已配置'}（${info.activeAi.model || '默认模型'}）— 密钥经本地一次性代理转发，绝不写入 CLI 参数或磁盘`
  } else {
    pdfTransAiBadge.className = 'conv-note dim'
    pdfTransAiBadge.textContent = '尚未配置活跃 AI 模型；请先在「AI 供应商」配置，或改用 Bing / Google 翻译'
  }
}

function setSelectedPdfFile (filePath) {
  selectedPdfPath = String(filePath || '').trim()
  if (selectedPdfPath) {
    const parts = selectedPdfPath.split(/[\\/]/)
    pdfTransFileLabel.textContent = parts[parts.length - 1] || selectedPdfPath
    pdfTransFilePath.textContent = selectedPdfPath
  } else {
    pdfTransFileLabel.textContent = '请选择或拖入学术 PDF 文件'
    pdfTransFilePath.textContent = '默认输出双语对照 PDF，保存至原文件同目录'
  }
}

function setTranslateRunningUi (running) {
  pdfTranslateRunning = running
  pdfTransStartBtn.hidden = running
  pdfTransStartBtn.disabled = running || pdfInstallRunning
  pdfTransCancelBtn.hidden = !running
  pdfTransCancelBtn.disabled = !running
  if (pdfTransInstallBtn) pdfTransInstallBtn.disabled = running || pdfInstallRunning || !uvAvailable
  if (running) pdfTransProgressWrap.hidden = false
}

function setInstallRunningUi (running) {
  pdfInstallRunning = running
  if (pdfTransInstallBtn) {
    pdfTransInstallBtn.hidden = running
    pdfTransInstallBtn.disabled = running || pdfTranslateRunning || !uvAvailable
  }
  if (pdfTransCancelInstallBtn) {
    pdfTransCancelInstallBtn.hidden = !running
    pdfTransCancelInstallBtn.disabled = !running
  }
  if (pdfTransRefreshEnvBtn) pdfTransRefreshEnvBtn.disabled = running
  pdfTransStartBtn.disabled = running || pdfTranslateRunning
  if (running) pdfTransInstallLogWrap.hidden = false
}

async function refreshPdfTranslateStatus () {
  if (typeof api.pdfTranslateStatus !== 'function') return
  pdfTransEnvStatus.textContent = '正在检测翻译引擎环境…'
  try {
    const info = await api.pdfTranslateStatus()
    applyTranslateStatus(info)
  } catch (err) {
    pdfTransEnvStatus.textContent = `检测失败：${err && err.message ? err.message : err}`
  }
}

function openPdfTranslateModal () {
  pdfTranslateModal.hidden = false
  void refreshPdfTranslateStatus()
}

function closePdfTranslateModal () {
  pdfTranslateModal.hidden = true
}

document.getElementById('pdfTranslateBtn').addEventListener('click', openPdfTranslateModal)
document.getElementById('pdfTransClose').addEventListener('click', closePdfTranslateModal)
document.getElementById('pdfTransRefreshEnv').addEventListener('click', () => {
  void refreshPdfTranslateStatus()
})
pdfTransBackendEl.addEventListener('change', syncTranslateBackendFields)

pdfTranslateModal.addEventListener('mousedown', (e) => {
  if (e.target === pdfTranslateModal) closePdfTranslateModal()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pdfTranslateModal.hidden) closePdfTranslateModal()
})

document.getElementById('pdfTransCopyInstall').addEventListener('click', () => {
  const cmd = 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(cmd).then(() => {
      statusEl.textContent = '已复制 uv 安装命令到剪贴板'
    }).catch(() => {})
  }
})

pdfTransInstallBtn.addEventListener('click', async () => {
  if (pdfInstallRunning || pdfTranslateRunning || typeof api.pdfTranslateInstallEnv !== 'function') return
  installLogLines = []
  activeInstallId = ''
  pdfTransInstallLog.textContent = ''
  pdfTransInstallMsg.textContent = '正在准备调用 uv 安装/更新 pdf2zh-next…'
  setInstallRunningUi(true)

  try {
    const res = await api.pdfTranslateInstallEnv({
      upgrade: true,
      useMirror: !!(pdfTransUseMirrorEl && pdfTransUseMirrorEl.checked)
    })
    if (res && res.env) applyTranslateStatus(res.env)
    if (res && res.ok) {
      pdfTransInstallMsg.textContent = 'pdf2zh_next 安装/更新完成，已自动就绪'
      statusEl.textContent = 'pdf2zh_next 翻译环境已就绪'
    } else {
      pdfTransInstallMsg.textContent = (res && res.error) ? res.error : '环境安装/更新未完成'
    }
  } catch (err) {
    pdfTransInstallMsg.textContent = `安装失败：${err && err.message ? err.message : err}`
  } finally {
    setInstallRunningUi(false)
    activeInstallId = ''
  }
})

pdfTransCancelInstallBtn.addEventListener('click', async () => {
  if (typeof api.pdfTranslateCancelInstall !== 'function') return
  pdfTransCancelInstallBtn.disabled = true
  pdfTransInstallMsg.textContent = '正在停止环境安装/更新…'
  await api.pdfTranslateCancelInstall(activeInstallId || undefined)
})

document.getElementById('pdfTransPickBtn').addEventListener('click', async () => {
  if (typeof api.pdfTranslatePickPdf !== 'function') return
  const res = await api.pdfTranslatePickPdf()
  if (res && !res.canceled && res.filePath) {
    setSelectedPdfFile(res.filePath)
    pdfTransOutputs.hidden = true
  }
})

pdfTransDrop.addEventListener('dragover', (e) => {
  e.preventDefault()
  pdfTransDrop.dataset.over = '1'
})
pdfTransDrop.addEventListener('dragleave', () => {
  pdfTransDrop.dataset.over = '0'
})
pdfTransDrop.addEventListener('drop', (e) => {
  e.preventDefault()
  pdfTransDrop.dataset.over = '0'
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
  const filePath = file && typeof api.getPathForFile === 'function' ? api.getPathForFile(file) : ''
  if (filePath && /\.pdf$/i.test(filePath)) {
    setSelectedPdfFile(filePath)
    pdfTransOutputs.hidden = true
  } else {
    pdfTransProgressWrap.hidden = false
    pdfTransStatusMsg.textContent = '请拖入 .pdf 格式文件'
  }
})

document.getElementById('pdfTransSaveCfg').addEventListener('click', async () => {
  if (typeof api.pdfTranslateSaveConfig !== 'function') return
  const patch = readTranslateFormPatch()
  const res = await api.pdfTranslateSaveConfig(patch)
  if (res && res.ok) {
    statusEl.textContent = '文献翻译默认设置已保存'
    void refreshPdfTranslateStatus()
  }
})

document.getElementById('pdfTransOpenDirBtn').addEventListener('click', () => {
  const target = lastTranslatedPath || selectedPdfPath
  if (target && typeof api.pdfTranslateOpenFolder === 'function') {
    void api.pdfTranslateOpenFolder(target)
  }
})

pdfTransCancelBtn.addEventListener('click', async () => {
  if (typeof api.pdfTranslateCancel !== 'function') return
  pdfTransCancelBtn.disabled = true
  pdfTransStatusMsg.textContent = '正在中止翻译任务…'
  await api.pdfTranslateCancel(activeTranslateJobId || undefined)
})

pdfTransStartBtn.addEventListener('click', async () => {
  if (pdfTranslateRunning || typeof api.pdfTranslateRun !== 'function') return
  if (!selectedPdfPath) {
    const picked = typeof api.pdfTranslatePickPdf === 'function' ? await api.pdfTranslatePickPdf() : null
    if (!picked || picked.canceled || !picked.filePath) return
    setSelectedPdfFile(picked.filePath)
  }

  const patch = readTranslateFormPatch()
  if (typeof api.pdfTranslateSaveConfig === 'function') {
    await api.pdfTranslateSaveConfig(patch).catch(() => {})
  }

  activeTranslateJobId = ''
  lastTranslatedPath = ''
  transLogLines = []
  pdfTransOutputs.hidden = true
  pdfTransOutputList.innerHTML = ''
  pdfTransBar.style.width = '5%'
  pdfTransPct.textContent = '5%'
  pdfTransStatusMsg.textContent = '正在启动本地一次性 Token 代理与翻译引擎…'
  if (pdfTransProxyLiveEl) {
    pdfTransProxyLiveEl.hidden = true
    pdfTransProxyLiveEl.className = 'pdf-proxy-live'
    pdfTransProxyLiveEl.textContent = ''
  }
  if (pdfTransLogEl) {
    pdfTransLogEl.hidden = true
    pdfTransLogEl.textContent = ''
  }
  setTranslateRunningUi(true)

  try {
    const res = await api.pdfTranslateRun(Object.assign({ filePath: selectedPdfPath }, patch))
    if (res && res.ok) {
      pdfTransBar.style.width = '100%'
      pdfTransPct.textContent = '100%'
      pdfTransStatusMsg.textContent = '翻译完成，已输出至原 PDF 同目录'
      const outs = Array.isArray(res.outputs) ? res.outputs : []
      if (outs.length > 0) {
        lastTranslatedPath = outs[0].path
        pdfTransOutputList.innerHTML = outs.map(o => `<div>已生成：<b>${escapeHtml(o.name)}</b></div>`).join('')
        pdfTransOutputs.hidden = false
      }
      statusEl.textContent = '学术文献 PDF 翻译完成'
    } else {
      pdfTransStatusMsg.textContent = (res && res.error) ? res.error : '翻译未完成'
    }
  } catch (err) {
    pdfTransStatusMsg.textContent = `翻译失败：${err && err.message ? err.message : err}`
  } finally {
    setTranslateRunningUi(false)
    activeTranslateJobId = ''
  }
})

if (typeof api.onPdfTranslateProgress === 'function') {
  api.onPdfTranslateProgress((ev) => {
    if (!ev) return
    if (ev.jobId && !activeTranslateJobId && pdfTranslateRunning) activeTranslateJobId = ev.jobId
    pdfTransProgressWrap.hidden = false
    if (typeof ev.percent === 'number') {
      const pct = Math.max(0, Math.min(100, Math.round(ev.percent)))
      pdfTransBar.style.width = `${pct}%`
      pdfTransPct.textContent = `${pct}%`
    }
    if (ev.message) pdfTransStatusMsg.textContent = ev.message
    if (pdfTransProxyLiveEl) {
      const p = ev.proxyLive
      const counterText = p && (p.inFlight > 0 || p.completed > 0 || p.retries > 0)
        ? `模型请求：进行中 ${p.inFlight} · 已完成 ${p.completed} · 重试 ${p.retries}`
        : ''
      if (ev.warning) {
        pdfTransProxyLiveEl.hidden = false
        pdfTransProxyLiveEl.className = 'pdf-proxy-live warn'
        pdfTransProxyLiveEl.textContent = counterText ? `${ev.warning}（${counterText}）` : ev.warning
      } else if (counterText) {
        pdfTransProxyLiveEl.hidden = false
        pdfTransProxyLiveEl.className = 'pdf-proxy-live'
        pdfTransProxyLiveEl.textContent = counterText
      }
    }
    if (pdfTransLogEl && ev.logLine) {
      if (transLogLines[transLogLines.length - 1] !== ev.logLine) {
        transLogLines.push(ev.logLine)
        if (transLogLines.length > 60) transLogLines.shift()
        pdfTransLogEl.hidden = false
        pdfTransLogEl.textContent = transLogLines.join('\n')
        pdfTransLogEl.scrollTop = pdfTransLogEl.scrollHeight
      }
    }
    if (ev.status === 'done' && Array.isArray(ev.outputs) && ev.outputs.length > 0) {
      lastTranslatedPath = ev.outputs[0].path
      pdfTransOutputList.innerHTML = ev.outputs.map(o => `<div>已生成：<b>${escapeHtml(o.name)}</b></div>`).join('')
      pdfTransOutputs.hidden = false
    }
  })
}

if (typeof api.onPdfTranslateInstallProgress === 'function') {
  api.onPdfTranslateInstallProgress((ev) => {
    if (!ev) return
    if (ev.installId && !activeInstallId && pdfInstallRunning) activeInstallId = ev.installId
    pdfTransInstallLogWrap.hidden = false
    if (ev.message) {
      pdfTransInstallMsg.textContent = ev.message
      installLogLines.push(ev.message)
      if (installLogLines.length > 80) installLogLines.shift()
      pdfTransInstallLog.textContent = installLogLines.join('\n')
      pdfTransInstallLog.scrollTop = pdfTransInstallLog.scrollHeight
    }
  })
}
