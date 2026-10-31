// -----------------------------------------------------------------------------
// Review r1: one test per guard a mutant removed without a test failing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, MINUTE, SECOND, created, setup } from './helpers/app.js';
import { ADDRESS, ADDRESS2, ID, ID2, fakeFans, fan } from './helpers/fakeFans.js';
import { memoryStore } from '../src/store.js';
import { parseState } from '../src/fan/model.js';

const KEY = `${ADDRESS}:80`;
const offWrites = (t, field = 'fanOn') =>
  t.world.writes().filter((r) => r.body[field] === false && Object.keys(r.body).length === 1);

test('an Off whose answer was lost, confirmed by a read, then started from the remote: never stopped again', async () => {
  const t = await setup();
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  // The fan applies the Off, the answer never comes.
  f.latency = (r) => (r.body.fanOn === false ? 60 * SECOND : 20);
  const ack = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.match(ack.error, /sans confirmation/);
  f.latency = 20;
  await t.act(t.app.readKey(KEY, 3));
  assert.equal(t.app.guards.get(`${ID}:fan`).confirmed, true, 'the read confirms it');
  f.state.fanOn = true; // the remote
  const before = offWrites(t).length;
  await t.wait(MINUTE);
  assert.equal(offWrites(t).length, before);
  assert.equal(f.state.fanOn, true);
  t.app.stop();
});

test('a 429 on the first read: the next read a minute later at least', async () => {
  const t = await setup();
  t.world.fan().status = 429;
  await t.start();
  const reads = () => t.world.requests.filter((r) => r.body?.queryDynamicShadowData).length;
  assert.equal(reads(), 1);
  t.world.fan().status = undefined;
  await t.wait(58 * SECOND);
  assert.equal(reads(), 1);
  await t.wait(4 * SECOND);
  assert.equal(reads(), 2);
  t.app.stop();
});

test('the information is read once an hour, not at every read; and only from the same fan', async () => {
  const t = await setup({ devices: [] });
  await t.start();
  const infos = () => t.world.requests.filter((r) => r.body?.queryStaticShadowData).length;
  assert.equal(infos(), 1);
  await t.wait(10 * MINUTE);
  assert.equal(infos(), 1);
  await t.wait(51 * MINUTE);
  assert.equal(infos(), 2);
  // An information answer of another fan never names this one.
  t.world.fan().info.clientId = `MF_${ID2.toUpperCase()}`;
  t.world.fan().info.deviceName = 'Other';
  await t.wait(61 * MINUTE);
  assert.notEqual(t.app.fans.get(ID).info.name, 'Other');
  t.app.stop();
});

test('a light command on a fan without light kit: refused after its read, nothing written', async () => {
  const world = fakeFans({ [KEY]: fan({ light: false }) });
  const t = await setup({ world, devices: [created(ID, { light: true })] });
  await t.start();
  for (const [key, value] of [
    ['light', 1],
    ['brightness', 40],
  ]) {
    const ack = await t.cmd(F(ID, key), value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /n’a pas cette fonction/);
  }
  assert.equal(t.world.writes().length, 0);
  t.app.stop();
});

test('an Off clicked before the configuration is read, nothing known but one address typed: sent there', async () => {
  let release;
  const config = new Promise((resolve) => {
    release = resolve;
  });
  const bare = { ...created(ID), params: [] };
  const t = await setup({ devices: [bare], getConfig: () => config });
  t.world.fan().state.fanOn = true;
  await t.start();
  const ack = t.gladys.fake.setValue(bare, { external_id: F(ID, 'fan-speed') }, 0);
  await t.wait(500);
  release({ fans: ADDRESS });
  const result = await t.act(ack);
  assert.equal(result.success, true, result.error);
  assert.equal(t.world.fan().state.fanOn, false);
  t.app.stop();
});

test('an Off with no address anywhere and the configuration never read: refused within the wait', async () => {
  const bare = { ...created(ID), params: [] };
  const t = await setup({ devices: [bare], getConfig: () => new Promise(() => {}) });
  await t.start();
  const ack = await t.cmd(F(ID, 'fan-speed'), 0, bare);
  assert.equal(ack.success, false);
  assert.match(ack.error, /adresse de ce ventilateur n’est pas connue/);
  assert.equal(t.world.writes().length, 0);
  t.app.stop();
});

