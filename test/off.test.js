// -----------------------------------------------------------------------------
// The Offs (fan speed 0, light 0, brightness 0): never blocked, held in /data,
// sent again by the reads that contradict them (3 times at most, counted when
// they left), never abandoned when they never left, lifted only by a newer
// command that left, another Off, the device deleted, or a start read twice
// after they were seen applied.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, F, MINUTE, SECOND, created, setup } from './helpers/app.js';
import { ADDRESS, ADDRESS2, ID, ID2, fakeFans, fan } from './helpers/fakeFans.js';
import { memoryStore } from '../src/store.js';

const KEY = `${ADDRESS}:80`;
const offs = (t, field = 'fanOn') =>
  t.world.writes().filter((r) => r.body[field] === false && Object.keys(r.body).length === 1);

test('fan Off and light Off: sent at once, confirmed by the answer, held in /data as applied', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  t.world.fan().state.fanOn = true;
  t.world.fan().state.lightOn = true;
  await t.start();
  const ack = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.equal(ack.success, true, ack.error);
  const light = await t.cmd(F(ID, 'brightness'), 0);
  assert.equal(light.success, true, light.error);
  assert.equal(t.world.fan().state.fanOn, false);
  assert.equal(t.world.fan().state.lightOn, false);
  // No read before an Off: it is the first request after the click.
  assert.deepEqual(offs(t)[0].body, { fanOn: false });
  await t.wait(100);
  assert.deepEqual(
    store.data.guards.map((g) => [g.id, g.part, g.address, g.confirmed]),
    [
      [ID, 'fan', KEY, true],
      [ID, 'light', KEY, true],
    ],
  );
  t.app.stop();
});

test('an Off goes during a pause (429) and cuts a frozen read', async () => {
  const t = await setup();
  t.world.fan().state.fanOn = true;
  await t.start();
  // A pause: the fan asked to wait.
  t.world.fan().status = 429;
  await t.wait(10 * SECOND);
  t.world.fan().status = undefined;
  const ack = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.equal(ack.success, true, ack.error);
  // A frozen read: the Off cuts it, the read is no failure.
  t.world.fan().state.fanOn = true;
  t.world.fan().latency = (r) => (r.body.queryDynamicShadowData ? 60 * SECOND : 20);
  await t.wait(60 * SECOND);
  const started = t.clock.elapsed;
  const ack2 = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.equal(ack2.success, true, ack2.error);
  assert.ok(t.clock.elapsed - started < 1000, 'not behind the read');
  t.app.stop();
});

test('an Off goes with a full queue, cancels the commands of the same part waiting, nothing of before leaves after', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().latency = 300;
  const device = t.gladys.devices[0];
  const waiting = [];
  for (let n = 0; n < 17; n += 1) {
    waiting.push(t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, (n % 6) + 1));
  }
  const refused = await t.cmd(F(ID, 'fan-speed'), 2);
  assert.equal(refused.success, false);
  assert.match(refused.error, /Trop de commandes/);
  const off = t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0);
  const acks = await t.act(Promise.all([...waiting, off]));
  assert.equal(acks.at(-1).success, true, acks.at(-1).error);
  const offAt = offs(t).at(-1).sentAt;
  const after = t.world.writes().filter((r) => r.sentAt > offAt && r.body.fanOn === true);
  assert.equal(after.length, 0, 'no start sent after the Off');
  assert.ok(acks.slice(1, 17).every((a) => !a.success));
  assert.equal(t.world.fan().state.fanOn, false);
  t.app.stop();
});

test('an Off clicked during a start in flight: the start is stopped before its first byte', async () => {
  const t = await setup();
  await t.start();
  t.world.fan().latency = 200;
  const device = t.gladys.devices[0];
  const start = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 1);
  await t.wait(50); // its read is in flight
  const off = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  const [a, b] = await t.act(Promise.all([start, off]));
  assert.equal(a.success, false);
  assert.match(a.error, /Annulée par une commande plus récente/);
  assert.equal(b.success, true, b.error);
  assert.equal(t.world.writes().filter((r) => r.body.lightOn === true).length, 0);
  t.app.stop();
});

