import { ADJECTIVES, ANIMALS } from '../public/src/handles.js';

export function generateRoomId(rng = Math.random) {
  const adj = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)].toLowerCase();
  const a1 = ANIMALS[Math.floor(rng() * ANIMALS.length)].toLowerCase();
  let a2 = ANIMALS[Math.floor(rng() * ANIMALS.length)].toLowerCase();
  for (let i = 0; i < 10 && a2 === a1; i++) {
    a2 = ANIMALS[Math.floor(rng() * ANIMALS.length)].toLowerCase();
  }
  return `${adj}-${a1}-${a2}`;
}