test('locate: the address kept in /data is used for an Off when the device has no param', async () => {
  const world = fakeFans({ [`${ADDRESS2}:80`]: fan() });
  const store = memoryStore({
    format: 1,
    fans: { [ID]: { address: `${ADDRESS2}:80` } },
    links: {},
    guards: [],
  });
  const bare = { ...created(ID), params: [] };
  const t = await setup({
    world,
    store,
    devices: [bare],
    config: { fans: `${ADDRESS}, 192.168.1.62` },
  });
  world.fan(`${ADDRESS2}:80`).state.fanOn = true;
  await t.start();
  const ack = await t.cmd(F(ID, 'fan-speed'), 0, bare);
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.fan(`${ADDRESS2}:80`).state.fanOn, false);
  t.app.stop();
});

test('the guards of /data never replace a live one (a click before /data answered)', async () => {
  const store = memoryStore({
    format: 1,
    fans: {},
    links: {},
    guards: [{ id: ID, part: 'fan', address: KEY, resends: 2, confirmed: true }],
  });
  const t = await setup({ store });
  const live = t.app.makeGuard({ id: ID, part: 'fan', address: KEY, seq: 7 });
  t.app.guards.set(`${ID}:fan`, live);
  await t.start();
  assert.equal(t.app.guards.get(`${ID}:fan`), live);
  t.app.stop();
});

test('the sends of a guard after its first answered one are capped at 3; kept Offs at start too', async () => {
  const store = memoryStore({
    format: 1,
    fans: { [ID]: { address: KEY } },
    links: {},
    guards: [
      { id: ID, part: 'fan', address: KEY, resends: 3, confirmed: false, left: true },
      { id: ID, part: 'light', address: KEY, resends: 0, confirmed: true, left: true },
    ],
  });
  const t = await setup({ store });
  t.world.fan().state.fanOn = true;
  t.world.fan().state.lightOn = true;
  t.world.fan().deaf = true;
  await t.start();
  await t.wait(2 * MINUTE);
  assert.equal(offWrites(t).length, 0, 'the fan Off sent 3 times already: never again');
  assert.equal(offWrites(t, 'lightOn').length, 0, 'a confirmed Off is not sent at start');
  t.app.stop();
});

test('an Off replaced by a newer click before it left never leaves; the Off has 3.5 s to leave', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.state.fanOn = true;
  // A read in flight, 2 s, not cut by... an Off cuts it: use the lane busy with an Off.
  f.latency = (r) => (r.body.lightOn === false ? 5 * SECOND : 20);
  const device = t.gladys.devices[0];
  const first = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  await t.wait(10);
  const a = t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0);
  await t.wait(10);
  const b = t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0);
  const acks = await t.act(Promise.all([first, a, b]));
  assert.match(acks[1].error, /Annulée/, 'replaced before it left');
  assert.equal(acks[2].success, true, acks[2].error);
  assert.equal(offWrites(t).length, 1);
  t.app.stop();
});

test('Off resends: never to an address where another fan answers, even from a read of the fan elsewhere', async () => {
  const world = fakeFans({ [KEY]: fan({ id: ID2 }), [`${ADDRESS2}:80`]: fan() });
  const t = await setup({ world, config: { fans: `${ADDRESS}, ${ADDRESS2}` } });
  await t.start();
  const guard = t.app.makeGuard({ id: ID, part: 'fan', address: KEY });
  guard.left = true;
  t.app.guards.set(`${ID}:fan`, guard);
  t.app.applyAnswer(KEY, parseState(world.fan(KEY).state), 1e12);
  t.app.resendGuard(guard);
  await t.wait(SECOND);
  assert.equal(world.requests.filter((r) => r.body.fanOn === false && r.address === KEY).length, 0);
  t.app.stop();
});

test('the states of a fan typed twice are published once (from the first address)', async () => {
  const world = fakeFans({ [KEY]: fan(), [`${ADDRESS2}:80`]: fan() });
  const t = await setup({ world, config: { fans: `${ADDRESS}, ${ADDRESS2}` } });
  world.fan(`${ADDRESS2}:80`).state.fanOn = true;
  world.fan(`${ADDRESS2}:80`).state.fanSpeed = 5;
  await t.start();
  await t.wait(30 * SECOND);
  assert.equal(t.gladys.fake.lastState(F(ID, 'fan-speed')), 0);
  assert.match(t.status().message.en, /the same fan as 192\.168\.1\.60:80/);
  t.app.stop();
});

