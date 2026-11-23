'use strict'

/**
 * 零依赖静态质量门禁：
 *   1. 全项目 .js / .mjs 语法校验（node --check）
 *   2. 生产模块零循环依赖检测（main.js + main/ + lib/）
 *   3. 主进程与 preload / preload-worker IPC 通道 100% 对齐校验
 *   4. 安全与工程红线检查（无 convert:read-bytes、无 spawnSync、无 eval、CSP 完整、无残留临时文件）
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor'])

function walkFiles (dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(full, acc)
    else acc.push(full)
  }
  return acc
}

function relPath (abs) {
  return path.relative(ROOT, abs).replace(/\\/g, '/')
}

function readFiles (rels) {
  return rels.map(r => ({
    rel: r,
    code: fs.readFileSync(path.join(ROOT, r), 'utf8')
  }))
}

const errors = []
function fail (msg) { errors.push(msg) }

// 1. 全量语法检查
const allFiles = walkFiles(ROOT)
const jsFiles = allFiles.filter(f => /\.(js|mjs)$/.test(f))
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (err) {
    fail(`语法错误 ${relPath(f)}: ${(err.stderr && err.stderr.toString()) || err.message}`)
  }
}

// 2. 生产代码零循环依赖检查
const prodNodeFiles = jsFiles.filter(f => {
  const r = relPath(f)
  return r === 'main.js' || r.startsWith('main/') || r.startsWith('lib/')
})
const graph = {}
for (const f of prodNodeFiles) {
  const r = relPath(f)
  const code = fs.readFileSync(f, 'utf8')
  const deps = []
  const re = /require\(['"](\.[^'"]+)['"]\)/g
  let m
  while ((m = re.exec(code))) {
    let target = path.resolve(path.dirname(f), m[1])
    if (fs.existsSync(target + '.js')) target += '.js'
    else if (fs.existsSync(path.join(target, 'index.js'))) target = path.join(target, 'index.js')
    deps.push(relPath(target))
  }
  graph[r] = [...new Set(deps)]
}

const visited = new Set()
const stack = new Set()
const cycles = []
function dfs (node, trail) {
  visited.add(node)
  stack.add(node)
  for (const dep of (graph[node] || [])) {
    if (stack.has(dep)) cycles.push([...trail, dep].join(' -> '))
    else if (!visited.has(dep)) dfs(dep, [...trail, dep])
  }
  stack.delete(node)
}
for (const n of Object.keys(graph)) {
  if (!visited.has(n)) dfs(n, [n])
}
if (cycles.length) {
  fail('发现循环依赖:\n  ' + cycles.join('\n  '))
}

// 3. IPC 通道对齐校验
const mainDirFiles = fs.readdirSync(path.join(ROOT, 'main'))
  .filter(f => f.endsWith('.js'))
  .map(f => 'main/' + f)
const mainSources = readFiles(['main.js', ...mainDirFiles, 'lib/convert/main-bridge.js', 'lib/convert/worker-host.js'])
const preloadSources = readFiles(['preload.js', 'preload-worker.js'])

const allMainCode = mainSources.map(x => x.code).join('\n')
const allPreloadCode = preloadSources.map(x => x.code).join('\n')

const ipcMainRe = /\b(?:ipcMain|ipc)\.(?:handle|on)\(['"]([^'"]+)['"]/g
const preloadInvokeRe = /\bipcRenderer\.(?:invoke|sendSync|send)\(['"]([^'"]+)['"]/g
const preloadOnRe = /\bipcRenderer\.on\(['"]([^'"]+)['"]/g
const mainSendRe = /\.send\(['"]([^'"]+)['"]/g
const workerSendRe = /\brequest\(['"](convert:worker-[^'"]+)['"]/g

const handleNames = new Set([...allMainCode.matchAll(ipcMainRe)].map(m => m[1]))
const invokeNames = new Set([...allPreloadCode.matchAll(preloadInvokeRe)].map(m => m[1]))
const onNames = new Set([...allPreloadCode.matchAll(preloadOnRe)].map(m => m[1]))
const sendNames = new Set([
  ...[...allMainCode.matchAll(mainSendRe)].map(m => m[1]),
  ...[...allMainCode.matchAll(workerSendRe)].map(m => m[1])
])

for (const ch of invokeNames) {
  if (!handleNames.has(ch)) fail(`IPC 缺失：preload 暴露了 ${ch}，但主进程未注册`)
}
for (const ch of handleNames) {
  if (!invokeNames.has(ch)) fail(`IPC 冗余：主进程注册了 ${ch}，但 preload 未暴露`)
}
for (const ch of onNames) {
  if (!sendNames.has(ch)) fail(`IPC 冗余：preload 监听了 ${ch}，但主进程未发送`)
}
for (const ch of sendNames) {
  if (!onNames.has(ch)) fail(`IPC 缺失：主进程发送了 ${ch}，但 preload 未监听`)
}

// 4. 安全红线与工作区卫生校验
if (/convert:read-bytes/.test(allMainCode)) fail('安全红线：主进程不得出现 convert:read-bytes')
if (/\bspawnSync\s*\(/.test(allMainCode)) fail('性能红线：主进程不得调用阻塞式 spawnSync()')

const preloadCode = preloadSources[0].code
if (/readFileBytes|convert:read-bytes|onWorkerDecode|workerDecoded|workerEncoded/.test(preloadCode)) {
  fail('安全红线：业务 preload.js 不得暴露任意读文件或 worker IPC')
}

const prodSrcFiles = allFiles.filter(f => {
  const r = relPath(f)
  return /\.(js|mjs)$/.test(r) && !r.startsWith('test/') && !r.startsWith('scripts/') && !r.startsWith('examples/')
})
for (const f of prodSrcFiles) {
  const code = fs.readFileSync(f, 'utf8')
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(code)) {
    fail(`安全红线：${relPath(f)} 禁止使用 eval / new Function`)
  }
}

const htmlFiles = fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.html'))
for (const f of htmlFiles) {
  const html = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')
  const m = html.match(/Content-Security-Policy[\s\S]*?content="([^"]+)"/i)
  if (!m) { fail(`CSP 缺失：src/${f}`); continue }
  if (!/connect-src\s+'none'/.test(m[1])) fail(`CSP 缺失 connect-src 'none'：src/${f}`)
  if ((f === 'note.html' || f === 'preview.html') && !/sticky-att:/.test(m[1])) {
    fail(`CSP img-src 缺失 sticky-att:：src/${f}`)
  }
  if (f === 'convert-worker.html' && !/<script\s+src="guard\.js"\s*><\/script>/.test(html)) {
    fail('src/convert-worker.html 未接入 guard.js')
  }
}

if (fs.existsSync(path.join(ROOT, 'tmp-review'))) {
  fail('工作区存在未清理临时目录 tmp-review/')
}
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
  if (/^__qa-realm-probe-/.test(f)) fail(`工作区存在未清理探针文件 src/${f}`)
}

if (errors.length) {
  console.error('[lint] 检查未通过（共 ' + errors.length + ' 项）：')
  for (const e of errors) console.error('  ✗', e)
  process.exit(1)
}

console.log(
  `[lint] PASS · 语法检查 ${jsFiles.length} 个文件 | 零循环依赖 (${prodNodeFiles.length} 模块) | ` +
  `IPC ${handleNames.size}/${onNames.size} 通道 100% 对齐 | ${htmlFiles.length} 个页面 CSP/安全红线全部通过`
)
