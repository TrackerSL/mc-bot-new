// Build ui-preview.html: the real page with textures inlined and a demo state,
// so the layout can be looked at without a running bot. Not used at runtime.
const fs = require('fs'), path = require('path')
const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')

const want = [
  'item/diamond.png', 'item/totem_of_undying.png', 'item/netherite_scrap.png', 'item/wind_charge.png',
  'item/dark_oak_chest_boat.png', 'entity/shield_base.png', 'item/iron_helmet.png', 'item/emerald.png',
  'block/ancient_debris_side.png', 'entity/chest/ender.png', 'item/netherite_sword.png',
  'item/golden_apple.png', 'item/ender_pearl.png', 'item/experience_bottle.png', 'item/echo_shard.png', 'item/nautilus_shell.png'
]
const TEX = {}
for (const t of want) {
  const f = path.join(__dirname, 'textures', t)
  if (fs.existsSync(f)) TEX[t] = 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
}

const demo = `(function(){
  const mk = (id, disp, key, tex, count, extra) => Object.assign({ id, count: count||1, name: null, disp, custom: false, key, tex, lore: [], ench: [] }, extra||{})
  const inv = new Array(46).fill(null)
  inv[0]  = mk(801, 'Diamond', 'diamond', 'item/diamond.png')
  inv[1]  = mk(801, 'Diamond', 'diamond', 'item/diamond.png', 3)
  inv[3]  = mk(802, 'Emerald', 'emerald', 'item/emerald.png', 2)
  inv[5]  = mk(861, 'Iron Helmet', 'iron_helmet', 'item/iron_helmet.png')
  inv[9]  = mk(801, 'Diamond', 'diamond', 'item/diamond.png', 12)
  inv[10] = mk(1156, 'Totem of Undying', 'totem_of_undying', 'item/totem_of_undying.png')
  inv[11] = mk(839, 'Netherite Sword', 'netherite_sword', 'item/netherite_sword.png',
              { name: '\\u00a7dMarket Sword', custom: true, disp: 'Market Sword',
                lore: ['\\u00a77Forged in the deep', '\\u00a78+8 Attack Damage'],
                ench: ['Sharpness V', 'Unbreaking III', 'Mending I'] })
  inv[12] = mk(1255, 'Echo Shard', 'echo_shard', 'item/echo_shard.png', 4)
  inv[13] = mk(786, 'Dark Oak Chest Boat', 'dark_oak_chest_boat', 'item/dark_oak_chest_boat.png')
  inv[14] = mk(881, 'Golden Apple', 'golden_apple', 'item/golden_apple.png', 8)
  inv[20] = mk(990, 'Ender Pearl', 'ender_pearl', 'item/ender_pearl.png', 16)
  inv[36] = mk(801, 'Diamond', 'diamond', 'item/diamond.png', 2)
  inv[37] = mk(1156, 'Totem of Undying', 'totem_of_undying', 'item/totem_of_undying.png')
  inv[38] = mk(80, 'Ancient Debris', 'ancient_debris', 'block/ancient_debris_side.png', 64)
  inv[39] = mk(813, 'Netherite Scrap', 'netherite_scrap', 'item/netherite_scrap.png', 41)
  inv[40] = mk(1180, 'Nautilus Shell', 'nautilus_shell', 'item/nautilus_shell.png')
  inv[41] = mk(786, 'Dark Oak Chest Boat', 'dark_oak_chest_boat', 'item/dark_oak_chest_boat.png')
  inv[45] = mk(1155, 'Shield', 'shield', 'entity/shield_base.png')

  const chest = new Array(63).fill(null)
  chest[10] = mk(1156, 'Totem of Undying', 'totem_of_undying', 'item/totem_of_undying.png', 2)
  chest[12] = mk(801, 'Diamond', 'diamond', 'item/diamond.png', 5)
  chest[13] = mk(990, 'Ender Pearl', 'ender_pearl', 'item/ender_pearl.png', 16)
  chest[31] = mk(801, 'Diamond', 'diamond', 'item/diamond.png', 5,
    { name: '\\u00a76\\u00a7lMONEY', custom: true, disp: 'MONEY', lore: ['\\u00a77Right-click to claim', '\\u00a78Expires in 2 days'] })

  // one stack is already on the cursor, so the built-in preview shows a held item
  const base = { connected: true, name: 'GalactusXD', server: 'mc.cwresports.lk:25565',
    player: { x: 7.66, y: 65, z: 59.9, gameMode: 0, held: 0, sneak: false },
    antiAfk: false, stand: true, cursor: mk(801, 'Diamond', 'diamond', 'item/diamond.png', 7), inv }
  window.__DEMO__ = { inv, chest, chestOpen: false }
  window.fetch = function (url, opt) {
    url = String(url)
    if (url.startsWith('/api/state')) {
      const d = window.__DEMO__
      const st = Object.assign({}, base)
      st.gui = d.chestOpen
        ? { id: 3, type: 2, menu: 'generic_9x3', title: "Airrack's Ender Chest", size: 63, stateId: 1, lay: { container: 27 }, slots: d.chest }
        : null
      return Promise.resolve({ json: () => Promise.resolve(st) })
    }
    if (url.startsWith('/api/chat?since=')) {
      const lines = window.__CHAT__ || []
      return Promise.resolve({ json: () => Promise.resolve({ last: lines.length, lines: lines.map((text, i) => ({ seq: i + 1, kind: i === 0 ? 'server' : 'chat', text })) }) })
    }
    if (url.startsWith('/api/chat')) {
      try { const b = JSON.parse((opt && opt.body) || '{}'); (window.__SENT__ = window.__SENT__ || []).push(b.text) } catch (e) {}
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
  }
  window.__CHAT__ = [
    'CWR > Verifying your connection... Please wait. :D',
    '\\u00a7aCWR \\u00a78\\u00bb \\u00a7fYour connection was verified successfully.',
    '\\u00a77[MEMBER] \\u00a7bGalactusXD \\u00a78\\u00bb \\u00a7fhi',
    '\\u00a77ravana_x3 \\u00a78\\u00bb \\u00a7fmeka nice tha',
    '\\u00a76[!] Coins \\u00a78\\u2192 \\u00a7fYou have received 1 Coin.'
  ]
})();`

