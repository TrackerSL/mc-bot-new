'use strict';
/*
 * captcha_nn.js — pure-JS inference for the Sonar-style map captcha reader.
 *
 * The model is a small CNN (conv16-32-64-64 / fc160 / 4 slots x 37 classes)
 * trained on labelled 128x128 map captchas. Weights live in
 * `captcha_nn_weights.bin` (float32 little endian) described by
 * `captcha_nn_weights.json`.
 *
 * No native deps: only fs + typed arrays.
 */

const fs = require('fs');
const path = require('path');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const BLANK = ALPHABET.length; // 36
const CLASSES = ALPHABET.length + 1; // 37
const SLOTS = 4;

// ---------------------------------------------------------------- weights ---

function loadModel(dir) {
  dir = dir || __dirname;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'captcha_nn_weights.json'), 'utf8'));
  if (manifest.alphabet !== ALPHABET || manifest.classes !== CLASSES ||
      manifest.slots !== SLOTS || manifest.input !== 64) throw new Error('Incompatible CAPTCHA model manifest');
  if (manifest.file && path.basename(manifest.file) !== manifest.file) throw new Error('Invalid model filename');
  const raw = fs.readFileSync(path.join(dir, manifest.file || 'captcha_nn_weights.bin'));
  if (raw.length !== 256500 * 4) throw new Error('Invalid CAPTCHA weight file size');
  // Explicit little-endian read: independent of Buffer alignment and host endianness.
  const buf = new Float32Array(256500);
  for (let i=0;i<buf.length;i++) {
    buf[i]=raw.readFloatLE(i*4);
    if (!Number.isFinite(buf[i])) throw new Error('Non-finite CAPTCHA weight');
  }
  const expected = {c1w:[16,1,5,5],c1b:[16],c2w:[32,16,5,5],c2b:[32],
    c3w:[64,32,3,3],c3b:[64],c4w:[64,64,3,3],c4b:[64],
    fc1w:[160,1024],fc1b:[160],fc2w:[148,160],fc2b:[148]};
  const t = {}; let offset=0;
  for (const [name, shape] of Object.entries(expected)) {
    const spec=manifest.tensors && manifest.tensors[name];
    const count=shape.reduce((a,b)=>a*b,1);
    if (!spec || JSON.stringify(spec.shape)!==JSON.stringify(shape) ||
        spec.offset!==offset || spec.count!==count) throw new Error('Invalid CAPTCHA tensor: '+name);
    t[name]=buf.subarray(offset,offset+count); offset+=count;
  }
  return { tensors: t, meta: manifest };
}

// ------------------------------------------------------------------- ops ----

function conv2dSame(inC, inH, inW, x, w, b, outC, k, relu) {
  // w: [outC][inC][k][k]
  const out = new Float32Array(outC * inH * inW);
  const pad = (k - 1) >> 1;
  for (let oc = 0; oc < outC; oc++) {
    const wBase = oc * inC * k * k;
    const bb = b ? b[oc] : 0;
    const oBase = oc * inH * inW;
    for (let ic = 0; ic < inC; ic++) {
      const kBase = wBase + ic * k * k;
      const iBase = ic * inH * inW;
      for (let ky = 0; ky < k; ky++) {
        for (let kx = 0; kx < k; kx++) {
          const wv = w[kBase + ky * k + kx];
          if (wv === 0) continue;
          const y0 = ky - pad;
          for (let y = 0; y < inH; y++) {
            const sy = y + y0;
            if (sy < 0 || sy >= inH) continue;
            const rowIn = iBase + sy * inW;
            const rowOut = oBase + y * inW;
            for (let x2 = 0; x2 < inW; x2++) {
              const sx = x2 + kx - pad;
              if (sx < 0 || sx >= inW) continue;
              out[rowOut + x2] += wv * x[rowIn + sx];
            }
          }
        }
      }
    }
    for (let i = 0; i < inH * inW; i++) {
      let v = out[oBase + i] + bb;
      if (relu && v < 0) v = 0;
      out[oBase + i] = v;
    }
  }
  return out;
}

