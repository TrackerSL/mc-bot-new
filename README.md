# CWR Bot — one-file version (no Java, no game window)

This is the whole bot as ONE small program. No Minecraft game window, no
virtual box, no extra screens — the game runs inside this console.
Everything the game would show (server chat, login prompts, kicks) is
printed right here, and anything you type is sent to the game.

## How to start (Windows PowerShell)

    npm.cmd start

That's it. It reads the .env file in the same folder and connects.

## The .env file (10 settings)

    PLAYER_NAME=Lactgen_Plus        your Minecraft name
    SERVER_IP=mc.cwresports.lk      server address
    SERVER_PORT=25565               server port
    PASSWORD=...                    your server password (used for /register and /login)
    AUTH=on                         on = bot answers the login/register prompts by itself
    ANTI_AFK=on                     on = vanilla walk/look/hop actions; off = stand still
    CMD_DELAY_MS=5000               how long to wait before sending each command (5 seconds)
    WEB=on                          on = web inventory/GUI console; off = no web console at all
    WEB_PORT=8080                   port of the web console (only used when WEB=on)
    CMDS=/queue lifesteal,/afk      commands to run automatically after you are in game
    TRANSFER_WAIT_MS=120000         how long to wait for a /queue transfer (2 min; see below)

Change any of these in Notepad, save, restart with npm.cmd start.

## Web inventory & GUI console

While the bot runs, open http://localhost:8080/ (or the host's IP:8080) in a
browser to see the bot's inventory live, plus any chest/GUI the server opens
for it.

- Left click a slot = pick up / place the whole stack (like vanilla).
- Right click = pick up half / place one item.
- "close GUI" closes the open window, same as pressing Esc.
- The page refreshes itself every second; the anti-afk state and the bot's
  position show in the status bar.
- No password — do not expose the port to the internet.

## Using it while it runs

- Type anything and press Enter — it is sent to the game chat.
- Commands starting with / go out as commands (for example /lifesteal).
- :queue   — show the command queue
- :help    — show help
- :quit    — stop the bot

When someone writes @Lactgen_Plus in chat, that line is marked with a ★ so
you can spot mentions easily.

## If you see "Verification failed"

The server puts new/unverified players through a short anti-bot test
(the login name shows up as "Sonar" while it runs). This bot answers
the test itself, exactly like the real game would: it steps through the
teleport, the fall onto the platform, the swing and held-item checks,
and the boat/minecart ride — you will see progress lines in the console
like `sonar: probe teleport`, `sonar: landed`, `sonar: swing echo sent`,
and finally `sonar: verification complete`. After that you are in the
lobby as a normal player.

The arena is **not the same room on every join**. Each attempt builds its
own obstacle out of a single block type (a smooth-stone slab plate, a
cobblestone wall, an end-portal frame, ...) delivered as one
`multi_block_change` packet. A fixed "fall 3.5 blocks and stop" answer
therefore lands in the wrong place on most joins. This build rebuilds those
blocks into its own world and runs the descent through the real 1.20.4
collision shapes (`block_shapes.json`), so the player stops on whatever
surface the server actually placed — exactly like the game.

Waits are tunable in `.env` if you want to experiment:

| key | default | meaning |
|-----|---------|---------|
| `SONAR_CONFIRM_MS` | 800 | first teleport confirm after the drop (terrain load) |
| `SONAR_CONFIRM_GAP_MS` | 5 | delay before the second confirm |
| `SONAR_LOAD_PAUSE_MS` | 3900 | pause after the echo before the fall starts |
| `SONAR_FALL_MS` | 10 | per-frame descent cadence |
| `SONAR_FLOOR_DROP` | 2.5 | fallback landing plane when the world is unknown |

If the test fails, the bot retries by itself: about 15 seconds after a
failed verification, 45 seconds if the server says "blocked from
entering". Note the block is **server-side and sticky**: every retry while
it is still up can extend it, so on a failed attempt it is better to leave
the bot stopped for ten minutes than to let it hammer the gate.

## Notes

- First time on the server the bot registers itself automatically; after
  that it logs in automatically (that is what AUTH=on does).
- The bot only speaks when you tell it to (typed lines and the CMDS
  queue). It never chats on its own.
- If /login ever says the password is wrong, edit PASSWORD= in .env to
  the password you used when you registered that account.

## Files

