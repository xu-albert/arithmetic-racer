import { createRunner } from './src/runner.js';
import { generateHandle } from './src/handles.js';
import { pickBotTiers } from './src/bot.js';
import { attachRaceUI } from './src/ui.js';

const screens = {
  lobby: document.getElementById('lobby'),
  race: document.getElementById('race'),
  results: document.getElementById('results'),
};

const diffButtons = document.querySelectorAll('.diff-btn');
const quickplayBtn = document.getElementById('quickplay-btn');
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

diffButtons.forEach((btn) => {
  btn.addEventListener('click', () => setDifficulty(btn.dataset.difficulty));
});

quickplayBtn.addEventListener('click', startQuickplay);

playAgainBtn.addEventListener('click', () => {
  showScreen('lobby');
});

setDifficulty('easy');
showScreen('lobby');
