// -----------------------------------------------------------------------------
// The app end to end: reads, Discover, states, commands, identity, pace.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, F, SECOND, created, setup } from './helpers/app.js';
import { ADDRESS, ADDRESS2, ID, ID2, fakeFans, fan } from './helpers/fakeFans.js';
import { memoryStore } from '../src/store.js';

test('a fan read: Discover lists it with its features, the address param and its name', async () => {
  const t = await setup({ devices: [] });
  await t.start();
  const [device] = t.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, F(ID));
  assert.equal(device.name, 'Living Room');
  assert.equal(device.model, 'Modern Forms 2006-52');
  assert.deepEqual(device.params, [{ name: 'address', value: `${ADDRESS}:80` }]);
  assert.deepEqual(
    device.features.map((f) => [f.external_id.split(':').pop(), f.category, f.type]),
    [
      ['fan-speed', 'fan', 'speed'],
      ['direction', 'fan', 'airflow-direction'],
      ['wind', 'fan', 'wind-setting'],
      ['light', 'light', 'binary'],
      ['brightness', 'light', 'brightness'],
    ],
  );
  assert.ok(!device.features.some((f) => f.category === 'switch'), 'never a switch');
  assert.equal(t.status().connected, true);
  assert.match(t.status().message.en, /Read: Living Room\. 1 fan\(s\) to add in Discover/);
  // The e-mail of the owner goes nowhere.
  assert.ok(!JSON.stringify(t.gladys.fake.requests).includes('someone@example.com'));
  assert.ok(!t.lines.join('\n').includes('someone@example.com'));
  t.app.stop();
});

test('a fan without light kit nor breeze: only the fan features', async () => {
  const world = fakeFans({ [`${ADDRESS}:80`]: fan({ light: false, wind: false }) });
  const t = await setup({ devices: [], world });
  await t.start();
  const keys = t.gladys.fake.discoveredDevices[0].features.map((f) =>
    f.external_id.split(':').pop(),
  );
  assert.deepEqual(keys, ['fan-speed', 'direction']);
  t.app.stop();
});

test('states of a created device: speed 0 when off, the speed when on, light and brightness', async () => {
  const t = await setup();
  t.world.fan().state.fanOn = true;
  t.world.fan().state.fanSpeed = 4;
  t.world.fan().state.lightOn = true;
  t.world.fan().state.lightBrightness = 40;
  t.world.fan().state.fanDirection = 'reverse';
  t.world.fan().state.wind = true;
  await t.start();
  const last = (key) => t.gladys.fake.lastState(F(ID, key));
  assert.equal(last('fan-speed'), 4);
  assert.equal(last('light'), 1);
  assert.equal(last('brightness'), 40);
  assert.equal(last('direction'), 1);
  assert.equal(last('wind'), 2);
  t.world.fan().state.fanOn = false;
  await t.wait(10 * SECOND);
  assert.equal(last('fan-speed'), 0);
  t.app.stop();
});

test('a value that is not one (text, out of range) is never published as 0', async () => {
  const t = await setup();
  Object.assign(t.world.fan().state, {
    fanOn: 'on',
    fanSpeed: '3',
    lightBrightness: 0,
    lightOn: 1,
  });
  await t.start();
  for (const key of ['fan-speed', 'brightness', 'light']) {
    assert.equal(t.gladys.fake.lastState(F(ID, key)), undefined, key);
  }
  t.app.stop();
});

test('a command reads the fan first (its identity), then writes; success on the answer', async () => {
  const t = await setup();
  await t.start();
  t.world.requests.length = 0;
  const ack = await t.cmd(F(ID, 'fan-speed'), 3);
  assert.equal(ack.success, true, ack.error);
  const bodies = t.world.requests.filter((r) => r.sentAt !== undefined).map((r) => r.body);
  assert.deepEqual(bodies, [{ queryDynamicShadowData: 1 }, { fanOn: true, fanSpeed: 3 }]);
  assert.equal(t.world.fan().state.fanOn, true);
  const ack2 = await t.cmd(F(ID, 'brightness'), 70);
  assert.equal(ack2.success, true, ack2.error);
  assert.deepEqual(t.world.writes().pop().body, { lightOn: true, lightBrightness: 70 });
  const ack3 = await t.cmd(F(ID, 'direction'), 1);
  assert.equal(ack3.success, true, ack3.error);
  assert.equal(t.world.fan().state.fanDirection, 'reverse');
  const ack4 = await t.cmd(F(ID, 'wind'), 2);
  assert.equal(ack4.success, true, ack4.error);
  assert.equal(t.world.fan().state.wind, true);
  t.app.stop();
});

