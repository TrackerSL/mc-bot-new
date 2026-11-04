/* Guards the item layer. Two bugs made every slot fall back to a letter tile:
     1. items1204.json was built from the wrong (1.21) registry, and
     2. server.js read the tables with `fs`/`path` BEFORE those consts were declared,
        so the read threw a ReferenceError into an empty catch and the registry was
        always {} at runtime.
   This test checks both: the data itself, and that nothing above the declarations
   touches fs/path. */
const fs = require('fs')
const path = require('path')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok   ' + name) } else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')) } }

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
const lines = src.split('\n')

/* --- 1. no use-before-declaration of fs / path (the runtime killer) --- */
const declFs = lines.findIndex(l => /^const fs = require\('fs'\)/.test(l))
const declPath = lines.findIndex(l => /^const path = require\('path'\)/.test(l))
ok('fs declared at module top', declFs >= 0 && declFs < 40, 'line ' + (declFs + 1))
ok('path declared at module top', declPath >= 0 && declPath < 40, 'line ' + (declPath + 1))
let early = []
lines.forEach((l, i) => {
  if (i >= Math.max(declFs, declPath)) return
  if (/(^|[^.\w])fs\.[a-zA-Z]/.test(l) || /(^|[^.\w])path\.join/.test(l)) early.push(i + 1)
})
ok('no fs/path use before declaration', early.length === 0, 'lines ' + early.join(','))

/* --- 2. the tables are 1.20.4 and complete --- */
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'items1204.json'), 'utf8'))
const tex = JSON.parse(fs.readFileSync(path.join(__dirname, 'item_tex.json'), 'utf8'))
ok('registry has >1200 ids', Object.keys(items).length > 1200, Object.keys(items).length + ' ids')
/* Anchors below are cross-checked against a real 1.20.4 client in the server's hub:
   ids 921 / 946 / 1103 / 853 render there as paper, lime dye, nether star and a leather
   cap. An earlier "fix" rebuilt this table from the 1.20 list, which shifted every id
   after 12 by ~58 and made those items decode as bone, melon seeds, end crystal and a
   mangrove sign. */
ok('registry has 1312 ids (1.20.4)', Object.keys(items).length === 1312, Object.keys(items).length + ' ids')
ok('id 13 = tuff_slab (1.20.4 experimental block)', items['13'] && items['13'].k === 'tuff_slab', JSON.stringify(items['13']))
ok('id 22 = tuff_brick_slab', items['22'] && items['22'].k === 'tuff_brick_slab', JSON.stringify(items['22']))
ok('id 853 = leather_helmet', items['853'] && items['853'].k === 'leather_helmet', JSON.stringify(items['853']))
ok('id 921 = paper', items['921'] && items['921'].k === 'paper', JSON.stringify(items['921']))
ok('id 946 = lime_dye', items['946'] && items['946'].k === 'lime_dye', JSON.stringify(items['946']))
ok('id 1103 = nether_star', items['1103'] && items['1103'].k === 'nether_star', JSON.stringify(items['1103']))
const resolved = Object.values(items).filter(v => tex[v.k])
ok('>=99% of keys have a texture', resolved.length / Object.keys(items).length >= 0.99,
   resolved.length + '/' + Object.keys(items).length)
const missingFiles = Object.entries(tex).filter(([, p]) => !fs.existsSync(path.join(__dirname, 'textures', p)))
ok('every mapped texture file exists', missingFiles.length === 0, missingFiles.slice(0, 3).map(m => m[1]).join(', '))

/* --- 3. the payload the page receives carries name + tex --- */
const ITEM_NAMES = items, ITEM_TEX = tex
function brief (id, count, custom) {
  const reg = ITEM_NAMES[String(id)] || null
  return { id, count: count || 1, disp: custom || (reg ? reg.n : 'item ' + id), key: reg ? reg.k : '', tex: reg ? (ITEM_TEX[reg.k] || '') : '' }
}
for (const [id, key, file] of [[921, 'paper', 'item/paper.png'], [946, 'lime_dye', 'item/lime_dye.png'], [1103, 'nether_star', 'item/nether_star.png']]) {
  const b = brief(id)
  ok('slot ' + id + ' -> ' + key, b.key === key && b.tex === file, JSON.stringify(b))
}
ok('custom name keeps the base texture', brief(853, 1, 'Mythic Helmet').tex === 'item/leather_helmet.png', brief(853,1,'Mythic Helmet').tex)

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
