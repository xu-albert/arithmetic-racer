import { createRoomClient } from './room-client.js';
import { canEditConfig } from './room-config-rules.js';
import { createExpiryLatch } from './room-expiry.js';
import { createRaceHandoffLatch } from './race-handoff.js';

const DIFFS = ['easy', 'medium', 'hard'];

/**
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {object} opts.screens
 * @param {function} opts.onRaceStart
 * @param {function} [opts.onRoomExpired] - the room wound down; nothing to join
 * @param {string} [opts.mode]       - 'public' activates public-mode UI
 * @param {string} [opts.difficulty] - forwarded to createRoomClient for public mode
 * @param {string} [opts.deviceId]   - forwarded to createRoomClient for public mode
 */
export function attachLobby({ roomId, screens, onRaceStart, onRoomExpired, mode, difficulty, deviceId }) {
  const isPublic = mode === 'public';

  const roomTitle = document.getElementById('room-title');
  const playersList = document.getElementById('room-players');
  const startBtn = document.getElementById('start-race-btn');
  const rematchBtn = document.getElementById('rematch-btn');
  const leaveBtn = document.getElementById('leave-room-btn');
  const inviteBtn = document.getElementById('invite-btn');
  const hint = document.getElementById('lobby-hint');
  const diffBtns = document.querySelectorAll('#lobby-room .diff-btn');
  const lengthInput = document.getElementById('race-length-input');

  const inviteModal = document.getElementById('invite-modal');
  const inviteUrlInput = document.getElementById('invite-url');
  const inviteCopyBtn = document.getElementById('invite-copy-btn');
  const inviteCloseBtn = document.getElementById('invite-close-btn');

  // Public mode: create a "Find Another Match" button and a searching pill dynamically
  let findAnotherBtn = null;
  let searchingPill = null;
  if (isPublic) {
    // Hide private-only controls
    startBtn.classList.add('hidden');
    inviteBtn.classList.add('hidden');

    // Searching pill (replaces start button in lobby state)
    searchingPill = document.createElement('span');
    searchingPill.id = 'searching-pill';
    searchingPill.className = 'lobby-hint';
    searchingPill.textContent = 'Searching…';
    startBtn.parentNode.insertBefore(searchingPill, startBtn);

    // "Find Another Match" replaces "Race Again" on the results screen
    findAnotherBtn = document.createElement('a');
    findAnotherBtn.id = 'find-another-btn';
    findAnotherBtn.href = '/';
    findAnotherBtn.className = 'primary button';
    findAnotherBtn.textContent = 'Find Another Match';
    rematchBtn.parentNode.insertBefore(findAnotherBtn, rematchBtn.nextSibling);
    findAnotherBtn.classList.add('hidden');
  }

  const client = createRoomClient({ roomId, mode, difficulty, deviceId });

  let currentState = null;
  let youAre = null;
  let inviteShownThisSession = false;
  let prevServerState = null;

  const raceHandoff = createRaceHandoffLatch({
    onRaceStart: (state, seatId) => onRaceStart?.({ roomClient: client, initialState: state, youAre: seatId }),
  });

  // Public matches are anonymous drop-ins — the internal room slug is
  // meaningless to players, so don't surface it.
  roomTitle.textContent = isPublic ? 'Quick Match' : `Room: ${roomId}`;
  inviteUrlInput.value = `${location.origin}/?room=${roomId}`;

  function meIsCreator() {
    if (!currentState || !youAre) return false;
    const me = currentState.players.find((p) => p.id === youAre);
    return !!me?.isCreator;
  }

  // Scores on the finished scoreboard belong to the race that just ran, so
  // they keep that race's length even if the host has already dialled in a
  // different one for the next race. `lastRace` is the snapshot the server
  // pins at finish; falls back to the live value for rooms that never
  // recorded one (pre-pin persisted state).
  function scoreboardLength() {
    if (currentState.state === 'finished' && currentState.lastRace?.raceLength != null) {
      return currentState.lastRace.raceLength;
    }
    return currentState.raceLength;
  }

  function statusFor(p) {
    const len = scoreboardLength();
    if (p.dropped) return `left mid-race at ${p.score}/${len}`;
    if (p.finishMs != null) return `finished — ${(p.finishMs / 1000).toFixed(1)}s`;
    if (p.dnf) return `${p.score}/${len} — didn't finish`;
    if (currentState.state === 'racing') return `racing — ${p.score}/${len}`;
    return null;
  }

  function render() {
    if (!currentState) return;

    // Player list
    playersList.innerHTML = '';
    for (const p of currentState.players) {
      const li = document.createElement('li');
      li.className = 'player-row';
      li.dataset.playerId = p.id;
      const isMe = p.id === youAre;

      const handleSpan = document.createElement('span');
      handleSpan.className = 'player-handle' + (isMe ? ' editable' : '');
      handleSpan.textContent = p.handle;
      if (isMe) handleSpan.title = 'Click to edit your handle';
      li.append(handleSpan);

      if (isMe) {
        const youBadge = document.createElement('span');
        youBadge.className = 'badge badge-you';
        youBadge.textContent = '(you)';
        li.append(youBadge);
      }
      if (p.isCreator) {
        const hostBadge = document.createElement('span');
        hostBadge.className = 'badge badge-host';
        hostBadge.textContent = '(host)';
        li.append(hostBadge);
      }
      // Server broadcasts isGuest (no userId). The badge only encodes account
      // status, so bots carry it too — bot backfill is disclosed in the lobby
      // copy, not hidden on the wire (isBot/tier stay in the payload).
      if (p.isGuest) {
        const guestBadge = document.createElement('span');
        guestBadge.className = 'badge badge-guest';
        guestBadge.textContent = '(Guest)';
        li.append(guestBadge);
      }

      const status = statusFor(p);
      if (status) {
        const statusSpan = document.createElement('span');
        statusSpan.className = 'player-status';
        statusSpan.textContent = status;
        li.append(statusSpan);
      }

      if (isMe) handleSpan.addEventListener('click', () => beginHandleEdit(handleSpan, p.handle));
      playersList.append(li);
    }

    // Difficulty buttons. Editable in 'lobby' AND 'finished' — the host lands
    // in 'finished' after every race and that is exactly where they want to
    // pick a different difficulty for the rematch.
    const inLobby = currentState.state === 'lobby';
    const isCreator = meIsCreator();
    const configEditable = canEditConfig({ roomState: currentState.state, isCreator });
    diffBtns.forEach((btn) => {
      const matches = btn.dataset.difficulty === currentState.difficulty;
      btn.setAttribute('aria-pressed', matches ? 'true' : 'false');
      btn.disabled = !configEditable;
    });

    // Race length input
    lengthInput.disabled = !configEditable;
    if (document.activeElement !== lengthInput) {
      lengthInput.value = String(currentState.raceLength);
    }

    // Buttons
    const enoughPlayers = currentState.players.length >= 2;
    const isFinished = currentState.state === 'finished';

    if (isPublic) {
      // Public mode: no start / rematch buttons; searching pill + find-another instead
      startBtn.classList.add('hidden');
      rematchBtn.classList.add('hidden');

      if (searchingPill) {
        const humanCount = currentState.players.filter((p) => !p.isBot).length;
        searchingPill.classList.toggle('hidden', currentState.state !== 'lobby');
        if (currentState.state === 'lobby') {
          searchingPill.textContent = `Searching… ${humanCount} / 6 humans`;
        }
      }
      if (findAnotherBtn) {
        findAnotherBtn.classList.toggle('hidden', !isFinished);
      }
    } else {
      startBtn.disabled = !(inLobby && isCreator && enoughPlayers);
      startBtn.classList.toggle('hidden', currentState.state !== 'lobby');
      rematchBtn.classList.toggle('hidden', !isFinished);
      rematchBtn.disabled = !isCreator;
    }

    // Hint
    if (currentState.state === 'lobby') {
      if (isPublic) {
        hint.textContent = 'Any lane no human takes gets a practice bot.';
      } else if (!enoughPlayers) {
        hint.textContent = 'Waiting for at least 2 players to start…';
      } else if (!isCreator) {
        hint.textContent = 'Waiting for the host to start the race.';
      } else {
        hint.textContent = '';
      }
    } else if (currentState.state === 'countdown') {
      hint.textContent = 'Get ready!';
    } else if (currentState.state === 'racing') {
      hint.textContent = 'Race in progress.';
    } else if (isFinished) {
      if (isPublic) {
        hint.textContent = '';
      } else {
        // Spell out that the settings are live here — the controls sitting
        // right above are enabled, but "Race Again" reads like the only move.
        hint.textContent = isCreator
          ? 'Change the difficulty or length if you like, then click Race Again.'
          : 'Waiting for the host to rematch.';
      }
    }
  }

  function beginHandleEdit(handleSpan, currentHandle) {
    if (handleSpan.querySelector('input')) return;
    handleSpan.textContent = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentHandle;
    input.maxLength = 24;
    input.className = 'handle-edit';
    handleSpan.append(input);
    input.focus();
    input.select();

    let committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      if (next && next !== currentHandle) {
        client.send({ type: 'set-handle', handle: next });
      }
      // Re-render will overwrite this DOM
      render();
    }
    function cancel() {
      committed = true;
      render();
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  // ----- invite modal -----
  function openInvite() {
    inviteModal.classList.remove('hidden');
    inviteUrlInput.focus();
    inviteUrlInput.select();
  }
  function closeInvite() {
    inviteModal.classList.add('hidden');
  }
  inviteBtn.addEventListener('click', openInvite);
  inviteCloseBtn.addEventListener('click', closeInvite);
  inviteCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(inviteUrlInput.value);
      const original = inviteCopyBtn.textContent;
      inviteCopyBtn.textContent = 'Copied!';
      setTimeout(() => { inviteCopyBtn.textContent = original; }, 1500);
    } catch {
      inviteUrlInput.select();
      document.execCommand('copy');
    }
  });
  inviteModal.addEventListener('click', (e) => {
    if (e.target === inviteModal) closeInvite();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !inviteModal.classList.contains('hidden')) closeInvite();
  });

  // ----- control wiring -----
  diffBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const len = parseInt(lengthInput.value, 10) || currentState.raceLength;
      client.send({ type: 'set-config', difficulty: btn.dataset.difficulty, raceLength: len });
    });
  });
  lengthInput.addEventListener('change', () => {
    if (lengthInput.disabled) return;
    const len = parseInt(lengthInput.value, 10);
    if (!Number.isFinite(len)) return;
    client.send({ type: 'set-config', difficulty: currentState.difficulty, raceLength: len });
  });
  startBtn.addEventListener('click', () => {
    if (startBtn.disabled) return;
    client.send({ type: 'start-race' });
  });
  rematchBtn.addEventListener('click', () => {
    if (rematchBtn.disabled) return;
    client.send({ type: 'rematch' });
    raceHandoff.rearm();
  });
  leaveBtn.addEventListener('click', () => {
    client.send({ type: 'quit' });
    setTimeout(() => { client.close(); location.assign('/'); }, 100);
  });

  // ----- toasts -----
  // Lives on <body>, so it reaches players sitting on the results or race
  // screen rather than only those looking at the room lobby.
  function showToast(msg, kind = 'error') {
    let toast = document.getElementById('error-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'error-toast';
      document.body.append(toast);
    }
    toast.className = `error-toast${kind === 'info' ? ' info' : ''}`;
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  function showError(msg) {
    showToast(msg, 'error');
  }

  // ----- subscribe -----
  const handleExpiry = createExpiryLatch({
    close: () => client.close(),
    onExpired: onRoomExpired,
  });

  client.on((msg) => {
    // Checked ahead of everything else — an expired room has no state worth
    // rendering, and the server may deliver this on the very first message.
    if (handleExpiry(msg)) return;
    if (msg.type === 'state') {
      currentState = msg.state;
      youAre = msg.youAre;

      // Auto-open invite modal once when creator first lands (private rooms only).
      if (!isPublic && !inviteShownThisSession && meIsCreator() && currentState.state === 'lobby' && currentState.problemSequence.length === 0) {
        inviteShownThisSession = true;
        openInvite();
      }

      // If race already in progress when we joined / state moves to racing, hand off.
      raceHandoff.handle(currentState, youAre);
      // After a rematch, state goes back to 'lobby' — re-arm the handoff
      // and pull the user back to lobby-room if they were sitting on results/race.
      if (currentState.state === 'lobby') {
        raceHandoff.rearm();
        if (prevServerState && prevServerState !== 'lobby') {
          for (const [key, el] of Object.entries(screens)) {
            el.classList.toggle('hidden', key !== 'lobby-room');
          }
        }
      }
      prevServerState = currentState.state;

      // Skip render during active racing/countdown — lobby DOM is hidden and
      // every state event would trigger an innerHTML rebuild that competes
      // with the race-screen car animation. Re-render fires on every other
      // state transition (lobby/finished).
      if (currentState.state !== 'racing' && currentState.state !== 'countdown') {
        render();
      }
    } else if (msg.type === 'config-changed') {
      // The host can now change settings while everyone else is looking at the
      // results screen. Announce it — a race that silently swaps difficulty
      // under the other players is worse than one you can't reconfigure.
      if (!meIsCreator()) {
        const diff = msg.difficulty ? msg.difficulty[0].toUpperCase() + msg.difficulty.slice(1) : '';
        showToast(`Host set the race to ${diff} · ${msg.raceLength} problems`, 'info');
      }
    } else if (msg.type === 'error') {
      showError(msg.message || msg.code);
    }
  });

  return {
    client,
    detach() {
      client.close();
      searchingPill?.remove();
      findAnotherBtn?.remove();
    },
  };
}
