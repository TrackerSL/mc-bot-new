// Minecraft 1.20.4 map colour palette + a captcha reader for the CWR map gate.
// Standalone: no dependencies, no native modules.
const fs = require('fs')
const path = require('path')

// index -> 0xRRGGBB, '------' = transparent. Data from the 1.20.4 map colour table.
const PALETTE_HEX = 
  '------------------------597d276d99307fb238435e1daea473d5c98cf7e9a3827b568c8c8cabababc7c7c7696969' +
  'b40000dc0000ff00008700007070b48a8adca0a0ff545487757575909090a7a7a7585858005700006a00007c00004100' +
  'b4b4b4dcdcdcffffff8787877376818d909ea4a8b85658616a4c36825e42976d4d4f39284f4f4f6060607070703b3b3b' +
  '2d2db43737dc4040ff2121876454327b663e8f77484b3f26b4b1acdcd9d3fffcf5878581985924ba6d2cd87f3372431b' +
  '7d35989941bab24cd85e2872486c985884ba6699d8365172a1a124c5c52ce5e53379791b5990116db0157fcc19436c0d' +
  'aa5974d06d8ef27fa58043573535354141414c4c4c2828286c6c6c84848499999951515135596c416d844c7f99284351' +
  '592c7d6d36997f3fb243215e24357d2c4199334cb21b285e48352458412c664c3336281b485924586d2c667f3336431b' +
  '6c2424842c2c993333511b1b1111111515151919190d0d0db0a836d7cd42faee4d847e28409a964fbcb75cdbd5307370' +
  '345ab43f6edc4a80ff27438700992800bb3200d93a00721e5b3c226f4a2a815631442d194f01006001007002003b0100' +
  '937c71b4988ad1b1a16e5d5570391989461f9f5224542b13693d4c804b5d95576c4e2e394f4c61605d77706c8a3b3949' +
  '835d19a0721fba852462461348522558642d677535363d1c7036378a4243a04d4e542829281c1831231e3929231e1512' +
  '5f4b45745c54876b624738333d40404b4f4f575c5c2e303056333e693e4b7a495840262e352b4041354f4c3e5c282030' +
  '352318412b1e4c3223281a1235391d4146244c522a282b16642a207a33278e3c2e4b1f181a0f0b1f120d251610130b08' +
  '852122a3292abd3031641919682c447f3653943f614e21334011144f15195c191d300d0f0f585e126c73167e860b4246' +
  '286462327a783a8e8c1e4b4a3c1f2b4a2535562c3e2d17200e7f5d119b7214b4850a5f46464646565656646464343434' +
  '987b67ba967ed8af93725c4d5975696d90817fa79643584f'
const PALETTE = (() => {
  const out = new Int32Array(PALETTE_HEX.length / 6)
  for (let i = 0; i < out.length; i++) {
    const s = PALETTE_HEX.substr(i * 6, 6)
    out[i] = s === '------' ? -1 : parseInt(s, 16)
  }
  return out
})()

function colourOf (idx) {
  const c = idx < PALETTE.length ? PALETTE[idx] : -1
  return c === -1 ? 0xffffff : c
}

// ---------- map packet ----------
function decodeMapPacket (payload) {
  let off = 0
  const varint = () => { let v = 0, s = 0; for (;;) { const b = payload[off++]; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) return v } }
  const mapId = varint()
  off += 1 // scale
  off += 1 // locked
  const hasIcons = payload[off++] === 1
  if (hasIcons) {
    const n = varint()
    for (let i = 0; i < n; i++) { varint(); off += 3; if (payload[off++] === 1) { const len = varint(); off += len } }
  }
  const cols = payload[off++]
  if (!cols) return null
  const rows = payload[off++]
  off += 2
  if (off + cols * rows > payload.length) return null
  return { id: mapId, cols, rows, data: payload.subarray(off, off + cols * rows) }
}

// ---------- image helpers ----------
// the map is text drawn over a photographic noise field; brightness separates them
function brightMask (grid) {
  const { cols, rows, data } = grid
  const m = new Uint8Array(cols * rows)
  for (let i = 0; i < data.length; i++) {
    const c = colourOf(data[i])
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255
    m[i] = (r > g ? (r > b ? r : b) : (g > b ? g : b)) >= 140 ? 1 : 0
  }
  return m
}

