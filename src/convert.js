'use strict'

/**
 * 格式选择弹窗。
 *
 * 交互：从资源管理器右键进来的文件 → 列出该类型能转的目标格式 → 选一个 → 转 → 保存到源文件目录。
 *
 * 能力来源：`filee formats <ext> --json` 的 targets（零引擎即可）与 withEngines（需装引擎）。
 * withEngines 里的格式**置灰但可点**：点了会提示去 Filee 的 Settings → Engines 装，
 * 而不是静默失败（这是「点了没反应」最容易发生的地方）。
 */

const els = {
  subtitle: document.getElementById('subtitle'),
  files: document.getElementById('files'),
  available: document.getElementById('available'),
  needsEngine: document.getElementById('needs-engine'),
  availableTitle: document.getElementById('available-title'),
  engineTitle: document.getElementById('engine-title'),
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  allPages: document.getElementById('allPages'),
  progress: document.getElementById('progress'),
  progressFill: document.getElementById('progressFill'),
  progressPct: document.getElementById('progressPct'),
  pdfTranslateSection: document.getElementById('pdfTranslateSection'),
  pdfTransEnvSub: document.getElementById('pdfTransEnvSub'),
  pdfTransDualBtn: document.getElementById('pdfTransDualBtn'),
  pdfTransMonoBtn: document.getElementById('pdfTransMonoBtn'),
  pdfTransBoxCancel: document.getElementById('pdfTransBoxCancel')
}

/**
 * 「转换所有页面」只在 PDF → 图片/txt 时有意义。
 * 图片 → PDF 是把多张图合成一份 PDF，没有"多页源"概念，勾选框必须隐藏。
 */
const ALL_PAGES_TARGETS = ['png', 'jpg', 'jpeg', 'webp', 'txt', 'md']

/** 当前待转换的文件 */
let currentFiles = []

/**
 * 失败提示是否已经显示。
 *
 * ★ 主进程会**先**发 convert:files、**再**发 convert:error。
 *   而 onFiles 里的能力查询是异步的：它 resolve 时会把状态栏清空（setStatus('')），
 *   于是错误提示会被后来的「查询完成」覆盖掉。
 *   用这个标记让失败提示**粘住**，直到用户重新选一次格式。
 */
let stickyError = false

/**
 * 转换进行中闸（防止同一 tick 内双击触发两次 convert:run）。
 *
 * ★ 为什么 DOM 的 pointerEvents='none' 不够：
 *   pointerEvents 只挡"用户再点一次"，但同一 tick 内的两次事件
 *   （例如程序化 click、或双击的两个 click 落在同一帧）仍可能都发出去。
 *   加上这个布尔闸，任何"已经在转"期间的 onPick 直接 return。
 */
let converting = false

/**
 * 当前这次转换的请求 id（**进度事件过滤器**）。
 *
 * ★ 为什么要 reqId：进度事件是**异步**到达的，旧请求的进度可能在新请求之后才到。
 *   UI 只认当前 reqId 的事件 ⇒ 旧事件一律丢弃（不更新任何 DOM）。
 */
let currentReqId = ''

/**
 * **正在飞行中**的那一次转换的请求 id（**UI 闸的所有权**）。
 *
 * ★ 为什么必须与 currentReqId 分成两个：
 *   currentReqId 是"进度事件过滤器"，收到新的一批文件（onFiles）时会被清空
 *   —— 因为旧进度必须丢弃（R-P4-14）。
 *   但**清空 currentReqId 不代表本次请求已经过期**：
 *   主进程在转换失败时会**先**发 convert:files、**再**回 convert:run 的失败回包
 *   （main.js openConvertWindow 先 send files，main-bridge reportError 在返回回包前调用）。
 *   于是失败回包到达时 currentReqId 已经被 onFiles 清成了 ''。
 *   ⇒ 若拿 currentReqId 判断"这个回包是不是过期了"，**失败回包会被当成旧回包丢掉**，
 *     converting 永远停在 true、allPages.disabled 永远停在 true，
 *     用户在同一窗口再也点不动任何格式卡（R-P4-8 / PRD §5.5）。
 *   runReqId 只由 onPick 自己在请求结束时释放 ⇒ 它才是"这一轮 UI 归谁"的权威。
 */
let runReqId = ''

