/* Build a preview from REAL captured data: fixtures/state_sample.json (a live /api/state
   from the hub) and fixtures/chat_samples.jsonl (raw system_chat components as the server
   sent them). Textures are inlined so it works without a running bot. Dev tool only. */
const fs = require('fs'), path = require('path')
const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')

// lift the real colour/component code out of server.js
const a = src.indexOf('/* chat component (NBT tree)')
const b = src.indexOf('/* offline-mode UUID')
const c = src.indexOf('const HEX_CODE')
const tail = src.slice(c); const e = tail.indexOf('\n}', tail.indexOf('function legacyOf'))
const { flattenComponent, legacyOf } = new Function(src.slice(a, b) + '\n' + tail.slice(0, e + 2) +
  '; return { flattenComponent, legacyOf }')()

const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/state_sample.json'), 'utf8'))
const chatRows = fs.readFileSync(path.join(__dirname, 'fixtures/chat_samples.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l))
let chat = chatRows.map(r => legacyOf(r.params.content)).filter(t => t.trim())
// keep the coloured ones first (that is what this preview is about)
chat.sort((x, y) => (y.match(/\u00a7/g) || []).length - (x.match(/\u00a7/g) || []).length)
chat = chat.slice(0, 6)
// plus a few lines in exactly the component shape the server uses, so every colour path is visible
const shape = (parts) => legacyOf({ extra: parts.map(([col, txt, flags]) => Object.assign({ color: col, text: txt }, flags || {})) })
chat = chat.concat([
  shape([['#FFD0A6', '[vip] '], ['#9DE3FF', 'SHADOW_LS '], ['gray', '\u00bb '], ['white', 'Ammo Eka Supiri Badu para !']]),
  shape([['#FFADAD', '[MEMBER] '], ['#C6B5FF', 'codex12346 '], ['gray', '\u00bb '], ['white', 'Ven_Sup baduwak']]),
  shape([['gold', '[!] Coins '], ['gray', '\u2192 '], ['white', 'You have received '], ['#DDFFBC', '1 Coin', { bold: 1 }]]),
  shape([['#FFC6FF', 'C'], ['#B2FADF', 'h'], ['#DDFFBC', 'a'], ['#FEF5B2', 't'], ['#FFADAD', 'C'], ['#9DE3FF', 'o'], ['#A7BFFF', 'l'], ['#C6B5FF', 'o'], ['#FFC6FF', 'r '], ['white', 'gradient per character', { italic: 1 }]])
])
chat = chat.map((text, i) => ({ seq: i + 1, kind: 'server', text }))

// inline every texture the state refers to
const TEX = {}
const want = new Set()
for (const it of [...(state.inv || []), ...((state.gui && state.gui.slots) || [])]) if (it && it.tex) want.add(it.tex)
for (const t of want) {
  const f = path.join(__dirname, 'textures', t)
  if (fs.existsSync(f)) TEX[t] = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
}

const payload = JSON.stringify({ state, chat })
const extra = `
<style>
  #pvtag{position:fixed;left:18px;top:14px;z-index:70;color:#6f7885;font:12px "Segoe UI",sans-serif}
</style>
<div id="pvtag">preview &mdash; live state captured from mc.cwresports.lk (build 2026-11-03f)</div>
<script>
  window.__TEX__ = ${JSON.stringify(TEX)};
  (function () {
    var DATA = ${payload};
    window.fetch = function (url) {
      url = String(url)
      if (url.indexOf('/api/chat') === 0) return Promise.resolve({ json: function () { return Promise.resolve(url.indexOf('since=') === 0 ? { last: 0, lines: [] } : { last: DATA.chat.length, lines: DATA.chat }) } })
      if (url.indexOf('/api/build') === 0) return Promise.resolve({ json: function () { return Promise.resolve({ build: '2026-11-03f', itemIds: 1254, localTextures: 587 }) } })
      return Promise.resolve({ json: function () { return Promise.resolve(DATA.state) } })
    }
  })();
  setTimeout(function () { var b = document.getElementById('chatBtn'); if (b) b.click() }, 700);
</script>
`
let out = page.replace('<script>\n(function () {', extra + '<script>\n(function () {')
out = out.replace('<title>vanilla-node — inventory</title>', '<title>vanilla-node — inventory (live data)</title>')
fs.writeFileSync(path.join(__dirname, '..', 'ui-preview-live.html'), out)
console.log('ui-preview-live.html written,', out.length, 'bytes,', Object.keys(TEX).length, 'textures inlined,', chat.length, 'chat lines')