test('values out of the fan ranges are refused before anything leaves', async () => {
  const t = await setup();
  await t.start();
  const before = t.world.requests.length;
  for (const [key, value] of [
    ['fan-speed', 7],
    ['fan-speed', -1],
    ['fan-speed', 2.5],
    ['brightness', 101],
    ['brightness', 50.5],
    ['direction', 2],
    ['wind', 1],
    ['light', 2],
  ]) {
    const ack = await t.cmd(F(ID, key), value);
    assert.equal(ack.success, false, `${key} ${value}`);
    assert.match(ack.error, /Valeur invalide/);
  }
  assert.equal(t.world.requests.length, before);
  t.app.stop();
});

test('another fan at the address: a command is refused after its read, nothing written', async () => {
  const world = fakeFans({ [`${ADDRESS}:80`]: fan({ id: ID2 }) });
  const t = await setup({ world });
  await t.start();
  const ack = await t.cmd(F(ID, 'fan-speed'), 2);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Un autre ventilateur répond/);
  assert.equal(t.world.writes().length, 0);
  // An Off neither: another fan proven there.
  const off = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.equal(off.success, false);
  assert.equal(t.world.writes().length, 0);
  // No value of the other fan reaches this device.
  assert.equal(t.gladys.fake.lastState(F(ID, 'fan-speed')), undefined);
  t.app.stop();
});

test('a fan answering without clientId: nothing published, commands refused, said in the status', async () => {
  const t = await setup();
  t.world.fan().noId = true;
  await t.start();
  assert.equal(t.status().connected, false);
  assert.match(t.status().message.en, /without the identity of a fan/);
  const ack = await t.cmd(F(ID, 'light'), 1);
  assert.equal(ack.success, false);
  assert.equal(t.world.writes().length, 0);
  assert.equal(t.gladys.fake.lastState(F(ID, 'light')), undefined);
  t.app.stop();
});

test('the command answered with the state before: not applied yet, never success', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().deaf = true;
  const ack = await t.cmd(F(ID, 'light'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /ne l’affiche pas encore/);
  t.app.stop();
});