function maxPool2(c, h, w, x) {
  const oh = h >> 1, ow = w >> 1;
  const out = new Float32Array(c * oh * ow);
  for (let ch = 0; ch < c; ch++) {
    const iB = ch * h * w, oB = ch * oh * ow;
    for (let y = 0; y < oh; y++) {
      for (let x2 = 0; x2 < ow; x2++) {
        const a = x[iB + (2 * y) * w + 2 * x2];
        const b = x[iB + (2 * y) * w + 2 * x2 + 1];
        const c2 = x[iB + (2 * y + 1) * w + 2 * x2];
        const d = x[iB + (2 * y + 1) * w + 2 * x2 + 1];
        out[oB + y * ow + x2] = Math.max(a, b, c2, d);
      }
    }
  }
  return out;
}

function dense(nIn, nOut, x, w, b, relu) {
  const out = new Float32Array(nOut);
  for (let o = 0; o < nOut; o++) {
    let s = b ? b[o] : 0;
    const base = o * nIn;
    for (let i = 0; i < nIn; i++) s += w[base + i] * x[i];
    out[o] = relu && s < 0 ? 0 : s;
  }
  return out;
}

// ----------------------------------------------------------------- model ----

function forward(model, input64) {
  const t = model.tensors;
  // input64: Float32Array(64*64)
  let x = conv2dSame(1, 64, 64, input64, t.c1w, t.c1b, 16, 5, true);
  x = maxPool2(16, 64, 64, x); // 32
  x = conv2dSame(16, 32, 32, x, t.c2w, t.c2b, 32, 5, true);
  x = maxPool2(32, 32, 32, x); // 16
  x = conv2dSame(32, 16, 16, x, t.c3w, t.c3b, 64, 3, true);
  x = maxPool2(64, 16, 16, x); // 8
  x = conv2dSame(64, 8, 8, x, t.c4w, t.c4b, 64, 3, true);
  x = maxPool2(64, 8, 8, x); // 4
  x = dense(64 * 4 * 4, 160, x, t.fc1w, t.fc1b, true);
  const logits = dense(160, SLOTS * CLASSES, x, t.fc2w, t.fc2b, false);
  // softmax per slot
  const probs = [];
  for (let s = 0; s < SLOTS; s++) {
    let mx = -Infinity;
    for (let c = 0; c < CLASSES; c++) mx = Math.max(mx, logits[s * CLASSES + c]);
    let sum = 0;
    const p = new Float32Array(CLASSES);
    for (let c = 0; c < CLASSES; c++) {
      p[c] = Math.exp(logits[s * CLASSES + c] - mx);
      sum += p[c];
    }
    for (let c = 0; c < CLASSES; c++) p[c] /= sum;
    probs.push(p);
  }
  return probs;
}

// ------------------------------------------------------------- image prep ---

/** RGB 128x128 (Uint8 RGBRGB...) -> ink mask 0..1 (Float32Array 128*128) */
function inkMask(rgb) {
  const N = 128 * 128;
  const chroma = new Float32Array(N);
  const mxArr = new Float32Array(N);
  const hist = new Uint32Array(256);
  for (let i = 0; i < N; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    mxArr[i] = mx / 255;
    const c = (mx - mn) / 255;
    chroma[i] = c;
    hist[Math.min(255, (c * 255) | 0)]++;
  }
  // median of chroma
  let acc = 0, med = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= N / 2) { med = i / 255; break; } }
  const grey = med < 0.12;
  const thrC = Math.max(0.055, med + 0.045);
  const m = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const mx = mxArr[i], c = chroma[i];
    let on;
    if (grey) on = c > thrC && mx > 0.12;
    else {
      const sat = mx > 1e-6 ? c / mx : 0;
      on = sat > 0.28 && mx > 0.25;
    }
    m[i] = on ? 1 : 0;
  }
  // 3x3 density gate
  const dens = new Float32Array(N);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= 128) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= 128) continue;
          s += m[yy * 128 + xx]; n++;
        }
      }
      dens[y * 128 + x] = s / n;
    }
  }
  for (let i = 0; i < N; i++) m[i] = dens[i] > 0.25 ? m[i] : 0;
  return m;
}

