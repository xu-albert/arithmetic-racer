// The lobby → race-screen handoff gate, factored out of lobby.js so it can be
// driven without a DOM (see race-handoff.test.js).
//
// A snapshot says what the room is doing before it can say who *you* are. The
// server pushes `state` on connect — ahead of `hello`, which is the only thing
// that proves which seat this socket owns — so that first message carries
// `youAre: null`, and carries `state: 'racing'` for anyone reloading mid-race.
// The seat id is therefore part of the gate, not a value the caller merely
// forwards: without it `createRemoteRunner` aliases nobody to 'player' and
// `attachRaceUI` has no local racer to read a score off. Waiting costs one
// round trip — `handleHello` broadcasts state again, keyed this time.
//
// Latched, because every subsequent broadcast still says `racing`; re-armed by
// the caller when the room returns to the lobby after a rematch.

/** @param {object} opts @param {(state: object, youAre: string) => void} opts.onRaceStart */
export function createRaceHandoffLatch({ onRaceStart }) {
  let handed = false;
  return {
    /** @returns {boolean} true when this snapshot triggered the handoff */
    handle(state, youAre) {
      if (handed || !youAre) return false;
      if (state?.state !== 'racing' && state?.state !== 'countdown') return false;
      handed = true;
      onRaceStart(state, youAre);
      return true;
    },
    rearm() {
      handed = false;
    },
  };
}
