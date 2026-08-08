import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIGURABLE_STATES, isConfigurableState, canEditConfig } from './room-config-rules.js';

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