// 3x3 median: erases the thin decorative strokes, keeps the solid glyph bodies
function median3 (mask, cols, rows) {
  const out = new Uint8Array(cols * rows)
  const win = new Uint8Array(9)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= rows) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= cols) continue
          win[n++] = mask[yy * cols + xx]
        }
      }
      // insertion sort the small window
      for (let i = 1; i < n; i++) { const v = win[i]; let j = i - 1; while (j >= 0 && win[j] > v) { win[j + 1] = win[j]; j-- } win[j + 1] = v }
      out[y * cols + x] = win[n >> 1]
    }
  }
  return out
}

function components (mask, cols, rows, minArea) {
  const seen = new Uint8Array(cols * rows)
  const out = []
  const stack = []
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue
    stack.length = 0; stack.push(i); seen[i] = 1
    const pix = []
    let x0 = cols, x1 = -1, y0 = rows, y1 = -1
    while (stack.length) {
      const p = stack.pop(); pix.push(p)
      const x = p % cols, y = (p - x) / cols
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || xx >= cols || yy < 0 || yy >= rows) continue
          const q = yy * cols + xx
          if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q) }
        }
      }
    }
    if (pix.length >= minArea) out.push({ x0, x1, y0, y1, area: pix.length })
  }
  return out.sort((a, b) => a.x0 - b.x0)
}

// a wide blob is usually two glyphs touching: cut it where the ink column is thinnest
function splitWide (cmp, mask, cols, maxPieces) {
  const out = []
  const rec = (a, b, depth) => {
    const w = b - a + 1
    if (w <= 30 || depth >= maxPieces) { out.push([a, b]); return }
    let best = -1, bestV = Infinity, maxV = 0
    for (let x = a; x <= b; x++) { let v = 0; for (let y = cmp.y0; y <= cmp.y1; y++) v += mask[y * cols + x]; if (v > maxV) maxV = v }
    const lo = a + Math.max(6, Math.floor(w * 0.25)), hi = b - Math.max(6, Math.floor(w * 0.25))
    for (let x = lo; x <= hi; x++) {
      let v = 0; for (let y = cmp.y0; y <= cmp.y1; y++) v += mask[y * cols + x]
      if (v < bestV) { bestV = v; best = x }
    }
    if (best < 0 || bestV > Math.max(2, 0.34 * maxV)) { out.push([a, b]); return }
    rec(a, best - 1, depth + 1); rec(best + 1, b, depth + 1)
  }
  rec(cmp.x0, cmp.x1, 0)
  return out.map(([a, b]) => ({ ...cmp, x0: a, x1: b }))
}

// ---------- classification ----------
const TPL_SIZE = 20
let BANK = null
function bank () {
  if (BANK) return BANK
  const file = path.join(__dirname, 'captcha_templates.json')
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const bits = Buffer.from(j.bits, 'base64')
  const n = TPL_SIZE * TPL_SIZE
  BANK = j.templates.map(t => {
    const m = new Uint8Array(n)
    for (let k = 0; k < n; k++) {
      const byte = bits[(t.i + k) >> 3]
      m[k] = (byte >> (7 - ((t.i + k) & 7))) & 1
    }
    return { ch: t.c, font: t.f, shear: t.s, mask: m }
  })
  return BANK
}

// box-average resize, aspect preserved by height, centred
function normalise (src, w, h) {
  const out = new Uint8Array(TPL_SIZE * TPL_SIZE)
  const s = (TPL_SIZE - 1) / h
  const nw = Math.max(1, Math.round(w * s)), nh = TPL_SIZE - 1
  const ox = nw >= TPL_SIZE ? 0 : (TPL_SIZE - nw) >> 1
  const oy = nw >= TPL_SIZE ? 0 : 0
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw && x + ox < TPL_SIZE; x++) {
      const sx0 = Math.floor(x * w / nw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / nw))
      const sy0 = Math.floor(y * h / nh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / nh))
      let on = 0, tot = 0
      for (let yy = sy0; yy < sy1 && yy < h; yy++) for (let xx = sx0; xx < sx1 && xx < w; xx++) { tot++; on += src[yy * w + xx] }
      out[(y + oy) * TPL_SIZE + ox + x] = tot && on / tot > 0.4 ? 1 : 0
    }
  }
  return out
}