- `server.js` — the whole client+server (zero dependencies)
- `protocol.json` — Minecraft 1.20.4 (protocol 765) packet definitions
- `blocks1204.json` — coarse block collision table (1.20.4 state-id ranges → air/solid/slab)
- `block_shapes.json` — exact 1.20.4 collision boxes for every block state (used by the verification descent)
- `block_names.json` — state-id → block name table (1.20.4)

## Web console

`WEB=on` (default) starts the browser UI on `WEB_PORT` (default 8080):

* **inventory** - armour column, 2x2 crafting + result, offhand, main inventory and
  hotbar, drawn like the vanilla screen (no player model, no recipe book).
* **containers** - any open GUI (chest / ender chest / shop / furnace / crafting
  table): the window's own title, its slot grid, then an `Inventory` section below.
* **real item art** - every icon is the actual 1.20.4 texture, extracted from the
  client assets into `textures/` and served locally by the bot (`/tex/...`), so icons
  work offline, instantly, with no CDN.
* **hover tooltips** - the item's in-game display name (custom codes included),
  enchantments (`Sharpness V`), lore lines and the registry key.
* **chat** - the chat button opens a message log plus an input: type a message or a
  `/command`. Server chat, verification messages and your own lines all show up there.
* clicking works exactly like the vanilla container screen: LMB/RMB, drag-paint,
  double-click gather, shift-click quick-move, `1`-`9` hotbar swap, `F` offhand,
  `Q`/shift+`Q` drop.

Files behind it: `page.html` (the UI), `items1204.json` (protocol item id -> name),
`item_tex.json` (item -> texture resolved through the vanilla model chain),
`textures/` (item, block and a few entity textures). `build_preview.js` renders
`ui-preview.html`, a standalone demo of the UI with inlined textures.

## Debug knobs

`SONAR_VERBOSE=1` prints the arena terrain sweeps; everything else is quiet by default.

## Item art: local first, mirror second

`items1204.json` is the **1.20.4** item registry (1254 ids, `{"<id>":{"n","k"}}`) and
`item_tex.json` maps each registry name to a file under `textures/`. The web console
serves those at `/tex/...`.

If a texture file is missing (or `textures/` was not extracted), the page falls back to
the public asset mirrors in this order, from the browser:

1. `/tex/<kind>/<file>.png` (what ships in the zip)
2. `https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@1.20.4/...`
3. `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.20.4/...`

So a slot only shows a letter tile when the item id is unknown to the 1.20.4 registry
*and* both mirrors miss. The startup line prints how many item textures were found.

## Tests

`npm test` runs protocol (35), clicks (43), wire-click (14), UI (20) and inventory
sync (15). `test_inv.js` is the regression guard for the container-close bug: window 0's
layout is 0 result, 1-4 craft, 5-8 armour, 9-35 main, 36-44 hotbar, 45 offhand, and a
container's trailing 36 slots are main then hotbar - never 0-8.

## The item registry, and the mistake that cost two rounds

`items1204.json` is the **true 1.20.4 (protocol 765) registry: 1312 ids**. Two things to
know before touching it:

* 1.20.3/1.20.4 registered the *experimental* 1.21 items, so tuff slabs/stairs/walls sit at
  **ids 13-23**, together with the crafter, breeze spawn egg and trial spawner. A table
  without them is the 1.20 table and is shifted by ~58 ids everywhere after slot 12.
* That shift is exactly what shipped for two rounds. A real 1.20.4 client in the hub draws
  ids 921 / 946 / 1103 / 853 as paper, lime dye, nether star and a leather cap; the shifted
  table decoded them as bone, melon seeds, end crystal and a mangrove sign. If a kit item
  ever looks absurd again, check these four ids first (`npm test` asserts them).

The colour pipeline never caused it either: ids were wrong, not textures.

### What actually was broken at the start

`server.js` read `items1204.json` / `item_tex.json` with `fs`/`path` *above* the lines that
declare them, so the read threw a `ReferenceError` into an empty `catch {}` and the registry
was `{}` at runtime. That is why every slot showed an initials tile and no name resolved.
`fs`/`path` are hoisted now, the load is fatal-if-empty, and `test_items.js` fails if
anything above the declarations touches them.

## Verifying what you are running

The header shows `build 2026-11-04d · 1254 ids · 587 tex`, `GET /api/build` returns the
same as JSON, and the terminal prints the line at startup. If your UI does not show the
build chip, you are serving an older `page.html`.

