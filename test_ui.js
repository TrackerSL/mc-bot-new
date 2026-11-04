// Front-end (vanilla screen) state-machine test in jsdom with a mocked API.
const { JSDOM } = require('jsdom')
const fs = require('fs')

const page = fs.readFileSync(__dirname + '/page.html', 'utf8')
let reqs = []
let state = null

function mkState (opts = {}) {
  const inv = new Array(46).fill(null)
  inv[9] = { id: 1, count: 64, name: 'stone' }
  inv[10] = { id: 1, count: 20, name: 'stone' }
  if (opts.cursor) state_cursor = opts.cursor
  return {
    connected: true, antiAfk: true, stand: false,
    player: { x: 0, y: 64, z: 0, gameMode: 2, held: 0, sneak: false },
    cursor: opts.cursor || null,
    cursorRaw: { id: opts.cursor ? opts.cursor.id : 0, count: opts.cursor ? opts.cursor.count : 0 },
    inv,
    lay: { key: 'inventory', size: 46, container: 0, hotbar: 36, invStart: 9, invEnd: 46, offhand: 45, result: 0, qm: 'inventory' },
    gui: opts.gui || null
  }
}
let state_cursor = null

const dom = new JSDOM(page, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse (win) {
    let cursor = null
    win.__setCursor = (c) => { cursor = c }
    win.fetch = (url, opt) => {
      if (url === '/api/state') {
        return Promise.resolve({ json: () => Promise.resolve(state || mkState()) })
      }
      // the chat panel polls in the background — it is not a click, don't record it
      if (String(url).startsWith('/api/chat')) {
        return Promise.resolve({ json: () => Promise.resolve({ last: 0, lines: [] }) })
      }
      reqs.push({ url, body: JSON.parse((opt && opt.body) || '{}') })
      return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
    }
  }
})
const win = dom.window
const doc = win.document

let pass = 0, fail = 0
const T = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + JSON.stringify(extra) : '')) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const slot = i => doc.querySelector('[data-slot="' + i + '"]')
function setState (s) { state = s }
const RENDER_WAIT = 1100 // the page polls /api/state once a second
function ev (el, type, opts) { el.dispatchEvent(new win.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, button: 0 }, opts || {}))) }
async function pressRelease (idx, opts = {}) {
  const el = slot(idx)
  ev(el, 'mousedown', opts)
  await sleep(5)
  ev(el, 'mouseup', opts)
  await sleep(60)
}

