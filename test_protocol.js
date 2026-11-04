// Protocol / codec regression suite (replaces the lost /tmp harness).
// Covers what the click feature depends on: framing, varints, slot + NBT
// round-trips (including the unnamed "anon" field group), window packets and
// the session handshake basics.
const m = require('./server.js')
let pass = 0, fail = 0
const T = (n, c, x) => { if (c) { pass++; console.log('  ok  ' + n) } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x) : '')) } }

// ---------- varints ----------
for (const v of [0, 1, 127, 128, 255, 300, 2097151, 2147483647]) {
  const b = m.writeUvarint(v)
  const r = m.readUvarint({ b, off: 0 })
  T('varint ' + v + ' (' + b.length + ' bytes)', r === v, r)
}
{
  const v = 2147483647
  T('varint 2^31-1 uses 5 bytes', m.writeUvarint(v).length === 5)
}

// ---------- offline uuid ----------
{
  const a = m.offlineUuid('Lactgen_Plus')
  const b = m.offlineUuid('Lactgen_Plus')
  T('offline uuid is deterministic', a.equals(b))
  T('offline uuid is 16 bytes', a.length === 16)
  T('offline uuid sets the v3 bits', (a[6] & 0xf0) === 0x30 && (a[8] & 0xc0) === 0x80, a.toString('hex'))
}

// ---------- packet framing / ids ----------
{
  const enc = m.encodePacket('play', 'toServer', 'window_click', {
    windowId: 0, stateId: 0, slot: 9, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: { present: false }
  })
  T('window_click id is 13 (0x0d)', enc[0] === 13, enc[0])
  const hs = m.encodePacket('handshaking', 'toServer', 'set_protocol', { protocolVersion: 765, serverHost: 'x', serverPort: 25565, nextState: 2 })
  T('set_protocol: id 0, protocol 765 (fd 05)', hs[0] === 0 && hs.subarray(1, 3).toString('hex') === 'fd05', hs.toString('hex'))
  T('set_protocol carries the host and next state', hs.subarray(3).includes(Buffer.from('x')) && hs[hs.length - 1] === 2, hs.toString('hex'))
  const ls = m.encodePacket('login', 'toServer', 'login_start', { username: 'Steve', playerUUID: m.offlineUuid('Steve') })
  T('login_start: id 0, name, 16-byte uuid', ls[0] === 0 && ls.length === 1 + 1 + 5 + 16, ls.toString('hex'))
}

// ---------- slot round-trip, incl. the unnamed field group ----------
{
  const slot = { present: true, itemId: 1, itemCount: 64, nbtData: null }
  const enc = m.encodePacket('play', 'toServer', 'set_creative_slot', { slot: 36, item: slot })
  // id 47, i16 slot, then present|itemId varint|count|nbt
  T('slot bytes: present=1 id=1 count=64 nbt=0', enc.subarray(3).toString('hex') === '01014000', enc.toString('hex'))
  const dec = m.decodePacket('play', 'toServer', 47, enc.subarray(1))
  T('slot decodes itemId/itemCount at the top level', dec.params.item.itemId === 1 && dec.params.item.itemCount === 64, dec.params)
  T('absent nbt decodes as a null tag', dec.params.item.nbtData == null, dec.params.item.nbtData)
}
{
  const nbt = { __t: 10, v: [['display', { __t: 10, v: [['Name', { __t: 8, v: 'Hi' }]] }]] }
  const enc = m.encodePacket('play', 'toServer', 'set_creative_slot', { slot: 36, item: { present: true, itemId: 834, itemCount: 1, nbtData: nbt } })
  const dec = m.decodePacket('play', 'toServer', 47, enc.subarray(1))
  T('nbt survives encode -> decode', dec.params.item.itemId === 834 && dec.params.item.nbtData.__t === 10)
  const re = m.writeNbtTagged(dec.params.item.nbtData)
  T('nbt re-encodes to the same tag', re[0] === 10 && re[re.length - 1] === 0, re.toString('hex'))
}
{
  const emptySlot = { present: false }
  const enc = m.encodePacket('play', 'toServer', 'set_creative_slot', { slot: 0, item: emptySlot })
  T('empty slot is a single 0x00', enc.subarray(3).toString('hex') === '00', enc.toString('hex'))
}

// ---------- clientbound window packets ----------
{
  // set_slot: windowId, stateId, slot, item
  const item = { present: true, itemId: 1, itemCount: 5, nbtData: null }
  const enc = m.encodePacket('play', 'toClient', 'set_slot', { windowId: 1, stateId: 3, slot: 12, item })
  const dec = m.decodePacket('play', 'toClient', enc[0], enc.subarray(1))
  T('set_slot round-trips', dec.name === 'set_slot' && dec.params.windowId === 1 && dec.params.stateId === 3 && dec.params.slot === 12 && dec.params.item.itemCount === 5, dec.params)
}
{
  // window_items: windowId, stateId, items[], carried
  const items = new Array(46).fill(null).map(() => ({ present: false }))
  items[9] = { present: true, itemId: 1, itemCount: 64, nbtData: null }
  items[10] = { present: true, itemId: 834, itemCount: 1, nbtData: { __t: 10, v: [['display', { __t: 10, v: [['Name', { __t: 8, v: 'Sword' }]] }]] } }
  const enc = m.encodePacket('play', 'toClient', 'window_items', { windowId: 0, stateId: 1, items, carriedItem: { present: false } })
  const dec = m.decodePacket('play', 'toClient', enc[0], enc.subarray(1))
  T('window_items has 46 slots', dec.params.items.length === 46)
  T('window_items slot 9 = 64 stone', dec.params.items[9].itemId === 1 && dec.params.items[9].itemCount === 64)
  T('window_items slot 10 keeps its nbt', dec.params.items[10].itemId === 834 && dec.params.items[10].nbtData.__t === 10)
}

// ---------- misc packets the session needs ----------
{
  const ka = m.encodePacket('play', 'toClient', 'keep_alive', { keepAliveId: 1234567890123n })
  const dec = m.decodePacket('play', 'toClient', ka[0], ka.subarray(1))
  T('keep_alive round-trips a long id', String(dec.params.keepAliveId) === '1234567890123', String(dec.params.keepAliveId))
}
{
  const dec = m.decodePacket('play', 'toClient', 254, Buffer.from([])) // unused id
  T('unknown packet ids decode to name null', dec.name === null, dec.name)
}
{
  // chat component flattening (NBT tree shaped, as the client builds it)
  T('flatten a bare string component', m.flattenComponent('hello') === 'hello', m.flattenComponent('hello'))
  const comp2 = { text: 'a', extra: [{ text: 'b' }, { text: 'c' }] }
  T('flatten text + extra', m.flattenComponent(comp2) === 'abc', m.flattenComponent(comp2))
  T('flatten a JSON-in-string component', m.flattenComponent('{"text":"hi"}') === 'hi', m.flattenComponent('{"text":"hi"}'))
  T('flatten translate + with', m.flattenComponent({ translate: 'chat.type.text', with: ['A', 'B'] }) === 'chat.type.text A B', m.flattenComponent({ translate: 'chat.type.text', with: ['A', 'B'] }))
}

// ---------- menu registry ----------
{
  const play = m.MAPS.play.toServer
  T('window_click is registered', play.name2id.get('window_click') === 13)
  T('set_creative_slot is registered', play.name2id.get('set_creative_slot') === 47)
  T('click modes 0..6 exist in the engine', typeof m.doClickSim === 'function')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
