'use strict'

/**
 * Windows 资源管理器右键菜单动词管理（HKCU 注册表 + 异步 PowerShell）。
 */

const { execFile } = require('child_process')
const verbLib = require('../lib/explorer-verb')

/**
 * 异步执行外部命令，避免阻塞 Electron 主进程事件循环。
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {Promise<{status:number, stdout:string, stderr:string}>}
 */
function execFileAsync (bin, args, opts) {
  return new Promise((resolve) => {
    execFile(bin, args, opts || {}, (err, stdout, stderr) => {
      resolve({
        status: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || (err && err.message) || '')
      })
    })
  })
}

function runPowerShellAsync (script, timeout = 15000) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout
  })
}

function resolveVerbOpts (ctx = {}) {
  const app = ctx.app
  if (app && !app.isPackaged) {
    const dir = ctx.appDir || (typeof app.getAppPath === 'function' ? app.getAppPath() : '')
    return { appPath: dir }
  }
  return { appPath: ctx.appPath || '' }
}

async function installExplorerVerb (ctx = {}) {
  const ps = verbLib.installScript(process.execPath, verbLib.DEFAULT_LABEL, resolveVerbOpts(ctx))
  const r = await runPowerShellAsync(ps)
  if (!r || r.status !== 0) {
    return { ok: false, error: (r && r.stderr ? String(r.stderr) : '写入注册表失败').trim() }
  }
  return { ok: true }
}

async function uninstallExplorerVerb () {
  const r = await runPowerShellAsync(verbLib.uninstallScript())
  if (!r || r.status !== 0) {
    return { ok: false, error: (r && r.stderr ? String(r.stderr) : '删除注册表失败').trim() }
  }
  return { ok: true }
}

/**
 * 查询右键菜单动词是否已安装（走 PowerShell .NET 注册表提供程序，绕开 reg.exe 策略限制）。
 * @param {object} [ctx] { app?, appDir?, appPath? }
 * @returns {Promise<{installed:boolean, values:Object<string,string>, command:string|null, error?:string}>}
 */
async function explorerVerbStatus (ctx = {}) {
  const r = await runPowerShellAsync(verbLib.statusScript())
  if (!r || r.status !== 0) {
    return {
      installed: false,
      values: {},
      command: null,
      error: (r && r.stderr ? String(r.stderr) : '读取注册表失败').trim()
    }
  }
  const parsed = verbLib.parseStatusJson(r.stdout, process.execPath, resolveVerbOpts(ctx))
  if (r.stderr && r.stderr.trim() && !parsed.installed) {
    parsed.error = r.stderr.trim().slice(0, 300)
  }
  return parsed
}

function registerExplorerVerbIpc (ipcMain, ctx = {}) {
  ipcMain.handle('app:explorer-verb-status', () => explorerVerbStatus(ctx))
  ipcMain.handle('app:explorer-verb-install', async () => {
    const r = await installExplorerVerb(ctx)
    if (!r.ok) return r
    const st = await explorerVerbStatus(ctx)
    return { ok: st.installed, error: st.installed ? null : '注册表已写入但回读校验未通过' }
  })
  ipcMain.handle('app:explorer-verb-uninstall', () => uninstallExplorerVerb())
}

module.exports = {
  execFileAsync,
  runPowerShellAsync,
  installExplorerVerb,
  uninstallExplorerVerb,
  explorerVerbStatus,
  registerExplorerVerbIpc
}