/**
 * 在飞行中的那次转换所处理的**文件批次**。
 *
 * ★ 为什么要记批次：
 *   在飞行期间可能又来了一批新文件（onFiles）⇒ 用户看到的是新批次。
 *   此时旧批次的回包到达：
 *     - **闸必须放**（converting=false + resetCards）⇒ 否则同样会锁死 UI；
 *     - 但**状态文案不能写**（那是旧批次的成败，与当前批次无关）。
 *   有了它就能区分"这轮回包属于哪一批"。
 */
let runFiles = []

/** 请求 id 计数器（同一窗口内唯一且非空） */
let reqSeq = 0

/**
 * 生成一个新的请求 id。
 * @returns {string}
 */
function newReqId () {
  reqSeq += 1
  return 'c' + Date.now().toString(36) + '-' + reqSeq + '-' +
    Math.random().toString(36).slice(2, 8)
}

/**
 * 显示进度条。
 * @param {boolean} visible
 */
function showProgress (visible) {
  if (!els.progress) return
  els.progress.hidden = !visible
  if (!visible) {
    // 终态时不得残留百分比文本（A19）
    if (els.progressFill) els.progressFill.style.width = '0%'
    if (els.progressPct) els.progressPct.textContent = ''
  }
}

/**
 * 更新进度条与页码文案。
 *
 * ★ 百分比**单调不减**：同一源内 done 只增不减 ⇒ 百分比不会倒退。
 *   源切换时允许重置（不做跨源聚合，PRD Q13）。
 *
 * @param {object} p { source, page, total, done, failed, phase }
 */
function updateProgress (p) {
  if (!p) return
  if (!els.progress) return

  // 文本抽取是黑盒：不显示百分比，只说"正在抽取文本…"
  if (p.phase && p.phase !== 'pages') {
    els.progress.hidden = false
    if (els.progressFill) els.progressFill.style.width = '0%'
    if (els.progressPct) els.progressPct.textContent = ''
    const label = p.phase === 'text' ? '正在抽取文本…' : '正在准备…'
    setStatus(label, 'busy')
    return
  }

  els.progress.hidden = false
  const total = Number(p.total) || 0
  const done = Number(p.done) || 0
  const failed = Number(p.failed) || 0

  if (!total) {
    // 总页数未知 ⇒ 显示"正在准备…"，绝不显示 0%（那会被误读成"卡住了"）
    if (els.progressFill) els.progressFill.style.width = '0%'
    if (els.progressPct) els.progressPct.textContent = ''
    setStatus('正在准备…', 'busy')
    return
  }

  const processed = done + failed
  const pct = Math.min(100, Math.round(processed * 100 / total))
  if (els.progressFill) els.progressFill.style.width = pct + '%'
  if (els.progressPct) els.progressPct.textContent = pct + '%'

  const name = String(p.source || '').split(/[\\/]/).pop()
  const failedText = failed ? '，' + failed + ' 页失败' : ''
  setStatus('正在转换 ' + name + ' 第 ' + processed + '/' + total + ' 页…' + failedText, 'busy')
}

