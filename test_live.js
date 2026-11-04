// LIVE verification against a real Minecraft 1.20.4 server.
// Each block re-seeds a known inventory, so no block depends on the previous one.
// A wrong prediction shows up here as a server correction: the state the server
// reports will not match what we expected.
//
// usage: node test_live.js [http://localhost:8080]
const BASE = process.argv[2] || 'http://localhost:8080'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')) } }

async function get (p) { return fetch(BASE + p).then(r => r.json()) }
async function post (p, body) {
  const j = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json())
  if (j.error) throw new Error(p + ' → ' + j.error)
  return j
}
const slotsOf = s => s.gui ? s.gui.slots : s.inv
const slotStr = it => it ? `${it.count}x${it.id}` : '-'
const brief = (s, idx) => idx.map(i => i + ':' + slotStr(slotsOf(s)[i])).join(' ')

async function seed (spec) {
  // a carried stack has to go first, or it merges into the next click
  for (let i = 0; i < 3; i++) {
    const cur = await get('/api/state')
    if (!cur.cursor || !cur.cursor.count) break
    await click(-999, 0, 0, 120) // drop everything on the cursor
  }
  for (let i = 0; i < 46; i++) await post('/api/creative', { slot: i, itemId: 0, count: 0 })
  for (const [slot, itemId, count] of spec) await post('/api/creative', { slot, itemId, count })
  // put the cursor down nowhere: the inventory is the whole story
  await sleep(200)
  return get('/api/state')
}
async function click (slot, button, mode, delay = 150) {
  const st0 = await get('/api/state')
  const wid = st0.gui ? st0.gui.id : 0
  await post('/api/click', { windowId: wid, slot, button, mode })
  await sleep(delay)
  return get('/api/state')
}
async function batch (clicks, delay = 200) {
  const st0 = await get('/api/state')
  const wid = st0.gui ? st0.gui.id : 0
  await post('/api/click_batch', { windowId: wid, clicks })
  await sleep(delay)
  return get('/api/state')
}

// item ids (1.20.4): 1 stone, 298 chest, 834 diamond sword, 990 ender pearl
const STONE = 1, SWORD = 834, PEARL = 990

