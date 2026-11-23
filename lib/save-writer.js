'use strict'

/**
 * 落盘写入器：把「整库 JSON.stringify + 写盘 + rename」挪到 worker 线程，
 * 并保证**同一时刻只有一次写盘在飞**。
 *
 * 三条硬约束：
 *  1) 串行化：.tmp 文件名固定，并发写会互相覆盖 → 同一 dataFile 上最多一个在飞；
 *  2) 不丢新内容：排队时用**最新**的 state，而不是排队那一刻的快照；
 *  3) 真实结果：调用方拿到的必须是「真的落盘成功 / 失败」，N-04 靠它决定「已保存」。
 *
 * 代号（generation）语义：
 *   每次 save() 领一个递增代号 gen。调用方的 Promise 在**某次成功的写盘覆盖了它的代号**
 *   之后才 resolve —— 也就是说「await save(state) 返回 ok」意味着「包含这个 state 的那次
 *   写盘已经真的落到磁盘」。若期间又来了更新的 state，则以更新那次的结果为准。
 *
 * 队列只保留**最新**一份：中间态没有意义，落盘只需要终态。
 */
const path = require('path')
const { Worker } = require('worker_threads')

const WORKER_PATH = path.join(__dirname, 'save-worker.js')

class SaveWriter {
  /**
   * @param {{dataFile:string, workerPath?:string, onFallback?:Function}} opts
   */
  constructor (opts) {
    this.dataFile = opts.dataFile
    this.workerPath = opts.workerPath || WORKER_PATH
    this.onFallback = opts.onFallback || null

    this.worker = null
    this.workerBroken = false
    this.gen = 0
    /** 已提交但未完成的一次写盘 */
    this.inFlight = null
    /** 排队中的最新一份（只需要最新态） */
    this.queued = null
    /** @type {Array<{gen:number, resolve:Function, reject:Function}>} */
    this.waiters = []
    this.closed = false
  }

  /** 懒启动 worker；失败则永久退回内联模式 */
  _ensureWorker () {
    if (this.worker || this.workerBroken) return this.worker
    try {
      const w = new Worker(this.workerPath)
      w.on('message', (msg) => this._onWorkerMessage(msg))
      w.on('error', (err) => this._onWorkerBroken(err))
      w.on('exit', (code) => {
        if (code !== 0 && !this.closed) {
          this._onWorkerBroken(new Error('save worker 退出码 ' + code))
        }
      })
      // 空闲时不吊住主进程退出；有写盘在飞时 ref() 回来（见 _start / _settle）
      w.unref()
      this.worker = w
    } catch (err) {
      this.workerBroken = true
      if (this.onFallback) {
        try { this.onFallback(err) } catch (_) {}
      }
    }
    return this.worker
  }

  _onWorkerMessage (msg) {
    if (!msg || !this.inFlight) return
    // worker 回话的 id 必须与在飞那次一致（job.id 就是它的代号 gen）
    if (msg.id !== this.inFlight.id) return
    const result = {
      ok: !!msg.ok,
      error: msg.error || null,
      snapshotPath: msg.snapshotPath || null
    }
    this._settle(this.inFlight.gen, result)
  }

  _onWorkerBroken (err) {
    this.workerBroken = true
    try { if (this.worker) this.worker.terminate() } catch (_) {}
    this.worker = null
    // 在飞的请求不能永远挂着：退回内联写，把结果补给等待方
    const stuck = this.inFlight
    this.inFlight = null
    if (stuck) {
      this._writeInline(stuck.state, stuck.snapshot)
        .then((r) => this._settle(stuck.gen, r))
        .catch((e) => this._settle(stuck.gen, {
          ok: false, error: e && e.message ? e.message : String(e), snapshotPath: null
        }))
    }
    if (this.onFallback) {
      try { this.onFallback(err) } catch (_) {}
    }
  }

  /** 内联兜底：主进程异步写（仍走 persistence 的原子替换语义） */
  async _writeInline (state, snapshot) {
    const persistence = require('./persistence')
    return persistence.writeState(this.dataFile, state, { snapshot: !!snapshot })
  }

  /**
   * 请求一次落盘。
   * @param {object} state 要落盘的完整 state
   * @param {{snapshot?:boolean}} opts
   * @returns {Promise<{ok:boolean, error:string|null, snapshotPath:string|null}>}
   */
  save (state, opts = {}) {
    if (this.closed) {
      return Promise.resolve({ ok: false, error: '写入器已关闭', snapshotPath: null })
    }
    const gen = ++this.gen
    const promise = new Promise((resolve, reject) => {
      this.waiters.push({ gen, resolve, reject })
    })
    const job = { gen, id: gen, state, snapshot: !!opts.snapshot }

    if (this.inFlight) {
      // 正在飞：只保留最新的一份排队任务（中间态没有意义）
      this.queued = job
      return promise
    }
    this._start(job)
    return promise
  }

  _start (job) {
    this.inFlight = job
    const worker = this._ensureWorker()
    if (!worker) {
      this._writeInline(job.state, job.snapshot)
        .then((r) => this._settle(job.gen, r))
        .catch((err) => this._settle(job.gen, {
          ok: false, error: err && err.message ? err.message : String(err), snapshotPath: null
        }))
      return
    }
    try {
      // 有写盘在飞时 ref 回来：worker 不能在写完之前把主进程带下线
      if (typeof worker.ref === 'function') worker.ref()
      worker.postMessage({ id: job.id, dataFile: this.dataFile, state: job.state, snapshot: job.snapshot })
    } catch (err) {
      this._settle(job.gen, {
        ok: false, error: err && err.message ? err.message : String(err), snapshotPath: null
      })
    }
  }

  /** 一次写盘落地：结清所有代号 ≤ 本次代号的等待方，然后处理排队 */
  _settle (gen, result) {
    if (this.inFlight && this.inFlight.gen === gen) this.inFlight = null
    const rest = []
    for (const w of this.waiters) {
      if (w.gen <= gen) w.resolve(result)
      else rest.push(w)
    }
    this.waiters = rest
    // 空闲时 unref：worker 不吊住主进程退出
    if (!this.inFlight && !this.queued && this.worker && typeof this.worker.unref === 'function') {
      this.worker.unref()
    }
    this._drain()
  }

  /** 当前这次写完了 → 若队列里还有最新态，立刻再写一次 */
  _drain () {
    if (!this.queued) return
    const next = this.queued
    this.queued = null
    this._start(next)
  }

  /** 是否有写盘在飞或排队（退出收口用） */
  get busy () {
    return !!this.inFlight || !!this.queued
  }

  /** 等所有在飞 + 排队的写盘真正落地 */
  async drain () {
    // 循环到既没有在飞、也没有排队、也没有等待方
    let guard = 0
    while ((this.inFlight || this.queued || this.waiters.length) && guard++ < 10000) {
      if (this.inFlight) {
        await new Promise(r => setTimeout(r, 10))
      } else {
        await new Promise(r => setTimeout(r, 5))
      }
    }
  }

  /** 关闭：等写盘落地再拆 worker */
  async close () {
    await this.drain()
    this.closed = true
    const w = this.worker
    this.worker = null
    if (w) {
      try { await w.terminate() } catch (_) {}
    }
  }
}

module.exports = { SaveWriter, WORKER_PATH }
