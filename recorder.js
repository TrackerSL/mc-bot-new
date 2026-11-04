'use strict'
// records EVERY packet a real vanilla client exchanges with the server.
// vanilla joins 127.0.0.1:25566 (here) -> forwarded to the real server.
//   node recorder.js            (then point the client's SERVER_IP/PORT here)
const net = require('net')
const zlib = require('zlib')
const path = require('path')
process.env.ENV_FILE = process.env.ENV_FILE || path.join(__dirname, '.env')
const { decodePacket, MAPS } = require('./server.js')

const UP_HOST = process.env.UP_HOST || 'mc.cwresports.lk'
const UP_PORT = parseInt(process.env.UP_PORT || '25565', 10)
const LISTEN = parseInt(process.env.LISTEN_PORT || '25566', 10)
const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(6, ' ')
const interesting = new Map([
  ['keep_alive', 0], ['position', 1], ['position_look', 1], ['teleport_confirm', 1],
  ['chat_command', 1], ['chat_message', 1], ['settings', 1], ['custom_payload', 1],
  ['system_chat', 1], ['player_chat', 1], ['profileless_chat', 1], ['kick_disconnect', 1],
  ['disconnect', 1], ['login', 1], ['finish_configuration', 1], ['success', 1],
  ['login_start', 1], ['login_acknowledged', 1], ['compress', 1], ['ping', 1], ['pong', 1],
  ['keep_alive', 1], ['chat_session_update', 1], ['message_acknowledgement', 1],
  ['add_resource_pack', 1], ['resource_pack_receive', 1], ['encryption_begin', 1],
  ['login_plugin_request', 1], ['login_plugin_response', 1], ['set_protocol', 1],
  ['update_health', 1], ['spawn_position', 1], ['player_info', 1], ['player_remove', 1],
  ['game_event', 1], ['entity_event', 1], ['player_combat', 1]
])

