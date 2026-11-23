'use strict'

const path = require('path')
const { createNoteSearch } = require('../lib/note-search')

function createSearchService (BrowserWindow) {
  let worker
  let ready
  async function run (expression) {
    if (!worker || worker.isDestroyed()) {
      worker = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      ready = worker.loadFile(path.join(__dirname, '../src/search.html'))
    }
    await ready
    return worker.webContents.executeJavaScript(expression)
  }
  const index = createNoteSearch(html => run('StickyDomSnapshot.searchTextFromRoot(new DOMParser().parseFromString(' + JSON.stringify(html) + ', "text/html").body)'))
  return { query: index.query, convert: (method, payload) => run('StickyExchange[' + JSON.stringify(method) + '](' + JSON.stringify(payload) + ')') }
}

module.exports = { createSearchService }
