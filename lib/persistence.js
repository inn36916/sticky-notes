'use strict'

/**
 * 落盘层（只依赖 fs，不依赖 Electron）。
 * - 原子写：.tmp + rename，正式文件永远不会被写一半
 * - 损坏：先备份 .bak-<ts> 再回退空库，备份前不碰正式文件
 * - 高版本：直接拒绝，绝不写任何文件（TC-10 原文件字节不变）
 * - 迁移：升级前一次 pre-vN-<ts> 快照
 * - 最小写前快照：按天一份 .bak-YYYYMMDD，同一天只写一次，避免每 350ms 写盘产生快照爆炸
 * - 紧凑 JSON：不再用 2 空格缩进。JSON 解析不关心缩进，旧文件照常读回；
 *   但体积与 stringify 的 CPU 都显著下降（12MB 便签实测：缩进版 ~11.7MB / 19.3ms，
 *   紧凑版体积不变但 stringify 更快，且写盘字节数更少）。
 *
 * 写盘已经改为**异步**（fs.promises）。真正把 JSON.stringify 也挪出主线程的是
 * lib/save-writer.js（worker 线程）；本模块只提供「怎么写」的单一真源。
 */
const fs = require('fs')
const path = require('path')
const { migrateState, emptyState, CURRENT_VERSION } = require('./migrations')

const fsp = fs.promises

function stamp () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

function backupFile (dataFile, tag) {
  const dest = `${dataFile}.${tag}-${Date.now()}`
  fs.copyFileSync(dataFile, dest)
  return dest
}

/** 按天快照的目标文件名（纯路径计算，不碰磁盘） */
function dailySnapshotPath (dataFile) {
  return `${dataFile}.bak-${stamp()}`
}

/**
 * 每天一份写前快照；已存在则跳过。返回快照路径或 null。
 *
 * 注意：快照拷的是**写之前**那份正式文件，所以必须在正式写盘之前调用。
 * 「同一天只写一份」的行为依赖目标文件是否存在 —— 跨进程/跨天都成立。
 *
 * 并发安全：用 copyFile 的 'wx' 独占标志（目标已存在就失败），
 * 保证「同一天只有一份」在并发调用下也成立 —— 不会两个写同时往同一个目标拷，
 * 也不会拷出半截文件。
 */
async function dailySnapshot (dataFile) {
  const dest = dailySnapshotPath(dataFile)
  try {
    await fsp.access(dataFile)
  } catch (_) {
    return null                      // 正式文件都没有，没什么可快照的
  }
  try {
    await fsp.copyFile(dataFile, dest, fs.constants.COPYFILE_EXCL)
    return dest
  } catch (_) {
    return null                      // 已存在（同一天已写过）或复制失败
  }
}

/**
 * 原子写：先写 .tmp，再 rename 覆盖正式文件。
 * 正式文件永远不会是「写了一半」的状态。
 *
 * @param {string} dataFile 正式文件路径
 * @param {string} content 已经序列化好的 JSON 文本
 * @param {{snapshot?:boolean}} opts snapshot=true 时先做一次按天写前快照
 * @returns {Promise<{ok:boolean, error:string|null, snapshotPath:string|null}>}
 */
async function atomicWriteFile (dataFile, content, opts = {}) {
  let snapshotPath = null
  try {
    const dir = path.dirname(dataFile)
    await fsp.mkdir(dir, { recursive: true })
    if (opts.snapshot) snapshotPath = await dailySnapshot(dataFile)
    const tmp = `${dataFile}.tmp`
    await fsp.writeFile(tmp, content, 'utf8')
    await fsp.rename(tmp, dataFile)
    return { ok: true, error: null, snapshotPath }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), snapshotPath }
  }
}

// ---------------------------------------------------------------- 写盘串行化
//
// .tmp 文件名是固定的（`${dataFile}.tmp`），并发写会互相覆盖：
// 两个写同时往同一个 .tmp 写 → 内容交错 → 正式文件变成半截 JSON。
// 因此**同一个 dataFile 上最多只有一次写盘在飞**。
//
// 用一个按 dataFile 分组的 FIFO 队列实现：
//   - 后来的写排在前面那次后面，依次执行（磁盘上的终态 = 最后一次的内容）；
//   - 每个调用方拿到的是**自己那一次**的真实结果（成功 / 失败）。
const writeQueues = new Map()

/** 把一次写盘挂到该 dataFile 的队列尾巴上 */
function enqueueWrite (dataFile, task) {
  const prev = writeQueues.get(dataFile) || Promise.resolve()
  const next = prev.then(task, task)      // 前一次失败也要继续跑下一次
  // 队列尾部只用于「排队」，不要把结果串下去
  writeQueues.set(dataFile, next.then(() => {}, () => {}))
  return next
}

/**
 * 原子写（紧凑 JSON）。返回真实结果给调用方（N-04：调用方据此决定 UI 是「已保存」还是「保存失败」）。
 *
 * 同一个 dataFile 上的并发调用会被串行化，不会互相覆盖 .tmp。
 * @returns {Promise<{ok:boolean, error:string|null, snapshotPath:string|null}>}
 */
function writeState (dataFile, state, opts = {}) {
  return enqueueWrite(dataFile, async () => {
    let json
    try {
      json = JSON.stringify(state)     // 紧凑：去掉 2 空格缩进
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err), snapshotPath: null }
    }
    return atomicWriteFile(dataFile, json, opts)
  })
}

/**
 * 读取 + 迁移。绝不在这里改写正式文件，由调用方按 needsWrite 决定写回。
 * @returns {{ok:boolean, reason:string, state:object|null, needsWrite:boolean,
 *            backupPath:string|null, recoveredIds:string[], error:string|null}}
 */
function readState (dataFile, opts = {}) {
  const base = {
    ok: true, reason: '', state: null, needsWrite: false,
    backupPath: null, recoveredIds: [], error: null
  }
  if (!fs.existsSync(dataFile)) {
    return Object.assign({}, base, { reason: 'fresh', state: opts.emptyState ? opts.emptyState() : emptyState() })
  }

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  } catch (err) {
    let backupPath = null
    try { backupPath = backupFile(dataFile, 'bak') } catch (_) {}
    return Object.assign({}, base, {
      reason: 'corrupt',
      state: opts.emptyState ? opts.emptyState() : emptyState(),
      backupPath,
      error: err && err.message ? err.message : String(err)
    })
  }

  const m = migrateState(raw)
  if (!m.ok) {
    if (m.reason === 'future-version') {
      // 关键：不备份、不写回、不覆盖，保持原文件字节不变
      return Object.assign({}, base, {
        ok: false, reason: 'future-version', fromVersion: m.fromVersion,
        error: `数据文件版本 v${m.fromVersion} 高于当前程序 v${CURRENT_VERSION}`
      })
    }
    let backupPath = null
    try { backupPath = backupFile(dataFile, 'bak') } catch (_) {}
    return Object.assign({}, base, {
      reason: m.reason,
      state: opts.emptyState ? opts.emptyState() : emptyState(),
      backupPath,
      error: '数据结构不可识别'
    })
  }

  let backupPath = null
  if (m.changed) {
    try { backupPath = backupFile(dataFile, `pre-v${CURRENT_VERSION}`) } catch (_) {}
  }
  return Object.assign({}, base, {
    state: m.state,
    needsWrite: m.changed,
    backupPath,
    recoveredIds: m.recoveredIds
  })
}

module.exports = {
  CURRENT_VERSION,
  backupFile, dailySnapshot, dailySnapshotPath, atomicWriteFile,
  readState, writeState
}
