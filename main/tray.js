'use strict'

/**
 * 系统托盘图标与右键菜单管理。
 */

function createTrayManager ({
  Tray, Menu, nativeImage, shell, app, ICON,
  getState, createNote, openDashboard, toggleVisible, setAllVisible,
  setGlobalSelect, openEdgeGroups, requestQuit
}) {
  let tray = null

  function buildTrayMenu () {
    const state = getState()
    const items = []

    items.push({
      label: '新建便签',
      accelerator: 'CommandOrControl+N',
      click: () => createNote()
    })
    items.push({
      label: '便签中心…',
      accelerator: 'CommandOrControl+Shift+N',
      click: () => openDashboard()
    })
    items.push({ type: 'separator' })

    if (state.notes.length === 0) {
      items.push({ label: '（暂无便签）', enabled: false })
    } else {
      for (const n of state.notes.filter(n => !n.archivedAt)) {
        const title = (n.title || n.preview || '无标题便签').trim().slice(0, 26)
        items.push({
          label: (n.visible ? '● ' : '○ ') + title,
          type: 'checkbox',
          checked: n.visible,
          click: () => toggleVisible(n.id)
        })
      }
    }

    items.push({ type: 'separator' })
    items.push({ label: '打开边缘卡组 (Ctrl+Alt+G)', click: () => openEdgeGroups() })
    items.push({ label: '显示全部', click: () => setAllVisible(true) })
    items.push({ label: '全部隐藏到托盘', click: () => setAllVisible(false) })
    items.push({ type: 'separator' })
    items.push({
      label: '全局划词（取词会使用系统剪贴板）',
      type: 'checkbox',
      checked: !!state.settings && state.settings.globalSelect === true,
      click: (item) => setGlobalSelect(item.checked)
    })
    items.push({ type: 'separator' })
    items.push({
      label: '打开数据目录',
      click: () => shell.openPath(app.getPath('userData'))
    })
    items.push({ label: '退出', click: () => requestQuit() })

    return Menu.buildFromTemplate(items)
  }

  function refreshTray () {
    if (!tray || tray.isDestroyed()) return
    tray.setContextMenu(buildTrayMenu())
  }

  function createTray () {
    const img = nativeImage.createFromPath(ICON)
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }))
    tray.setToolTip('桌面便签')
    refreshTray()
    tray.on('click', () => openDashboard())
    tray.on('double-click', () => createNote())
  }

  return {
    buildTrayMenu,
    refreshTray,
    createTray
  }
}

module.exports = { createTrayManager }
