// Vanilla-expectation suite for the menu engine.
// Every expectation comes from the decompiled 1.20.4 AbstractContainerMenu /
// ServerboundContainerClickPacket / per-menu quickMoveStack sources.
const m = require('./server.js')
let pass = 0, fail = 0
const T = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')) } }

const empty = { present: false }
const st = (id, n, nbt) => ({ present: true, itemId: id, itemCount: n, nbtData: nbt || null })
const mk = (arr, opts = {}) => ({ slots: arr.slice(), cursor: opts.cursor || empty, layout: opts.layout || m.menuLayout(opts.gui || null), drag: null, inv: opts.inv || { slots: [] } })

// ---------- stack sizes (parsed from the 1.20.4 Items class initialiser) ----------
T('diamond sword stacks to 1', m.maxStackOf(834) === 1)
T('ender pearl stacks to 16', m.maxStackOf(990) === 16)
T('stone stacks to 64', m.maxStackOf(1) === 64)
T('water bucket stacks to 1', m.maxStackOf(906) === 1)

// ---------- PICKUP left ----------
{
  const L = mk([st(1, 64), empty])
  m.doClickSim(L, 0, 0, 0)
  T('left pick: slot -> cursor', L.cursor.itemCount === 64 && m.stEmpty(L.slots[0]))
  m.doClickSim(L, 1, 0, 0)
  T('left place all into an empty slot', L.slots[1].itemCount === 64 && m.stEmpty(L.cursor))
}
{
  const L = mk([st(1, 64), st(1, 10)])
  L.cursor = st(1, 20)
  m.doClickSim(L, 1, 0, 0)
  T('left merge (10+20 <= 64)', L.slots[1].itemCount === 30 && m.stEmpty(L.cursor))
}
{
  const L = mk([st(1, 64), st(2, 10)])
  L.cursor = st(1, 5)
  m.doClickSim(L, 1, 0, 0)
  T('left swap different items', L.slots[1].itemId === 1 && L.slots[1].itemCount === 5 && L.cursor.itemId === 2 && L.cursor.itemCount === 10)
}
{
  const L = mk([empty])
  L.cursor = st(990, 20) // 20 pearls, max 16
  m.doClickSim(L, 0, 0, 0)
  T('left place respects the stack limit', L.slots[0].itemCount === 16 && L.cursor.itemCount === 4)
}

// ---------- PICKUP right ----------
{
  const L = mk([st(1, 11)])
  m.doClickSim(L, 0, 1, 0)
  T('right pick half rounds up', L.cursor.itemCount === 6 && L.slots[0].itemCount === 5)
}
{
  const L = mk([empty])
  L.cursor = st(1, 10)
  m.doClickSim(L, 0, 1, 0)
  T('right place one', L.slots[0].itemCount === 1 && L.cursor.itemCount === 9)
}
{
  const L = mk([st(1, 10)])
  L.cursor = st(1, 5)
  m.doClickSim(L, 0, 1, 0)
  T('right merge one', L.slots[0].itemCount === 11 && L.cursor.itemCount === 4)
}

// ---------- outside click ----------
{
  const L = mk([empty])
  L.cursor = st(1, 10)
  m.doClickSim(L, -999, 0, 0)
  T('outside left drops the whole cursor', m.stEmpty(L.cursor))
  L.cursor = st(1, 10)
  m.doClickSim(L, -999, 1, 0)
  T('outside right drops one', L.cursor.itemCount === 9)
}

// ---------- QUICK_MOVE ----------
{
  const gui = { id: 1, type: 2, slots: new Array(63).fill(empty) }
  gui.slots[0] = st(1, 64)
  const L = mk(gui.slots, { gui })
  m.doClickSim(L, 0, 0, 1)
  T('chest shift: container -> hotbar first', L.slots[62].itemCount === 64 && m.stEmpty(L.slots[0]))
}
{
  const gui = { id: 1, type: 2, slots: new Array(63).fill(empty) }
  gui.slots[30] = st(1, 64)
  const L = mk(gui.slots, { gui })
  m.doClickSim(L, 30, 0, 1)
  T('chest shift: player -> container', L.slots[0].itemCount === 64 && m.stEmpty(L.slots[30]))
}
{
  const slots = new Array(46).fill(empty)
  slots[10] = st(1, 32)
  const L = mk(slots)
  m.doClickSim(L, 10, 0, 1)
  T('inventory shift: main -> hotbar only', L.slots[36].itemCount === 32 && m.stEmpty(L.slots[10]))
}
{
  const slots = new Array(46).fill(empty)
  slots[40] = st(1, 32)
  const L = mk(slots)
  m.doClickSim(L, 40, 0, 1)
  T('inventory shift: hotbar -> main only', L.slots[9].itemCount === 32 && m.stEmpty(L.slots[40]))
}