// chamfer distance: average distance from each inked pixel of a to the nearest inked pixel of b
function distTransform (mask, size) {
  const BIG = 1e6
  const d = new Float64Array(size * size)
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : BIG
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      let v = d[i]
      if (y > 0) v = Math.min(v, d[i - size] + 1)
      if (x > 0) v = Math.min(v, d[i - 1] + 1)
      if (y > 0 && x > 0) v = Math.min(v, d[i - size - 1] + 1.414)
      if (y > 0 && x < size - 1) v = Math.min(v, d[i - size + 1] + 1.414)
      d[i] = v
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    for (let x = size - 1; x >= 0; x--) {
      const i = y * size + x
      let v = d[i]
      if (y < size - 1) v = Math.min(v, d[i + size] + 1)
      if (x < size - 1) v = Math.min(v, d[i + 1] + 1)
      if (y < size - 1 && x < size - 1) v = Math.min(v, d[i + size + 1] + 1.414)
      if (y < size - 1 && x > 0) v = Math.min(v, d[i + size - 1] + 1.414)
      d[i] = v
    }
  }
  return d
}

function meanAt (dt, mask) {
  let s = 0, n = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) { s += dt[i]; n++ }
  return n ? s / n : 9
}

function classify (crop, w, h) {
  const q = normalise(crop, w, h)
  const dq = distTransform(q, TPL_SIZE)
  let best = null
  const per = new Map()
  for (const t of bank()) {
    const dt = distTransform(t.mask, TPL_SIZE)
    const d = meanAt(dt, q) + meanAt(dq, t.mask)
    if (!best || d < best.d) best = { d, ch: t.ch, font: t.font, shear: t.shear }
    const cur = per.get(t.ch)
    if (cur === undefined || d < cur) per.set(t.ch, d)
  }
  const sorted = [...per.entries()].sort((a, b) => a[1] - b[1])
  const gap = sorted.length > 1 ? sorted[1][1] - sorted[0][1] : 9
  return { ch: sorted[0][0], d: sorted[0][1], gap, runnerUp: sorted[1] ? sorted[1][0] : null }
}

function crops (grid) {
  const { cols, rows, data } = grid
  const mask = median3(brightMask(grid), cols, rows)
  const comps = components(mask, cols, rows, 90)
  const pieces = []

  // One glyph is drawn in one colour family (base colour + its shades). Where two
  // glyphs touch, or a decoy stroke fuses them, the components come out joined —
  // so each component is split by family before anything else happens.
  for (const c of comps) {
    const hist = new Map()
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        if (!mask[y * cols + x]) continue
        const f = data[y * cols + x] >> 2
        hist.set(f, (hist.get(f) || 0) + 1)
      }
    }
    const fams = [...hist.entries()].sort((a, b) => b[1] - a[1])
      .filter(([, n]) => n >= Math.max(70, 0.16 * c.area))
      .slice(0, 4)
    if (!fams.length) continue
    for (const [f] of fams) {
      const sub = new Uint8Array(cols * rows)
      for (let y = c.y0; y <= c.y1; y++) {
        for (let x = c.x0; x <= c.x1; x++) {
          const i = y * cols + x
          if (mask[i] && (data[i] >> 2) === f) sub[i] = 1
        }
      }
      const whole = { x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, area: c.area }
      const parts = components(sub, cols, rows, 60)
      for (const piece of parts.length ? parts : [whole]) {
        const w = piece.x1 - piece.x0 + 1, h = piece.y1 - piece.y0 + 1
        if (w < 5 || h < 8) continue
        let ink = 0
        for (let y = piece.y0; y <= piece.y1; y++) for (let x = piece.x0; x <= piece.x1; x++) ink += sub[y * cols + x] || mask[y * cols + x]
        if (ink < 70) continue
        // a glyph is a solid body; a wide, mostly empty box is a decoy stroke
        if (w > 40 && ink / (w * h) < 0.14) continue
        const buf = new Uint8Array(w * h)
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (piece.y0 + y) * cols + piece.x0 + x
          buf[y * w + x] = mask[i] && (data[i] >> 2) === f ? 1 : 0
        }
        pieces.push({ x: piece.x0, x1: piece.x1, y0: piece.y0, y1: piece.y1, w, h, ink, buf, family: f })
      }
    }
  }

  // pieces of the same family that touch or overlap are one glyph, not two
  const buckets = new Map()
  for (const p of pieces) {
    if (!buckets.has(p.family)) buckets.set(p.family, [])
    buckets.get(p.family).push(p)
  }
  const stitch = (a, b) => {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x1, b.x1)
    const y0 = Math.min(a.y0, b.y0), y1 = Math.max(a.y1, b.y1)
    const w = x1 - x0 + 1, h = y1 - y0 + 1
    const buf = new Uint8Array(w * h)
    let ink = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y0 + y) * cols + x0 + x
      buf[y * w + x] = (data[i] >> 2) === a.family ? 1 : 0
      if (buf[y * w + x]) ink++
    }
    return { x: x0, x1, y0, y1, w, h, ink, buf, family: a.family }
  }
  const merged = []
  for (const list of buckets.values()) {
    list.sort((a, b) => a.x - b.x)
    let cur = list[0]
    for (let i = 1; i < list.length; i++) {
      const p = list[i]
      const gap = p.x - cur.x1
      const overlap = Math.min(cur.x1, p.x1) - Math.max(cur.x, p.x)
      if (gap <= 3 || overlap > 0) cur = stitch(cur, p)
      else { merged.push(cur); cur = p }
    }
    merged.push(cur)
  }
  return merged.sort((a, b) => a.x - b.x)
}


