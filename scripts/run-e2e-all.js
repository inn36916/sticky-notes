'use strict'

/**
 * 串行执行 package.json 中注册的所有 Electron 端到端回归脚本。
 *
 * 用法：
 *   node scripts/run-e2e-all.js              # 顺序跑完所有 test:e2e*
 *   node scripts/run-e2e-all.js --list       # 仅列出待执行的脚本
 *   node scripts/run-e2e-all.js --filter pdf # 仅跑名称包含关键词的脚本
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const scripts = pkg.scripts || {}

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const filterIdx = args.indexOf('--filter')
const filter = filterIdx >= 0 ? String(args[filterIdx + 1] || '').toLowerCase() : ''

const e2eKeys = Object.keys(scripts)
  .filter(k => k === 'test:e2e' || k.startsWith('test:e2e:'))
  .filter(k => k !== 'test:e2e:all')
  .filter(k => !filter || k.toLowerCase().includes(filter))

if (listOnly) {
  console.log('待执行 E2E 套件（共 ' + e2eKeys.length + ' 项）：')
  for (const k of e2eKeys) console.log('  - ' + k + ' (' + scripts[k] + ')')
  process.exit(0)
}

if (!e2eKeys.length) {
  console.error('未匹配到任何 test:e2e* 脚本')
  process.exit(1)
}

let passed = 0
const failed = []

for (let i = 0; i < e2eKeys.length; i++) {
  const key = e2eKeys[i]
  console.log(`\n[${i + 1}/${e2eKeys.length}] 运行 npm run ${key} ...`)
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const r = spawnSync(npmCmd, ['run', key], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (r.status === 0) {
    passed++
  } else {
    failed.push({ key, status: r.status })
  }
}

console.log(`\n=== E2E 汇总：${passed}/${e2eKeys.length} 通过 ===`)
if (failed.length) {
  console.error('失败套件：')
  for (const f of failed) console.error(`  ✗ ${f.key} (exit=${f.status})`)
  process.exit(1)
}
