# Web control — vanilla container semantics

The web console is not a "click a slot, hope for the best" UI: it is a port of the
1.20.4 client's own container code, so the Click Container packets it sends are the
same ones a real client would send, with the same `changed_slots` predictions.

## What was ported (source of truth: decompiled 1.20.4 client)

| Vanilla class | Ported into `server.js` |
| --- | --- |
| `AbstractContainerMenu.doClick` | `doClickSim()` — all click types |
| `AbstractContainerMenu.moveItemStackTo` | `qmMove()` — two-pass merge / first-empty |
| per-menu `quickMoveStack` overrides | `quickMoveOnce()` — chest / inventory / crafting / furnace / hopper / generic orders |
| `MultiPlayerGameMode.handleContainerInput` | `predictClick()` — snapshot → click → diff → `changed_slots` |
| `ItemStack.getMaxStackSize` | `maxStackOf()` + the 221-entry stack table from the item registry |
| `AbstractContainerScreen.mouseClicked/mouseDragged/mouseReleased` | the page's `press()` / pointer-move collector / `release()` |

## Controls (identical to the game)

| Input | Sent |
| --- | --- |
| Left click | PICKUP `0`, button 0 — pick up / place stack, merge up to the item's max, else swap |
| Right click | PICKUP `0`, button 1 — pick up half (rounded up) / place one / merge one |
| Shift + click | QUICK_MOVE `1` — vanilla transfer order per menu family |
| Drag with a held stack | QUICK_CRAFT `5` — START + one packet per painted slot + END, **batched in one tick**, left = even split, right = one per slot; a one-slot drag is replayed by the server as a plain click |
| Double click an empty slot while holding | PICKUP_ALL `6` — two-pass gather; shift+double-click quick-moves every matching stack |
| Click outside the menu | PICKUP `0` at slot `-999` — drop the whole carried stack (right = drop one) |
| `1`–`9` over a slot | SWAP `2`, button 0–8 — swap with that hotbar slot; over-limit stacks are split back |
| `F` over a slot | SWAP `2`, button 40 — offhand swap |
| `Q` over a slot | THROW `4`, button 0 — drop one |
| `Shift` + `Q` | THROW `4`, button 1 — drop the stack |

Screen timing mirrors vanilla: with an empty cursor the packet leaves on **press**;
while carrying, pressing only starts a drag and the drag packets are sent together on
**release**; a double-click is judged at press (>250 ms, same slot, same button) and
acted on at release.

## Endpoints

```
GET  /                     the console page
GET  /api/state            connected, player, cursor, cursorRaw, inv[46], lay, stateId,
                           gui{id,type,menu,title,size,stateId,lay,slots[]}
POST /api/click            {windowId, slot, button, mode}
POST /api/click_batch      {windowId, clicks:[{slot,button,mode}]}   one tick, one stateId
POST /api/creative         {slot, itemId, count}                     creative mode only
POST /api/use_block        {x, y, z, face}                           use an item on a block (opens chests)
POST /api/held             {slot}                                    hotbar selection 0-8
POST /api/close            close the open container
```

Buttons are validated per mode, from `doClick`: PICKUP/QUICK_MOVE/THROW accept 0-1,
SWAP accepts 0-8 and 40 (offhand), QUICK_CRAFT accepts 0-10 (stage | type<<2).

`slot: -999` is the outside-the-menu slot (legal for PICKUP and QUICK_CRAFT).
Modes: 0 PICKUP, 1 QUICK_MOVE, 2 SWAP, 4 THROW, 5 QUICK_CRAFT, 6 PICKUP_ALL
(3 CLONE is creative-only and never sent).

## Verification (all green)

| Suite | Result | What it proves |
| --- | --- | --- |
| `node test_clicks.js` | **43/43** | engine semantics against the decompiled source: half-pick rounding, merge caps, stack limits (pearls 16, swords 1), shift-click direction per family, hotbar/offhand swap, drag split maths, double-click two passes, result-slot exclusion, NBT round-trip, `changed_slots` diff |
| `node test_protocol.js` | **35/35** | framing, varints, offline UUID, slot + unnamed-NBT round-trips, window packets, chat flattening |
| `node test_wire_click.js` | **14/14** | Click Container bytes field by field (id 13, `-999` as an i16, carried NBT echoed verbatim) |
| `node test_ui.js` (jsdom, uses `page.html`) | **20/20** | the page's press/drag/release machine: packet-on-press vs packet-on-release, drag batching, drag gating, double-click, outside click, Q/shift+Q, digits, F, chest layout |
| `node test_live.js` | **33/33** | **live against a real 1.20.4 server** (offline-mode, creative): every click type, plus a chest opened over the protocol and its shift-click direction |

`test_live.js` seeds a known inventory before every block, so it is idempotent. It needs a
creative-mode server; point it at the console with `node test_live.js http://host:port`.

### Notes from live testing

* The server only answers a click when it *disagrees* with the prediction (Set Container
  Slot) or when the stateId is stale (full Set Container Content). A click sent before the
  previous update lands is therefore ignored — the same race a vanilla client has. The page
  serialises clicks and re-reads state after each one; scripts should sleep ~150 ms.
* One real bug this caught: `button 40` (offhand swap) was rejected by an over-strict
  validator, so `F` never reached the server. Validation is now per click mode.
* A second one: unnamed (`anon`) container fields were dropped by the codec, so slot
  `itemId`/`itemCount` were lost in *both* directions. Fixed generically in the reader and
  the writer, and covered by `test_protocol.js`.
* Furnace-family shift-click from a player slot needs recipe knowledge (smeltable vs fuel)
  that a client without recipes cannot have; we approximate, and the server's correction is
  the safety net. Container→player directions are exact.