// read the text off a decoded map. returns { text, chars, confident }

// two pieces that cover the same ground in BOTH axes are one glyph, never two
function stitchPieces (list, mask, cols) {
  const merge = (a, b) => {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x1, b.x1)
    const y0 = Math.min(a.y0, b.y0), y1 = Math.max(a.y1, b.y1)
    const w = x1 - x0 + 1, h = y1 - y0 + 1
    const buf = new Uint8Array(w * h)
    let ink = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = mask[(y0 + y) * cols + x0 + x] ? 1 : 0
      if (v) { const i = (a.y0 - y0 + y) * a.w + (a.x - x0 + x); if (a.buf[i] && a.y0 - y0 + y >= 0 && a.x - x0 + x >= 0) { } }
      buf[y * w + x] = (a.buf && a.x <= x0 + x && x0 + x <= a.x1 && a.y0 <= y0 + y && y0 + y <= a.y1 && a.buf[(y0 + y - a.y0) * a.w + (x0 + x - a.x)]) ||
                       (b.buf && b.x <= x0 + x && x0 + x <= b.x1 && b.y0 <= y0 + y && y0 + y <= b.y1 && b.buf[(y0 + y - b.y0) * b.w + (x0 + x - b.x)]) ? 1 : 0
      if (buf[y * w + x]) ink++
    }
    return { x: x0, x1, y0, y1, w, h, ink, buf, family: a.family }
  }
  const out = []
  for (const p of list.slice().sort((a, b) => a.x - b.x)) {
    const q = out[out.length - 1]
    if (q) {
      const ox = Math.min(q.x1, p.x1) - Math.max(q.x, p.x)
      const oy = Math.min(q.y1, p.y1) - Math.max(q.y0, p.y0)
      const mergedW = Math.max(q.x1, p.x1) - Math.min(q.x, p.x) + 1
      const cap = 0.95 * Math.max(q.h, p.h)   // a glyph is not wider than it is tall
      if (mergedW > cap) { out.push(p); continue }
      if (ox > 0.3 * Math.min(q.w, p.w) && oy > 0.3 * Math.min(q.h, p.h)) { out[out.length - 1] = merge(q, p); continue }
      if (p.x - q.x1 <= 3 && oy > 0.5 * Math.min(q.h, p.h)) { out[out.length - 1] = merge(q, p); continue }
    }
    out.push(p)
  }
  return out
}