;(async () => {
  let st = await get('/api/state')
  if (!st.connected) { console.log('bot not connected'); process.exit(1) }
  console.log(`live @ ${BASE} — ${st.player.x} ${st.player.y} ${st.player.z}, gamemode ${st.player.gameMode}`)
  if (st.player.gameMode !== 1 && st.player.gameMode !== 2) { console.log('need creative mode'); process.exit(2) }

  // ---------- 1. PICKUP left ----------
  st = await seed([[9, STONE, 64]])
  st = await click(9, 0, 0)
  T('pick up a whole stack', !slotsOf(st)[9] && st.cursor && st.cursor.count === 64, brief(st, [9]))
  st = await click(13, 0, 0)
  T('place it into an empty slot', slotsOf(st)[13] && slotsOf(st)[13].count === 64 && !st.cursor, brief(st, [9, 13]))

  // ---------- 2. merge clamps at the stack limit ----------
  st = await seed([[10, STONE, 20], [11, STONE, 64]])
  st = await click(11, 0, 0)          // cursor 64
  st = await click(10, 0, 0)          // merge into 20
  T('merge fills to 64 and keeps the rest', slotsOf(st)[10].count === 64 && st.cursor.count === 20, brief(st, [10]))

  // ---------- 3. right click: half / one / merge one ----------
  st = await seed([[9, STONE, 11]])
  st = await click(9, 1, 0)
  T('right click picks up half (rounded up)', st.cursor && st.cursor.count === 6 && slotsOf(st)[9].count === 5, brief(st, [9]))
  st = await seed([[9, STONE, 10]])
  st = await click(9, 0, 0)           // cursor 10
  st = await click(14, 1, 0)          // place one
  T('right click places one', slotsOf(st)[14].count === 1 && st.cursor && st.cursor.count === 9, brief(st, [14]))
  st = await click(14, 1, 0)          // merge one
  T('right click merges one', slotsOf(st)[14].count === 2 && st.cursor && st.cursor.count === 8, brief(st, [14]))

  // ---------- 4. per-item stack limits ----------
  st = await seed([[12, PEARL, 16]])
  st = await click(12, 1, 0)
  T('right click halves the pearls', st.cursor && st.cursor.count === 8 && slotsOf(st)[12].count === 8, brief(st, [12]))
  st = await seed([[12, PEARL, 16], [13, PEARL, 16]])
  st = await click(13, 0, 0)          // cursor 16 pearls
  st = await click(12, 0, 0)          // merge into a full pearl stack: nothing fits
  T('a full stack absorbs nothing', slotsOf(st)[12].count === 16 && st.cursor && st.cursor.count === 16, brief(st, [12]))
  st = await click(20, 0, 0)          // place 16 into an empty slot
  T('pearls fill an empty slot to 16', slotsOf(st)[20].count === 16 && !st.cursor, brief(st, [20]))
  st = await seed([[12, PEARL, 16]])
  st = await click(12, 0, 0)
  st = await click(13, 0, 0)          // place into empty, max 16
  T('a 16-stack fits exactly', slotsOf(st)[13].count === 16 && !st.cursor, brief(st, [13]))

  // ---------- 5. swap different items ----------
  st = await seed([[9, STONE, 64], [10, SWORD, 1]])
  st = await click(9, 0, 0)
  st = await click(10, 0, 0)
  T('left click on a different item swaps', slotsOf(st)[10].id === STONE && st.cursor.id === SWORD, brief(st, [10]))

  // ---------- 6. QUICK_MOVE directions ----------
  st = await seed([[9, STONE, 64], [36, STONE, 5]])
  st = await click(9, 0, 1)
  T('shift-click main → hotbar (merge, then next slot)', !slotsOf(st)[9] && slotsOf(st)[36].count === 64 && slotsOf(st)[37].count === 5, brief(st, [9, 36, 37]))
  st = await seed([[40, STONE, 32]])
  st = await click(40, 0, 1)
  T('shift-click hotbar → main', !slotsOf(st)[40] && slotsOf(st)[9].count === 32, brief(st, [9, 40]))
  st = await seed([[9, STONE, 32], [36, STONE, 20]])
  st = await click(9, 0, 1)
  T('shift-click merges into a matching hotbar stack', !slotsOf(st)[9] && slotsOf(st)[36].count === 52, brief(st, [9, 36]))

  // ---------- 7. SWAP (number key, offhand) ----------
  st = await seed([[9, STONE, 10], [38, SWORD, 1]])
  st = await click(9, 2, 2)           // number key 3 on slot 9 <-> hotbar 2
  T('number key swap', slotsOf(st)[9].id === SWORD && slotsOf(st)[38].count === 10, brief(st, [9, 38]))
  st = await click(9, 2, 2)
  T('number key swap back', slotsOf(st)[9].count === 10 && slotsOf(st)[38].id === SWORD, brief(st, [9, 38]))
  st = await seed([[9, STONE, 7], [45, SWORD, 1]])
  st = await click(9, 40, 2)
  T('offhand swap (F)', slotsOf(st)[9].id === SWORD && slotsOf(st)[45].count === 7, brief(st, [9, 45]))
  st = await click(9, 40, 2)
  T('offhand swap back', slotsOf(st)[9].count === 7 && slotsOf(st)[45].id === SWORD, brief(st, [9, 45]))

  // ---------- 8. drag painting ----------
  st = await seed([[9, STONE, 64]])
  st = await click(9, 0, 0)           // cursor 64
  st = await batch([
    { slot: -999, button: 0, mode: 5 },
    { slot: 20, button: 1, mode: 5 },
    { slot: 21, button: 1, mode: 5 },
    { slot: 22, button: 1, mode: 5 },
    { slot: -999, button: 2, mode: 5 }
  ])
  T('left drag splits evenly (21/21/21 + 1 left)', slotsOf(st)[20].count === 21 && slotsOf(st)[21].count === 21 && slotsOf(st)[22].count === 21 && st.cursor && st.cursor.count === 1, brief(st, [20, 21, 22]))
  st = await seed([[9, STONE, 2]])
  st = await click(9, 0, 0)
  st = await batch([
    { slot: -999, button: 0, mode: 5 },
    { slot: 20, button: 1, mode: 5 },
    { slot: 21, button: 1, mode: 5 },
    { slot: 22, button: 1, mode: 5 },
    { slot: -999, button: 2, mode: 5 }
  ])
  T('left drag stops when the cursor is spent', slotsOf(st)[20].count === 1 && slotsOf(st)[21].count === 1 && !slotsOf(st)[22] && !st.cursor, brief(st, [20, 21, 22]))
  st = await seed([[9, STONE, 16]])
  st = await click(9, 0, 0)
  st = await batch([
    { slot: -999, button: 4, mode: 5 },
    { slot: 20, button: 5, mode: 5 },
    { slot: 21, button: 5, mode: 5 },
    { slot: -999, button: 6, mode: 5 }
  ])
  T('right drag places one per slot', slotsOf(st)[20].count === 1 && slotsOf(st)[21].count === 1 && st.cursor && st.cursor.count === 14, brief(st, [20, 21]))

  // ---------- 9. PICKUP_ALL ----------
  st = await seed([[9, STONE, 10], [10, STONE, 20], [11, STONE, 33]])
  st = await click(9, 0, 0)           // cursor 10
  st = await click(25, 0, 6)          // gather into an empty slot
  T('double-click gathers every matching stack', st.cursor && st.cursor.count === 63 && !slotsOf(st)[10] && !slotsOf(st)[11], brief(st, [9, 10, 11, 25]) + ' cursor ' + slotStr(st.cursor))
  st = await click(26, 0, 0)
  T('the gathered stack places normally', slotsOf(st)[26].count === 63 && !st.cursor, brief(st, [26]))

  // ---------- 10. THROW ----------
  st = await seed([[9, STONE, 10]])
  st = await click(9, 0, 4)
  T('Q drops one', slotsOf(st)[9].count === 9, brief(st, [9]))
  st = await click(9, 1, 4)
  T('shift+Q drops the stack', !slotsOf(st)[9], brief(st, [9]))

  // ---------- 11. outside the menu ----------
  st = await seed([[9, STONE, 10]])
  st = await click(9, 0, 0)           // cursor 10
  st = await click(-999, 1, 0)        // drop one outside
  T('clicking outside the menu drops one', st.cursor && st.cursor.count === 9, 'cursor ' + slotStr(st.cursor))
  st = await click(-999, 0, 0)        // drop the rest
  T('clicking outside with the left button drops all', !st.cursor, 'cursor ' + slotStr(st.cursor))

  // ---------- 12. a real container ----------
  await seed([[36, 298, 1]])          // a chest in hotbar 0
  await post('/api/held', { slot: 0 })
  const p = (await get('/api/state')).player
  const bx = Math.floor(p.x) + 1, by = Math.floor(p.y) - 1, bz = Math.floor(p.z)
  await post('/api/use_block', { x: bx, y: by, z: bz, face: 1 })  // place the chest
  await sleep(500)
  await post('/api/creative', { slot: 36, itemId: SWORD, count: 1 })
  await post('/api/use_block', { x: bx, y: by + 1, z: bz, face: 1 }) // right-click it to open
  await sleep(700)
  st = await get('/api/state')
  T('a chest opens a real container window', !!st.gui && st.gui.size === 63 && st.gui.type === 2, st.gui && { type: st.gui.type, size: st.gui.size, menu: st.gui.menu })
  if (st.gui) {
    T('chest layout 27 + 36', st.gui.lay.container === 27 && st.gui.lay.hotbar === 54)
    st = await click(54, 0, 0, 250)   // hotbar 0 inside the chest window
    T('pick up inside the container window', st.cursor && st.cursor.count > 0, 'cursor ' + slotStr(st.cursor))
    st = await click(0, 0, 0, 250)    // into the chest
    T('place into the container itself', slotsOf(st)[0] && slotsOf(st)[0].count > 0 && !st.cursor, brief(st, [0]))
    st = await click(0, 0, 1, 250)    // shift-click it back out
    T('chest shift-click returns it to the player', !slotsOf(st)[0] && slotsOf(st).some((x, i) => i >= 27 && x && x.count > 0), brief(st, [0]))
    await post('/api/close', {})
    await sleep(400)
    st = await get('/api/state')
    T('closing the window cleans up', st.gui === null)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
