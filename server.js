'use strict'
// vanilla-node — the vanilla game as ONE Node.js process.
// Speaks real Minecraft protocol 765 (1.20.4) over TCP: handshake, login,
// configuration, play — chat, commands, keep-alive, teleports — no Java,
// no game window, no virtual display. Zero dependencies.
//
//   npm start        (copy .env.example to .env first)
const net = require('net')
const zlib = require('zlib')
const LE_MODE = !!process.env.SONAR_LE_MODE // debug: replay the little-endian era
const OLD_SHAPE = !!process.env.SONAR_OLD_SHAPE // debug: replay the 8:42-8:58 survivor shape (delayed echo pairs)
const TICK_CLOSER = !!process.env.SONAR_TICK_CLOSER // send flying after every move packet (article's tick-end probe)
const REMINDERS = !!process.env.SONAR_REMINDERS
// pad terrain dumps: useful while reverse-engineering the arena, pure noise (and
// a 27-block sweep per teleport) in normal play — opt in with SONAR_VERBOSE=1
const VERBOSE = !!process.env.SONAR_VERBOSE // 20-tick position reminders (capture shows the real client stays silent while idle)
const DEBUG_CHAT = process.env.DEBUG_CHAT === '1'
const BUILD = '2026-11-05an'
const DEBUG_ITEM = process.env.DEBUG_ITEM === '1'
const DEBUG_SLOT = process.env.DEBUG_SLOT === '1'
const ICON_GUESS = process.env.ICON_GUESS === '1'   // off: the 1.20.4 registry is authoritative  // bump when the web UI or item tables change
// --- tick cadence of the verification replay (all in ms) -------------------
// a vanilla client runs one tick per 50ms: it can confirm at most ONE teleport
// per tick, and it reports at most one position per tick. Compressed replays
// (several movement packets per millisecond) are what bot detectors key on.
const CONFIRM1_MS = Number(process.env.SONAR_CONFIRM_MS || 800) // tp1 confirm after terrain load
const CONFIRM_GAP_MS = Number(process.env.SONAR_CONFIRM_GAP_MS || 5) // tp2 confirm (real client: +5ms)
const LOAD_PAUSE_MS = Number(process.env.SONAR_LOAD_PAUSE_MS || 3900) // terrain-load stall before the fall
const FALL_MS = Number(process.env.SONAR_FALL_MS || 10) // per-frame descent cadence (real client bursts)
// the arena plate is a bottom smooth_stone_slab at y=168: its top face is 168.5,
// i.e. spawnY (171) - 2.5. Measured from the real client's own landing plateau.
const FLOOR_DROP = Number(process.env.SONAR_FLOOR_DROP || 2.5)
// a vanilla client answers the gate's challenges from its tick loop, so the
// earliest it can reply is the next tick. Replying in the same millisecond is
// something only a bot does, so the echoes are held for ~one tick.
const ECHO_MS = Number(process.env.SONAR_ECHO_MS || 45)
const crypto = require('crypto')
const fs = require('fs')   // hoisted: the data tables below are read at module load
const path = require('path')
let mapCaptcha = null
try { mapCaptcha = require('./map_captcha.js') } catch (e) { mapCaptcha = null }

/* block collision categories per state-id range: 0 = passable, 1 = full cube,
   2 = half-height (slabs) — built from minecraft-data 1.20.4 blocks.json */
let BLOCK_RANGES = []
try { BLOCK_RANGES = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'blocks1204.json'), 'utf8')) } catch {}
/* ---- block shapes (1.20.4): names + collision boxes ------------------------
   The arena builds its own obstacle every session (a smooth-stone slab plate on
   one join, a cobblestone wall on the next), so a landing height cannot be
   hard-coded — the descent has to collide with the blocks actually on the wire.
   block_names.json is [name, minStateId, maxStateId] for every 1.20.4 block. */
let BLOCK_NAMES = []
try { BLOCK_NAMES = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'block_names.json'), 'utf8')) } catch {}
function blockNameForState (id) {
  let lo = 0, hi = BLOCK_NAMES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = BLOCK_NAMES[mid]
    if (id < r[1]) hi = mid - 1
    else if (id > r[2]) lo = mid + 1
    else return r[0]
  }
  return null
}
const NO_COLLIDE = /(^air$|cave_air|void_air|_air$|water$|lava$|^fire$|soul_fire|torch$|_torch$|wall_torch|redstone_wire|tripwire|rail$|_rail$|_sign$|wall_sign|_banner$|_button$|^lever$|_sapling$|^short_grass$|^grass$|^fern$|^dead_bush$|^dandelion$|^poppy$|_tulip$|_mushroom$|^sugar_cane$|^kelp$|_coral$|^cobweb$|^lily_pad$|^vine$|^hanging_roots$|^nether_sprouts$|^wheat$|^carrots$|^potatoes$|^beetroots$|_pressure_plate$|_flower_pot$|_head$|_skull$|^structure_void$|^light$|^barrier$|_candle$|^lantern$|^soul_lantern$|^chain$|^end_rod$|_roots$|^seagrass$|^tall_grass$|^large_fern$|^sunflower$|^lilac$|^rose_bush$|^peony$|^pink_petals$|^spore_blossom$|^azalea_leaves_flowers?$)/
// exact 1.20.4 collision boxes (block_shapes.json, coordinates in 1/16 units).
// The arena picks a different obstacle block on every join, so the shapes have
// to come from the real data instead of a per-block-name guess.
let SHAPE_DB = { shapes: [], blocks: [] }
try { SHAPE_DB = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'block_shapes.json'), 'utf8')) } catch {}
/* ---- item registry: protocol item id -> display name + texture ------------
   items1204.json is {id:{n:"display name", k:"registry_key"}} for 1.20.4;
   item_tex.json maps that key to the PNG it resolves to through the vanilla
   model chain (slabs use their base block, wood uses its log, ...). Both are
   generated from the 1.20.4 client assets, so icons are the real game art
   served locally — no CDN, works offline. */
let ITEM_NAMES = {}
let ITEM_TEX = {}
const ITEM_LOAD_ERR = []
try { ITEM_NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'items1204.json'), 'utf8')) } catch (e) { ITEM_LOAD_ERR.push('items1204.json: ' + e.message) }
try { ITEM_TEX = JSON.parse(fs.readFileSync(path.join(__dirname, 'item_tex.json'), 'utf8')) } catch (e) { ITEM_LOAD_ERR.push('item_tex.json: ' + e.message) }
if (!Object.keys(ITEM_NAMES).length || !Object.keys(ITEM_TEX).length) {
  // an empty registry means every slot falls back to a letter tile - say so, loudly
  console.error('FATAL: item tables did not load (' + (ITEM_LOAD_ERR.join('; ') || 'empty') + ') — run npm start from the folder that contains items1204.json')
  process.exit(1)
}
function shapeIndexForState (id) {
  const t = SHAPE_DB.blocks
  let lo = 0, hi = t.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, r = t[mid]
    if (id < r[0]) hi = mid - 1
    else if (id > r[1]) lo = mid + 1
    else return Array.isArray(r[2]) ? r[2][id - r[0]] : r[2]
  }
  return undefined
}
// collision boxes in block-local units [x0,y0,z0,x1,y1,z1]
function blockBoxes (stateId) {
  if (!stateId) return null
  const si = shapeIndexForState(stateId)
  const raw = si === undefined ? null : SHAPE_DB.shapes[si]
  if (raw && raw.length) return raw.map(b => [b[0] / 16, b[1] / 16, b[2] / 16, b[3] / 16, b[4] / 16, b[5] / 16])
  if (raw && !raw.length) return null // explicitly no collision
  // unknown state: fall back to the name heuristic below
  const name = blockNameForState(stateId)
  if (!name || NO_COLLIDE.test(name)) return null
  if (name.endsWith('_slab')) return [[0, 0, 0, 1, 0.5, 1]]
  if (name.endsWith('_wall') || name.endsWith('_fence')) return [[0.25, 0, 0.25, 0.75, 1.5, 0.75]]
  return [[0, 0, 0, 1, 1, 1]]
}
function blockCat (stateId) {
  if (stateId <= 0) return 0
  if (stateId > 262143) return 1
  let lo = 0, hi = BLOCK_RANGES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = BLOCK_RANGES[mid]
    if (stateId < r[0]) hi = mid - 1
    else if (stateId > r[1]) lo = mid + 1
    else return r[2]
  }
  return 1 // unknown state outside known ranges — treat solid (safe)
}
const readline = require('readline')

let ARENA_DONE_AT = 0   // timestamp: the gate's last ride was answered (see arena-reset)

/* ---------------- config (.env) ---------------- */
/* Which auth prompt is the server showing? CWR asks a fresh account to
   /register and an existing one to /login, and the two read very differently.
   Answering the wrong one costs the whole 180 s window. */
function authPromptMode (text) {
  const t = String(text || '')
  if (/^register time:/i.test(t.trim())) return 'register-countdown'
  if (/REGISTRATION REQUIRED|please register|register time:|register with \/register|Command: \/register|Example: \/register|\/register <pass|you are not registered|not registered!/i.test(t)) return 'register'
  // "Verify your account. Login time: 180s." is the pre-login countdown, not a request:
  // answering it early burned attempts (and counts as a failed login server-side).
  if (/^(verify your account\.?\s*)?login time:/i.test(t.trim())) return 'login-countdown'
  if (/authentication required|please complete authentication|Command: \/login|\/login <pass|welcome back|please log ?in/i.test(t)) return 'login'
  return null
}

/* What did the server say back to our /login or /register? AuthMe answers with
   plain chat, and it is the only place the real reason shows up (wrong password,
   password rules, already registered, …). */
/* CWR answers repeated bad logins with a temporary ban:
     Kicked by Console: … player uses wrong password too many times.
     Blacklisted! … Try again after: 29 minutes
   Walking back into that makes it worse, so parse the wait and honour it. */
function banInfo (text, name) {
  const t = String(text || '')
  if (!/blacklist|banned|wrong password too many|too many (failed )?(login )?attempts/i.test(t)) return null
  // CWR also broadcasts OTHER people's punishments into chat:
  //   [!] BINU_MC tempbanned LoginWesaw for 30 days for 'Using unauthorized mods'
  // Reading that as our own ban parked the bot for 30 minutes right after a good
  // transfer. Only a line that names us (or a kick straight from the console) counts.
  const who = String(name || '').toLowerCase()
  const targeted = (who && t.toLowerCase().includes(who)) ||
    /^(blacklisted!|kicked by console|kicked\b)/i.test(t.trim())
  if (!targeted) return null
  const m = t.match(/(\d+)\s*(minute|min|hour|second|sec)/i)
  let ms = 30 * 60 * 1000
  if (m) {
    const n = parseInt(m[1], 10)
    const unit = m[2].toLowerCase()
    ms = /hour/.test(unit) ? n * 3600000 : /min/.test(unit) ? n * 60000 : n * 1000
    ms += 15000
  }
  return { ms, text: t.replace(/\s+/g, ' ').slice(0, 160) }
}

function authReplyInfo (text) {
  const t = String(text || '')
  if (/already registered|already have an account|you are already registered/i.test(t)) return { kind: 'already', mode: 'login' }
  if (/not registered|you are not registered|register first/i.test(t)) return { kind: 'notreg', mode: 'register' }
  if (/wrong password|incorrect password|invalid password|password is incorrect/i.test(t)) return { kind: 'badpass', mode: null }
  if (/password (must|should|needs|is too|cannot)|minimum|maximum|at least|digits|letters|symbols/i.test(t)) return { kind: 'rule', mode: null }
  if (/login was successful|your login was successful|authentication successful|already logged in|welcome back .* to |successfully registered|registration successful/i.test(t)) return { kind: 'ok', mode: 'login' }
  return null
}

function loadEnvFile (file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    const q = val[0]
    const quoted = (q === '"' || q === "'") && val.length > 1
    if (quoted) {
      const end = val.indexOf(q, 1)
      val = end > 0 ? val.slice(1, end) : val.slice(1)   // keep a # that lives inside the quotes
    }
    // dotenv-style trailing comment: only for unquoted values, so
    // PASSWORD="a # b" still works. `KEY=value   # note` used to keep the note.
    else {
      const hash = val.search(/\s#/)
      if (hash >= 0) val = val.slice(0, hash).trim()
    }
    out[key] = val
  }
  return out
}
const envFile = process.env.ENV_FILE || path.join(__dirname, '.env')
const ENV = { ...loadEnvFile(envFile), ...process.env }
const cfg = {
  playerName: String(ENV.PLAYER_NAME || '').trim(),
  serverIp: String(ENV.SERVER_IP || '').trim(),
  serverPort: parseInt(ENV.SERVER_PORT || '25565', 10),
  password: ENV.PASSWORD || '',
  auth: /^(on|true|yes|1)$/i.test(ENV.AUTH || 'on'),
  antiAfk: /^(on|true|yes|1)$/i.test(ENV.ANTI_AFK || 'on'),
  // WEB=off keeps the console completely off (no port bound, no HTTP server)
  web: /^(on|true|yes|1)$/i.test(ENV.WEB || 'on'),
  // Render (and most PaaS) hand you a port in $PORT and require the service to bind
  // it. Order: WEB_PORT from the environment > $PORT > WEB_PORT from .env > 8080.
  // $PORT has to beat a stale WEB_PORT in .env, or the host's port check fails.
  webPort: (() => {
    const n = parseInt(process.env.WEB_PORT || process.env.PORT || ENV.WEB_PORT || '8080', 10)
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : 8080
  })(),
  // VERBOSE=on brings back the per-tick / per-entity lines. Off by default: on a
  // 0.1-CPU container that chatter is enough to starve the event loop, and a
  // starved client stops answering keep-alives (that is the ReadTimeout kick).
  verbose: /^(on|true|yes|1)$/i.test(ENV.VERBOSE || ''),
  delayMs: (() => { const n = parseInt(ENV.CMD_DELAY_MS || '5000', 10); return Number.isFinite(n) && n >= 0 ? n : 5000 })(),
  cmds: String(ENV.CMDS || '').split(',').map(s => s.trim()).filter(Boolean)
}
const missing = []
if (!cfg.playerName) missing.push('PLAYER_NAME')
if (!cfg.serverIp) missing.push('SERVER_IP')
if (cfg.auth && !cfg.password) missing.push('PASSWORD (when AUTH=on)')
if (missing.length) {
  // Only a direct run should refuse to start. The test suites `require('./server.js')`
  // to get at the codecs, and a checkout without a .env (the zip ships none, on purpose)
  // must still run them — exiting here killed two suites on a fresh extract.
  if (require.main === module) {
    console.error(`[bot] missing in .env: ${missing.join(', ')} — copy .env.example to .env and fill it in`)
    process.exit(1)
  }
}
const PROTOCOL_VERSION = 765 // Minecraft 1.20.4

