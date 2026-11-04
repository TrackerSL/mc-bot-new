/* Item icon resolution, checked against synthetic NBT in the exact shape the server sends.

   Two rules, in order:
     1. the registry is the source of truth — a leather cap is drawn as a leather cap;
     2. only with ICON_GUESS=1 (opt-in) does a name like "MEMBER Helmet" override the base
        material, for servers that really do disguise items.

   This guards the mistake that shipped for two rounds: a shifted id table made a leather
   cap (id 853) decode as a mangrove sign, and a name-based guess was added to paper over
   it instead of fixing the table. */
const fs = require('fs'), path = require('path')
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')

const GUESS = process.env.ICON_GUESS === '1'
let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x ? '  ' + x : '')) } }

const a = src.indexOf('const HEX_CODE'), b = src.indexOf('// best-effort MenuType registry')
const ITEM_NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'items1204.json'), 'utf8'))
const ITEM_TEX = JSON.parse(fs.readFileSync(path.join(__dirname, 'item_tex.json'), 'utf8'))
const api = new Function('ITEM_NAMES', 'ITEM_TEX', 'fs', 'path', 'DEBUG_ITEM', 'ICON_GUESS',
  src.slice(a, b) + '; return { itemBrief, iconClassOf, CLASS_ICON }')(ITEM_NAMES, ITEM_TEX, fs, path, false, GUESS)

const comp = (e) => ({ __t: 10, v: e })
const str = (s) => ({ __t: 8, v: s })
const nameJson = (t, col) => JSON.stringify({ extra: [{ color: col || 'aqua', text: t, bold: true }], text: '' })
function item (id, name, lore) {
  const display = comp([['Name', str(nameJson(name))]])
  if (lore) display.v.push(['Lore', { __t: 9, v: { __et: 8, items: lore.map(l => str(JSON.stringify({ extra: [{ color: 'gray', text: l }], text: '' }))) } }])
  return { present: true, itemId: id, itemCount: 1, nbtData: comp([['hotbarItem', str('k')], ['display', display]]) }
}

/* ---- 1. the registry decides, always ---- */
const helmet = api.itemBrief(item(853, 'MEMBER Helmet'))
ok('id 853 is a leather cap', helmet.key === 'leather_helmet', helmet.key)
ok('it is drawn as a leather cap', helmet.tex === 'item/leather_helmet.png', helmet.tex)
ok('the custom name is kept', helmet.disp === 'MEMBER Helmet', JSON.stringify(helmet.disp))
ok('the texture file exists', fs.existsSync(path.join(__dirname, 'textures', helmet.tex)))
if (!GUESS) ok('no guessing while the flag is off', helmet.customIcon === '', helmet.customIcon)

const hub = [[921, 'paper'], [946, 'lime_dye'], [1103, 'nether_star']]
for (const [id, key] of hub) {
  const b = api.itemBrief({ present: true, itemId: id, itemCount: 1 })
  ok('id ' + id + ' -> ' + key, b.key === key && b.tex === 'item/' + key + '.png', b.key + ' / ' + b.tex)
}

/* ---- 2. ordinary items are untouched ---- */
const plain = api.itemBrief({ present: true, itemId: 1155, itemCount: 1 })
ok('plain shield keeps its art', plain.key === 'shield' && plain.tex === 'entity/shield_base.png', plain.key + ' / ' + plain.tex)

/* ---- 3. lore still converts through the colour pipeline ---- */
const withLore = api.itemBrief(item(853, 'MEMBER Helmet', ['Click to equip']))
ok('lore parsed and colour-coded', (withLore.lore || []).length === 1 && withLore.lore[0].includes('Click to equip'), JSON.stringify(withLore.lore))
ok('lore carries a colour code', (withLore.lore[0] || '').includes(String.fromCharCode(167)), JSON.stringify(withLore.lore))

/* ---- 4. the opt-in guessing path ---- */
if (GUESS) {
  const cases = [
    ['MEMBER Chestplate', 'item/iron_chestplate.png'],
    ['MEMBER Leggings', 'item/iron_leggings.png'],
    ['MEMBER Boots', 'item/iron_boots.png'],
    ['Mythic Pickaxe', 'item/iron_pickaxe.png'],
    ['Rage Axe', 'item/iron_axe.png'],
    ['Hunter Bow', 'item/bow.png']
  ]
  for (const [name, want] of cases) {
    const b = api.itemBrief(item(853, name))
    ok('guess: ' + name + ' -> ' + path.basename(want), b.customIcon === want, b.customIcon)
  }
  const same = api.itemBrief(item(861, 'Diamond Helmet Custom'))
  ok('guess never overrides a matching base', same.customIcon === '', same.customIcon)
  const vague = api.itemBrief(item(853, 'Mystery Box'))
  ok('guess needs a shape word', vague.customIcon === '', vague.customIcon)
  ok('guessed icon files exist', cases.every(([, w]) => fs.existsSync(path.join(__dirname, 'textures', w))))
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