let sessions = 0
const server = net.createServer(client => {
  const sid = ++sessions
  const tag = `[s${sid}]`
  console.log(`${ms()} ${tag} === new connection ===`)
  let state = 'handshaking'
  let upState = 'handshaking' // what we (as server) expect from client — separate from downstream
  let threshold = -1
  const up = net.connect(UP_PORT, UP_HOST, () => console.log(`${ms()} ${tag} upstream connected`))

  /* generic framed reader per direction */
  function makeReader (dir, onPacket) {
    let buf = Buffer.alloc(0)
    return chunk => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const len = tryVarint(buf, 0)
        if (!len) return
        if (buf.length < len.size + len.value) return
        let body = buf.slice(len.size, len.size + len.value)
        buf = buf.slice(len.value + len.size)
        try {
          if (threshold >= 0) {
            const d = tryVarint(body, 0)
            if (!d) throw new Error('bad frame')
            const ulen = d.value
            const rest = body.slice(d.size)
            body = ulen === 0 ? rest : zlib.inflateSync(rest, { maxOutputLength: 64 * 1024 * 1024 })
          }
          onPacket(body)
        } catch (e) {
          console.log(`${ms()} ${tag} ${dir} frame error: ${e.message}`)
        }
      }
    }
  }
  function tryVarint (b, off) {
    let num = 0, shift = 0, c = 0
    for (;;) {
      if (off + c >= b.length) return null
      const byte = b[off + c]; c++
      num |= (byte & 0x7f) << shift
      shift += 7
      if ((byte & 0x80) === 0) break
      if (c >= 5) return null
    }
    return { value: num >>> 0, size: c }
  }
  function idSize (raw) {
    let c = 0
    for (;;) {
      const b = raw[c++]
      if ((b & 0x80) === 0 || c > 6) break
    }
    return c
  }

  const brief = (name, p) => {
    if (!p) return ''
    try {
      switch (name) {
        case 'custom_payload': {
          const d = p.data || Buffer.alloc(0)
          return `${p.channel} ${JSON.stringify(d.toString('utf8').replace(/[^\x20-\x7e]/g, '.').slice(0, 80))}`
        }
        case 'system_chat':
        case 'kick_disconnect':
        case 'disconnect':
          return JSON.stringify((typeof p.content === 'object' || typeof p.reason === 'object'
            ? '' : '')).slice(0, 0) + (name === 'system_chat' ? 'nbt' : 'nbt')
        case 'position': return `id=${p.teleportId} pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} flags=${p.flags}`
        case 'teleport_confirm': return `id=${p.teleportId}`
        case 'keep_alive': return `id=${p.keepAliveId}`
        case 'settings': return `${p.locale} vd=${p.viewDistance} colors=${p.chatColors} skin=${p.skinParts} hand=${p.mainHand}`
        case 'login_start': return `${p.username} uuid=${Buffer.isBuffer(p.playerUUID) ? p.playerUUID.toString('hex') : p.playerUUID}`
        case 'set_protocol': return `proto=${p.protocolVersion} host=${p.serverHost}:${p.serverPort} next=${p.nextState}`
        case 'chat_message': return JSON.stringify(p.message)
        case 'chat_command': return JSON.stringify('/' + p.command)
        case 'login': return `entity=${p.entityId} mode=${p.gameMode}`
        case 'success': return `${p.username}`
        case 'compress': return `threshold=${p.threshold}`
        case 'chat_session_update': return JSON.stringify(p).slice(0, 120)
        default: return Object.keys(p).length ? Object.keys(p).join(',') : ''
      }
    } catch { return '' }
  }

  const hex = b => b.slice(0, 48).toString('hex')
  // full payload dump for kick/disconnect so the exact reason text survives
  const fullHex = b => b.toString('hex')
  const plainFromNbt = b => { try { const t = b.toString('latin1'); return (t.match(/[ -~]{4,}/g) || []).join(' | ') } catch { return '' } }

  const handleBoth = (dir, curStateRef) => body => {
    const idr = tryVarint(body, 0)
    if (!idr) return
    const id = idr.value
    const payload = body.slice(idSize(body))
    const cur = curStateRef()
    // RAW-id state machine (independent of name maps — bulletproof)
    if (dir === 'toServer' && cur === 'handshaking' && id === 0x0) {
      cState = 'login'
    } else if (dir === 'toClient' && cur === 'login' && id === 0x3) {
      const t = tryVarint(payload, 0)
      if (t) { threshold = t.value; console.log(`${ms()} ${tag} ## compression threshold ${threshold}`) }
    } else if (dir === 'toServer' && cur === 'login' && id === 0x3) {
      cState = 'configuration'
    } else if (dir === 'toServer' && cur === 'configuration' && id === 0x2) {
      cState = 'play'
    }
    const m = MAPS[cur][dir]
    const name = m ? m.id2name.get(id) : undefined
    if (frameCount < 6) {
      frameCount++
      console.log(`${ms()} ${tag} ${dir} ${cur} raw id=0x${id.toString(16)} len=${body.length} ${hex(body)}`)
    }
    if (!name) {
      unknownCount++
      if (unknownCount <= 40) console.log(`${ms()} ${tag} ${dir} ${cur} UNKNOWN id=0x${id.toString(16)} (${payload.length}b)`)
      if (unknownCount === 41) console.log(`${ms()} ${tag} ## unknown-frame flood suppressed`)
      return
    }
    // log EVERY packet (full visibility for diffs) — brief details for interesting ones
    const briefable = interesting.has(name)
    let params = null
    if (briefable) {
      try { params = decodePacket(cur, dir, id, payload).params } catch (e) { params = { _err: e.message } }
    }
    if (process.env.FULL && cur === 'play') console.log(`${ms()} ${tag} ${dir} HEX ${name} ${fullHex(payload)}`)
    if (name === 'kick_disconnect') {
      console.log(`${ms()} ${tag} ${dir} kick RAW ${hex(payload)}`)
      console.log(`${ms()} ${tag} ${dir} kick FULLHEX ${fullHex(payload)}`)
      console.log(`${ms()} ${tag} ${dir} kick TEXT ${plainFromNbt(payload)}`)
    }
    console.log(`${ms()} ${tag} ${dir.padEnd(4)} ${cur.padEnd(13)} ${name} (${payload.length}b) ${briefable ? brief(name, params) : ''}`)
  }

  let cState = 'handshaking'
  let frameCount = 0
  let unknownCount = 0
  const clientReader = makeReader('C->S', handleBoth('toServer', () => cState))
  const serverReader = makeReader('S->C', handleBoth('toClient', () => cState))

  client.on('data', d => { clientReader(d); up.write(d) })
  up.on('data', d => { serverReader(d); client.write(d) })
  const bye = why => {
    console.log(`${ms()} ${tag} === closed: ${why} ===`)
    try { client.destroy() } catch {}
    try { up.destroy() } catch {}
  }
  client.on('error', e => bye('client ' + e.message))
  up.on('error', e => bye('upstream ' + e.message))
  client.on('close', () => bye('client closed'))
  up.on('close', () => bye('upstream closed'))
})

server.listen(LISTEN, '127.0.0.1', () => console.log(`recorder: client -> 127.0.0.1:${LISTEN} -> ${UP_HOST}:${UP_PORT}`))