test('an Off that never left (fan down) is kept, never abandoned, and sent when the fan is back', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  t.world.fan().state.fanOn = true;
  await t.start();
  t.world.fan().down = true;
  const ack = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arrêt pas encore envoyé.*gardé/);
  await t.wait(100);
  assert.equal(store.data.guards[0].resends, 0, 'a try that never left is no try');
  // Down for an hour: many failed reads, the Off still held.
  await t.wait(60 * MINUTE);
  assert.equal(t.app.guards.size, 1);
  assert.match(
    t.status().message.en,
    /Off of the fan of .*: not seen applied yet \(sent again 0 time/,
  );
  t.world.fan().down = false;
  await t.wait(6 * MINUTE);
  assert.equal(t.world.fan().state.fanOn, false, 'sent once the fan answers');
  assert.equal(t.app.guards.get(`${ID}:fan`).confirmed, true);
  t.app.stop();
});

test('an Off the fan does not apply: sent again by the reads, 3 times at most, counted when sent; still held', async () => {
  const t = await setup();
  t.world.fan().state.fanOn = true;
  await t.start();
  t.world.fan().deaf = true;
  const ack = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /ne l’affiche pas encore.*gardé/);
  await t.wait(5 * MINUTE);
  assert.equal(offs(t).length, 4, 'the click and 3 more');
  const guard = t.app.guards.get(`${ID}:fan`);
  assert.equal(guard.resends, 3);
  assert.equal(guard.confirmed, false);
  assert.match(t.status().message.en, /accepted 3 more times by the fan, still on; held/);
  // A new click: a new guard, sent again.
  t.world.fan().deaf = false;
  const again = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.equal(again.success, true, again.error);
  t.app.stop();
});

test('applied, then started from the remote: read on twice in a row lifts the guard, once does not', async () => {
  const t = await setup();
  t.world.fan().state.fanOn = true;
  await t.start();
  await t.cmd(F(ID, 'fan-speed'), 0);
  t.world.fan().state.fanOn = true; // the remote
  const read = () => t.act(t.app.readKey(KEY, 3));
  await read();
  assert.ok(t.app.guards.has(`${ID}:fan`), 'once: still held');
  assert.equal(offs(t).length, 1, 'never sent over the remote');
  await read();
  assert.ok(!t.app.guards.has(`${ID}:fan`), 'twice: started elsewhere');
  assert.equal(offs(t).length, 1);
  assert.equal(t.world.fan().state.fanOn, true);
  t.app.stop();
});

test('applied, on once then off again then on: not lifted (two reads in a row only)', async () => {
  const t = await setup();
  await t.start();
  await t.cmd(F(ID, 'light'), 0);
  const read = () => t.act(t.app.readKey(KEY, 3));
  t.world.fan().state.lightOn = true;
  await read();
  t.world.fan().state.lightOn = false;
  await read();
  t.world.fan().state.lightOn = true;
  await read();
  assert.ok(t.app.guards.has(`${ID}:light`));
  t.app.stop();
});

test('a later start that left lifts the guard; one the fan refused (429) does not', async () => {
  const t = await setup();
  await t.start();
  await t.cmd(F(ID, 'light'), 0);
  assert.ok(t.app.guards.has(`${ID}:light`));
  // Refused by the fan: the Off stands.
  t.world.queue.push(undefined); // the read before the command answers normally
  t.world.queue.push(() => ({ status: 429 }));
  const refused = await t.cmd(F(ID, 'light'), 1);
  assert.equal(refused.success, false);
  assert.ok(t.app.guards.has(`${ID}:light`));
  await t.wait(2 * MINUTE);
  const ack = await t.cmd(F(ID, 'light'), 1);
  assert.equal(ack.success, true, ack.error);
  assert.ok(!t.app.guards.has(`${ID}:light`));
  // Direction does not start the fan: it never lifts the fan guard.
  await t.cmd(F(ID, 'fan-speed'), 0);
  await t.cmd(F(ID, 'direction'), 1);
  assert.ok(t.app.guards.has(`${ID}:fan`));
  t.app.stop();
});

