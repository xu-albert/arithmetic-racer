// Screen switching and Profile return-screen tracking for main.js.
// Extracted so unit tests can exercise direct ?room= boot, in-room Profile
// open/close, and results->Profile->results without a browser.

export function createScreenNav({ screens, onLobbyShown, onEnsureLobbyWired } = {}) {
  let currentScreen = null;
  let returnScreen = 'lobby';

  function showScreen(name) {
    for (const [key, el] of Object.entries(screens)) {
      el?.classList.toggle('hidden', key !== name);
    }
    currentScreen = name;
    if (name === 'lobby') onLobbyShown?.();
  }

  function activeScreen() {
    // ui.js transitions race -> results directly on screens.race/results, so
    // check which screen element is actually unhidden before falling back.
    for (const [key, el] of Object.entries(screens)) {
      if (key !== 'profile' && el && !el.classList.contains('hidden')) return key;
    }
    return currentScreen;
  }

  function openProfile() {
    const visible = activeScreen();
    if (visible && visible !== 'profile') returnScreen = visible;
    const backLink = screens.profile?.querySelector('.profile__back');
    if (backLink) {
      backLink.textContent = returnScreen === 'lobby' ? '← Back to lobby' : '← Back';
    }
    showScreen('profile');
  }

  function closeProfile() {
    const target = returnScreen || 'lobby';
    if (target === 'lobby') onEnsureLobbyWired?.();
    showScreen(target);
  }

  return {
    showScreen,
    openProfile,
    closeProfile,
    getCurrentScreen: () => currentScreen,
    getReturnScreen: () => returnScreen,
  };
}
