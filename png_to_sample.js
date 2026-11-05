// The raw .bin captures are gone for most samples, but the true-colour PNGs are
// lossless: every map colour maps to exactly one palette index, so the pixel grid
// can be inverted back out of the picture.
const fs = require('fs')
const path = require('path')
const M = require('./map_captcha.js')
const R = require('/home/user/map_reader.js')   // decodePng

function paletteReverse () {
  const rev = new Map()
  for (let i = 0; i < M.PALETTE.length; i++) {
    const c = M.PALETTE[i]
    if (c === -1) continue
    if (!rev.has(c)) rev.set(c, i)
  }
  return rev
}

function pngToGrid (file) {
  const img = R.decodePng(fs.readFileSync(file))
  const rev = paletteReverse()
  const scale = Math.round(img.cols / 128)
  const cols = 128, rows = 128
  const data = new Uint8Array(cols * rows)
  let unknown = 0
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = img.data[(y * scale + (scale >> 1)) * img.cols + (x * scale + (scale >> 1))]
      const idx = rev.get(px >>> 0)   // packed rgb from decodePng
      if (idx === undefined) { unknown++; data[y * cols + x] = 0 } else data[y * cols + x] = idx
    }
  }
  return { cols, rows, data, unknown, scale }
}

module.exports = { pngToGrid }

if (require.main === module) {
  const [file, label] = process.argv.slice(2)
  if (!file) { console.error('usage: node png_to_sample.js <png> [label]'); process.exit(1) }
  const g = pngToGrid(file)
  const dir = path.join(__dirname, 'captcha-samples')
  fs.mkdirSync(dir, { recursive: true })
  const name = (label || path.basename(file, '.png')).replace(/[^A-Za-z0-9]/g, '_')
  const out = path.join(dir, name + '.json')
  fs.writeFileSync(out, JSON.stringify({ label: label || null, cols: g.cols, rows: g.rows, data: Buffer.from(g.data).toString('base64') }))
  console.log(`${path.basename(file)} -> ${out}  (${g.unknown} pixels had no palette match, scale ${g.scale})`)
}