test('after a restart: the Off kept in /data leaves before getConfig and before the first read', async () => {
  const store = memoryStore({
    format: 1,
    fans: { [ID]: { address: KEY } },
    links: {},
    guards: [{ id: ID, part: 'fan', address: KEY, resends: 0, confirmed: false }],
  });
  let configAsked = false;
  const t = await setup({
    store,
    getConfig: () => {
      configAsked = true;
      return new Promise(() => {}); // Gladys never answers
    },
  });
  t.world.fan().state.fanOn = true;
  await t.start();
  const first = t.world.requests.find((r) => r.sentAt !== undefined);
  assert.deepEqual(first.body, { fanOn: false });
  assert.ok(configAsked);
  assert.equal(t.world.fan().state.fanOn, false);
  assert.equal(t.app.guards.get(`${ID}:fan`).confirmed, true);
  t.app.stop();
});

test('a click before the configuration is read: the Off goes to the address kept in /data', async () => {
  const store = memoryStore({ format: 1, fans: { [ID]: { address: KEY } }, links: {}, guards: [] });
  const t = await setup({ store, getConfig: () => new Promise(() => {}) });
  t.world.fan().state.lightOn = true;
  await t.start();
  const ack = await t.cmd(F(ID, 'light'), 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(t.world.fan().state.lightOn, false);
  // A start is not sent without the configuration.
  const on = await t.cmd(F(ID, 'light'), 1);
  assert.equal(on.success, false);
  assert.match(on.error, /configuration n’a pas encore été lue/);
  t.app.stop();
});

test('owner not known (/data empty, never read): the Off goes to the address param of the device, else the only address typed', async () => {
  const device = created(ID, { address: `${ADDRESS2}:80` });
  const world = fakeFans({ [`${ADDRESS2}:80`]: fan() });
  const t = await setup({ world, devices: [device], getConfig: () => new Promise(() => {}) });
  world.fan(`${ADDRESS2}:80`).state.fanOn = true;
  await t.start();
  const ack = await t.cmd(F(ID, 'fan-speed'), 0, device);
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.fan(`${ADDRESS2}:80`).state.fanOn, false);
  t.app.stop();
  // No param, nothing kept: the only address typed.
  const bare = { ...created(ID), params: [] };
  const t2 = await setup({ devices: [bare] });
  t2.world.fan().state.fanOn = true;
  t2.world.fan().down = true;
  await t2.start();
  const ack2 = await t2.cmd(F(ID, 'fan-speed'), 0, bare);
  assert.match(ack2.error, /gardé/);
  t2.world.fan().down = false;
  await t2.wait(MINUTE);
  assert.equal(t2.world.fan().state.fanOn, false);
  t2.app.stop();
  // Several addresses typed, none known: refused (never sent to a fan that may be another).
  const t3 = await setup({ devices: [bare], config: { fans: `${ADDRESS}, ${ADDRESS2}` } });
  for (const f of Object.values(t3.world.fans)) f.down = true;
  await t3.start();
  const ack3 = await t3.cmd(F(ID, 'fan-speed'), 0, bare);
  assert.equal(ack3.success, false);
  assert.match(ack3.error, /adresse de ce ventilateur n’est pas connue/);
  t3.app.stop();
});

test('/data that cannot be written, or never answers, never holds an Off; said in the status', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  t.world.fan().state.fanOn = true;
  await t.start();
  store.hang = true;
  const ack = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.equal(ack.success, true, ack.error);
  store.hang = false;
  store.fail = true;
  t.world.fan().state.lightOn = true;
  const ack2 = await t.cmd(F(ID, 'light'), 0);
  assert.equal(ack2.success, true, ack2.error);
  await t.wait(10 * SECOND);
  assert.match(t.status().message.en, /\/data could not be written/);
  t.app.stop();
});