const stamp = () => new Date().toLocaleTimeString()
const log = m => console.log(`[${stamp()} [bot] ${m}`.replace(/\]\[/, '] ['))
const chatLog = m => console.log(`[${stamp()}] ${m}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------------- protocol engine (driven by protocol.json) ---------------- */
const proto = JSON.parse(fs.readFileSync(path.join(__dirname, 'protocol.json'), 'utf8'))

function buildIdMaps (state, dir) {
  const types = proto[state][dir].types
  const mapperField = types.packet[1][0]
  const raw = mapperField.type[1].mappings
  const id2name = new Map()
  const name2id = new Map()
  for (const [k, name] of Object.entries(raw)) {
    const id = k.startsWith('0x') || k.startsWith('0X') ? parseInt(k, 16) : parseInt(k, 10)
    id2name.set(id, name)
    name2id.set(name, id)
  }
  const switchType = types.packet[1][1].type // ["switch", {compareTo, fields}]
  return { types, id2name, name2id, packetFields: switchType[1].fields }
}
const MAPS = {}
for (const state of ['handshaking', 'login', 'configuration', 'play']) {
  MAPS[state] = {
    toServer: buildIdMaps(state, 'toServer'),
    toClient: buildIdMaps(state, 'toClient')
  }
}

function resolveRef (ref, state, dir, depth = 0) {
  if (depth > 20) throw new Error('type recursion too deep: ' + ref)
  if (Array.isArray(ref)) return ref
  const local = MAPS[state][dir].types[ref]
  if (local) return local
  const g = proto.types[ref]
  if (g) return g
  if (ref === 'string') return ['pstring', { countType: 'varint' }]
  throw new Error(`unknown type ref: ${ref}`)
}

/* varint */
/* ---------- the map captcha ----------
   CWR's second verification ("Please enter the text in chat that is displayed on the
   map") draws a code into a 128x128 in-game map. A real player reads it off the screen;
   a headless client has to turn those colour indices into something a human can read.
   The colours themselves are not what matters — the glyph shapes are — so the image is
   binarised against the most common colour and upscaled 4x. */
const PNG_CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()
function pngChunk (type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  // the CRC covers the type and body only — including the length makes every chunk
  // invalid, which is what a strict viewer reports as "cannot process image"
  let c = -1
  for (let i = 0; i < typed.length; i++) c = PNG_CRC[(c ^ typed[i]) & 0xff] ^ (c >>> 8)
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ -1) >>> 0, 0)
  return Buffer.concat([len, typed, crc])
}
function pngFromGrey (cols, rows, grey, rgb, scale) {
  const sc = scale || 1
  const w = cols * sc, h = rows * sc
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1)
    raw[off] = 0
    const sy = Math.floor(y / sc)
    for (let x = 0; x < w; x++) {
      const si = sy * cols + Math.floor(x / sc)
      const o = off + 1 + x * 3
      // rgb=true takes a flat r,g,b,r,g,b... array of cols*rows*3 values
      if (rgb) { raw[o] = grey[si * 3]; raw[o + 1] = grey[si * 3 + 1]; raw[o + 2] = grey[si * 3 + 2] }
      else { raw[o] = raw[o + 1] = raw[o + 2] = grey[si] }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}
/* clientbound map: id varint, scale u8, locked bool, icons optional-array,
   width u8, then (if width>0) height u8, x i8, z i8, width*height colour bytes */
function decodeMapPacket (payload) {
  const src = { b: payload, off: 0 }
  const mapId = readUvarint(src)
  src.off += 1
  src.off += 1
  const hasIcons = payload[src.off++] === 1
  if (hasIcons) {
    const n = readUvarint(src)
    for (let i = 0; i < n; i++) {
      readUvarint(src)
      src.off += 3
      const hasName = payload[src.off++] === 1
      if (hasName) {
        const len = readUvarint(src)
        src.off += len
      }
    }
  }
  const cols = payload[src.off++]
  if (!cols) return null
  const rows = payload[src.off++]
  src.off += 2
  if (src.off + cols * rows > payload.length) return null
  return { id: mapId, cols, rows, data: payload.subarray(src.off, src.off + cols * rows) }
}

function readUvarint (src) {
  let num = 0, shift = 0, bytes = 0
  for (;;) {
    if (src.off >= src.b.length) throw new Error('varint overrun')
    const b = src.b[src.off++]
    num |= (b & 0x7f) << shift
    shift += 7
    bytes++
    if ((b & 0x80) === 0) break
    if (bytes >= 5) throw new Error('varint too long')
  }
  return num >>> 0
}
function writeUvarint (n) {
  n = n >>> 0
  const out = []
  for (;;) {
    if ((n & ~0x7f) === 0) { out.push(n); break }
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  return Buffer.from(out)
}

/* NBT (anonymous / network root) */
function readNbtValue (src, tag) {
  const need = n => { if (src.off + n > src.b.length) throw new Error('nbt overrun') }
  switch (tag) {
    case 1: need(1); return src.b.readInt8(src.off++)
    case 2: need(2); { const v = src.b.readInt16BE(src.off); src.off += 2; return v }
    case 3: need(4); { const v = src.b.readInt32BE(src.off); src.off += 4; return v }
    case 4: need(8); { const v = src.b.readBigInt64BE(src.off); src.off += 8; return v }
    case 5: need(4); { const v = src.b.readFloatBE(src.off); src.off += 4; return v }
    case 6: need(8); { const v = src.b.readDoubleBE(src.off); src.off += 8; return v }
    case 7: { const n = readI32BE(src); need(n); const v = src.b.slice(src.off, src.off + n); src.off += n; return v }
    case 8: { const n = readU16BE(src); need(n); const v = src.b.toString('utf8', src.off, src.off + n); src.off += n; return v }
    case 9: {
      const et = src.b[src.off++]
      const n = readI32BE(src)
      const arr = []
      for (let i = 0; i < n; i++) arr.push(et === 0 ? null : readNbtValue(src, et))
      return arr
    }
    case 10: {
      const obj = {}
      for (;;) {
        const t = src.b[src.off++]
        if (t === 0) break
        const name = readNbtValue(src, 8)
        obj[name] = readNbtValue(src, t)
      }
      return obj
    }
    case 11: { const n = readI32BE(src); const a = []; for (let i = 0; i < n; i++) a.push(readI32BE(src)); return a }
    case 12: { const n = readI32BE(src); const a = []; for (let i = 0; i < n; i++) { a.push(src.b.readBigInt64BE(src.off)); src.off += 8 } return a }
    default: throw new Error('bad nbt tag ' + tag)
  }
}
function readI32BE (src) { if (src.off + 4 > src.b.length) throw new Error('nbt'); const v = src.b.readInt32BE(src.off); src.off += 4; return v }
function readU16BE (src) { if (src.off + 2 > src.b.length) throw new Error('nbt'); const v = src.b.readUInt16BE(src.off); src.off += 2; return v }
function readAnonymousNbt (src) {
  if (src.off >= src.b.length) throw new Error('nbt empty')
  const tag = src.b[src.off++]
  if (tag === 0) return null
  return readNbtValue(src, tag)
}
/* slot NBT that keeps its wire tags: {__t, v} trees (lists = {__et, items},
   compounds = [[name, node], ...]) so a click can echo the exact bytes */
function readNbtTagged (src) {
  const need = n => { if (src.off + n > src.b.length) throw new Error('nbt overrun') }
  const tag = src.b[src.off++]
  if (tag === 0) return null
  const rd = (t) => {
    switch (t) {
      case 1: need(1); return src.b.readInt8(src.off++)
      case 2: need(2); { const v = src.b.readInt16BE(src.off); src.off += 2; return v }
      case 3: need(4); { const v = src.b.readInt32BE(src.off); src.off += 4; return v }
      case 4: need(8); { const v = src.b.readBigInt64BE(src.off); src.off += 8; return v }
      case 5: need(4); { const v = src.b.readFloatBE(src.off); src.off += 4; return v }
      case 6: need(8); { const v = src.b.readDoubleBE(src.off); src.off += 8; return v }
      case 7: { const n = readI32BE(src); need(n); const v = src.b.slice(src.off, src.off + n); src.off += n; return v }
      case 8: { const n = readU16BE(src); need(n); const v = src.b.toString('utf8', src.off, src.off + n); src.off += n; return v }
      case 9: {
        const et = src.b[src.off++]
        const n = readI32BE(src)
        const items = []
        for (let i = 0; i < n; i++) items.push(et === 0 ? null : { __t: et, v: rd(et) })
        return { __et: et, items }
      }
      case 10: {
        const entries = []
        for (;;) {
          const t2 = src.b[src.off++]
          if (!t2) break
          const name = rd(8)
          entries.push([name, { __t: t2, v: rd(t2) }])
        }
        return entries
      }
      case 11: { const n = readI32BE(src); const a = []; for (let i = 0; i < n; i++) a.push(readI32BE(src)); return a }
      case 12: { const n = readI32BE(src); const a = []; for (let i = 0; i < n; i++) { a.push(src.b.readBigInt64BE(src.off)); src.off += 8 } return a }
      default: throw new Error('bad nbt tag ' + t)
    }
  }
  return { __t: tag, v: rd(tag) }
}
function writeNbtTagged (node) {
  if (node == null) return Buffer.from([0x00])
  // defaultFor() fills an unset nbt field with 0 — that means "no tag"
  if (node.__t === undefined) {
    if (typeof node !== 'object') return Buffer.from([0x00])
    console.error('BADNBT node:', JSON.stringify(node).slice(0, 300))
    throw new Error('nbt node missing __t')
  }
  const tag = node.__t
  const v = node.v
  const parts = [Buffer.from([tag])]
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b }
  const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b }
  const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n), 0); return b }
  const str = (x) => { const b = Buffer.from(String(x), 'utf8'); return Buffer.concat([u16(b.length), b]) }
  switch (tag) {
    case 1: parts.push(Buffer.from([v & 0xff])); break
    case 2: { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); parts.push(b); break }
    case 3: parts.push(i32(v)); break
    case 4: parts.push(i64(v)); break
    case 5: { const b = Buffer.alloc(4); b.writeFloatBE(v, 0); parts.push(b); break }
    case 6: { const b = Buffer.alloc(8); b.writeDoubleBE(v, 0); parts.push(b); break }
    case 7: parts.push(i32(v.length), Buffer.isBuffer(v) ? v : Buffer.from(v)); break
    case 8: parts.push(str(v)); break
    case 9: {
      const et = v.__et
      parts.push(Buffer.from([et]), i32(v.items.length))
      // element payloads only — the element type was declared once at the header
      for (const it of v.items) if (et !== 0) parts.push(writeNbtPayload({ __t: et, v: it && it.__t !== undefined ? it.v : it }))
      break
    }
    case 10: {
      for (const [name, child] of v) parts.push(Buffer.from([child.__t]), str(name), writeNbtPayload(child))
      parts.push(Buffer.from([0x00]))
      break
    }
    case 11: { parts.push(i32(v.length)); for (const n of v) parts.push(i32(n)); break }
    case 12: { parts.push(i32(v.length)); for (const n of v) parts.push(i64(n)); break }
    default: throw new Error('bad nbt tag ' + tag)
  }
  return Buffer.concat(parts)
}
function writeNbtPayload (node) {
  const full = writeNbtTagged(node)
  return full.subarray(1) // strip the tag byte (already written by the caller)
}

/* generic type reader/writer */
function readVal (ref, src, ctx, state, dir) {
  if (typeof ref === 'string') {
    switch (ref) {
      case 'varint': return readUvarint(src)
      case 'varlong': { let num = 0n, shift = 0n; for (;;) { if (src.off >= src.b.length) throw new Error('varlong'); const b = src.b[src.off++]; num |= BigInt(b & 0x7f) << shift; shift += 7n; if ((b & 0x80) === 0) break } return num }
      case 'i8': return src.b.readInt8(src.off++)
      case 'u8': return src.b[src.off++]
      case 'i16': { const v = LE_MODE ? src.b.readInt16LE(src.off) : src.b.readInt16BE(src.off); src.off += 2; return v }
      case 'u16': { const v = LE_MODE ? src.b.readUInt16LE(src.off) : src.b.readUInt16BE(src.off); src.off += 2; return v }
      case 'i32': { const v = LE_MODE ? src.b.readInt32LE(src.off) : src.b.readInt32BE(src.off); src.off += 4; return v }
      case 'u32': { const v = LE_MODE ? src.b.readUInt32LE(src.off) : src.b.readUInt32BE(src.off); src.off += 4; return v }
      case 'i64': { if (src.off + 8 > src.b.length) throw new Error('i64'); const v = LE_MODE ? src.b.readBigInt64LE(src.off) : src.b.readBigInt64BE(src.off); src.off += 8; return v }
      case 'u64': { if (src.off + 8 > src.b.length) throw new Error('u64'); const v = src.b.readBigUInt64LE(src.off); src.off += 8; return v }
      case 'f32': { const v = LE_MODE ? src.b.readFloatLE(src.off) : src.b.readFloatBE(src.off); src.off += 4; return v }
      case 'f64': { const v = LE_MODE ? src.b.readDoubleLE(src.off) : src.b.readDoubleBE(src.off); src.off += 8; return v }
      case 'bool': return src.b[src.off++] !== 0
      case 'UUID': { if (src.off + 16 > src.b.length) throw new Error('uuid'); const v = src.b.slice(src.off, src.off + 16); src.off += 16; return v }
      case 'anonymousNbt': return readAnonymousNbt(src)
      case 'anonOptionalNbt': return readNbtTagged(src) // slot nbt: keep the tag bytes so clicks can echo them
      case 'restBuffer': { const v = src.b.slice(src.off); src.off = src.b.length; return v }
      case 'void': return null
      case 'native': throw new Error('unhandled native type')
      default: return readVal(resolveRef(ref, state, dir), src, ctx, state, dir)
    }
  }
  const [kind, opts] = ref
  switch (kind) {
    case 'pstring': {
      const n = readUvarint(src)
      if (src.off + n > src.b.length) throw new Error('string overrun')
      const v = src.b.toString('utf8', src.off, src.off + n)
      src.off += n
      return v
    }
    case 'buffer': {
      const n = opts.count !== undefined ? opts.count : readUvarint(src)
      if (src.off + n > src.b.length) throw new Error('buffer overrun')
      const v = src.b.slice(src.off, src.off + n)
      src.off += n
      return v
    }
    case 'container': {
      const vals = {}
      for (const f of opts) {
        const v = readVal(f.type, src, vals, state, dir)
        // an unnamed ("anon") field is a nested group: its members belong to this
        // container (1.20.4 Slot = present + anon{itemId, itemCount, nbt})
        if (f.anon) { if (v && typeof v === 'object') Object.assign(vals, v) } else vals[f.name] = v
      }
      return vals
    }
    case 'array': {
      const n = readUvarint(src)
      const out = []
      for (let i = 0; i < n; i++) out.push(readVal(opts.type, src, ctx, state, dir))
      return out
    }
    case 'option': {
      const has = src.b[src.off++] !== 0
      return has ? readVal(opts, src, ctx, state, dir) : null
    }
    case 'switch': {
      const key = String(ctx[opts.compareTo])
      const t = opts.fields[key] !== undefined ? opts.fields[key] : opts.default
      if (t === undefined || t === 'void' || t === null) return null
      return readVal(t, src, ctx, state, dir)
    }
    case 'mapper': {
      const id = readUvarint(src)
      const m = MAPS[state][dir] // only used inside packet wrapper (handled separately)
      const name = opts.mappings['0x' + id.toString(16)] ?? opts.mappings['0x' + id.toString(16).padStart(2, '0')] ?? opts.mappings[id]
      if (name === undefined) throw new Error('mapper id ' + id)
      return name
    }
    case 'bitfield': {
      // packed MSB-first across a big-endian integer (MC SectionPos longs)
      const fields = opts
      const total = fields.reduce((s, f) => s + f.size, 0)
      const nbytes = Math.ceil(total / 8)
      let acc = 0n
      for (let i = 0; i < nbytes; i++) { acc = (acc << 8n) | BigInt(src.b[src.off + i]) }
      src.off += nbytes
      const out = {}
      let shift = BigInt(total)
      for (const f of fields) {
        shift -= BigInt(f.size)
        let v = (acc >> shift) & ((1n << BigInt(f.size)) - 1n)
        if (f.signed && (v & (1n << (BigInt(f.size) - 1n))) !== 0) v -= 1n << BigInt(f.size)
        out[f.name] = Number(v)
      }
      return out
    }
    default: throw new Error('read: unknown kind ' + kind)
  }
}

function writeVal (ref, val, ctx, state, dir) {
  if (typeof ref === 'string') {
    switch (ref) {
      case 'varint': return writeUvarint(val)
      case 'varlong': { let n = BigInt(val), out = []; for (;;) { let b = Number(n & 0x7fn); n >>= 7n; if (n !== 0n) b |= 0x80; out.push(b); if (n === 0n) break } return Buffer.from(out) }
      case 'i8': { const b = Buffer.alloc(1); b.writeInt8(val, 0); return b }
      case 'u8': return Buffer.from([val & 0xff])
      case 'i16': { const b = Buffer.alloc(2); (LE_MODE ? b.writeInt16LE(val, 0) : b.writeInt16BE(val, 0)); return b }
      case 'u16': { const b = Buffer.alloc(2); (LE_MODE ? b.writeUInt16LE(val, 0) : b.writeUInt16BE(val, 0)); return b }
      case 'i32': { const b = Buffer.alloc(4); (LE_MODE ? b.writeInt32LE(val, 0) : b.writeInt32BE(val, 0)); return b }
      case 'u32': { const b = Buffer.alloc(4); (LE_MODE ? b.writeUInt32LE(val, 0) : b.writeUInt32BE(val, 0)); return b }
      case 'i64': { const b = Buffer.alloc(8); (LE_MODE ? b.writeBigInt64LE(BigInt(val), 0) : b.writeBigInt64BE(BigInt(val), 0)); return b }
      case 'u64': { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(val), 0); return b }
      case 'f32': { const b = Buffer.alloc(4); (LE_MODE ? b.writeFloatLE(val, 0) : b.writeFloatBE(val, 0)); return b }
      case 'f64': { const b = Buffer.alloc(8); (LE_MODE ? b.writeDoubleLE(val, 0) : b.writeDoubleBE(val, 0)); return b }
      case 'bool': return Buffer.from([val ? 1 : 0])
      case 'UUID': return Buffer.isBuffer(val) ? val : Buffer.from(String(val).replace(/-/g, ''), 'hex')
      case 'anonymousNbt':
      case 'anonOptionalNbt': return writeNbtTagged(val) // tag-direct: 0x00 = absent
      case 'restBuffer': return Buffer.isBuffer(val) ? val : Buffer.from(val || '')
      case 'void': return Buffer.alloc(0)
      default: return writeVal(resolveRef(ref, state, dir), val, ctx, state, dir)
    }
  }
  const [kind, opts] = ref
  switch (kind) {
    case 'pstring': {
      const b = Buffer.from(String(val), 'utf8')
      return Buffer.concat([writeUvarint(b.length), b])
    }
    case 'buffer': {
      const b = Buffer.isBuffer(val) ? val : Buffer.from(val || '')
      if (opts.count !== undefined) {
        const out = Buffer.alloc(opts.count)
        b.copy(out, 0, 0, opts.count)
        return out
      }
      return Buffer.concat([writeUvarint(b.length), b])
    }
    case 'container': {
      const vals = {}
      const parts = []
      for (const f of opts) {
        // an unnamed group writes straight from the parent object
        const v = f.anon ? (val || {}) : (val && val[f.name] !== undefined ? val[f.name] : defaultFor(f.type, state, dir))
        if (!f.anon) vals[f.name] = v
        parts.push(writeVal(f.type, v, vals, state, dir))
      }
      return Buffer.concat(parts)
    }
    case 'array': {
      const arr = Array.isArray(val) ? val : []
      const parts = [writeUvarint(arr.length)]
      for (const item of arr) parts.push(writeVal(opts.type, item, ctx, state, dir))
      return Buffer.concat(parts)
    }
    case 'option': {
      if (val === null || val === undefined) return Buffer.from([0])
      return Buffer.concat([Buffer.from([1]), writeVal(opts, val, ctx, state, dir)])
    }
    case 'switch': {
      const key = String(ctx[opts.compareTo])
      const t = opts.fields[key] !== undefined ? opts.fields[key] : opts.default
      if (t === undefined || t === 'void' || t === null) return Buffer.alloc(0)
      return writeVal(t, val, ctx, state, dir)
    }
    case 'mapper': {
      // field-level mapper: invert opts.mappings (name -> id), not the packet map
      let id
      if (opts && opts.mappings) {
        for (const [k, v] of Object.entries(opts.mappings)) if (v === val) { id = k; break }
      }
      if (id === undefined) id = MAPS[state][dir].name2id.get(val)
      if (id === undefined) throw new Error('mapper name ' + val)
      const n = typeof id === 'string' ? (id.startsWith('0x') || id.startsWith('0X') ? parseInt(id, 16) : parseInt(id, 10)) : id
      return writeUvarint(n)
    }
    case 'bitfield': {
      // mirror of readVal bitfield: pack MSB-first across a big-endian integer
      // (position = x:26, z:26, y:12 -> one i64)
      const total = opts.reduce((t, f) => t + f.size, 0)
      const nbytes = Math.ceil(total / 8)
      let acc = 0n
      for (const f of opts) {
        acc <<= BigInt(f.size)
        let v = BigInt(val && val[f.name] !== undefined ? val[f.name] : 0)
        v &= (1n << BigInt(f.size)) - 1n // two's-complement wrap for signed fields
        acc |= v
      }
      acc &= (1n << BigInt(total)) - 1n
      const out = Buffer.alloc(nbytes)
      for (let i = 0; i < nbytes; i++) out[i] = Number((acc >> BigInt(8 * (nbytes - 1 - i))) & 0xffn)
      return out
    }
    default: throw new Error('write: unknown kind ' + kind)
  }
}
function defaultFor (ref, state, dir) {
  if (Array.isArray(ref)) {
    const [kind, opts] = ref
    if (kind === 'option') return null
    if (kind === 'array') return []
    if (kind === 'buffer') return Buffer.alloc(opts.count || 0)
    if (kind === 'container') return {}
    if (kind === 'switch') return null
  }
  if (ref === 'void' || ref === 'anonymousNbt') return null
  if (ref === 'bool') return false
  if (ref === 'i64' || ref === 'u64' || ref === 'varlong') return 0
  if (ref === 'restBuffer') return Buffer.alloc(0)
  if (ref === 'UUID') return Buffer.alloc(16)
  if (ref === 'f32' || ref === 'f64') return 0
  return 0
}

/* packet encode / decode */
function decodePacket (state, dir, id, payload) {
  const m = MAPS[state][dir]
  const name = m.id2name.get(id)
  if (!name) return { id, name: null }
  const typeRef = m.packetFields[name]
  if (!typeRef) return { id, name, params: null }
  const src = { b: payload, off: 0 }
  const params = readVal(typeRef, src, {}, state, dir)
  return { id, name, params }
}
function encodePacket (state, dir, name, params) {
  const m = MAPS[state][dir]
  const id = m.name2id.get(name)
  if (id === undefined) throw new Error(`unknown packet ${state}/${dir}/${name}`)
  const typeRef = m.packetFields[name]
  const body = typeRef ? writeVal(typeRef, params || {}, {}, state, dir) : Buffer.alloc(0)
  return Buffer.concat([writeUvarint(id), body])
}

/* chat component (NBT tree) -> plain text. Servers like CWR put literal \u00a7 codes in
   the text itself; those are stripped here so log lines and the gate patterns only ever
   see readable words (the coloured form comes from legacyOf). */
function flattenComponent (n) { return String(flattenRaw(n)).replace(/§./g, '') }
function flattenRaw (n) {
  if (n === null || n === undefined) return ''
  if (typeof n === 'string') {
    // some servers stuff a full JSON component into a string tag
    const s = n.trim()
    if ((s.startsWith('{') || s.startsWith('[')) && s.length > 1) {
      try { return flattenRaw(JSON.parse(s)) } catch {}
    }
    return n
  }
  if (typeof n === 'number' || typeof n === 'bigint' || typeof n === 'boolean') return String(n)
  if (Array.isArray(n)) return n.map(flattenComponent).join('')
  if (Buffer.isBuffer(n)) return n.toString('utf8')
  if (typeof n === 'object') {
    let out = ''
    if (typeof n.text === 'string') out += n.text
    else if (typeof n.translate === 'string') {
      const withs = Array.isArray(n.with) ? n.with.map(flattenComponent).join(' ') : ''
      out += (n.fallback || n.translate) + (withs ? ' ' + withs : '')
    } else if (n.score) out += (n.score.value !== undefined && n.score.value !== null ? String(n.score.value) : String(n.score.name || ''))
    else if (typeof n.selector === 'string') out += n.selector
    else if (typeof n.keybind === 'string') out += n.keybind
    else if (typeof n.literal === 'string') out += n.literal
    if (Array.isArray(n.extra)) out += n.extra.map(flattenComponent).join('')
    return out
  }
  return ''
}

/* offline-mode UUID (Java nameUUIDFromBytes) */
function offlineUuid (name) {
  const md5 = crypto.createHash('md5').update(Buffer.from('OfflinePlayer:' + name, 'utf8')).digest()
  md5[6] = (md5[6] & 0x0f) | 0x30
  md5[8] = (md5[8] & 0x3f) | 0x80
  return md5
}

/* ---------------- command queue (delay BEFORE every send) ---------------- */
let gateWait = null
let gateOpen = null
function closeGate () {
  if (gateOpen) gateOpen() // flush waiters from the dead session (they fail fast)
  gateWait = new Promise(resolve => { gateOpen = resolve })
}
function openGate () { if (gateOpen) { gateOpen(); gateOpen = null } }
closeGate()

const queue = { items: [], running: false, sent: 0, size () { return this.items.length } }
queue.push = function (text) {
  return new Promise((resolve, reject) => {
    // a session re-push replaces a pending copy of the same command — no
    // duplicate sends, and a stale-gen copy can never shadow the fresh one
    const i = this.items.findIndex(x => x.text === String(text))
    if (i >= 0) this.items.splice(i, 1)
    this.items.push({ text: String(text), gen: sessionGen, resolve, reject })
    pump()
  })
}
async function pump () {
  if (queue.running) return
  queue.running = true
  while (queue.items.length) {
    const item = queue.items.shift()
    if (item.gen !== sessionGen) { // pushed into a session that has since died
      item.reject(new Error('stale session'))
      continue
    }
    const spec = verifyFor(item.text)
    const tries = spec ? spec.tries : 1
    let done = false, dropped = false, sendErr = null
    let attempt = 0
    while (!done && !dropped) {
      attempt++
      if (item.gen !== sessionGen) { dropped = true; break } // session moved on mid-wait
      if (attempt > tries) break
      await sleep(cfg.delayMs) // required gap — before the first command too
      sendErr = null
      try {
        await gateWait
        const pw = await SESSION_WAIT_PLAY(20000) // ride out server transfers before sending
        if (item.gen !== sessionGen) { dropped = true; break } // waited through a session change
        if (pw === 'ended') { dropped = true; break } // session died; the new session re-queues
        if (pw !== 'ok') throw new Error('not in play state')
        if (SESSION_SEND(item.text) === false) {
          // the session died between the wait and the send — the new session re-queues it
          log(`not in play — [${item.text}] handed to the next session`)
          dropped = true
          break
        }
        queue.sent++
        log(`sent [${item.text}] (queue left: ${queue.items.length})${attempt > 1 ? ` [retry ${attempt - 1}]` : ''}`)
      } catch (e) {
        log(`send failed [${item.text}]: ${e.message}`)
        sendErr = e
      }
      if (sendErr) {
        if (!spec) break // legacy behavior: skip it, keep the queue moving
        continue // verify-command: send again (lifesteal retries forever)
      }
      if (!spec) { done = true; break }
      const ok = SESSION_VERIFY ? await SESSION_VERIFY(spec, Date.now()) : false
      if (ok) {
        log(`verified [${item.text}] — ${spec.label}`)
        done = true
        if (spec.label === 'afk teleport') { try { SESSION_ACTIONS.afkStand && SESSION_ACTIONS.afkStand() } catch {} }
      }
      else {
        const t = tries === Infinity ? `${attempt}` : `${attempt}/${tries}`
        log(`verify: no ${spec.label} yet for [${item.text}] (attempt ${t}) — still waiting`)
      }
    }
    if (done) { item.resolve(); continue }
    if (dropped) {
      log(`dropped [${item.text}] — session changed; the new session re-queues it`)
      item.reject(new Error('stale session'))
      continue
    }
    if (!spec) { item.reject(sendErr || new Error('send failed')); continue } // plain cmd skipped, queue continues
    log(`queue halted: [${item.text}] never verified — holding back the rest`)
    item.reject(new Error('unverified'))
    while (queue.items.length) { const drop = queue.items.shift(); drop.reject(new Error('halted')) }
    break
  }
  queue.running = false
}
let SESSION_SEND = () => false
let sendBlocked = 0            // sends dropped because the session ended under us
let SESSION_ACTIONS = {} // vanilla interaction senders, rebound every session
// afkStand (per-session action): set once the server has teleported us to the
// AFK pad. Evidence: pacing even <1m on the pad draws a position correction
// every ~30s and a Cheat-Detection kick at ~3.5min, while standing still runs
// for hours. Lobby walking (real floor) is unaffected.
let SESSION_VERIFY = null // session-scoped: waits for a command's effect in chat/joins
let SESSION_WAIT_PLAY = () => Promise.resolve('ok') // session-scoped: 'ok' | 'timeout' | 'ended'
let sessionGen = 0 // bumped every runSession — queue items from a dead session are dropped
// 'login' | 'register' | null — what the server last asked for. Kept across
// sessions: a reconnect should not send /login to an account that must register.
let authPlan = null
    let captchaUntil = 0
let authFailWhy = null      // the server's own reason, when it gives one
let banUntil = 0            // set when the server temp-bans us for bad logins
/* what "the previous action worked" looks like per command */
function verifyFor (text) {
  // lifesteal: the server queue is ongoing — never fail it, re-send and keep
  // waiting (any session length) until we actually land on the mode-0 server
  if (/lifesteal/i.test(text)) return { chat: /Welcome[^\n]*to Lifesteal|Received kit/i, mode: 0, timeout: 120000, tries: Infinity, label: 'lifesteal join' }
  if (/(?:^|\s)\/afk\b/i.test(text)) return { chat: /\[TP\]/i, timeout: 15000, tries: 3, label: 'afk teleport' }
  return null
}

/* ---------------- one connection session ---------------- */
function runSession () {
  return new Promise(resolve => {
    let state = 'handshaking'
    let threshold = -1
    let buf = Buffer.alloc(0)
    let ended = false
    let ready = false        // AuthMe satisfied (or not required)
    let verifyDone = false   // Sonar verification completed (or N/A: warm account)
    let gateDone = false
    let authBusy = false
    let authStartedAt = 0
    let authCooldownUntil = 0
    let authWarned = false
    let cmdsQueued = false
    let pos = null // {x,y,z,yaw,pitch}
    let chatSeen = [] // recent inbound texts (for auth checks)
    let joinEvents = [] // {mode, at} — world joins seen this session (command-effect evidence)
    let curMode = null // game mode of the latest join (0 = survival/lifesteal)
    let cfgWatch = null // reconnect watchdog: config must finish within 30s
    let rxN = 0, txN = 0 // packet counters, for the heartbeat line
    let lastRx = Date.now() // last inbound packet, for the traffic watchdog
    let reconfN = 0     // server-initiated re-configurations seen this session
    sessionGen++
    const startedAt = Date.now()

    const socket = new net.Socket()
    let heartbeat = null
    const finish = reason => {
      if (ended) return
      ended = true
      try { clearLiveness && clearLiveness() } catch {}
      clearInterval(heartbeat)
      try { clearTimeout(tickTimer) } catch {}
      try { arena.active = false } catch {}
      try { for (const t of arena.timers) clearTimeout(t) } catch {}
      try { socket.destroy() } catch {}
      if (sendBlocked) log(`session ended with ${sendBlocked} queue item(s) dropped (not in play) — expected while re-connecting`)
      closeGate()
      resolve(reason)
    }

    /* send one packet in current state */
    let tickBatch = null
    const pkt = (dirState, name, params) => {
      // A vanilla client's connection state and its outgoing packets can never
      // disagree. Ours could: a 50ms tick loop and a 1s heartbeat keep sending
      // movement while the proxy has already switched our stream to CONFIG after
      // start_configuration. Velocity decodes those bytes with the CONFIG table,
      // where ids 0x00-0x05 are real packets — so a stray play packet becomes a
      // malformed `settings`/`resource_pack_receive` and the switch wedges.
      if (dirState === 'play' && state !== 'play') {
        playWhileConfig = (playWhileConfig || 0) + 1
        if (playWhileConfig <= 8) log(`!! blocked a play packet (${name}) while in ${state} — a vanilla client never sends this`)
        return false
      }
      const raw = encodePacket(dirState, 'toServer', name, params) // [id varint][payload]
      let body
      if (threshold >= 0) {
        if (raw.length >= threshold) {
          body = Buffer.concat([writeUvarint(raw.length), zlib.deflateSync(raw)])
        } else {
          body = Buffer.concat([writeUvarint(0), raw])
        }
      } else {
        body = raw
      }
      const frame = Buffer.concat([writeUvarint(body.length), body])
      txN++
      if (traceOn) traceLog('tx', dirState, name, raw.length)
      if (tickBatch) tickBatch.push(frame) // collected; flushed once per tick like vanilla
      else socket.write(frame)
    }

    /* payload -> [id varint size] (skip id) */
    function idSizeOf (raw) {
      let c = 0
      for (;;) {
        if (c >= raw.length) throw new Error('bad id')
        const b = raw[c++]
        if ((b & 0x80) === 0) break
      }
      return c
    }

    /* frame parsing */
    const feed = chunk => {
      lastRx = Date.now()
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const lenRes = tryVarint(buf, 0)
        if (!lenRes) return
        const { value: flen, size: lsize } = lenRes
        if (buf.length < lsize + flen) return
        let body = buf.slice(lsize, lsize + flen)
        buf = buf.slice(lsize + flen)
        rxN++
        let id = null
        let curPayload = null
        try {
          if (threshold >= 0) {
            const d = tryVarint(body, 0)
            if (!d) throw new Error('bad compressed frame')
            const ulen = d.value
            const rest = body.slice(d.size)
            if (ulen === 0) {
              body = rest
            } else {
              const inflated = zlib.inflateSync(rest, { maxOutputLength: 32 * 1024 * 1024 })
              // vanilla-style: trust the server's dataLen; some proxies emit
              // deflate streams that decompress slightly longer — truncate, don't die
              body = inflated.length >= ulen ? inflated.subarray(0, ulen) : inflated
            }
          }
          id = readUvarint({ b: body, off: 0 })
          const payload = body.slice(idSizeOf(body))
          curPayload = payload
          if (!player.mcRaw && state === 'play') {
            const nm0 = MAPS[state].toClient.id2name.get(id)
            if (nm0 === 'map_chunk') {
              player.mcRaw = true
              try { require('fs').writeFileSync('/tmp/mapchunk_raw.bin', payload) } catch {}
              log(`map_chunk raw captured len=${payload.length}`)
            }
          }
          handle(id, payload)
        } catch (e) {
          let nm = '0x' + (id != null ? id.toString(16) : '?')
          try { nm = (MAPS[state] && MAPS[state].toClient.id2name.get(id)) || nm } catch {}
          if (verifyDone && !arena.active) {
            // in the live world one odd packet must not kill the session —
            // frames are length-prefixed so skipping stays in sync
            if (nm === 'map_chunk' && curPayload && (player.mcFailN || 0) < 4) {
              player.mcFailN = (player.mcFailN || 0) + 1
              try { require('fs').writeFileSync('/tmp/mapchunk_fail' + player.mcFailN + '.bin', curPayload) } catch {}
              log(`map_chunk fail dump #${player.mcFailN} len=${curPayload.length}`)
            }
            log(`packet skipped [${nm}]: ${e.message}`)
            continue
          }
          log(`packet error [${nm}]: ${e.message} — reconnecting`)
          finish('restart')
          return
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

    /* inbound chat text pipeline */
    const captchaImagePath = () => path.join(process.cwd(), 'captcha-map.png')
    const onText = (text, speaker, coloured) => {
      try {
        const shown = coloured || text
        pushWebChat(speaker ? 'chat' : 'server', speaker ? `${speaker}: ${shown}` : shown)
      } catch {}
      if (!text) return
      const line = speaker ? `${speaker}: ${text}` : text
      const mention = cfg.playerName && text.toLowerCase().startsWith('@' + cfg.playerName.toLowerCase())
      chatLog(mention ? `★ MENTION ${line}` : `chat: ${line}`)
      if (/wrong answer|wrong captcha|incorrect! try again/i.test(text) && !speaker) {
        captchaMisses++;
        pendingCaptcha = null;
        // Only explicitly configured same-picture servers may spend another candidate.
        // Most inspected plugins replace the answer after a rejection.
        const samePicture = /^(on|true|yes|1)$/i.test(ENV.CAPTCHA_RETRY_SAME_MAP || '');
        const auto = !/^(off|false|no|0)$/i.test(ENV.CAPTCHA_AUTO || '');
        const next = captchaCandidates.find(t => !captchaTried.includes(t));
        const picture = lastMap ? Buffer.from(lastMap.data).toString('base64') : null;
        if (samePicture && auto && picture && next && captchaTried.length < 3 && captchaMisses < 2) {
          const generation = sessionGen;
          setTimeout(() => {
            if (generation !== sessionGen || !lastMap ||
                Buffer.from(lastMap.data).toString('base64') !== picture) {
              log('verify: map changed — cancelled stale candidate'); return;
            }
            if (SESSION_SEND(next)) { captchaTried.push(next); log(`verify: retried with "${next}"`); }
          }, 1500);
        } else log('verify: answer rejected — waiting for the current challenge; no blind candidate retry');
      }
      if (/verification failed|captcha/i.test(line)) { /* keep the gate log readable */ }
      chatSeen.push(text)
      if (chatSeen.length > 60) chatSeen.shift()

      // verify gate / bans
      const ban = banInfo(text, cfg.playerName)
      if (ban) {
        log(`blacklisted by the server — waiting ${Math.round(ban.ms / 60000)} min (${ban.text})`)
        banUntil = Date.now() + ban.ms
        finish('banned')
        return
      }
      if (/blocked from entering|wait a few minutes/i.test(text)) { finish('blocked-cooldown'); return }
      if (/displayed on the map|text .*on the map|enter the text/i.test(text)) {
        // second gate: "Please enter the text in chat that is displayed on the map"
        const path = captchaImagePath()
        const writeCaptcha = () => {
          if (!lastMap) return false
          try {
            const { cols, rows, data } = lastMap
            const freq = new Map()
            for (const v of data) freq.set(v, (freq.get(v) || 0) + 1)
            let bg = 0, best = -1
            for (const [k, n] of freq) if (n > best) { best = n; bg = k }
            const grey = new Uint8Array(data.length)
            for (let i = 0; i < data.length; i++) grey[i] = data[i] === bg ? 255 : 0
            fs.writeFileSync(path, pngFromGrey(cols, rows, grey, null, 4))
            // and the same map in real Minecraft colours: the text is legible there,
            // which the thresholded copy above never is
            let readText = null, readConf = 0
            if (mapCaptcha) {
              try {
                const rgbTrue = mapCaptcha.trueColourRgb({ cols, rows, data })
                fs.writeFileSync(path.replace(/\.png$/, '-true.png'), pngFromGrey(cols, rows, rgbTrue, true, 6))
                const res = mapCaptcha.solve({ cols, rows, data })
                readText = res.text
                readConf = res.confident ? 1 : 0
                const detail = res.chars.map(c => `${c.ch}(${c.d.toFixed(2)}/${c.gap.toFixed(2)})`).join(' ')
                log(`verify: auto-read "${res.text}" ${res.confident ? '(confident)' : '(unsure)'} — ${detail}`)
                const decision = require('./captcha_policy').assess(res, ENV)
                let plausible = decision.allowed
                if (!plausible) log(`verify: holding auto-answer — ${decision.reason}`)
                // two misses in a row means the layout is too tangled to read; stop
                // burning attempts (the server blocks the IP) and hand it to a person
                if (captchaMisses >= 2) {
                  log('verify: two guesses were rejected — giving up on auto-answer, the picture above is readable, type the text in the console')
                  plausible = false
                }
                captchaCandidates = res.candidates || [res.text]
                captchaTried = []
                if (!/^(off|false|no|0)$/i.test(ENV.CAPTCHA_AUTO || '')) {
                if (plausible) {
                  if (SESSION_SEND(res.text)) {
                    captchaTried.push(res.text)
                    pendingCaptcha = { text: res.text, bin: path.replace(/\.png$/, '.bin'), at: Date.now(), by: 'bot' }
                    log(`verify: answered with "${res.text}"${res.confident ? '' : ' (best guess)'}`)
                  }
                } else {
                  log('verify: could not make out the text — open captcha-map-true.png and type it in the console')
                }
                } else log('verify: auto-answer is off — type the text in the console (POST /api/chat)')
              } catch (e) { log(`verify: auto-read failed (${e.message})`) }
            }
            // and the untouched data: the map is text drawn over a patterned background,
            // so thresholding it throws away the only thing that separates them
            try {
              fs.writeFileSync(path.replace(/\.png$/, '.bin'), lastMapRaw || Buffer.alloc(0))
              const rgb = new Uint8Array(data.length * 3)
              for (let i = 0; i < data.length; i++) {
                const v = data[i]
                if (v === bg) { rgb[i * 3] = 255; rgb[i * 3 + 1] = 255; rgb[i * 3 + 2] = 255; continue }
                // distinct hue per colour index, so text and background stay apart
                const h = (v * 0.61803398875) % 1
                const f = (n) => { const k = (n + h * 6) % 6; return Math.round(255 * (0.15 + 0.85 * Math.max(0, Math.min(k, 4 - k, 1)))) }
                rgb[i * 3] = f(5); rgb[i * 3 + 1] = f(3); rgb[i * 3 + 2] = f(1)
              }
              fs.writeFileSync(path.replace(/\.png$/, '-colour.png'), pngFromGrey(cols, rows, rgb, true, 4))
            } catch (e) { if (cfg.verbose) log(`captcha colour dump: ${e.message}`) }
            try {
              let dumped = 0
              for (const [id, entry] of mapById) {
                if (Date.now() - entry.at > 20000) continue
                fs.writeFileSync(path.replace(/\.png$/, '-' + id + '.bin'), entry.raw)
                const d2 = entry.m.data
                const rgb2 = new Uint8Array(d2.length * 3)
                const fq = new Map()
                for (const v of d2) fq.set(v, (fq.get(v) || 0) + 1)
                let bg2 = 0, best2 = -1
                for (const [k, v] of fq) if (v > best2) { best2 = v; bg2 = k }
                for (let i = 0; i < d2.length; i++) {
                  const v = d2[i]
                  if (v === bg2) { rgb2[i * 3] = 255; rgb2[i * 3 + 1] = 255; rgb2[i * 3 + 2] = 255; continue }
                  const hue = (v * 0.61803398875) % 1
                  const f2 = (n2) => { const k = (n2 + hue * 6) % 6; return Math.round(255 * (0.15 + 0.85 * Math.max(0, Math.min(k, 4 - k, 1)))) }
                  rgb2[i * 3] = f2(5); rgb2[i * 3 + 1] = f2(3); rgb2[i * 3 + 2] = f2(1)
                }
                fs.writeFileSync(path.replace(/\.png$/, '-' + id + '.png'), pngFromGrey(entry.m.cols, entry.m.rows, rgb2, true, 4))
                dumped++
              }
              if (dumped) log(`verify: wrote ${dumped} recently seen map(s) as captcha-map-<id>.png — one of them is the captcha`)
            } catch (e) { if (cfg.verbose) log(`captcha dump: ${e.message}`) }
            log(`verify: the server is showing a text captcha on a map — picture saved to ${path}`)
            log('verify: read it and type the text in the console (or web chat) — the bot sends it as-is')
            if (readText === null) captchaMisses++
            if (cfg.web) log(`verify: or open http://<this-host>:${cfg.webPort}/captcha.png in a browser`)
            captchaPendingUntil = Date.now() + 120000
            return true
          } catch (e) { log(`verify: could not write the captcha picture (${e.message})`); return false }
        }
        // A map that was already in memory when the prompt arrived is a stale one (the
        // player's own map, the lobby map). The captcha map is sent right after the
        // prompt, so the old one is dropped and we wait for a genuinely new packet.
        // The map arrives a beat BEFORE this prompt (measured: same second), so a map
        // seen in the last few seconds IS the captcha — only an older one is stale.
        if (lastMap && Date.now() - (lastMapAt || 0) < 3000 && writeCaptcha()) return
        const stale = Date.now() - (lastMapAt || 0) < 3000 ? null : lastMap
        const staleRaw = stale ? lastMapRaw : null
        lastMap = null
        lastMapRaw = null
        if (writeCaptcha()) return
        // the map packet often lands a beat after the chat line — wait for it instead
        // of reporting "nothing to read" and losing the only chance at the text
        log('verify: the server wants the text on the map — waiting for the map picture...')
        let tries = 0
        const retry = setInterval(() => {
          tries++
          if (writeCaptcha()) { clearInterval(retry); return }
          if (tries >= 12) {
            clearInterval(retry)   // 6s
            if (stale) {
              lastMap = stale
              lastMapRaw = staleRaw
              log('verify: no new map arrived — falling back to the one already in memory (it may be the wrong map)')
              writeCaptcha()
            } else {
              log('verify: no map packet arrived at all — this gate cannot be answered automatically')
            }
          }
        }, 500)
        return
      }
      if (/verified successfully/i.test(text)) { setVerifyDone(); log('verify passed — rejoining'); finish('rejoin'); return }
      if (/verifying your connection/i.test(text)) log('verify gate — waiting...')

      // Captcha gate — CWR inserts this between attempts and before /login:
      //   [!] To log in, solve the captcha: /captcha 69ss98uq
      // A bot that ignores it looks exactly like a wrong password, so answer it at once.
      const cap = cfg.auth ? text.match(/\/captcha\s+([A-Za-z0-9]{2,16})/i) : null
      if (cap && Date.now() > (captchaUntil || 0)) {
        captchaUntil = Date.now() + 4000
        log(`auth: captcha — answering /captcha ${cap[1]}`)
        try { SESSION_SEND(`/captcha ${cap[1]}`) } catch {}
        return
      }

      // AuthMe
      const prompt = cfg.auth ? authPromptMode(text) : null
      const countdown = prompt === 'login-countdown' || prompt === 'register-countdown'
      if (prompt && !countdown) authPlan = prompt
      if (countdown) {
        // remember the direction, but do not answer a countdown
        if (!authPlan) authPlan = prompt === 'register-countdown' ? 'register' : 'login'
      }
      // The server repeats its prompt about once a second. Trigger on the first one,
      // and if an attempt is already running, only re-trigger after a cooldown so a
      // silent failure cannot loop forever; a busy-but-stuck attempt is abandoned.
      const stuck = authBusy && Date.now() - authStartedAt > 45000
      if (cfg.auth && !ready && prompt && !countdown && Date.now() > authCooldownUntil && (!authBusy || stuck)) {
        if (stuck) log('auth: the previous attempt went quiet — starting a fresh one')
        authBusy = true
        authStartedAt = Date.now()
        authCooldownUntil = Date.now() + 8000
        doAuth().then(ok => { authBusy = false; if (ok) markReady() })
          .catch(e => { authBusy = false; log(`auth: attempt aborted (${e && e.message})`) })
        return
      }
      if (!cfg.auth && /please complete authentication|Command: \/login|Please register to join/i.test(text) && !authWarned) {
        authWarned = true
        log('server asks for login but AUTH=off — skipping (set AUTH=on to auto-login)')
      }
      if (cfg.auth && /login was successful/i.test(text)) markReady()
      if (!cfg.auth && !ready) markReady() // no auth expected: first chat = we're in
    }

    const maybeReady = () => {
      // commands (AuthMe done AND verification done) — nothing runs earlier
      if (gateDone || !ready || !verifyDone) return
      gateDone = true
      log('READY — verified & logged in')
      openGate()
      if (!cmdsQueued) {
        cmdsQueued = true
        log(`anti-afk: ${cfg.antiAfk ? 'on — vanilla walk/look/hop actions' : 'off — standing still (no actions)'}`)
        if (cfg.cmds.length) {
          log(`running .env queue: ${cfg.cmds.join(' | ')}`)
          for (const c of cfg.cmds) queue.push(c).catch(() => {})
        }
      }
    }
    const markReady = () => { if (ready) return; ready = true; maybeReady() }
    const setVerifyDone = () => { if (verifyDone) return; verifyDone = true; maybeReady() }

    const authSucceeded = () => chatSeen.some(t => /login was successful|Your login was successful|Authentication Successful|already logged in|Welcome back .* to /i.test(t))

    const doAuth = async (attempt = 1, mode = authPlan) => {
      // Auth commands bypass the gated queue — the gate opens only AFTER auth
      // completes, so pushing through it would deadlock. The sleeps below outlive
      // sessions, so each send is gated on the session that started the attempt.
      const gen = sessionGen
      const mine = () => gen === sessionGen && !ended && state === 'play'
      const pw = cfg.password
      const stars = '*'.repeat(Math.max(3, pw.length))
      // authPlan survives the session: after a reconnect the server asks again,
      // and by then we already know whether this account needs /register.
      if (mode) authPlan = mode
      const registerFirst = authPlan === 'register'

      log(`auth: ${registerFirst ? 'registering (/register) — the server asked a new account to register' : 'logging in (/login)'} (AUTH=on, password ${stars})`)
      await sleep(cfg.delayMs) // delay-before-every-cmd, incl the first
      if (!mine()) { log('auth: session changed while waiting — the next session picks this up'); return false }
      // every auth command: note where the chat was, send, then read what came back
      const ask = async (cmd, waitMs) => {
        const mark = chatSeen.length
        if (SESSION_SEND(cmd) === false) return []
        await sleep(waitMs)
        const reply = chatSeen.slice(mark).filter(Boolean)
        if (reply.length) log(`auth: server replied to ${cmd.split(' ')[0]}: ${reply.slice(-3).join(' | ')}`)
        return reply
      }

      if (registerFirst) {
        const reg = await ask(`/register ${pw} ${pw}`, 2500)
        const info = reg.map(authReplyInfo).filter(Boolean).pop()
        if (info && info.kind === 'already') { log('auth: the account already exists — switching to /login'); authPlan = 'login' }
        if (info && info.kind === 'rule') { log('auth: the server rejected the password itself (see "server replied" above) — fix PASSWORD in .env'); authFailWhy = 'password rejected by the server' }
        if (info && info.kind === 'badpass') { log('auth: wrong password — fix PASSWORD in .env'); authFailWhy = 'wrong password' }
      }
      if (!mine()) { log('auth: session changed while waiting — the next session picks this up'); return false }
      if (authPlan !== 'register') {
        const log1 = await ask(`/login ${pw}`, 3500)
        const info = log1.map(authReplyInfo).filter(Boolean).pop()
        if (info && info.kind === 'already') { /* already logged in: nothing to do */ }
        if (info && info.kind === 'notreg') { log('auth: the account is not registered — registering'); authPlan = 'register'; return doAuth(attempt, 'register') }
        if (info && (info.kind === 'badpass' || info.kind === 'rule')) { log('auth: the server rejected the credentials (see "server replied" above)'); authFailWhy = info.kind === 'badpass' ? 'wrong password' : 'password rejected by the server' }
      }
      if (authSucceeded()) { authPlan = 'login'; log('auth: logged in'); return true }

      // Wrong guess? Try the other form once before giving up — an account that
      // is already registered answers /register with "already registered", and a
      // fresh one answers /login with "not registered".
      if (authPlan !== 'register' && attempt === 1) {
        log('auth: no confirmation — trying /register (the account may be new)')
        return doAuth(attempt, 'register')
      }
      if (!mine()) { log('auth: session changed while waiting — the next session picks this up'); return false }
      if (authFailWhy) {
        // the server told us the password is wrong — retrying only builds toward a ban
        log(`auth: giving up on this password (${authFailWhy}) — fix PASSWORD in .env and restart`)
        authCooldownUntil = Date.now() + 10 * 60 * 1000
        return false
      }
      if (attempt < 3) {
        log(`auth: still no confirmation — retrying (attempt ${attempt + 1}/3) in 10s`)
        await sleep(10000)
        if (!mine()) { log('auth: session changed while waiting — the next session picks this up'); return false }
        return doAuth(attempt + 1, authPlan)
      }
      log(`auth: FAILED${authFailWhy ? ` — ${authFailWhy}` : ' — check PASSWORD'} (you can also type /login <pass> or /register <pass> <pass> in the terminal)`)
      if (mine()) { log('auth: reconnecting for a clean session'); finish('restart') }
      return false
    }

    /* Sonar verification arena (CWR's anti-bot).
       Unverified logins receive the placeholder name "Sonar" at login
       success, spawn at (0,0,0), and must answer the anti-bot's proof:
       two teleports (absolute then Y-relative) → three priming positions
       (spawnY, spawnY+0.0001, spawnY) → a real 8-tick gravity fall onto
       the platform slab → swing + held-item echoes → boat and minecart
       movement driven by keep-alives. A vanilla client passes because its
       physics engine produces those outputs naturally; this client
       reproduces them packet-for-packet. */
    const arena = {
      active: false, stage: 'idle', // idle → priming → fall → protocol → vehicle → done
      y1: null, blockHeight: 0.75,
      fallDy: 0, fallY: 0, landingY: 0,
      animReplied: false, slotReplied: false,
      vehiclePhase: 'waiting', timers: []
    }
    const SONAR_BLOCK_H = { 9451: 0.75, 12582: 0.1875, 9473: 0.8125, 11295: 0.375, 9984: 1.5, 13399: 0.5, 12896: 0.0625 }

    /* vanilla LocalPlayer — direct port of fsj.D() (sendPosition) on top of
       Entity gravity. Frames are EMERGENT: each 50ms client tick the physics
       step runs, then the send-decision tree picks position / position_look /
       look / flying exactly like the decompiled game does. */
    const player = {
      x: 0, y: 0, z: 0, yaw: 0, pitch: 0, onGround: false,
      xOld: 0, yOld: 0, zOld: 0, yawOld: 0, pitchOld: 0, groundOld: false,
      dy: 0, reminder: 0, airborne: false, floorY: null,
      entityId: 0, gameMode: 0, inWorld: false,
      dx: 0, dz: 0,            // horizontal velocity (knockback) — LivingEntity.travel
      heldSlot: 0,             // vanilla hotbar selection (server can set it)
      sneaking: false, sprinting: false,
      seq: 0,                  // shared action sequence counter (dig/place/use)
      tabTx: 0,                // tab-complete transaction ids (capture: 0,1,2,...)
      win: null                // open container: { id, stateId } for correct clicks
    }
    let arenaTickTimer = null
    function playerTeleport (x, y, z, yaw, pitch) {
      // fnt.a(abg): apply target + setOldPosAndRot
      player.x = x; player.y = y; player.z = z
      player.yaw = yaw; player.pitch = pitch
      player.xOld = x; player.yOld = y; player.zOld = z
      player.yawOld = yaw; player.pitchOld = pitch
      player.groundOld = player.onGround
      if (pos) { pos.x = x; pos.y = y; pos.z = z; pos.yaw = yaw; pos.pitch = pitch }
    }
    /* ---------------- world: chunk store + block collision + entities + inv ---------------- */
    const loadedChunks = new Set()   // 'cx,cz'
    const sections = new Map()       // 'cx,cz,sy' -> Uint16Array(4096)
    const chunkLru = []              // least-recently-used chunk first
    const meshFaces = new Map()      // render model: 'cx,cz,sy' -> exposed face count
    const heightMaps = new Map()     // render model: 'cx,cz' -> Int16Array(256) top y+1
    const visibleEntities = new Set()// entities inside the view frustum with clear line of sight
    const seenEntities = new Set()   // logging throttle for first sighting
    const entities = new Map()       // id -> {x,y,z,yaw,pitch}
    const inv = { stateId: 0, cursor: { present: false }, slots: [] } // window 0 + cursor
    const ensureGui = (id) => {
      if (!player.gui || player.gui.id !== id) player.gui = { id, type: null, title: '', slots: [], stateId: 0 }
      return player.gui
    }
    // closing a container: fold its player-inventory half back into the
    // window-0 mirror so the standalone inventory view stays correct
    const syncInvFromGui = (gui) => {
      // window-0 layout: 0 result, 1-4 craft, 5-8 armour, 9-35 main, 36-44 hotbar, 45 offhand.
      // A container's last 36 slots are main (0-26) then hotbar (27-35), so they belong in
      // 9-35 and 36-44. Writing the hotbar to 0-8 (as this used to) smeared the
      // container's contents over the crafting grid after closing it.
      const n = (gui.slots || []).length
      if (!(n % 9 === 0 && n >= 36)) return
      const cont = n - 36
      for (let i = 0; i < 27; i++) if (gui.slots[cont + i] !== undefined) inv.slots[9 + i] = gui.slots[cont + i]
      for (let i = 0; i < 9; i++) if (gui.slots[cont + 27 + i] !== undefined) inv.slots[36 + i] = gui.slots[cont + 27 + i]
    }
    const CLIENT_VD = 12             // what we declare in settings — the render radius
    const chunkKey = (cx, cz) => cx + ',' + cz
    const sectKey = (cx, cz, sy) => cx + ',' + cz + ',' + sy

    function dropChunk (cx, cz) {
      const p = cx + ',' + cz + ','
      for (const key of [...sections.keys()]) if (key.startsWith(p)) sections.delete(key)
      for (const key of [...meshFaces.keys()]) if (key.startsWith(p)) meshFaces.delete(key)
      heightMaps.delete(chunkKey(cx, cz))
      loadedChunks.delete(chunkKey(cx, cz))
      const i = chunkLru.indexOf(chunkKey(cx, cz))
      if (i >= 0) chunkLru.splice(i, 1)
    }
    function touchChunk (cx, cz) {
      const k = chunkKey(cx, cz)
      const i = chunkLru.indexOf(k)
      if (i > 0) { chunkLru.splice(i, 1); chunkLru.push(k) }
    }
    /* Chunk decode queue: bounded, time-sliced, yields to the event loop so packets
       (keep-alives in particular) keep being answered while the world streams in. */
    const chunkQueue = []
    let chunkDraining = false
    let chunkDropped = 0
    let chunkSkipped = 0, chunkParsed = 0, chunkMs = 0
    // TRACE=on logs every packet in both directions for 90s after the queue command,
    // so a transfer can be compared packet-for-packet between a good and a stuck run
    let traceOn = ENV.TRACE === 'on'
    let playWhileConfig = 0
    let lastMap = null       // the newest in-game map — the captcha is drawn on one
    let lastMapRaw = null
    let captchaMisses = 0
    let lastMapAt = 0
    let pendingCaptcha = null
    let captchaCandidates = []
    let captchaTried = []
    const mapById = new Map()
    let captchaPendingUntil = 0
    const TRACE_NOISE = /^(map_chunk|unload_chunk|entity_move|entity_look|entity_head|rel_entity|entity_teleport|set_entity_motion|update_light|block_change|multi_block|sound|world_event|particle|block_entity_data|time_update|health|experience|set_slot|window_items|position|flying|keep_alive)$/
    if (traceOn) {
      log('trace: on — every packet, both directions (TRACE=on)')
      const ms = parseInt(ENV.TRACE_MS || '', 10)
      if (Number.isFinite(ms) && ms > 0) setTimeout(() => { if (traceOn) { traceOn = false; log('trace: off') } }, ms)
    }
    const traceLog = (dir, st, name, len) => {
      const t = new Date().toISOString().slice(11, 23)
      log(`trace ${t} ${dir} [${st}] ${name} len=${len}`)
    }
    function enqueueChunk (x, z, data) {
      // Only decode what the bot actually uses: the chunks around it (collision,
      // floor) and the ones the verification teleports target. A full view distance
      // is 300-800 chunks; parsing all of them costs ~10ms each, i.e. tens of
      // seconds on a 0.1-CPU container — which froze the loop and swallowed the
      // packets of a server transfer. Everything else is acknowledged and skipped.
      const pcx = Math.floor((player.x || 0) / 16)
      const pcz = Math.floor((player.z || 0) / 16)
      const near = Math.abs(x - pcx) <= 3 && Math.abs(z - pcz) <= 3
      const tgs = player.tpTargets || []
      const wanted = near || tgs.some(t => {
        const tcx = Math.floor(t[0]) >> 4, tcz = Math.floor(t[1]) >> 4
        return Math.abs(tcx - x) <= 1 && Math.abs(tcz - z) <= 1
      })
      if (!wanted) { chunkSkipped++; return }
      chunkParsed++
      chunkQueue.push({ x, z, data })
      if (chunkQueue.length > 64) { chunkQueue.shift(); chunkDropped++ }
      if (!chunkDraining) drainChunkQueue()
    }
    function drainChunkQueue () {
      chunkDraining = true
      const step = () => {
        const t0 = Date.now()
        while (chunkQueue.length && Date.now() - t0 < 8) {
          const c = chunkQueue.shift()
          const t1 = Date.now()
          try { parseChunkData(c.x, c.z, c.data) } catch (e) { if (cfg.verbose) log(`chunk parse: ${e.message}`) }
          chunkMs += Date.now() - t1
        }
        if (chunkQueue.length) { setTimeout(step, 0); return }
        chunkDraining = false
        if (chunkDropped) { log(`chunk queue: dropped ${chunkDropped} chunks (the client was behind)`); chunkDropped = 0 }
        if (chunkSkipped) {
          const avg = chunkParsed ? (chunkMs / chunkParsed).toFixed(1) : '0'
          log(`chunks: parsed ${chunkParsed} (${chunkMs}ms, ${avg}ms each), skipped ${chunkSkipped} far ones (not needed for collision)`)
          chunkSkipped = 0; chunkParsed = 0; chunkMs = 0
        }
      }
      setTimeout(step, 0)
    }

    function parseChunkData (cx, cz, data) {
      // 1.20.4 network sections — verified byte-exact against a live capture
      // and prismarine-chunk: per section i16BE block count, then blockstates
      // container, then biomes container. Container: u8 bpe; bpe==0 -> varint
      // value + u8 data-len(0); blocks 1-8 / biomes 1-3 -> varint plen + plen
      // varints + varint longCount + data; blocks 9-16 / biomes 4-8 -> varint
      // longCount + data. Data longs are 8-byte big-endian, bits packed
      // LSB-first without crossing long boundaries.
      const secs = new Map()
      let off = 0
      const end = data.length
      const u8 = () => { if (off >= end) throw new Error('u8 eof'); return data[off++] }
      const i16 = () => { if (off + 2 > end) throw new Error('u16 eof'); const v = data.readInt16BE(off); off += 2; return v }
      const varint = () => {
        let num = 0, shift = 0
        for (;;) {
          if (off >= end) throw new Error('varint eof')
          const b = data[off++]
          num |= (b & 0x7f) << shift
          shift += 7
          if ((b & 0x80) === 0) break
          if (shift > 31) throw new Error('varint long')
        }
        return num >>> 0
      }
      const takeLongs = () => {
        const k = varint()
        if (k < 0 || off + k * 8 > end) throw new Error('longs eof')
        const start = off
        off += k * 8
        return { k, start }
      }
      const readStates = () => {
        const bpe = u8()
        if (bpe === 0) { const v = varint(); u8(); return { single: v } } // + data-len byte
        if (bpe <= 8) {
          const plen = varint()
          if (plen > 4096) throw new Error('palette long')
          const palette = new Array(plen)
          for (let i = 0; i < plen; i++) palette[i] = varint()
          const L = takeLongs()
          return { bpe, palette, k: L.k, start: L.start }
        }
        if (bpe > 16) throw new Error('bad bpe ' + bpe)
        const L = takeLongs()
        return { bpe, palette: null, k: L.k, start: L.start }
      }
      const skipBiomes = () => {
        const bb = u8()
        if (bb === 0) { varint(); u8(); return }
        if (bb <= 3) {
          const plen = varint()
          if (plen > 64) throw new Error('biome palette long')
          for (let i = 0; i < plen; i++) varint()
          takeLongs()
        } else {
          if (bb > 8) throw new Error('bad bb ' + bb)
          takeLongs()
        }
      }
      for (let s = 0; s < 24 && off + 2 <= end; s++) {
        const bc = i16()
        const st = readStates()
        skipBiomes()
        if (st.single !== undefined) {
          if (st.single === 0) continue // palette says air — the only trusted signal
          const arr = new Uint16Array(4096)
          arr.fill(Math.min(st.single, 65535))
          secs.set(s - 4, arr) // section 0 covers y -64..-49
          continue
        }
        // NOTE: do NOT skip on bc===0 — plugins that place blocks without
        // updating the section's block-count field would be dropped here while
        // vanilla clients (palette readers) see the floor. The `any` flag below
        // already gates genuinely-empty sections.
        const arr = new Uint16Array(4096)
        const bpe = st.bpe
        const epl = Math.floor(64 / bpe)
        const mask = (1 << bpe) - 1
        const longs = new Array(st.k)
        for (let li = 0; li < st.k; li++) longs[li] = data.readBigInt64BE(st.start + li * 8)
        let any = false
        for (let i = 0; i < 4096; i++) {
          const li = Math.floor(i / epl)
          if (li >= st.k) break
          const shift = BigInt((i % epl) * bpe)
          const idx = Number((longs[li] >> shift) & BigInt(mask))
          const v = st.palette ? (st.palette[idx] !== undefined ? st.palette[idx] : 0) : idx
          if (v !== 0) { arr[i] = Math.min(v, 65535); any = true }
        }
        if (any) secs.set(s - 4, arr)
      }
      // store
      const ck = chunkKey(cx, cz)
      if (!loadedChunks.has(ck)) { loadedChunks.add(ck); chunkLru.push(ck) }
      const p = cx + ',' + cz + ','
      for (const key of [...sections.keys()]) if (key.startsWith(p)) sections.delete(key)
      for (const [sy, arr] of secs) sections.set(sectKey(cx, cz, sy), arr)
      buildChunkRender(cx, cz)
      while (chunkLru.length > 400) {
        const [old] = chunkLru
        const [ox, oz] = old.split(',').map(Number)
        dropChunk(ox, oz) // evicts from front of the LRU
        if (chunkLru.length && chunkLru[0] === old) chunkLru.shift() // safety
      }
    }
    // the internal "render" of a chunk — same inputs a mesh builder uses:
    // exposed block faces (air or unloaded-neighbor contact) + a top heightmap
    function buildChunkRender (cx, cz) {
      const p = cx + ',' + cz + ','
      const top = new Int16Array(256)
      for (const [key, arr] of sections) {
        if (!key.startsWith(p)) continue
        const sy = Number(key.slice(p.length))
        let faces = 0
        for (let i = 0; i < 4096; i++) {
          const st = arr[i]
          if (st === 0) continue
          const ly = i >> 8, lz = (i >> 4) & 15, lx = i & 15
          const wx = (cx << 4) + lx, wz = (cz << 4) + lz, wy = (sy << 4) + ly
          if (worldBlockCat(wx, wy + 1, wz) !== 1) faces++
          if (worldBlockCat(wx, wy - 1, wz) !== 1) faces++
          if (lx === 0 ? worldBlockCat(wx - 1, wy, wz) !== 1 : arr[i - 1] === 0) faces++
          if (lx === 15 ? worldBlockCat(wx + 1, wy, wz) !== 1 : arr[i + 1] === 0) faces++
          if (lz === 0 ? worldBlockCat(wx, wy, wz - 1) !== 1 : arr[i - 16] === 0) faces++
          if (lz === 15 ? worldBlockCat(wx, wy, wz + 1) !== 1 : arr[i + 16] === 0) faces++
          const col = (lz << 4) | lx
          if (top[col] === 0 || wy + 1 > top[col]) top[col] = wy + 1
        }
        meshFaces.set(key, faces)
      }
      heightMaps.set(chunkKey(cx, cz), top)
    }
    // returns collision category 0/1/2, or -1 = chunk not loaded (unknown)
    function worldBlockCat (x, y, z) {
      if (y < -64) return 1 // below the void — solid floor
      if (y >= 320) return 0
      const cx = x >> 4, cz = z >> 4
      if (!loadedChunks.has(chunkKey(cx, cz))) return -1
      touchChunk(cx, cz)
      const arr = sections.get(sectKey(cx, cz, y >> 4))
      if (!arr) return 0 // loaded chunk, section absent = all air
      return blockCat(arr[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)])
    }
    const solidAt = (bx, by, bz) => { const c = worldBlockCat(bx, by, bz); return c === -1 ? true : c > 0 } // unknown = wall
    const boxTopAt = (bx, by, bz) => { const c = worldBlockCat(bx, by, bz); if (c < 0) return undefined; if (c === 0) return null; return c === 2 ? by + 0.5 : by + 1 }
    // raw state id at a world block (0 = air, undefined = chunk not loaded)
    function worldStateAt (x, y, z) {
      if (y < -64 || y >= 320) return 0
      const cx = x >> 4, cz = z >> 4
      if (!loadedChunks.has(chunkKey(cx, cz))) return undefined
      const arr = sections.get(sectKey(cx, cz, y >> 4))
      if (!arr) return 0
      return arr[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]
    }
    // write one block (creates the section array + chunk entry on demand)
    function setWorldState (x, y, z, state) {
      if (y < -64 || y >= 320) return false
      const cx = x >> 4, cz = z >> 4, ck = chunkKey(cx, cz)
      if (!loadedChunks.has(ck)) { loadedChunks.add(ck); chunkLru.push(ck) }
      const sk = sectKey(cx, cz, y >> 4)
      let arr = sections.get(sk)
      if (!arr) { arr = new Uint16Array(4096); sections.set(sk, arr) }
      arr[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = Math.min(state, 65535)
      return true
    }
    // vertical sweep: highest collision top a 0.6x1.8 box at (px,pz) crosses
    // while moving from fromY down to toY (vanilla: the feet stop on the face)
    function landTop (px, pz, fromY, toY, hw) {
      // hw === 0 means "the column the player's centre is in" — used for the
      // arena drop, where the spawned-in decoy wall is never what holds the
      // real client up (it keeps x=8.0 and falls straight past it)
      const w = hw === undefined ? P_HW : hw
      const x0 = w === 0 ? Math.floor(px) : Math.floor(px - w + 1e-4)
      const x1 = w === 0 ? Math.floor(px) : Math.floor(px + w - 1e-4)
      const z0 = w === 0 ? Math.floor(pz) : Math.floor(pz - w + 1e-4)
      const z1 = w === 0 ? Math.floor(pz) : Math.floor(pz + w - 1e-4)
      let best = null
      const yLo = Math.floor(toY) - 1
      for (let bx = x0; bx <= x1; bx++) {
        for (let bz = z0; bz <= z1; bz++) {
          for (let by = Math.floor(fromY); by >= yLo; by--) {
            const st = worldStateAt(bx, by, bz)
            if (st === undefined) continue // unknown chunk: not a collision surface
            const boxes = blockBoxes(st)
            if (!boxes) continue
            for (const b of boxes) {
              // does the player's footprint overlap the box horizontally?
              if (px + w <= bx + b[0] || px - w >= bx + b[3]) continue
              if (pz + w <= bz + b[2] || pz - w >= bz + b[5]) continue
              const top = by + b[4]
              if (top <= fromY + 1e-4 && top > toY - 1.0) { if (best === null || top > best) best = top }
            }
          }
        }
      }
      return best
    }

    // drop the arena's multi_block_change records into the world. The obstacle
    // always sits in the section just around the landing plane, so the section
    // index is derived from spawnY rather than from the (mangled) section long.
    function applyArenaBlocks (spawnY) {
      const recs = (arena.mbcRecords || [])
      if (!recs.length) return 0
      const sx = Math.floor(player.x) >> 4, sz = Math.floor(player.z) >> 4
      const sy = Math.floor((spawnY - 4) / 16)
      let placed = 0
      for (const v of recs) {
        // wire layout is (state << 12) | (localX << 8) | (localZ << 4) | localY
        // — y sits in the LOW nibble, which is what makes the plate a floor
        const state = v >> 12, pos = v & 0xfff
        if (!state || pos > 4095) continue
        const lx = pos >> 8, lz = (pos >> 4) & 15, ly = pos & 15
        if (setWorldState((sx << 4) + lx, (sy << 4) + ly, (sz << 4) + lz, state)) placed++
      }
      return placed
    }
    const P_HW = 0.299, P_H = 1.8
    function aabbHits (x, y, z) {
      const x0 = Math.floor(x - P_HW + 1e-6), x1 = Math.floor(x + P_HW - 1e-6)
      const z0 = Math.floor(z - P_HW + 1e-6), z1 = Math.floor(z + P_HW - 1e-6)
      const y0 = Math.floor(y + 0.02), y1 = Math.floor(y + P_H - 0.02)
      for (let bx = x0; bx <= x1; bx++)
        for (let bz = z0; bz <= z1; bz++)
          for (let by = y0; by <= y1; by++)
            if (solidAt(bx, by, bz)) return true
      return false
    }
    function groundSupported () {
      const x0 = Math.floor(player.x - P_HW + 1e-6), x1 = Math.floor(player.x + P_HW - 1e-6)
      const z0 = Math.floor(player.z - P_HW + 1e-6), z1 = Math.floor(player.z + P_HW - 1e-6)
      let unknown = false
      for (let bx = x0; bx <= x1; bx++)
        for (let bz = z0; bz <= z1; bz++) {
          // standing surface: top of the block just below the feet
          const below = Math.floor(player.y - 0.02)
          const t = boxTopAt(bx, below, bz)
          if (t === undefined) unknown = true
          else if (t !== null && Math.abs(t - player.y) < 0.05) return true
        }
      // remembered lobby plane while chunks are still unknown
      if (unknown && player.floorY != null && Math.abs(player.y - player.floorY) < 0.05) return true
      return false
    }
    function stepUpTry (nx, nz) {
      if (!player.onGround) return false
      const x0 = Math.floor(nx - P_HW + 1e-6), x1 = Math.floor(nx + P_HW - 1e-6)
      const z0 = Math.floor(nz - P_HW + 1e-6), z1 = Math.floor(nz + P_HW - 1e-6)
      let top = -1
      for (let bx = x0; bx <= x1; bx++)
        for (let bz = z0; bz <= z1; bz++) {
          const t = boxTopAt(bx, Math.floor(player.y + 1e-6), bz) // the block blocking the feet
          const t2 = boxTopAt(bx, Math.floor(player.y - 0.02), bz)
          const cand = t !== null && t !== undefined ? t : null
          if (cand !== null && cand > player.y + 1e-6 && cand <= player.y + 0.6 + 1e-6) top = Math.max(top, cand)
          if (t2 !== null && t2 !== undefined && t2 > player.y + 1e-6 && t2 <= player.y + 0.6 + 1e-6) top = Math.max(top, t2)
        }
      if (top < 0) return false
      if (aabbHits(nx, top + 0.001, nz)) return false // head clearance / taller block
      player.y = top + 0.001
      player.onGround = true
      player.airborne = false
      return true
    }
    function stepHorizontal () {
      const dist = Math.hypot(player.dx, player.dz)
      const steps = Math.max(1, Math.ceil(dist / 0.3))
      const sx = player.dx / steps, sz = player.dz / steps
      for (let i = 0; i < steps; i++) {
        const nx = player.x + sx
        if (aabbHits(nx, player.y, player.z)) {
          if (!stepUpTry(nx, player.z)) {
            // wall — creep up to the face (substep halving), slide on the other axis
            let s = sx
            for (let k = 0; k < 4 && s > 1e-4; k++) {
              s /= 2
              if (!aabbHits(player.x + s, player.y, player.z)) player.x += s
            }
            player.dx = 0
          }
        } else player.x = nx
        const nz = player.z + sz
        if (aabbHits(player.x, player.y, nz)) {
          if (!stepUpTry(player.x, nz)) {
            let s = sz
            for (let k = 0; k < 4 && s > 1e-4; k++) {
              s /= 2
              if (!aabbHits(player.x, player.y, player.z + s)) player.z += s
            }
            player.dz = 0
          }
        } else player.z = nz
      }
    }
    function stepVertical () {
      // server-truth hold: right after a server teleport the target IS the
      // ground truth. If our chunk model finds no floor under the pad the
      // server still has us standing there — hold the plane instead of
      // simulating a fall through the platform (that fall + rubber-band
      // loop is what the anticheat kicks for).
      const th = player.tpHold
      // no time limit: while we remain near the target the server's plane is
      // ground truth indefinitely (a timer expiry caused periodic 1-frame
      // falls -> correction loops). Radius + y-band keep it scoped.
      if (th && !arena.active &&
          Math.abs(player.x - th.x) < 2.0 && Math.abs(player.z - th.z) < 2.0 &&
          player.y <= th.y + 0.05 && player.y >= th.y - 1.0 &&
          !groundSupported()) {
        player.y = th.y
        player.dy = 0
        player.onGround = true
        player.airborne = false
        return
      }
      if (player.airborne && player.dy !== 0) {
        const steps = Math.max(1, Math.ceil(Math.abs(player.dy) / 0.5))
        const sd = player.dy / steps
        for (let i = 0; i < steps; i++) {
          const prevY = player.y
          const ny = player.y + sd
          if (sd <= 0) {
            // landing scan: block tops inside the swept band
            let land = null
            let unknown = false
            const x0 = Math.floor(player.x - P_HW + 1e-6), x1 = Math.floor(player.x + P_HW - 1e-6)
            const z0 = Math.floor(player.z - P_HW + 1e-6), z1 = Math.floor(player.z + P_HW - 1e-6)
            for (let bx = x0; bx <= x1; bx++)
              for (let bz = z0; bz <= z1; bz++)
                for (let by = Math.floor(ny - 1e-6); by <= Math.floor(prevY + 1e-6); by++) {
                  const t = boxTopAt(bx, by, bz)
                  if (t === undefined) { unknown = true; continue }
                  if (t === null) continue
                  if (t <= prevY + 1e-6 && t >= ny - 1e-9) { if (land === null || t > land) land = t }
                }
            if (land !== null) {
              player.y = land; player.dy = 0; player.onGround = true; player.airborne = false
              if (arena.stage === 'fall') { arena.landingY = land; arena.stage = 'protocol'; log(`sonar: landed y=${land.toFixed(4)} (blocks) — waiting for echoes`) }
              return
            }
            if (unknown && player.floorY != null && ny <= player.floorY) {
              player.y = player.floorY; player.dy = 0; player.onGround = true; player.airborne = false
              if (arena.stage === 'fall') { arena.landingY = player.floorY; arena.stage = 'protocol'; log(`sonar: landed y=${player.floorY.toFixed(4)} (plane) — waiting for echoes`) }
              return
            }
            player.y = ny
            player.onGround = false
          } else {
            // head bump
            let ceil = null
            const x0 = Math.floor(player.x - P_HW + 1e-6), x1 = Math.floor(player.x + P_HW - 1e-6)
            const z0 = Math.floor(player.z - P_HW + 1e-6), z1 = Math.floor(player.z + P_HW - 1e-6)
            const headNew = ny + P_H
            for (let bx = x0; bx <= x1; bx++)
              for (let bz = z0; bz <= z1; bz++)
                if (solidAt(bx, Math.floor(headNew), bz)) { ceil = Math.floor(headNew) - P_H - 1e-4 }
            if (ceil !== null && ceil > player.y) { player.y = ceil; player.dy = 0; return }
            player.y = ny
          }
        }
      } else if (!player.airborne && !groundSupported()) {
        player.airborne = true // walked off an edge
        player.dy = 0
      } else if (!player.airborne) {
        player.onGround = true // standing on known ground — keep the flag honest
      }
    }

    /* ---------------- inputs: a human at the keyboard/mouse (look, walk, jump, sneak) ---------------- */
    const input = {
      wishX: 0, wishZ: 0, sneak: false, sprint: false, jumpRequest: false,
      mode: 'idle', modeUntil: Date.now() + 3000 + Math.random() * 5000,
      fromYaw: null, fromPitch: 0, toYaw: 0, toPitch: 0, lerp0: 0, lerpDur: 400,
      lookAt: 0, nextJump: Date.now() + 4000 + Math.random() * 8000, anchor: null,
      sentSneak: false, sentSprint: false,
      trackAt: 0, trackX: 0, trackZ: 0, stuckSince: 0
    }
    const yawNorm = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a }
    function pickLook (now) {
      input.fromYaw = player.yaw
      input.fromPitch = player.pitch
      if (entities.size && Math.random() < 0.35) {
        // face the nearest thing on screen first, else the nearest known —
        // players constantly glance at whatever is around them
        let best = null, bd = 144
        for (const id of visibleEntities) {
          const e = entities.get(id)
          if (!e) continue
          const d = (e.x - player.x) ** 2 + (e.y - player.y) ** 2 + (e.z - player.z) ** 2
          if (d < bd) { bd = d; best = e }
        }
        if (!best) {
          for (const e of entities.values()) {
            const d = (e.x - player.x) ** 2 + (e.y - player.y) ** 2 + (e.z - player.z) ** 2
            if (d < bd) { bd = d; best = e }
          }
        }
        if (best) {
          const dx = best.x - player.x, dz = best.z - player.z, dy = (best.y + 1.0) - (player.y + 1.62)
          input.toYaw = yawNorm(Math.atan2(-dx, dz) * 180 / Math.PI)
          input.toPitch = -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI
        }
      } else {
        input.toYaw = yawNorm(player.yaw + (Math.random() * 160 - 80))
        input.toPitch = -25 + Math.random() * 35
      }
      input.lerp0 = now
      input.lerpDur = 250 + Math.random() * 650
      input.lookAt = now + input.lerpDur + 900 + Math.random() * 3000
    }
    function setSprintState (on) {
      if (input.sentSprint === on) return
      input.sentSprint = on
      try { pkt('play', 'entity_action', { entityId: player.entityId, actionId: on ? 'start_sprinting' : 'stop_sprinting', jumpBoost: 0 }) } catch {}
      player.sprinting = on
    }
    function setSneakState (on) {
      if (input.sentSneak === on) return
      input.sentSneak = on
      try { pkt('play', 'entity_action', { entityId: player.entityId, actionId: on ? 'start_sneaking' : 'stop_sneaking', jumpBoost: 0 }) } catch {}
      player.sneaking = on
    }
    // what a rendered client would actually have on screen right now:
    // inside the ~70° frustum, within view distance, no blocks in the way
    function lineOfSight (ex, ey, ez) {
      const sx = player.x, sy = player.y + 1.62, sz = player.z
      const dx = ex - sx, dy = (ey + 1.0) - sy, dz = ez - sz
      const dist = Math.hypot(dx, dy, dz)
      if (dist < 0.05) return true
      const steps = Math.ceil(dist / 0.4)
      for (let i = 1; i < steps; i++) {
        const t = i / steps
        const bx = Math.floor(sx + dx * t), by = Math.floor(sy + dy * t), bz = Math.floor(sz + dz * t)
        if (worldBlockCat(bx, by, bz) === 1) return false // solid blocks the view
      }
      return true
    }
    function updateVisibility () {
      visibleEntities.clear()
      const rad = player.yaw * Math.PI / 180
      const pitch = player.pitch * Math.PI / 180
      const fx = -Math.sin(rad) * Math.cos(pitch), fy = -Math.sin(pitch), fz = Math.cos(rad) * Math.cos(pitch)
      for (const [id, e] of entities) {
        const dx = e.x - player.x, dy = (e.y + 1.0) - (player.y + 1.62), dz = e.z - player.z
        const dist = Math.hypot(dx, dy, dz)
        if (dist > CLIENT_VD * 16 || dist > 64) continue
        const dot = (dx * fx + dy * fy + dz * fz) / (dist || 1)
        if (dot < 0.819) continue // outside the ~70° view cone
        if (!lineOfSight(e.x, e.y, e.z)) continue
        visibleEntities.add(id)
        if (!seenEntities.has(id)) {
          seenEntities.add(id)
          if (cfg.verbose && verifyDone && !arena.active) log(`render: see entity #${id} at ${dist.toFixed(1)} blocks`)
        }
      }
    }
    // keep the rendered world centered on the player — vanilla unloads what
    // falls outside view distance as you walk away
    let renderCx = null, renderCz = null
    function renderCenterTick () {
      const cx = player.x >> 4, cz = player.z >> 4
      if (cx === renderCx && cz === renderCz) return
      renderCx = cx; renderCz = cz
      for (const k of [...loadedChunks]) {
        const [ccx, ccz] = k.split(',').map(Number)
        if (Math.max(Math.abs(ccx - cx), Math.abs(ccz - cz)) > CLIENT_VD + 1) dropChunk(ccx, ccz)
      }
    }
    function inputTick () {
      const now = Date.now()
      updateVisibility()
      if (!cfg.antiAfk) {
        // ANTI_AFK=off — a perfectly still vanilla player: no look, no steps,
        // no jumps, no swings; nothing but the idle heartbeat goes on the wire
        input.wishX = 0; input.wishZ = 0
        input.mode = 'idle'
        input.jumpRequest = false
        setSprintState(false); setSneakState(false)
        input.stuckSince = 0; input.trackAt = 0
        return
      }
      /* look: eased glide to a new aim point — the mouse is never perfectly still */
      if (input.fromYaw === null) { input.fromYaw = player.yaw; input.fromPitch = player.pitch; input.toYaw = player.yaw; input.toPitch = player.pitch; input.lookAt = now + 1000 }
      if (now >= input.lookAt) pickLook(now)
      const u = Math.min(1, (now - input.lerp0) / input.lerpDur)
      const ease = u * u * (3 - 2 * u)
      const dyaw = yawNorm(input.toYaw - input.fromYaw)
      const dpitch = input.toPitch - input.fromPitch
      player.yaw = yawNorm(input.fromYaw + dyaw * ease)
      player.pitch = input.fromPitch + dpitch * ease
      /* movement modes: idle <-> walk (rare sneak-walk), human-length holds */
      if (player.ridingId) {
        // aboard a vehicle a player only looks around — no walking, no swings
        input.wishX = 0; input.wishZ = 0
        input.mode = 'idle'
        setSprintState(false); setSneakState(false)
        return
      }
      if (now >= input.modeUntil) {
        const r = Math.random()
        if (input.mode === 'idle') {
          if (r < 0.75) { input.mode = 'walk'; input.modeUntil = now + 3000 + Math.random() * 9000 }
          else input.modeUntil = now + 2000 + Math.random() * 8000
        } else if (input.mode === 'sneak') {
          input.mode = 'walk'
          setSneakState(false)
          input.modeUntil = now + 3000 + Math.random() * 7000
        } else { // walk -> (rarely sneak-walk) or idle
          setSprintState(false)
          if (r < 0.12) { input.mode = 'sneak'; setSneakState(true) } else input.mode = 'idle'
          input.modeUntil = input.mode === 'sneak' ? now + 2500 + Math.random() * 3500 : now + 2500 + Math.random() * 9000
        }
      }
      if (input.mode === 'walk' || input.mode === 'sneak') {
        // forward along the current look direction (walking curves with the mouse)
        const rad = player.yaw * Math.PI / 180
        input.wishX = -Math.sin(rad)
        input.wishZ = Math.cos(rad)
        /* pace a small circle around the spot the server put us on — a real
           player fidgets in place; walking off into the void is what the
           anticheat flags (fall-through rubber-band loop) */
        if (input.anchor) {
          const ax = player.x - input.anchor.x, az = player.z - input.anchor.z
          const ad = Math.hypot(ax, az)
          if (ad > 0.55) {
            if (ad > 0.85) {
              input.wishX = -ax / ad
              input.wishZ = -az / ad
            } else {
              const ox = ax / ad, oz = az / ad
              const outward = input.wishX * ox + input.wishZ * oz
              if (outward > 0) {
                input.wishX -= ox * outward
                input.wishZ -= oz * outward
                const m = Math.hypot(input.wishX, input.wishZ)
                if (m > 1e-6) { input.wishX /= m; input.wishZ /= m } else { input.wishX = 0; input.wishZ = 0 }
              }
            }
          }
        }
        if (input.mode === 'walk' && !input.sentSprint && Math.random() < 0.02) setSprintState(true)
        /* stuck detector: human would stop, look around, try again */
        if (now - input.trackAt > 500) {
          if (input.trackAt && Math.hypot(player.x - input.trackX, player.z - input.trackZ) < 0.25) {
            if (!input.stuckSince) input.stuckSince = input.trackAt
            else if (now - input.stuckSince > 2200) {
              pickLook(now)
              input.toYaw = yawNorm(player.yaw + 140 + Math.random() * 60)
              input.jumpRequest = true
              input.stuckSince = 0
              input.modeUntil = now + 800 // release keys briefly, like a person re-adjusting
            }
          } else input.stuckSince = 0
          input.trackAt = now; input.trackX = player.x; input.trackZ = player.z
        }
        /* hop while walking — occasional, like a person crossing a field */
        if (now >= input.nextJump && input.mode === 'walk') { input.jumpRequest = true; input.nextJump = now + 3500 + Math.random() * 5500 }
      } else {
        input.wishX = 0; input.wishZ = 0
        setSprintState(false)
        setSneakState(false)
        input.stuckSince = 0; input.trackAt = 0
      }
      // no fidget swings / hotbar scrolls — vanilla clients only put
      // arm_animation and held_item_slot on the wire when the player acts
    }

    function playerTick () {
      // vanilla LocalPlayer.l() while riding: rotation + vehicle input every
      // tick, and vehicle movement instead of player movement (research.md +
      // fsj.java:808-213 — aeg.c Rot + ServerboundPlayerInputPacket each tick)
      if (arena.active && arena.stage === 'vehicle') {
        // golden s5: the phase bursts own the wire — the tick loop stays silent
        return
      }
      // inputs + world collision only after verification, only outside the arena
      // (the Sonar plane/teleport path above stays byte-identical)
      const playing = state === 'play' && verifyDone && !arena.active && player.inWorld && !player.spectator
      if (playing && player.ridingId) {
        // riding: our transform IS the vehicle's transform; the wire sees
        // ServerboundMoveVehicle only (that is how vanilla passengers move)
        inputTick()
        const v = entities.get(player.ridingId)
        if (v) {
          player.x = v.x; player.y = v.y + 0.35; player.z = v.z
          const moved = !player.lastVeh || v.x !== player.lastVeh.x || v.y !== player.lastVeh.y || v.z !== player.lastVeh.z
          const turned = !player.lastVeh || player.yaw !== player.lastVeh.yaw || player.pitch !== player.lastVeh.pitch
          if (moved || turned) {
            try { pkt('play', 'vehicle_move', { x: player.x, y: v.y, z: player.z, yaw: player.yaw, pitch: player.pitch }) } catch {}
            player.lastVeh = { x: v.x, y: v.y, z: v.z, yaw: player.yaw, pitch: player.pitch }
          }
        }
        return
      }
      if (playing) {
        inputTick()
        // vanilla walk/sprint/sneak speed (blocks/tick), approach curve ground .4 / air .12
        const spd = (input.sneak ? 1.295 : input.sentSprint ? 5.612 : 4.317) / 20
        // paused = rubber-batch pause OR standing on the AFK pad (walking
        // there is what the anticheat kicks for — look glides still run)
        const paused = Date.now() < (input.pauseUntil || 0) || !!player.afkStand
        const wx = paused ? 0 : input.wishX
        const wz = paused ? 0 : input.wishZ
        player.dx += (wx * spd - player.dx) * (player.airborne ? 0.12 : 0.4)
        player.dz += (wz * spd - player.dz) * (player.airborne ? 0.12 : 0.4)
        if (Math.abs(player.dx) < 1e-5) player.dx = 0
        if (Math.abs(player.dz) < 1e-5) player.dz = 0
        if (input.jumpRequest && !paused && !player.airborne && player.onGround) {
          player.dy = 0.42 // vanilla jump
          player.airborne = true
          player.onGround = false
        }
        input.jumpRequest = false
        stepHorizontal()
        if (player.airborne) player.dy = (player.dy - 0.08) * 0.98
        stepVertical()
        renderCenterTick()
      } else {
      // horizontal travel (only nonzero after a knockback velocity packet);
      // drag: air 0.91, ground 0.91*friction(0.6) — matches vanilla travel()
      if (player.dx !== 0 || player.dz !== 0) {
        player.x += player.dx
        player.z += player.dz
        const drag = player.airborne ? 0.91 : 0.546
        player.dx *= drag
        player.dz *= drag
        if (Math.abs(player.dx) < 1e-4) player.dx = 0
        if (Math.abs(player.dz) < 1e-4) player.dz = 0
      }
      // physics (Entity/LivingEntity): gravity while airborne, collide at floor
      if (player.airborne) {
        if (arena.stage === 'fall' && arena.restFrames > 0) {
          // golden s5: hold at the teleport target for a rest tick, reporting
          // position_look each tick, THEN let gravity start
          arena.restFrames--
          try { pkt('play', 'position_look', { x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch, onGround: false }) } catch {}
          return
        }
        player.dy = (player.dy - 0.08) * 0.98
        if (arena.stage === 'fall') {
          // block collision first (mbc platform collides solid via the
          // unknown-state fallback); golden s5's landing plane stays as the
          // guaranteed floor — then FALL THROUGH to D() so every frame of the
          // descent actually goes on the wire (Sonar counts them)
          stepVertical()
          if (player.airborne && player.floorY != null && player.dy < 0 && player.y + player.dy <= player.floorY) {
            player.y = player.floorY; player.dy = 0
            player.onGround = true; player.airborne = false
            arena.landingY = player.floorY
            arena.stage = 'protocol'
            log(`sonar: landed y=${player.floorY.toFixed(4)} (plane ${arena.blockHeight}) — waiting for echoes`)
          } else if (player.airborne) player.onGround = false
        } else {
          let ny = player.y + player.dy
          if (player.floorY != null && player.dy < 0 && ny <= player.floorY) {
            ny = player.floorY; player.dy = 0
            player.onGround = true; player.airborne = false
          } else {
            player.onGround = false
          }
          player.y = ny
        }
      }
      }
      // fsj.D() verbatim decision tree
      const dx = player.x - player.xOld
      const dyv = player.y - player.yOld
      const dz = player.z - player.zOld
      const dyaw = player.yaw - player.yawOld
      const dpitch = player.pitch - player.pitchOld
      ++player.reminder
      const moved = (dx * dx + dyv * dyv + dz * dz) > 4.0e-8 || (REMINDERS && player.reminder >= 20)
      const rot = dyaw !== 0 || dpitch !== 0
      try {
        // sonar-bypass: every movement packet is closed by a tick-end marker
        // (1.21.2+ "tick_end"; on the 765 wire the movement-set closer we can
        // actually send is `flying`) — without a closer the fall is discarded
        // with the exact same "Verification failed" symptom
        if (moved && rot) {
          pkt('play', 'position_look', { x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch, onGround: player.onGround })
          if (!OLD_SHAPE && TICK_CLOSER) pkt('play', 'flying', { onGround: player.onGround })
        } else if (moved) {
          pkt('play', 'position', { x: player.x, y: player.y, z: player.z, onGround: player.onGround })
          if (!OLD_SHAPE && TICK_CLOSER) pkt('play', 'flying', { onGround: player.onGround })
        } else if (rot) {
          pkt('play', 'look', { yaw: player.yaw, pitch: player.pitch, onGround: player.onGround })
          if (!OLD_SHAPE && TICK_CLOSER) pkt('play', 'flying', { onGround: player.onGround })
        } else if (player.groundOld !== player.onGround) {
          pkt('play', 'flying', { onGround: player.onGround }) // vanilla aeg.d
        }
        if (arena.stage === 'fall' && moved) log(`sonar: frame y=${player.y} og=${player.onGround}`)
        if (player.tpAt && Date.now() - player.tpAt < 120000 && (player.tpSends || 0) < 6 && (moved || rot)) {
          player.tpSends = (player.tpSends || 0) + 1
          if (cfg.verbose) log(`send#${player.tpSends} pos=(${player.x.toFixed(2)},${player.y.toFixed(3)},${player.z.toFixed(2)}) og=${player.onGround ? 1 : 0} yaw=${player.yaw.toFixed(1)} pitch=${player.pitch.toFixed(1)} mode=${input.mode}`)
        }
      } catch (err) { log(`sonar: playerTick ERROR ${err.message}`) }
      if (moved) {
        player.xOld = player.x; player.yOld = player.y; player.zOld = player.z
        player.reminder = 0
      }
      if (rot) { player.yawOld = player.yaw; player.pitchOld = player.pitch }
      if (player.tpAt && Date.now() - player.tpAt < 180000 && player.groundOld !== player.onGround) {
        if (cfg.verbose) log(`ground flip → og=${player.onGround ? 1 : 0} y=${player.y.toFixed(3)} dy=${player.dy.toFixed(3)} air=${player.airborne ? 1 : 0} mode=${input.mode}`)
      }
      player.groundOld = player.onGround
    }
    function playerStartLoop () {
      if (arenaTickTimer) return
      const period = OLD_SHAPE ? 44 : 50
      let next = Date.now() + period // stay on the vanilla 20Hz game-tick grid
      const step = () => {
        if (!player.inWorld || socket.destroyed) { arenaTickTimer = null; return }
        tickBatch = []
        playerTick()
        const frames = tickBatch; tickBatch = null
        if (frames.length) socket.write(Buffer.concat(frames)) // one flush per tick
        const now = Date.now()
        if (next <= now - period) next = now + period // fell behind badly; re-grid
        else next += period
        arenaTickTimer = setTimeout(step, Math.max(0, next - now))
      }
      arenaTickTimer = setTimeout(step, period)
    }
    function arenaSendPos (y, onGround) {
      try { pkt('play', 'position', { x: pos ? pos.x : 0, y, z: pos ? pos.z : 0, onGround }) } catch (err) { log(`sonar: arenaSendPos ERROR ${err.message}`) }
    }

    function arenaVehicleBurst (kind, startY) {
      // golden s5 vehicle phases: 7 rounds at ~45ms. Boat rounds =
      // steer_boat + look + steer_vehicle + vehicle_move with the vehicle
      // descending ~0.21/tick (Sonar lowers it); minecart rounds have no
      // steer_boat/vehicle_move — just look + steer_vehicle, position silent
      let y = startY
      for (let r = 0; r < 7; r++) {
        arena.timers.push(setTimeout(() => {
          if (!arena.active) return
          y -= 0.21
          arena.vehY = y
          try {
            if (kind === 'boat') {
              pkt('play', 'steer_boat', { leftPaddle: true, rightPaddle: true })
              pkt('play', 'look', { yaw: player.yaw, pitch: player.pitch, onGround: false })
              pkt('play', 'steer_vehicle', { sideways: 0, forward: 0, jump: 0 })
              pkt('play', 'vehicle_move', { x: pos ? pos.x : 8, y, z: pos ? pos.z : 8, yaw: player.yaw, pitch: player.pitch })
            } else {
              pkt('play', 'look', { yaw: player.yaw, pitch: player.pitch, onGround: false })
              pkt('play', 'steer_vehicle', { sideways: 0, forward: 0, jump: 0 })
            }
          } catch {}
        }, r * 45))
      }
      arena.vehY = y
    }

    function arenaAirFall (fromY, nFrames) {
      // post-destroy free-fall (~35ms apart in golden), gravity per frame
      let y = fromY, dy = 0
      for (let f = 0; f < nFrames; f++) {
        arena.timers.push(setTimeout(() => {
          if (!arena.active) return
          dy = (dy - 0.08) * 0.98
          y += dy
          arena.vehY = y
          try { pkt('play', 'position', { x: pos ? pos.x : 8, y, z: pos ? pos.z : 8, onGround: false }) } catch {}
        }, f * 35))
      }
      arena.vehY = y
    }

    // The gate's vehicle stage is event driven (measured from the real client):
    //   spawn_entity + set_passengers -> client answers 4 quick rounds of
    //   steer_boat / look / steer_vehicle / vehicle_move AT ITS CURRENT SPOT,
    //   then the server destroys the boat and drops the player again.
    // Reporting a made-up altitude here is an instant fail.
    let arenaFallTimer
    function arenaBoatRound (label) {
      // Measured from a passing client (byte-for-byte):
      //   boat     : steer_boat(false,false) + look + steer_vehicle + vehicle_move,
      //              seven ticks, the vehicle FALLING 0.04/tick without drag
      //              (dy -0.04, -0.08, -0.12 ...), yaw/pitch 0, onGround false
      //   minecart : look + steer_vehicle only
      // The ride is reported at the VEHICLE's position: the gate spawns it at the
      // teleport altitude (y=3114), far above the landing plate.
      const veh = () => (player.ridingId !== null && player.ridingId !== undefined ? entities.get(player.ridingId) : null)
      const v0 = veh()
      const isBoat = !!(v0 && v0.type === 9)
      const baseX = v0 ? v0.x : player.x
      const baseY = v0 ? v0.y : player.y
      const baseZ = v0 ? v0.z : player.z
      const rounds = isBoat ? 7 : 6
      let vel = 0, py = baseY   // boat gravity: velocity gains 0.04/tick, position integrates it
      log(`sonar: ${label} ride (${isBoat ? 'boat' : 'minecart'}) at x=${baseX} y=${baseY} z=${baseZ}`)
      for (let r = 0; r < rounds; r++) {
        arena.timers.push(setTimeout(() => {
          if (!arena.active) return
          try {
            if (isBoat) {
              vel -= 0.04
              py += vel
              const vy = py
              player.x = baseX; player.y = vy; player.z = baseZ
              pkt('play', 'steer_boat', { leftPaddle: false, rightPaddle: false })
              pkt('play', 'look', { yaw: player.yaw, pitch: player.pitch, onGround: false })
              pkt('play', 'steer_vehicle', { sideways: 0, forward: 0, jump: 0 })
              pkt('play', 'vehicle_move', { x: baseX, y: vy, z: baseZ, yaw: 0, pitch: 0, onGround: false })
            } else {
              pkt('play', 'look', { yaw: player.yaw, pitch: player.pitch, onGround: false })
              pkt('play', 'steer_vehicle', { sideways: 0, forward: 0, jump: 0 })
            }
          } catch {}
        }, 15 + r * 33))
      }
    }
    function arenaFreeFall (tag) {
      if (arenaFallTimer) { clearInterval(arenaFallTimer); arenaFallTimer = null }
      let dy = 0
      log(`sonar: ${tag} — free fall from y=${player.y.toFixed(2)}`)
      arenaFallTimer = setInterval(() => {
        if (!arena.active) { clearInterval(arenaFallTimer); arenaFallTimer = null; return }
        if (player.ridingId !== null && player.ridingId !== undefined) return
        dy = (dy - 0.08) * 0.98
        player.y += dy
        try { pkt('play', 'position', { x: player.x, y: player.y, z: player.z, onGround: false }) } catch {}
      }, 50)
      arena.timers.push(arenaFallTimer)
    }
    function arenaVehicleAdvance () {
      const p = arena.vehiclePhase
      if (p === 'waiting') { arena.vehiclePhase = 'boat'; log('sonar: boat'); arenaVehicleBurst('boat', 3113.8) }
      else if (p === 'boat') { arena.vehiclePhase = 'air_boat'; arenaAirFall(arena.vehY || 3112.5, 4) }
      else if (p === 'air_boat') { arena.vehiclePhase = 'minecart'; log('sonar: minecart'); arenaVehicleBurst('minecart', 3111.6) }
      else if (p === 'minecart') { arena.vehiclePhase = 'air_minecart'; arenaAirFall(3097.6, 4) } // server moved the cart down — ride is silent, fall resumes there
      else if (p === 'air_minecart') {
        arena.vehiclePhase = 'done'
        arena.stage = 'done'
        arena.active = false
        for (const t of arena.timers) clearTimeout(t)
        log('sonar: verification complete — playing as a normal member')
        setVerifyDone() // commands may only run from now on
      }
    }

    /* inbound dispatch */
    const HANDLED = new Set([
      // login
      'compress', 'disconnect', 'success', 'encryption_begin', 'login_plugin_request',
      // configuration
      'keep_alive', 'ping', 'finish_configuration', 'add_resource_pack',
      // play
      'login', 'position', 'system_chat', 'player_chat', 'profileless_chat', 'kick_disconnect',
      'custom_payload', 'multi_block_change', 'animation', 'held_item_slot',
      'entity_velocity', 'tab_complete', 'set_slot', 'window_items',
      'map', 'map_chunk', 'unload_chunk', 'spawn_entity', 'rel_entity_move',
      'entity_move_look', 'entity_look', 'entity_head_rotation',
      'entity_teleport', 'entity_destroy', 'set_passengers',
      'chunk_batch_finished', 'start_configuration', 'animation',
      'open_window', 'close_window'
    ])
    const rxSeen = new Set() // pre-verification packet census (Sonar's window)
    const cfgSeen = new Map() // per-session census of the configuration state (transfers)
    const cfgLog = (name, len) => {
      const n = (cfgSeen.get(name) || 0) + 1
      cfgSeen.set(name, n)
      if (n === 1 || n % 10 === 0) log(`config rx: ${name} (${n}x) len=${len}`)
    }
    const handle = (id, payload) => {
      // only decode packets we actually act on — everything else (chunks,
      // entities, advancements, ...) is consumed by frame skipping alone
      const name0 = MAPS[state].toClient.id2name.get(id)
      if (state === 'configuration') cfgLog(name0 || ('0x' + id.toString(16)), payload.length)
      if (traceOn && !TRACE_NOISE.test(name0 || '')) traceLog('rx', state, name0 || ('0x' + id.toString(16)), payload.length)
      if (!verifyDone && state !== 'configuration' && !rxSeen.has(name0 || ('0x' + id.toString(16)))) {
        rxSeen.add(name0 || ('0x' + id.toString(16)))
        log(`rx: ${name0 || ('0x' + id.toString(16))} len=${payload.length}${HANDLED.has(name0) ? '' : ' (UNANSWERED)'}`)
      }
      if (!name0 || !HANDLED.has(name0)) {
        if (process.env.DEBUG && state === 'play') {
          debugSeen.set(name0 || ('0x' + id.toString(16)), (debugSeen.get(name0 || ('0x' + id.toString(16))) || 0) + 1)
        }
        return
      }
      if (process.env.DEBUG && state === 'play') {
        debugSeen.set(name0, (debugSeen.get(name0) || 0) + 1)
      }
      const { name, params } = decodePacket(state, 'toClient', id, payload)
      if (name === 'position') {
        arena.tpRaw = (arena.tpRaw || 0) + 1
        if (arena.tpRaw <= 3) log(`sonar: tp-raw${arena.tpRaw} len=${payload.length} ${payload.toString('hex')}`)
      }
      if (name === 'multi_block_change' && arena.active && !arena.mbcRawLogged) {
        arena.mbcRawLogged = true
        log(`sonar: mbc-payload len=${payload.length} ${payload.toString('hex')}`)
      }
      // DEBUG_CHAT=1 dumps every chat-shaped packet as received, so the colour pipeline can be
      // checked against real server data instead of guesses. Off by default; file is chatraw.jsonl.
      if (DEBUG_CHAT && /chat|message|title|action_bar|subtitle|tab_list/i.test(String(name || ''))) {
        try {
          fs.appendFileSync(path.join(__dirname, 'chatraw.jsonl'), JSON.stringify({ name, params },
            (k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data)) ? `<${v.data.length}b>` : (Buffer.isBuffer(v) ? `<${v.length}b>` : v)) + '\n')
        } catch {}
      }
      switch (name) {
        case null: return // unknown for this state — skip (framing already consumed it)

        /* --- login --- */
        case 'compress':
          threshold = params.threshold
          log(`compression on (>=${threshold}b)`)
          return
        case 'disconnect': { // login / configuration state
          const why = flattenComponent(params.reason)
          onText(why, null, legacyOf(params.reason))
          const b = banInfo(why, cfg.playerName)
          if (b) {
            log(`blacklisted by the server — waiting ${Math.round(b.ms / 60000)} min before touching it again`)
            banUntil = Date.now() + b.ms
            finish('banned')
            return
          }
          finish(/verified successfully/i.test(why) ? 'rejoin' : 'restart')
          return
        }
        case 'encryption_begin':
          log('server requires online-mode encryption — this bot only supports offline (cracked) servers')
          finish('error')
          return
        case 'success': {
          if (params.username === 'Sonar') {
            arena.active = true
            log('login ok — verification arena (anti-bot proof required)')
          } else {
            setVerifyDone() // no Sonar gate for this session — account already verified
          }
          pkt('login', 'login_acknowledged', {})
          state = 'configuration'
          log('login ok — configuration')
          // vanilla order (captured): brand first, then client settings
          pkt('configuration', 'custom_payload', { channel: 'minecraft:brand', data: Buffer.concat([writeUvarint(7), Buffer.from('vanilla')]) })
          pkt('configuration', 'settings', clientInfo())
          return
        }
        case 'login_plugin_request':
          pkt('login', 'login_plugin_response', { messageId: params.messageId, understood: false, data: Buffer.alloc(0) })
          return

        /* --- configuration --- */
        case 'keep_alive':
          // vanilla replies to keep-alives immediately on the network thread
          // (ClientCommonPacketListenerImpl has no thread guard for these)
          if (state === 'configuration') pkt('configuration', 'keep_alive', { keepAliveId: params.keepAliveId })
          else if (state === 'play') {
            pkt('play', 'keep_alive', { keepAliveId: params.keepAliveId })
            // during verification each keep-alive drives the boat/minecart phases
            // vehicle stages are driven by set_passengers / entity_destroy,
            // with this as a safety net: if we are aboard and have not answered
            // yet, answer now (the gate closes the socket when a ride is ignored)
            if (arena.active && player.ridingId !== null && player.ridingId !== undefined && !arena.boatDone) {
              arena.boatDone = true
              arena.stage = 'vehicle'
              arenaBoatRound('boat (keep-alive)')
            }
          }
          return
        case 'ping':
          if (state === 'configuration') pkt('configuration', 'pong', { id: params.id })
          else if (state === 'play') {
            if (arena.active) {
              // verification pings are answered immediately (raw-handler style)
              // and each one can drive the vehicle phases
              pkt('play', 'pong', { id: params.id }) // vehicle phases advance on keep-alive (research.md)
            } else queueTick(() => pkt('play', 'pong', { id: params.id }))
          }
          return
        case 'finish_configuration':
          // golden s5: the real client acks ~85ms after finish arrives
          setTimeout(() => { try { pkt('configuration', 'finish_configuration', {}) } catch {} }, 85)
          state = 'play'
          if (cfgWatch) { clearTimeout(cfgWatch); cfgWatch = null }
          log('configuration done — entering play')
          // golden s5 re-sends client information in PLAY — after the rest
          // pos_look inside the tp2 burst, not here
          // (no openGate here — the queue opens only after verify + AuthMe)
          // idle heartbeat: vanilla sends the no-move "flying" packet about
          // once a second while standing still — matches the captured cadence
          heartbeat = setInterval(() => {
            if (state !== 'play') return // never write play packets into a configuration
            if (arena.active) return // verification: no idle spam — probes only
            if (pos) {
              queueTick(() => { try { if (!OLD_SHAPE && TICK_CLOSER) pkt('play', 'flying', { onGround: true }) } catch {} })
              if (player.tpAt && Date.now() - player.tpAt < 180000) {
                player.hbN = (player.hbN || 0) + 1
                if (player.hbN % 10 === 0) {
                  if (cfg.verbose) log(`state x=${player.x.toFixed(2)} y=${player.y.toFixed(3)} z=${player.z.toFixed(2)} og=${player.onGround ? 1 : 0} air=${player.airborne ? 1 : 0} dy=${player.dy.toFixed(3)} floorY=${player.floorY == null ? 'null' : player.floorY.toFixed(3)} mode=${input.mode} server=(${pos.x.toFixed(2)},${pos.y.toFixed(3)},${pos.z.toFixed(2)})`)
                }
              }
            }
          }, 1000)
          return
        case 'add_resource_pack':
          if (state === 'configuration') pkt('configuration', 'resource_pack_receive', { uuid: params.uuid, result: 0 })
          else if (state === 'play') pkt('play', 'resource_pack_receive', { uuid: params.uuid, result: 0 })
          return

        /* --- play --- */
        case 'login': // game join
          player.entityId = params.entityId
          player.gameMode = params.gameMode
          player.inWorld = true
          curMode = params.gameMode
          joinEvents.push({ mode: params.gameMode, at: Date.now() })
          if (pendingCaptcha && Date.now() - pendingCaptcha.at < 60000) {
            try {
              const dir = path.join(__dirname, 'captcha-samples')
              fs.mkdirSync(dir, { recursive: true })
              const safe = pendingCaptcha.text.replace(/[^A-Za-z0-9]/g, '_').slice(0, 16) || 'blank'
              let saved = null
              if (pendingCaptcha.bin && fs.existsSync(pendingCaptcha.bin)) {
                saved = path.join(dir, `${safe}__${Date.now()}.bin`)
                fs.copyFileSync(pendingCaptcha.bin, saved)
              }
              const meta = path.join(dir, 'labels.jsonl')
              fs.appendFileSync(meta, JSON.stringify({ text: pendingCaptcha.text, by: pendingCaptcha.by, bin: saved, at: new Date().toISOString() }) + '\n')
              log(`verify: "${pendingCaptcha.text}" was ACCEPTED — saved as a labelled sample${pendingCaptcha.by === 'human' ? ' (answered by you)' : ''}`)
            } catch (e) { log(`verify: could not save the labelled sample (${e.message})`) }
            pendingCaptcha = null
          }
          log(`joined world (entity ${params.entityId}, mode ${params.gameMode})`)
          // the LocalPlayer tick loop runs for the whole session, exactly like
          // the real game — verify sessions arm it at tp2 (unchanged shape),
          // lobby sessions start it right away
          if (!arena.active) playerStartLoop()
          return
        case 'position': { // synchronize player position
          pos = { x: params.x, y: params.y, z: params.z, yaw: params.yaw, pitch: params.pitch }
          try { input.anchor = { x: params.x, z: params.z } } catch {}
          if (arena.active && arena.stage === 'idle') {
            // Anti-bot probe. Sonar's doubles are big-endian like the rest of
            // the MC protocol; we decode BE and answer each teleport the way
            // vanilla's fnt.handleMovePlayer does — teleport_confirm +
            // position_look of the applied target, one immediate burst — then
            // run client-side gravity (8 ticks, landing with tick 8).
            const yRel = (params.flags & 0x02) !== 0
            if (!yRel) {
              arena.y1 = params.y
              arena.tid1 = params.teleportId
              log(`sonar: tp1 y=${params.y} tid=${params.teleportId}`)
              // fnt.a(abg): apply per relative-flags, reset olds, then the
              // immediate confirm + position_look echo of the applied target
              const ax = (params.flags & 0x01) ? player.x + params.x : params.x
              const ay = params.y
              const az = (params.flags & 0x04) ? player.z + params.z : params.z
              const ayaw = (params.flags & 0x08) ? player.yaw + params.yaw : params.yaw
              const apitch = (params.flags & 0x10) ? player.pitch + params.pitch : params.pitch
              playerTeleport(ax, ay, az, ayaw, apitch)
              player.airborne = true // mid-air drop point — physics resumes
              const burst1 = () => {
                try {
                  pkt('play', 'teleport_confirm', { teleportId: params.teleportId })
                  pkt('play', 'position_look', { x: ax, y: ay, z: az, yaw: ayaw, pitch: apitch, onGround: false })
                  if (!OLD_SHAPE && TICK_CLOSER) pkt('play', 'flying', { onGround: false })
                } catch {}
              }
              // golden s5: the real client confirms ~800ms after the tp
              // batch arrives (terrain load); tp2 confirms one tick later
              setTimeout(() => { if (arena.active) burst1() }, CONFIRM1_MS)
              return
            }
            const spawnY = (arena.y1 != null ? arena.y1 : 0) + params.y
            const px = params.x, pz = params.z
            arena.stage = 'fall'
            log(`sonar: tp2 delta=${params.y} → spawnY=${spawnY}`)
            // apply relative-y teleport, reset olds, immediate confirm+echo —
            // then the client's tick loop does the rest: 8 gravity ticks land
            // on the platform, exactly like the decompiled game
            playerTeleport(px, spawnY, pz, params.yaw, params.pitch)
            player.airborne = true
            player.dy = 0
            player.floorY = spawnY - FLOOR_DROP // last-resort plane if the world is unknown
            arena.spawnY = spawnY
            // the obstacle packet can arrive before or after the teleport — apply
            // it whichever side we are on (0 here just means "not here yet")
            const placedN = applyArenaBlocks(spawnY)
            if (placedN) log(`sonar: arena obstacle built (${placedN} blocks)`)
            const burst2 = () => {
              try {
                pkt('play', 'teleport_confirm', { teleportId: params.teleportId })
                pkt('play', 'position_look', { x: px, y: spawnY, z: pz, yaw: params.yaw, pitch: params.pitch, onGround: false })
                if (!OLD_SHAPE && TICK_CLOSER) pkt('play', 'flying', { onGround: false })
              } catch {}
            }
            if (OLD_SHAPE) { setTimeout(() => { if (arena.active) playerStartLoop() }, 20); return }
            // golden s5 exact timeline: tp1 confirms ~800ms after arrival
            // (the real client's terrain-load pause) and tp2 one tick later —
            // a tick-based client can only accept one teleport per tick.
            // Then: rest pos_look +45ms after the echo, play settings right
            // after rest, ~160ms pause, and the descent at one frame per tick
            // landing on frame ~10 — Sonar judges the shape of the fall
            setTimeout(() => {
              if (!arena.active) return
              burst2()
              setTimeout(() => {
                if (!arena.active) return
                try { pkt('play', 'position_look', { x: px, y: spawnY, z: pz, yaw: params.yaw, pitch: params.pitch, onGround: false }) } catch {}
                if (process.env.SONAR_PLAY_SETTINGS) { try { pkt('play', 'settings', clientInfo()) } catch {} } // not sent by a real client (kept behind a flag)
                setTimeout(() => {
                let y = spawnY, dy = 0
                try {
                  const probe = landTop(px, pz, spawnY, spawnY - 64)
                  log(`sonar: column floor below spawn = ${probe === null ? 'none' : probe.toFixed(4)} (world blocks ${arena.mbcRecords ? arena.mbcRecords.length : 0})`)
                } catch {}
                const iv = setInterval(() => {
                  if (!arena.active || arena.stage !== 'fall') { clearInterval(iv); return }
                  dy = (dy - 0.08) * 0.98
                  const nextY = y + dy
                  // collide with the blocks on the wire (walls, slabs, ...),
                  // not with an assumed floor
                  const hit = landTop(px, pz, y, nextY)
                  if (hit !== null && hit <= y + 1e-4 && hit >= nextY - 1e-4) {
                    y = hit
                    clearInterval(iv)
                    try { pkt('play', 'position', { x: px, y, z: pz, onGround: true }) } catch {}
                    log(`sonar: collision landing at y=${y.toFixed(4)}`)
                    player.xOld = px; player.yOld = y; player.zOld = pz
                    player.x = px; player.y = y; player.z = pz
                    player.dy = 0; player.onGround = true; player.airborne = false
                    arena.landingY = y
                    arena.stage = 'protocol'
                    log(`sonar: landed y=${y.toFixed(4)} (burst) — waiting for echoes`)
                    return
                  }
                  if (y < spawnY - 64) {
                    clearInterval(iv)
                    log('sonar: no collision surface in 64 blocks — still falling, letting the server re-teleport')
                    arena.stage = 'fall'
                    return
                  }
                  y = nextY
                  try { pkt('play', 'position', { x: px, y, z: pz, onGround: false }) } catch {}
                }, FALL_MS)
                }, LOAD_PAUSE_MS)
              }, 45)
            }, CONFIRM1_MS + CONFIRM_GAP_MS)
            return // the burst drives the fall — the tick loop stays out of it
            return
          }
          if (arena.active) {
            // mid-verification teleport — vanilla applies it and echoes like
            // the initial pair (fnt.a(abg)); the tick loop keeps running
            const ax = (params.flags & 0x01) ? player.x + params.x : params.x
            const ay = (params.flags & 0x02) ? player.y + params.y : params.y
            const az = (params.flags & 0x04) ? player.z + params.z : params.z
            const ayaw = (params.flags & 0x08) ? player.yaw + params.yaw : params.yaw
            const apitch = (params.flags & 0x10) ? player.pitch + params.pitch : params.pitch
            playerTeleport(ax, ay, az, ayaw, apitch)
            pos = { x: ax, y: ay, z: az, yaw: ayaw, pitch: apitch }
            try {
              pkt('play', 'teleport_confirm', { teleportId: params.teleportId })
              pkt('play', 'position_look', { x: ax, y: ay, z: az, yaw: ayaw, pitch: apitch, onGround: false })
            } catch {}
            return
          }
          // vanilla fnt.a(abg): apply relative flags, reset old pos/rot, then
          // confirm BEFORE the position echo — immediately, same tick as recv
          const ax = (params.flags & 0x01) ? player.x + params.x : params.x
          const ay = (params.flags & 0x02) ? player.y + params.y : params.y
          const az = (params.flags & 0x04) ? player.z + params.z : params.z
          const ayaw = (params.flags & 0x08) ? player.yaw + params.yaw : params.yaw
          const apitch = (params.flags & 0x10) ? player.pitch + params.pitch : params.pitch
          playerTeleport(ax, ay, az, ayaw, apitch)
          pos = { x: ax, y: ay, z: az, yaw: ayaw, pitch: apitch }
          // lobby teleport target = standing spot -> that's our ground plane
          player.floorY = ay
          player.airborne = false
          player.dy = 0
          player.tpAt = Date.now()
          player.tpSends = 0
          player.hbN = 0
          // server-truth hold: while close to this target the wire position is
          // ground truth — our model may lack the pad blocks, but the server
          // has us standing here (see stepVertical hold)
          player.tpHold = { x: ax, y: ay, z: az, at: Date.now() }
          // correction burst -> pause walking (a human stops when rubber-banded)
          const nowT = Date.now()
          player.tpTimes = (player.tpTimes || []).filter(t => nowT - t < 10000)
          player.tpTimes.push(nowT)
          if (player.tpTimes.length >= 3 && nowT >= (input.pauseUntil || 0)) {
            input.pauseUntil = nowT + 20000
            log(`input pause 20s — ${player.tpTimes.length} corrections in 10s`)
          }
          // one probe per pad target: what does our chunk actually hold there?
          const pk = Math.round(ax) + ',' + Math.round(az)
          player.probedPads = player.probedPads || []
          if (ay >= 50) {
            player.tpTargets = player.tpTargets || []
            if (!player.tpTargets.some(t => Math.abs(t[0] - ax) < 4 && Math.abs(t[1] - az) < 4)) {
              player.tpTargets.push([ax, az])
              // if the target chunk already arrived, dump its raw bytes now
              const tcx = Math.floor(ax) >> 4, tcz = Math.floor(az) >> 4
              const hit = (player.rawKeep || []).find(c => c.x === tcx && c.z === tcz)
              if (hit) {
                player.padSaves = (player.padSaves || 0) + 1
                if (player.padSaves <= 4) {
                  try {
                    require('fs').writeFileSync(`/tmp/padchunk_tp_${player.padSaves}_${tcx}_${tcz}.bin`, hit.data || Buffer.alloc(0))
                    log(`pad target chunk raw saved(from keep) /tmp/padchunk_tp_${player.padSaves}_${tcx}_${tcz}.bin len=${(hit.data || []).length}`)
                  } catch {}
                }
              } else log(`pad target chunk ${tcx},${tcz} not yet in rawKeep`)
            }
          }
          if (ay >= 50 && !player.probedPads.includes(pk) && player.probedPads.length < 6) {
            player.probedPads.push(pk)
            const probeAt = (ms, tag) => setTimeout(() => {
              if (!VERBOSE) return
              try {
                const bx = Math.floor(ax), bz = Math.floor(az), by = Math.floor(ay)
                const lines = []
                for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
                  const x = bx + dx, z = bz + dz, y = by + dy
                  const loaded = loadedChunks.has(chunkKey(x >> 4, z >> 4))
                  const arr = loaded ? sections.get(sectKey(x >> 4, z >> 4, y >> 4)) : null
                  const st = arr ? arr[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] : -1
                  lines.push(`(${x},${y},${z}) cat=${worldBlockCat(x, y, z)} st=${st} sec=${arr ? 1 : 0} ld=${loaded ? 1 : 0}`)
                }
                log(`pad probe${tag} @${pk} gen=${sessionGen}:\n  ` + lines.join('\n  '))
              } catch (e) { log('pad probe err: ' + e.message) }
            }, ms)
            probeAt(2500, '')
            probeAt(15000, ' late')
            probeAt(60000, ' settle')
          }
          log(`tp recv x=${ax.toFixed(2)} y=${ay.toFixed(3)} z=${az.toFixed(2)} flags=0x${(params.flags >>> 0).toString(16)} tid=${params.teleportId} og=${player.onGround ? 1 : 0}`)
          try { input.anchor = { x: ax, z: az } } catch {}
          try {
            pkt('play', 'teleport_confirm', { teleportId: params.teleportId })
            pkt('play', 'position_look', { x: ax, y: ay, z: az, yaw: ayaw, pitch: apitch, onGround: false })
            log(`tp echo sent tid=${params.teleportId} (claim og=0 at y=${ay.toFixed(3)})`)
          } catch {}
          if (!arena.active && !arenaTickTimer) playerStartLoop()
          return
        }
        case 'multi_block_change': {
          // the platform block in the probe section sets the landing height
          if (arena.active) {
            const recs = params.records || []
            if (!arena.mbcLogged) {
              arena.mbcLogged = true
              log(`sonar: mbc n=${recs.length} sids=${recs.slice(0, 6).join(',')}`)
            }
            if (!arena.mbcDumped) {
              arena.mbcDumped = true
              log(`sonar: mbc-raw ${params.chunkCoordinates !== undefined ? JSON.stringify(params.chunkCoordinates) : 'nocoord'} hex ${Buffer.alloc(0).toString('hex')}`)
            }
            // the records are packed (blockState << 12) | localPos; they are
            // built into the world once the teleport has told us which section
            // holds the obstacle (see applyArenaBlocks below)
            arena.mbcRecords = recs.slice()
            log(`sonar: mbc stored n=${recs.length} states=${recs.slice(0, 3).map(v => v >> 12).join(',')}`)
            if (arena.spawnY != null) {
              const placed = applyArenaBlocks(arena.spawnY)
              log(`sonar: arena obstacle built (${placed} blocks) — landing comes from collision`)
            }
          } else if ((player.mbcN = (player.mbcN || 0) + 1) <= 8) {
            const cc = params.chunkCoordinates
            log(`mbc #${player.mbcN} sec=(${cc ? `${cc.x},${cc.y},${cc.z}` : '?'}) n=${(params.records || []).length} rec=${(params.records || []).slice(0, 6).join(',')}`)
          }
          return
        }
        case 'block_change': {
          if ((player.bcN = (player.bcN || 0) + 1) <= 8) {
            const L = params.location || {}
            log(`block_change #${player.bcN} loc=(${L.x},${L.y},${L.z}) type=${params.type}`)
          }
          return
        }
        case 'animation': {
          // protocol echo #1: the server swings our arm — swing back exactly once
          if (arena.active && !arena.animReplied) {
            arena.animReplied = true
            arena.timers.push(setTimeout(() => {
              if (!arena.active) return
              try { pkt('play', 'arm_animation', { hand: 0 }) } catch {}
              log('sonar: swing echo sent')
            }, ECHO_MS))
            if (arena.slotReplied) {
              arena.stage = 'vehicle'
              log('sonar: echoes done — vehicle stage (keep-alive driven)')
            }
          }
          return
        }
        case 'held_item_slot': {
          // protocol echo #2: first held-slot packet is invalid on purpose —
          // a vanilla client only confirms a valid slot (0-8), once
          const s = params.slot
          if (arena.active && !arena.slotReplied && s >= 0 && s <= 8) {
            arena.slotReplied = true
            arena.timers.push(setTimeout(() => {
              if (!arena.active) return
              try { pkt('play', 'held_item_slot', { slotId: s }) } catch {}
              log('sonar: held-slot echo sent')
            }, ECHO_MS))
          }
          if (arena.active && arena.animReplied && arena.slotReplied && arena.stage !== 'vehicle') {
            arena.stage = 'vehicle'
            log('sonar: echoes done — vehicle stage (keep-alive driven)')
          }
          if (!arena.active && s >= 0 && s <= 8) player.heldSlot = s // vanilla applies silently
          return
        }
        case 'entity_velocity': {
          // ClientboundSetEntityMotion — only our own entity matters: a normal
          // player reacts to knockback with real horizontal physics
          if (!player.inWorld || params.entityId !== player.entityId) return
          const v = params.velocity || {}
          player.dx = (v.x || 0) / 8000
          player.dz = (v.z || 0) / 8000
          if (v.y) { player.dy = v.y / 8000; player.airborne = true }
          return
        }
        case 'tab_complete':
          // our own suggestion request came back — a real client displays it;
          // we just acknowledge (queue commands tab-complete before sending)
          log(`tab suggestions: ${(params.matches || []).length}`)
          return
        case 'open_window': {
          if (player.gui) { try { syncInvFromGui(player.gui) } catch {} }
          let title = ''
          try { title = flattenComponent(params.windowTitle) || '' } catch {}
          player.gui = { id: params.windowId, type: params.inventoryType, title, slots: [] }
          player.menuDrag = null
          log(`gui open #${params.windowId} ${menuName(params.inventoryType)} "${title}"`)
          return
        }
        case 'close_window':
          // the server (or a plugin) closed our GUI
          if (player.gui && player.gui.id === params.windowId) {
            try { syncInvFromGui(player.gui) } catch {}
            player.gui = null
            player.menuDrag = null
            if (player.win && player.win.id === params.windowId) player.win = null
            log('gui closed by server')
          }
          return
        case 'set_slot':
          if (DEBUG_SLOT) log(`<- set_slot win=${params.windowId} slot=${params.slot} state=${params.stateId} item=${params.item ? (params.item.itemId + 'x' + params.item.itemCount) : 'null'}`)
          // remember container state id so window_click answers are accepted
          if (params.windowId >= 0 && params.stateId !== undefined) player.win = { id: params.windowId, stateId: params.stateId }
          if (params.windowId === 0) {
            if (params.slot !== undefined) inv.slots[params.slot] = params.item
            if (params.stateId !== undefined) inv.stateId = params.stateId
          } else if (params.windowId > 0) {
            const g = ensureGui(params.windowId)
            if (params.slot !== undefined) g.slots[params.slot] = params.item
            // the container's own counter — window 0 packets must not clobber it, or every
            // click inside a container goes out with a stale id and gets resynced
            if (params.stateId !== undefined) g.stateId = params.stateId
          }
          if (params.windowId === -1) inv.cursor = params.item
          return
        case 'window_items':
          if (DEBUG_SLOT) log(`<- window_items win=${params.windowId} state=${params.stateId} n=${(params.items || []).length}`)
          if (params.stateId !== undefined) player.win = { id: params.windowId, stateId: params.stateId }
          if (params.windowId === 0) { inv.slots = params.items || []; inv.stateId = params.stateId || 0 }
          else if (params.windowId > 0) {
            const g = ensureGui(params.windowId)
            g.slots = params.items || []
            g.stateId = params.stateId || 0
          }
          if (params.carriedItem) inv.cursor = params.carriedItem
          return
        case 'map': {
          // the verification captcha is a picture on a map; keep the newest one so it
          // can be turned into a PNG the moment the server asks for the text
          try {
            const m = decodeMapPacket(payload)
            if (m) {
              lastMap = m; lastMapRaw = Buffer.from(payload); lastMapAt = Date.now()
              // several maps can be in flight (the player's own map, the captcha map).
              // Keep them all by id so the right one can be identified afterwards.
              mapById.set(String(m.id), { m, raw: Buffer.from(payload), at: Date.now() })
              while (mapById.size > 8) mapById.delete(mapById.keys().next().value)
            }
          } catch (e) { if (cfg.verbose) log(`map decode: ${e.message}`) }
          return
        }
        case 'map_chunk':
          // world knowledge — the client parses chunks, it does not ignore them.
          // Decoding is deferred (≤8 ms per turn, then yield): a burst of 200 chunks
          // used to block the event loop, which on a throttled host starves the
          // keep-alive replies and gets us kicked with ReadTimeout.
          player.chArr = (player.chArr || 0) + 1
          if (cfg.verbose && (player.chArr <= 12 || player.chArr % 20 === 0)) log(`chunk recv #${player.chArr} (${params.x},${params.z}) len=${(params.chunkData || []).length} gen=${sessionGen}`)
          try { enqueueChunk(params.x, params.z, params.chunkData) } catch (e) {
            if (!player.chunkDumped) {
              player.chunkDumped = true
              const cd = params.chunkData || Buffer.alloc(0)
              try { require('fs').writeFileSync('/tmp/badchunk.bin', cd) } catch {}
              log(`chunk parse: ${e.message} — len=${cd.length} hm=${JSON.stringify(params.heightmaps).slice(0, 120)} be=${(params.blockEntities || []).length} hex ${cd.subarray(0, 160).toString('hex')}`)
            } else log(`chunk parse: ${e.message}`)
          }
          // diagnostic: keep recent raw chunks + dump any chunk at/near a
          // teleport target (is the pad section on the wire at all?)
          player.rawKeep = player.rawKeep || []
          player.rawKeep.push({ x: params.x, z: params.z, data: params.chunkData })
          if (player.rawKeep.length > 14) player.rawKeep.shift()
          const tgs = player.tpTargets || []
          if (tgs.some(t => { const tcx = Math.floor(t[0]) >> 4, tcz = Math.floor(t[1]) >> 4; return Math.abs(tcx - params.x) <= 1 && Math.abs(tcz - params.z) <= 1 })) {
            player.padSaves = (player.padSaves || 0) + 1
            if (player.padSaves <= 4) {
              try {
                require('fs').writeFileSync(`/tmp/padchunk_tp_${player.padSaves}_${params.x}_${params.z}.bin`, params.chunkData || Buffer.alloc(0))
                log(`pad target chunk raw saved /tmp/padchunk_tp_${player.padSaves}_${params.x}_${params.z}.bin len=${(params.chunkData || []).length}`)
              } catch {}
            }
          }
          return
        case 'unload_chunk':
          player.chUnl = (player.chUnl || 0) + 1
          if (player.chUnl <= 12 || player.chUnl % 20 === 0) log(`chunk unload #${player.chUnl} (${params.chunkX},${params.chunkZ}) gen=${sessionGen}`)
          dropChunk(params.chunkX, params.chunkZ)
          return
        case 'spawn_entity':
          if (params.entityId === player.entityId) return // that's us
          entities.set(params.entityId, {
            x: params.x, y: params.y, z: params.z, type: params.type,
            yaw: ((params.yaw & 0xff) * 360 / 256), pitch: ((params.pitch & 0xff) * 360 / 256)
          })
          if (arena.active) log(`sonar: vehicle spawn type=${params.type} at y=${params.y}`)
          return
        case 'rel_entity_move': {
          const e = entities.get(params.entityId)
          if (e) { e.x += params.dX / 4096; e.y += params.dY / 4096; e.z += params.dZ / 4096 }
          return
        }
        case 'entity_move_look': {
          const e = entities.get(params.entityId)
          if (e) {
            e.x += params.dX / 4096; e.y += params.dY / 4096; e.z += params.dZ / 4096
            e.yaw = ((params.yaw & 0xff) * 360 / 256); e.pitch = ((params.pitch & 0xff) * 360 / 256)
          }
          return
        }
        case 'entity_look': {
          const e = entities.get(params.entityId)
          if (e) { e.yaw = ((params.yaw & 0xff) * 360 / 256); e.pitch = ((params.pitch & 0xff) * 360 / 256) }
          return
        }
        case 'entity_head_rotation': {
          const e = entities.get(params.entityId)
          if (e) e.yaw = ((params.yaw & 0xff) * 360 / 256)
          return
        }
        case 'entity_teleport': {
          const e = entities.get(params.entityId)
          if (e) { e.x = params.x; e.y = params.y; e.z = params.z; e.yaw = ((params.yaw & 0xff) * 360 / 256); e.pitch = ((params.pitch & 0xff) * 360 / 256) }
          return
        }
        case 'entity_destroy':
          if (arena.active && (params.entityIds || []).length) {
            if (arena.boatNo >= 2) ARENA_DONE_AT = Date.now()
            arenaFreeFall('boat gone')
          }
          for (const id of (params.entityIds || [])) {
            entities.delete(id)
            if (player.ridingId === id) player.ridingId = null // vehicle gone
          }
          return
        case 'animation':
          // golden s5: the real client swings its arm right when Sonar shows
          // an animation during verification
          if (arena.active && !verifyDone) queueTick(() => { try { pkt('play', 'arm_animation', { hand: 0 }) } catch {} })
          return
        case 'chunk_batch_finished':
          // vanilla replies with its comfortable chunk-loading rate so the
          // server paces further batches — a real client ALWAYS answers this
          try { pkt('play', 'chunk_batch_received', { chunksPerTick: 9 }) } catch {}
          return
        case 'start_configuration':
          // Server-initiated re-configuration — how a hub moves you to another
          // backend (e.g. /queue lifesteal). Vanilla answers the ack and then
          // walks the new configuration listener from the top: brand, client
          // settings, and only then the finish ack. Skipping the settings step
          // leaves the proxy waiting, which showed up as the 30s config stall.
          if (tickBatch && tickBatch.length) {
            const frames = tickBatch; tickBatch = null
            try { socket.write(Buffer.concat(frames)) } catch {}
            tickBatch = []
          }
          try { pkt('play', 'configuration_acknowledged', {}) } catch {}
          state = 'configuration'
          playWhileConfig = 0
          log('server requested re-configuration — acknowledged')
          reconfN = (reconfN || 0) + 1
          const reconfNudge = (why) => {
            if (state === 'play' || ended) return
            try { pkt('configuration', 'custom_payload', { channel: 'minecraft:brand', data: Buffer.concat([writeUvarint(7), Buffer.from('vanilla')]) }) } catch {}
            try { pkt('configuration', 'settings', clientInfo()) } catch {}
            log(`reconfig: ${why} — resent brand + client settings (still waiting for finish_configuration)`)
          }
          setTimeout(() => reconfNudge('start of the transfer'), 60)
          setTimeout(() => reconfNudge('10s, the transfer is slow'), 10000)
          // Progress line while the proxy swaps backends. It goes quiet for a while
          // (no keep-alives either) and then finishes — reconnecting early only
          // loses the queue position, so this waits, and says that it is waiting.
          const reconfStartedAt = Date.now()
          const reconfTick = setInterval(() => {
            if (state === 'play' || ended) { clearInterval(reconfTick); return }
            const s2 = Math.round((Date.now() - reconfStartedAt) / 1000)
            log(`reconfig: still transferring (${s2}s) — the proxy is waiting for the target server`)
          }, 15000)
          if (cfgWatch) clearTimeout(cfgWatch)
          const transferMs = (() => { const n = parseInt(ENV.TRANSFER_WAIT_MS || '', 10); return Number.isFinite(n) && n > 0 ? n : 120000 })()
          cfgWatch = setTimeout(() => {
            if (state !== 'play' && !ended) {
              const seen = [...cfgSeen.entries()].map(([k, v]) => `${k}x${v}`).join(' ') || 'nothing'
              log(`config stall — the transfer did not complete in ${Math.round(transferMs / 1000)}s (got: ${seen}), reconnecting`)
              finish('restart')
            }
          }, transferMs)
          return
        case 'set_passengers': {
          // vanilla SetPassengersPacket — the vehicle that carries US is, by
          // definition, a vehicle; while aboard a real client stops sending its
          // own position and moves the vehicle instead (ServerboundMoveVehicle)
          const list = params.passengers || []
          // the decoded field is entityId (the vehicle), not vehicleId
          const vehId = params.entityId !== undefined ? params.entityId : params.vehicleId
          if (arena.active) log(`sonar: set_passengers vehicle=${vehId} list=[${list}] us=${player.entityId} riding=${player.ridingId}`)
          if (list.includes(player.entityId)) {
            if (player.ridingId !== vehId) {
              player.ridingId = vehId
              player.lastVeh = null
              if (arena.active) {
                ARENA_DONE_AT = Date.now()
                arena.stage = 'vehicle'
                arena.boatDone = false
                const veh = entities.get(vehId)
                if (veh) { player.x = veh.x; player.y = veh.y; player.z = veh.z }
                log(`sonar: mounted vehicle at y=${veh ? veh.y.toFixed(2) : 'unknown'}`)
                arena.boatNo = (arena.boatNo || 0) + 1
                arena.boatDone = true
                arenaBoatRound(arena.boatNo === 1 ? 'boat' : `boat #${arena.boatNo}`)
              } else if (verifyDone) log(`riding entity #${vehId}`)
            }
          } else if (player.ridingId !== null && player.ridingId !== undefined && vehId === player.ridingId) {
            player.ridingId = null
            // vanilla resyncs its position right after dismount
            try { pkt('play', 'position', { x: player.x, y: player.y, z: player.z, onGround: true }) } catch {}
          }
          return
        }
        case 'system_chat':
          onText(flattenComponent(params.content), null, legacyOf(params.content))
          return
        case 'action_bar':
          chatLog(`actionbar: ${flattenComponent(params.text)}`)
          return
        case 'set_title_text':
          chatLog(`title: ${flattenComponent(params.text)}`)
          return
        case 'set_title_subtitle':
          chatLog(`subtitle: ${flattenComponent(params.text)}`)
          return
        case 'player_chat': {
          const who = flattenComponent(params.networkName)
          onText(params.plainMessage, who || null, params.networkName ? legacyOf(params.networkName) : null)
          return
        }
        case 'profileless_chat': {
          const who = flattenComponent(params.name)
          onText(flattenComponent(params.message), who || null, legacyOf(params.message))
          return
        }
        case 'kick_disconnect': {
          const reason = flattenComponent(params.reason)
          chatLog(`kicked: ${reason}`)
          if (debugSeen.size) log(`play packets seen: ${[...debugSeen.entries()].map(([n, c]) => `${n}x${c}`).join(' ')}`)
          const ban = banInfo(reason, cfg.playerName)
          if (ban) {
            log(`blacklisted by the server — waiting ${Math.round(ban.ms / 60000)} min before trying again (${ban.text})`)
            if (cfg.auth) log(`auth: not retrying until then — a wrong PASSWORD is the usual cause`)
            banUntil = Date.now() + ban.ms
            finish('banned')
            return
          }
          if (/verified successfully/i.test(reason)) finish('rejoin')
          else if (banInfo(reason, cfg.playerName)) { banUntil = Date.now() + banInfo(reason, cfg.playerName).ms; log(`blacklisted — waiting ${Math.round(banInfo(reason, cfg.playerName).ms / 60000)} min (${banInfo(reason, cfg.playerName).text})`); finish('banned') }
          else if (/blocked from entering|wait a few minutes/i.test(reason)) finish('blocked-cooldown')
          else if (/verif/i.test(reason)) {
            log('sonar: verification proof failed or timed out — the server will allow a retry after its cooldown')
            finish('verify-cooldown')
          }
          else finish('restart')
          return
        }
        case 'custom_payload':
          log(`plugin message from server: ${params.channel} (${(params.data || Buffer.alloc(0)).length}b)`)
          return
        default:
          return // everything else (chunks, entities, ...) skipped by design
      }
    }
    const debugSeen = new Map()

    /* vanilla-like network tick: play-phase replies go out on the next
       ~50ms tick (40-75ms with jitter) instead of instantly — a real game
       client never answers in <1ms, and the server's bot filter watches. */
    let tickQueue = []
    let tickTimer = null
    function queueTick (fn) {
      tickQueue.push(fn)
      if (!tickTimer) {
        tickTimer = setTimeout(() => {
          tickTimer = null
          const q = tickQueue
          tickQueue = []
          for (const f of q) { try { f() } catch {} }
        }, 40 + Math.floor(Math.random() * 35))
      }
    }

    // Section 2 (self-declaration): brand + client_information above/below are
    // everything a vanilla OFFLINE player sends — chat_session_update is
    // deliberately absent: it requires a Mojang profile key the cracked client
    // never has (captured real client on this server sent none either).
    const clientInfo = () => ({
      locale: 'en_us',
      viewDistance: 12,
      chatFlags: 0,
      chatColors: true,
      skinParts: 0x7f,
      mainHand: 1,
      enableTextFiltering: false,
      enableServerListing: true
    })

    /* sections 3-5: every action a normal player can take, vanilla encodings */
    const seqNext = () => ++player.seq
    SESSION_ACTIONS = {
      afkStand: () => { player.afkStand = true; log('afk stand mode — look only, no walking on the pad') },
      // --- section 3: state transitions (entity_action family) ---
      entityAction: (actionId, jumpBoost = 0) => pkt('play', 'entity_action', { entityId: player.entityId, actionId, jumpBoost: jumpBoost || 0 }),
      sneak (on = !player.sneaking) { player.sneaking = on; pkt('play', 'entity_action', { entityId: player.entityId, actionId: on ? 'start_sneaking' : 'stop_sneaking', jumpBoost: 0 }) },
      sprint (on = !player.sprinting) { player.sprinting = on; pkt('play', 'entity_action', { entityId: player.entityId, actionId: on ? 'start_sprinting' : 'stop_sprinting', jumpBoost: 0 }) },
      openInventory: () => pkt('play', 'entity_action', { entityId: player.entityId, actionId: 'open_inventory', jumpBoost: 0 }),
      respawn: () => pkt('play', 'client_command', { actionId: 'perform_respawn' }),
      abilities: (flags) => pkt('play', 'abilities', { flags }),
      steer: (sideways = 0, forward = 0, jump = 0) => pkt('play', 'steer_vehicle', { sideways, forward, jump }),
      // --- section 4: interactions with geometry ---
      swing: (hand = 0) => pkt('play', 'arm_animation', { hand }),
      dig: (status, x, y, z, face = 1) => pkt('play', 'block_dig', { status, location: { x, y, z }, face, sequence: seqNext() }),
      place: (x, y, z, direction = 1, cursor = null, hand = 0) => pkt('play', 'block_place', {
        hand, location: { x, y, z }, direction,
        cursorX: cursor ? cursor.x : 0.5, cursorY: cursor ? cursor.y : 0.5, cursorZ: cursor ? cursor.z : 0.5,
        insideBlock: false, sequence: seqNext()
      }),
      useItem: (hand = 0) => pkt('play', 'use_item', { hand, sequence: seqNext() }),
      attack: (targetId) => pkt('play', 'use_entity', { target: targetId, mouse: 1, sneaking: player.sneaking }),
      interact: (targetId, hand = 0) => pkt('play', 'use_entity', { target: targetId, mouse: 0, hand, sneaking: player.sneaking }),
      interactAt: (targetId, hit, hand = 0) => pkt('play', 'use_entity', { target: targetId, mouse: 2, x: hit.x, y: hit.y, z: hit.z, hand, sneaking: player.sneaking }),
      // --- section 4: inventory / containers ---
      setHeld: (slot) => { player.heldSlot = slot; pkt('play', 'held_item_slot', { slotId: slot }) },
      pick: (slot) => pkt('play', 'pick_item', { slot }),
      click: (o) => {
        // predict ANY click type exactly like the vanilla client (engine above)
        const mode = o.mode !== undefined ? o.mode : 0
        const mouse = o.mouseButton !== undefined ? o.mouseButton : 0
        const wid = o.windowId !== undefined ? o.windowId : (player.win ? player.win.id : 0)
        const gui = (wid > 0 && player.gui && player.gui.id === wid) ? player.gui : null
        if (wid > 0 && !gui) throw new Error('stale window')
        const slots = gui ? gui.slots : inv.slots
        if (o.slot !== -999 && (o.slot < 0 || o.slot >= slots.length)) throw new Error('bad slot')
        const { changed, cursor } = predictClick({ inv, player }, gui, o.slot, mouse, mode)
        return pkt('play', 'window_click', {
          windowId: wid,
          stateId: o.stateId !== undefined ? o.stateId : (player.win && player.win.id === wid ? player.win.stateId : 0),
          slot: o.slot, mouseButton: mouse, mode,
          changedSlots: changed, cursorItem: cursor
        })
      },
      closeWindow: (windowId = 0) => pkt('play', 'close_window', { windowId }),
      creativeSlot: (slot, item) => pkt('play', 'set_creative_slot', { slot, item }),
      // --- section 5: typed content ---
      tabComplete: (text) => { pkt('play', 'tab_complete', { transactionId: player.tabTx >>> 0, text: String(text) }); player.tabTx++ },
      rename: (name) => pkt('play', 'name_item', { name: String(name).slice(0, 50) }), // anvil/loom typed text
      sign: (x, y, z, lines, front = true) => {
        const J = (t) => { t = String(t === undefined || t === null ? '' : t); return (/^[[{"]/.test(t) || t === '') ? t : JSON.stringify({ text: t }) }
        pkt('play', 'update_sign', { location: { x, y, z }, isFrontText: front, text1: J(lines[0]), text2: J(lines[1]), text3: J(lines[2]), text4: J(lines[3]) })
      },
      book: (hand, pages, title = null) => pkt('play', 'edit_book', { hand, pages: Array.isArray(pages) ? pages.map(String) : [String(pages)], title: title === null ? null : String(title) })
    }

    /* web console bindings — inventory & open GUI (module-level fns set these) */
    WEB_STATE = () => ({
      connected: !!(player.inWorld && socket && !socket.destroyed),
      name: cfg.playerName, server: `${cfg.serverIp}:${cfg.serverPort}`, chatLast: CHAT_SEQ,
      player: {
        x: Math.round(player.x * 100) / 100, y: Math.round(player.y * 100) / 100, z: Math.round(player.z * 100) / 100,
        gameMode: player.gameMode | 0, held: player.heldSlot | 0, sneak: !!player.sneaking
      },
      antiAfk: cfg.antiAfk, stand: !!player.afkStand,
      stateId: inv.stateId | 0, // window 0 state counter (echoed back in every click)
      cursor: itemBrief(inv.cursor),
      cursorRaw: { count: (inv.cursor && inv.cursor.present) ? (inv.cursor.itemCount | 0) : 0, id: (inv.cursor && inv.cursor.present) ? (inv.cursor.itemId | 0) : 0 },
      inv: (inv.slots || []).map(itemBrief),
      lay: menuLayout(null), // window 0 slot map (vanilla rows)
      gui: player.gui ? {
        id: player.gui.id, type: player.gui.type, menu: menuName(player.gui.type), title: player.gui.title || '',
        size: (player.gui.slots || []).length,
        stateId: (player.win && player.win.id === player.gui.id) ? (player.win.stateId | 0) : 0,
        lay: menuLayout(player.gui),
        slots: (player.gui.slots || []).map(itemBrief)
      } : null
    })
    WEB_CLICK = (o) => {
      if (!player.inWorld || !socket || socket.destroyed) throw new Error('bot not connected')
      if (!o || !Number.isFinite(o.slot)) throw new Error('bad slot')
      const slot = o.slot | 0
      const mode = Number.isFinite(o.mode) ? (o.mode | 0) : 0
      if (mode < 0 || mode > 6 || mode === 3) throw new Error('bad mode')
      if (slot !== -999 && (slot < 0 || slot > 512)) throw new Error('bad slot')
      const wid = player.gui ? player.gui.id : 0
      if (o.windowId !== undefined && o.windowId !== null && o.windowId !== wid) throw new Error('stale window id')
      const slots = player.gui ? player.gui.slots : inv.slots
      if (slot !== -999 && slot >= slots.length) throw new Error('bad slot')
      const button = Number.isFinite(o.button) ? (o.button | 0) : 0
      // per-mode button domains, straight from the client's doClick
      const okButton = mode === 2 ? ((button >= 0 && button <= 8) || button === 40) // hotbar 1-9 or offhand
        : mode === 5 ? (button >= 0 && button <= 10)                                  // stage | type<<2
          : (button === 0 || button === 1)
      if (!okButton) throw new Error('bad button')
      const stateId = wid === 0 ? (inv.stateId | 0) : ((player.gui && player.gui.id === wid) ? (player.gui.stateId | 0) : 0)
      SESSION_ACTIONS.click({ slot, mouseButton: button, mode, windowId: wid, stateId })
      log(`web: click win=${wid} slot=${slot} btn=${button} mode=${mode} state=${stateId}`)
      return { ok: true }
    }
    // use an item on a block — how you open a chest/furnace/crafting table yourself
    WEB_USE_BLOCK = (o) => {
      if (!player.inWorld || !socket || socket.destroyed) throw new Error('bot not connected')
      if (!o || ![o.x, o.y, o.z].every(Number.isFinite)) throw new Error('bad position')
      if (player.gui) throw new Error('container already open')
      const face = Number.isFinite(o.face) ? (o.face | 0) : 1
      const hand = o.hand === 1 ? 1 : 0
      SESSION_ACTIONS.swing(hand)
      SESSION_ACTIONS.place(o.x | 0, o.y | 0, o.z | 0, face, null, hand)
      log(`web: use block ${o.x | 0} ${o.y | 0} ${o.z | 0} face=${face}`)
      return { ok: true }
    }
    // use the held item in the air, exactly like a right click in the game
    WEB_USE = (o) => {
      if (!player.inWorld || !socket || socket.destroyed) throw new Error('bot not connected')
      if (player.gui) throw new Error('container already open')
      const hand = (o && o.hand === 1) ? 1 : 0
      SESSION_ACTIONS.useItem(hand)
      log(`web: use item (hand ${hand})`)
      return { ok: true }
    }
    // hotbar selection (vanilla Held Item Change)
    WEB_HELD = (o) => {
      if (!player.inWorld || !socket || socket.destroyed) throw new Error('bot not connected')
      const slot = o && Number.isFinite(o.slot) ? (o.slot | 0) : -1
      if (slot < 0 || slot > 8) throw new Error('bad slot')
      SESSION_ACTIONS.setHeld(slot)
      return { ok: true }
    }
    // creative inventory: place an item straight into a slot (vanilla Set Creative Mode Slot)
    WEB_CREATIVE = (o) => {
      if (!player.inWorld || !socket || socket.destroyed) throw new Error('bot not connected')
      const gm = player.gameMode | 0
      if (gm !== 1 && gm !== 2) throw new Error('not in creative')
      if (!o || !Number.isFinite(o.slot)) throw new Error('bad slot')
      const slot = o.slot | 0
      if (slot < 0 || slot >= 46) throw new Error('bad slot')
      const count = Number.isFinite(o.count) ? (o.count | 0) : 1
      const itemId = Number.isFinite(o.itemId) ? (o.itemId | 0) : 0
      if (count < 0 || count > 64) throw new Error('bad count')
      const item = count > 0 ? { present: true, itemId, itemCount: count, nbtData: null } : { present: false }
      SESSION_ACTIONS.creativeSlot(slot, item)
      inv.slots[slot] = item
      log(`web: creative slot=${slot} id=${itemId} x${count}`)
      return { ok: true }
    }
    // vanilla sends drags as START / per-slot / END inside one tick, all sharing the
    // stateId read before the batch — so apply them as one ordered unit.
    WEB_CLICK_BATCH = (o) => {
      const clicks = (o && Array.isArray(o.clicks)) ? o.clicks : []
      if (!clicks.length) throw new Error('empty batch')
      if (clicks.length > 128) throw new Error('batch too large')
      for (const c of clicks) WEB_CLICK({ ...c, windowId: o.windowId })
      return { ok: true, sent: clicks.length }
    }
    WEB_CLOSE = () => {
      if (!player.inWorld || !socket || socket.destroyed) throw new Error('bot not connected')
      if (!player.gui) return { ok: true, nothing: true }
      const id = player.gui.id
      try { syncInvFromGui(player.gui) } catch {}
      SESSION_ACTIONS.closeWindow(id)
      player.gui = null
      if (player.win && player.win.id === id) player.win = null
      log(`web: closed gui #${id}`)
      return { ok: true }
    }

    /* outbound API used by the queue */
    SESSION_VERIFY = (spec, since) => new Promise(resolve => {
      const deadline = Date.now() + spec.timeout
      const tick = () => {
        if (ended) return resolve(false)
        const hitChat = spec.chat ? chatSeen.some(t => spec.chat.test(t)) : false
        const hitJoin = spec.mode !== undefined && joinEvents.some(j => j.mode === spec.mode && j.at >= since)
        const hereNow = spec.mode === 0 && curMode === 0 // already on the lifesteal server
        if (hitChat || hitJoin || hereNow) return resolve(true)
        if (Date.now() >= deadline) return resolve(false)
        setTimeout(tick, 300)
      }
      tick()
    })
    WEB_CHAT = text => {
      if (SESSION_SEND(text) === false) throw new Error('not in play right now (re-connecting)')
      if (captchaPendingUntil > Date.now()) pendingCaptcha = { text: String(text).trim(), bin: null, at: Date.now(), by: 'human' }
    }
    SESSION_WAIT_PLAY = (timeout) => new Promise(resolve => {
      if (state === 'play') return resolve('ok')
      const t0 = Date.now()
      const tick = () => {
        if (ended) return resolve('ended')
        if (state === 'play') return resolve('ok')
        if (Date.now() - t0 >= timeout) return resolve('timeout')
        setTimeout(tick, 250)
      }
      tick()
    })
    SESSION_SEND = text => {
      const t = String(text)
      // a session can end between two awaits (socket reset, re-configuration,
      // server transfer) — that is not an error worth crashing over
      if (state !== 'play') { sendBlocked = (sendBlocked || 0) + 1; return false }
      if (t.startsWith('/')) {
        // section 5: real players TAB the command before pressing Enter —
        // captured client sent tab_complete(full text) right before /login
        pkt('play', 'tab_complete', { transactionId: player.tabTx >>> 0, text: t })
        player.tabTx++
        pkt('play', 'chat_command', {
          command: t.slice(1),
          timestamp: BigInt(Date.now()),
          salt: 0n,
          argumentSignatures: [],
          messageCount: 0,
          acknowledged: Buffer.alloc(3)
        })
      } else {
        pkt('play', 'chat_message', {
          message: t,
          timestamp: BigInt(Date.now()),
          salt: 0n,
          signature: null,
          offset: 0,
          acknowledged: Buffer.alloc(3)
        })
      }
      return true
    }

    socket.on('data', feed)

    /* ---- liveness: prove whether it is us or the host ---- */
    // 1. event-loop lag. A big number here means the host throttled our CPU.
    let lagWorst = 0, lagLoggedAt = 0, lastTick = Date.now()
    const lagTimer = setInterval(() => {
      const now = Date.now()
      const lag = Math.max(0, now - lastTick - 500)
      lastTick = now
      if (lag > lagWorst) lagWorst = lag
      if (lag > 3000 && now - lagLoggedAt > 30000) {
        lagLoggedAt = now
        log(`stall: the event loop was blocked ${(lag / 1000).toFixed(1)}s — the host is throttling CPU (VERBOSE=off and fewer chunks help)`)
      }
    }, 500)
    // 2. traffic watchdog: nothing inbound for 90s means the socket is dead
    const rxTimer = setInterval(() => {
      if (!ended && Date.now() - lastRx > 90000) {
        log(`no packet for ${Math.round((Date.now() - lastRx) / 1000)}s — the connection looks dead, reconnecting`)
        finish('restart')
      }
    }, 5000)
    // 3. a heartbeat line people can actually see in a host's log
    const aliveTimer = setInterval(() => {
      if (ended) return
      log(`alive — up ${Math.round((Date.now() - startedAt) / 60000)}m, rx ${rxN}, tx ${txN}, lag ${(lagWorst / 1000).toFixed(1)}s max`)
      lagWorst = 0
    }, 60000)
    const clearLiveness = () => { clearInterval(lagTimer); clearInterval(rxTimer); clearInterval(aliveTimer) }
    // A reset that lands within seconds of the final ride is the gate hanging up
    // after (or instead of) its verdict — rejoining in 10s just walks back into
    // AntiBot. Treat it as its own case with a longer, jittered back-off.
    const arenaJustFinished = () => ARENA_DONE_AT && (Date.now() - ARENA_DONE_AT) < 12000
    socket.on('error', e => {
      log(`socket: ${e.message}${arenaJustFinished() ? ' (right after the arena — the gate hung up)' : ''}`)
      finish(arenaJustFinished() ? 'arena-reset' : 'restart')
    })
    socket.on('close', () => { if (!ended) finish(arenaJustFinished() ? 'arena-reset' : 'restart') })

    socket.connect(cfg.serverPort, cfg.serverIp, () => {
      log(`connected to ${cfg.serverIp}:${cfg.serverPort} (protocol ${PROTOCOL_VERSION})`)
      // handshake -> login
      pkt('handshaking', 'set_protocol', {
        protocolVersion: PROTOCOL_VERSION,
        serverHost: cfg.serverIp,
        serverPort: cfg.serverPort,
        nextState: 2
      })
      state = 'login'
      pkt('login', 'login_start', {
        username: cfg.playerName,
        playerUUID: offlineUuid(cfg.playerName)
      })
    })

    /* session must reach play within 4 min (verify gate may force one rejoin) */
    const guard = setTimeout(() => {
      if (!ready) { log('session timed out before login'); finish('timeout') }
    }, 240000)
    socket.on('close', () => clearTimeout(guard))
  })
}

/* ---------------- main loop ---------------- */
/* ---------------- vanilla menu engine ----------------
   Ported from the 1.20.4 client's AbstractContainerMenu.doClick / quickMoveStack
   (decompiled via CFR + Mojang mappings) so every click predicts exactly what
   the vanilla client would put in changed_slots — the server compares those
   predictions and corrects any mismatch with set_slot packets. */
const ITEM_STACK_MAX = {380:1,521:1,522:1,523:1,524:1,525:1,526:1,527:1,528:1,529:1,530:1,531:1,532:1,533:1,534:1,535:1,536:1,537:1,764:1,765:1,766:1,767:1,768:1,769:1,770:1,771:1,772:1,773:1,774:1,775:1,776:1,777:1,778:1,779:1,780:1,781:1,782:1,783:1,784:1,785:1,786:1,787:1,788:1,789:1,790:1,793:1,795:1,797:1,814:1,815:1,816:1,817:1,818:1,819:1,820:1,821:1,822:1,823:1,824:1,825:1,826:1,827:1,828:1,829:1,830:1,831:1,832:1,833:1,834:1,835:1,836:1,837:1,838:1,839:1,840:1,841:1,842:1,843:1,846:1,853:1,854:1,855:1,856:1,857:1,858:1,859:1,860:1,861:1,862:1,863:1,864:1,865:1,866:1,867:1,868:1,869:1,870:1,871:1,872:1,873:1,874:1,875:1,876:1,883:16,884:16,885:16,886:16,887:16,888:16,889:16,890:16,891:16,892:16,893:16,894:16,895:16,896:16,897:16,898:16,899:16,900:16,901:16,902:16,903:16,904:16,905:16,906:1,907:1,908:1,909:16,911:1,912:1,913:1,914:1,915:1,916:1,917:1,924:16,927:1,928:1,930:1,960:1,961:1,962:1,963:1,964:1,965:1,966:1,967:1,968:1,969:1,970:1,971:1,972:1,973:1,974:1,975:1,976:1,980:1,990:16,995:1,1085:1,1086:16,1107:1,1113:1,1116:16,1117:1,1118:1,1119:1,1120:1,1123:1,1126:16,1127:16,1128:16,1129:16,1130:16,1131:16,1132:16,1133:16,1134:16,1135:16,1136:16,1137:16,1138:16,1139:16,1140:16,1141:16,1149:1,1151:1,1154:1,1155:1,1156:1,1159:1,1160:1,1161:1,1162:1,1163:1,1164:1,1165:1,1166:1,1167:1,1168:1,1169:1,1170:1,1171:1,1172:1,1173:1,1174:1,1175:1,1176:1,1178:1,1182:1,1183:1,1185:1,1186:1,1187:1,1188:1,1189:1,1190:1,1191:1,1212:16,1256:1}
function maxStackOf (id) { return ITEM_STACK_MAX[String(id | 0)] || 64 }
function stEmpty (s) { return !s || !s.present || !(s.itemCount > 0) }
function stClone (s) { return stEmpty(s) ? { present: false } : { present: true, itemId: s.itemId, itemCount: s.itemCount, nbtData: s.nbtData || null } }
function stEq (a, b) {
  if (stEmpty(a) && stEmpty(b)) return true
  if (stEmpty(a) || stEmpty(b)) return false
  return a.itemId === b.itemId && a.itemCount === a.itemCount && nbtEq(a.nbtData, b.nbtData)
}
function nbtEq (a, b) {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return JSON.stringify(a, (k, v) => typeof v === 'bigint' ? { $l: String(v) } : v) ===
    JSON.stringify(b, (k, v) => typeof v === 'bigint' ? { $l: String(v) } : v)
}
function sameItem (a, b) {
  if (stEmpty(a) || stEmpty(b)) return false
  return a.itemId === b.itemId && nbtEq(a.nbtData, b.nbtData)
}
function stackAt (arr, i) { const v = arr[i]; return stEmpty(v) ? { present: false } : v }
function menuLayout (gui) {
  if (!gui) {
    // default inventory window (wiki): 0 result, 1-4 craft, 5-8 armor,
    // 9-35 main, 36-44 hotbar, 45 offhand
    return { key: 'inventory', size: 46, container: 0, hotbar: 36, invStart: 9, invEnd: 46, offhand: 45, result: 0, qm: 'inventory' }
  }
  const n = (gui.slots || []).length
  const t = gui.type
  const T = {
    0: { c: 9, qm: 'chest' }, 1: { c: 18, qm: 'chest' }, 2: { c: 27, qm: 'chest' }, 3: { c: 36, qm: 'chest' },
    4: { c: 45, qm: 'chest' }, 5: { c: 54, qm: 'chest' }, 6: { c: 9, qm: 'chest' }, 7: { c: 9, qm: 'chest' },
    8: { c: 3, qm: 'generic', result: 2 }, 9: { c: 1, qm: 'generic' },
    10: { c: 3, qm: 'furnace', result: 2 }, 14: { c: 3, qm: 'furnace', result: 2 }, 22: { c: 3, qm: 'furnace', result: 2 },
    11: { c: 5, qm: 'generic' }, 12: { c: 10, qm: 'crafting', result: 0 }, 13: { c: 2, qm: 'generic' },
    15: { c: 3, qm: 'generic', result: 2 }, 16: { c: 5, qm: 'hopper' }, 17: { c: 1, qm: 'generic' },
    18: { c: 4, qm: 'generic', result: 3 }, 19: { c: 3, qm: 'generic', result: 0 }, 20: { c: 27, qm: 'chest' },
    21: { c: 3, qm: 'generic', result: 2 }, 23: { c: 3, qm: 'generic' }, 24: { c: 2, qm: 'generic', result: 1 }
  }
  const d = (t != null && T[t]) ? T[t] : { c: (n % 9 === 0 && n > 36) ? n - 36 : Math.max(0, n - 36), qm: 'generic' }
  const container = Math.min(d.c, Math.max(0, n))
  const hotbar = n >= container + 36 ? container + 27 : Math.max(container, n - 9)
  return {
    key: String(t), size: n, container, hotbar,
    invStart: container, invEnd: Math.min(n, container + 36),
    offhand: (n === 46 && t === 12) ? 45 : -1,
    result: d.result !== undefined ? d.result : -1,
    qm: d.qm
  }
}
/* moveItemStackTo: merge into matching stacks first, then the first empty slot */
function qmMove (L, stack, start, end, reverse) {
  if (stEmpty(stack)) return false
  let changed = false
  let i = reverse ? end - 1 : start
  while (!stEmpty(stack) && (reverse ? i >= start : i < end)) {
    const sl = stackAt(L.slots, i)
    if (!stEmpty(sl) && sameItem(stack, sl)) {
      const max = maxStackOf(stack.itemId)
      const total = sl.itemCount + stack.itemCount
      if (total <= max) { sl.itemCount = total; stack.itemCount = 0; changed = true }
      else if (sl.itemCount < max) { stack.itemCount -= (max - sl.itemCount); sl.itemCount = max; changed = true }
    }
    i += reverse ? -1 : 1
  }
  if (!stEmpty(stack)) {
    i = reverse ? end - 1 : start
    while (reverse ? i >= start : i < end) {
      const sl = stackAt(L.slots, i)
      if (stEmpty(sl)) {
        const max = maxStackOf(stack.itemId)
        const put = Math.min(stack.itemCount, max)
        L.slots[i] = { present: true, itemId: stack.itemId, itemCount: put, nbtData: stack.nbtData || null }
        stack.itemCount -= put
        changed = true
        break
      }
      i += reverse ? -1 : 1
    }
  }
  return changed
}
/* quickMoveStack per menu family (vanilla orders, decompiled) */
function quickMoveOnce (L, slotIdx) {
  const lay = L.layout
  const s0 = stackAt(L.slots, slotIdx)
  if (stEmpty(s0)) return { present: false }
  const stack = stClone(s0)
  let moved = false
  if (lay.qm === 'inventory') {
    if (slotIdx === 0) moved = qmMove(L, stack, 9, 45, true)
    else if (slotIdx >= 1 && slotIdx < 9) moved = qmMove(L, stack, 9, 45, false)
    else if (slotIdx >= 9 && slotIdx < 36) moved = qmMove(L, stack, 36, 45, false)
    else if (slotIdx >= 36 && slotIdx < 45) moved = qmMove(L, stack, 9, 36, false)
    else moved = qmMove(L, stack, 9, 45, false)
  } else if (lay.qm === 'chest') {
    if (slotIdx < lay.container) moved = qmMove(L, stack, lay.container, lay.size, true)
    else moved = qmMove(L, stack, 0, lay.container, false)
  } else if (lay.qm === 'crafting') {
    if (slotIdx === 0) moved = qmMove(L, stack, 10, 46, true)
    else if (slotIdx >= 10 && slotIdx < 46) {
      moved = qmMove(L, stack, 1, 10, false)
      if (!stEmpty(stack)) moved = (slotIdx < 37 ? qmMove(L, stack, 37, 46, false) : qmMove(L, stack, 10, 37, false)) || moved
    } else moved = qmMove(L, stack, 10, 46, false)
  } else if (lay.qm === 'furnace') {
    if (slotIdx === 2) moved = qmMove(L, stack, 3, 39, true)
    else if (slotIdx === 0 || slotIdx === 1) moved = qmMove(L, stack, 3, 39, false)
    else {
      // recipe knowledge lives server-side; nearest vanilla shape is container-first
      moved = qmMove(L, stack, 0, 3, false)
      if (!stEmpty(stack)) moved = (slotIdx >= 3 && slotIdx < 30 ? qmMove(L, stack, 30, 39, false) : qmMove(L, stack, 3, 30, false)) || moved
    }
  } else if (lay.qm === 'hopper') {
    if (slotIdx < 5) moved = qmMove(L, stack, 5, lay.size, true)
    else moved = qmMove(L, stack, 0, 5, false)
  } else {
    if (slotIdx < lay.container) moved = qmMove(L, stack, lay.container, lay.size, true)
    else moved = qmMove(L, stack, 0, lay.container, false)
  }
  L.slots[slotIdx] = stEmpty(stack) ? { present: false } : stack
  if (!moved || stEmpty(stack)) {
    if (!moved) return { present: false } // vanilla: failed move returns empty and stops the loop
  }
  return stClone(stack) // remainder (matches vanilla's returned copy semantics)
}
/* AbstractContainerMenu.doClick — all seven click types */
function doClickSim (L, slotIdx, button, mode) {
  const lay = L.layout
  if (mode === 0) { // PICKUP
    if (slotIdx === -999) {
      if (stEmpty(L.cursor)) return
      if (button === 0) L.cursor = { present: false }
      else { L.cursor = { ...L.cursor, itemCount: L.cursor.itemCount - 1 }; if (L.cursor.itemCount <= 0) L.cursor = { present: false } }
      return
    }
    if (slotIdx < 0 || slotIdx >= L.slots.length) return
    const s = stackAt(L.slots, slotIdx)
    if (button === 0) {
      if (stEmpty(L.cursor) && stEmpty(s)) return
      if (!stEmpty(L.cursor) && !stEmpty(s)) {
        if (sameItem(s, L.cursor)) {
          const cap = maxStackOf(s.itemId)
          const total = s.itemCount + L.cursor.itemCount
          if (total <= cap) { L.slots[slotIdx] = { ...s, itemCount: total }; L.cursor = { present: false } }
          else { const space = cap - s.itemCount; L.slots[slotIdx] = { ...s, itemCount: cap }; L.cursor = { ...L.cursor, itemCount: L.cursor.itemCount - space } }
        } else { L.slots[slotIdx] = L.cursor; L.cursor = s }
      } else if (!stEmpty(L.cursor)) {
        // vanilla: place min(cursor count, slot max); the remainder stays
        const put = Math.min(L.cursor.itemCount, maxStackOf(L.cursor.itemId))
        L.slots[slotIdx] = { present: true, itemId: L.cursor.itemId, itemCount: put, nbtData: L.cursor.nbtData || null }
        const restN = L.cursor.itemCount - put
        L.cursor = restN > 0 ? { ...L.cursor, itemCount: restN } : { present: false }
      }
      else { L.cursor = s; L.slots[slotIdx] = { present: false } }
    } else {
      if (stEmpty(L.cursor)) {
        if (stEmpty(s)) return
        const take = Math.ceil(s.itemCount / 2)
        L.cursor = { present: true, itemId: s.itemId, itemCount: take, nbtData: s.nbtData || null }
        const rest = { ...s, itemCount: s.itemCount - take }
        L.slots[slotIdx] = rest.itemCount > 0 ? rest : { present: false }
      } else if (stEmpty(s)) {
        L.slots[slotIdx] = { present: true, itemId: L.cursor.itemId, itemCount: 1, nbtData: L.cursor.nbtData || null }
        L.cursor = { ...L.cursor, itemCount: L.cursor.itemCount - 1 }
        if (L.cursor.itemCount <= 0) L.cursor = { present: false }
      } else if (sameItem(s, L.cursor)) {
        if (s.itemCount < maxStackOf(s.itemId)) {
          L.slots[slotIdx] = { ...s, itemCount: s.itemCount + 1 }
          L.cursor = { ...L.cursor, itemCount: L.cursor.itemCount - 1 }
          if (L.cursor.itemCount <= 0) L.cursor = { present: false }
        }
      } else { L.slots[slotIdx] = L.cursor; L.cursor = s }
    }
    return
  }
  if (mode === 1) { // QUICK_MOVE — vanilla loops while the remainder still matches
    if (slotIdx < 0 || slotIdx >= L.slots.length) return
    if (stEmpty(stackAt(L.slots, slotIdx))) return
    for (let guard = 0; guard < 64; guard++) {
      const r = quickMoveOnce(L, slotIdx)
      if (stEmpty(r)) break
      if (!sameItem(stackAt(L.slots, slotIdx), r)) break
    }
    return
  }
  if (mode === 2) { // SWAP (number key / offhand)
    if (slotIdx < 0 || slotIdx >= L.slots.length) return
    if (!((button >= 0 && button < 9) || button === 40)) return
    const s = stackAt(L.slots, slotIdx)
    let hotWin = -1
    if (button < 9) hotWin = lay.hotbar + button
    else if (button === 40) hotWin = lay.offhand
    const readInv = () => {
      if (hotWin >= 0 && hotWin < L.slots.length) return stackAt(L.slots, hotWin)
      if (button === 40 && L.inv) return stackAt(L.inv.slots, 45)
      return null
    }
    const writeInv = (v) => {
      if (hotWin >= 0 && hotWin < L.slots.length) L.slots[hotWin] = v
      else if (button === 40 && L.inv) L.inv.slots[45] = v
    }
    const hot = readInv()
    if (hot == null) return
    if (stEmpty(hot) && stEmpty(s)) return
    if (stEmpty(hot)) {
      writeInv(s); L.slots[slotIdx] = { present: false }
    } else if (stEmpty(s)) {
      const max = maxStackOf(hot.itemId)
      if (hot.itemCount > max) { L.slots[slotIdx] = { ...hot, itemCount: max }; writeInv({ ...hot, itemCount: hot.itemCount - max }) }
      else { L.slots[slotIdx] = hot; writeInv({ present: false }) }
    } else {
      const max = maxStackOf(hot.itemId)
      if (hot.itemCount <= max) { writeInv(s); L.slots[slotIdx] = hot }
      else { L.slots[slotIdx] = { ...hot, itemCount: max }; writeInv({ ...hot, itemCount: hot.itemCount - max }) }
    }
    return
  }
  if (mode === 3) return // CLONE: creative only
  if (mode === 4) { // THROW (Q) — vanilla requires an empty cursor
    if (!stEmpty(L.cursor)) return
    if (slotIdx < 0 || slotIdx >= L.slots.length) return
    const s = stackAt(L.slots, slotIdx)
    if (stEmpty(s)) return
    const drop = button === 0 ? 1 : s.itemCount
    const rest = { ...s, itemCount: s.itemCount - drop }
    L.slots[slotIdx] = rest.itemCount > 0 ? rest : { present: false }
    return
  }
  if (mode === 5) { // QUICK_CRAFT — three-stage drag (button = stage | type<<2)
    const stage = button & 3
    const type = (button >> 2) & 3
    if (stEmpty(L.cursor)) { L.drag = null; return }
    if (stage === 0) { L.drag = (type === 0 || type === 1) ? { type, slots: [] } : null; return }
    if (!L.drag) return
    if (stage === 1) {
      if (slotIdx < 0 || slotIdx >= L.slots.length) return
      const s = stackAt(L.slots, slotIdx)
      const canRep = stEmpty(s) || sameItem(s, L.cursor)
      const enough = type === 2 || L.cursor.itemCount > L.drag.slots.length
      if (canRep && enough && !L.drag.slots.includes(slotIdx)) L.drag.slots.push(slotIdx)
      return
    }
    if (stage === 2) {
      const d = L.drag
      L.drag = null
      if (!d) return
      if (d.slots.length === 1) { doClickSim(L, d.slots[0], d.type, 0); return } // single-slot drag = a plain click
      if (d.slots.length > 1) {
        let remaining = L.cursor.itemCount
        const itemId = L.cursor.itemId
        const nbtData = L.cursor.nbtData || null
        const size = d.slots.length
        for (const idx of d.slots) {
          if (remaining <= 0) break
          const s2 = stackAt(L.slots, idx)
          if (!(stEmpty(s2) || (s2.itemId === itemId && nbtEq(s2.nbtData, nbtData)))) continue
          const existing = stEmpty(s2) ? 0 : s2.itemCount
          const per = d.type === 1 ? 1 : Math.floor(remaining / size) // left = even split, right = one each
          const total = Math.min(per + existing, maxStackOf(itemId))
          const gain = total - existing
          if (gain <= 0) continue
          remaining -= gain
          L.slots[idx] = { present: true, itemId, itemCount: total, nbtData }
        }
        L.cursor = remaining > 0 ? { present: true, itemId, itemCount: remaining, nbtData } : { present: false }
      }
      return
    }
    return
  }
  if (mode === 6) { // PICKUP_ALL (double-click gather)
    if (stEmpty(L.cursor)) return
    if (slotIdx < 0 || slotIdx >= L.slots.length) return
    if (!stEmpty(stackAt(L.slots, slotIdx))) return // gate: clicked slot must be empty
    const dir = button === 0 ? 1 : -1
    const start = button === 0 ? 0 : L.slots.length - 1
    const exclude = (lay.qm === 'inventory' || lay.qm === 'crafting') ? lay.result : -1
    for (let pass = 0; pass < 2; pass++) {
      for (let i = start; i >= 0 && i < L.slots.length; i += dir) {
        if (L.cursor.itemCount >= maxStackOf(L.cursor.itemId)) break
        const s3 = stackAt(L.slots, i)
        if (stEmpty(s3) || !sameItem(s3, L.cursor)) continue
        if (pass === 0 && s3.itemCount >= maxStackOf(s3.itemId)) continue
        if (i === exclude) continue
        const take = Math.min(s3.itemCount, maxStackOf(L.cursor.itemId) - L.cursor.itemCount)
        if (take <= 0) break
        L.slots[i] = { ...s3, itemCount: s3.itemCount - take }
        if (L.slots[i].itemCount <= 0) L.slots[i] = { present: false }
        L.cursor = { ...L.cursor, itemCount: L.cursor.itemCount + take }
      }
    }
    return
  }
}
/* predict one click exactly like MultiPlayerGameMode.handleContainerInput:
   snapshot -> doClick -> diff -> changed_slots + carried-after */
function predictClick (refs, gui, slotIdx, button, mode) {
  const { inv, player } = refs
  const slots = gui ? gui.slots : inv.slots
  const n = slots.length
  const snap = new Array(n)
  for (let i = 0; i < n; i++) snap[i] = stClone(stackAt(slots, i))
  const L = { slots, layout: menuLayout(gui), cursor: stClone(inv.cursor), drag: player.menuDrag || null, inv }
  doClickSim(L, slotIdx, button, mode)
  inv.cursor = L.cursor
  player.menuDrag = L.drag
  const changed = []
  for (let i = 0; i < n; i++) {
    const after = stackAt(slots, i)
    if (!stEq(snap[i], after)) changed.push({ location: i, item: stClone(after) })
  }
  return { changed, cursor: stClone(inv.cursor) }
}

/* ---------------- web console: inventory & open GUIs ---------------- */
// slot -> JSON-safe brief (never ship nbt: longs are BigInt and would throw)
/* plain text out of a chat/JSON component or a legacy § string */
function textOf (v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.startsWith('{') || t.startsWith('[')) { try { return textOf(JSON.parse(t)) } catch {} }
    return v
  }
  if (Array.isArray(v)) return v.map(textOf).join('')
  if (typeof v === 'object') {
    let out = ''
    if (typeof v.text === 'string') out += v.text
    if (typeof v.translate === 'string') out += v.translate
    if (v.with) out += textOf(v.with)
    if (v.extra) out += textOf(v.extra)
    return out
  }
  return String(v)
}
const HEX_CODE = /\u00a7#[0-9a-fA-F]{6}/g
const stripCodes = t => String(t).replace(HEX_CODE, '').replace(/\u00a7./g, '')
/* JSON text component -> legacy § string, so one renderer handles both */
const LEGACY_COLOR = { black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5', gold: '6', gray: '7', dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c', light_purple: 'd', yellow: 'e', white: 'f' }
function legacyOf (v, depth = 0) {
  if (v === null || v === undefined || depth > 8) return ''
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.startsWith('{') || t.startsWith('[')) { try { return legacyOf(JSON.parse(t), depth + 1) } catch {} }
    return v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(x => legacyOf(x, depth + 1)).join('')
  if (typeof v !== 'object') return ''
  let pre = ''
  // colours: named -> legacy code, "#RRGGBB" -> the 5-char §#RRGGBB form the page understands
  // (CWR's chat is per-character gradients, which legacy codes alone cannot express)
  if (typeof v.color === 'string') {
    const c = v.color.trim()
    if (c === 'reset' || c === 'none') pre += '§r'
    else if (/^#[0-9a-fA-F]{6}$/.test(c)) pre += '§' + c.toUpperCase()
    else if (LEGACY_COLOR[c]) pre += '§' + LEGACY_COLOR[c]
  }
  // formatting flags arrive as NBT bytes (0/1) as often as booleans
  const on = x => x === true || x === 1 || x === 'true'
  if (on(v.bold)) pre += '§l'
  if (on(v.italic)) pre += '§o'
  if (on(v.underlined)) pre += '§n'
  if (on(v.strikethrough)) pre += '§m'
  if (on(v.obfuscated)) pre += '§k'
  let body = ''
  if (typeof v.text === 'string') body += v.text
  else if (typeof v.translate === 'string') body += v.translate
  else if (v.score && v.score.value !== undefined && v.score.value !== null) body += String(v.score.value)
  else if (typeof v.selector === 'string') body += v.selector
  else if (typeof v.keybind === 'string') body += v.keybind
  else if (typeof v.literal === 'string') body += v.literal
  if (v.with) body += legacyOf(v.with, depth + 1)
  if (v.extra) body += legacyOf(v.extra, depth + 1)
  // keep the code even when this node has no text of its own: legacy codes stay
  // active for the siblings that follow, which is how colour inheritance works
  return pre + body
}
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
/* Optional (ICON_GUESS=1), OFF by default. An earlier round used this to "fix" items that
   looked wrong only because the id table was shifted; with the correct 1.20.4 registry the
   base material is right, so guessing from the name would override good data. Kept for
   servers that really do disguise items behind unrelated materials. */