## Chat colours

The server sends colours as hex components (`{"color":"#FFADAD","text":"C"}`, sometimes
one per character) and formatting as NBT bytes (`"bold":1`). `legacyOf` maps named colours
to `§` codes and hex to the 5-character `§#RRGGBB` form, which `page.html` renders as an
exact inline colour. `DEBUG_CHAT=1 npm start` appends every chat packet as received to
`chatraw.jsonl`, which is how the mapping was checked against real traffic.

## Missing textures

`/tex/<path>` serves the file from `textures/`. If it is not on disk the bot downloads it
from the public 1.20.4 asset mirrors, writes it into `textures/` and serves that copy, so
the browser never needs internet access and an incomplete extraction still shows real art.

## ICON_GUESS (optional, off by default)

`ICON_GUESS=1` lets a custom name pick the icon ("MEMBER Helmet" -> iron helmet art) for
servers that really do disguise an item behind an unrelated base material. It is off by
default because with the correct registry the base material *is* the answer: enabling it
while the id table was shifted is what turned a leather cap into a mangrove sign.
`ICON_GUESS=1 node test_icons.js` exercises that path.

## Clicking the inventory (vanilla semantics)

A press does the whole action, like the game — the stack is picked up on the press and
**stays on the cursor** until you click again, no button held:

| gesture | what happens |
|---|---|
| LMB on an item, cursor empty | the stack goes onto the cursor (drawn hanging off the pointer) |
| LMB with a stack, on an empty slot | the stack is placed |
| LMB with a stack, on the same item | merged up to that item's stack limit |
| LMB with a stack, on another item | swapped |
| RMB | half of the slot, or one item in |
| double click while holding | gathers every matching item |
| shift + click | quick move between inventory and container |
| `1`-`9` / `F` | swap with that hotbar slot / the offhand |
| `Q` / shift+`Q` | drop one / drop the stack |
| click outside the slots | throw the carried stack |

The result is predicted locally and painted on the same frame, then reconciled against
`/api/state`; a move the server refuses is dropped and the UI says so instead of silently
snapping back. If the server never agrees (`slotsMatch` keeps failing), the prediction is
discarded after 1.5 s.

Two bugs this replaced: clicks used to fire on *release*, and an `inflight` guard silently
discarded any click made while another was on the wire, so a quick pick-up/put-down lost
the second half. Clicks are now queued and sent in order.

Containers also carry their own `stateId` now. Window-0 packets used to overwrite the
shared one, so every click inside a chest went out with a stale counter (the server answers
those with a full resync and ignores the click). Visible in the log as
`web: click win=1 slot=0 btn=0 mode=0 state=1`.

`POST /api/use` right-clicks the held item in the air (there is a "use held item" button in
the console) — that is how the bot opens server menus itself.

## Staying up (the crash and the config stall)

Two failures that used to take the bot down or strand it:

**It could die mid-login.** `/login`, `/register` and the second `/login` are separated by
5s and 3.5s sleeps. If the socket died inside one of those windows, the next `SESSION_SEND`
was called with the client no longer in the play state and threw — inside an async function
nobody awaited, so Node exited. Three layers now stop that:

* `SESSION_SEND` never throws. It returns `false` when the client is not in play, and the
  caller decides (queued commands are handed to the next session instead of lost).
* auth remembers the session it started in (`sessionGen`) and aborts instead of sending into
  a dead socket; if the server never confirms, it retries twice 10s apart and then reconnects
  for a clean session rather than sitting unauthenticated forever.
* `uncaughtException` / `unhandledRejection` are logged as `!! … — continuing`. Every session
  already has its own reconnect loop, so nothing is gained by exiting.

**It stalled on the transfer to another backend.** `/queue lifesteal` makes the proxy send
`start_configuration` while you are in play. A real player transfers in about a second; the bot
sometimes sat there for 45 seconds and then reconnected, losing the queue position.

The cause was ours, and it is the kind of bug only a hand-written client can have. Velocity (the
proxy in front of CWR) switches its **decoder** to the configuration table the instant it writes
`start_configuration` — `switchToConfigState()` writes the packet and then calls
`setState(StateRegistry.CONFIG)`. Our client, meanwhile, kept running its 50ms movement tick and
its 1s idle heartbeat, which are gated on *"am I in the world"* rather than *"is this connection in
play"*. So for the second the transfer took, the bot was still writing play packets into a stream
the proxy was already reading as configuration.

