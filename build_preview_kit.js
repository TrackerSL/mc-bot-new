/* Preview of the member kit as it arrives on a 1.20.4 connection: the armour pieces are
   disguised (base material = sign), so the icons come from the names. Uses the real
   itemBrief lifted out of server.js. Dev tool only. */
const fs = require('fs'), path = require('path')
const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
const ITEM_NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'items1204.json'), 'utf8'))
const ITEM_TEX = JSON.parse(fs.readFileSync(path.join(__dirname, 'item_tex.json'), 'utf8'))
const a = src.indexOf('const HEX_CODE'), b = src.indexOf('// best-effort MenuType registry')
const { itemBrief } = new Function('ITEM_NAMES', 'ITEM_TEX', 'fs', 'path', 'DEBUG_ITEM', 'ICON_GUESS',
  src.slice(a, b) + '; return { itemBrief }')(ITEM_NAMES, ITEM_TEX, fs, path, false, false)

const tag = (t, v) => ({ __t: t, v })
const comp = (e) => tag(10, e)
const str = (s) => tag(8, s)
const nm = (t, col) => JSON.stringify({ extra: [{ color: col || 'aqua', text: t, bold: true }], text: '' })
function custom (id, name, lore, count) {
  const display = comp([['Name', str(nm(name))]])
  if (lore) display.v.push(['Lore', tag(9, { __et: 8, items: lore.map(l => str(JSON.stringify({ extra: [{ color: 'gray', text: l }], text: '' }))) })])
  return itemBrief({ present: true, itemId: id, itemCount: count || 1, nbtData: comp([['hotbarItem', str('k')], ['display', display]]) })
}
function plain (id, count) { return itemBrief({ present: true, itemId: id, itemCount: count || 1 }) }

const inv = new Array(46).fill(null)
// the four disguised armour pieces (base material: mangrove_sign = 853)
inv[5] = custom(853, 'MEMBER Helmet', ['Click to equip'])
inv[6] = custom(853, 'MEMBER Chestplate', ['Click to equip'])
inv[7] = custom(853, 'MEMBER Leggings', ['Click to equip'])
inv[8] = custom(853, 'MEMBER Boots', ['Click to equip'])
// an ordinary member kit
inv[36] = custom(839, 'MEMBER Sword', ['Sharpness V', 'Life Steal II'])
inv[37] = custom(836, 'MEMBER Pickaxe', ['Efficiency V'])
inv[38] = plain(801, 12)
inv[39] = plain(881, 8)
inv[40] = plain(1156, 1)
inv[41] = plain(990, 16)
inv[45] = plain(1155, 1)

const state = {
  connected: true, name: 'GalactusXD', server: 'mc.cwresports.lk:25565',
  player: { x: 28.48, y: 65, z: 41.24, gameMode: 0, held: 0 }, antiAfk: false, stand: true,
  cursor: null, inv, gui: null
}
const TEX = {}
const want = new Set()
for (const it of inv) if (it) { if (it.tex) want.add(it.tex); if (it.customIcon) want.add(it.customIcon) }
for (const t of want) {
  const f = path.join(__dirname, 'textures', t)
  if (fs.existsSync(f)) TEX[t] = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
}
const extra = `
<style>#pvtag{position:fixed;left:18px;top:14px;z-index:70;color:#6f7885;font:12px "Segoe UI",sans-serif}</style>
<div id="pvtag">preview &mdash; member kit on a 1.20.4 connection: armour is disguised, icons come from the names</div>
<script>
  window.__TEX__ = ${JSON.stringify(TEX)};
  (function () {
    var ST = ${JSON.stringify(state)};
    window.fetch = function (url) {
      url = String(url)
      if (url.indexOf('/api/chat') === 0) return Promise.resolve({ json: function () { return Promise.resolve(url.indexOf('since=') === 0 ? { last: 0, lines: [] } : { last: 0, lines: [] }) } })
      if (url.indexOf('/api/build') === 0) return Promise.resolve({ json: function () { return Promise.resolve({ build: '2026-11-03f', itemIds: 1254, localTextures: 587 }) } })
      return Promise.resolve({ json: function () { return Promise.resolve(ST) } })
    }
  })();
  setTimeout(function () {
    var s = document.querySelector('.slot[data-slot="5"]')
    if (s) s.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 700, clientY: 250 }))
  }, 900);
</script>
`
let out = page.replace('<script>\n(function () {', extra + '<script>\n(function () {')
out = out.replace('<title>vanilla-node — inventory</title>', '<title>vanilla-node — member kit</title>')
fs.writeFileSync(path.join(__dirname, '..', 'ui-preview-kit.html'), out)
console.log('ui-preview-kit.html written,', out.length, 'bytes,', Object.keys(TEX).length, 'textures inlined')