// ---------- SWAP ----------
{
  const slots = new Array(46).fill(empty)
  slots[9] = st(1, 10); slots[36] = st(2, 5)
  const L = mk(slots)
  m.doClickSim(L, 9, 0, 2)
  T('number key swap', L.slots[9].itemId === 2 && L.slots[36].itemId === 1)
}
{
  const slots = new Array(46).fill(empty)
  slots[9] = st(834, 1); slots[37] = st(1, 64)
  const L = mk(slots)
  m.doClickSim(L, 9, 1, 2)
  T('swap exchanges whole stacks', L.slots[9].itemId === 1 && L.slots[9].itemCount === 64 && L.slots[37].itemId === 834)
}

// ---------- THROW ----------
{
  const slots = new Array(46).fill(empty)
  slots[9] = st(1, 10)
  const L = mk(slots)
  m.doClickSim(L, 9, 0, 4)
  T('Q drops one', L.slots[9].itemCount === 9)
  m.doClickSim(L, 9, 1, 4)
  T('shift+Q drops the stack', m.stEmpty(L.slots[9]))
}
{
  const slots = new Array(46).fill(empty)
  slots[9] = st(1, 10)
  const L = mk(slots)
  L.cursor = st(1, 3)
  m.doClickSim(L, 9, 1, 4)
  T('Q is ignored while carrying', L.slots[9].itemCount === 10 && L.cursor.itemCount === 3)
}

// ---------- QUICK_CRAFT ----------
{
  const slots = new Array(46).fill(empty)
  const L = mk(slots)
  L.cursor = st(1, 10)
  m.doClickSim(L, -999, 0 | (1 << 2), 5)
  T('drag start (right) records the type', L.drag && L.drag.type === 1)
  m.doClickSim(L, 9, 1 | (1 << 2), 5)
  m.doClickSim(L, 10, 1 | (1 << 2), 5)
  m.doClickSim(L, -999, 2 | (1 << 2), 5)
  T('right drag places one per slot', L.slots[9].itemCount === 1 && L.slots[10].itemCount === 1 && L.cursor.itemCount === 8 && L.drag === null)
}
{
  const slots = new Array(46).fill(empty)
  const L = mk(slots)
  L.cursor = st(1, 10)
  m.doClickSim(L, -999, 0, 5)
  m.doClickSim(L, 9, 1, 5)
  m.doClickSim(L, 10, 1, 5)
  m.doClickSim(L, -999, 2, 5)
  T('left drag splits evenly (floor of running/size)', L.slots[9].itemCount === 5 && L.slots[10].itemCount === 2 && L.cursor.itemCount === 3)
}
{
  const slots = new Array(46).fill(empty)
  const L = mk(slots)
  L.cursor = st(2, 4)
  m.doClickSim(L, -999, 0, 5)
  m.doClickSim(L, 9, 1, 5)
  m.doClickSim(L, -999, 2, 5)
  T('a single-slot drag acts as a plain click', L.slots[9].itemId === 2 && L.slots[9].itemCount === 4 && m.stEmpty(L.cursor))
}
{
  const L = mk(new Array(46).fill(empty))
  m.doClickSim(L, -999, 0, 5)
  T('drag with an empty cursor is ignored', L.drag === null)
}
{
  const slots = new Array(46).fill(empty)
  const L = mk(slots)
  L.cursor = st(1, 2)
  m.doClickSim(L, -999, 0, 5)
  m.doClickSim(L, 9, 1, 5)   // 2 > 0 -> accepted
  m.doClickSim(L, 10, 1, 5)  // 2 > 1 -> accepted
  m.doClickSim(L, 11, 1, 5)  // 2 > 2 false -> rejected
  T('drag stops once the cursor has no spare items', L.drag.slots.length === 2, L.drag)
}

