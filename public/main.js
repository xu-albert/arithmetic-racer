// Entry point — merges Phase A (users + auth + stats) and Phase 6 (private
// multiplayer rooms). Both branches rewrote this file; this version
// preserves all features of each.
//
// Boot order: imports → identity helpers → mount Phase A UI →
// screens/state → quickplay (solo) → rooms (multiplayer) → initial routing.

import { createRunner } from './src/runner.js';
import { generateHandle } from './src/handles.js';
import { pickBotTiers } from './src/bot.js';
import { attachRaceUI } from './src/ui.js';
import { attachLobby } from './src/lobby.js';
import { createRemoteRunner } from './src/remote-runner.js';
import { mountHeader } from './src/header.js';
import { mountAuthModal } from './src/auth.js';
import { mountProfile } from './src/profile.js';
import { postRaceResult } from './src/stats-api.js';
import { getOrCreateDeviceId } from './src/identity.js';
import { joinMatchmaking } from './src/matchmake-api.js';

// ---- Identity helpers --------------------------------------------------

function getOrCreateAnonHandle() {
  let h = localStorage.getItem('anonHandle');
  if (!h) {
    h = generateHandle(Math.random);
    localStorage.setItem('anonHandle', h);
  }
  return h;
}

// Cache of the logged-in user's username — set by the `session-ready`
// event dispatched by header.js after its /api/me fetch. Saves a duplicate
// fetch and lets quickplay pick the right lane label.
let currentUsername = null;
document.addEventListener('session-ready', (e) => {
  currentUsername = e.detail?.username ?? null;
});

// ---- Race-result reporting (solo / quickplay) --------------------------
//
// Phase A behavior: when the local runner emits `finish`, POST the result
// so it lands in race_results with the right user_id (or NULL for anon).
// Room races are NOT handled here — that wiring is commit B (the room
// Durable Object writes its own result rows).

function reportRaceResult({ runner, difficulty }) {
  const player = runner.racers.find((r) => !r.isBot);
  if (!player) return;
  const finished = player.score >= runner.raceLength;
  const finishTime = finished ? player.finishMs : null;
  const attempts = player.attempts || 0;
  const correct = player.score;
  const accuracy = attempts > 0 ? (correct / attempts) * 100 : 0;
  const avgPerProblem = finishTime != null && correct > 0
    ? Math.round(finishTime / correct)
    : 0;

  postRaceResult({
    device_id: getOrCreateDeviceId(),
    difficulty,
    finished,
    finish_time_ms: finishTime,
    problems_total: runner.raceLength,
    problems_correct: correct,
    problems_attempted: attempts,
    avg_time_per_problem_ms: avgPerProblem,
    accuracy_pct: accuracy,
    longest_streak: player.longestStreak || 0,
  })
    .then(() => {
      // Tell the header pill to refresh without a page reload.
      document.dispatchEvent(new Event('race-finished'));
    })
    .catch((err) => {
      // Best-effort: race UX never blocks on the POST.
      console.warn('[race-result] post failed', err);
    });
}

// ---- Mount Phase A UI ---------------------------------------------------

mountHeader(document.getElementById('app-header'));
mountAuthModal(document.getElementById('auth-modal-root'));
mountProfile(document.getElementById('profile'));

document.addEventListener('open-profile', () => {
  showScreen('profile');
});

// ---- Screens & lobby state ---------------------------------------------

const screens = {
  lobby: document.getElementById('lobby'),
  'lobby-room': document.getElementById('lobby-room'),
  race: document.getElementById('race'),
  results: document.getElementById('results'),
  profile: document.getElementById('profile'),
};

// Difficulty picker is scoped to #lobby — the room lobby has its own.
const lobbyDiffButtons = document.querySelectorAll('#lobby .diff-btn');
const quickplayBtn = document.getElementById('quickplay-btn');
const createRoomBtn = document.getElementById('create-room-btn');
const playAgainBtn = document.getElementById('play-again-btn');

let selectedDifficulty = 'easy';
let cleanupRace = null;
let lobbyHandle = null;

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
}

function setDifficulty(diff) {
  selectedDifficulty = diff;
  lobbyDiffButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.difficulty === diff ? 'true' : 'false');
  });
}

// ---- Quickplay (solo vs bots) -------------------------------------------

