import { createRoomClient } from './room-client.js';

const DIFFS = ['easy', 'medium', 'hard'];

export function attachLobby({ roomId, screens, onRaceStart }) {
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

  const client = createRoomClient(roomId);
  let currentState = null;
  let youAre = null;
  let inviteShownThisSession = false;
  let raceStartHandled = false;
  let prevServerState = null;

  roomTitle.textContent = `Room: ${roomId}`;
  inviteUrlInput.value = `${location.origin}/?room=${roomId}`;

  function meIsCreator() {
    if (!currentState || !youAre) return false;
    const me = currentState.players.find((p) => p.id === youAre);
    return !!me?.isCreator;
  }

  function statusFor(p) {
    if (p.dropped) return `left mid-race at ${p.score}/${currentState.raceLength}`;
    if (p.finishMs != null) return `finished — ${(p.finishMs / 1000).toFixed(1)}s`;
    if (p.dnf) return `${p.score}/${currentState.raceLength} — didn't finish`;
    if (currentState.state === 'racing') return `racing — ${p.score}/${currentState.raceLength}`;
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
      // Everyone is a guest until accounts ship; suppress for any future signed-in player.
      const guestBadge = document.createElement('span');
      guestBadge.className = 'badge badge-guest';
      guestBadge.textContent = '(Guest)';
      li.append(guestBadge);

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

    // Difficulty buttons
    const inLobby = currentState.state === 'lobby';
    const isCreator = meIsCreator();
    diffBtns.forEach((btn) => {
      const matches = btn.dataset.difficulty === currentState.difficulty;
      btn.setAttribute('aria-pressed', matches ? 'true' : 'false');
      btn.disabled = !inLobby || !isCreator;
    });

    // Race length input
    lengthInput.disabled = !inLobby || !isCreator;
    if (document.activeElement !== lengthInput) {
      lengthInput.value = String(currentState.raceLength);
    }

    // Buttons
    const enoughPlayers = currentState.players.length >= 2;
    startBtn.disabled = !(inLobby && isCreator && enoughPlayers);
    startBtn.classList.toggle('hidden', currentState.state !== 'lobby');

    const isFinished = currentState.state === 'finished';
    rematchBtn.classList.toggle('hidden', !isFinished);
    rematchBtn.disabled = !isCreator;

    // Hint
    if (currentState.state === 'lobby') {
      if (!enoughPlayers) {
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
      hint.textContent = isCreator ? 'Click Race Again to rematch.' : 'Waiting for the host to rematch.';
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
    raceStartHandled = false;
  });
  leaveBtn.addEventListener('click', () => {
    client.send({ type: 'quit' });
    setTimeout(() => { client.close(); location.assign('/'); }, 100);
  });

  // ----- error toast -----
  function showError(msg) {
    let toast = document.getElementById('error-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'error-toast';
      toast.className = 'error-toast';
      document.body.append(toast);
    }
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(showError._t);
    showError._t = setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  // ----- subscribe -----
  client.on((msg) => {
    if (msg.type === 'state') {
      currentState = msg.state;
      youAre = msg.youAre;

      // Auto-open invite modal once when creator first lands.
      if (!inviteShownThisSession && meIsCreator() && currentState.state === 'lobby' && currentState.problemSequence.length === 0) {
        inviteShownThisSession = true;
        openInvite();
      }

      // If race already in progress when we joined / state moves to racing, hand off.
      if (!raceStartHandled && (currentState.state === 'racing' || currentState.state === 'countdown') && onRaceStart) {
        raceStartHandled = true;
        onRaceStart({ roomClient: client, initialState: currentState, youAre });
      }
      // After a rematch, state goes back to 'lobby' — re-arm raceStartHandled
      // and pull the user back to lobby-room if they were sitting on results/race.
      if (currentState.state === 'lobby') {
        raceStartHandled = false;
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
    } else if (msg.type === 'error') {
      showError(msg.message || msg.code);
    }
  });

  return {
    client,
    detach() {
      client.close();
    },
  };
}
