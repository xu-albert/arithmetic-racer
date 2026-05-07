import { createRunner } from './src/runner.js';
import { generateHandle } from './src/handles.js';
import { pickBotTiers } from './src/bot.js';
import { attachRaceUI } from './src/ui.js';
import { attachLobby } from './src/lobby.js';
import { createRemoteRunner } from './src/remote-runner.js';

const screens = {
  lobby: document.getElementById('lobby'),
  'lobby-room': document.getElementById('lobby-room'),
  race: document.getElementById('race'),
  results: document.getElementById('results'),
};

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

function startQuickplay() {
  if (cleanupRace) {
    cleanupRace();
    cleanupRace = null;
  }

  const taken = new Set();
  const playerHandle = generateHandle(Math.random, taken);
  taken.add(playerHandle);

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

  showScreen('race');
  cleanupRace = attachRaceUI({ runner, raceLength: runner.raceLength, screens });
  runner.start();
}

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

function enterRoom(roomId) {
  history.replaceState(null, '', `/?room=${roomId}`);
  lobbyHandle = attachLobby({ roomId, screens, onRaceStart: handleRoomRaceStart });
  showScreen('lobby-room');
}

const params = new URLSearchParams(location.search);
const initialRoomId = params.get('room');

if (initialRoomId) {
  enterRoom(initialRoomId);
} else {
  lobbyDiffButtons.forEach((btn) => {
    btn.addEventListener('click', () => setDifficulty(btn.dataset.difficulty));
  });
  quickplayBtn.addEventListener('click', startQuickplay);
  setDifficulty('easy');
  showScreen('lobby');
}

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