// segmentation is the fragile part, so two different ones are tried and the
// reading whose glyphs each match a template most closely wins
function pieceVariants (grid) {
  const out = [crops(grid)]
  const { cols, rows } = grid
  const mask = median3(brightMask(grid), cols, rows)
  const flat = new Uint8Array(cols * rows)
  const comps = components(mask, cols, rows, 90)
  const list = []
  for (const c of comps) {
    for (const piece of splitWide(c, mask, cols, 3)) {
      const w = piece.x1 - piece.x0 + 1, h = piece.y1 - piece.y0 + 1
      if (w < 5 || h < 8 || (w > 40 && piece.area / (w * h * 2) < 0.1)) continue
      let ink = 0
      for (let y = piece.y0; y <= piece.y1; y++) for (let x = piece.x0; x <= piece.x1; x++) ink += mask[y * cols + x]
      if (ink < 70) continue
      const buf = new Uint8Array(w * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf[y * w + x] = mask[(piece.y0 + y) * cols + piece.x0 + x]
      list.push({ x: piece.x0, x1: piece.x1, y0: piece.y0, y1: piece.y1, w, h, ink, buf, family: -1 })
    }
  }
  out.push(stitchPieces(list, mask, cols))
  return out
}


// The server lays the code out on an even pitch, so instead of trying to cut blobs
// apart, fit N evenly spaced cells and let the match score pick N. This is the only
// variant that gets the CHARACTER COUNT right when glyphs are fused.
function pitchSplit (grid, cols, rows, mask) {
  let bandY0 = rows, bandY1 = 0
  const rowInk = new Int32Array(rows)
  for (let y = 0; y < rows; y++) {
    let n = 0
    for (let x = 0; x < cols; x++) n += mask[y * cols + x]
    rowInk[y] = n
  }
  let maxRow = 0
  for (const n of rowInk) if (n > maxRow) maxRow = n
  for (let y = 0; y < rows; y++) {
    if (rowInk[y] >= 0.25 * maxRow) { if (y < bandY0) bandY0 = y; if (y > bandY1) bandY1 = y }
  }
  if (bandY1 - bandY0 < 10) { bandY0 = 0; bandY1 = rows - 1 }
  bandY0 = Math.max(0, bandY0 - 3); bandY1 = Math.min(rows - 1, bandY1 + 3)
  const out = []
  for (let n = 3; n <= 5; n++) {
    for (let pitch = 22; pitch <= 38; pitch++) {
      for (let x0 = 0; x0 <= cols - n * pitch; x0 += 2) {
        const cells = []
        let ok = true
        for (let i = 0; i < n; i++) {
          const a = x0 + i * pitch, b = Math.min(cols - 1, a + pitch - 1)
          const w = b - a + 1, h = bandY1 - bandY0 + 1
          const buf = new Uint8Array(w * h)
          let ink = 0
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const v = mask[(bandY0 + y) * cols + a + x]
            buf[y * w + x] = v
            ink += v
          }
          if (ink < 55) { ok = false; break }
          cells.push({ x: a, x1: b, y0: bandY0, y1: bandY1, w, h, ink, buf, family: -1 })
        }
        if (!ok) continue
        out.push({ n, pitch, x0, cells })
      }
    }
  }
  return out
}

