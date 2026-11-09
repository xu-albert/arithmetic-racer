import { expiredScreen } from './room-expiry.js';

export function renderExpiredScreen(screen, msg, mode) {
  const { copy, exit } = expiredScreen(msg, mode);
  for (const el of screen?.querySelectorAll('[data-expired-copy]') ?? []) {
    el.classList.toggle('hidden', el.dataset.expiredCopy !== copy);
  }
  for (const el of screen?.querySelectorAll('[data-expired-exit]') ?? []) {
    el.classList.toggle('hidden', el.dataset.expiredExit !== exit);
  }
}