const extra = `
<style>
  #pvbar{position:fixed;left:18px;bottom:18px;z-index:70;display:flex;gap:8px;align-items:center}
  #pvbar button{padding:9px 14px;border-radius:999px;border:1px solid #3b4350;background:#22262d;color:#e8ecf2;
    font:600 13px "Segoe UI",sans-serif;cursor:pointer;box-shadow:0 6px 20px #0008}
  #pvbar button:hover{border-color:#5b6b86}
  #pvtag{position:fixed;left:18px;top:14px;color:#6f7885;font:12px "Segoe UI",sans-serif}
</style>
<div id="pvtag">preview &mdash; real 1.20.4 textures, demo data</div>
<div id="pvbar"><button id="pvToggle">open ender chest</button></div>
<script>
  window.__TEX__ = ${JSON.stringify(TEX)};
  ${demo}
  document.getElementById('pvToggle').onclick = function () {
    window.__DEMO__.chestOpen = !window.__DEMO__.chestOpen
    this.textContent = window.__DEMO__.chestOpen ? 'back to inventory' : 'open ender chest'
  }
  setTimeout(function () { document.getElementById('chatBtn').click() }, 700)
  // park the carried stack where a mouse would have left it
  setTimeout(function () { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 1110, clientY: 470 })) }, 800)
</script>
`

// the preview script must run BEFORE the page script (it defines fetch + textures)
let out = page.replace('<script>\n(function () {', extra + '<script>\n(function () {')
out = out.replace('<title>vanilla-node — inventory</title>', '<title>vanilla-node — inventory (preview)</title>')
fs.writeFileSync(path.join(__dirname, '..', 'ui-preview.html'), out)
console.log('ui-preview.html written,', out.length, 'bytes,', Object.keys(TEX).length, 'textures inlined')
