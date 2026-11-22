/**
 * The engine double the forwarding suite's two loops share.
 *
 * The forward and forward-persist sections had byte-identical copies of this
 * function: same `once`/`off`/`emit` shim, same `forwardOut` that dials a real
 * loopback server, same record shape. Two copies of a double is not a style
 * problem — the two suites drifted, and a change to what a spliced socket sees
 * landed in one of them.
 *
 * The splice is REAL: `forwardOut` opens a TCP connection to a loopback server
 * the suite starts, so bytes actually travel and a broken splice shows up as a
 * broken socket rather than as a missing call. What is doubled is only the SSH
 * connection that would have carried it.
 *
 * @module tests/support/fake-forward-engine
 */

import { createConnection } from 'node:net'

/**
 * Build the engine double.
 *
 * @param {number} farSidePort - the loopback port `forwardOut` dials.
 * @returns {{engine: object, record: object, state: object}} the double.
 */
export function fakeForwardEngine (farSidePort) {
  const handlers = new Map()
  const state = { holds: 0, forwardOutCalls: [], acquireCalls: 0 }
  const client = {
    // A minimal EventEmitter: the manager subscribes to 'close' and must be
    // able to unsubscribe without leaking a handler into the next record.
    once (event, handler) { handlers.set(event, handler) },
    off (event, handler) { if (handlers.get(event) === handler) handlers.delete(event) },
    emit (event, ...args) {
      const handler = handlers.get(event)
      if (handler !== undefined) handler(...args)
    },
    forwardOut (_srcHost, _srcPort, dstHost, dstPort, callback) {
      state.forwardOutCalls.push({ dstHost, dstPort })
      const socket = createConnection({ host: '127.0.0.1', port: farSidePort })
      socket.once('connect', () => callback(null, socket))
      socket.once('error', (error) => callback(error))
    },
  }
  const record = { client, holds: 0, idleAt: Date.now(), inFlight: 0, broken: false }
  return {
    state,
    record,
    engine: {
      async acquire () { state.acquireCalls += 1; return record },
    },
  }
}
