// -----------------------------------------------------------------------------
// The answers read strictly, the commands built and bounded, the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandOf,
  idOf,
  integerOf,
  parseInfo,
  parseState,
  shows,
  validBody,
  valuesOf,
} from '../src/fan/model.js';
import { addressOf, normalizeConfig, parseAddress, parseFans } from '../src/config.js';
import { fan } from './helpers/fakeFans.js';

// The examples of the WAC reference (generation 1-2 and 3), anonymized.
const GEN12 = {
  clientId: 'MF_C8934683DEF0',
  lightOn: false,
  fanOn: false,
  lightBrightness: 25,
  fanSpeed: 1,
  fanDirection: 'forward',
  rfPairModeActive: false,
  resetRfPairList: false,
  factoryReset: false,
  awayModeEnabled: false,
  fanSleepTimer: 0,
  lightSleepTimer: 0,
  decommission: false,
  schedule: 'AAAA',
  adaptiveLearning: false,
};
const GEN3 = { ...fan().state, lightOn: true, fanOn: true, lightBrightness: 100, fanSpeed: 1 };

test('the identity: clientId MF_ / WAC_ and 12 hex digits, nothing else', () => {
  assert.equal(idOf('MF_C8934683DEF0'), 'c8934683def0');
  assert.equal(idOf('WAC_C8934683DEF0'), 'c8934683def0');
  for (const bad of [
    'C8934683DEF0',
    'MF_C8934683DEF',
    'MF_C8934683DEF0X',
    'XX_C8934683DEF0',
    1,
    null,
    '',
  ]) {
    assert.equal(idOf(bad), undefined, String(bad));
  }
});

test('the state of the WAC examples (generation 1-2: no breeze; generation 3: breeze)', () => {
  const s12 = parseState(GEN12);
  assert.equal(s12.id, 'c8934683def0');
  assert.deepEqual(s12.fan, { on: false, speed: 1, direction: 0, hasWind: false, wind: undefined });
  assert.deepEqual(s12.light, { present: true, on: false, brightness: 25 });
  assert.deepEqual(
    [...valuesOf(s12)],
    [
      ['fan-speed', 0],
      ['direction', 0],
      ['light', 0],
      ['brightness', 25],
    ],
  );
  const s3 = parseState(GEN3);
  assert.deepEqual(
    [...valuesOf(s3)],
    [
      ['fan-speed', 1],
      ['direction', 0],
      ['wind', 0],
      ['light', 1],
      ['brightness', 100],
    ],
  );
});

test('strict values: a text, a 0, an out of range number is unknown, never 0', () => {
  const s = parseState({
    clientId: 'MF_C8934683DEF0',
    fanOn: 'true',
    fanSpeed: 7,
    fanDirection: 'up',
    lightOn: 1,
    lightBrightness: 0,
  });
  assert.equal(s.fan.on, undefined);
  assert.equal(s.fan.speed, undefined);
  assert.equal(s.fan.direction, undefined);
  assert.equal(s.light.present, false);
  assert.deepEqual([...valuesOf(s)], []);
  const on = parseState({
    clientId: 'MF_C8934683DEF0',
    fanOn: true,
    fanSpeed: 2.5,
    lightOn: true,
    lightBrightness: '40',
  });
  assert.equal(valuesOf(on).has('fan-speed'), false, 'on at an unknown speed: not published');
  assert.equal(valuesOf(on).has('brightness'), false);
  assert.equal(parseState(null).id, undefined);
  assert.equal(parseState(JSON.parse('{"__proto__":{"fanOn":true}}')).fan.on, undefined);
});

test('the information: never the e-mail of the owner nor the AWS identity; names cleaned and cut', () => {
  const info = parseInfo({ ...fan().info, deviceName: `Salon\u0007 ${'x'.repeat(100)}` });
  assert.deepEqual(Object.keys(info).sort(), ['firmware', 'id', 'mac', 'model', 'name']);
  assert.equal(info.mac, 'c82b9698e5ac');
  assert.equal([...info.name].length, 60);
  assert.ok(!JSON.stringify(info).includes('@'));
  assert.ok(!info.name.includes('\u0007'));
});

