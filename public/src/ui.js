// DOM bindings for the race screen. The only file that touches the DOM directly.
// All state lives in runner.js; this module just renders runner events.

export function attachRaceUI({ runner, raceLength, screens }) {
  const track = document.getElementById('track');
  const problemQueue = document.getElementById('problem-queue');
  const countdownEl = document.getElementById('countdown');
  const finishBanner = document.getElementById('finish-banner');
  const finishBannerPlace = finishBanner.querySelector('.finish-banner-place');
  const finishBannerTime = finishBanner.querySelector('.finish-banner-time');
  const input = document.getElementById('answer-input');
  const scoreEl = document.getElementById('score');
  const podium = document.getElementById('podium');
  const quitBtn = document.getElementById('quit-race-btn');
  const bugReportLink = document.querySelector('#hud .bug-report-link');
  const playerRacer = runner.racers.find((r) => r.id === 'player');

  track.innerHTML = '';
  const carEls = new Map();
  const laneEls = new Map();
  for (const racer of runner.racers) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.dataset.laneId = racer.id;

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

  // Cache rowHeight once — reading offsetHeight on every advance forces a
  // synchronous layout, which competes with the car-animation paint frames.
  let cachedRowHeight = 0;
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
    if (cachedRowHeight === 0) cachedRowHeight = items[0]?.offsetHeight ?? 0;
    problemQueue.style.transform = `translateY(-${idx * cachedRowHeight}px)`;
  }

  updateQueue();
  scoreEl.textContent = `0 / ${raceLength}`;
  input.value = '';
  input.disabled = true;
  finishBanner.classList.add('hidden');
  finishBanner.classList.remove('first-place');

  function onSubmit() {
    const raw = input.value;
    if (!raw.trim()) return;
    runner.submitAnswer(raw);
    input.value = '';
  }

  let resultsTimer = null;

  function ordinalSuffix(n) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return 'th';
    switch (n % 10) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  }

  function showFinishBanner() {
    const place = runner.racers.filter((r) => r.finishMs != null).length;
    const seconds = (playerRacer.finishMs / 1000).toFixed(2);
    finishBannerPlace.textContent = `${place}${ordinalSuffix(place)} place`;
    finishBannerTime.textContent = `${seconds}s`;
    finishBanner.classList.remove('hidden');
    finishBanner.classList.toggle('first-place', place === 1);
    const playerCar = carEls.get('player');
    if (playerCar && place === 1) {
      playerCar.classList.add('victory');
    }
  }

  function renderPodium() {
    podium.innerHTML = '';
    const rankings = runner.getRankings();
    rankings.forEach((r) => {
      const li = document.createElement('li');
      const youBadge = r.id === 'player' ? ' (you)' : '';
      let detail;
      if (r.dropped) detail = `left mid-race at ${r.score}/${raceLength}`;
      else if (r.finishMs != null) detail = `${r.score}/${raceLength} in ${(r.finishMs / 1000).toFixed(1)}s`;
      else if (r.dnf) detail = `${r.score}/${raceLength} — didn't finish`;
      else detail = `${r.score}/${raceLength} — waiting for results`;
      // Rank number comes from the CSS counter badge on #podium li::before.
      li.textContent = `${r.handle}${youBadge} — ${detail}`;
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

  // #answer-input is the only thing listening for keystrokes, and the HUD's
  // bug-report link opens in a new tab with the race still running. Hand focus
  // back, but only while there is a race to type into — input.disabled is
  // false exactly between 'start' and the player finishing.
  //
  // Only ever reclaim focus nothing has deliberately taken — the answer box
  // itself, the report link it was handed to, or nobody at all. A modal
  // (sign-in, pick a username, the invite card) installs no focus trap, and a
  // Tab-focused Quit race button is a position the player chose; neither is
  // ours to override.
  function modalIsOpen() {
    const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    return [...dialogs].some((el) => !el.hidden && !el.classList.contains('hidden'));
  }

  function restoreAnswerFocus() {
    if (input.disabled || screens.race.classList.contains('hidden')) return;
    const active = document.activeElement;
    const unclaimed =
      !active || active === document.body || active === input || active === bugReportLink;
    if (!unclaimed || modalIsOpen()) return;
    input.focus();
  }

  input.addEventListener('keydown', onKey);
  quitBtn.addEventListener('click', onQuit);
  bugReportLink?.addEventListener('click', restoreAnswerFocus);
  window.addEventListener('focus', restoreAnswerFocus);

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
      const car = carEls.get(data.laneId);
      if (car) car.style.setProperty('--progress', String(data.score / raceLength));
      if (data.laneId === 'player') {
        scoreEl.textContent = `${data.score} / ${raceLength}`;
        if (data.score >= raceLength) {
          input.disabled = true;
          input.value = '';
          showFinishBanner();
        }
        updateQueue();
      }
      if (podium.childElementCount > 0) renderPodium();
    } else if (event === 'wrong') {
      input.classList.add('wrong');
      setTimeout(() => input.classList.remove('wrong'), 250);
    } else if (event === 'drop') {
      const lane = laneEls.get(data.laneId);
      if (lane) lane.classList.add('dropped');
      if (podium.childElementCount > 0) renderPodium();
    } else if (event === 'finish') {
      input.disabled = true;
      renderPodium();
      resultsTimer = setTimeout(() => {
        screens.race.classList.add('hidden');
        screens.results.classList.remove('hidden');
      }, 800);
    }
  });

  return () => {
    if (resultsTimer) clearTimeout(resultsTimer);
    input.removeEventListener('keydown', onKey);
    quitBtn.removeEventListener('click', onQuit);
    bugReportLink?.removeEventListener('click', restoreAnswerFocus);
    window.removeEventListener('focus', restoreAnswerFocus);
    unsubscribe();
    runner.stop();
  };
}
