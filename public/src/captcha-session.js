// Client half of the superhuman-pace verification (server/captcha.js).
//
// Pure: no DOM and no socket. It takes the room's two verification messages in
// and calls back with what should be on screen, which is what lets the banner
// live above every screen instead of inside the race — a challenge outlives the
// race screen and has to survive a reload onto the room lobby.
//
// The server is the only grader. This tracks nothing but which problem is on
// screen and how long is left, and it never decides an outcome: the one verdict
// it can produce on its own says exactly that it could not get one.

// How long past the deadline to keep waiting before giving up on a verdict, so
// a message already in flight still wins.
export const VERDICT_GRACE_MS = 2000;

// How long a settled notice stays up before it clears itself.
export const NOTICE_MS = 2500;

const UNCONFIRMED = 'Verification couldn\'t be confirmed for this race.';

/** What the player is told about a verdict the server sent. */
export function verdictMessage({ verified, reason }) {
  if (verified) return 'Verified — your race counts.';
  return reason === 'captcha_timeout'
    ? 'Verification timed out — this race won\'t appear on leaderboards.'
    : 'Verification failed — this race won\'t appear on leaderboards.';
}

/**
 * @param {object} opts
 * @param {(msg: object) => void} opts.send      - room client send
 * @param {(view: object|null) => void} opts.onChange - null means "show nothing"
 */
export function createCaptchaSession({ send, onChange }) {
  let challenge = null; // { problems, index, endsAt }
  let tick = null;
  let notice = null;

  function stopTick() {
    if (tick != null) { clearInterval(tick); tick = null; }
  }

  function stopNotice() {
    if (notice != null) { clearTimeout(notice); notice = null; }
  }

  function view() {
    const answered = challenge.index >= challenge.problems.length;
    const msLeft = challenge.endsAt - Date.now();
    return {
      title: `That pace was superhuman — solve ${challenge.problems.length} quick problems to verify your race.`,
      problem: answered ? 'Checking…' : challenge.problems[challenge.index].problem,
      secondsLeft: answered || msLeft <= 0 ? null : Math.ceil(msLeft / 1000),
      message: null,
      answering: !answered,
    };
  }

  // First settle wins. A verdict that lands after the client gave up must not
  // re-open anything, and neither must a second verdict.
  function settle(message) {
    if (!challenge) return;
    challenge = null;
    stopTick();
    onChange({ title: null, problem: null, secondsLeft: null, message, answering: false });
    notice = setTimeout(() => { notice = null; onChange(null); }, NOTICE_MS);
  }

  function onTick() {
    if (!challenge) return;
    if (Date.now() - challenge.endsAt >= VERDICT_GRACE_MS) {
      settle(UNCONFIRMED);
      return;
    }
    onChange(view());
  }

  return {
    /**
     * Feed this every room message; it ignores the ones that are not its own.
     * A `captcha` message is equally an opening offer and a re-offer after a
     * reconnect or a reload — `remainingMs` is what is left of the original
     * budget either way, so both are handled by starting from what arrived.
     */
    receive(msg) {
      if (msg?.type === 'captcha') {
        stopNotice();
        stopTick();
        challenge = { problems: msg.problems, index: 0, endsAt: Date.now() + msg.remainingMs };
        onChange(view());
        tick = setInterval(onTick, 1000);
        return true;
      }
      if (msg?.type === 'captcha-result') {
        settle(verdictMessage(msg));
        return true;
      }
      return false;
    },

    /** Send one answer to the server, which grades it. Ignored when idle. */
    submit(raw) {
      if (!challenge || challenge.index >= challenge.problems.length) return false;
      send({ type: 'captcha-answer', value: raw });
      challenge.index += 1;
      onChange(view());
      return true;
    },

    get active() { return challenge !== null; },

    destroy() {
      stopTick();
      stopNotice();
      challenge = null;
    },
  };
}
