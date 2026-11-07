'use strict'
const assert = require('assert')
const fs = require('fs')
const { AutoJoinController } = require('./auto_join')
let passed = 0
function check (condition, message) { assert.ok(condition, message); passed++ }
function observe (controller, mode, ready = true, verified = true) {
  return controller.observe({ inWorld: true, mode, ready, verified })
}

// A hub join before AuthMe/captcha readiness is remembered, then acted on once ready.
{
  let sends = 0
  const a = new AutoJoinController(true, () => sends++)
  check(!observe(a, 2, false, true), 'does not queue before auth is ready')
  check(observe(a, 2, true, true), 'queues on readiness while still in the hub')
  check(sends === 1, 'one queue request')
  check(!observe(a, 2), 'repeated hub packets do not spam')
  check(sends === 1, 'still one request')
}
// A player returning from mode-0 Lifesteal to the adventure hub is re-queued once.
{
  let sends = 0
  const a = new AutoJoinController(true, () => sends++)
  observe(a, 2); check(sends === 1, 'initial hub queues')
  check(!observe(a, 0), 'mode 0 is Lifesteal, not hub')
  check(observe(a, 2), 'return to hub queues again')
  check(!observe(a, 2), 'same hub visit only queues once')
  check(sends === 2, 'exactly one request per hub visit')
}
// No join until both login and verification are complete.
{
  let sends = 0
  const a = new AutoJoinController(true, () => sends++)
  observe(a, 2, true, false)
  check(sends === 0, 'does not queue before captcha verification')
  check(observe(a, 2, true, true), 'queues once verification completes')
}
// Explicitly disabled is inert.
{
  let sends = 0
  const a = new AutoJoinController(false, () => sends++)
  observe(a, 2); observe(a, 0); observe(a, 2)
  check(sends === 0, 'AUTO_JOIN off never auto-queues')
}
// Out-of-world/unknown state must not create a false join.
{
  let sends = 0
  const a = new AutoJoinController(true, () => sends++)
  a.observe({ inWorld: false, mode: null, ready: true, verified: true })
  a.observe({ inWorld: true, mode: null, ready: true, verified: true })
  check(sends === 0, 'unknown game mode is not assumed to be the hub')
}
const src = fs.readFileSync(require.resolve('./server'), 'utf8')
check(/autoJoin:\s*\/\^\(on\|true\|yes\|1\)\$\/i\.test\(ENV\.AUTO_JOIN \|\| 'on'\)/.test(src), 'AUTO_JOIN environment toggle defaults on')
check(src.includes("new AutoJoinController(cfg.autoJoin") && src.includes("queue.push('/queue lifesteal')"), 'controller is wired to Lifesteal queue')
check(src.includes('queue.lifestealInFlight') && src.includes("this.lifestealInFlight++"), 'duplicate initial/automatic joins are coalesced')
console.log(`${passed} passed, 0 failed (auto-join controller)`)