test('a command without answer: "sent, without confirmation", then read again 5 s later', async () => {
  const t = await setup();
  await t.start();
  const original = t.world.fan().latency;
  t.world.fan().latency = (r) => ('lightOn' in r.body ? 60 * SECOND : original);
  const ack = await t.cmd(F(ID, 'light'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /sans confirmation/);
  const reads = t.world.reads().length;
  await t.wait(6 * SECOND);
  assert.ok(t.world.reads().length > reads);
  t.app.stop();
});

test('a fan that does not answer: the command is refused "nothing was sent" with the pause', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().down = true;
  await t.wait(10 * SECOND);
  const ack = await t.cmd(F(ID, 'light'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /injoignable.*rien n’a été envoyé/);
  assert.equal(t.status().connected, false);
  assert.match(t.status().message.en, /unreachable \(no connection/);
  t.app.stop();
});

test('pace: one read per interval; failures pause 10 s, 30 s, 1 min; 429 a minute', async () => {
  const t = await setup();
  await t.start();
  const reads = () => t.world.reads().filter((r) => r.body.queryDynamicShadowData).length;
  assert.equal(reads(), 1);
  await t.wait(9 * SECOND);
  assert.equal(reads(), 1);
  await t.wait(1 * SECOND);
  assert.equal(reads(), 2);
  t.world.fan().down = true;
  await t.wait(10 * SECOND); // fails
  const failedAt = t.world.requests.length;
  await t.wait(9 * SECOND);
  assert.equal(t.world.requests.length, failedAt, 'paused 10 s');
  await t.wait(2 * SECOND);
  assert.ok(t.world.requests.length > failedAt);
  t.world.fan().down = false;
  t.world.fan().status = 429;
  await t.wait(30 * SECOND);
  const busyAt = t.world.requests.length;
  await t.wait(50 * SECOND);
  assert.equal(t.world.requests.length, busyAt, 'a minute at least on 429');
  t.app.stop();
});

test('a restart never reads sooner than the interval (the attempt in /data)', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  await t.start();
  assert.ok(store.data.links[`${ADDRESS}:80`].lastAttemptAt > 0);
  t.app.stop();
  const t2 = await setup({ store, clock: t.clock, world: t.world });
  const before = t.world.requests.length;
  await t2.start();
  assert.equal(t.world.requests.length, before, 'no read within the interval of the last one');
  await t2.wait(9 * SECOND);
  assert.ok(t.world.requests.length > before);
  t2.app.stop();
});

test('answers are applied in the order their requests left, never the order they come back', async () => {
  const t = await setup();
  await t.start();
  const { parseState } = await import('../src/fan/model.js');
  const key = `${ADDRESS}:80`;
  const on = parseState({ ...t.world.fan().state, fanOn: true });
  const off = parseState({ ...t.world.fan().state, fanOn: false });
  const last = t.app.seen.get(key).at;
  assert.equal(t.app.applyAnswer(key, on, last + 20), true);
  // A request that left before (a cut command landing late, say), answered after: dropped.
  assert.equal(t.app.applyAnswer(key, off, last + 10), false);
  assert.equal(t.app.fans.get(ID).state.fan.on, true);
  t.app.stop();
});

test('getConfig failing in connected: retried (5 s, 15 s), status said, then the fans are read', async () => {
  let calls = 0;
  const t = await setup({
    getConfig: async () => {
      calls += 1;
      if (calls < 3) throw new Error('down');
      return CONFIG;
    },
  });
  await t.start();
  assert.match(t.status().message.en, /could not be read from Gladys; new try in 5 s/);
  await t.wait(5 * SECOND);
  assert.match(t.status().message.en, /new try in 15 s/);
  await t.wait(16 * SECOND);
  assert.equal(calls, 3);
  assert.equal(t.status().connected, true);
  t.app.stop();
});

test('configurations saved one after the other apply in order, the last one wins', async () => {
  const world = fakeFans({
    [`${ADDRESS}:80`]: fan(),
    [`${ADDRESS2}:80`]: fan({ id: ID2, name: 'Bedroom' }),
  });
  const t = await setup({ world, devices: [] });
  await t.start();
  const a = t.app.configUpdated({ fans: ADDRESS2 });
  const b = t.app.configUpdated({ fans: `${ADDRESS}, ${ADDRESS2}` });
  await t.act(Promise.all([a, b]));
  await t.wait(SECOND);
  assert.deepEqual([...t.app.links.keys()], [`${ADDRESS}:80`, `${ADDRESS2}:80`]);
  t.app.stop();
});

test('two fans, one down: the other is read and driven; the status names the one down', async () => {
  const world = fakeFans({
    [`${ADDRESS}:80`]: fan(),
    [`${ADDRESS2}:80`]: fan({ id: ID2, name: 'Bedroom' }),
  });
  world.fan(`${ADDRESS}:80`).down = true;
  const devices = [created(ID), created(ID2, { address: `${ADDRESS2}:80` })];
  const t = await setup({ world, devices, config: { fans: `${ADDRESS}\n${ADDRESS2}` } });
  await t.start();
  const ack = await t.cmd(F(ID2, 'light'), 1, devices[1]);
  assert.equal(ack.success, true, ack.error);
  assert.equal(t.status().connected, false);
  assert.match(
    t.status().message.en,
    /Read: Ventilateur Modern Forms 83DEF0\. 192\.168\.1\.60:80: unreachable/,
  );
  t.app.stop();
});

test('a scene on 5 slow fans (900 ms): the 5 are set', async () => {
  const fans = {};
  const ids = [];
  const devices = [];
  for (let n = 0; n < 5; n += 1) {
    const id = `c82b9698e5a${n}`;
    const address = `192.168.1.${70 + n}`;
    fans[`${address}:80`] = fan({ id });
    fans[`${address}:80`].latency = 900;
    ids.push(id);
    devices.push(created(id, { address: `${address}:80` }));
  }
  const t = await setup({
    world: fakeFans(fans),
    devices,
    config: {
      fans: Object.keys(fans)
        .map((k) => k.replace(':80', ''))
        .join(','),
    },
  });
  await t.start();
  await t.wait(2 * SECOND);
  const acks = await t.act(
    Promise.all(
      devices.map((d, i) => t.gladys.fake.setValue(d, { external_id: F(ids[i], 'light') }, 1)),
    ),
  );
  for (const ack of acks) assert.equal(ack.success, true, ack.error);
  for (const key of Object.keys(fans)) assert.equal(fans[key].state.lightOn, true);
  t.app.stop();
});

test('test button: reads when due, otherwise reports the last read; never faster than the interval', async () => {
  const t = await setup();
  await t.start();
  const before = t.world.requests.length;
  const answer = await t.act(t.app.testConnection());
  assert.match(answer.en, /192\.168\.1\.60:80: .* \(98E5AC\), fan off, light off/);
  assert.equal(t.world.requests.length, before, 'read 1 s ago: not read again');
  t.app.stop();
});

test('a generation 4 fan (no /mf): said in the status', async () => {
  const t = await setup();
  t.world.fan().status = 404;
  await t.start();
  assert.match(t.status().message.en, /generation 4 fan is not handled/);
  t.app.stop();
});

test('the information read failing (secondary) never blocks the states nor pauses the fan', async () => {
  const t = await setup({ devices: [] });
  t.world.queue.push(undefined, () => ({ status: 500 }));
  await t.start();
  assert.equal(t.status().connected, true);
  assert.equal(t.app.paceOf(`${ADDRESS}:80`).failures, 0);
  assert.equal(t.gladys.fake.discoveredDevices.length, 1);
  assert.match(t.gladys.fake.discoveredDevices[0].name, /98E5AC/);
  t.app.stop();
});

test('a reconnection reads nothing sooner, forgets the published states, resends status and Discover', async () => {
  const t = await setup();
  await t.start();
  const before = t.world.requests.length;
  const statuses = t.gladys.fake.connectionStatuses.length;
  await t.act(t.app.onConnected(() => t.gladys.getConfig()));
  await t.wait(100);
  assert.equal(t.world.requests.length, before, 'no read relaunched by a reconnection');
  assert.ok(t.gladys.fake.connectionStatuses.length > statuses);
  t.app.stop();
});

test('a device created: nothing old republished, its states come with the next read', async () => {
  const t = await setup({ devices: [] });
  await t.start();
  const device = created();
  t.gladys.devices.push(device);
  const states = t.gladys.fake.states.length;
  await t.act(t.app.deviceCreated(device));
  await t.app.flush();
  assert.equal(t.gladys.fake.states.length, states);
  await t.wait(10 * SECOND);
  assert.equal(t.gladys.fake.lastState(F(ID, 'fan-speed')), 0);
  t.app.stop();
});

test('the answer of another fan to a write is no success, even when it shows the value asked', async () => {
  const t = await setup();
  await t.start();
  t.world.queue.push(undefined, { json: { ...fan({ id: ID2 }).state, lightOn: true } });
  const ack = await t.cmd(F(ID, 'light'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /un autre ventilateur a répondu/);
  t.app.stop();
});

test('another fan seen at the address between the read of a command and its write: the write never leaves', async () => {
  const t = await setup();
  await t.start();
  const { parseState } = await import('../src/fan/model.js');
  // While the read of the command is answered, an answer of another fan (a later request)
  // is applied at that address.
  t.world.queue.push(() => {
    t.app.applyAnswer(`${ADDRESS}:80`, parseState(fan({ id: ID2 }).state), 1e12);
    return undefined;
  });
  const ack = await t.cmd(F(ID, 'light'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Un autre ventilateur répond/);
  assert.equal(t.world.writes().length, 0);
  t.app.stop();
});

test('a write answered without the field asked: "sent, without confirmation", never success', async () => {
  const t = await setup();
  await t.start();
  const { lightOn: _drop, ...noLight } = t.world.fan().state;
  t.world.queue.push(undefined, { json: noLight });
  const ack = await t.cmd(F(ID, 'light'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /sans confirmation/);
  t.app.stop();
});

test('I3: a scene of 5 functions on one slow fan (900 ms): one read, one write, all applied within the 5 s of Gladys', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.latency = 900;
  const started = t.clock.elapsed;
  const device = t.gladys.devices[0];
  const set = (key, value) => t.gladys.fake.setValue(device, { external_id: F(ID, key) }, value);
  t.world.requests.length = 0;
  const acks = await t.act(
    Promise.all([
      set('fan-speed', 4),
      set('direction', 1),
      set('wind', 2),
      set('light', 1),
      set('brightness', 30),
    ]),
  );
  for (const ack of acks) assert.equal(ack.success, true, ack.error);
  assert.equal(t.world.reads().length, 1, 'one read shared by the scene');
  assert.equal(t.world.writes().length, 1, 'one write for the scene');
  assert.ok(t.clock.elapsed - started < 4300);
  assert.deepEqual(
    [
      f.state.fanSpeed,
      f.state.fanDirection,
      f.state.wind,
      f.state.lightOn,
      f.state.lightBrightness,
    ],
    [4, 'reverse', true, true, 30],
  );
  t.app.stop();
});