const ICON_CLASS = [
  [/\bhelmet|\bhood|\bcap\b|\bhead\b|\bcrown|\bmask/i, 'helmet'],
  [/chestplate|\bchest\b|\btunic|\bplatebody|\bjacket/i, 'chestplate'],
  [/leggings|\blegs\b|\bpants|\bgreaves/i, 'leggings'],
  [/boots|\bboots\b|\bsandals/i, 'boots'],
  [/\bsword|\bblade\b|\bkatana|\bsaber/i, 'sword'],
  [/\bpickaxe|\bdrill/i, 'pickaxe'],
  [/\bshovel|\bspade/i, 'shovel'],
  [/\baxe\b|\bhatchet/i, 'axe'],
  [/crossbow/i, 'crossbow'],
  [/\bbow\b/i, 'bow'],
  [/\bshield/i, 'shield'],
  [/fishing rod|\brod\b/i, 'fishing_rod'],
  [/elytra|\bwings\b/i, 'elytra'],
  [/\btrident|\bspear\b/i, 'trident']
]
const CLASS_ICON = {
  helmet: 'item/iron_helmet.png', chestplate: 'item/iron_chestplate.png',
  leggings: 'item/iron_leggings.png', boots: 'item/iron_boots.png',
  sword: 'item/iron_sword.png', pickaxe: 'item/iron_pickaxe.png', shovel: 'item/iron_shovel.png',
  axe: 'item/iron_axe.png', bow: 'item/bow.png', crossbow: 'item/crossbow.png',
  shield: 'entity/shield_base.png', fishing_rod: 'item/fishing_rod.png',
  elytra: 'item/elytra.png', trident: 'item/trident.png'
}
function iconClassOf (plain) {
  if (!plain) return ''
  for (const [re, cls] of ICON_CLASS) if (re.test(plain)) return cls
  return ''
}
const nbtList = (node) => {
  if (!node || !node.v) return []
  if (Array.isArray(node.v.items)) return node.v.items          // tagged codec
  if (Array.isArray(node.v)) return node.v                      // plain codec
  return []
}
function itemBrief (it) {
  if (!it || it.present === false) return null
  if (it.present === undefined && it.itemId === undefined) return null
  const id = it.itemId | 0
  const count = Math.max(0, it.itemCount | 0)
  if (id === 0 && count <= 0) return null // air = empty
  const reg = ITEM_NAMES[String(id)] || null
  let custom = null, lore = [], ench = []
  try {
    const n = it.nbtData
    if (n && n.__t === 10 && Array.isArray(n.v)) {
      const entry = (k) => { const e = n.v.find(x => x[0] === k); return e ? e[1] : null }
      const disp = entry('display')
      if (disp && disp.__t === 10 && Array.isArray(disp.v)) {
        const e2 = disp.v.find(x => x[0] === 'Name')
        if (e2 && e2[1].__t === 8 && typeof e2[1].v === 'string') custom = e2[1].v
        const lo = disp.v.find(x => x[0] === 'Lore')
        // lore lines arrive as JSON components inside string tags — run them through the
        // same legacy converter as names so the page gets § codes, not raw JSON
        if (lo && lo[1]) lore = nbtList(lo[1]).slice(0, 14)
          .map(x => (x && typeof x.v === 'string') ? legacyOf(x.v) : legacyOf(x && x.v))
          .filter(Boolean)
      }
      const en = entry('Enchantments') || entry('StoredEnchantments')
      if (en) {
        ench = nbtList(en).slice(0, 12).map(c => {
          if (!c || !Array.isArray(c.v)) return null
          const g = k2 => { const e = c.v.find(x => x[0] === k2); return e ? e[1].v : null }
          let nm = g('id')
          const lvl = g('lvl') || 1
          if (nm === null) return null
          nm = stripCodes(textOf(nm)).replace(/^minecraft:/, '').replace(/_/g, ' ')
          return nm.replace(/\b\w/g, m => m.toUpperCase()) + ' ' + (ROMAN[lvl] || lvl)
        }).filter(Boolean)
      }
    }
  } catch {}
  if (DEBUG_ITEM) {
    try {
      fs.appendFileSync(path.join(__dirname, 'itemraw.jsonl'), JSON.stringify({ id, count, nbt: it.nbtData },
        (k, v) => Buffer.isBuffer(v) ? `<${v.length}b>` : v) + '\n')
    } catch {}
  }
  const nameLegacy = custom ? legacyOf(custom) : null   // §-coded, ready for the page
  const disp = nameLegacy ? stripCodes(nameLegacy).trim() : (reg ? reg.n.replace(/\b\w/g, m => m.toUpperCase()) : ('item ' + id))
  let cmd = null                                     // 1.20.4 CustomModelData (custom item art)
  try {
    const n = it.nbtData
    if (n && n.__t === 10 && Array.isArray(n.v)) {
      const e = n.v.find(x => x[0] === 'CustomModelData')
      if (e && e[1] && e[1].v !== undefined) cmd = Number(e[1].v)
    }
  } catch {}
  // only override when the name promises a shape the base material does not already have
  let cls = '', ctex = ''
  if (ICON_GUESS && custom) {
    const plain = stripCodes(disp)
    cls = iconClassOf(plain)
    const baseKey = reg ? reg.k : ''
    if (cls && !(baseKey && baseKey.includes(cls === 'chestplate' ? 'chestplate' : cls))) ctex = CLASS_ICON[cls] || ''
  }
  return {
    id, count, cmd, customIcon: ctex,
    max: (reg && reg.s) ? reg.s : 64,               // stack limit, so the page can merge exactly
    name: nameLegacy,                                   // raw (may carry § codes / JSON)
    disp,                                           // plain, hover title
    custom: !!custom,
    key: reg ? reg.k : '',
    tex: reg ? (ITEM_TEX[reg.k] || '') : '',
    lore: lore.map(x => String(x)),   // raw: the page renders § colours
    ench
  }
}
// best-effort MenuType registry order for 1.20.4 (cosmetic only)
const MENU_TYPES = ['generic_9x1', 'generic_9x2', 'generic_9x3', 'generic_9x4', 'generic_9x5', 'generic_9x6',
  'generic_3x3', 'crafter_3x3', 'anvil', 'beacon', 'blast_furnace', 'brewing_stand', 'crafting', 'enchantment',
  'furnace', 'grindstone', 'hopper', 'lectern', 'loom', 'merchant', 'shulker_box', 'smithing', 'smoker',
  'cartography', 'stonecutter']
