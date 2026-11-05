/* Regression tests for the crash/robustness round:
   - SESSION_SEND must never throw (a session can end between two awaits)
   - auth must not send into a dead session, must retry within bounds, then pause
   - a server re-configuration must be answered with the full handshake
   - the process must survive an exception instead of exiting
*/
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const FLOW = fs.readFileSync(path.join(__dirname, 'auth_flow.js'), 'utf8')
const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8')
let pass = 0, fail = 0
const T = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')) }
}

// --- 1. the send path
const sendBody = SRC.slice(SRC.indexOf('SESSION_SEND = text => {'), SRC.indexOf("socket.on('data', feed)"))
T('SESSION_SEND no longer throws when the session is gone',
  /if \(state !== 'play'\) \{ sendBlocked = \(sendBlocked \|\| 0\) \+ 1; return false \}/.test(sendBody) &&
  !/throw/.test(sendBody))
T('a queued command that loses its session is kept, not thrown',
  /if \(SESSION_SEND\(item\.text\) === false\)/.test(SRC))
T('SESSION_SEND reports success in the play state', /return true\n    \}\n\n    socket\.on\('data', feed\)/.test(SRC))
T('the default SESSION_SEND is a no-op, not a throw',
  /let SESSION_SEND = \(\) => false/.test(SRC))
T('web chat surfaces "not in play" instead of crashing',
  /if \(SESSION_SEND\(text\) === false\) throw new Error\('not in play right now/.test(SRC))

// --- 2. auth
T('auth remembers its exact session generation', SRC.includes('const authSessionGen = sessionGen') && SRC.includes('authSessionGen === sessionGen && !ended'))
T('every auth send rechecks active session after waits', FLOW.includes('while(this.alive())') && FLOW.includes('await this.sleep(delay);continue;'))
T('auth retries are bounded', FLOW.includes('attempt<=3') && FLOW.includes('counts[mode]>=3'))
T('a failed auth pauses without a speculative reconnect', SRC.includes('no automatic login/register loop') && !SRC.includes('auth: reconnecting for a clean session'))
T('auth attempts are serialised', /let authBusy = false/.test(SRC) && /let authStartedAt = 0/.test(SRC) && !/authStarted\b(?!At)/.test(SRC))

// --- 3. re-configuration handshake
T('re-configuration resends brand + client settings', /configuration', 'custom_payload', \{ channel: 'minecraft:brand'/.test(SRC) &&
  /configuration', 'settings', clientInfo\(\)/.test(SRC))
T('re-configuration is nudged again at 10s if the transfer is slow', /reconfNudge\('10s, the transfer is slow'\), 10000\)/.test(SRC))
T('a stalled transfer is patient, then reconnects', /const transferMs = /.test(SRC) && /n > 0 \? n : 120000/.test(SRC) && /finish\('restart'\)/.test(SRC))

// --- 4. the process survives
T('uncaught exceptions are caught and logged', /process\.on\('uncaughtException'/.test(SRC) && /continuing/.test(SRC))
T('unhandled rejections are caught and logged', /process\.on\('unhandledRejection'/.test(SRC))

// --- 4b. the .env parser (inline comments, quotes, empty values)
{
  const loader = SRC.slice(SRC.indexOf('function loadEnvFile'), SRC.indexOf('const envFile ='))
  const fsx = require('fs'), os = require('os'), pathx = require('path')
  const tmp = pathx.join(os.tmpdir(), 'env-parse-' + process.pid + '.env')
  fsx.writeFileSync(tmp, [
    'PLAYER_NAME=YourName',
    'WEB=on            # inline note',
    'PASSWORD="pa # ss"   # quoted hash survives',
    "PASS2='single # quote' # note",
    'CMDS=/queue lifesteal,/afk   # two commands',
    'EMPTY=',
    '  # a whole-line comment',
    'HASHY=a#b'
  ].join('\n'))
  const load = new Function('fs', loader + '; return loadEnvFile')(fsx)
  const e = load(tmp)
  T('.env: inline comments are stripped from values', e.WEB === 'on', e.WEB)
  T('.env: CMDS keeps both commands, not the comment', e.CMDS === '/queue lifesteal,/afk', e.CMDS)
  T('.env: a quoted value keeps its #', e.PASSWORD === 'pa # ss', e.PASSWORD)
  T('.env: single quotes work too', e.PASS2 === 'single # quote', e.PASS2)
  T('.env: empty values stay empty, whole-line comments are skipped', e.EMPTY === '' && !('a whole-line comment' in e), e.EMPTY)
  T('.env: a # with no space before it is part of the value', e.HASHY === 'a#b', e.HASHY)
  try { fsx.unlinkSync(tmp) } catch {}
}

// --- 5. behaviour: an unreachable endpoint must not kill the process
const PORT = 1
const child = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, WEB: 'off', PLAYER_NAME: 'CrashTestBot', SERVER_IP: '127.0.0.1', SERVER_PORT: String(PORT), AUTH: 'off', ANTI_AFK: 'off', ENV_FILE: '/nonexistent', PASSWORD: 'x' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let out = '', exited = null
child.stdout.on('data', d => { out += d })
child.stderr.on('data', d => { out += d })
child.on('exit', (c) => { exited = c })

setTimeout(() => {
  T('the bot is still running after repeated connection failures', exited === null, exited)
  T('it keeps retrying instead of exiting', /reconnecting|socket|ECONNREFUSED/i.test(out), out.split('\n').slice(-3))
  try { child.kill('SIGKILL') } catch {}
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}, 7000)