function startQuickplay() {
  if (cleanupRace) {
    cleanupRace();
    cleanupRace = null;
  }

  // Lane label: logged-in username wins. Anon players get the persistent
  // localStorage handle PLUS "(Guest)" so the race screen consistently
  // signals "you're not signed in" — mirrors the multiplayer room badge.
  const isLoggedIn = !!currentUsername;
  const baseName = currentUsername || getOrCreateAnonHandle();
  const playerHandle = isLoggedIn ? baseName : `${baseName} (Guest)`;
  const taken = new Set([baseName]);

  const tiers = pickBotTiers(selectedDifficulty, 4);
  const bots = tiers.map((tier) => {
    const handle = generateHandle(Math.random, taken);
    taken.add(handle);
    return { handle, tier };
  });

  const runner = createRunner({
    difficulty: selectedDifficulty,
    seed: Math.floor(Math.random() * 1e9),
    player: { handle: playerHandle },
    bots,
  });

  runner.on((event) => {
    if (event === 'finish') {
      reportRaceResult({ runner, difficulty: selectedDifficulty });
    }
  });

  showScreen('race');
  cleanupRace = attachRaceUI({ runner, raceLength: runner.raceLength, screens });
  runner.start();
}

// ---- Private rooms (Phase 6) -------------------------------------------

function handleRoomRaceStart({ roomClient, initialState, youAre }) {
  if (cleanupRace) { cleanupRace(); cleanupRace = null; }
  const runner = createRemoteRunner({
    roomClient,
    initialState,
    youAre,
    onLocalQuit: () => {
      if (cleanupRace) { cleanupRace(); cleanupRace = null; }
      showScreen('lobby-room');
    },
  });
  showScreen('race');
  cleanupRace = attachRaceUI({ runner, raceLength: initialState.raceLength, screens });
}

function enterRoom(roomId, { mode, difficulty } = {}) {
  if (!mode) history.replaceState(null, '', `/?room=${roomId}`);
  lobbyHandle = attachLobby({
    roomId,
    screens,
    onRaceStart: handleRoomRaceStart,
    mode,
    difficulty,
    deviceId: getOrCreateDeviceId(),
  });
  showScreen('lobby-room');
}

// ---- Initial routing ----------------------------------------------------

const params = new URLSearchParams(location.search);
const initialRoomId = params.get('room');
const initialMode = params.get('mode') ?? undefined;
const initialDifficulty = params.get('difficulty') ?? undefined;

if (initialRoomId) {
  enterRoom(initialRoomId, { mode: initialMode, difficulty: initialDifficulty });
} else {
  lobbyDiffButtons.forEach((btn) => {
    btn.addEventListener('click', () => setDifficulty(btn.dataset.difficulty));
  });
  quickplayBtn.addEventListener('click', startQuickplay);
  setDifficulty('easy');
  showScreen('lobby');
}

// ---- Find a Match (public matchmaking) ----------------------------------

const findMatchBtn = document.getElementById('btn-find-match');
const matchStatus = document.getElementById('match-status');

findMatchBtn?.addEventListener('click', async () => {
  const checkedRadio = document.querySelector('input[name="match-diff"]:checked');
  const diff = checkedRadio ? checkedRadio.value : 'medium';
  findMatchBtn.disabled = true;
  matchStatus.textContent = 'Searching…';
  try {
    const { roomId, difficulty } = await joinMatchmaking({
      difficulty: diff,
      deviceId: getOrCreateDeviceId(),
    });
    window.location.href = `/?room=${encodeURIComponent(roomId)}&mode=public&difficulty=${encodeURIComponent(difficulty)}`;
  } catch (e) {
    matchStatus.textContent = e.message || 'Error finding match';
    findMatchBtn.disabled = false;
  }
});

createRoomBtn.addEventListener('click', async () => {
  createRoomBtn.disabled = true;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const { roomId } = await res.json();
    enterRoom(roomId);
  } catch (e) {
    console.error('create room failed', e);
    alert('Could not create room. Try again.');
  } finally {
    createRoomBtn.disabled = false;
  }
});

playAgainBtn.addEventListener('click', () => {
  if (initialRoomId || lobbyHandle) {
    showScreen('lobby-room');
  } else {
    showScreen('lobby');
  }
});