That matters because in the configuration state the serverbound ids `0x00`-`0x05` are real packets
(`settings`, `custom_payload`, `finish_configuration`, `keep_alive`, `pong`, `resource_pack_receive`).
A stray play packet therefore decodes as one of those, with a garbage body, and Velocity forwards
unknown configuration packets **verbatim to the backend connection** (`ClientConfigSessionHandler.
handleUnknown`), which is itself in configuration by then. The backend reads an id it does not know
and drops the player. That is exactly the symptom: after the ack we got `brand` and `feature_flags`
and then nothing at all — not even keep-alives — while the proxy still thought everything was fine.

Whether it happened at all depended on whether a tick or a heartbeat landed inside that window,
which is why it looked random and why waiting longer never helped: once the backend had dropped us,
nothing was ever going to arrive.

Three guards now make that impossible:

* `pkt()` refuses to encode a play packet unless the connection is actually in play. Anything that
  tries is counted and logged, once, as
  `!! blocked a play packet (position_look) while in configuration — a vanilla client never sends this`.
* The movement tick requires `state === 'play'` (not just "verified and in the world"), and the idle
  heartbeat returns immediately outside play.
* Whatever is already batched is flushed **before** the ack, so nothing of ours can cross the
  boundary after it.

A transfer now looks like this, with no play packets in between:

```
[bot] sent [/queue lifesteal]
chat: Sending you to lifesteal now..
[bot] server requested re-configuration — acknowledged
[bot] reconfig: start of the transfer — resent brand + client settings
[bot] configuration done — entering play
[bot] joined world (entity 1664911, mode 2)
[bot] verified [/queue lifesteal] — lifesteal join
```

`TRACE=on` in `.env` logs every packet in both directions, so a transfer can be compared
packet-for-packet (`trace 13:07:35.601 tx [configuration] finish_configuration len=1`).

The watchdog is still there as a safety net, but it is patient now: it prints
`reconfig: still transferring (15s)` every 15s and only reconnects after 120s
(`TRANSFER_WAIT_MS`). Reconnecting earlier only threw away the queue position.

Two other things that were fixed at the same time and are worth knowing about:

* **Chunk decoding is limited to what the bot uses.** A chunk costs ~16ms; a full view distance is
  300-800 of them, and on Render's free CPU that alone can eat the first half-minute of a session.
  Only chunks within ±3 of the bot (and the ones it teleports to) are decoded now:
  `chunks: parsed 26 (414ms, 15.9ms each), skipped 381 far ones (not needed for collision)`.
* **Chat captchas are answered.** CWR sometimes answers a login with
  `[!] To log in, solve the captcha: /captcha 69ss98uq`; the bot now sends it back. Ignoring it looks
  exactly like a wrong password, and repeated wrong passwords end in a 28-minute blacklist.

## Auth: /register vs /login

The server says which one it wants, and the two prompts look nothing alike:

```
----=[ REGISTRATION REQUIRED ]=----        <- new account  -> /register <pw> <pw> then /login
register with /register <password> <confirmPassword>

----=[ Authentication Required ]=----      <- known account -> /login <pw>
Command: /login <password>
```

`authPromptMode()` reads the prompt and remembers the answer in `authPlan`, which lives
**outside** the session, so a reconnect does not walk a new account back into `/login`.
If the guess is wrong the other form is tried once, then the attempt repeats twice more 10s
apart, then the session restarts rather than sitting unauthenticated forever.

## Hosting it (Render)

Two things bite on a PaaS:

* **The port.** A Render *web service* must bind the port in `$PORT`. `WEB_PORT` unset now
  falls back to `$PORT`, then 8080. If you run it as a **background worker** instead, set
  `WEB=off` — nothing needs to listen and Render stops scanning for a port.
* **CPU.** On a free 0.1-CPU instance the per-tick logging alone can starve the event loop;
  the client then stops answering keep-alives and the server kicks it with
  `ReadTimeoutException`. The chatty lines (`send#`, `ground flip`, `chunk recv`,
  `render: see entity`, `state x=`) are now behind `VERBOSE=on` and off by default.

### What the bot does with those prompts

1. Every server chat line is classified: `register` prompt, `login` prompt, or neither
   (`authPromptMode`). A register prompt wins — the missing half of the old code.
