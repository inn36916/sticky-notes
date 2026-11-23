'use strict'
const api = window.sticky
const toggle = document.getElementById('toggle')
const cards = document.getElementById('cards')
let expanded = false
toggle.addEventListener('click', () => api.toggleEdgeGroup(!expanded))
api.onEdgeGroupState(payload => {
  expanded = payload.expanded
  toggle.textContent = expanded ? '收起 · Esc' : '便签 ' + payload.notes.length
  toggle.setAttribute('aria-expanded', String(expanded))
  cards.hidden = !expanded
  cards.replaceChildren()
  for (const note of payload.notes) {
    const button = document.createElement('button')
    button.dataset.id = note.id
    button.style.borderLeftColor = note.color
    button.textContent = (note.due ? '⏰ ' : '') + note.title
    button.addEventListener('click', async () => { await api.action(note.id, 'show'); await api.toggleEdgeGroup(false) })
    cards.appendChild(button)
  }
})
document.addEventListener('keydown', e => { if (e.key === 'Escape') { api.toggleEdgeGroup(false); toggle.focus() } })