test('/data unreadable: not written over, the reads go on, the Offs still go', async () => {
  const store = memoryStore({ format: 1, fans: {}, links: {}, guards: [] });
  store.unreadable = true;
  const t = await setup({ store });
  await t.start();
  const saves = store.saves;
  await t.cmd(F(ID, 'light'), 0);
  await t.wait(30 * SECOND);
  assert.equal(store.saves, saves);
  assert.match(t.status().message.en, /\/data could not be read/);
  store.unreadable = false;
  await t.wait(10 * SECOND);
  assert.ok(store.saves > saves, 'written once it reads again');
  t.app.stop();
});

test('the fan moved (DHCP): its kept Off follows it to its new address', async () => {
  const world = fakeFans({ [`${ADDRESS2}:80`]: fan() });
  const store = memoryStore({
    format: 1,
    fans: { [ID]: { address: KEY } },
    links: {},
    guards: [{ id: ID, part: 'light', address: KEY, resends: 0, confirmed: false }],
  });
  world.fan(`${ADDRESS2}:80`).state.lightOn = true;
  const t = await setup({ world, store, config: { fans: ADDRESS2 } });
  await t.start();
  await t.wait(SECOND);
  assert.equal(world.fan(`${ADDRESS2}:80`).state.lightOn, false);
  assert.equal(store.data.guards[0].address, `${ADDRESS2}:80`);
  t.app.stop();
});

test('another fan answered at the address of a kept Off: never sent to it', async () => {
  const world = fakeFans({ [KEY]: fan({ id: ID2 }) });
  world.fan(KEY).state.fanOn = true;
  const store = memoryStore({
    format: 1,
    fans: { [ID]: { address: KEY } },
    links: {},
    guards: [{ id: ID, part: 'fan', address: KEY, resends: 0, confirmed: true }],
  });
  const t = await setup({ world, store, config: CONFIG });
  await t.start();
  await t.wait(30 * SECOND);
  assert.equal(world.fan(KEY).state.fanOn, true);
  assert.equal(offs(t).length, 0);
  t.app.stop();
});

test('the device deleted: its Offs held are dropped', async () => {
  const t = await setup();
  await t.start();
  await t.cmd(F(ID, 'light'), 0);
  await t.app.deviceDeleted(t.gladys.devices[0]);
  assert.equal(t.app.guards.size, 0);
  t.app.stop();
});

test('a start of ours cut by an Off but applied late by the fan is not "started elsewhere": the Off is sent again', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.latency = (r) => (r.body.lightOn === true ? 3 * SECOND : 20);
  f.applyDelay = (r) => (r.body.lightOn === true ? 1500 : 0);
  const device = t.gladys.devices[0];
  const start = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 1);
  await t.wait(200); // its read answered, the write left
  const off = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  const [a, b] = await t.act(Promise.all([start, off]));
  assert.equal(a.success, false);
  assert.equal(b.success, true, b.error);
  await t.wait(30 * SECOND);
  assert.equal(f.state.lightOn, false, 'our own late start never taken for the remote');
  assert.ok(t.app.guards.has(`${ID}:light`));
  t.app.stop();
});

// --- Tests written against surviving mutants (each kills one guard removed). -----------

test('an Off refused because another fan answers there never becomes a guard, not even in /data', async () => {
  const world = fakeFans({ [KEY]: fan({ id: ID2 }) });
  const store = memoryStore();
  const written = [];
  const save = store.save.bind(store);
  store.save = (data) => {
    written.push(...data.guards);
    return save(data);
  };
  const t = await setup({ world, store });
  await t.start();
  const ack = await t.cmd(F(ID, 'light'), 0);
  assert.match(ack.error, /Un autre ventilateur répond/);
  await t.wait(SECOND);
  assert.deepEqual(written, []);
  t.app.stop();
});

