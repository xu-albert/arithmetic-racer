import { createRunner, RACE_LENGTH } from './src/runner.js';
import { generateHandle } from './src/handles.js';
import { pickBotTiers } from './src/bot.js';
import { attachRaceUI } from './src/ui.js';
import { mountHeader } from './src/header.js';
import { mountAuthModal } from './src/auth.js';
import { mountProfile } from './src/profile.js';
import { postRaceResult, getMe } from './src/stats-api.js';

function getOrCreateDeviceId() {
  let id = localStorage.getItem('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('deviceId', id);
  }
  return id;
}

// The header (header.js) writes the persistent anonymous handle to
// localStorage.anonHandle on first visit. Reading the same key here keeps
// the player's lane name consistent with the header. If the header hasn't
// run yet (shouldn't happen — mountHeader is called above), generate one
// and persist so subsequent loads stay consistent.
function getOrCreateAnonHandle() {
  let h = localStorage.getItem('anonHandle');
  if (!h) {
    h = generateHandle(Math.random);
    localStorage.setItem('anonHandle', h);
  }
  return h;
}

// Cache of the logged-in user's username. Refreshed on auth-changed events.
// null means anonymous.
let currentUsername = null;
async function refreshUsername() {
  const me = await getMe().catch(() => null);
  currentUsername = me?.username || null;
}
document.addEventListener('auth-changed', refreshUsername);
refreshUsername();

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
  }).catch((err) => {
    // Non-fatal: race UX should never depend on the network call succeeding.
    console.warn('[race-result] post failed', err);
  });
}

mountHeader(document.getElementById('app-header'));
mountAuthModal(document.getElementById('auth-modal-root'));
mountProfile(document.getElementById('profile'));

// When the header dispatches `open-profile`, swap screens.
document.addEventListener('open-profile', () => {
  showScreen('profile');
});

const screens = {
  lobby: document.getElementById('lobby'),
  race: document.getElementById('race'),
  results: document.getElementById('results'),
  profile: document.getElementById('profile'),
};

const diffButtons = document.querySelectorAll('.diff-btn');
const quickplayBtn = document.getElementById('quickplay-btn');
const createRoomBtn = document.getElementById('create-room-btn');
const playAgainBtn = document.getElementById('play-again-btn');

let selectedDifficulty = 'easy';
let cleanupRace = null;

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
}

function setDifficulty(diff) {
  selectedDifficulty = diff;
  diffButtons.forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.difficulty === diff ? 'true' : 'false');
  });
}

function startQuickplay() {
  if (cleanupRace) {
    cleanupRace();
    cleanupRace = null;
  }

  // Use the logged-in username when available, else the persistent anon
  // handle. Falls back to a fresh generated name only if both are missing
  // (which shouldn't happen because the header populates anonHandle on
  // first paint).
  const playerHandle = currentUsername || getOrCreateAnonHandle();
  const taken = new Set([playerHandle]);

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

  // Submit the race-result once the runner emits finish. The runner emits
  // finish for both natural completion and quit (player.dropped = true).
  runner.on((event) => {
    if (event === 'finish') {
      reportRaceResult({ runner, difficulty: selectedDifficulty });
    }
  });

  showScreen('race');
  cleanupRace = attachRaceUI({ runner, raceLength: runner.raceLength, screens });
  runner.start();
}

diffButtons.forEach((btn) => {
  btn.addEventListener('click', () => setDifficulty(btn.dataset.difficulty));
});

quickplayBtn.addEventListener('click', startQuickplay);

createRoomBtn.addEventListener('click', () => {
  alert('Private rooms come in Phase 7. For now: Quickplay.');
});

playAgainBtn.addEventListener('click', () => {
  showScreen('lobby');
});

setDifficulty('easy');
showScreen('lobby');
