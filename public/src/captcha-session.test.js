// Client verification lifecycle. Runs under node:test with mock.timers, which
// is why the lifecycle lives in a module with no DOM in it.
//
// One trap inherited from the other runner tests: tick(ms) fires only the
// timers already due when it is called, so a repeating interval has to be
// walked in steps no larger than its period.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCaptchaSession,
  verdictMessage,
  VERDICT_GRACE_MS,
  NOTICE_MS,
} from './captcha-session.js';

const PROBLEMS = [{ problem: '7 × 8' }, { problem: '9 + 4' }, { problem: '12 ÷ 3' }];

function makeSession({ remainingMs = 12000 } = {}) {
  const sent = [];
  const views = [];
  const session = createCaptchaSession({
    send: (msg) => sent.push(msg),
    onChange: (v) => views.push(v),
  });
  return {
    session,
    sent,
    views,
    last: () => views[views.length - 1],
    offer: (over = {}) => session.receive({ type: 'captcha', problems: PROBLEMS, remainingMs, ...over }),
  };
}

function withTimers(fn) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    fn();
  } finally {
    mock.timers.reset();
  }
}

/** Walk a repeating interval forward one period at a time. */
function advance(ms, step = 1000) {
  for (let left = ms; left > 0; left -= step) mock.timers.tick(Math.min(step, left));
}

describe('captcha session', () => {
  test('an offer with no race in progress still opens the challenge', () => {
    withTimers(() => {
      // The reload case: the tab came back on the room lobby and the server
      // re-offered. Nothing about a race is involved in getting it on screen.
      const h = makeSession({ remainingMs: 8000 });
      assert.equal(h.session.active, false);

      assert.equal(h.offer(), true);

      assert.equal(h.session.active, true);
      assert.equal(h.last().problem, '7 × 8');
      assert.equal(h.last().secondsLeft, 8);
    });
  });

  test('a re-offer shows what is left of the original budget, not a fresh one', () => {
    withTimers(() => {
      const h = makeSession({ remainingMs: 12000 });
      h.offer();
      advance(9000);
      assert.equal(h.last().secondsLeft, 3);

      // Same challenge, re-offered on a new socket with the remainder.
      h.session.receive({ type: 'captcha', problems: PROBLEMS.slice(1), remainingMs: 2500 });

      assert.equal(h.last().problem, '9 + 4');
      assert.equal(h.last().secondsLeft, 3);
      advance(2000);
      assert.equal(h.last().secondsLeft, 1);
    });
  });

  test('answers go to the server one at a time and end in Checking', () => {
    withTimers(() => {
      const h = makeSession();
      h.offer();

      assert.equal(h.session.submit('56'), true);
      assert.equal(h.last().problem, '9 + 4');
      assert.equal(h.session.submit('13'), true);
      assert.equal(h.session.submit('4'), true);

      assert.deepEqual(h.sent, [
        { type: 'captcha-answer', value: '56' },
        { type: 'captcha-answer', value: '13' },
        { type: 'captcha-answer', value: '4' },
      ]);
      assert.equal(h.last().problem, 'Checking…');
      assert.equal(h.last().secondsLeft, null);
      // Nothing more is accepted; the server owns the outcome from here.
      assert.equal(h.session.submit('99'), false);
      assert.equal(h.sent.length, 3);
    });
  });

  test('the server verdict settles the banner, then clears it', () => {
    withTimers(() => {
      const h = makeSession();
      h.offer();
      h.session.receive({ type: 'captcha-result', verified: true });

      assert.equal(h.session.active, false);
      assert.equal(h.last().message, 'Verified — your race counts.');

      mock.timers.tick(NOTICE_MS);
      assert.equal(h.last(), null);
    });
  });

  test('a verdict that never arrives settles as unconfirmed, claiming nothing', () => {
    withTimers(() => {
      const h = makeSession({ remainingMs: 12000 });
      h.offer();
      h.session.submit('56');
      h.session.submit('13');
      h.session.submit('4');
      // Socket died after the last answer: the banner would otherwise sit on
      // "Checking…" with no way out and the input still live.
      assert.equal(h.session.active, true);

      advance(12000 + VERDICT_GRACE_MS);

      assert.equal(h.session.active, false);
      assert.equal(h.last().message, 'Verification couldn\'t be confirmed for this race.');
      assert.equal(h.last().answering, false);
      assert.equal(h.session.submit('7'), false);
    });
  });

  test('a late verdict after a self-settle changes nothing', () => {
    withTimers(() => {
      const h = makeSession({ remainingMs: 5000 });
      h.offer();
      advance(5000 + VERDICT_GRACE_MS);
      const settledAt = h.views.length;

      h.session.receive({ type: 'captcha-result', verified: false, reason: 'captcha_timeout' });

      assert.equal(h.views.length, settledAt);
      assert.equal(h.session.active, false);
    });
  });

  test('destroy stops the clock', () => {
    withTimers(() => {
      const h = makeSession({ remainingMs: 3000 });
      h.offer();
      h.session.destroy();
      const after = h.views.length;

      advance(3000 + VERDICT_GRACE_MS + NOTICE_MS);

      assert.equal(h.views.length, after);
    });
  });
});

describe('verdict wording', () => {
  test('a timeout is not reported as a failed answer', () => {
    // `captcha_timeout` is the string the server emits; it is also what the
    // row's suspect_reason says, and a racer who ran out of time was not
    // caught answering wrongly.
    assert.match(verdictMessage({ verified: false, reason: 'captcha_timeout' }), /timed out/);
    assert.match(verdictMessage({ verified: false, reason: 'captcha_failed' }), /failed/);
    assert.match(verdictMessage({ verified: true }), /counts/);
  });
});