2. The matching command waits `CMD_DELAY_MS` (your 5000 ms), then goes out:
   `/register <pw> <pw>` + `/login <pw>`, or `/login <pw>`.
3. Whatever the server answers within the next few seconds is logged, so the failure is
   visible instead of silent:

   ```
   [bot] auth: registering (/register) — the server asked a new account to register
   [bot] auth: server replied to /register: … please complete authentication. | Command: /login <password>
   [bot] auth: server replied to /login: … Your login was successful | Login successful.
   [bot] auth: logged in
   ```

   The reply is also acted on: *already registered* switches to `/login`, *not registered*
   switches to `/register`, *wrong password* / *password must contain…* stops the retries
   (more attempts only walk toward a ban) and says which one it was.
4. Prompts repeat about once a second. The first one triggers; a later one re-triggers only
   after an 8 s cooldown, and an attempt that has gone quiet for 45 s is abandoned so a
   silent failure cannot spin forever.
5. Bans are obeyed. CWR answers repeated bad logins with
   `Blacklisted! … Try again after: 29 minutes`, delivered as a kick *or* a login-state
   disconnect or plain chat. All three are parsed, and the reconnect loop sleeps the stated
   time instead of knocking again (knocking again extends it). Seen live:

   ```
   [bot] blacklisted by the server — waiting 26 min (Blacklisted! … Try again after: 26 minutes)
   [bot] session (banned) — waiting 26 min, then reconnecting
   ```

### Hosted on Render (or any PaaS)

`No open ports detected … Port scan timeout reached. Bind your service to at least one
port` is not cosmetic. Render treats an unbound container as unhealthy: it keeps scanning,
throttles it, and the CPU gets suspended in bursts. Symptom in the bot log: a ~60 s gap
with everything arriving in one burst, then `kicked: ReadTimeoutException` — the client
was alive but frozen, so it never answered the server's keep-alives.

Three things fix it, and all three are in the code now:

* `WEB=off` **plus** a `$PORT` from the host → the bot opens that port with a health
  endpoint and nothing else (`GET /` or `/healthz` → `{"ok":true,"build":…}`; everything
  else 404). The console stays off, the host stays happy.
* `$PORT` now beats a stale `WEB_PORT` in `.env` (order: env `WEB_PORT` > `$PORT` > `.env`
  `WEB_PORT` > 8080). Before, a leftover `WEB_PORT=8080` silently kept the service on the
  wrong port.
* Deploying as a **background worker** also works — nothing binds a port, and Render does
  not scan for one. Then `WEB=off` with no `$PORT` prints the plain "no port bound" line.

`VERBOSE=off` (the default) matters for the same reason: on a 0.1-CPU instance the per-tick
lines are enough to starve timers, and a starved client stops answering keep-alives.

### The two countdowns

The server prints `Verify your account. Login time: 180s.` **before** it asks for anything.
That is a countdown, not a prompt — answering it early is a failed login, and enough of them
earn the `wrong password too many times` blacklist. `authPromptMode` classifies those as
`login-countdown` / `register-countdown`: they record which auth is coming, and never fire a
command. Only the real requests do:

```
----=[ Authentication Required ]=----   /  Command: /login <password>   /  welcome back
----=[ REGISTRATION REQUIRED ]=----      /  register with /register …
```

### "It's paused" — telling a frozen host from a broken bot

Build `2026-11-04h` makes that question answerable from the log alone:

```
[bot] alive — up 2m, rx 16195, tx 2298, lag 0.0s max          <- every 60s
[bot] stall: the event loop was blocked 4.2s — the host is throttling CPU
[bot] no packet for 91s — the connection looks dead, reconnecting
[bot] chunk queue: dropped 69 far chunks (the client was behind)
```

* `alive` proves the process is running and shipping packets.
* `stall` means the container got no CPU — a host problem, not a protocol one.
* `no packet` means the socket went quiet and the session is restarted instead of hanging.
* `chunk queue` is the fix that keeps the loop breathing: chunk decoding is queued and
  time-sliced (≤8 ms per turn, then yield), so a 200-chunk burst no longer blocks
  keep-alives. A live run logged `dropped 69 far chunks` and `lag 0.0s max`.

On a free Render web service also add an uptime pinger (UptimeRobot, cron-job.org …) on
`https://<service>.onrender.com/healthz` every 5–10 minutes: free instances spin down
after a stretch without inbound HTTP, and a spinning-down container cannot hold a
Minecraft session.