test('an Off waiting behind another frozen Off: another fan proven meanwhile, it never leaves', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.latency = (r) => (r.body.lightOn === false ? 60 * SECOND : 20);
  const device = t.gladys.devices[0];
  const light = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  await t.wait(10);
  const fanOff = t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0);
  await t.wait(100);
  t.app.applyAnswer(KEY, parseState(fan({ id: ID2 }).state), 1e12);
  const acks = await t.act(Promise.all([light, fanOff]));
  assert.equal(acks[1].success, false);
  assert.equal(offWrites(t).length, 0, 'never sent to the other fan');
  t.app.stop();
});

test('an Off that cannot start its request within 3.5 s of the click does not leave on that try', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.state.fanOn = true;
  let slow = true;
  f.connectDelay = (r) => (r.body.fanOn === false && slow ? 3600 : 1);
  const started = t.clock.elapsed;
  const ack = await t.cmd(F(ID, 'fan-speed'), 0);
  slow = false;
  assert.equal(ack.success, false);
  assert.match(ack.error, /gardé/);
  const first = offWrites(t)[0];
  assert.ok(!first || first.sentAt - started < 3500 || first.sentAt - started > 4300);
  t.app.stop();
});

test('an Off on a fan that refuses connections is tried for 250 ms, not until the deadline', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().down = true;
  const before = t.world.requests.length;
  await t.cmd(F(ID, 'fan-speed'), 0);
  const tries = t.world.requests.slice(before).filter((r) => r.body.fanOn === false).length;
  assert.ok(tries >= 2 && tries <= 8, `${tries} tries`);
  t.app.stop();
});

test('an Off resend queued behind a slow read never leaves once another fan answered there', async () => {
  const t = await setup();
  await t.start();
  await t.cmd(F(ID, 'fan-speed'), 0);
  const guard = t.app.guards.get(`${ID}:fan`);
  t.world.fan().latency = (r) => (r.body.queryDynamicShadowData ? 2 * SECOND : 20);
  const read = t.app.readKey(KEY, 4).catch(() => {});
  await t.wait(100);
  t.app.resendGuard(guard);
  t.app.applyAnswer(KEY, parseState(fan({ id: ID2 }).state), 1e12);
  const before = offWrites(t).length;
  await t.wait(3 * SECOND);
  await read;
  assert.equal(offWrites(t).length, before);
  t.app.stop();
});

test('a start clicked while an Off of the same part is in flight is refused at once', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().latency = (r) => (r.body.lightOn === false ? 2 * SECOND : 20);
  const device = t.gladys.devices[0];
  const off = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  await t.wait(50);
  const on = await t.cmd(F(ID, 'light'), 1);
  assert.match(on.error, /arrêt est en cours/);
  await t.act(off);
  t.app.stop();
});

test('a command waiting in the queue when the fan goes into pause is refused with the pause', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().latency = 600;
  const device = t.gladys.devices[0];
  const first = t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 2);
  await t.wait(20);
  const second = t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 3);
  await t.wait(20);
  t.app.paceOf(KEY).pause = { due: t.clock.monotonic() + MINUTE, code: 'failed' };
  const acks = await t.act(Promise.all([first, second]));
  assert.equal(acks[1].success, false);
  assert.match(acks[1].error, /injoignable/);
  assert.equal(t.world.writes().length, 0, 'nothing written during the pause');
  t.app.stop();
});

test('commands of one field on a slow fan: those that cannot leave within 3.5 s are refused unsent', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().latency = 900;
  const device = t.gladys.devices[0];
  const clicked = t.clock.elapsed;
  const acks = await t.act(
    Promise.all(
      [1, 2, 3, 4, 5].map((v) =>
        t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, v),
      ),
    ),
  );
  const refused = acks.filter((a) => /Pas envoyée à temps/.test(a.error ?? ''));
  assert.ok(refused.length >= 1);
  assert.equal(t.world.writes().length, 5 - refused.length, 'a refused one never left');
  for (const w of t.world.writes())
    assert.ok(w.sentAt - clicked < 3500, 'every write left within 3.5 s');
  t.app.stop();
});

test('the commands waiting are rejected as soon as an Off of their part comes, not at their turn', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().latency = 1000;
  const device = t.gladys.devices[0];
  const at = {};
  const track = (name, p) => p.then((a) => ((at[name] = t.clock.elapsed), a));
  const first = track(
    'first',
    t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 2),
  );
  await t.wait(20);
  const waiting = track(
    'waiting',
    t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 3),
  );
  await t.wait(20);
  const clicked = t.clock.elapsed;
  const off = track('off', t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0));
  const acks = await t.act(Promise.all([first, waiting, off]));
  assert.match(acks[1].error, /Annulée/);
  assert.ok(at.waiting - clicked < 100, `${at.waiting - clicked} ms`);
  t.app.stop();
});