// ---------- PICKUP_ALL ----------
{
  const slots = new Array(46).fill(empty)
  slots[10] = st(1, 30); slots[11] = st(1, 20); slots[12] = st(1, 64)
  const L = mk(slots)
  L.cursor = st(1, 10)
  m.doClickSim(L, 9, 0, 6)
  T('double-click gathers in two passes', L.cursor.itemCount === 64 && m.stEmpty(L.slots[10]) && m.stEmpty(L.slots[11]) && L.slots[12].itemCount === 60)
}
{
  const slots = new Array(46).fill(empty)
  slots[9] = st(1, 10)
  const L = mk(slots)
  L.cursor = st(1, 5)
  m.doClickSim(L, 9, 0, 6)
  T('gather needs an empty clicked slot', L.cursor.itemCount === 5 && L.slots[9].itemCount === 10)
}
{
  const slots = new Array(46).fill(empty)
  slots[0] = st(1, 4); slots[10] = st(1, 10)
  const L = mk(slots)
  L.cursor = st(1, 1)
  m.doClickSim(L, 1, 0, 6)
  T('gather skips the crafting result', L.slots[0].itemCount === 4 && m.stEmpty(L.slots[10]) && L.cursor.itemCount === 11)
}

// ---------- NBT ----------
{
  const u16 = (str) => { const b = Buffer.from(str, 'utf8'); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]) }
  const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b }
  const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(n); return b }
  const END = Buffer.from([0])
  // unnamed network NBT (1.20.2+): type, entries..., end
  const raw = Buffer.concat([
    Buffer.from([10]),
    Buffer.from([10]), u16('display'), Buffer.from([8]), u16('Name'), u16('Hi'), END,
    Buffer.from([9]), u16('Enchantments'), Buffer.from([10]), i32(1),
    Buffer.from([8]), u16('id'), u16('minecraft:sharpness'),
    Buffer.from([2]), u16('lvl'), Buffer.from([0, 3]), END,
    Buffer.from([4]), u16('L'), i64(1234567890123n),
    END
  ])
  const node = m.readNbtTagged({ b: raw, off: 0 })
  const back = m.writeNbtTagged(node)
  T('tagged NBT round-trips byte for byte', Buffer.compare(raw, back) === 0, { raw: raw.toString('hex'), back: back.toString('hex') })
  T('long tags survive', String(node.v.find(e => e[0] === 'L')[1].v) === '1234567890123')
  T('lists of compounds survive', node.v.find(e => e[0] === 'Enchantments')[1].v.items.length === 1)
  const L = mk([empty])
  L.cursor = { present: true, itemId: 1, itemCount: 1, nbtData: node }
  m.doClickSim(L, 0, 0, 0)
  T('NBT travels with the stack through a click', L.slots[0].nbtData && m.nbtEq(L.slots[0].nbtData, node))
}

// ---------- changed_slots diff ----------
{
  const inv = { slots: new Array(46).fill(empty), cursor: empty, stateId: 0 }
  const player = { menuDrag: null }
  const gui = { id: 1, type: 2, slots: new Array(63).fill(empty) }
  gui.slots[5] = st(1, 64)
  const r = m.predictClick({ inv, player }, gui, 5, 0, 0)
  T('predict: pick reports one changed slot + the carried stack', r.changed.length === 1 && r.changed[0].location === 5 && r.cursor.itemCount === 64)
  const r2 = m.predictClick({ inv, player }, gui, 7, 0, 0)
  T('predict: place reports one changed slot + an empty cursor', r2.changed.length === 1 && r2.changed[0].location === 7 && m.stEmpty(r2.cursor))
}

// ---------- layouts ----------
{
  const l0 = m.menuLayout(null)
  T('window 0 layout', l0.hotbar === 36 && l0.invStart === 9 && l0.offhand === 45 && l0.result === 0 && l0.qm === 'inventory')
  const lc = m.menuLayout({ id: 1, type: 2, slots: new Array(63).fill(empty) })
  T('generic_9x3 layout', lc.container === 27 && lc.hotbar === 54 && lc.qm === 'chest')
  const lf = m.menuLayout({ id: 1, type: 14, slots: new Array(39).fill(empty) })
  T('furnace layout', lf.container === 3 && lf.hotbar === 30 && lf.qm === 'furnace' && lf.result === 2)
  const lh = m.menuLayout({ id: 1, type: 16, slots: new Array(41).fill(empty) })
  T('hopper layout', lh.container === 5 && lh.qm === 'hopper')
  const lcr = m.menuLayout({ id: 1, type: 12, slots: new Array(46).fill(empty) })
  T('crafting table layout', lcr.container === 10 && lcr.result === 0 && lcr.qm === 'crafting')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