test('a command taken from the queue never leaves after an Off that came after it, even once the Off is done', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.latency = (r) => (r.body.queryDynamicShadowData ? 2 * SECOND : 20);
  const ok = await t.cmd(F(ID, 'light'), 1);
  assert.equal(ok.success, true, ok.error);
  await t.wait(5 * SECOND + 50); // the follow-up read (5 s) is in flight, 2 s long
  const device = t.gladys.devices[0];
  const dim = t.gladys.fake.setValue(device, { external_id: F(ID, 'brightness') }, 60);
  await t.wait(100); // taken from the queue, its read waits behind the follow-up
  const off = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  const [a, b] = await t.act(Promise.all([dim, off]));
  assert.equal(b.success, true, b.error);
  assert.equal(a.success, false);
  assert.match(a.error, /Annulée par une commande plus récente/);
  await t.wait(SECOND);
  assert.equal(f.state.lightOn, false);
  t.app.stop();
});

test('a kept Off for an address where another fan answers opens no connection there', async () => {
  const world = fakeFans({ [KEY]: fan({ id: ID2 }) });
  const store = memoryStore({
    format: 1,
    fans: { [ID]: { address: KEY } },
    links: {},
    guards: [{ id: ID, part: 'fan', address: KEY, resends: 0, confirmed: true }],
  });
  const t = await setup({ world, store });
  world.fan(KEY).state.fanOn = true;
  await t.start();
  await t.wait(30 * SECOND);
  // Sent again by any path (a read of the fan elsewhere, the start): no request there at all.
  const guard = t.app.guards.get(`${ID}:fan`);
  guard.confirmed = false;
  t.app.resendGuard(guard);
  await t.wait(SECOND);
  assert.equal(world.requests.filter((r) => r.body.fanOn === false).length, 0);
  assert.equal(guard.inFlight, false);
  t.app.stop();
});

test('an Off resend waiting in the lane does not leave once its guard is gone (device deleted)', async () => {
  const t = await setup();
  await t.start();
  await t.cmd(F(ID, 'fan-speed'), 0);
  const guard = t.app.guards.get(`${ID}:fan`);
  t.world.fan().latency = (r) => (r.body.queryDynamicShadowData ? 2 * SECOND : 20);
  const read = t.app.readKey(KEY, 4).catch(() => {});
  await t.wait(100);
  t.app.resendGuard(guard);
  await t.app.deviceDeleted(t.gladys.devices[0]);
  const before = offs(t).length;
  await t.wait(3 * SECOND);
  await read;
  assert.equal(offs(t).length, before);
  t.app.stop();
});

test('a part read unknown is never "started elsewhere": the guard stays', async () => {
  const t = await setup();
  await t.start();
  await t.cmd(F(ID, 'fan-speed'), 0);
  t.world.fan().state.fanOn = 'unknown';
  await t.act(t.app.readKey(KEY, 3));
  await t.act(t.app.readKey(KEY, 3));
  assert.ok(t.app.guards.has(`${ID}:fan`));
  assert.equal(offs(t).length, 1, 'never sent again on an unknown value either');
  t.app.stop();
});

test('an answer to a request that left before the last send of a guard never judges it', async () => {
  const t = await setup();
  await t.start();
  const { parseState } = await import('../src/fan/model.js');
  const key = '192.168.1.99:80';
  const guard = t.app.makeGuard({ id: ID, part: 'fan', address: key, confirmed: true });
  guard.sentAt = 1e12;
  t.app.guards.set(`${ID}:fan`, guard);
  const on = parseState({ ...t.world.fan().state, fanOn: true });
  t.app.applyAnswer(key, on, 1e12 - 2, { judge: true });
  t.app.applyAnswer(key, on, 1e12 - 1, { judge: true });
  assert.equal(t.app.guards.get(`${ID}:fan`), guard, 'two older reads on never lift it');
  assert.equal(guard.other, undefined);
  t.app.stop();
});

