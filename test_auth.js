/* The registration/login round:
   - the prompt decides the command (/register for a new account, /login otherwise)
   - that decision survives a reconnect
   - a wrong guess falls back to the other form
   - the web console binds $PORT (Render) and WEB_PORT wins when both exist
   - the per-tick chatter is off unless VERBOSE=on
*/
const fs = require('fs')
const path = require('path')
const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
let pass = 0, fail = 0
const T = (n, c, x) => { if (c) { pass++; console.log('  ok  ' + n) } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  ' + JSON.stringify(x) : '')) } }

// --- 1. the classifier, run for real
const classify = new Function(SRC.slice(SRC.indexOf('function authPromptMode'), SRC.indexOf('function loadEnvFile')) + '; return authPromptMode')()
const cases = [
  ['----=[ REGISTRATION REQUIRED ]=----', 'register'],
  // the countdowns are NOT prompts: answering them early counts as a failed login
  ['Verify your account. Login time: 180s.', 'login-countdown'],
  ['Register time: 179s.', 'register-countdown'],
  ['Please register to join. Register time: 180s.', 'register'],
  ['register with /register <password> <confirmPassword>', 'register'],
  ['Example: /register password15234# password15234#', 'register'],
  ['Command: /register <password>', 'register'],
  ['Please complete authentication.', 'login'],
  ['Command: /login <password>', 'login'],
  ['Hello Sentry_Lord welcome back!', 'login'],
  ['Before you can continue playing on the server,', null],
  ['CWR > Verifying your connection... Please wait. :D', null],
  ['ChatColor > Your color is currently: White!', null],
  ['Your connection was verified successfully.', null]
]
let bad = cases.filter(([t, want]) => classify(t) !== want)
T('every prompt maps to the right command', bad.length === 0, bad)
T('a register prompt never looks like a login prompt', cases.filter(c => c[1] === 'register').every(([t]) => classify(t) !== 'login'))
T('a countdown never triggers a command', /cfg\.auth && !ready && prompt && !countdown && Date\.now\(\) > authCooldownUntil/.test(SRC))

// --- 2. the flow
// --- 1b. someone else's punishment is not our ban
const banInfo = new Function(SRC.slice(SRC.indexOf('function banInfo'), SRC.indexOf('function authReplyInfo')) + '; return banInfo')()
{
  const me = 'Sentry_Lord'
  const real = banInfo('Blacklisted! Reason: player uses wrong password too many times. Try again after: 28 minutes', me)
  T('our own blacklist is honoured', !!real && real.ms > 27 * 60000, real)
  T('a console kick is honoured', !!banInfo('Kicked by Console: you are banned', me))
  const other = banInfo("[!] BINU_MC tempbanned LoginWesaw for 30 days for 'Using unauthorized mods or hacked clients'", me)
  T("another player's tempban is ignored", other === null, other)
  T('a vote broadcast is ignored', banInfo('[!] Vote → iTz has voted for us on MCSL!', me) === null)
  T('a line naming us is honoured', !!banInfo('Sentry_Lord was banned for 30 minutes', me))
  T('every call site passes the player name', (SRC.match(/banInfo\([^)]*cfg\.playerName\)/g) || []).length >= 4)
}