test('commands: Offs are protective; values bounded; the body checked again before it leaves', () => {
  assert.deepEqual(commandOf('fan-speed', 0), {
    body: { fanOn: false },
    part: 'fan',
    protective: true,
  });
  assert.deepEqual(commandOf('light', 0), {
    body: { lightOn: false },
    part: 'light',
    protective: true,
  });
  assert.deepEqual(commandOf('brightness', 0), {
    body: { lightOn: false },
    part: 'light',
    protective: true,
  });
  assert.deepEqual(commandOf('fan-speed', 6).body, { fanOn: true, fanSpeed: 6 });
  assert.deepEqual(commandOf('brightness', 1).body, { lightOn: true, lightBrightness: 1 });
  assert.deepEqual(commandOf('direction', 1).body, { fanDirection: 'reverse' });
  assert.deepEqual(commandOf('wind', 2).body, { wind: true });
  for (const [key, value] of [
    ['fan-speed', 7],
    ['fan-speed', undefined],
    ['brightness', 101],
    ['direction', 2],
    ['wind', 1],
    ['light', 2],
    ['nope', 1],
  ]) {
    assert.equal(commandOf(key, value), undefined, `${key} ${value}`);
  }
  assert.equal(integerOf(2.5), undefined);
  assert.equal(integerOf('3'), 3);
  assert.equal(integerOf('3.0'), undefined);
  assert.equal(integerOf(''), undefined);
  assert.equal(validBody({ fanSpeed: 7 }), false);
  assert.equal(validBody({ lightBrightness: 101 }), false);
  assert.equal(validBody({ factoryReset: true }), false, 'never anything else');
  assert.equal(validBody({ fanOn: 'true' }), false);
  assert.equal(validBody({}), false);
  assert.equal(validBody({ fanOn: true, fanSpeed: 6 }), true);
  assert.equal(
    validBody({
      fanOn: true,
      fanSpeed: 6,
      fanDirection: 'forward',
      wind: true,
      lightOn: true,
      lightBrightness: 5,
    }),
    true,
  );
  assert.equal(validBody({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }), false);
});

test('shows: true, false, or unknown when a field is missing', () => {
  const s = parseState(GEN12);
  assert.equal(shows(s, { fanOn: false }), true);
  assert.equal(shows(s, { fanOn: true, fanSpeed: 1 }), false);
  assert.equal(shows(s, { wind: true }), undefined);
  assert.equal(shows(s, { fanDirection: 'forward' }), true);
});

test('addresses: IP, name, port; a URL with a path, https, broadcast, multicast refused', () => {
  assert.deepEqual(parseAddress('192.168.1.60'), { host: '192.168.1.60', port: 80 });
  assert.deepEqual(parseAddress('http://Fan.lan:8080/'), { host: 'fan.lan', port: 8080 });
  assert.deepEqual(parseAddress('[fe80::1]:81'), { host: 'fe80::1', port: 81 });
  for (const bad of [
    'https://x',
    'x/mf',
    'a@b',
    '255.255.255.255',
    '224.0.0.1',
    '0.0.0.0',
    'x:0',
    'ff02::1',
    'a\rb',
  ]) {
    assert.ok(parseAddress(bad).error, bad);
  }
  const fans = parseFans('192.168.1.60, 192.168.1.60:80\nfan.lan; bad/x 10.0.0.1:99999');
  assert.deepEqual(
    fans.addresses.map((a) => a.key),
    ['192.168.1.60:80', 'fan.lan:80'],
  );
  assert.deepEqual(fans.errors, ['bad/x', '10.0.0.1:99999']);
  const many = parseFans(Array.from({ length: 10 }, (_, i) => `10.0.0.${i + 1}`).join(','));
  assert.equal(many.addresses.length, 8);
  assert.equal(many.tooMany, true);
  assert.equal(addressOf('192.168.1.60:80').host, '192.168.1.60');
  assert.equal(addressOf('192.168.1.60'), undefined, 'a key has its port');
  assert.equal(addressOf('__proto__'), undefined);
  const config = normalizeConfig({ fans: '', poll_interval: 1, language: 'de' });
  assert.equal(config.pollInterval, 5);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 10);
});
