/* Regression test for the bug where closing a container smeared its contents over the
   player's crafting grid and emptied the hotbar.

   server.js is a single self-contained file (no exports), so the function under test is
   lifted out of it verbatim and run against fake inventories. If it is ever edited into
   something that writes outside 9..44, these assertions fail. */
const fs = require('fs')
const src = fs.readFileSync(__dirname + '/server.js', 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')) } }

const m = src.match(/const syncInvFromGui = \(gui\) => \{[\s\S]*?\n    \}/)
if (!m) { console.log('  FAIL could not find syncInvFromGui in server.js'); process.exit(1) }
const factory = new Function('inv', m[0] + '\n return syncInvFromGui')
const sync = factory({ slots: new Array(46).fill(null) })

const it = (id, count) => ({ id: id, count: count || 1 })
const blank = () => new Array(46).fill(null)

/* ---- 1. chest (27 storage + 9 hotbar = 36 player-ish slots, 63 total) ---- */
{
  const inv = { slots: blank() }
  inv.slots[1] = it(764, 5)                      // something already in the 2x2 grid
  const gui = { slots: new Array(63).fill(null) }
  for (let i = 0; i < 27; i++) gui.slots[27 + i] = it(100 + i)   // container storage
  for (let i = 0; i < 9; i++)  gui.slots[54 + i] = it(900 + i)   // player hotbar
  factory(inv)(gui)
  ok('storage lands in 9..35', Array.from({ length: 27 }, (_, i) => inv.slots[9 + i] && inv.slots[9 + i].id).every((v, i) => v === 100 + i))
  ok('hotbar lands in 36..44', Array.from({ length: 9 }, (_, i) => inv.slots[36 + i] && inv.slots[36 + i].id).every((v, i) => v === 900 + i))
  ok('crafting grid untouched', inv.slots[0] === null && inv.slots[1].id === 764 && inv.slots[2] === null)
  ok('armour untouched', inv.slots[5] === null && inv.slots[6] === null)
  ok('offhand untouched', inv.slots[45] === null)
}

/* ---- 2. window 0 (46 slots) is not a multiple of 9: it must be ignored here,
       because the window_items handler replaces inv.slots wholesale ---- */
{
  const inv = { slots: blank() }
  inv.slots[9] = it(764)
  const gui = { slots: new Array(46).fill(null) }
  gui.slots[0] = it(515)
  factory(inv)(gui)
  ok('window0 snapshot ignored (46 % 9 != 0)', inv.slots[9].id === 764 && inv.slots[0] === null && inv.slots[36] === null)
}

/* ---- 2b. dispenser: 9 container + 36 player = 45, offset must be 9 ---- */
{
  const inv = { slots: blank() }
  const gui = { slots: new Array(45).fill(null) }
  for (let i = 0; i < 9; i++) gui.slots[i] = it(700 + i)
  for (let i = 0; i < 27; i++) gui.slots[9 + i] = it(200 + i)
  for (let i = 0; i < 9; i++) gui.slots[36 + i] = it(800 + i)
  factory(inv)(gui)
  ok('dispenser: main from offset 9', inv.slots[9].id === 200)
  ok('dispenser: hotbar from offset 36', inv.slots[36].id === 800)
  ok('dispenser: grid empty', inv.slots[0] === null && inv.slots[1] === null)
}

/* ---- 3. after closing, /api/state must not show container goods in the grid ---- */
{
  const inv = { slots: blank() }
  const gui = { slots: new Array(63).fill(null) }
  gui.slots[27] = it(515); gui.slots[54] = it(764)
  factory(inv)(gui)
  ok('closed: grid empty', inv.slots[0] === null && inv.slots[1] === null && inv.slots[4] === null)
  ok('closed: hotbar slot 0 = hotbar item', inv.slots[36].id === 764)
  ok('closed: storage slot 0 = container item', inv.slots[9].id === 515)
}

/* ---- 4. a shorter window (9x1 hopper etc.) must not move anything ---- */
{
  const inv = { slots: blank() }
  const gui = { slots: new Array(9).fill(null) }
  factory(inv)(gui)
  ok('small window leaves inv alone', inv.slots.every(s => s === null))
}

/* ---- 5. an item poker (shift-click) that empties a source slot keeps nulls ---- */
{
  const inv = { slots: blank() }
  inv.slots[9] = it(764); inv.slots[36] = it(22)
  const gui = { slots: new Array(63).fill(null) }
  gui.slots[27] = null; gui.slots[54] = it(22)
  factory(inv)(gui)
  ok('emptied slot becomes null, not stale', inv.slots[9] === null)
  ok('hotbar still consistent', inv.slots[36].id === 22)
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