function menuName (t) {
  return Number.isInteger(t) && t >= 0 && t < MENU_TYPES.length ? MENU_TYPES[t] : ('menu#' + t)
}
let WEB_STATE = () => ({ connected: false })
let WEB_CLICK = () => { throw new Error('bot not connected') }
let WEB_CLICK_BATCH = () => { throw new Error('bot not connected') }
let WEB_USE = () => { throw new Error('bot not connected') }
let WEB_CREATIVE = () => { throw new Error('bot not connected') }
let WEB_USE_BLOCK = () => { throw new Error('bot not connected') }
let WEB_HELD = () => { throw new Error('bot not connected') }
let WEB_CLOSE = () => { throw new Error('bot not connected') }
let WEB_CHAT = () => { throw new Error('bot not connected') }
// kept in sync with SESSION_SEND: a false return means "the bot is not in play right now"

/* ---- web chat: one ring buffer fed by every inbound text line ---- */
const CHAT_RING = []
let CHAT_SEQ = 0
function pushWebChat (kind, text) {
  if (!text) return
  CHAT_RING.push({ seq: ++CHAT_SEQ, t: Date.now(), kind, text: String(text) })
  while (CHAT_RING.length > 400) CHAT_RING.shift()
}
function webChatSince (since) {
  const n = Number(since) || 0
  return { last: CHAT_SEQ, lines: CHAT_RING.filter(l => l.seq > n) }
}

