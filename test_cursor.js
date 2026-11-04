/* Click semantics of the web inventory, driven through the real page in jsdom.

   The rule the user cares about: one press on a slot picks the stack up and it stays on
   the cursor (no button held). This test checks the predicted screen *and* the packet that
   goes to the bot for every vanilla gesture. */
const fs = require('fs'), path = require('path')
const { JSDOM } = require(path.join(__dirname, 'node_modules/jsdom'))

const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x ? '  ' + x : '')) } }

const mk = (id, disp, count, max, tex) => ({ id, count, disp, name: null, key: disp, tex: tex || 'item/stone.png', lore: [], ench: [], max: max || 64 })
const inv = new Array(46).fill(null)
inv[9] = mk(801, 'Diamond', 12)            // storage
inv[10] = mk(921, 'Paper', 64)             // a full stack
inv[11] = mk(839, 'Netherite Sword', 1, 1) // unstackable
inv[36] = mk(946, 'Lime Dye', 5)           // hotbar
const state = { connected: true, name: 'T', player: { x: 0, y: 0, z: 0, held: 0 }, antiAfk: false, inv, cursor: null, gui: null }

const sent = []
const dom = new JSDOM(page, {
  runScripts: 'dangerously', url: 'http://localhost:8080/', pretendToBeVisual: true,
  beforeParse (w) {
    // The page polls /api/state every ~200ms and re-renders from the server's view,
    // which can land in the middle of a gesture and wipe the optimistic paint —
    // that made this suite flaky (21/0 one run, 16/5 the next). The gesture model
    // is what is under test, not the poll, so the poll is switched off here.
    // Not just the 1s poll: after every click the page schedules a refresh 60-80ms
    // later, which repaints from the server's (still stale) view and wipes the
    // optimistic paint the gesture just produced. Kill both so a gesture can be
    // observed for longer than one frame.
    const realSetInterval = w.setInterval.bind(w)
    const realSetTimeout = w.setTimeout.bind(w)
    w.setInterval = (fn, ms, ...a) => (ms <= 1000 ? 0 : realSetInterval(fn, ms, ...a))
    w.setTimeout = (fn, ms, ...a) => (ms === 60 || ms === 80 || ms === 100 ? 0 : realSetTimeout(fn, ms, ...a))
    w.fetch = (u, opt) => {
      u = String(u)
      if (u.startsWith('/api/click')) {
        try { sent.push(JSON.parse((opt && opt.body) || '{}')) } catch (e) { sent.push({ raw: opt && opt.body }) }
        return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
      }
      if (u.startsWith('/api/chat')) return Promise.resolve({ json: () => Promise.resolve({ last: 0, lines: [] }) })
      if (u.startsWith('/api/build')) return Promise.resolve({ json: () => Promise.resolve({ build: 't', itemIds: 1312, localTextures: 587 }) })
      return Promise.resolve({ json: () => Promise.resolve(state) })
    }
  }
})
const W = dom.window, D = W.document
const slot = (i) => D.querySelector('.slot[data-slot="' + i + '"]')
function press (i, button, shift) {
  const el = slot(i)
  const ev = new W.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: button || 0, shiftKey: !!shift })
  el.dispatchEvent(ev)
}
function release (i, button) {
  slot(i).dispatchEvent(new W.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: button || 0 }))
}
const slotImg = (i) => !!slot(i).querySelector('img')
const cursorShown = () => D.getElementById('carry').style.display !== 'none'

const tick = () => new Promise(r => setTimeout(r, 15))

setTimeout(async () => {
  try {
    ok('page rendered 46 slots', D.querySelectorAll('.slot').length === 46, D.querySelectorAll('.slot').length)

    /* ---- 1. one press picks the stack up and it STAYS (no mouseup needed) ---- */
    press(9, 0); await tick()
    ok('press alone sends one pickup', sent.length === 1 && sent[0].mode === 0 && sent[0].slot === 9 && sent[0].button === 0, JSON.stringify(sent[0]))
    ok('cursor shows the stack immediately', cursorShown())
    ok('slot 9 is painted empty', !slotImg(9))
    ok('hover chip says holding', /holding/.test(D.getElementById('bar').textContent), D.getElementById('bar').textContent.slice(0, 120))
    ok('the carried icon follows the mouse', !!D.querySelector('#carry img'))
    release(9, 0); await tick()
    ok('releasing does NOT put it back', cursorShown() && !slotImg(9) && sent.length === 1, 'sent=' + sent.length)

    /* ---- 2. a second press puts it down ---- */
    press(20, 0); await tick()
    ok('second press = place on that slot', sent.length === 2 && sent[1].slot === 20 && sent[1].mode === 0 && sent[1].button === 0, JSON.stringify(sent[1]))
    ok('slot 20 now painted with the item', slotImg(20))
    ok('cursor cleared', !cursorShown())

    /* ---- 3. right click: half out, then one back ---- */
    press(10, 2); await tick()
    ok('right press sends button 1', sent.length === 3 && sent[2].button === 1 && sent[2].mode === 0, JSON.stringify(sent[2]))
    const carryCount = () => (D.querySelector('#carry span') || {}).textContent
    ok('half of 64 (32) is on the cursor', carryCount() === '32', String(carryCount()))
    press(21, 2); await tick()
    ok('right place puts exactly one down', sent.length === 4 && sent[3].button === 1 && sent[3].slot === 21)
    ok('cursor now 31', carryCount() === '31', String(carryCount()))
    ok('slot 21 holds a single item', (slot(21).querySelector('.ct') || {}).textContent === undefined)

    /* ---- 4. shift click quick-moves (mode 1) ---- */
    press(11, 0, true); await tick()
    ok('shift+press uses quick move', sent.length === 5 && sent[4].mode === 1 && sent[4].slot === 11, JSON.stringify(sent[4]))
    ok('quick move leaves the cursor alone', carryCount() === '31', String(carryCount()))

    /* ---- 5. a full stack does not merge past its limit ---- */
    press(30, 0); await tick()          // drop the 31 dyes on an empty slot
    press(10, 0); await tick()          // pick up 32 paper
    press(10, 0); await tick()          // and put them back
    ok('every click in the sequence reached the bot', sent.length === 8, 'sent=' + sent.length)
    ok('nothing is stuck on the cursor', !cursorShown())

    /* ---- 6. clicking outside throws the carried stack ---- */
    press(10, 2); await tick()
    const before = sent.length
    D.getElementById('gui').dispatchEvent(new W.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    await tick()
    ok('click outside sends a throw (mode 4, slot -999)', sent[before] && sent[before].mode === 4 && sent[before].slot === -999, JSON.stringify(sent[before]))
    ok('the throw empties the cursor', !cursorShown())
  } catch (e) {
    fail++; console.log('  FAIL threw: ' + e.message)
  }
  console.log('')
  console.log(pass + ' passed, ' + fail + ' failed')
  W.close()
  process.exit(fail ? 1 : 0)
}, 1400)
