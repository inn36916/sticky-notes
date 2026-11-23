'use strict'
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')

function storeImage (userData, dataUrl) {
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/=\r\n]+)$/i)
  if (!match || dataUrl.length > 24 * 1024 * 1024) throw new Error('图片格式无效或超过 18MB')
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length) throw new Error('图片为空')
  const name = createHash('sha256').update(bytes).digest('hex') + '.' + match[1].toLowerCase()
  const dir = path.join(userData, 'attachments')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  if (!fs.existsSync(file)) {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, bytes)
    fs.renameSync(tmp, file)
  }
  return 'sticky-att://local/' + name
}

function backupImages (userData) {
  const dir = path.join(userData, 'backups', 'pre-external-images-' + Date.now())
  fs.mkdirSync(dir, { recursive: true })
  const data = path.join(userData, 'sticky-notes.json')
  if (fs.existsSync(data)) fs.copyFileSync(data, path.join(dir, 'sticky-notes.json'))
  const attachments = path.join(userData, 'attachments')
  if (fs.existsSync(attachments)) fs.cpSync(attachments, path.join(dir, 'attachments'), { recursive: true })
  return dir
}
module.exports = { storeImage, backupImages }