/* Missing texture? The bot downloads it from the public 1.20.4 asset mirrors and caches it
   in textures/, so the browser only ever talks to the bot and icons work even when the
   folder was not extracted. Runs at most once per file per process. */
const TEX_MIRRORS = [
  'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@1.20.4/assets/minecraft/textures/',
  'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.20.4/assets/minecraft/textures/'
]
const texWanted = new Set()
const texTried = new Set()
function fetchTexFromMirror (rel) {
  if (texTried.has(rel)) return Promise.resolve(null)
  texTried.add(rel)
  const https = require('https')
  const tryOne = (i) => new Promise(resolve => {
    if (i >= TEX_MIRRORS.length) return resolve(null)
    let settled = false
    const done = b => { if (!settled) { settled = true; resolve(b) } }
    try {
      const rq = https.get(TEX_MIRRORS[i] + rel, { timeout: 8000, headers: { 'user-agent': 'vanilla-node' } }, res => {
        if (res.statusCode !== 200) { res.resume(); return done(null) }
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) { log(`tex: fetched ${rel} from mirror`); done(buf) } else done(null)
        })
      })
      rq.on('error', () => done(null))
      rq.on('timeout', () => { try { rq.destroy() } catch {}; done(null) })
    } catch { done(null) }
  })
  return (async () => {
    for (let i = 0; i < TEX_MIRRORS.length; i++) {
      const b = await tryOne(i)
      if (b) return b
    }
    return null
  })()
}
/* Hosts like Render require a *web service* to bind the port they hand you.
   With WEB=off there is no console, but an unbound container is treated as
   unhealthy: Render keeps scanning, throttles it and eventually suspends the CPU,
   which is what froze the client for ~60s and got it kicked with ReadTimeout.
   So when $PORT exists, open it anyway — with a health endpoint and nothing else. */
