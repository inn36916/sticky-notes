'use strict'

/**
 * 假 Filee CLI —— 用于自动化测试，**不依赖用户真装 Filee**。
 *
 * 模拟官方契约（skills/filee/SKILL.md + Filee 源码 Cli.cs）：
 *   filee version                 → 打印版本，退出码 0
 *   filee formats <ext> --json    → {id,displayName,extensions,targets,withEngines}
 *   filee convert <files> --to <fmt> -o <dir> --overwrite --json --quiet
 *                                 → {preset,target,converted,skipped,failed,files:[...]}
 *
 * 行为由环境变量 STICKY_FAKE_FILEE 决定（默认 'ok'）：
 *   ok          正常转换，全部 done
 *   partial     一个 done + 一个 failed（退出码 1）
 *   needs-engine 失败且带 needsEngines（退出码 1）
 *   usage       退出码 2，stderr 有原因，**无 JSON**
 *   nothing     退出码 3，stderr 有原因，**无 JSON**
 *   bad-json    退出码 0 但 stdout 不是合法 JSON
 *   echo-args   把收到的参数原样打到 stdout（用于验证调用参数）
 *   slow        睡一会儿再输出（用于测超时）
 *
 * 额外约定：
 *   STICKY_FAKE_FILEE_PREFIX  给成功产物的文件名前缀（默认 fake-）
 */

const fs = require('fs')
const path = require('path')

const mode = process.env.STICKY_FAKE_FILEE || 'ok'
const prefix = process.env.STICKY_FAKE_FILEE_PREFIX || 'fake-'
const args = process.argv.slice(2)

function out (obj) {
  process.stdout.write(JSON.stringify(obj, null, 2))
}
function err (msg) {
  process.stderr.write(msg + '\n')
}

// ---------------------------------------------------------------- version
if (args[0] === 'version') {
  process.stdout.write('filee 2.4.1 (fake)\n')
  process.exit(0)
}

// ---------------------------------------------------------------- formats
if (args[0] === 'formats') {
  const name = args[1]
  if (mode === 'usage') {
    err("filee: unknown format '" + name + "'.")
    process.exit(2)
  }
  if (!name) {
    out({ formats: [{ id: 'jpg', displayName: 'JPEG', extensions: ['jpg', 'jpeg'] }] })
    process.exit(0)
  }
  const ext = String(name).replace(/^\./, '').toLowerCase()
  const table = {
    png: { targets: ['jpg', 'webp', 'pdf'], withEngines: ['heic'] },
    jpg: { targets: ['png', 'webp', 'pdf'], withEngines: [] },
    heic: { targets: [], withEngines: ['jpg', 'png'] },
    docx: { targets: ['pdf', 'txt', 'md'], withEngines: [] },
    pdf: { targets: ['png', 'jpg', 'txt'], withEngines: [] },
    mp4: { targets: [], withEngines: ['mp3'] },
    xyz: { targets: [], withEngines: [] }
  }
  const t = table[ext] || { targets: ['png'], withEngines: [] }
  out({
    id: ext,
    displayName: ext.toUpperCase(),
    extensions: [ext],
    targets: t.targets,
    withEngines: t.withEngines
  })
  process.exit(0)
}

// ---------------------------------------------------------------- convert
if (args[0] === 'convert') {
  const toIdx = args.indexOf('--to')
  const target = toIdx >= 0 ? args[toIdx + 1] : 'jpg'
  const oIdx = args.indexOf('-o')
  const outDir = oIdx >= 0 ? args[oIdx + 1] : process.cwd()

  // 位置参数：convert 之后、跳过所有带值选项及其值
  const VALUE_OPTS = new Set(['--to', '-t', '--preset', '-p', '-o', '--output', '--quality', '-q', '--pages', '--sort'])
  const inputs = []
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (VALUE_OPTS.has(a)) { i++; continue }   // 带值选项：跳过它的值
    if (a.startsWith('--')) continue            // 布尔开关
    inputs.push(a)
  }

  if (mode === 'echo-args') {
    out({ args })
    process.exit(0)
  }
  if (mode === 'usage') {
    err('filee: not found: ' + (inputs[0] || '?'))
    process.exit(2)
  }
  if (mode === 'nothing') {
    err('filee: no files to convert.')
    process.exit(3)
  }
  if (mode === 'slow') {
    const ms = Number(process.env.STICKY_FAKE_FILEE_SLOW_MS || 5000)
    setTimeout(() => {
      out({ preset: 'FAKE', target, converted: 0, skipped: 0, failed: 0, files: [] })
      process.exit(0)
    }, ms)
    return
  }
  if (mode === 'bad-json') {
    process.stdout.write('{not json at all')
    process.exit(0)
  }

  // 正常/部分失败：真的把产物写出去，这样测试能验证落盘
  fs.mkdirSync(outDir, { recursive: true })
  const files = []
  let converted = 0
  let failed = 0
  let skipped = 0

  for (let i = 0; i < inputs.length; i++) {
    const src = inputs[i]
    const base = path.basename(src, path.extname(src))
    const dest = path.join(outDir, prefix + base + '.' + target)

    if (mode === 'partial' && i === inputs.length - 1) {
      failed++
      files.push({
        source: src,
        state: 'failed',
        outputs: [],
        error: 'The engine reported an error (improper image header)'
      })
      continue
    }
    if (mode === 'needs-engine') {
      failed++
      files.push({
        source: src,
        state: 'failed',
        outputs: [],
        errorKey: 'error.no_route',
        needsEngines: ['pandoc']
      })
      continue
    }

    fs.writeFileSync(dest, 'fake output for ' + src)
    converted++
    files.push({ source: src, state: 'done', outputs: [dest] })
  }

  out({ preset: 'FAKE', target, converted, skipped, failed, files })
  process.exit(failed > 0 ? 1 : 0)
}

// ---------------------------------------------------------------- 未知命令
err('filee: unknown command')
process.exit(2)