function solve (grid) {
  const fast = solveNN(grid)
  if (fast) return fast
  let pieces = crops(grid)
  // Score a segmentation on three things: how well each glyph matches a template,
  // how much of the glyph ink it accounts for, and how few pieces it needed.
  // Without the coverage term, cutting a glyph into fragments always "wins".
  const { cols: gc, rows: gr } = grid
  const gmask = median3(brightMask(grid), gc, gr)
  let totalInk = 0
  for (let i = 0; i < gmask.length; i++) totalInk += gmask[i]
  const pitchCandidates = pitchSplit(grid, gc, gr, gmask).map(h => {
    const rd = h.cells.map(p => classify(p.buf, p.w, p.h))
    const mean = rd.reduce((a, r) => a + r.d, 0) / rd.length
    const spread = h.cells.map(c => c.x).sort((a, b) => a - b)
    const leftGap = spread[0], rightGap = gc - (spread[spread.length - 1] + h.pitch)
    // the line should sit inside the picture, not hug an edge
    const edge = Math.min(leftGap, rightGap)
    return { ps: h.cells, rd, mean, coverage: 1, score: mean + 0.02 * Math.abs(edge) + 0.05 * h.n, n: h.n, pitch: h.pitch }
  }).sort((a, b) => a.score - b.score).slice(0, 40)
  const judged = pieceVariants(grid).map(ps => {
    const rd = ps.map(p => classify(p.buf, p.w, p.h))
    const mean = rd.length ? rd.reduce((a, r) => a + r.d, 0) / rd.length : 9
    const covered = new Uint8Array(gmask.length)
    let cov = 0
    for (const p of ps) {
      for (let y = p.y0; y <= p.y1; y++) {
        for (let x = p.x; x <= p.x1; x++) {
          const i = y * gc + x
          if (gmask[i] && !covered[i]) { covered[i] = 1; cov++ }
        }
      }
    }
    const coverage = totalInk ? cov / totalInk : 0
    const score = mean + 0.9 * (1 - coverage) + 0.06 * ps.length
    return { ps, rd, mean, coverage, score }
  }).filter(v => v.ps.length >= 2 && v.ps.length <= 8)
  if (pitchCandidates[0]) judged.push(pitchCandidates[0])
  judged.sort((a, b) => a.score - b.score)
  const chosen = judged[0] || { ps: [], rd: [], mean: 9 }
  pieces = chosen.ps
  const read = chosen.rd
  const text = read.map(r => r.ch).join('')
  const strong = read.filter(r => r.gap > 0.25 && r.d < 2.2).length
  // the server says "try again" on a wrong answer without resending the map, so a
  // few ranked guesses can be spent against the SAME picture. Build them from the
  // per-position runner-ups, best combination first.
  const alts = read.map(r => [r.ch, r.runnerUp].filter(Boolean))
  const candidates = []
  const walk = (i, acc, score) => {
    if (candidates.length >= 8) return
    if (i === alts.length) { if (acc.length) candidates.push({ text: acc, score }); return }
    for (const ch of alts[i]) walk(i + 1, acc + ch, score + (ch === alts[i][0] ? 0 : 1))
  }
  walk(0, '', 0)
  candidates.sort((a, b) => a.score - b.score)
  return {
    text,
    chars: read.map((r, i) => ({ ...r, x: pieces[i].x })),
    meanDistance: chosen.mean,
    coverage: chosen.coverage,
    candidates: candidates.slice(0, 6).map(c => c.text),
    confident: pieces.length >= 3 && strong === pieces.length
  }
}

// ---------- neural reader (sonar-style captcha) ----------
// The map gate on this server is the Sonar plugin's standard captcha: Kingthings
// Trypewriter glyphs painted with a radial colour gradient over an FBM noise
// field, 3 curves, then per-pixel noise. Templates of the right font still lose
// to the noise, so the reading is done by a small CNN trained on that renderer.
let _nn = null
function nnReader () {
  if (_nn !== null) return _nn
  try {
    const mod = require('./captcha_nn.js')
    if (!fs.existsSync(path.join(__dirname, 'captcha_nn_weights.bin'))) { _nn = false; return _nn }
    _nn = { mod, model: mod.loadModel(__dirname) }
  } catch (e) { throw new Error('CAPTCHA neural model failed validation: ' + e.message) }
  return _nn
}

function solveNN (grid) {
  const r = nnReader()
  if (!r) return null
  const rgb = trueColourRgb(grid)
  const out = r.mod.read(r.model, rgb)
  if (!out.text) return null
  // Confidence: the joint probability of the winning string. ~0.6+ means the
  // four slots agree; below ~0.25 the picture is genuinely ambiguous.
  const slots = (out.slots || []).filter(s => s.ch);
  const chars = out.text.split('').map((ch, i) => {
    const slot = slots[i];
    const p = slot ? slot.p : out.confidence;
    return { ch, d: -Math.log(Math.max(p, 1e-6)),
      gap: slot ? slot.gap : 0, x: 0, runnerUp: slot ? slot.runnerUp : null };
  });

  return {
    text: out.text,
    chars,
    meanDistance: -Math.log(Math.max(out.confidence, 1e-6)) / Math.max(out.text.length, 1),
    coverage: 1,
    candidates: out.candidates.map(c => c.text),
    confident: out.confidence >= 0.5,
    confidence: out.confidence,
    source: 'nn'
  }
}

function trueColourRgb (grid) {
  const out = new Uint8Array(grid.data.length * 3)
  for (let i = 0; i < grid.data.length; i++) {
    const c = colourOf(grid.data[i])
    out[i * 3] = (c >> 16) & 255; out[i * 3 + 1] = (c >> 8) & 255; out[i * 3 + 2] = c & 255
  }
  return out
}

module.exports = { PALETTE, decodeMapPacket, brightMask, median3, components, splitWide, crops, solve, solveNN, trueColourRgb, classify }