test('a device deleted without Off held still refreshes Discover and the status', async () => {
  const t = await setup();
  await t.start();
  const posts = () => t.gladys.fake.bodies('POST', '/discovered_device').length;
  const before = posts();
  t.app.published = 'stale';
  await t.app.deviceDeleted(t.gladys.devices[0]);
  assert.ok(posts() > before);
  t.app.stop();
});

// --- Review r1 -----------------------------------------------------------------------

test('I1: an Off held through a 12 min outage leaves within 15 s of the fan answering again', async () => {
  const t = await setup();
  t.world.fan().state.fanOn = true;
  await t.start();
  t.world.fan().down = true;
  await t.wait(2 * MINUTE); // the reads now pause 1, 2 then 5 min
  const ack = await t.cmd(F(ID, 'fan-speed'), 0);
  assert.match(ack.error, /gardé/);
  await t.wait(10 * MINUTE);
  assert.equal(t.world.fan().state.fanOn, true);
  t.world.fan().down = false;
  const back = t.clock.elapsed;
  await t.wait(15 * SECOND);
  const sent = offs(t)[0];
  assert.ok(sent, 'the Off left');
  assert.ok(sent.sentAt - back <= 15 * SECOND, `${sent.sentAt - back} ms after the fan came back`);
  assert.equal(t.world.fan().state.fanOn, false);
  assert.equal(t.app.guards.get(`${ID}:fan`).resends, 0, 'its first send is no resend');
  t.app.stop();
});

test('I1: an Off refused with 503 is sent again by the probe, not after the minute of the reads', async () => {
  const t = await setup();
  t.world.fan().state.lightOn = true;
  await t.start();
  t.world.queue.push(() => ({ status: 503 }));
  const ack = await t.cmd(F(ID, 'light'), 0);
  assert.equal(ack.success, false);
  await t.wait(11 * SECOND);
  assert.equal(t.world.fan().state.lightOn, false);
  t.app.stop();
});

test('I4: fan Off and light Off of one scene on a deaf fan: each judged on its own field, both applied', async () => {
  const t = await setup();
  const f = t.world.fan();
  f.state.fanOn = true;
  f.state.lightOn = true;
  await t.start();
  f.deaf = true;
  const device = t.gladys.devices[0];
  const acks = await t.act(
    Promise.all([
      t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0),
      t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0),
    ]),
  );
  assert.ok(acks.every((a) => !a.success));
  await t.wait(1 * SECOND);
  assert.equal(t.world.writes().length, 2, 'no resend burst from the answers of the writes');
  await t.wait(5 * SECOND);
  f.deaf = false;
  await t.wait(30 * SECOND);
  assert.equal(f.state.fanOn, false);
  assert.equal(f.state.lightOn, false);
  // Spread: never two resends of one guard within a read interval.
  for (const field of ['fanOn', 'lightOn']) {
    const at = offs(t, field).map((r) => r.sentAt);
    for (let i = 1; i < at.length; i += 1)
      assert.ok(at[i] - at[i - 1] >= 9 * SECOND, `${field} ${at}`);
  }
  t.app.stop();
});

test('m6: duplicate Offs behind a frozen one: each frozen Off is cut at 1 s, the last one leaves in time', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.state.fanOn = true;
  let frozen = 2;
  f.latency = (r) =>
    (r.body.fanOn === false || r.body.lightOn === false) && frozen-- > 0 ? 60 * SECOND : 20;
  const device = t.gladys.devices[0];
  const one = t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0);
  await t.wait(10);
  const two = t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0);
  await t.wait(10);
  const three = t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0);
  const started = t.clock.elapsed;
  const acks = await t.act(Promise.all([one, two, three]));
  assert.equal(acks[2].success, true, acks[2].error);
  assert.ok(t.clock.elapsed - started < 3 * SECOND);
  t.app.stop();
});
