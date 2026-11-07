'use strict'

// Detect an arrival in the CWR hub and request Lifesteal once per hub visit.
// This proxy's hub uses a non-survival game mode; Lifesteal was observed as mode 0.
class AutoJoinController {
  constructor (enabled, onJoin) {
    this.enabled = !!enabled
    this.onJoin = typeof onJoin === 'function' ? onJoin : () => {}
    this.wasHub = false
    this.queuedForHub = false
  }

  observe ({ inWorld, mode, ready, verified }) {
    const knownMode = mode !== null && mode !== undefined && Number.isInteger(Number(mode))
    const inHub = !!inWorld && knownMode && Number(mode) !== 0

    if (!inHub) {
      if (!inWorld || (knownMode && Number(mode) === 0)) {
        this.wasHub = false
        this.queuedForHub = false
      }
      return false
    }

    if (!this.wasHub) {
      this.wasHub = true
      this.queuedForHub = false
    }
    if (!this.enabled || !ready || !verified || this.queuedForHub) return false

    // Mark before calling out: observations can arrive in quick succession.
    this.queuedForHub = true
    this.onJoin()
    return true
  }
}

module.exports = { AutoJoinController }
