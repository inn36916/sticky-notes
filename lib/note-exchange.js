'use strict'
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
const { storeImage } = require('./image-store')
const { escapeHtml } = require('./utils')
const { parseMarkdownToRawHtmlWithMath } = require('./note-markdown')

function insideFile (root, relative) {
  if (typeof relative !== 'string' || !relative || /^[a-z][a-z\d+.-]*:/i.test(relative) || path.isAbsolute(relative)) throw new Error('仅允许所选目录中的相对资源路径')
  const realRoot = fs.realpathSync(root)
  const file = fs.realpathSync(path.resolve(realRoot, decodeURIComponent(relative)))
  if (!file.startsWith(realRoot + path.sep) || !fs.statSync(file).isFile()) throw new Error('资源路径越过所选目录')
  return file
}
function attachmentFile (userData, source) {
  const root = path.join(userData, 'attachments')
  if (source.startsWith('sticky-att://local/')) return insideFile(root, new URL(source).pathname.slice(1))
  const realRoot = fs.realpathSync(root)
  if (path.basename(path.dirname(source)) === 'attachments' && fs.existsSync(path.join(realRoot, path.basename(source)))) return insideFile(realRoot, path.basename(source))
  const file = fs.realpathSync(source)
  if (!file.startsWith(realRoot + path.sep) || !fs.statSync(file).isFile()) throw new Error('附件不在便签目录中')
  return file
}
async function importFile (file, userData, convert) {
  const input = fs.readFileSync(file, 'utf8')
  const title = path.basename(file, path.extname(file))
  const html = path.extname(file).toLowerCase() === '.txt'
    ? input.split(/\r?\n/).map(line => '<p>' + escapeHtml(line) + '</p>').join('')
    : parseMarkdownToRawHtmlWithMath(input, (await import('marked')).marked, { breaks: true })
  const result = await convert('importHtml', { html, title })
  const created = []
  try {
    for (const resource of result.resources) {
      const source = insideFile(path.dirname(file), resource.source)
      const dir = path.join(userData, 'attachments')
      fs.mkdirSync(dir, { recursive: true })
      const name = 'import-' + randomUUID() + path.extname(source)
      const target = path.join(dir, name)
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      created.push(target)
      result.html = result.html.split(resource.token).join(escapeHtml(resource.attachment ? target : 'sticky-att://local/' + encodeURIComponent(name)))
    }
  } catch (err) {
    for (const file of created) fs.unlinkSync(file)
    throw err
  }
  delete result.resources
  result.createdAttachments = created
  return result
}
async function exportFile (note, file, userData, convert) {
  const result = await convert('exportNote', note)
  const plain = path.extname(file).toLowerCase() === '.txt'
  let content = plain ? result.text : result.markdown
  const resourceDir = path.basename(file, path.extname(file)) + '-resources-' + randomUUID().slice(0, 8)
  const directory = path.join(path.dirname(file), resourceDir)
  const tmp = file + '.' + randomUUID() + '.tmp'
  try {
    if (!plain && result.resources.length) fs.mkdirSync(directory)
    for (let i = 0; !plain && i < result.resources.length; i++) {
      const resource = result.resources[i]
      let source = resource.source
      if (source.startsWith('data:image/')) source = storeImage(userData, source)
      source = attachmentFile(userData, source)
      const name = i + '-' + path.basename(source)
      fs.copyFileSync(source, path.join(directory, name), fs.constants.COPYFILE_EXCL)
      content = content.split(resource.token).join(encodeURI(resourceDir + '/' + name).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16)))
    }
    fs.writeFileSync(tmp, content, { flag: 'wx', encoding: 'utf8' })
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true })
    return { ok: false, error: err.message }
  }
}
module.exports = { insideFile, attachmentFile, importFile, exportFile }
