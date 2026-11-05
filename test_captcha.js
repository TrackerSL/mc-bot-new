/* The map captcha: CWR's second gate draws a code into a 128x128 in-game map and asks
   you to type it. Nothing can guess the text, but the bot must at least turn the map
   into a picture a human can read, and say that it did. These tests pin the decoder,
   the PNG writer (including real chunk CRCs) and the wiring in the chat handler. */
const fs = require('fs'), path = require('path'), zlib = require('zlib')
const m = require(path.join(__dirname, 'server.js'))
const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
let pass = 0, fail = 0
const T = (n, c, x) => { if (c) { pass++; console.log('  ok  ' + n) } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x) : '')) } }

// --- 1. the packet decoder
const cols = 128, rows = 128
const data = Buffer.alloc(cols * rows, 34)              // background colour index
for (let y = 40; y < 80; y++) for (let x = 40; x < 80; x++) data[y * cols + x] = 7   // an "ink" block
const payload = Buffer.concat([Buffer.from([9, 1, 0, 0, cols, rows, 0, 0]), data])
const d = m.decodeMapPacket(payload)
T('a map packet decodes to its pixel grid', d && d.cols === 128 && d.rows === 128, d && [d.cols, d.rows])
T('pixels are read in the right order', d.data[50 * 128 + 50] === 7 && d.data[0] === 34)
T('a partial map (no columns) is refused rather than half-read', m.decodeMapPacket(Buffer.from([1, 0, 0, 0])) === null)

// --- 2. the binarisation the bot applies before writing the picture
const freq = new Map()
for (const v of d.data) freq.set(v, (freq.get(v) || 0) + 1)
let bg = 0, best = -1
for (const [k, n] of freq) if (n > best) { best = n; bg = k }
const grey = new Uint8Array(d.data.length)
for (let i = 0; i < d.data.length; i++) grey[i] = d.data[i] === bg ? 255 : 0
T('the most common colour becomes the white background', bg === 34 && grey[0] === 255)
T('everything else becomes ink', grey[50 * 128 + 50] === 0)

// --- 3. a PNG that a strict reader accepts: signature, chunk CRCs, inflatable IDAT
const png = m.pngFromGrey(cols, rows, grey, null, 4)
T('png signature is right', png.slice(0, 8).toString('hex') === '89504e470d0a1a0a')
let off = 8, chunks = [], crcsOk = true
while (off < png.length) {
  const len = png.readUInt32BE(off)
  const type = png.slice(off + 4, off + 8).toString('ascii')
  const body = png.slice(off + 8, off + 8 + len)
  const crc = png.readUInt32BE(off + 8 + len)
  const calc = zlib.crc32 ? zlib.crc32(Buffer.concat([Buffer.from(type), body])) >>> 0 : null
  if (calc !== null && calc !== crc) crcsOk = false
  chunks.push(type)
  off += 12 + len
}
T('the chunks are IHDR, IDAT, IEND', chunks.join(',') === 'IHDR,IDAT,IEND', chunks)
T('every chunk CRC is valid', crcsOk)
const ihdr = png.slice(16, 16 + 13)
T('the image is the 4x upscale (512x512)', ihdr.readUInt32BE(0) === 512 && ihdr.readUInt32BE(4) === 512)
T('image data inflates to exactly w*3+1 per row', (() => {
  const i = png.indexOf(Buffer.from('IDAT'))
  const len = png.readUInt32BE(i - 4)
  return zlib.inflateSync(png.slice(i + 4, i + 4 + len)).length === (512 * 3 + 1) * 512
})())

// --- 4. the wiring in the bot itself
T('the map packet is kept', /case 'map': \{/.test(SRC) && /lastMap = m/.test(SRC))
T('the prompt triggers a picture', /displayed on the map/.test(SRC) && /captcha-map\.png/.test(SRC))
T('the log says where the picture is and what to do', /picture saved to/.test(SRC) && /type the text in the console/.test(SRC))
T('the bot waits for a map that lands late', /waiting for the map picture/.test(SRC) && /setInterval/.test(SRC))
T('a map already in memory is not trusted as the captcha', /Date\.now\(\) - \(lastMapAt \|\| 0\) < 3000/.test(SRC) && /lastMap = null/.test(SRC))
T('the stale map is only used as a labelled fallback', /may be the wrong map/.test(SRC))
T('a map from the last few seconds is the captcha, not stale', /lastMapAt = Date\.now\(\)/.test(SRC))
T('a prompt with no map says so instead of pretending', /no map packet arrived at all/.test(SRC))
T('the console can serve it over http', /url\.pathname === '\/captcha\.png'/.test(SRC))
T('the raw map is dumped too, not just a thresholded copy', /replace\(\/\\\.png\$\/, '\.bin'\)/.test(SRC) && /lastMapRaw/.test(SRC))
T('a colour version is written so text and background stay apart', /-colour\.png/.test(SRC))
T('pngFromGrey accepts a flat rgb array', /if \(rgb\) \{ raw\[o\] = grey\[si \* 3\]/.test(SRC))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
