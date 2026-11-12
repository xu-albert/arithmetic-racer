import test from 'node:test';
import assert from 'node:assert/strict';
import { renderExpiredScreen } from './room-expiry-view.js';
import { ROOM_EXPIRED_TYPE, ROOM_FULL_REASON } from './room-expiry.js';

function item(kind, value, text) {
  const classes = new Set(['hidden']);
  return {
    dataset: { [kind]: value },
    textContent: text,
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
    },
  };
}

test('a full private room reveals its heading, explanation, and new-room exit', () => {
  const heading = item('expiredCopy', 'room-full', 'Room full');
  const explanation = item('expiredCopy', 'room-full', 'This room already has as many racers as it can hold.');
  const idle = item('expiredCopy', 'idle', 'Idle');
  const newRoom = item('expiredExit', 'new-room', 'Create a New Room');
  const findMatch = item('expiredExit', 'find-match', 'Find Another Match');
  const screen = {
    querySelectorAll(selector) {
      return selector === '[data-expired-copy]'
        ? [heading, explanation, idle]
        : [newRoom, findMatch];
    },
  };

  renderExpiredScreen(screen, { type: ROOM_EXPIRED_TYPE, reason: ROOM_FULL_REASON });

  assert.equal(heading.classList.contains('hidden'), false);
  assert.equal(explanation.classList.contains('hidden'), false);
  assert.equal(idle.classList.contains('hidden'), true);
  assert.equal(newRoom.classList.contains('hidden'), false);
  assert.equal(findMatch.classList.contains('hidden'), true);
});
