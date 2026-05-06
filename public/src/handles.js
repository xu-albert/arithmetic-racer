// Anonymous handle generator. Adjective + Animal, e.g. "BraveOtter", "SilentBadger".

const ADJECTIVES = [
  'Brave', 'Silent', 'Swift', 'Clever', 'Quick', 'Bold', 'Lucky', 'Sleepy',
  'Fierce', 'Calm', 'Quiet', 'Sharp', 'Wild', 'Sly', 'Nimble', 'Fuzzy',
  'Mighty', 'Witty', 'Eager', 'Jolly', 'Plucky', 'Stoic', 'Zesty', 'Cosmic',
];

const ANIMALS = [
  'Otter', 'Badger', 'Panda', 'Falcon', 'Wolf', 'Lynx', 'Owl', 'Heron',
  'Fox', 'Hawk', 'Mole', 'Mantis', 'Crow', 'Toad', 'Bear', 'Stoat',
  'Raven', 'Newt', 'Hare', 'Eel', 'Mink', 'Tapir', 'Yak', 'Ibis',
];

export function generateHandle(rng = Math.random, taken = new Set()) {
  for (let i = 0; i < 50; i++) {
    const adj = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)];
    const ani = ANIMALS[Math.floor(rng() * ANIMALS.length)];
    const handle = `${adj}${ani}`;
    if (!taken.has(handle)) return handle;
  }
  return `${ADJECTIVES[0]}${ANIMALS[0]}${Math.floor(rng() * 100)}`;
}