test('an Off cuts a follow-up read in flight (not only a polling read); a command cuts a polling read', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  await t.cmd(F(ID, 'light'), 1);
  f.latency = (r) => (r.body.queryDynamicShadowData ? 60 * SECOND : 20);
  await t.wait(5 * SECOND + 100); // the follow-up read is in flight, frozen
  const clicked = t.clock.elapsed;
  const ack = await t.cmd(F(ID, 'light'), 0);
  assert.equal(ack.success, true, ack.error);
  assert.ok(t.clock.elapsed - clicked < SECOND);
  t.app.stop();
  // A polling read frozen: a command cuts it.
  const t2 = await setup();
  await t2.start();
  t2.world.fan().latency = (r) => (r.body.queryDynamicShadowData && !r.cutMe ? 60 * SECOND : 20);
  await t2.wait(9 * SECOND + 500); // the next polling read leaves at 10 s, frozen
  t2.world.fan().latency = (r) => (r.at < t2.clock.elapsed - 100 ? 60 * SECOND : 20);
  await t2.wait(1000);
  const ack2 = await t2.cmd(F(ID, 'fan-speed'), 2);
  assert.equal(ack2.success, true, ack2.error);
  t2.app.stop();
});

test('devices: a feature the device has in Gladys is kept even when the fan no longer reports it', async () => {
  const { buildDevice } = await import('../src/devices.js');
  const { createFakeGladys } = await import('@gladysassistant/integration-sdk/testing');
  const gladys = createFakeGladys({ selector: 'mf' });
  const device = buildDevice(
    gladys,
    { id: ID, state: parseState(fan({ light: false }).state), address: KEY },
    { language: 'fr', created: created(ID) },
  );
  assert.ok(device.features.some((f) => f.external_id.endsWith(':brightness')));
});

test('an address with a path or credentials is said as such (a pasted URL)', async () => {
  const { parseAddress } = await import('../src/config.js');
  assert.equal(parseAddress('http://192.168.1.60/mf').error, 'path');
  assert.equal(parseAddress('user@192.168.1.60').error, 'path');
});

test('a resend refused (503) is sent again by the probe within 10 s, not at the next read', async () => {
  const t = await setup({ config: { fans: ADDRESS, poll_interval: 60 } });
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  f.deaf = true;
  await t.cmd(F(ID, 'fan-speed'), 0);
  f.deaf = false;
  // A read a read interval after the Off contradicts it: resent, and that resend is refused with 503.
  let refuse = true;
  f.statusFor = (r) => (r.body.fanOn === false && refuse ? ((refuse = false), 503) : undefined);
  for (let i = 0; i < 200 && refuse; i += 1) await t.wait(SECOND);
  assert.equal(refuse, false, 'the resend was refused');
  assert.equal(f.state.fanOn, true);
  await t.wait(11 * SECOND);
  assert.equal(f.state.fanOn, false, 'the probe sent it again within 10 s');
  t.app.stop();
});

test('the answer of a write never judges a guard (only a read does)', async () => {
  const t = await setup();
  await t.start();
  await t.cmd(F(ID, 'fan-speed'), 0);
  const guard = t.app.guards.get(`${ID}:fan`);
  assert.equal(guard.confirmed, true);
  const on = parseState({ ...t.world.fan().state, fanOn: true });
  t.app.applyAnswer(KEY, on, 1e12);
  t.app.applyAnswer(KEY, on, 1e12 + 1);
  assert.equal(t.app.guards.get(`${ID}:fan`), guard);
  assert.equal(guard.other, undefined);
  t.app.stop();
});

test('two commands of the same field on one fan: one read serves both, two writes, both done', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().latency = 400;
  t.world.requests.length = 0;
  const device = t.gladys.devices[0];
  const acks = await t.act(
    Promise.all([
      t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 2),
      t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 5),
    ]),
  );
  for (const ack of acks) assert.equal(ack.success, true, ack.error);
  assert.equal(t.world.reads().length, 1);
  assert.equal(t.world.writes().length, 2);
  assert.equal(t.world.fan().state.fanSpeed, 5);
  t.app.stop();
});

test('an Off answered by another fan (swapped, not seen yet): nothing held for it', async () => {
  const t = await setup();
  await t.start();
  t.world.queue.push({ json: { ...fan({ id: ID2 }).state, fanOn: false } });
  const ack = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.match(ack.error, /un autre ventilateur a répondu/);
  assert.equal(t.app.guards.size, 0);
  t.app.stop();
});
