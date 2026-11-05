// score the reader on every labelled sample we have
const fs = require('fs'), path = require('path')
const M = require('./map_captcha.js')
const { pngToGrid } = require('./png_to_sample.js')

const dir = path.join(__dirname, 'captcha-samples')
let ok = 0, n = 0, chars = 0, charsOk = 0
const rows = []
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : []) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
  if (!j.label) continue
  const grid = { cols: j.cols, rows: j.rows, data: new Uint8Array(Buffer.from(j.data, 'base64')) }
  const r = M.solve(grid)
  const truth = j.label
  const good = r.text === truth
  if (good) ok++
  n++
  for (let i = 0; i < Math.max(truth.length, r.text.length); i++) {
    if (truth[i] === r.text[i]) charsOk++
    chars++
  }
  const hit3 = (r.candidates || []).slice(0, 3).indexOf(truth) >= 0
  rows.push({ truth, read: r.text, good, hit3, cands: (r.candidates || []),
    conf: r.confidence, d: r.meanDistance, cov: r.coverage, pieces: r.chars.length })
}
// the ttu capture survives only as crops, so it is scored by eye, not here
let ok3 = 0
for (const x of rows) {
  if (x.hit3) ok3++
  console.log(`  ${x.good ? 'OK   ' : 'WRONG'} ${JSON.stringify(x.truth).padEnd(8)} -> ${JSON.stringify(x.read).padEnd(10)}` +
    ` conf ${(x.conf || 0).toFixed(2)}  tries: ${x.cands.slice(0, 3).join(' / ')}`)
}
console.log(`\n${ok}/${n} whole reads on the top guess, ${ok3}/${n} within the first three guesses, ${charsOk}/${chars} characters`)