function startHealthPort (port) {
  const http = require('http')
  const srv = http.createServer((req, res) => {
    if (!/^\/(healthz|health)?$/.test((req.url || '/').split('?')[0])) { res.writeHead(404); res.end('not here'); return }
    const body = JSON.stringify({ ok: true, build: BUILD, web: 'off', uptime: Math.round(process.uptime()) })
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  })
  srv.on('error', e => log(`health port ${port}: ${e.message}`))
  srv.listen(port, '0.0.0.0', () => log(`health endpoint on :${port} (the host requires a bound port; web console is still off — set WEB=on for the UI)`))
  return srv
}

function startWebConsole () {
  const http = require('http')
  // the UI lives in page.html so it can be edited without touching the engine
  let PAGE_FILE = null
  try { PAGE_FILE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8') } catch {}
  const PAGE = "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>MC bot &mdash; container</title>\n<style>\n  *{box-sizing:border-box}\n  body{background:#14161a;color:#dfe3e8;font:14px/1.4 system-ui,Segoe UI,sans-serif;margin:0;padding:14px;user-select:none}\n  h1{font-size:15px;margin:0 0 8px;font-weight:600}\n  .chip{display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;background:#2a2f36;margin:0 6px 6px 0}\n  .on{background:#1d5c2e}.warn{background:#6b5310}\n  #panel{position:relative;display:inline-block;padding:10px 12px;background:#1b1e23;border:1px solid #333941;border-radius:6px;min-width:300px}\n  .line{display:flex;align-items:flex-end;gap:10px;margin:6px 0}\n  .col{display:flex;flex-direction:column;gap:4px}\n  .lbl{color:#8b94a1;font-size:10px;text-transform:uppercase;letter-spacing:.07em}\n  .grid{display:grid;gap:3px}\n  .slot{width:42px;height:42px;background:#23262b;border:1px solid #3a3f47;border-radius:4px;position:relative;cursor:pointer;overflow:hidden}\n  .slot.empty{background:#1a1d22}\n  .slot.hot{border-color:#8ab4ff;background:#2b3340}\n  .slot.drag{border-color:#ffd76e;background:#3a3320}\n  .slot .n{position:absolute;left:2px;top:1px;right:2px;font-size:8px;line-height:1.1;color:#cfd6de;word-break:break-word;pointer-events:none}\n  .slot .c{position:absolute;right:3px;bottom:-1px;font-size:12px;font-weight:700;color:#fff;text-shadow:1px 1px 0 #000;pointer-events:none}\n  .slot.result{border-color:#6b7f5a}\n  #carry{position:fixed;pointer-events:none;z-index:9;padding:2px 6px;border-radius:4px;background:#2b3340cc;border:1px solid #8ab4ff;font-size:11px;display:none}\n  button{background:#2a2f36;color:#dfe3e8;border:1px solid #3a3f47;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:13px}\n  button:hover{border-color:#8ab4ff}\n  .hint{color:#8b94a1;font-size:11.5px;margin:8px 0 0;max-width:640px}\n  kbd{background:#2a2f36;border:1px solid #3a3f47;border-radius:3px;padding:0 4px;font-size:11px}\n  .title{color:#ffd76e;font-size:12.5px;margin:0 0 4px}\n</style></head><body>\n<h1>MC bot &mdash; inventory &amp; container</h1>\n<div id=\"status\">connecting&hellip;</div>\n<div id=\"panel\"><div id=\"box\">loading&hellip;</div></div>\n<div class=\"hint\">\n  LMB pick up / place stack &middot; RMB pick up half / place one &middot; drag to paint &middot; double-click to gather &middot;\n  click outside the menu to drop the cursor &middot; <kbd>shift</kbd>+click transfer &middot; <kbd>1</kbd>&ndash;<kbd>9</kbd> swap to hotbar &middot;\n  <kbd>F</kbd> swap to offhand &middot; <kbd>Q</kbd> drop one &middot; <kbd>shift</kbd>+<kbd>Q</kbd> drop stack\n  <div style=\"margin-top:8px\"><button id=\"closeBtn\" style=\"display:none\">close container</button></div>\n</div>\n<div id=\"carry\"></div>\n<script>\nvar NAMES={0:\"\",1:\"stone\",2:\"granite\",3:\"polished granite\",4:\"diorite\",5:\"polished diorite\",6:\"andesite\",7:\"polished andesite\",8:\"deepslate\",9:\"cobbled deepslate\",10:\"polished deepslate\",11:\"calcite\",12:\"tuff\",13:\"tuff slab\",14:\"tuff stairs\",15:\"tuff wall\",16:\"chiseled tuff\",17:\"polished tuff\",18:\"polished tuff slab\",19:\"polished tuff stairs\",20:\"polished tuff wall\",21:\"tuff bricks\",22:\"tuff brick slab\",23:\"tuff brick stairs\",24:\"tuff brick wall\",25:\"chiseled tuff bricks\",26:\"dripstone block\",27:\"grass block\",28:\"dirt\",29:\"coarse dirt\",30:\"podzol\",31:\"rooted dirt\",32:\"mud\",33:\"crimson nylium\",34:\"warped nylium\",35:\"cobblestone\",36:\"oak planks\",37:\"spruce planks\",38:\"birch planks\",39:\"jungle planks\",40:\"acacia planks\",41:\"cherry planks\",42:\"dark oak planks\",43:\"mangrove planks\",44:\"bamboo planks\",45:\"crimson planks\",46:\"warped planks\",47:\"bamboo mosaic\",48:\"oak sapling\",49:\"spruce sapling\",50:\"birch sapling\",51:\"jungle sapling\",52:\"acacia sapling\",53:\"cherry sapling\",54:\"dark oak sapling\",55:\"mangrove propagule\",56:\"bedrock\",57:\"sand\",58:\"suspicious sand\",59:\"suspicious gravel\",60:\"red sand\",61:\"gravel\",62:\"coal ore\",63:\"deepslate coal ore\",64:\"iron ore\",65:\"deepslate iron ore\",66:\"copper ore\",67:\"deepslate copper ore\",68:\"gold ore\",69:\"deepslate gold ore\",70:\"redstone ore\",71:\"deepslate redstone ore\",72:\"emerald ore\",73:\"deepslate emerald ore\",74:\"lapis ore\",75:\"deepslate lapis ore\",76:\"diamond ore\",77:\"deepslate diamond ore\",78:\"nether gold ore\",79:\"nether quartz ore\",80:\"ancient debris\",81:\"coal block\",82:\"raw iron block\",83:\"raw copper block\",84:\"raw gold block\",85:\"amethyst block\",86:\"budding amethyst\",87:\"iron block\",88:\"copper block\",89:\"gold block\",90:\"diamond block\",91:\"netherite block\",92:\"exposed copper\",93:\"weathered copper\",94:\"oxidized copper\",95:\"chiseled copper\",96:\"exposed chiseled copper\",97:\"weathered chiseled copper\",98:\"oxidized chiseled copper\",99:\"cut copper\",100:\"exposed cut copper\",101:\"weathered cut copper\",102:\"oxidized cut copper\",103:\"cut copper stairs\",104:\"exposed cut copper stairs\",105:\"weathered cut copper stairs\",106:\"oxidized cut copper stairs\",107:\"cut copper slab\",108:\"exposed cut copper slab\",109:\"weathered cut copper slab\",110:\"oxidized cut copper slab\",111:\"waxed copper block\",112:\"waxed exposed copper\",113:\"waxed weathered copper\",114:\"waxed oxidized copper\",115:\"waxed chiseled copper\",116:\"waxed exposed chiseled copper\",117:\"waxed weathered chiseled copper\",118:\"waxed oxidized chiseled copper\",119:\"waxed cut copper\",120:\"waxed exposed cut copper\",121:\"waxed weathered cut copper\",122:\"waxed oxidized cut copper\",123:\"waxed cut copper stairs\",124:\"waxed exposed cut copper stairs\",125:\"waxed weathered cut copper stairs\",126:\"waxed oxidized cut copper stairs\",127:\"waxed cut copper slab\",128:\"waxed exposed cut copper slab\",129:\"waxed weathered cut copper slab\",130:\"waxed oxidized cut copper slab\",131:\"oak log\",132:\"spruce log\",133:\"birch log\",134:\"jungle log\",135:\"acacia log\",136:\"cherry log\",137:\"dark oak log\",138:\"mangrove log\",139:\"mangrove roots\",140:\"muddy mangrove roots\",141:\"crimson stem\",142:\"warped stem\",143:\"bamboo block\",144:\"stripped oak log\",145:\"stripped spruce log\",146:\"stripped birch log\",147:\"stripped jungle log\",148:\"stripped acacia log\",149:\"stripped cherry log\",150:\"stripped dark oak log\",151:\"stripped mangrove log\",152:\"stripped crimson stem\",153:\"stripped warped stem\",154:\"stripped oak wood\",155:\"stripped spruce wood\",156:\"stripped birch wood\",157:\"stripped jungle wood\",158:\"stripped acacia wood\",159:\"stripped cherry wood\",160:\"stripped dark oak wood\",161:\"stripped mangrove wood\",162:\"stripped crimson hyphae\",163:\"stripped warped hyphae\",164:\"stripped bamboo block\",165:\"oak wood\",166:\"spruce wood\",167:\"birch wood\",168:\"jungle wood\",169:\"acacia wood\",170:\"cherry wood\",171:\"dark oak wood\",172:\"mangrove wood\",173:\"crimson hyphae\",174:\"warped hyphae\",175:\"oak leaves\",176:\"spruce leaves\",177:\"birch leaves\",178:\"jungle leaves\",179:\"acacia leaves\",180:\"cherry leaves\",181:\"dark oak leaves\",182:\"mangrove leaves\",183:\"azalea leaves\",184:\"flowering azalea leaves\",185:\"sponge\",186:\"wet sponge\",187:\"glass\",188:\"tinted glass\",189:\"lapis block\",190:\"sandstone\",191:\"chiseled sandstone\",192:\"cut sandstone\",193:\"cobweb\",194:\"short grass\",195:\"fern\",196:\"azalea\",197:\"flowering azalea\",198:\"dead bush\",199:\"seagrass\",200:\"sea pickle\",201:\"white wool\",202:\"orange wool\",203:\"magenta wool\",204:\"light blue wool\",205:\"yellow wool\",206:\"lime wool\",207:\"pink wool\",208:\"gray wool\",209:\"light gray wool\",210:\"cyan wool\",211:\"purple wool\",212:\"blue wool\",213:\"brown wool\",214:\"green wool\",215:\"red wool\",216:\"black wool\",217:\"dandelion\",218:\"poppy\",219:\"blue orchid\",220:\"allium\",221:\"azure bluet\",222:\"red tulip\",223:\"orange tulip\",224:\"white tulip\",225:\"pink tulip\",226:\"oxeye daisy\",227:\"cornflower\",228:\"lily of the valley\",229:\"wither rose\",230:\"torchflower\",231:\"pitcher plant\",232:\"spore blossom\",233:\"brown mushroom\",234:\"red mushroom\",235:\"crimson fungus\",236:\"warped fungus\",237:\"crimson roots\",238:\"warped roots\",239:\"nether sprouts\",240:\"weeping vines\",241:\"twisting vines\",242:\"sugar cane\",243:\"kelp\",244:\"moss carpet\",245:\"pink petals\",246:\"moss block\",247:\"hanging roots\",248:\"big dripleaf\",249:\"small dripleaf\",250:\"bamboo\",251:\"oak slab\",252:\"spruce slab\",253:\"birch slab\",254:\"jungle slab\",255:\"acacia slab\",256:\"cherry slab\",257:\"dark oak slab\",258:\"mangrove slab\",259:\"bamboo slab\",260:\"bamboo mosaic slab\",261:\"crimson slab\",262:\"warped slab\",263:\"stone slab\",264:\"smooth stone slab\",265:\"sandstone slab\",266:\"cut standstone slab\",267:\"petrified oak slab\",268:\"cobblestone slab\",269:\"brick slab\",270:\"stone brick slab\",271:\"mud brick slab\",272:\"nether brick slab\",273:\"quartz slab\",274:\"red sandstone slab\",275:\"cut red sandstone slab\",276:\"purpur slab\",277:\"prismarine slab\",278:\"prismarine brick slab\",279:\"dark prismarine slab\",280:\"smooth quartz\",281:\"smooth red sandstone\",282:\"smooth sandstone\",283:\"smooth stone\",284:\"bricks\",285:\"bookshelf\",286:\"chiseled bookshelf\",287:\"decorated pot\",288:\"mossy cobblestone\",289:\"obsidian\",290:\"torch\",291:\"end rod\",292:\"chorus plant\",293:\"chorus flower\",294:\"purpur block\",295:\"purpur pillar\",296:\"purpur stairs\",297:\"spawner\",298:\"chest\",299:\"crafting table\",300:\"farmland\",301:\"furnace\",302:\"ladder\",303:\"cobblestone stairs\",304:\"snow\",305:\"ice\",306:\"snow block\",307:\"cactus\",308:\"clay\",309:\"jukebox\",310:\"oak fence\",311:\"spruce fence\",312:\"birch fence\",313:\"jungle fence\",314:\"acacia fence\",315:\"cherry fence\",316:\"dark oak fence\",317:\"mangrove fence\",318:\"bamboo fence\",319:\"crimson fence\",320:\"warped fence\",321:\"pumpkin\",322:\"carved pumpkin\",323:\"jack o lantern\",324:\"netherrack\",325:\"soul sand\",326:\"soul soil\",327:\"basalt\",328:\"polished basalt\",329:\"smooth basalt\",330:\"soul torch\",331:\"glowstone\",332:\"infested stone\",333:\"infested cobblestone\",334:\"infested stone bricks\",335:\"infested mossy stone bricks\",336:\"infested cracked stone bricks\",337:\"infested chiseled stone bricks\",338:\"infested deepslate\",339:\"stone bricks\",340:\"mossy stone bricks\",341:\"cracked stone bricks\",342:\"chiseled stone bricks\",343:\"packed mud\",344:\"mud bricks\",345:\"deepslate bricks\",346:\"cracked deepslate bricks\",347:\"deepslate tiles\",348:\"cracked deepslate tiles\",349:\"chiseled deepslate\",350:\"reinforced deepslate\",351:\"brown mushroom block\",352:\"red mushroom block\",353:\"mushroom stem\",354:\"iron bars\",355:\"chain\",356:\"glass pane\",357:\"melon\",358:\"vine\",359:\"glow lichen\",360:\"brick stairs\",361:\"stone brick stairs\",362:\"mud brick stairs\",363:\"mycelium\",364:\"lily pad\",365:\"nether bricks\",366:\"cracked nether bricks\",367:\"chiseled nether bricks\",368:\"nether brick fence\",369:\"nether brick stairs\",370:\"sculk\",371:\"sculk vein\",372:\"sculk catalyst\",373:\"sculk shrieker\",374:\"enchanting table\",375:\"end portal frame\",376:\"end stone\",377:\"end stone bricks\",378:\"dragon egg\",379:\"sandstone stairs\",380:\"ender chest\",381:\"emerald block\",382:\"oak stairs\",383:\"spruce stairs\",384:\"birch stairs\",385:\"jungle stairs\",386:\"acacia stairs\",387:\"cherry stairs\",388:\"dark oak stairs\",389:\"mangrove stairs\",390:\"bamboo stairs\",391:\"bamboo mosaic stairs\",392:\"crimson stairs\",393:\"warped stairs\",394:\"command block\",395:\"beacon\",396:\"cobblestone wall\",397:\"mossy cobblestone wall\",398:\"brick wall\",399:\"prismarine wall\",400:\"red sandstone wall\",401:\"mossy stone brick wall\",402:\"granite wall\",403:\"stone brick wall\",404:\"mud brick wall\",405:\"nether brick wall\",406:\"andesite wall\",407:\"red nether brick wall\",408:\"sandstone wall\",409:\"end stone brick wall\",410:\"diorite wall\",411:\"blackstone wall\",412:\"polished blackstone wall\",413:\"polished blackstone brick wall\",414:\"cobbled deepslate wall\",415:\"polished deepslate wall\",416:\"deepslate brick wall\",417:\"deepslate tile wall\",418:\"anvil\",419:\"chipped anvil\",420:\"damaged anvil\",421:\"chiseled quartz block\",422:\"quartz block\",423:\"quartz bricks\",424:\"quartz pillar\",425:\"quartz stairs\",426:\"white terracotta\",427:\"orange terracotta\",428:\"magenta terracotta\",429:\"light blue terracotta\",430:\"yellow terracotta\",431:\"lime terracotta\",432:\"pink terracotta\",433:\"gray terracotta\",434:\"light gray terracotta\",435:\"cyan terracotta\",436:\"purple terracotta\",437:\"blue terracotta\",438:\"brown terracotta\",439:\"green terracotta\",440:\"red terracotta\",441:\"black terracotta\",442:\"barrier\",443:\"light\",444:\"hay block\",445:\"white carpet\",446:\"orange carpet\",447:\"magenta carpet\",448:\"light blue carpet\",449:\"yellow carpet\",450:\"lime carpet\",451:\"pink carpet\",452:\"gray carpet\",453:\"light gray carpet\",454:\"cyan carpet\",455:\"purple carpet\",456:\"blue carpet\",457:\"brown carpet\",458:\"green carpet\",459:\"red carpet\",460:\"black carpet\",461:\"terracotta\",462:\"packed ice\",463:\"dirt path\",464:\"sunflower\",465:\"lilac\",466:\"rose bush\",467:\"peony\",468:\"tall grass\",469:\"large fern\",470:\"white stained glass\",471:\"orange stained glass\",472:\"magenta stained glass\",473:\"light blue stained glass\",474:\"yellow stained glass\",475:\"lime stained glass\",476:\"pink stained glass\",477:\"gray stained glass\",478:\"light gray stained glass\",479:\"cyan stained glass\",480:\"purple stained glass\",481:\"blue stained glass\",482:\"brown stained glass\",483:\"green stained glass\",484:\"red stained glass\",485:\"black stained glass\",486:\"white stained glass pane\",487:\"orange stained glass pane\",488:\"magenta stained glass pane\",489:\"light blue stained glass pane\",490:\"yellow stained glass pane\",491:\"lime stained glass pane\",492:\"pink stained glass pane\",493:\"gray stained glass pane\",494:\"light gray stained glass pane\",495:\"cyan stained glass pane\",496:\"purple stained glass pane\",497:\"blue stained glass pane\",498:\"brown stained glass pane\",499:\"green stained glass pane\",500:\"red stained glass pane\",501:\"black stained glass pane\",502:\"prismarine\",503:\"prismarine bricks\",504:\"dark prismarine\",505:\"prismarine stairs\",506:\"prismarine brick stairs\",507:\"dark prismarine stairs\",508:\"sea lantern\",509:\"red sandstone\",510:\"chiseled red sandstone\",511:\"cut red sandstone\",512:\"red sandstone stairs\",513:\"repeating command block\",514:\"chain command block\",515:\"magma block\",516:\"nether wart block\",517:\"warped wart block\",518:\"red nether bricks\",519:\"bone block\",520:\"structure void\",521:\"shulker box\",522:\"white shulker box\",523:\"orange shulker box\",524:\"magenta shulker box\",525:\"light blue shulker box\",526:\"yellow shulker box\",527:\"lime shulker box\",528:\"pink shulker box\",529:\"gray shulker box\",530:\"light gray shulker box\",531:\"cyan shulker box\",532:\"purple shulker box\",533:\"blue shulker box\",534:\"brown shulker box\",535:\"green shulker box\",536:\"red shulker box\",537:\"black shulker box\",538:\"white glazed terracotta\",539:\"orange glazed terracotta\",540:\"magenta glazed terracotta\",541:\"light blue glazed terracotta\",542:\"yellow glazed terracotta\",543:\"lime glazed terracotta\",544:\"pink glazed terracotta\",545:\"gray glazed terracotta\",546:\"light gray glazed terracotta\",547:\"cyan glazed terracotta\",548:\"purple glazed terracotta\",549:\"blue glazed terracotta\",550:\"brown glazed terracotta\",551:\"green glazed terracotta\",552:\"red glazed terracotta\",553:\"black glazed terracotta\",554:\"white concrete\",555:\"orange concrete\",556:\"magenta concrete\",557:\"light blue concrete\",558:\"yellow concrete\",559:\"lime concrete\",560:\"pink concrete\",561:\"gray concrete\",562:\"light gray concrete\",563:\"cyan concrete\",564:\"purple concrete\",565:\"blue concrete\",566:\"brown concrete\",567:\"green concrete\",568:\"red concrete\",569:\"black concrete\",570:\"white concrete powder\",571:\"orange concrete powder\",572:\"magenta concrete powder\",573:\"light blue concrete powder\",574:\"yellow concrete powder\",575:\"lime concrete powder\",576:\"pink concrete powder\",577:\"gray concrete powder\",578:\"light gray concrete powder\",579:\"cyan concrete powder\",580:\"purple concrete powder\",581:\"blue concrete powder\",582:\"brown concrete powder\",583:\"green concrete powder\",584:\"red concrete powder\",585:\"black concrete powder\",586:\"turtle egg\",587:\"sniffer egg\",588:\"dead tube coral block\",589:\"dead brain coral block\",590:\"dead bubble coral block\",591:\"dead fire coral block\",592:\"dead horn coral block\",593:\"tube coral block\",594:\"brain coral block\",595:\"bubble coral block\",596:\"fire coral block\",597:\"horn coral block\",598:\"tube coral\",599:\"brain coral\",600:\"bubble coral\",601:\"fire coral\",602:\"horn coral\",603:\"dead brain coral\",604:\"dead bubble coral\",605:\"dead fire coral\",606:\"dead horn coral\",607:\"dead tube coral\",608:\"tube coral fan\",609:\"brain coral fan\",610:\"bubble coral fan\",611:\"fire coral fan\",612:\"horn coral fan\",613:\"dead tube coral fan\",614:\"dead brain coral fan\",615:\"dead bubble coral fan\",616:\"dead fire coral fan\",617:\"dead horn coral fan\",618:\"blue ice\",619:\"conduit\",620:\"polished granite stairs\",621:\"smooth red sandstone stairs\",622:\"mossy stone brick stairs\",623:\"polished diorite stairs\",624:\"mossy cobblestone stairs\",625:\"end stone brick stairs\",626:\"stone stairs\",627:\"smooth sandstone stairs\",628:\"smooth quartz stairs\",629:\"granite stairs\",630:\"andesite stairs\",631:\"red nether brick stairs\",632:\"polished andesite stairs\",633:\"diorite stairs\",634:\"cobbled deepslate stairs\",635:\"polished deepslate stairs\",636:\"deepslate brick stairs\",637:\"deepslate tile stairs\",638:\"polished granite slab\",639:\"smooth red sandstone slab\",640:\"mossy stone brick slab\",641:\"polished diorite slab\",642:\"mossy cobblestone slab\",643:\"end stone brick slab\",644:\"smooth sandstone slab\",645:\"smooth quartz slab\",646:\"granite slab\",647:\"andesite slab\",648:\"red nether brick slab\",649:\"polished andesite slab\",650:\"diorite slab\",651:\"cobbled deepslate slab\",652:\"polished deepslate slab\",653:\"deepslate brick slab\",654:\"deepslate tile slab\",655:\"scaffolding\",656:\"redstone\",657:\"redstone torch\",658:\"redstone block\",659:\"repeater\",660:\"comparator\",661:\"piston\",662:\"sticky piston\",663:\"slime block\",664:\"honey block\",665:\"observer\",666:\"hopper\",667:\"dispenser\",668:\"dropper\",669:\"lectern\",670:\"target\",671:\"lever\",672:\"lightning rod\",673:\"daylight detector\",674:\"sculk sensor\",675:\"calibrated sculk sensor\",676:\"tripwire hook\",677:\"trapped chest\",678:\"tnt\",679:\"redstone lamp\",680:\"note block\",681:\"stone button\",682:\"polished blackstone button\",683:\"oak button\",684:\"spruce button\",685:\"birch button\",686:\"jungle button\",687:\"acacia button\",688:\"cherry button\",689:\"dark oak button\",690:\"mangrove button\",691:\"bamboo button\",692:\"crimson button\",693:\"warped button\",694:\"stone pressure plate\",695:\"polished blackstone pressure plate\",696:\"light weighted pressure plate\",697:\"heavy weighted pressure plate\",698:\"oak pressure plate\",699:\"spruce pressure plate\",700:\"birch pressure plate\",701:\"jungle pressure plate\",702:\"acacia pressure plate\",703:\"cherry pressure plate\",704:\"dark oak pressure plate\",705:\"mangrove pressure plate\",706:\"bamboo pressure plate\",707:\"crimson pressure plate\",708:\"warped pressure plate\",709:\"iron door\",710:\"oak door\",711:\"spruce door\",712:\"birch door\",713:\"jungle door\",714:\"acacia door\",715:\"cherry door\",716:\"dark oak door\",717:\"mangrove door\",718:\"bamboo door\",719:\"crimson door\",720:\"warped door\",721:\"copper door\",722:\"exposed copper door\",723:\"weathered copper door\",724:\"oxidized copper door\",725:\"waxed copper door\",726:\"waxed exposed copper door\",727:\"waxed weathered copper door\",728:\"waxed oxidized copper door\",729:\"iron trapdoor\",730:\"oak trapdoor\",731:\"spruce trapdoor\",732:\"birch trapdoor\",733:\"jungle trapdoor\",734:\"acacia trapdoor\",735:\"cherry trapdoor\",736:\"dark oak trapdoor\",737:\"mangrove trapdoor\",738:\"bamboo trapdoor\",739:\"crimson trapdoor\",740:\"warped trapdoor\",741:\"copper trapdoor\",742:\"exposed copper trapdoor\",743:\"weathered copper trapdoor\",744:\"oxidized copper trapdoor\",745:\"waxed copper trapdoor\",746:\"waxed exposed copper trapdoor\",747:\"waxed weathered copper trapdoor\",748:\"waxed oxidized copper trapdoor\",749:\"oak fence gate\",750:\"spruce fence gate\",751:\"birch fence gate\",752:\"jungle fence gate\",753:\"acacia fence gate\",754:\"cherry fence gate\",755:\"dark oak fence gate\",756:\"mangrove fence gate\",757:\"bamboo fence gate\",758:\"crimson fence gate\",759:\"warped fence gate\",760:\"powered rail\",761:\"detector rail\",762:\"rail\",763:\"activator rail\",764:\"saddle\",765:\"minecart\",766:\"chest minecart\",767:\"furnace minecart\",768:\"tnt minecart\",769:\"hopper minecart\",770:\"carrot on a stick\",771:\"warped fungus on a stick\",772:\"elytra\",773:\"oak boat\",774:\"oak chest boat\",775:\"spruce boat\",776:\"spruce chest boat\",777:\"birch boat\",778:\"birch chest boat\",779:\"jungle boat\",780:\"jungle chest boat\",781:\"acacia boat\",782:\"acacia chest boat\",783:\"cherry boat\",784:\"cherry chest boat\",785:\"dark oak boat\",786:\"dark oak chest boat\",787:\"mangrove boat\",788:\"mangrove chest boat\",789:\"bamboo raft\",790:\"bamboo chest raft\",791:\"structure block\",792:\"jigsaw\",793:\"turtle helmet\",794:\"scute\",795:\"flint and steel\",796:\"apple\",797:\"bow\",798:\"arrow\",799:\"coal\",800:\"charcoal\",801:\"diamond\",802:\"emerald\",803:\"lapis lazuli\",804:\"quartz\",805:\"amethyst shard\",806:\"raw iron\",807:\"iron ingot\",808:\"raw copper\",809:\"copper ingot\",810:\"raw gold\",811:\"gold ingot\",812:\"netherite ingot\",813:\"netherite scrap\",814:\"wooden sword\",815:\"wooden shovel\",816:\"wooden pickaxe\",817:\"wooden axe\",818:\"wooden hoe\",819:\"stone sword\",820:\"stone shovel\",821:\"stone pickaxe\",822:\"stone axe\",823:\"stone hoe\",824:\"golden sword\",825:\"golden shovel\",826:\"golden pickaxe\",827:\"golden axe\",828:\"golden hoe\",829:\"iron sword\",830:\"iron shovel\",831:\"iron pickaxe\",832:\"iron axe\",833:\"iron hoe\",834:\"diamond sword\",835:\"diamond shovel\",836:\"diamond pickaxe\",837:\"diamond axe\",838:\"diamond hoe\",839:\"netherite sword\",840:\"netherite shovel\",841:\"netherite pickaxe\",842:\"netherite axe\",843:\"netherite hoe\",844:\"stick\",845:\"bowl\",846:\"mushroom stew\",847:\"string\",848:\"feather\",849:\"gunpowder\",850:\"wheat seeds\",851:\"wheat\",852:\"bread\",853:\"leather helmet\",854:\"leather chestplate\",855:\"leather leggings\",856:\"leather boots\",857:\"chainmail helmet\",858:\"chainmail chestplate\",859:\"chainmail leggings\",860:\"chainmail boots\",861:\"iron helmet\",862:\"iron chestplate\",863:\"iron leggings\",864:\"iron boots\",865:\"diamond helmet\",866:\"diamond chestplate\",867:\"diamond leggings\",868:\"diamond boots\",869:\"golden helmet\",870:\"golden chestplate\",871:\"golden leggings\",872:\"golden boots\",873:\"netherite helmet\",874:\"netherite chestplate\",875:\"netherite leggings\",876:\"netherite boots\",877:\"flint\",878:\"porkchop\",879:\"cooked porkchop\",880:\"painting\",881:\"golden apple\",882:\"enchanted golden apple\",883:\"oak sign\",884:\"spruce sign\",885:\"birch sign\",886:\"jungle sign\",887:\"acacia sign\",888:\"cherry sign\",889:\"dark oak sign\",890:\"mangrove sign\",891:\"bamboo sign\",892:\"crimson sign\",893:\"warped sign\",894:\"oak hanging sign\",895:\"spruce hanging sign\",896:\"birch hanging sign\",897:\"jungle hanging sign\",898:\"acacia hanging sign\",899:\"cherry hanging sign\",900:\"dark oak hanging sign\",901:\"mangrove hanging sign\",902:\"bamboo hanging sign\",903:\"crimson hanging sign\",904:\"warped hanging sign\",905:\"bucket\",906:\"water bucket\",907:\"lava bucket\",908:\"powder snow bucket\",909:\"snowball\",910:\"leather\",911:\"milk bucket\",912:\"pufferfish bucket\",913:\"salmon bucket\",914:\"cod bucket\",915:\"tropical fish bucket\",916:\"axolotl bucket\",917:\"tadpole bucket\",918:\"brick\",919:\"clay ball\",920:\"dried kelp block\",921:\"paper\",922:\"book\",923:\"slime ball\",924:\"egg\",925:\"compass\",926:\"recovery compass\",927:\"bundle\",928:\"fishing rod\",929:\"clock\",930:\"spyglass\",931:\"glowstone dust\",932:\"cod\",933:\"salmon\",934:\"tropical fish\",935:\"pufferfish\",936:\"cooked cod\",937:\"cooked salmon\",938:\"ink sac\",939:\"glow ink sac\",940:\"cocoa beans\",941:\"white dye\",942:\"orange dye\",943:\"magenta dye\",944:\"light blue dye\",945:\"yellow dye\",946:\"lime dye\",947:\"pink dye\",948:\"gray dye\",949:\"light gray dye\",950:\"cyan dye\",951:\"purple dye\",952:\"blue dye\",953:\"brown dye\",954:\"green dye\",955:\"red dye\",956:\"black dye\",957:\"bone meal\",958:\"bone\",959:\"sugar\",960:\"cake\",961:\"white bed\",962:\"orange bed\",963:\"magenta bed\",964:\"light blue bed\",965:\"yellow bed\",966:\"lime bed\",967:\"pink bed\",968:\"gray bed\",969:\"light gray bed\",970:\"cyan bed\",971:\"purple bed\",972:\"blue bed\",973:\"brown bed\",974:\"green bed\",975:\"red bed\",976:\"black bed\",977:\"cookie\",978:\"crafter\",979:\"filled map\",980:\"shears\",981:\"melon slice\",982:\"dried kelp\",983:\"pumpkin seeds\",984:\"melon seeds\",985:\"beef\",986:\"cooked beef\",987:\"chicken\",988:\"cooked chicken\",989:\"rotten flesh\",990:\"ender pearl\",991:\"blaze rod\",992:\"ghast tear\",993:\"gold nugget\",994:\"nether wart\",995:\"potion\",996:\"glass bottle\",997:\"spider eye\",998:\"fermented spider eye\",999:\"blaze powder\",1000:\"magma cream\",1001:\"brewing stand\",1002:\"cauldron\",1003:\"ender eye\",1004:\"glistering melon slice\",1005:\"allay spawn egg\",1006:\"axolotl spawn egg\",1007:\"bat spawn egg\",1008:\"bee spawn egg\",1009:\"blaze spawn egg\",1010:\"breeze spawn egg\",1011:\"cat spawn egg\",1012:\"camel spawn egg\",1013:\"cave spider spawn egg\",1014:\"chicken spawn egg\",1015:\"cod spawn egg\",1016:\"cow spawn egg\",1017:\"creeper spawn egg\",1018:\"dolphin spawn egg\",1019:\"donkey spawn egg\",1020:\"drowned spawn egg\",1021:\"elder guardian spawn egg\",1022:\"ender dragon spawn egg\",1023:\"enderman spawn egg\",1024:\"endermite spawn egg\",1025:\"evoker spawn egg\",1026:\"fox spawn egg\",1027:\"frog spawn egg\",1028:\"ghast spawn egg\",1029:\"glow squid spawn egg\",1030:\"goat spawn egg\",1031:\"guardian spawn egg\",1032:\"hoglin spawn egg\",1033:\"horse spawn egg\",1034:\"husk spawn egg\",1035:\"iron golem spawn egg\",1036:\"llama spawn egg\",1037:\"magma cube spawn egg\",1038:\"mooshroom spawn egg\",1039:\"mule spawn egg\",1040:\"ocelot spawn egg\",1041:\"panda spawn egg\",1042:\"parrot spawn egg\",1043:\"phantom spawn egg\",1044:\"pig spawn egg\",1045:\"piglin spawn egg\",1046:\"piglin brute spawn egg\",1047:\"pillager spawn egg\",1048:\"polar bear spawn egg\",1049:\"pufferfish spawn egg\",1050:\"rabbit spawn egg\",1051:\"ravager spawn egg\",1052:\"salmon spawn egg\",1053:\"sheep spawn egg\",1054:\"shulker spawn egg\",1055:\"silverfish spawn egg\",1056:\"skeleton spawn egg\",1057:\"skeleton horse spawn egg\",1058:\"slime spawn egg\",1059:\"sniffer spawn egg\",1060:\"snow golem spawn egg\",1061:\"spider spawn egg\",1062:\"squid spawn egg\",1063:\"stray spawn egg\",1064:\"strider spawn egg\",1065:\"tadpole spawn egg\",1066:\"trader llama spawn egg\",1067:\"tropical fish spawn egg\",1068:\"turtle spawn egg\",1069:\"vex spawn egg\",1070:\"villager spawn egg\",1071:\"vindicator spawn egg\",1072:\"wandering trader spawn egg\",1073:\"warden spawn egg\",1074:\"witch spawn egg\",1075:\"wither spawn egg\",1076:\"wither skeleton spawn egg\",1077:\"wolf spawn egg\",1078:\"zoglin spawn egg\",1079:\"zombie spawn egg\",1080:\"zombie horse spawn egg\",1081:\"zombie villager spawn egg\",1082:\"zombified piglin spawn egg\",1083:\"experience bottle\",1084:\"fire charge\",1085:\"writable book\",1086:\"written book\",1087:\"item frame\",1088:\"glow item frame\",1089:\"flower pot\",1090:\"carrot\",1091:\"potato\",1092:\"baked potato\",1093:\"poisonous potato\",1094:\"map\",1095:\"golden carrot\",1096:\"skeleton skull\",1097:\"wither skeleton skull\",1098:\"player head\",1099:\"zombie head\",1100:\"creeper head\",1101:\"dragon head\",1102:\"piglin head\",1103:\"nether star\",1104:\"pumpkin pie\",1105:\"firework rocket\",1106:\"firework star\",1107:\"enchanted book\",1108:\"nether brick\",1109:\"prismarine shard\",1110:\"prismarine crystals\",1111:\"rabbit\",1112:\"cooked rabbit\",1113:\"rabbit stew\",1114:\"rabbit foot\",1115:\"rabbit hide\",1116:\"armor stand\",1117:\"iron horse armor\",1118:\"golden horse armor\",1119:\"diamond horse armor\",1120:\"leather horse armor\",1121:\"lead\",1122:\"name tag\",1123:\"command block minecart\",1124:\"mutton\",1125:\"cooked mutton\",1126:\"white banner\",1127:\"orange banner\",1128:\"magenta banner\",1129:\"light blue banner\",1130:\"yellow banner\",1131:\"lime banner\",1132:\"pink banner\",1133:\"gray banner\",1134:\"light gray banner\",1135:\"cyan banner\",1136:\"purple banner\",1137:\"blue banner\",1138:\"brown banner\",1139:\"green banner\",1140:\"red banner\",1141:\"black banner\",1142:\"end crystal\",1143:\"chorus fruit\",1144:\"popped chorus fruit\",1145:\"torchflower seeds\",1146:\"pitcher pod\",1147:\"beetroot\",1148:\"beetroot seeds\",1149:\"beetroot soup\",1150:\"dragon breath\",1151:\"splash potion\",1152:\"spectral arrow\",1153:\"tipped arrow\",1154:\"lingering potion\",1155:\"shield\",1156:\"totem of undying\",1157:\"shulker shell\",1158:\"iron nugget\",1159:\"knowledge book\",1160:\"debug stick\",1161:\"music disc 13\",1162:\"music disc cat\",1163:\"music disc blocks\",1164:\"music disc chirp\",1165:\"music disc far\",1166:\"music disc mall\",1167:\"music disc mellohi\",1168:\"music disc stal\",1169:\"music disc strad\",1170:\"music disc ward\",1171:\"music disc 11\",1172:\"music disc wait\",1173:\"music disc otherside\",1174:\"music disc relic\",1175:\"music disc 5\",1176:\"music disc pigstep\",1177:\"disc fragment 5\",1178:\"trident\",1179:\"phantom membrane\",1180:\"nautilus shell\",1181:\"heart of the sea\",1182:\"crossbow\",1183:\"suspicious stew\",1184:\"loom\",1185:\"flower banner pattern\",1186:\"creeper banner pattern\",1187:\"skull banner pattern\",1188:\"mojang banner pattern\",1189:\"globe banner pattern\",1190:\"piglin banner pattern\",1191:\"goat horn\",1192:\"composter\",1193:\"barrel\",1194:\"smoker\",1195:\"blast furnace\",1196:\"cartography table\",1197:\"fletching table\",1198:\"grindstone\",1199:\"smithing table\",1200:\"stonecutter\",1201:\"bell\",1202:\"lantern\",1203:\"soul lantern\",1204:\"sweet berries\",1205:\"glow berries\",1206:\"campfire\",1207:\"soul campfire\",1208:\"shroomlight\",1209:\"honeycomb\",1210:\"bee nest\",1211:\"beehive\",1212:\"honey bottle\",1213:\"honeycomb block\",1214:\"lodestone\",1215:\"crying obsidian\",1216:\"blackstone\",1217:\"blackstone slab\",1218:\"blackstone stairs\",1219:\"gilded blackstone\",1220:\"polished blackstone\",1221:\"polished blackstone slab\",1222:\"polished blackstone stairs\",1223:\"chiseled polished blackstone\",1224:\"polished blackstone bricks\",1225:\"polished blackstone brick slab\",1226:\"polished blackstone brick stairs\",1227:\"cracked polished blackstone bricks\",1228:\"respawn anchor\",1229:\"candle\",1230:\"white candle\",1231:\"orange candle\",1232:\"magenta candle\",1233:\"light blue candle\",1234:\"yellow candle\",1235:\"lime candle\",1236:\"pink candle\",1237:\"gray candle\",1238:\"light gray candle\",1239:\"cyan candle\",1240:\"purple candle\",1241:\"blue candle\",1242:\"brown candle\",1243:\"green candle\",1244:\"red candle\",1245:\"black candle\",1246:\"small amethyst bud\",1247:\"medium amethyst bud\",1248:\"large amethyst bud\",1249:\"amethyst cluster\",1250:\"pointed dripstone\",1251:\"ochre froglight\",1252:\"verdant froglight\",1253:\"pearlescent froglight\",1254:\"frogspawn\",1255:\"echo shard\",1256:\"brush\",1257:\"netherite upgrade smithing template\",1258:\"sentry armor trim smithing template\",1259:\"dune armor trim smithing template\",1260:\"coast armor trim smithing template\",1261:\"wild armor trim smithing template\",1262:\"ward armor trim smithing template\",1263:\"eye armor trim smithing template\",1264:\"vex armor trim smithing template\",1265:\"tide armor trim smithing template\",1266:\"snout armor trim smithing template\",1267:\"rib armor trim smithing template\",1268:\"spire armor trim smithing template\",1269:\"wayfinder armor trim smithing template\",1270:\"shaper armor trim smithing template\",1271:\"silence armor trim smithing template\",1272:\"raiser armor trim smithing template\",1273:\"host armor trim smithing template\",1274:\"angler pottery sherd\",1275:\"archer pottery sherd\",1276:\"arms up pottery sherd\",1277:\"blade pottery sherd\",1278:\"brewer pottery sherd\",1279:\"burn pottery sherd\",1280:\"danger pottery sherd\",1281:\"explorer pottery sherd\",1282:\"friend pottery sherd\",1283:\"heart pottery sherd\",1284:\"heartbreak pottery sherd\",1285:\"howl pottery sherd\",1286:\"miner pottery sherd\",1287:\"mourner pottery sherd\",1288:\"plenty pottery sherd\",1289:\"prize pottery sherd\",1290:\"sheaf pottery sherd\",1291:\"shelter pottery sherd\",1292:\"skull pottery sherd\",1293:\"snort pottery sherd\",1294:\"copper grate\",1295:\"exposed copper grate\",1296:\"weathered copper grate\",1297:\"oxidized copper grate\",1298:\"waxed copper grate\",1299:\"waxed exposed copper grate\",1300:\"waxed weathered copper grate\",1301:\"waxed oxidized copper grate\",1302:\"copper bulb\",1303:\"exposed copper bulb\",1304:\"weathered copper bulb\",1305:\"oxidized copper bulb\",1306:\"waxed copper bulb\",1307:\"waxed exposed copper bulb\",1308:\"waxed weathered copper bulb\",1309:\"waxed oxidized copper bulb\",1310:\"trial spawner\",1311:\"trial key\"};\n(function () {\n  var ST = null, inflight = false\n  var carry = { id: 0, count: 0, name: \"\" }   // server truth for the cursor stack\n  var drag = null, lastClick = { slot: -2, t: 0, button: -1 }\n  var hovered = -1\n  function $(id) { return document.getElementById(id) }\n  function esc(s) { return String(s == null ? \"\" : s).replace(/[&<>\"]/g, function (c) { return { \"&\": \"&amp;\", \"<\": \"&lt;\", \">\": \"&gt;\", \"\\\"\": \"&quot;\" }[c] }) }\n  function nm(it) { if (!it) return \"\"; return it.name ? it.name : (NAMES[it.id] || (\"item \" + it.id)) }\n  function label(it) { if (!it) return \"\\u2014\"; return nm(it) + (it.count > 1 ? (\" x\" + it.count) : \"\") }\n  function curSlots() { if (!ST) return []; return ST.gui ? ST.gui.slots : ST.inv }\n  function itemAt(i) { var s = curSlots(); return (i >= 0 && i < s.length) ? s[i] : null }\n  function winId() { return (ST && ST.gui) ? ST.gui.id : 0 }\n  function isEmptySlot(i) { return !itemAt(i) }\n\n  /* ---- wire ---- */\n  function send(list) {\n    if (inflight) return Promise.resolve(null)\n    inflight = true\n    var body = list.length === 1\n      ? { windowId: winId(), slot: list[0].slot, button: list[0].button, mode: list[0].mode }\n      : { windowId: winId(), clicks: list }\n    var url = list.length === 1 ? \"/api/click\" : \"/api/click_batch\"\n    return fetch(url, { method: \"POST\", headers: { \"content-type\": \"application/json\" }, body: JSON.stringify(body) })\n      .then(function (r) { return r.json() })\n      .then(function (j) { if (j && j.error) console.warn(\"click:\", j.error); return j })\n      .catch(function (e) { console.warn(e) })\n      .then(function (j) { inflight = false; setTimeout(refresh, 60); return j })\n  }\n  function click(slot, button, mode) { return send([{ slot: slot, button: button, mode: mode }]) }\n\n  /* ---- vanilla AbstractContainerScreen press/release ---- */\n  var pressInfo = null\n  function press(slot, button, shift) {\n    if (!ST || !ST.connected) return\n    if (button !== 0 && button !== 1) return\n    pressInfo = { slot: slot, t: Date.now(), button: button }\n    var held = carry.count > 0\n    if (!held) {\n      // empty cursor: the packet goes out on PRESS (vanilla does the same)\n      if (shift) {\n        if (slot >= 0) click(slot, button, 1)          // QUICK_MOVE\n      } else if (slot === -999) {\n        click(-999, button, 4)                          // THROW (no-op with an empty cursor)\n      } else {\n        click(slot, button, 0)                          // PICKUP\n      }\n      return\n    }\n    // carrying something: only open a drag \u2014 no packet until release.\n    // The slots under the pointer are collected by mouse moves (vanilla does the\n    // same in mouseDragged), so a motionless press+release stays a plain click.\n    drag = { button: button, type: button === 0 ? 0 : 1, slots: [] }\n  }\n  function addDragSlot(i) {\n    if (!drag || i < 0) return\n    if (drag.slots.indexOf(i) >= 0) return\n    var it = itemAt(i)\n    var fits = !it || (it.id === carry.id && nm(it) === carry.name)\n    var enough = carry.count > drag.slots.length\n    if (!fits || !enough) return\n    drag.slots.push(i)\n    var el = document.querySelector('[data-slot=\"' + i + '\"]')\n    if (el) el.classList.add(\"drag\")\n  }\n  function release(slot, button, shift) {\n    if (!ST || !ST.connected) return\n    var d = drag\n    drag = null\n    var now = Date.now()\n    var cp = pressInfo\n    pressInfo = null\n    // double click = this press repeats the PREVIOUS one on the same slot, same\n    // button, within 250 ms, and the clicked slot is empty (canTakeItemForPickAll)\n    var dbl = cp && slot >= 0 && carry.count > 0 && isEmptySlot(slot) &&\n      slot === lastClick.slot && lastClick.button === button && (now - lastClick.t) < 250\n    if (cp) lastClick = { slot: cp.slot, t: cp.t, button: cp.button }\n    if (dbl) {\n      if (shift) {\n        // vanilla: shift-double-click quick-moves every matching stack\n        var jobs = [], s = curSlots()\n        for (var i = 0; i < s.length; i++) {\n          if (s[i] && s[i].id === carry.id && nm(s[i]) === carry.name) jobs.push({ slot: i, button: 0, mode: 1 })\n        }\n        if (jobs.length) send(jobs)\n      } else {\n        click(slot, button, 6)   // PICKUP_ALL\n      }\n      return\n    }\n    if (d) {\n      if (button !== d.button) return               // button mismatch aborts the drag\n      if (d.slots.length > 0) {\n        var t = d.type, pk = [{ slot: -999, button: (t << 2) | 0, mode: 5 }]\n        for (var k = 0; k < d.slots.length; k++) pk.push({ slot: d.slots[k], button: (t << 2) | 1, mode: 5 })\n        pk.push({ slot: -999, button: (t << 2) | 2, mode: 5 })\n        send(pk)                                     // START + slots + END, one tick\n        return\n      }\n    }\n    if (carry.count > 0) {\n      // carried but no painting happened: a plain click, acted on release\n      if (shift) click(slot, button, 1)\n      else if (slot === -999) click(-999, button, 0)\n      else click(slot, button, 0)\n    }\n  }\n\n  /* ---- rows: vanilla slot arrangement ---- */\n  function range(S, a, b) { var out = []; for (var i = a; i < b; i++) out.push({ i: i, it: S[i] || null }); return out }\n  function rowsFor(st) {\n    var rows = []\n    if (st.gui) {\n      var g = st.gui, S = g.slots, lay = g.lay || {}, c = (lay.container == null ? Math.max(0, S.length - 36) : lay.container)\n      if (g.type === 12) { // crafting table: result + 3x3 grid\n        rows.push({ group: 1, cols: 1, items: range(S, 0, 1), result: true })\n        rows.push({ group: 1, cols: 3, items: range(S, 1, 10) })\n      } else if (c > 0 && c <= 9) {\n        rows.push({ group: 1, cols: c, items: range(S, 0, c) })\n      } else {\n        for (var i = 0; i < c; i += 9) rows.push({ group: 1, cols: 9, items: range(S, i, Math.min(i + 9, c)) })\n      }\n      rows.push({ group: 2, cols: 9, items: range(S, c, Math.min(c + 27, S.length)) })\n      rows.push({ group: 2, cols: 9, items: range(S, c + 27, Math.min(c + 36, S.length)) })\n    } else {\n      var I = st.inv || []\n      rows.push({ group: 1, cols: 2, items: range(I, 1, 5) })\n      rows.push({ group: 1, cols: 1, items: range(I, 0, 1), result: true })\n      rows.push({ group: 3, cols: 4, items: range(I, 5, 9) })\n      rows.push({ group: 3, cols: 1, items: range(I, 45, 46) })\n      rows.push({ group: 2, cols: 9, items: range(I, 9, 36) })\n      rows.push({ group: 2, cols: 9, items: range(I, 36, 45) })\n    }\n    return rows\n  }\n  function slotEl(idx, it) {\n    var d = document.createElement(\"div\")\n    d.className = \"slot\" + (it ? \"\" : \" empty\") + (idx < 0 ? \" result\" : \"\")\n    d.setAttribute(\"data-slot\", String(idx))\n    d.title = (it ? label(it) : \"empty\") + \"  [slot \" + idx + \"]\"\n    if (it) {\n      var n = document.createElement(\"div\"); n.className = \"n\"; n.textContent = nm(it); d.appendChild(n)\n      if (it.count > 1) { var c = document.createElement(\"div\"); c.className = \"c\"; c.textContent = it.count; d.appendChild(c) }\n    }\n    d.addEventListener(\"mouseenter\", function () { hovered = idx; addDragSlot(idx) })\n    d.addEventListener(\"mousedown\", function (e) {\n      e.preventDefault(); e.stopPropagation()\n      hovered = idx\n      press(idx, e.button === 2 ? 1 : (e.button === 0 ? 0 : 9), e.shiftKey)\n    })\n    d.addEventListener(\"mouseup\", function (e) {\n      e.preventDefault(); e.stopPropagation()\n      if (e.button === 2 || e.button === 0) release(idx, e.button === 2 ? 1 : 0, e.shiftKey)\n    })\n    d.addEventListener(\"contextmenu\", function (e) { e.preventDefault() })\n    return d\n  }\n  function gridEl(row) {\n    var g = document.createElement(\"div\")\n    g.className = \"grid\"\n    g.style.gridTemplateColumns = \"repeat(\" + row.cols + \",42px)\"\n    for (var i = 0; i < row.items.length; i++) g.appendChild(slotEl(row.items[i].i, row.items[i].it))\n    return g\n  }\n  function render(st) {\n    ST = st\n    carry = { id: st.cursorRaw ? st.cursorRaw.id : (st.cursor ? st.cursor.id : 0), count: st.cursorRaw ? st.cursorRaw.count : (st.cursor ? st.cursor.count : 0), name: st.cursor ? nm(st.cursor) : \"\" }\n    var h = '<span class=\"chip ' + (st.connected ? \"on\" : \"warn\") + '\">' + (st.connected ? \"connected\" : \"offline\") + \"</span>\"\n    h += '<span class=\"chip\">anti-afk ' + (st.antiAfk ? \"on\" : \"off\") + \"</span>\"\n    if (st.stand) h += '<span class=\"chip on\">on AFK pad</span>'\n    if (st.player) h += '<span class=\"chip\">xyz ' + st.player.x + \" \" + st.player.y + \" \" + st.player.z + \"</span>\"\n    h += '<span class=\"chip\">carried: ' + esc(st.cursor ? label(st.cursor) : \"\\u2014\") + \"</span>\"\n    $(\"status\").innerHTML = h\n    var box = $(\"box\"); box.innerHTML = \"\"\n    var cb = $(\"closeBtn\")\n    if (st.gui) { cb.style.display = \"\"; var t = document.createElement(\"div\"); t.className = \"title\"; t.textContent = (st.gui.title || st.gui.menu) + \"  (window \" + st.gui.id + \" \\u00b7 \" + st.gui.menu + \")\"; box.appendChild(t) }\n    else cb.style.display = \"none\"\n    var rows = rowsFor(st), line = null, group = null\n    for (var i = 0; i < rows.length; i++) {\n      var r = rows[i]\n      if (r.group !== group) { group = r.group; line = document.createElement(\"div\"); line.className = \"line\"; box.appendChild(line) }\n      var col = document.createElement(\"div\"); col.className = \"col\"\n      if (r.group === 3) { col.style.marginTop = \"6px\" }\n      col.appendChild(gridEl(r))\n      line.appendChild(col)\n    }\n    // repaint drag highlight after a re-render\n    if (drag) for (var k = 0; k < drag.slots.length; k++) { var e = document.querySelector('[data-slot=\"' + drag.slots[k] + '\"]'); if (e) e.classList.add(\"drag\") }\n    var hv = document.querySelector('[data-slot=\"' + hovered + '\"]'); if (hv) hv.classList.add(\"hot\")\n    paintCarry()\n  }\n  function paintCarry() {\n    var c = $(\"carry\")\n    if (!carry.count) { c.style.display = \"none\"; return }\n    c.textContent = carry.name + (carry.count > 1 ? (\" x\" + carry.count) : \"\")\n  }\n  document.addEventListener(\"mousemove\", function (e) {\n    var c = $(\"carry\")\n    if (carry.count) { c.style.display = \"block\"; c.style.left = (e.clientX + 12) + \"px\"; c.style.top = (e.clientY + 10) + \"px\" }\n    // while painting, every slot the pointer passes over (the pressed one included) joins the drag\n    if (drag && e.target && e.target.closest) {\n      var el = e.target.closest(\".slot\")\n      if (el) addDragSlot(parseInt(el.getAttribute(\"data-slot\"), 10))\n    }\n  })\n  // clicks that are not on a slot = outside the menu (vanilla slot -999)\n  $(\"panel\").addEventListener(\"mousedown\", function (e) {\n    if (e.target.closest(\".slot\")) return\n    e.preventDefault(); press(-999, e.button === 2 ? 1 : 0, e.shiftKey)\n  })\n  $(\"panel\").addEventListener(\"mouseup\", function (e) {\n    if (e.target.closest(\".slot\")) return\n    e.preventDefault(); release(-999, e.button === 2 ? 1 : 0, e.shiftKey)\n  })\n  $(\"panel\").addEventListener(\"contextmenu\", function (e) { e.preventDefault() })\n  document.addEventListener(\"mouseup\", function (e) { if (drag && !e.target.closest(\".slot\") && !e.target.closest(\"#panel\")) release(-999, e.button === 2 ? 1 : 0, e.shiftKey) })\n  // keyboard: Q drop, digits swap, F offhand \u2014 all act on the hovered slot\n  document.addEventListener(\"keydown\", function (e) {\n    if (!ST || !ST.connected || hovered < 0) return\n    var k = e.key\n    if (k === \"q\" || k === \"Q\") { e.preventDefault(); click(hovered, e.shiftKey ? 1 : 0, 4); return }\n    if (k === \"f\" || k === \"F\") { e.preventDefault(); if (carry.count === 0) click(hovered, 40, 2); return }\n    if (/^[1-9]$/.test(k)) { e.preventDefault(); if (carry.count === 0) click(hovered, parseInt(k, 10) - 1, 2) }\n  })\n  $(\"closeBtn\").onclick = function () {\n    fetch(\"/api/close\", { method: \"POST\", headers: { \"content-type\": \"application/json\" }, body: \"{}\" }).then(refresh).catch(function () {})\n  }\n  function refresh() {\n    fetch(\"/api/state\").then(function (r) { return r.json() }).then(render)\n      .catch(function () { $(\"status\").textContent = \"bot offline\" })\n  }\n  refresh()\n  setInterval(refresh, 1000)\n})()\n</script></body></html>"
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req, cb) => {
    let b = ''
    req.on('data', c => { b += c; if (b.length > 65536) req.destroy() })
    req.on('end', () => cb(b))
    req.on('error', () => cb(null))
  }
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }); res.end(); return }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' })
        res.end(PAGE_FILE || PAGE); return
      }
      if (req.method === 'GET' && url.pathname === '/api/state') { sendJson(res, 200, WEB_STATE()); return }
      // --- local item textures (extracted from the 1.20.4 client assets) ---
      if (req.method === 'GET' && url.pathname.startsWith('/tex/')) {
        const rel = decodeURIComponent(url.pathname.slice(5)).replace(/\\/g, '/')
        if (!/^(item|block|entity)\/[a-z0-9_/.-]+\.png$/i.test(rel) || rel.includes('..')) { res.writeHead(403); res.end(); return }
        const file = path.join(__dirname, 'textures', rel)
        const send = (res2, buf, tag) => {
          res2.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800', 'x-tex-src': tag, 'access-control-allow-origin': '*' })
          res2.end(buf)
        }
        fs.readFile(file, (err, buf) => {
          if (!err) return send(res, buf, 'local')
          if (!texWanted.has(rel)) { texWanted.add(rel); log(`tex: ${rel} not on disk — asking the mirror`) }
          fetchTexFromMirror(rel).then(got => {
            if (!got) { res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end(); return }
            try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, got) } catch {}
            send(res, got, 'mirror')
          }).catch(() => { res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end() })
        })
        return
      }
      // --- chat: read the ring buffer / send a line ---
      if (req.method === 'GET' && url.pathname === '/api/build') {
        let tn = 0
        try { tn = fs.readdirSync(path.join(__dirname, 'textures', 'item')).length } catch {}
        sendJson(res, 200, { build: BUILD, itemIds: Object.keys(ITEM_NAMES).length, localTextures: tn })
        return
      }
      if (req.method === 'GET' && url.pathname === '/captcha.png') {
        try {
          const png = fs.readFileSync(path.join(process.cwd(), 'captcha-map.png'))
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
          res.end(png)
        } catch { sendJson(res, 404, { ok: false, error: 'no captcha picture yet' }) }
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/chat') {
        sendJson(res, 200, webChatSince(url.searchParams.get('since')))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        readBody(req, (raw) => {
          let body = {}
          try { body = JSON.parse(raw || '{}') } catch {}
          const text = String((body && body.text) || '').trim()
          if (!text) return sendJson(res, 400, { ok: false, error: 'empty message' })
          if (text.length > 256) return sendJson(res, 400, { ok: false, error: 'message too long' })
          try {
            WEB_CHAT(text)
            // plain chat is echoed back by the server; echoing here too showed it twice.
            // Commands are not echoed, so those are shown locally.
            if (text.startsWith('/')) pushWebChat('me', text)
            sendJson(res, 200, { ok: true })
          } catch (e) { sendJson(res, 500, { ok: false, error: e.message }) }
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/use_block') {
        readBody(req, (b) => {
          let out
          try { out = WEB_USE_BLOCK(JSON.parse(b || '{}')) } catch (e) { sendJson(res, 400, { error: e.message }); return }
          sendJson(res, 200, out)
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/held') {
        readBody(req, (b) => {
          let out
          try { out = WEB_HELD(JSON.parse(b || '{}')) } catch (e) { sendJson(res, 400, { error: e.message }); return }
          sendJson(res, 200, out)
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/creative') {
        readBody(req, (b) => {
          let out
          try { out = WEB_CREATIVE(JSON.parse(b || '{}')) } catch (e) { sendJson(res, 400, { error: e.message }); return }
          sendJson(res, 200, out)
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/click_batch') {
        readBody(req, (b) => {
          let out
          try { out = WEB_CLICK_BATCH(JSON.parse(b || '{}')) } catch (e) { sendJson(res, 400, { error: e.message }); return }
          sendJson(res, 200, out)
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/click') {
        readBody(req, (b) => {
          let out
          try { out = WEB_CLICK(JSON.parse(b || '{}')) } catch (e) { sendJson(res, 400, { error: e.message }); return }
          sendJson(res, 200, out)
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/use') {
        readBody(req, (raw) => {
          let body = {}
          try { body = JSON.parse(raw || '{}') } catch {}
          try { sendJson(res, 200, WEB_USE(body)) } catch (e) { sendJson(res, 400, { ok: false, error: e.message }) }
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/close') {
        readBody(req, () => {
          let out
          try { out = WEB_CLOSE() } catch (e) { sendJson(res, 400, { error: e.message }); return }
          sendJson(res, 200, out)
        })
        return
      }
      res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end('not found')
    } catch (e) {
      try { res.writeHead(500); res.end('error') } catch {}
    }
  })
  server.on('error', e => log(`web console: ${e.message}`))
  // make it obvious if the art is missing: the UI then leans on the public mirror
  let texN = 0
  try { texN = fs.readdirSync(path.join(__dirname, 'textures', 'item')).length } catch {}
  let itemN = 0
  try { itemN = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, 'items1204.json'), 'utf8'))).length } catch {}
  log(`build ${BUILD} — item registry ${itemN} ids, ${texN} local item textures${texN ? '' : ' (icons will be pulled from the public mirror)'}`)
  if (!texN) log('web console: textures/ not found — icon requests are proxied to the public mirror instead')
  server.listen(cfg.webPort, '0.0.0.0', () => log(`web console: http://0.0.0.0:${cfg.webPort}/ — inventory & GUI view/click${texN ? ` (${texN} item textures)` : ''}`))
}

async function main () {
  // One bad packet path must never take the process down: every session already
  // has its own reconnect loop, so log and keep going instead of exiting.
  let errN = 0
  const softFail = (what, e) => {
    errN++
    const msg = (e && (e.stack || e.message)) || String(e)
    log(`!! ${what}: ${msg.split('\n').slice(0, 3).join(' | ')} — continuing`)
    if (errN === 25) log('!! 25 soft errors this run — something is systematically wrong, check the log above')
  }
  process.on('uncaughtException', e => softFail('uncaught exception', e))
  process.on('unhandledRejection', e => softFail('unhandled rejection', e))

  log(`player: ${cfg.playerName}  server: ${cfg.serverIp}:${cfg.serverPort}`)
  log(`auth: ${cfg.auth ? 'on (login/register automatic)' : 'off'}  cmd delay: ${cfg.delayMs}ms  queue: ${cfg.cmds.length ? cfg.cmds.join(', ') : '(empty)'}`)
  let regN = 0
  try { regN = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, 'items1204.json'), 'utf8'))).length } catch {}
  log(`build ${BUILD} — item registry ${regN} ids${fs.existsSync(path.join(__dirname, 'textures')) ? ', local textures' : ''}`)
  log('vanilla-node: full protocol client — no java, no window')

  startTerminal()
  if (cfg.web) startWebConsole()
  else if (ENV.PORT) startHealthPort(cfg.webPort)   // hosted: keep the port open, UI stays off
  else log('web console: off (WEB=off) — no port bound; set WEB=on in .env to turn it back on')

  let streak = 0
  while (true) {
    if (banUntil && banUntil > Date.now()) {
      const waitMs = banUntil - Date.now() + 2000
      log(`banned until ${new Date(banUntil).toLocaleTimeString()} — sleeping ${Math.round(waitMs / 60000)} min instead of hammering the server`)
      await sleep(waitMs)
      banUntil = 0
      streak = 0
    }
    let reason
    try {
      reason = await runSession()
    } catch (e) {
      log(`session error: ${e.message}`)
      reason = 'restart'
    }
    if (/^(on|true|yes|1)$/i.test(ENV.SINGLE_SESSION || '')) { log(`single-session test finished: ${reason} — not reconnecting`); process.exit(0) }
    streak = reason === 'rejoin' ? 0 : streak + 1
    if (reason === 'banned') {
      const waitMs = Math.max(30000, (banUntil || 0) - Date.now())
      log(`session (banned) — waiting ${Math.round(waitMs / 60000)} min, then reconnecting`)
      await sleep(waitMs)
      banUntil = 0
      streak = 0
      continue
    }
    const base = reason === 'rejoin' ? 3000
      : reason === 'blocked-cooldown' ? 45000
        : reason === 'verify-cooldown' ? 15000
          : reason === 'arena-reset' ? (22000 + Math.floor(Math.random() * 10000))
            : reason === 'restart' ? 10000
              : reason === 'timeout' ? 5000 : 3000
    const penalty = streak >= 5 ? Math.min(10000 * (streak - 4), 30000) : 0
    log(`session (${reason}) — reconnecting in ${(base + penalty) / 1000}s${streak >= 4 ? ' (repeated failures — cooling down)' : ''}`)
    await sleep(base + penalty)
  }
}

/* ---------------- terminal ---------------- */
function startTerminal () {
  if (!process.stdin.isTTY) {
    log('no interactive terminal attached — running queue only')
    return
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
  console.log('[bot] terminal ready — type a chat message or /command, :help for help')
  rl.prompt()
  rl.on('line', line => {
    const s = line.trim()
    if (!s) { rl.prompt(); return }
    if (s === ':help' || s === ':h') {
      console.log('  <anything>   sent to the game chat as-is (colors ok: &a&l ...)')
      console.log('  /lifesteal    example game command — same for any /command')
      console.log('  :queue        queue status')
      console.log('  :quit         stop the bot and exit')
    } else if (s === ':queue' || s === ':q') {
      console.log(`  queued: ${queue.size()}, sent total: ${queue.sent}`)
    } else if (s === ':quit' || s === ':exit') {
      rl.close(); process.exit(0)
    } else {
      queue.push(s).catch(() => {})
    }
    rl.prompt()
  })
}

if (require.main === module) {
  process.on('SIGINT', () => { log('bye'); process.exit(0) })
  process.on('SIGTERM', () => { log('bye'); process.exit(0) })
  main().catch(e => { console.error('[bot] fatal:', e); process.exit(1) })
}

module.exports = { encodePacket, decodePacket, flattenComponent, offlineUuid, writeUvarint, readUvarint, MAPS, proto, get SESSION_ACTIONS () { return SESSION_ACTIONS },
  // vanilla menu engine (exported for the offline click test suite)
  doClickSim, predictClick, menuLayout, quickMoveOnce, qmMove, maxStackOf, stClone, stEmpty, sameItem, nbtEq,
  readNbtTagged, writeNbtTagged, ITEM_STACK_MAX, decodeMapPacket, pngFromGrey }
