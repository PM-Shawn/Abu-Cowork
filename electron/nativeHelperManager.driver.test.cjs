'use strict';

// L3 driver capability declaration (contract §2.8), manager half: a declared
// helper is taken field by field with conservative fallbacks; an undeclared
// one gets the legacy table where nothing is promised.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  normalizeDriverCapabilities,
  legacyDriverCapabilities,
  validateHelperHello,
  NATIVE_HELPER_PROTOCOL_VERSION,
} = require('./nativeHelperManager.cjs');

function hello(driver, platform = 'windows') {
  return {
    protocol_version: NATIVE_HELPER_PROTOCOL_VERSION,
    binary_version: '0.1.0',
    platform,
    supported_commands: ['hello'],
    started_at_ms: 1,
    capabilities: {
      transport: 'ndjson-stdio',
      request_serialization: 'host',
      legacy_v1_request_adapter: true,
      events: [],
      ...(driver === undefined ? {} : { driver }),
    },
  };
}

const WINDOWS_DECLARATION = {
  id: 'windows-uia',
  input: {
    foreground_required: true,
    background_element_actions: false,
    unicode_text: true,
    chords: true,
    ime_aware: false,
    physical_input_monitoring: true,
  },
  capture: { display: 'wgc-monitor', occluded_window: false, excludes_own_window: true },
  elements: { identity: 'runtime-id', empty_value: 'string', actions: ['Invoke', 'SetValue'] },
  boundaries: ['secure-desktop', 'higher-integrity'],
  activation: { can_activate_window: true },
};

test('a declared driver is normalized field by field and frozen', () => {
  const caps = normalizeDriverCapabilities(hello(WINDOWS_DECLARATION));
  assert.deepEqual(caps, { ...WINDOWS_DECLARATION, declared: true });
  assert.ok(Object.isFrozen(caps) && Object.isFrozen(caps.input) && Object.isFrozen(caps.elements.actions));
  assert.equal(validateHelperHello(hello(WINDOWS_DECLARATION)).capabilities.driver, WINDOWS_DECLARATION);
});

test('an undeclared helper gets the legacy table for its platform', () => {
  for (const [platform, id] of [['windows', 'windows-uia'], ['macos', 'macos-ax'], ['linux', 'unavailable']]) {
    const caps = normalizeDriverCapabilities(hello(undefined, platform));
    assert.equal(caps.declared, false, platform);
    assert.equal(caps.id, id, platform);
    assert.equal(caps.input.foreground_required, true, platform);
    assert.equal(caps.input.unicode_text, false, platform);
    assert.equal(caps.elements.identity, 'session-index', platform);
    assert.equal(caps.elements.empty_value, 'unknown', platform);
    assert.deepEqual(caps.elements.actions, [], platform);
  }
  assert.deepEqual(normalizeDriverCapabilities(hello(undefined, 'windows')), legacyDriverCapabilities('win32'));
});

test('a driver can only under-promise: unparseable fields fall to the conservative value', () => {
  const caps = normalizeDriverCapabilities(hello({
    id: '  custom  ',
    input: { foreground_required: 'no', unicode_text: 'true', chords: 1 },
    capture: { display: 42, occluded_window: 'yes' },
    elements: { identity: 'made-up', empty_value: 'maybe', actions: ['Invoke', 7, null] },
    boundaries: 'secure-desktop',
    activation: { can_activate_window: 'sure' },
  }));
  assert.equal(caps.declared, true);
  assert.equal(caps.id, 'custom');
  assert.equal(caps.input.foreground_required, true);
  assert.equal(caps.input.unicode_text, false);
  assert.equal(caps.input.chords, false);
  assert.equal(caps.capture.display, 'unknown');
  assert.equal(caps.capture.occluded_window, false);
  assert.equal(caps.elements.identity, 'session-index');
  assert.equal(caps.elements.empty_value, 'unknown');
  assert.deepEqual(caps.elements.actions, ['Invoke']);
  assert.deepEqual(caps.boundaries, []);
  assert.equal(caps.activation.can_activate_window, true);
});

test('a malformed declaration (no id) counts as undeclared', () => {
  for (const driver of [null, 'windows-uia', ['windows-uia'], { input: {} }, { id: '' }]) {
    assert.equal(normalizeDriverCapabilities(hello(driver)).declared, false, JSON.stringify(driver));
  }
});
