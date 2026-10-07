import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIGURABLE_STATES, isConfigurableState, canEditConfig,
  parseRaceLength, RACE_LENGTH_HINT, MIN_RACE_LENGTH, MAX_RACE_LENGTH,
} from './room-config-rules.js';

test('config is editable in lobby and between races', () => {
  assert.equal(isConfigurableState('lobby'), true);
  assert.equal(isConfigurableState('finished'), true);
});

test('config is locked once a race is under way', () => {
  assert.equal(isConfigurableState('countdown'), false);
  assert.equal(isConfigurableState('racing'), false);
});

test('unknown / missing phases are locked rather than open', () => {
  assert.equal(isConfigurableState(undefined), false);
  assert.equal(isConfigurableState(null), false);
  assert.equal(isConfigurableState('nonsense'), false);
});

test('canEditConfig — host may change config between races', () => {
  // The original bug: the host had just finished a race and every difficulty
  // control was dead, so the only way to race at a new difficulty was to
  // abandon the room and create a new one.
  assert.equal(canEditConfig({ roomState: 'finished', isCreator: true }), true);
  assert.equal(canEditConfig({ roomState: 'lobby', isCreator: true }), true);
});

test('canEditConfig — non-host may never change config', () => {
  for (const roomState of ['lobby', 'finished', 'countdown', 'racing']) {
    assert.equal(canEditConfig({ roomState, isCreator: false }), false, roomState);
  }
});

test('canEditConfig — nobody changes config mid-race, host included', () => {
  assert.equal(canEditConfig({ roomState: 'countdown', isCreator: true }), false);
  assert.equal(canEditConfig({ roomState: 'racing', isCreator: true }), false);
});

test('CONFIGURABLE_STATES is frozen so callers cannot widen the rule', () => {
  assert.throws(() => CONFIGURABLE_STATES.push('racing'), TypeError);
});

describe('parseRaceLength', () => {
  test('takes a whole number inside the bounds the room enforces', () => {
    assert.equal(parseRaceLength('10'), 10);
    assert.equal(parseRaceLength(' 5 '), MIN_RACE_LENGTH);
    assert.equal(parseRaceLength('50'), MAX_RACE_LENGTH);
  });

  test('refuses what the room would refuse, rather than sending it', () => {
    // A refused set-config gets no state broadcast back, so a value sent
    // anyway sat in the host's box while the room kept its old length.
    for (const raw of ['4', '51', '-10', 'abc', '3.7', '12abc', '', null, undefined]) {
      assert.equal(parseRaceLength(raw), null, String(raw));
    }
  });

  test('the hint names the same bounds', () => {
    assert.match(RACE_LENGTH_HINT, new RegExp(`${MIN_RACE_LENGTH} to ${MAX_RACE_LENGTH}`));
  });
});
