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

  // Place is read off the one ranking this project has — rankings.js, which the
  // podium below the banner draws and the server sorts its own results by — so
  // the two can never disagree. Counting finishers here instead would miss the
  // tiering rankRacers applies to a seat that is dropped or DNF.
  //
  // Note the server will not hand us a dropped finisher: `dropRacer` refuses a
  // seat that already carries a finishMs, and PublicRaceRoom holds a departed
  // finisher's seat instead of splicing it, so an earned finish survives a quit
  // or a disconnect. The tiering still has to be honoured here because DNF
  // seats reach it, and because rankings.js is shared with hand-built data.
  //
  // Repaintable, because in a room race it is painted more than once: from the
  // optimistic finish, again from the time the room stamped, and again for
  // every finish that lands behind this player's own. Every class it sets has
  // to come back off if a later paint disagrees.
  function showFinishBanner() {
    const index = runner.getRankings().findIndex((r) => r.id === 'player');
    if (index < 0) return;
    const place = index + 1;
    const seconds = (playerRacer.finishMs / 1000).toFixed(2);
    finishBannerPlace.textContent = `${place}${ordinalSuffix(place)} place`;
    finishBannerTime.textContent = `${seconds}s`;
    finishBanner.classList.remove('hidden');
    finishBanner.classList.toggle('first-place', place === 1);
    const playerCar = carEls.get('player');
    if (playerCar) playerCar.classList.toggle('victory', place === 1);
  }

  // The banner's counterpart. An authoritative frame can revoke a finish this
  // screen already announced — the room ignored the answer because the race had
  // already ended, or a reconnect snapshot shows the server never received it —
  // and every class the banner set has to come back off with it.
  function hideFinishBanner() {
    finishBanner.classList.add('hidden');
    finishBanner.classList.remove('first-place');
    carEls.get('player')?.classList.remove('victory');
  }

  // Paint the banner from whatever the local racer's finish currently is, so a
  // single call is correct whether the finish was just earned, re-placed behind
  // a later arrival, or taken away.
  function paintFinishBanner() {
    if (playerRacer.finishMs != null) showFinishBanner();
    else hideFinishBanner();
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
        // Reconnect can move this backwards: an answer whose frame never
        // reached the room leaves the screen finished while the server still
        // has the earlier score. Derive the input from the authoritative state
        // each time rather than only ever closing it.
        const done = data.score >= raceLength || playerRacer.dropped;
        input.disabled = done;
        if (done) input.value = '';
        paintFinishBanner();
        updateQueue();
      } else if (data.finishMs != null && playerRacer.finishMs != null) {
        // Somebody else reached the line after this player's banner was
        // painted. If they got there first — a bot the client is still
        // catching up, an opponent whose finish the socket delivered late —
        // the place on screen is now one too good.
        showFinishBanner();
      }
      if (podium.childElementCount > 0) renderPodium();
    } else if (event === 'wrong') {
      input.classList.add('wrong');
      setTimeout(() => input.classList.remove('wrong'), 250);
    } else if (event === 'drop') {
      const lane = laneEls.get(data.laneId);
      if (lane) lane.classList.add('dropped');
      // A seat the room dropped cannot score again; its answers are ignored on
      // both sides, so leave no box inviting them.
      if (data.laneId === 'player') { input.disabled = true; input.value = ''; }
      paintFinishBanner();
      if (podium.childElementCount > 0) renderPodium();
    } else if (event === 'finish') {
      input.disabled = true;
      input.value = '';
      paintFinishBanner();
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
