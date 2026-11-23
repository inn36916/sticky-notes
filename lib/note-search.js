'use strict'

function buildCompact (str) {
  const s = String(str || '')
  let compact = ''
  const map = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (!/\s/.test(ch)) {
      compact += ch.toLowerCase()
      map.push(i)
    }
  }
  return { compact, map }
}

function createNoteSearch (extractText) {
  const cache = new Map()
  async function query (notes, keyword) {
    const ids = new Set(notes.map(n => n.id))
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id)
    const needle = typeof keyword === 'string' ? keyword.trim().toLowerCase() : ''
    if (!needle) return []
    const needleCompact = needle.replace(/\s+/g, '')
    const results = []
    for (const note of notes) {
      let entry = cache.get(note.id)
      const noteTitle = note.title || ''
      if (!entry || entry.html !== note.html) {
        const html = note.html || ''
        const text = await extractText(html)
        if (note.html !== html) return query(notes, keyword)
        const bodyIdx = buildCompact(text)
        const titleIdx = buildCompact(noteTitle)
        entry = {
          html,
          text,
          lower: text.toLowerCase(),
          bodyCompact: bodyIdx.compact,
          bodyMap: bodyIdx.map,
          title: noteTitle,
          titleLower: noteTitle.toLowerCase(),
          titleCompact: titleIdx.compact,
          titleMap: titleIdx.map
        }
        cache.set(note.id, entry)
      } else if (entry.title !== noteTitle) {
        const titleIdx = buildCompact(noteTitle)
        entry.title = noteTitle
        entry.titleLower = noteTitle.toLowerCase()
        entry.titleCompact = titleIdx.compact
        entry.titleMap = titleIdx.map
      }

      const fullText = noteTitle + ' ' + entry.text
      const titlePrefixLen = noteTitle.length + 1
      let origStart = -1
      let origEnd = -1

      const bodyAt = entry.lower.indexOf(needle)
      if (bodyAt >= 0) {
        origStart = titlePrefixLen + bodyAt
        origEnd = origStart + needle.length
      } else {
        const fullAt = fullText.toLowerCase().indexOf(needle)
        if (fullAt >= 0) {
          origStart = fullAt
          origEnd = fullAt + needle.length
        } else if (needleCompact) {
          const cb = entry.bodyCompact.indexOf(needleCompact)
          if (cb >= 0) {
            origStart = titlePrefixLen + entry.bodyMap[cb]
            origEnd = titlePrefixLen + entry.bodyMap[cb + needleCompact.length - 1] + 1
          } else {
            const ct = entry.titleCompact.indexOf(needleCompact)
            if (ct >= 0) {
              origStart = entry.titleMap[ct]
              origEnd = entry.titleMap[ct + needleCompact.length - 1] + 1
            } else if (entry.titleCompact && entry.bodyCompact) {
              const combined = entry.titleCompact + entry.bodyCompact
              const cc = combined.indexOf(needleCompact)
              if (cc >= 0) {
                const startIdx = cc
                const endIdx = cc + needleCompact.length - 1
                origStart = startIdx < entry.titleMap.length
                  ? entry.titleMap[startIdx]
                  : titlePrefixLen + entry.bodyMap[startIdx - entry.titleMap.length]
                origEnd = endIdx < entry.titleMap.length
                  ? entry.titleMap[endIdx] + 1
                  : titlePrefixLen + entry.bodyMap[endIdx - entry.titleMap.length] + 1
              }
            }
          }
        }
      }

      if (origStart < 0) continue
      let start = Math.max(0, origStart - 35)
      let end = Math.min(fullText.length, start + 120)
      if (origEnd > end) {
        end = Math.min(fullText.length, origEnd + 20)
        start = Math.max(0, end - 120)
      }
      results.push({
        id: note.id,
        context: (start ? '…' : '') + fullText.slice(start, end) + (end < fullText.length ? '…' : '')
      })
    }
    return results
  }
  return { query }
}

module.exports = { createNoteSearch }