const auth = SRC.slice(SRC.indexOf('const authSucceeded'), SRC.indexOf('/* Sonar verification arena'))
{
  const iReg = auth.indexOf('ask(`/register ${pw} ${pw}`')
  const iLog = auth.indexOf('ask(`/login ${pw}`')
  T('register is sent before login when the account is new', iReg >= 0 && iLog > iReg, { iReg, iLog })
}
T('the register step only runs when the prompt said register', /const registerFirst = authPlan === 'register'/.test(auth) && /if \(registerFirst\) \{/.test(auth))
T('the decision survives a reconnect', /let authPlan = null/.test(SRC) && /authPlan = prompt/.test(SRC) && /if \(mode\) authPlan = mode/.test(auth))
T('a failed attempt tries the other form', /trying \/register \(the account may be new\)/.test(auth))
T('success is judged on auth chat, not only "login was successful"', /authSucceeded/.test(auth) && /already logged in/.test(auth))
T('repeated failure reconnects rather than sitting unauthenticated', /reconnecting for a clean session/.test(auth))
T('a session that dies mid-auth hands the work to the next session', /the next session picks this up/.test(auth))

// --- 2b. what the server says back
const reply = new Function(SRC.slice(SRC.indexOf('function authReplyInfo'), SRC.indexOf('function loadEnvFile')) + '; return authReplyInfo')()
const expectReply = [
  ['You are already registered!', 'already'],
  ['You are not registered!', 'notreg'],
  ['Wrong password!', 'badpass'],
  ['Your password is too short, minimum 8 characters', 'rule'],
  ['Your login was successful', 'ok'],
  ['Successfully registered', 'ok'],
  ['Please register to join. Register time: 180s.', null]
]
T('the reply tells us what went wrong', expectReply.every(([t, k]) => (reply(t) || {}).kind === (k || undefined)), expectReply.filter(([t, k]) => (reply(t) || {}).kind !== (k || undefined)))

// --- 2c. bans
const ban = new Function(SRC.slice(SRC.indexOf('function banInfo'), SRC.indexOf('function authReplyInfo')) + '; return banInfo')()
T('a "wrong password too many times" kick is a ban', (ban('Kicked by Console: Reason: player uses wrong password too many times.') || {}).ms > 0)
T('the stated wait is honoured', Math.round(ban('Blacklisted! Try again after: 29 minutes').ms / 60000) === 29)
T('hours work too', Math.round(ban('Blacklisted! Try again after: 2 hours').ms / 60000) === 120)
T('an ordinary kick is not a ban', ban('Your connection was verified successfully.') === null && ban('You are not whitelisted') === null)
T('the bot waits the ban out instead of retrying', /waiting \$\{Math\.round\(waitMs \/ 60000\)\} min/.test(SRC))
T('the reconnect loop refuses to start a session during a ban', /if \(banUntil && banUntil > Date\.now\(\)\)/.test(SRC))
T('a ban is caught in chat, in kick, and in the login disconnect', (SRC.match(/banUntil = Date\.now\(\) \+ /g) || []).length >= 3, (SRC.match(/banUntil = Date\.now\(\) \+ /g) || []).length)
T('a bad password stops the retry loop', /giving up on this password/.test(SRC))

// --- 2d. the login countdown must not be answered
T('the pre-auth countdown is classified apart from a real prompt',
  classify('Verify your account. Login time: 180s.') === 'login-countdown' &&
  classify('----=[ Authentication Required ]=----') === 'login')
T('a countdown still records which auth is coming', /if \(!authPlan\) authPlan = prompt === 'register-countdown'/.test(SRC))

// --- 3. the port
const portBody = SRC.match(/webPort: \(\(\) => \{([\s\S]*?)\}\)\(\)/)[1]
const portOf = new Function('ENV', 'return (() => {' + portBody + '})()')
T('8080 is the local default', portOf({}) === 8080)

// $PORT must beat a stale WEB_PORT from .env, or a host's port check fails
const portHosted = new Function('process', 'ENV', 'return (() => {' + portBody + '})()')
T('$PORT beats WEB_PORT from .env', portHosted({ env: { PORT: '10000' } }, { WEB_PORT: '8080' }) === 10000)
T('WEB_PORT in the real environment beats $PORT', portHosted({ env: { WEB_PORT: '9000', PORT: '10000' } }, {}) === 9000)
T('.env WEB_PORT is still used locally', portHosted({ env: {} }, { WEB_PORT: '8080' }) === 8080)

// --- 3b. no console, but the host still needs an open port
T('WEB=off on a host opens a health port', /else if \(ENV\.PORT\) startHealthPort\(cfg\.webPort\)/.test(SRC))
T('the health port serves nothing but health', /not here/.test(SRC) && /healthz/.test(SRC))

// --- 3b. the trigger and its feedback
T('the server reply to each auth command is logged', /auth: server replied to \$\{cmd\.split\(' '\)\[0\]\}/.test(SRC))
T('a repeated prompt re-triggers a stuck attempt', /const stuck = authBusy && Date\.now\(\) - authStartedAt > 45000/.test(SRC))
T('prompts are rate limited so a silent failure cannot spin', /authCooldownUntil = Date\.now\(\) \+ 8000/.test(SRC))
T('the build is printed even with WEB=off', /log\(`build \$\{BUILD\}/.test(SRC.slice(SRC.indexOf('async function main'), SRC.indexOf('function startTerminal'))))

// --- 3c. surviving a slow host
T('chunk decoding is queued, not inline in the packet handler', /enqueueChunk\(params\.x, params\.z, params\.chunkData\)/.test(SRC) && !/try \{ parseChunkData\(params\.x/.test(SRC))
T('the chunk queue is time-sliced so timers still run', /Date\.now\(\) - t0 < 8/.test(SRC) && /setTimeout\(step, 0\)/.test(SRC))
T('the chunk queue is bounded', /chunkQueue\.length > 64/.test(SRC))
// a full view distance is 300-800 chunks at ~16ms each: decoding all of them
// saturated the loop long enough for a server transfer to stall, so only the
// chunks the bot stands in (and the ones it teleports to) are decoded
T('only chunks near the bot are decoded', /const near = Math\.abs\(x - pcx\) <= 3 && Math\.abs\(z - pcz\) <= 3/.test(SRC))
T('chunks at a verification teleport target are decoded too', /player\.tpTargets/.test(SRC) && /if \(!wanted\) \{ chunkSkipped\+\+; return \}/.test(SRC))
T('skipped chunks are counted, not silently forgotten', /chunks: parsed \$\{chunkParsed\}/.test(SRC))
T('chunk decoding cost is measured', /chunkMs \+= Date\.now\(\) - t1/.test(SRC))

// --- the reason the transfer died: play packets leaking into the configuration stream
// Velocity flips its decoder to CONFIG the moment it writes start_configuration, so any
// play packet we emit afterwards is decoded as a config packet (ids 0x00-0x05 are real
// there) and forwarded raw to the backend, which is also in CONFIG — it drops us.
T('no play packet can be written outside the play state',
  /if \(dirState === 'play' && state !== 'play'\)/.test(SRC) && /blocked a play packet/.test(SRC))
T('the guard is counted, not silent', /playWhileConfig = \(playWhileConfig \|\| 0\) \+ 1/.test(SRC))
T('the movement tick does not run in configuration', /const playing = state === 'play' && verifyDone/.test(SRC))
T('the heartbeat does not run in configuration', /heartbeat = setInterval\(\(\) => \{\n\s*if \(state !== 'play'\) return/.test(SRC))
T('queued tick frames are flushed before the ack', /const frames = tickBatch; tickBatch = null[\s\S]{0,400}configuration_acknowledged/.test(SRC))

// --- the transfer that used to die at 30s
T('every configuration packet is logged by name', /if \(state === 'configuration'\) cfgLog\(/.test(SRC))
T('the configuration census says how many of each arrived', /config rx: \$\{name\} \(\$\{n\}x\) len=\$\{len\}/.test(SRC))
T('the transfer watchdog waits minutes, not seconds', /const transferMs = /.test(SRC) && /n > 0 \? n : 120000/.test(SRC) && /cfgWatch = setTimeout/.test(SRC))
T('it reports progress while the proxy swaps backends', /still transferring \(\$\{s2\}s\)/.test(SRC) && /}, 15000\)/.test(SRC))
T('a stalled transfer lists what did arrive', /did not complete in \$\{Math\.round\(transferMs \/ 1000\)\}s \(got: \$\{seen\}\)/.test(SRC))
T('brand + client settings are re-sent when the transfer is slow', /reconfNudge\('start of the transfer'\)/.test(SRC) && /10s, the transfer is slow/.test(SRC))
T('event-loop lag is measured and reported', /stall: the event loop was blocked/.test(SRC))
T('a dead socket is detected by silence', /no packet for \$\{Math\.round\(\(Date\.now\(\) - lastRx\) \/ 1000\)\}s/.test(SRC) && /Date\.now\(\) - lastRx > 90000/.test(SRC))
T('a heartbeat line proves the bot is alive', /alive — up \$\{Math\.round/.test(SRC))
T('inbound and outbound packets are counted', /rxN\+\+/.test(SRC) && /txN\+\+/.test(SRC))
T('liveness timers are cleared with the session', /clearLiveness && clearLiveness\(\)/.test(SRC))

// --- 4. log volume
T('verbose is off unless asked for', /verbose: \/\^\(on\|true\|yes\|1\)\$\/i\.test\(ENV\.VERBOSE \|\| ''\)/.test(SRC))
const gated = (SRC.match(/if \(cfg\.verbose/g) || []).length
T('the per-tick chatter is behind VERBOSE', gated >= 5, gated)
{
  // nothing that the verification arena depends on may sit behind VERBOSE
  const sonar = SRC.split('\n').filter(l => /sonar:/.test(l))
  T('verification logs are never gated', sonar.length > 20 && !sonar.some(l => /cfg\.verbose/.test(l)), sonar.filter(l => /cfg\.verbose/.test(l)).length + '/' + sonar.length)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
