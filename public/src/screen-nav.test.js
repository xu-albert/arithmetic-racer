import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenNav } from './screen-nav.js';

function fakeScreen(id, { hidden = true, backLink = null } = {}) {
  const classes = new Set(hidden ? ['hidden'] : []);
  return {
    id,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, force) => {
        const shouldHave = force === undefined ? !classes.has(c) : Boolean(force);
        if (shouldHave) classes.add(c);
        else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    querySelector: (sel) => (sel === '.profile__back' ? backLink : null),
  };
}

function makeScreens(initial = 'lobby-room') {
  const backLink = { textContent: '← Back to lobby' };
  const screens = {
    lobby: fakeScreen('lobby', { hidden: initial !== 'lobby' }),
    'lobby-room': fakeScreen('lobby-room', { hidden: initial !== 'lobby-room' }),
    race: fakeScreen('race', { hidden: initial !== 'race' }),
    results: fakeScreen('results', { hidden: initial !== 'results' }),
    profile: fakeScreen('profile', { hidden: true, backLink }),
    'room-expired': fakeScreen('room-expired', { hidden: initial !== 'room-expired' }),
  };
  return { screens, backLink };
}

describe('createScreenNav — Profile return-screen tracking', () => {
  test('opening Profile from #lobby-room (direct ?room= boot) returns to #lobby-room without unhiding #lobby', () => {
    const { screens, backLink } = makeScreens('lobby-room');
    let lobbyShownCount = 0;
    let lobbyWiredCount = 0;
    const nav = createScreenNav({
      screens,
      onLobbyShown: () => { lobbyShownCount++; },
      onEnsureLobbyWired: () => { lobbyWiredCount++; },
    });

    nav.showScreen('lobby-room');
    nav.openProfile();

    assert.equal(screens.profile.classList.contains('hidden'), false);
    assert.equal(screens['lobby-room'].classList.contains('hidden'), true);
    assert.equal(screens.lobby.classList.contains('hidden'), true);
    assert.equal(backLink.textContent, '← Back');

    nav.closeProfile();

    assert.equal(screens.profile.classList.contains('hidden'), true);
    assert.equal(screens['lobby-room'].classList.contains('hidden'), false);
    assert.equal(screens.lobby.classList.contains('hidden'), true, '#lobby must remain hidden');
    assert.equal(lobbyShownCount, 0);
    assert.equal(lobbyWiredCount, 0);
  });

  test('opening Profile from #lobby keeps "← Back to lobby" and returns to #lobby', () => {
    const { screens, backLink } = makeScreens('lobby');
    let lobbyShownCount = 0;
    let lobbyWiredCount = 0;
    const nav = createScreenNav({
      screens,
      onLobbyShown: () => { lobbyShownCount++; },
      onEnsureLobbyWired: () => { lobbyWiredCount++; },
    });

    nav.showScreen('lobby');
    assert.equal(lobbyShownCount, 1);

    nav.openProfile();
    assert.equal(backLink.textContent, '← Back to lobby');
    assert.equal(screens.lobby.classList.contains('hidden'), true);
    assert.equal(screens.profile.classList.contains('hidden'), false);

    nav.closeProfile();
    assert.equal(screens.lobby.classList.contains('hidden'), false);
    assert.equal(screens.profile.classList.contains('hidden'), true);
    assert.equal(lobbyShownCount, 2);
    assert.equal(lobbyWiredCount, 1);
  });

  test('opening Profile from #race or #results (including direct DOM toggle by ui.js) restores the active screen', () => {
    const { screens, backLink } = makeScreens('race');
    const nav = createScreenNav({ screens });
    nav.showScreen('race');

    // Open mid-race
    nav.openProfile();
    assert.equal(backLink.textContent, '← Back');
    nav.closeProfile();
    assert.equal(screens.race.classList.contains('hidden'), false);

    // Simulate ui.js transitioning race -> results directly without showScreen()
    screens.race.classList.add('hidden');
    screens.results.classList.remove('hidden');

    nav.openProfile();
    assert.equal(backLink.textContent, '← Back');
    assert.equal(screens.results.classList.contains('hidden'), true);
    nav.closeProfile();
    assert.equal(screens.results.classList.contains('hidden'), false);
    assert.equal(screens.race.classList.contains('hidden'), true);
  });

  test('re-dispatching open-profile while already on #profile preserves the original returnScreen', () => {
    const { screens } = makeScreens('lobby-room');
    const nav = createScreenNav({ screens });
    nav.showScreen('lobby-room');

    nav.openProfile();
    nav.openProfile();
    nav.closeProfile();

    assert.equal(screens['lobby-room'].classList.contains('hidden'), false);
    assert.equal(screens.lobby.classList.contains('hidden'), true);
  });

  test('opening Profile when mountProfile already unhid #profile still records a screen listed after profile in screens', () => {
    const { screens, backLink } = makeScreens('room-expired');
    const nav = createScreenNav({ screens });
    nav.showScreen('room-expired');

    // Simulate mountProfile's open-profile listener running before nav.openProfile()
    screens.profile.classList.remove('hidden');
    nav.openProfile();
    assert.equal(backLink.textContent, '← Back');
    assert.equal(nav.getReturnScreen(), 'room-expired');

    nav.closeProfile();
    assert.equal(screens['room-expired'].classList.contains('hidden'), false);
    assert.equal(screens.profile.classList.contains('hidden'), true);
  });
});