/** 扩展名（用于查能力表） */
function extOf (filePath) {
  const base = String(filePath || '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** 当前批里有没有 PDF 源文件 */
function hasPdfSource () {
  return currentFiles.some(f => extOf(f) === 'pdf')
}

/**
 * 刷新勾选框可见性。
 *
 * onFiles 时目标还没选：用能力表判断"这批文件是否存在 PDF→图片/txt 的可选目标"；
 * onPick 时目标已确定：只在该目标属于 ALL_PAGES_TARGETS 时显示。
 * ★ 这个窗口是"点格式即转换"，没有常驻的选中态，所以两处都要刷新一次。
 *
 * @param {string} [target] 已选目标（onPick）
 * @param {string[]} [targets] 可用目标列表（onFiles）
 */
function updateAllPagesVisibility (target, targets) {
  if (!els.allPages) return
  let show = hasPdfSource()
  if (target) {
    show = show && ALL_PAGES_TARGETS.includes(String(target).toLowerCase())
  } else if (Array.isArray(targets)) {
    show = show && targets.some(t => ALL_PAGES_TARGETS.includes(String(t).toLowerCase()))
  }
  els.allPages.hidden = !show
}

/**
 * 用户是否真的要转全部页。
 * 必须同时满足：勾选框存在、可见、已勾选、源含 PDF、目标属于 PDF→图片/txt。
 * ★ 隐藏时即使还残留 checked 也不能生效，避免换格式后偷偷全页转换。
 *
 * @param {string} target
 * @returns {boolean}
 */
function shouldAllPages (target) {
  if (!els.allPages || els.allPages.hidden || !els.allPages.checked) return false
  if (!hasPdfSource()) return false
  if (target && !ALL_PAGES_TARGETS.includes(String(target).toLowerCase())) return false
  return true
}

/** 设置状态文案 */
function setStatus (msg, kind) {
  els.status.textContent = msg || ''
  els.status.className = 'status' + (kind ? ' ' + kind : '')
}

/**
 * 显示一条**粘住**的错误提示。
 *
 * 粘住的含义：后续的能力查询回调不会再把它清掉。
 * @param {string} reason
 * @param {string} detail
 */
function showStickyError (reason, detail) {
  stickyError = true
  setStatus(reasonText(reason, detail), 'err')
}

/**
 * 渲染一个格式卡片。
 * @param {string} id 格式 id
 * @param {boolean} disabled 是否置灰（需要额外引擎）
 */
function fmtCard (id, disabled) {
  const el = document.createElement('div')
  el.className = 'fmt' + (disabled ? ' disabled' : '')
  el.dataset.fmt = id

  const name = document.createElement('div')
  name.className = 'id'
  name.textContent = id

  const sub = document.createElement('div')
  sub.className = 'name'
  sub.textContent = disabled ? '需安装引擎' : ''

  el.appendChild(name)
  el.appendChild(sub)
  el.addEventListener('click', () => onPick(id, disabled))
  return el
}

/** 清空并填入一组格式 */
function render (container, ids, disabled) {
  container.innerHTML = ''
  for (const id of ids) container.appendChild(fmtCard(id, disabled))
}

/**
 * 选了一个目标格式。
 * @param {string} target
 * @param {boolean} needsEngine
 */
async function onPick (target, needsEngine) {
  // 用户又试了一次 ⇒ 之前的失败提示作废
  stickyError = false
  if (needsEngine) {
    setStatus('该格式需要额外引擎。安装 Filee 后可在其 Settings → Engines 中补齐，然后重试。', 'err')
    return
  }
  if (!currentFiles.length) return

  // ★ 不可重复触发：已经在转就直接返回（同一 tick 内的双击也拦得住）
  if (converting) return

  // 目标已确定 ⇒ 最后再刷一次可见性，并按勾选状态组装 payload
  updateAllPagesVisibility(target)
  const allPages = shouldAllPages(target)
  converting = true
  const reqId = newReqId()
  currentReqId = reqId
  // ★ runReqId = "这一轮的 UI 归谁管"。它只在本次请求**自己**结束时才释放，
  //   不会被 onFiles 清掉（详见 runReqId 的注释）。
  runReqId = reqId
  // ★ 记下本轮处理的批次：回包到达时要判断"它是不是当前批次"的。
  runFiles = currentFiles.slice()
  setStatus('转换中…', 'busy')
  showProgress(true)
  els.available.querySelectorAll('.fmt').forEach(el => { el.style.pointerEvents = 'none' })
  if (els.allPages) els.allPages.disabled = true

  let r
  try {
    r = await window.sticky.convertRun({ files: currentFiles, target, allPages, reqId })
  } catch (err) {
    // 异常路径同样必须**走到终态收口**：否则 converting 永远停在 true、
    // allPages.disabled 永远停在 true ⇒ 用户在同一窗口再也点不动任何格式卡。
    if (runReqId === reqId) {
      converting = false
      runReqId = ''
      runFiles = []
      showProgress(false)
      setStatus('转换失败：' + (err && err.message ? err.message : String(err)), 'err')
      resetCards()
    }
    return
  }

  // ★ 回包归属判定（2026-11-18 / F1）。
  //
  //   reqId 不匹配 ⇒ 这是**别的**请求的回包（旧请求的迟到回包，或更新的请求在飞行）：
  //     绝不能覆盖当前状态、也绝不能替当前请求收口 ⇒ 直接丢弃。
  //
  //   reqId 匹配或没有 reqId ⇒ 是本次请求的回包：
  //     - 成功 ⇒ 正常收口（写成功文案、关窗）。
  //     - 失败 ⇒ **必须**走到终态收口（写失败文案 + resetCards），
  //       否则 converting 永远 true、allPages.disabled 永远 true，
  //       用户在同一窗口再也点不动任何格式卡（R-P4-8 / PRD §5.5）。
  //
  //   ★ 为什么用 runReqId 而不是 currentReqId：
  //     currentReqId 是「进度事件过滤器」，收到新的一批文件（onFiles）时会被清空；
  //     而主进程在转换失败时的顺序是「**先**发 convert:files、**再**回失败回包」
  //     ⇒ 失败回包到达时 currentReqId 已经被清成 ''。
  //     拿 currentReqId 判定 ⇒ 'cxxx' !== '' ⇒ 失败回包被当成旧回包丢掉
  //     ⇒ converting 永远 true、allPages.disabled 永远 true（R-P4-8 / PRD §5.5）。
  //     runReqId 只由本次请求自己释放 ⇒ 它才是"这一轮 UI 归谁"的权威。
  //
  //   ★ 无 reqId 的回包按"本次请求"处理：宁可多收口一次，也不能让 UI 卡死。
  const replyReqId = r && r.reqId ? String(r.reqId) : ''
  if (replyReqId && replyReqId !== runReqId) return

  // ★ 在飞行期间用户又来了一批新文件 ⇒ 当前显示的批次已经不是本轮的批次了。
  //   这种情况下**不写状态文案**（那是旧批次的成败），但**仍然必须收口**
  //   （放开 converting 与 allPages.disabled，否则新批次也会被锁死）。
  const sameBatch = runFiles.length === currentFiles.length &&
    runFiles.every((f, i) => String(f) === String(currentFiles[i]))
  const stale = !sameBatch

  // 失败态要"粘住"错误提示：主进程紧接着还会走一次 onFiles 的能力查询回调，
  // 那次回调会调 setStatus('') 把文案清掉 —— 失败原因必须留在窗口里。
  if (!stale && (!r || !r.ok)) stickyError = true

  converting = false
  runReqId = ''
  runFiles = []
  // ★ 任何终态都**先隐藏进度条，再写状态栏文案**（顺序固定）
  showProgress(false)

  if (r && r.ok) {
    // ★ 成功 ≠ 符合预期：例如 SVG 转出来是全透明空白图。
    //   必须把警告说出来，否则用户拿到一张空白图却看到"已转换成功"，无从判断原因。
    const warns = Array.isArray(r.warnings) ? r.warnings : []
    if (!stale) {
      if (warns.length) {
        setStatus('已转换，但请注意：' + describeWarnings(warns), 'warn')
        // 有警告时多留一会儿：用户得有时间读完
        setTimeout(() => { window.close() }, 2600)
      } else {
        setStatus('已转换，结果已保存到源文件目录。', 'ok')
        setTimeout(() => { window.close() }, 700)
      }
    }
    return
  }

  const reason = r && r.reason
  if (!stale) setStatus(reasonText(reason, r && r.error), 'err')
  // ★ 失败后必须恢复可点：卡片 pointerEvents 与「转换所有页面」勾选框都要复原，
  //   否则用户在同一窗口无法重试（R-P4-8 / PRD §5.5）。
  resetCards()
}

/**
 * 把一组产物警告拼成一句人话。
 *
 * 为什么要拼接而不是只显示第一条：一次可能同时"全透明" + "尺寸被缩小"，
 * 两件事用户都得知道；但也不能把 10 条一样的重复贴出来（主进程已去重）。
 *
 * @param {Array<{code:string, message:string}>} warns
 * @returns {string}
 */
function describeWarnings (warns) {
  const msgs = []
  for (const w of warns) {
    const m = w && w.message ? String(w.message) : ''
    if (m && !msgs.includes(m)) msgs.push(m)
  }
  if (!msgs.length) return '产物可能与预期不同。'
  return msgs.join('；')
}

/** 恢复卡片可点 */
function resetCards () {
  els.available.querySelectorAll('.fmt').forEach(el => { el.style.pointerEvents = '' })
  if (els.allPages) els.allPages.disabled = false
}

/**
 * 把「失败原因」翻译成用户看得懂的一句话。
 *
 * ★ 失败提示走这个窗口，而不是 dialog.showMessageBox：
 *   模态对话框会挂住 app.quit()（e2e S2 抓到过），退出流程会被卡死。
 *
 * ★ 2026-11-16：不再假设"必须装 Filee"。
 *   内置引擎（图片/文本数据）始终可用；Filee 装了才有额外格式。
 *
 * @param {string} reason 失败分类
 * @param {string} detail 原始错误
 * @returns {string}
 */
function reasonText (reason, detail) {
  switch (reason) {
    case 'not-installed':
      return '没有可用的转换引擎。请确认应用完整安装后重试。'
    case 'needs-engine':
      return '该格式需要额外引擎。安装 Filee 后可在其 Settings → Engines 中补齐。'
    case 'usage':
      return '目标格式不被支持' + (detail ? '：' + detail : '。')
    case 'nothing-to-do':
      return '没有可转换的内容。'
    case 'timeout':
      return '转换超时，请检查文件大小后重试。'
    case 'spawn-failed':
      return '无法启动转换引擎：' + (detail || '')
    default:
      return '转换失败' + (detail ? '：' + detail : '。')
  }
}

/** 收到文件列表：查能力并渲染。
 * @param {string[]} files
 */
async function onFiles (files) {
  currentFiles = Array.isArray(files) ? files.slice() : []
  // ★ 新的一批文件 ⇒ 旧的 reqId 立即失效：
  //   其后的旧进度事件会被丢弃（R-P4-14），旧回包也会被 R-P4-15 忽略。
  //   （旧产物已保存到源文件目录，不撤销 —— 那是另一个议题。）
  currentReqId = ''
  showProgress(false)
  // 新的一批文件 ⇒ 旧的勾选状态作废，避免误转几十页
  if (els.allPages) els.allPages.checked = false
  updateAllPagesVisibility()
  void updatePdfTranslateSection()
  if (!currentFiles.length) {
    els.subtitle.textContent = '没有待转换的文件'
    render(els.available, [], false)
    render(els.needsEngine, [], false)
    setStatus('')
    return
  }

  const names = currentFiles.map(f => f.split(/[\\/]/).pop())
  els.subtitle.textContent = names.length === 1 ? names[0] : names[0] + ' 等 ' + names.length + ' 个文件'
  els.files.innerHTML = '<b>' + names.map(escapeHtml).join('</b>、<b>') + '</b>'

  // 多文件时按第一个文件的扩展名查能力
  const ext = extOf(currentFiles[0])
  if (!ext) {
    render(els.available, [], false)
    render(els.needsEngine, [], false)
    els.availableTitle.textContent = '可用格式'
    setStatus('无法识别文件类型。', 'err')
    return
  }

  setStatus('查询可用格式…', 'busy')
  let caps
  try {
    caps = await window.sticky.convertCapabilities(ext)
  } catch (err) {
    setStatus('查询失败：' + (err && err.message ? err.message : String(err)), 'err')
    return
  }

  if (!caps || !caps.ok) {
    render(els.available, [], false)
    render(els.needsEngine, [], false)
    const reason = caps && caps.reason
    setStatus(reasonText(reason, caps && caps.error), 'err')
    if (reason === 'not-installed') {
      els.hint.textContent = '内置转换引擎未就绪。图片与文本/数据转换不需要任何外部引擎。'
    }
    return
  }

  render(els.available, caps.targets || [], false)
  render(els.needsEngine, caps.withEngines || [], true)
  // 格式网格刚渲染完 ⇒ 按能力表刷新「全部页」勾选框（见函数注释）
  updateAllPagesVisibility(null, caps.targets || [])

  els.availableTitle.textContent = '可用格式（' + (caps.targets || []).length + '）'
  els.engineTitle.textContent = '需要额外引擎（可选）'
  els.engineTitle.style.display = (caps.withEngines || []).length ? '' : 'none'

  if (!(caps.targets || []).length) {
    els.hint.textContent = '该类型在当前已安装的引擎下没有可直接转换的目标格式。'
  } else {
    els.hint.textContent = '选择目标格式即可开始转换；结果会保存到各自的源文件目录，不会覆盖同名文件。'
  }
  // ★ 若之前已有失败提示（主进程先发 files、后发 error），不要把它清掉
  if (!stickyError) setStatus('')
}

let pdfTransRunning = false
let pdfTransJobId = ''

function isPdfBatch () {
  return currentFiles.length > 0 && extOf(currentFiles[0]) === 'pdf'
}

function setPdfTransButtonsDisabled (disabled) {
  if (els.pdfTransDualBtn) els.pdfTransDualBtn.disabled = disabled
  if (els.pdfTransMonoBtn) els.pdfTransMonoBtn.disabled = disabled
}

async function updatePdfTranslateSection () {
  if (!els.pdfTranslateSection) return
  const visible = isPdfBatch() && window.sticky && typeof window.sticky.pdfTranslateRun === 'function'
  els.pdfTranslateSection.hidden = !visible
  if (!visible) return
  if (typeof window.sticky.pdfTranslateStatus !== 'function') return
  try {
    const info = await window.sticky.pdfTranslateStatus()
    if (!els.pdfTransEnvSub) return
    const cfg = (info && info.config) || {}
    const ready = (info && info.cli && info.cli.found) || (info && info.server && info.server.reachable)
    if (ready) {
      els.pdfTransEnvSub.textContent = `${cfg.langIn || 'en'} → ${cfg.langOut || 'zh'}`
    } else {
      els.pdfTransEnvSub.textContent = '未检测到 pdf2zh_next（可在便签中心“文献翻译”配置）'
    }
  } catch (_) {}
}

async function startQuickPdfTranslate (mode) {
  if (converting || pdfTransRunning || !isPdfBatch()) return
  if (!window.sticky || typeof window.sticky.pdfTranslateRun !== 'function') return

  converting = true
  pdfTransRunning = true
  pdfTransJobId = ''
  stickyError = false
  setPdfTransButtonsDisabled(true)
  if (els.pdfTransBoxCancel) {
    els.pdfTransBoxCancel.hidden = false
    els.pdfTransBoxCancel.disabled = false
  }
  showProgress(true)
  if (els.progressFill) els.progressFill.style.width = '5%'
  if (els.progressPct) els.progressPct.textContent = '5%'
  setStatus('正在启动学术文献翻译…', 'busy')

  try {
    const res = await window.sticky.pdfTranslateRun({
      filePath: currentFiles[0],
      mode
    })
    showProgress(false)
    if (res && res.ok) {
      const firstOut = Array.isArray(res.outputs) && res.outputs[0] ? res.outputs[0].name : '已保存到源文件目录'
      setStatus(`翻译完成：${firstOut}`, 'ok')
    } else {
      setStatus((res && res.error) ? res.error : '文献翻译未完成', 'err')
    }
  } catch (err) {
    showProgress(false)
    setStatus(`文献翻译失败：${err && err.message ? err.message : String(err)}`, 'err')
  } finally {
    converting = false
    pdfTransRunning = false
    pdfTransJobId = ''
    setPdfTransButtonsDisabled(false)
    if (els.pdfTransBoxCancel) els.pdfTransBoxCancel.hidden = true
  }
}

if (els.pdfTransDualBtn) {
  els.pdfTransDualBtn.addEventListener('click', () => { void startQuickPdfTranslate('dual') })
}
if (els.pdfTransMonoBtn) {
  els.pdfTransMonoBtn.addEventListener('click', () => { void startQuickPdfTranslate('mono') })
}
if (els.pdfTransBoxCancel) {
  els.pdfTransBoxCancel.addEventListener('click', () => {
    if (!window.sticky || typeof window.sticky.pdfTranslateCancel !== 'function') return
    els.pdfTransBoxCancel.disabled = true
    void window.sticky.pdfTranslateCancel(pdfTransJobId || undefined)
  })
}

if (window.sticky && typeof window.sticky.onPdfTranslateProgress === 'function') {
  window.sticky.onPdfTranslateProgress((ev) => {
    if (!ev || !pdfTransRunning) return
    if (ev.jobId && !pdfTransJobId) pdfTransJobId = ev.jobId
    if (typeof ev.percent === 'number') {
      const pct = Math.max(0, Math.min(100, Math.round(ev.percent)))
      if (els.progressFill) els.progressFill.style.width = `${pct}%`
      if (els.progressPct) els.progressPct.textContent = `${pct}%`
    }
    if (ev.message && ev.status === 'running') {
      setStatus(ev.message, 'busy')
    }
  })
}

/** HTML 转义 */
const escapeHtml = (window.StickyUtils && window.StickyUtils.escapeHtml) ||
  (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])))

// 主进程在窗口加载完成后发来文件列表
window.sticky.onConvertFiles(onFiles)

// 主进程发来的失败通知（例如从资源管理器右键进来、Filee 没装）
// 注意：这个窗口是非模态的，所以它不会阻塞 app.quit()
if (window.sticky.onConvertError) {
  window.sticky.onConvertError((info) => {
    if (!info) return
    showStickyError(info.reason, info.error)
  })
}

// 转换进度（全部页 PDF→图片）
//
// ★ 必须按 reqId 过滤：旧请求的进度事件可能在新请求之后才到，
//   收到 reqId 不匹配的件 ⇒ **不更新任何 DOM**（R-P4-14）。
if (window.sticky.onConvertProgress) {
  window.sticky.onConvertProgress((info) => {
    if (!info) return
    if (!currentReqId || info.reqId !== currentReqId) return
    updateProgress(info)
  })
}
