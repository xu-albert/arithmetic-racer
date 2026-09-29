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
import { attachCaptchaUI } from './src/captcha-ui.js';
import { createRemoteRunner } from './src/remote-runner.js';
import { mountHeader } from './src/header.js';
import { mountAuthModal } from './src/auth.js';
import { mountProfile } from './src/profile.js';
import { mountLeaderboard } from './src/leaderboard.js';
import { postRaceResult } from './src/stats-api.js';
import { soloResultPayload } from './src/solo-result.js';
import { getOrCreateDeviceId } from './src/identity.js';
import { joinMatchmaking } from './src/matchmake-api.js';
import { mountRecentFinishes } from './src/recent-finishes.js';

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
// Phase A behavior: when the local runner emits `finish` for a race the
// player completed, POST the result so it lands in race_results with the
// right user_id (or NULL for anon). A quit posts nothing.
// Room races are NOT handled here — that wiring is commit B (the room
// Durable Object writes its own result rows).

function reportRaceResult({ runner, difficulty }) {
  // Null for a quit: only finished solo races are stored (solo-result.js).
  const payload = soloResultPayload({ runner, difficulty, deviceId: getOrCreateDeviceId() });
  if (!payload) return;

  postRaceResult(payload)
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
// Lobby "who's racing" strip. Mounted unconditionally — it no-ops on pages
// (and screens) where its elements are absent, and gates its own polling on the
// lobby being visible.
mountRecentFinishes();

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
  'room-expired': document.getElementById('room-expired'),
};

// Difficulty picker is scoped to #lobby — the room lobby has its own.
const lobbyDiffButtons = document.querySelectorAll('#lobby .diff-btn');
const quickplayBtn = document.getElementById('quickplay-btn');
const createRoomBtn = document.getElementById('create-room-btn');
const playAgainBtn = document.getElementById('play-again-btn');

let selectedDifficulty = 'easy';
let cleanupRace = null;
let lobbyHandle = null;
// Attached for the life of the room, not the race: a verification opens at the
// racer's own finish and has to survive the results screen and a reload.
let cleanupCaptcha = null;
// Set only on the lobby route — see the initial-routing block below.
let leaderboardHandle = null;

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
  // The "who's racing" strip polls only while the lobby is on-screen, so it
  // needs to hear about coming back to a lobby that has been away.
  if (name === 'lobby') document.dispatchEvent(new Event('lobby-shown'));
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

// Terminal state for a private room: the server wound it down after 30 minutes
// of inactivity. Tear everything room-shaped down so nothing keeps rendering
// against a room that no longer exists, then offer the two ways out.
function handleRoomExpired() {
  if (cleanupRace) { cleanupRace(); cleanupRace = null; }
  if (cleanupCaptcha) { cleanupCaptcha(); cleanupCaptcha = null; }
  if (lobbyHandle) { lobbyHandle.detach(); lobbyHandle = null; }
  document.getElementById('invite-modal')?.classList.add('hidden');
  showScreen('room-expired');
  // The switch can happen while the player is staring at the race screen, so
  // move focus rather than leaving a screen reader on a lane that just vanished.
  screens['room-expired']?.focus();
}

function enterRoom(roomId, { mode, difficulty } = {}) {
  if (!mode) history.replaceState(null, '', `/?room=${roomId}`);
  if (cleanupCaptcha) { cleanupCaptcha(); cleanupCaptcha = null; }
  lobbyHandle = attachLobby({
    roomId,
    screens,
    onRaceStart: handleRoomRaceStart,
    onRoomExpired: handleRoomExpired,
    mode,
    difficulty,
    deviceId: getOrCreateDeviceId(),
  });
  cleanupCaptcha = attachCaptchaUI({ client: lobbyHandle.client });
  showScreen('lobby-room');
}

async function createRoom() {
  const res = await fetch('/api/rooms', { method: 'POST' });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const { roomId } = await res.json();
  return roomId;
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
  // Mounted only on this route: a `?room=` deep link never shows the lobby, so
  // fetching boards there would be a request for a screen nobody will see.
  //
  // The board opens on Medium — the tier Find a Match sits on beside it — and
  // deliberately does not follow `selectedDifficulty`, which is the Solo vs
  // Bots picker and belongs to a mode that never reaches a board.
  leaderboardHandle = mountLeaderboard(document.getElementById('leaderboard'), {
    difficulty: 'medium',
  });
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
    enterRoom(await createRoom());
  } catch (e) {
    console.error('create room failed', e);
    alert('Could not create room. Try again.');
  } finally {
    createRoomBtn.disabled = false;
  }
});

// ---- Expired-room screen ------------------------------------------------

const expiredHomeBtn = document.getElementById('expired-home-btn');
const expiredNewRoomBtn = document.getElementById('expired-new-room-btn');

expiredHomeBtn?.addEventListener('click', () => {
  // Full navigation, not showScreen: the URL still carries ?room=<dead id>,
  // and a reload of it would land right back on this screen.
  location.assign('/');
});

expiredNewRoomBtn?.addEventListener('click', async () => {
  expiredNewRoomBtn.disabled = true;
  try {
    const roomId = await createRoom();
    location.assign(`/?room=${encodeURIComponent(roomId)}`);
  } catch (e) {
    console.error('create room failed', e);
    alert('Could not create room. Try again.');
    expiredNewRoomBtn.disabled = false;
  }
});

playAgainBtn.addEventListener('click', () => {
  // Public quickmatch rooms are one-shot — returning to the dead room's
  // lobby is a dead end, so go home where Find a Match lives.
  if (initialMode === 'public') {
    location.assign('/');
    return;
  }
  if (initialRoomId || lobbyHandle) {
    showScreen('lobby-room');
  } else {
    showScreen('lobby');
    // The tab may have sat on the race screen for a while; other people's
    // room races land on the boards in the meantime.
    leaderboardHandle?.refresh();
  }
});
