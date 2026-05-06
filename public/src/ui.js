// DOM bindings for the race screen. The only file that touches the DOM directly.
// All state lives in runner.js; this module just renders runner events.

export function attachRaceUI({ runner, raceLength, screens }) {
  const track = document.getElementById('track');
  const problemQueue = document.getElementById('problem-queue');
  const countdownEl = document.getElementById('countdown');
  const input = document.getElementById('answer-input');
  const scoreEl = document.getElementById('score');
  const podium = document.getElementById('podium');
  const quitBtn = document.getElementById('quit-race-btn');
  const playerRacer = runner.racers.find((r) => r.id === 'player');

  track.innerHTML = '';
  const carEls = new Map();
  const laneEls = new Map();
  for (const racer of runner.racers) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.dataset.racerId = racer.id;

    const handleEl = document.createElement('span');
    handleEl.className = 'lane-handle';
    handleEl.textContent = racer.handle;

    const car = document.createElement('div');
    car.className = 'car' + (racer.id === 'player' ? ' you' : '');
    car.style.setProperty('--progress', '0');

    const finish = document.createElement('div');
    finish.className = 'lane-finish';

    lane.append(handleEl, car, finish);
    track.append(lane);
    carEls.set(racer.id, car);
    laneEls.set(racer.id, lane);
  }

  problemQueue.innerHTML = '';
  for (let i = 0; i < runner.sequence.length; i++) {
    const div = document.createElement('div');
    div.className = 'queue-item';
    div.textContent = runner.sequence[i].problem;
    problemQueue.append(div);
  }

  function updateQueue() {
    const idx = playerRacer.score;
    const items = problemQueue.querySelectorAll('.queue-item');
    items.forEach((el, i) => {
      el.classList.remove('current', 'upcoming-1', 'upcoming-2', 'upcoming-3');
      const offset = i - idx;
      if (offset === 0) el.classList.add('current');
      else if (offset === 1) el.classList.add('upcoming-1');
      else if (offset === 2) el.classList.add('upcoming-2');
      else if (offset === 3) el.classList.add('upcoming-3');
    });
    const rowHeight = items[0]?.offsetHeight ?? 0;
    problemQueue.style.transform = `translateY(-${idx * rowHeight}px)`;
  }

  updateQueue();
  scoreEl.textContent = `0 / ${raceLength}`;
  input.value = '';
  input.disabled = true;

  function onSubmit() {
    const raw = input.value;
    if (!raw.trim()) return;
    runner.submitAnswer(raw);
    input.value = '';
  }

  function renderPodium() {
    podium.innerHTML = '';
    const rankings = runner.getRankings();
    rankings.forEach((r, i) => {
      const li = document.createElement('li');
      const youBadge = r.id === 'player' ? ' (you)' : '';
      let detail;
      if (r.dropped) detail = `left mid-race at ${r.score}/${raceLength}`;
      else if (r.finishMs != null) detail = `${r.score}/${raceLength} in ${(r.finishMs / 1000).toFixed(1)}s`;
      else if (r.dnf) detail = `${r.score}/${raceLength} — didn't finish`;
      else detail = `${r.score}/${raceLength} — waiting for results`;
      li.textContent = `${i + 1}. ${r.handle}${youBadge} — ${detail}`;
      if (r.dropped || r.dnf || r.finishMs == null) li.classList.add('unfinished');
      podium.append(li);
    });
  }

  function onKey(e) {
    if (e.key === 'Enter') onSubmit();
  }

  function onQuit() {
    runner.quit();
  }

  input.addEventListener('keydown', onKey);
  quitBtn.addEventListener('click', onQuit);

  const unsubscribe = runner.on((event, data) => {
    if (event === 'countdown') {
      countdownEl.classList.remove('hidden');
      countdownEl.textContent = data.n === 0 ? 'GO' : String(data.n);
    } else if (event === 'start') {
      countdownEl.classList.add('hidden');
      countdownEl.textContent = '';
      input.disabled = false;
      input.focus();
    } else if (event === 'advance') {
      const car = carEls.get(data.racerId);
      if (car) car.style.setProperty('--progress', String(data.score / raceLength));
      if (data.racerId === 'player') {
        scoreEl.textContent = `${data.score} / ${raceLength}`;
        if (data.score >= raceLength) {
          input.disabled = true;
          input.value = '';
        }
        updateQueue();
      }
      if (podium.childElementCount > 0) renderPodium();
    } else if (event === 'wrong') {
      input.classList.add('wrong');
      setTimeout(() => input.classList.remove('wrong'), 250);
    } else if (event === 'drop') {
      const lane = laneEls.get(data.racerId);
      if (lane) lane.classList.add('dropped');
      if (podium.childElementCount > 0) renderPodium();
    } else if (event === 'finish') {
      input.disabled = true;
      renderPodium();
      setTimeout(() => {
        screens.race.classList.add('hidden');
        screens.results.classList.remove('hidden');
      }, 800);
    }
  });

  return () => {
    input.removeEventListener('keydown', onKey);
    quitBtn.removeEventListener('click', onQuit);
    unsubscribe();
    runner.stop();
  };
}
