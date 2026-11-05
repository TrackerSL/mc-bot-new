// gate for the map-captcha reader: palette, packet decode, and the live sample
const fs = require('fs')
const M = require('./map_captcha.js')
let pass = 0, fail = 0
const T = (name, ok) => { ok ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name)) }

T('palette has 248 entries', M.PALETTE.length === 248)
T('index 66 is magenta #b24cd8', M.PALETTE[66] === 0xb24cd8)
T('index 78 is lime #7fcc19', M.PALETTE[78] === 0x7fcc19)
T('index 4 is grass #597d27', M.PALETTE[4] === 0x597d27)
T('shade 2 of a family is the base colour', (M.PALETTE[4 + 2] & 0xff) > (M.PALETTE[4] & 0xff))

const sample = '/home/user/real-map.bin'
if (fs.existsSync(sample)) {
  const g = M.decodeMapPacket(fs.readFileSync(sample))
  T('real map decodes to 128x128', g && g.cols === 128 && g.rows === 128)
  T('real map has colour variety', new Set(g.data).size > 40)
  const rgb = M.trueColourRgb(g)
  T('true colour rgb is 3 bytes per pixel', rgb.length === g.data.length * 3)
  const mask = M.brightMask(g)
  const ink = mask.reduce((a, b) => a + b, 0)
  T('brightness separates text from the noise field', ink > 800 && ink < 5000)
  const med = M.median3(mask, g.cols, g.rows)
  T('median pass removes thin decoy strokes', med.reduce((a, b) => a + b, 0) < ink)
  const pieces = M.crops(g)
  T('the text splits into a handful of pieces', pieces.length >= 3 && pieces.length <= 8)
  T('pieces are ordered left to right', pieces.every((p, i) => i === 0 || p.x >= pieces[i - 1].x))
  T('no piece covers the same ground twice', pieces.every((p, i) => pieces.every((q, j) => i === j || Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) <= 0.45 * Math.min(p.w, q.w))))
  const res = M.solve(g)
  T('solve returns text', typeof res.text === 'string' && res.text.length >= 2)
  T('solve returns one entry per glyph', res.chars.length === res.text.length)
  T('every glyph has a finite distance', res.chars.every(c => Number.isFinite(c.d)))
  T('a template bank was loaded', M.classify(new Uint8Array(20 * 20).fill(1), 20, 20).ch.length === 1)
} else {
  console.log('  (skip real-sample checks — /home/user/real-map.bin not present)')
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
