// DOM shell for the verification banner. All of the lifecycle lives in
// captcha-session.js; this only paints what the session reports.
//
// Mounted on document.body rather than a screen, and attached for as long as
// the room is, because a challenge is not part of the race: it opens at the
// racer's own finish while others are still racing, it outlives the results
// screen, and after a reload the player is standing in the room lobby when the
// server re-offers it.

import { createCaptchaSession } from './captcha-session.js';

export function attachCaptchaUI({ client }) {
  const banner = document.createElement('div');
  banner.id = 'captcha-banner';
  banner.className = 'hidden';
  banner.setAttribute('role', 'status');

  const textEl = document.createElement('div');
  textEl.className = 'captcha-text';
  const problemEl = document.createElement('div');
  problemEl.className = 'captcha-problem';
  const inputEl = document.createElement('input');
  inputEl.className = 'captcha-input';
  inputEl.type = 'text';
  inputEl.inputMode = 'numeric';
  inputEl.autocomplete = 'off';
  inputEl.setAttribute('aria-label', 'Verification answer');
  const countdownEl = document.createElement('div');
  countdownEl.className = 'captcha-countdown';

  banner.append(textEl, problemEl, inputEl, countdownEl);
  document.body.appendChild(banner);

  const session = createCaptchaSession({
    send: (msg) => client.send(msg),
    onChange: render,
  });

  function render(view) {
    if (!view) {
      banner.classList.add('hidden');
      inputEl.value = '';
      return;
    }
    const wasHidden = banner.classList.contains('hidden');
    banner.classList.remove('hidden');
    textEl.textContent = view.title ?? view.message ?? '';
    problemEl.textContent = view.problem ?? '';
    countdownEl.textContent = view.secondsLeft == null ? '' : `${view.secondsLeft}s`;
    inputEl.classList.toggle('hidden', !view.answering);
    if (view.answering && wasHidden) inputEl.focus();
  }

  function onKey(e) {
    if (e.key !== 'Enter') return;
    const raw = inputEl.value;
    if (!raw.trim()) return;
    if (session.submit(raw)) inputEl.value = '';
  }

  inputEl.addEventListener('keydown', onKey);
  const off = client.on((msg) => session.receive(msg));

  return () => {
    off();
    inputEl.removeEventListener('keydown', onKey);
    session.destroy();
    banner.remove();
  };
}