/** 128x128 mask -> 64x64 by 2x2 mean */
function pool2(m) {
  const out = new Float32Array(64 * 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      out[y * 64 + x] = (m[(2 * y) * 128 + 2 * x] + m[(2 * y) * 128 + 2 * x + 1] +
        m[(2 * y + 1) * 128 + 2 * x] + m[(2 * y + 1) * 128 + 2 * x + 1]) / 4;
    }
  }
  return out;
}

// ---------------------------------------------------------------- decode ----

function beam(probs, n) {
  // Training decodes blank by removing it, not by terminating at first blank.
  // Enumerate the strongest slot combinations and combine duplicate spellings.
  const totals = new Map();
  const orders = probs.map(p => Array.from({length: CLASSES}, (_,i)=>i)
    .sort((a,b)=>p[b]-p[a]).slice(0,6));
  function visit(slot, text, probability) {
    if (slot === SLOTS) {
      if (text.length >= 3 && text.length <= 4)
        totals.set(text, (totals.get(text) || 0) + probability);
      return;
    }
    for (const cls of orders[slot]) visit(slot+1,
      text + (cls === BLANK ? '' : ALPHABET[cls]), probability*probs[slot][cls]);
  }
  visit(0, '', 1);
  return [...totals].map(([s,p])=>({s,p})).sort((a,b)=>b.p-a.p).slice(0,n);
}

function shiftMask (m, dx, dy) {
  const out = new Float32Array(m.length);
  for (let y = 0; y < 64; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= 64) continue;
    for (let x = 0; x < 64; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= 64) continue;
      out[y * 64 + x] = m[sy * 64 + sx];
    }
  }
  return out;
}

/** average the per-slot distributions over small shifts (test-time augmentation) */
function forwardTTA (model, mask) {
  const shifts = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  let acc = null;
  for (const [dx, dy] of shifts) {
    const p = forward(model, shiftMask(mask, dx, dy));
    if (!acc) acc = p;
    else for (let s = 0; s < SLOTS; s++) for (let c = 0; c < CLASSES; c++) acc[s][c] += p[s][c];
  }
  for (let s = 0; s < SLOTS; s++) {
    let sum = 0;
    for (let c = 0; c < CLASSES; c++) sum += acc[s][c];
    for (let c = 0; c < CLASSES; c++) acc[s][c] /= sum;
  }
  return acc;
}

/**
 * Read a captcha from RGB bytes (128*128*3) or from an existing mask.
 * Returns { text, confidence, candidates: [{text, p}] }
 */
function read(model, rgb, options = {}) {
  if (!(rgb instanceof Uint8Array) || rgb.length !== 128*128*3)
    throw new Error('Expected 128x128 RGB byte array');
  const mask = pool2(inkMask(rgb));
  const probs = options.tta ? forwardTTA(model, mask) : forward(model, mask);
  const cands = beam(probs, 4);
  const text = cands.length ? cands[0].s : '';
  return {
    text,
    slots: probs.map(p => {
      const order = Array.from({length: CLASSES},(_,i)=>i).sort((a,b)=>p[b]-p[a]);
      return {ch: order[0] === BLANK ? '' : ALPHABET[order[0]],
        p:p[order[0]], gap:p[order[0]]-p[order[1]],
        runnerUp:order[1] === BLANK ? '' : ALPHABET[order[1]]};
    }),
    confidence: cands.length ? cands[0].p : 0,
    candidates: cands.map(c => ({ text: c.s, p: c.p })),
  };
}

module.exports = { loadModel, read, inkMask, pool2, forward, forwardTTA, beam, ALPHABET };