;(async () => {
  await sleep(120) // initial refresh + render
  T('page rendered slots', !!slot(9) && !!slot(45))
  T('inventory rows rendered', doc.querySelectorAll('.slot').length >= 46, doc.querySelectorAll('.slot').length)

  // --- 1. empty cursor + left press on a filled slot -> immediate PICKUP ---
  reqs = []
  setState(mkState())
  await sleep(RENDER_WAIT)
  await pressRelease(9, { button: 0 })
  T('empty-cursor click sends PICKUP on press', reqs.length === 1 && reqs[0].url === '/api/click' &&
    reqs[0].body.slot === 9 && reqs[0].body.button === 0 && reqs[0].body.mode === 0, reqs)

  // --- 2. right click -> button 1 ---
  reqs = []
  await pressRelease(10, { button: 2 })
  T('right click sends button 1', reqs.length === 1 && reqs[0].body.button === 1 && reqs[0].body.mode === 0, reqs)

  // --- 3. shift+click -> QUICK_MOVE ---
  reqs = []
  await pressRelease(9, { button: 0, shiftKey: true })
  T('shift+click sends QUICK_MOVE', reqs.length === 1 && reqs[0].body.mode === 1, reqs)

  // --- 4. carrying: the press itself places (no release needed) ---
  reqs = []
  setState(mkState({ cursor: { id: 1, count: 32, name: 'stone' } }))
  await sleep(RENDER_WAIT)
  ev(slot(13), 'mousedown', { button: 0 })
  await sleep(20)
  T('carried press places immediately (PICKUP)', reqs.length === 1 && reqs[0].body.slot === 13 && reqs[0].body.mode === 0, reqs)
  ev(slot(13), 'mouseup', { button: 0 })
  await sleep(60)
  T('the release adds nothing', reqs.length === 1, reqs)

  // --- 5. dragging after a press sends nothing extra (one press = one action) ---
  reqs = []
  setState(mkState({ cursor: { id: 1, count: 32, name: 'stone' } }))
  await sleep(RENDER_WAIT)
  ev(slot(20), 'mousedown', { button: 0 })
  ev(slot(20), 'mousemove', {})
  ;[21, 22, 23].forEach(i => ev(slot(i), 'mouseenter', {}))
  ev(slot(23), 'mouseup', { button: 0 })
  await sleep(80)
  T('a press-and-drag is still one click', reqs.length === 1 && reqs[0].body.slot === 20 && reqs[0].body.mode === 0, reqs)

  // --- 6. right press with a stack places exactly one ---
  reqs = []
  setState(mkState({ cursor: { id: 1, count: 32, name: 'stone' } }))
  await sleep(RENDER_WAIT)
  ev(slot(24), 'mousedown', { button: 2 })
  await sleep(40)
  T('right press sends button 1', reqs.length === 1 && reqs[0].body.button === 1 && reqs[0].body.slot === 24, reqs)

  // The page gathers only if the second press lands inside 300ms of the first, so the
  // pair is dispatched back to back instead of through a sleep — a 120ms sleep turns
  // into 400ms on a loaded machine and made this suite flaky.
  reqs = []
  setState(mkState({ cursor: { id: 1, count: 4, name: 'stone' } }))
  await sleep(1700)   // the page hides the server's cursor while its own prediction is live (1500ms)
  ev(slot(10), 'mousedown', { button: 0 })
  ev(slot(10), 'mousedown', { button: 0 })
  await sleep(400)
  T('double-click gathers matching items (PICKUP_ALL)',
    reqs.length === 2 && reqs[0].body.mode === 0 && reqs[1].body.mode === 6 && reqs[1].body.slot === 10, reqs)

  // --- 8b. and two presses on a slot in a row still reach the bot in order ---
  reqs = []
  setState(mkState({ cursor: { id: 1, count: 2, name: 'stone' } }))
  await sleep(1700)
  ev(slot(28), 'mousedown', { button: 0 })
  await sleep(60)
  ev(slot(28), 'mousedown', { button: 0 })
  await sleep(400)
  T('two quick clicks both reach the bot, in order',
    reqs.length === 2 && reqs[0].body.mode === 0 && reqs[0].body.slot === 28 && reqs[1].body.slot === 28, reqs)

  // --- 9. clicking outside the slots throws the carried stack ---
  reqs = []
  setState(mkState({ cursor: { id: 1, count: 4, name: 'stone' } }))
  await sleep(RENDER_WAIT)
  const panel = doc.getElementById('gui')
  ev(panel, 'mousedown', { button: 0 })
  await sleep(60)
  T('outside click throws at -999 (mode 4)', reqs.length === 1 && reqs[0].body.slot === -999 && reqs[0].body.mode === 4, reqs)

  // --- 10. keyboard: Q / shift+Q / digits / F ---
  reqs = []
  setState(mkState())
  await sleep(RENDER_WAIT)
  ev(slot(9), 'mouseenter', {})
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'q', bubbles: true }))
  await sleep(60)
  T('Q sends THROW one', reqs.length === 1 && reqs[0].body.mode === 4 && reqs[0].body.button === 0, reqs)
  reqs = []
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Q', shiftKey: true, bubbles: true }))
  await sleep(60)
  T('shift+Q throws the stack', reqs.length === 1 && reqs[0].body.mode === 4 && reqs[0].body.button === 1, reqs)
  reqs = []
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '3', bubbles: true }))
  await sleep(60)
  T('digit 3 swaps hotbar 2', reqs.length === 1 && reqs[0].body.mode === 2 && reqs[0].body.button === 2, reqs)
  reqs = []
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'f', bubbles: true }))
  await sleep(60)
  T('F swaps the offhand', reqs.length === 1 && reqs[0].body.mode === 2 && reqs[0].body.button === 40, reqs)

  // --- 11. GUI rendering: chest window 27+36 ---
  const slots = new Array(63).fill(null)
  slots[0] = { id: 1, count: 64, name: 'stone' }
  setState(mkState({ gui: { id: 1, type: 2, menu: 'generic_9x3', title: 'Chest', size: 63, stateId: 4, slots, lay: { key: '2', size: 63, container: 27, hotbar: 54, invStart: 27, invEnd: 63, offhand: -1, result: -1, qm: 'chest' } } }))
  await sleep(1100)
  T('chest renders 27 container + 36 player slots', doc.querySelectorAll('.slot').length === 63, doc.querySelectorAll('.slot').length)
  T('close button visible with a GUI', doc.getElementById('closeBtn').style.display === '')
  reqs = []
  await pressRelease(30, { button: 0, shiftKey: true }) // a player main slot inside the chest window
  T('chest shift-click sends QUICK_MOVE with the window id', reqs.length === 1 && reqs[0].body.mode === 1 && reqs[0].body.windowId === 1, reqs)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
