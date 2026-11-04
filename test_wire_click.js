// Byte-level check of the Click Container packet against the 1.20.4 spec:
// id | windowId u8 | stateId varint | slot i16 | button i8 | mode varint
//    | changed: varint n { location i16, slot } | carried slot
// slot = present bool | itemId varint | count i8 | anonymous NBT (0x00 = absent)
const m = require('/home/user/vanilla-node/server.js')
let pass = 0, fail = 0
const T = (n, c, x) => { if (c) { pass++; console.log('  ok  ' + n) } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x) : '')) } }

function parse (buf) {
  let i = 0
  const uv = () => { let n = 0, s = 0; for (;;) { const b = buf[i++]; n |= (b & 0x7f) << s; if (!(b & 0x80)) return n >>> 0; s += 7 } }
  const slot = () => {
    const present = buf.readInt8(i++) === 1
    if (!present) return { present: false }
    const itemId = uv()
    const itemCount = buf.readInt8(i++)
    const start = i
    if (buf[i] !== 0) { const src = { b: buf, off: i }; m.readNbtTagged(src); i = src.off } else i += 1
    const nbt = Buffer.from(buf.subarray(start, i))
    return { present: true, itemId, itemCount, nbt: nbt.toString('hex') }
  }
  const id = uv()
  const windowId = buf.readInt8(i++)
  const stateId = uv()
  const slotIdx = buf.readInt16BE(i); i += 2
  const button = buf.readInt8(i++)
  const mode = uv()
  const n = uv()
  const changed = []
  for (let k = 0; k < n; k++) { const location = buf.readInt16BE(i); i += 2; changed.push({ location, item: slot() }) }
  const carried = slot()
  return { id, windowId, stateId, slotIdx, button, mode, changed, carried, bytesLeft: buf.length - i }
}

const nbt = { __t: 10, v: [['display', { __t: 10, v: [['Name', { __t: 8, v: 'Hi' }]] }]] }
const pkt = m.encodePacket('play', 'toServer', 'window_click', {
  windowId: 1, stateId: 7, slot: 3, mouseButton: 1, mode: 0,
  changedSlots: [
    { location: 3, item: { present: true, itemId: 1, itemCount: 64, nbtData: null } },
    { location: 4, item: { present: false } }
  ],
  cursorItem: { present: true, itemId: 834, itemCount: 1, nbtData: nbt }
})
const p = parse(pkt)
T('packet id 13 (window_click)', p.id === 13, p.id)
T('windowId 1', p.windowId === 1, p.windowId)
T('stateId 7', p.stateId === 7, p.stateId)
T('slot 3 (i16)', p.slotIdx === 3, p.slotIdx)
T('button 1', p.button === 1, p.button)
T('mode 0', p.mode === 0, p.mode)
T('two changed slots', p.changed.length === 2)
T('changed[0] loc3 64x id1, nbt absent=0x00', p.changed[0].location === 3 && p.changed[0].item.itemCount === 64 && p.changed[0].item.itemId === 1 && p.changed[0].item.nbt === '00', p.changed[0])
T('changed[1] loc4 empty (present=0)', p.changed[1].location === 4 && p.changed[1].item.present === false, p.changed[1])
T('carried sword with nbt', p.carried.itemId === 834 && p.carried.itemCount === 1 && p.carried.nbt.length > 4, p.carried)
T('no trailing bytes', p.bytesLeft === 0, p.bytesLeft)

// quick-craft start packet: slot -999 is legal and encodes as a negative i16
const drag = m.encodePacket('play', 'toServer', 'window_click', {
  windowId: 1, stateId: 9, slot: -999, mouseButton: 5, mode: 5,
  changedSlots: [], cursorItem: { present: false }
})
const d = parse(drag)
T('drag START: slot -999, button 5, mode 5', d.slotIdx === -999 && d.button === 5 && d.mode === 5, d)
T('empty changed slots + empty carried', d.changed.length === 0 && d.carried.present === false)

// every mode/button the UI can emit must encode
let encoded = 0
for (const mode of [0, 1, 2, 4, 5, 6]) {
  for (const button of [0, 1, 2, 4, 5, 6, 8, 40]) {
    const b = m.encodePacket('play', 'toServer', 'window_click', {
      windowId: 0, stateId: 0, slot: 9, mouseButton: button, mode,
      changedSlots: [{ location: 9, item: { present: false } }], cursorItem: { present: false }
    })
    if (b.length > 8) encoded++
  }
}
T('all mode/button combinations encode', encoded === 48, encoded)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
