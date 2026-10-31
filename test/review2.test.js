// -----------------------------------------------------------------------------
// Review r2: an Off held is never given up (only an answer still showing the
// part on counts), the guards of a batch, the probe, the order of the renames.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { F, MINUTE, SECOND, created, setup } from './helpers/app.js';
import { ADDRESS, ID, fakeFans, fan } from './helpers/fakeFans.js';
import { fileStore, memoryStore } from '../src/store.js';

const KEY = `${ADDRESS}:80`;
const offWrites = (t, field = 'fanOn') =>
  t.world.writes().filter((r) => r.body[field] === false && Object.keys(r.body).length === 1);

for (const [label, make] of [
  ['503', (f) => (f.statusFor = (r) => (r.body.fanOn === false ? 503 : undefined))],
  ['429', (f) => (f.statusFor = (r) => (r.body.fanOn === false ? 429 : undefined))],
  [
    'no answer',
    (f) => {
      // The fan neither answers nor acts.
      f.deaf = true;
      f.latency = (r) => (r.body.fanOn === false ? 60 * SECOND : 20);
    },
  ],
]) {
  test(`B1: an Off refused or unanswered (${label}) many times is never given up`, async () => {
    const t = await setup();
    const f = t.world.fan();
    f.state.fanOn = true;
    await t.start();
    make(f);
    await t.cmd(F(ID, 'fan-speed'), 0);
    await t.wait(3 * MINUTE); // far more than 3 tries
    assert.ok(offWrites(t).length > 5, `${offWrites(t).length} sends`);
    const guard = t.app.guards.get(`${ID}:fan`);
    assert.equal(guard.resends, 0, 'none of them counts');
    assert.equal(f.state.fanOn, true);
    f.statusFor = undefined;
    f.latency = 20;
    f.deaf = false;
    await t.wait(11 * SECOND);
    assert.equal(f.state.fanOn, false, 'applied once the fan accepts it');
    t.app.stop();
  });
}

test('B1: only an answer still showing the part on counts; 3 of them and the Off waits for a click', async () => {
  const t = await setup();
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  f.deaf = true;
  await t.cmd(F(ID, 'fan-speed'), 0);
  await t.wait(5 * MINUTE);
  const guard = t.app.guards.get(`${ID}:fan`);
  assert.equal(guard.resends, 3);
  const sends = offWrites(t).length;
  await t.wait(5 * MINUTE);
  assert.equal(offWrites(t).length, sends, 'no fourth one');
  assert.match(t.status().message.en, /click Off again/);
  t.app.stop();
});

test('m-a: one resend per read interval, 10 s at most even with a 60 s interval', async () => {
  const t = await setup({ config: { fans: ADDRESS, poll_interval: 60 } });
  const f = t.world.fan();
  f.state.lightOn = true;
  await t.start();
  f.deaf = true;
  await t.cmd(F(ID, 'light'), 0);
  f.deaf = false;
  await t.wait(5 * SECOND + 100); // the follow-up read (5 s) shows it on: too soon
  assert.equal(offWrites(t, 'lightOn').length, 1);
  await t.wait(15 * SECOND); // the follow-up at 20 s: 10 s passed, sent again
  assert.equal(offWrites(t, 'lightOn').length, 2);
  assert.equal(f.state.lightOn, false);
  t.app.stop();
});

// --- The probe ---------------------------------------------------------------------

test('probe: one Off per address per turn, the other Off of that fan right behind its answer', async () => {
  const t = await setup();
  const f = t.world.fan();
  f.state.fanOn = true;
  f.state.lightOn = true;
  await t.start();
  f.down = true;
  const device = t.gladys.devices[0];
  await t.act(
    Promise.all([
      t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0),
      t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0),
    ]),
  );
  await t.wait(30 * SECOND);
  // While down: one connection attempt per probe turn (10 s), not two.
  const turn = t.world.requests.filter((r) => r.at > t.clock.elapsed - 9 * SECOND);
  assert.ok(turn.filter((r) => r.body.fanOn === false || r.body.lightOn === false).length <= 1);
  f.down = false;
  await t.wait(10 * SECOND + 100);
  const [a, b] = [offWrites(t)[0], offWrites(t, 'lightOn')[0]];
  assert.ok(a && b, 'both left');
  assert.ok(Math.abs(a.sentAt - b.sentAt) < SECOND, 'the second right behind the first answer');
  assert.equal(f.state.fanOn, false);
  assert.equal(f.state.lightOn, false);
  t.app.stop();
});

test('probe: an answer clears "unanswered" (no probe send within 10 s of an answered one)', async () => {
  const t = await setup();
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  let slow = true;
  f.deaf = true; // the fan stays on
  f.latency = (r) => (r.body.fanOn === false && slow ? 60 * SECOND : 20);
  await t.cmd(F(ID, 'fan-speed'), 0); // no answer: unanswered
  assert.equal(t.app.guards.get(`${ID}:fan`).unanswered, true);
  slow = false; // the probe send is answered (still on)
  await t.wait(11 * SECOND);
  const guard = t.app.guards.get(`${ID}:fan`);
  assert.equal(guard.unanswered, false);
  const sends = offWrites(t).length;
  await t.wait(9 * SECOND);
  assert.equal(offWrites(t).length, sends, 'no probe send within 10 s of an answer');
  t.app.stop();
});

test('probe: whether an Off ever left is kept in /data (its first send after a restart is no resend)', async () => {
  const store = memoryStore();
  const t = await setup({ store });
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  f.deaf = true;
  await t.cmd(F(ID, 'fan-speed'), 0);
  await t.wait(SECOND);
  assert.equal(store.data.guards[0].left, true);
  t.app.stop();
});

// --- The guards of a batch ---------------------------------------------------------

test('batch: a write refused (503): no command of it is a success', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.latency = 200;
  f.statusFor = (r) => (r.body.fanOn === true ? 503 : undefined);
  const device = t.gladys.devices[0];
  const set = (k, v) => t.gladys.fake.setValue(device, { external_id: F(ID, k) }, v);
  const acks = await t.act(
    Promise.all([set('fan-speed', 3), set('direction', 1), set('light', 1)]),
  );
  assert.ok(acks.every((a) => !a.success));
  t.app.stop();
});

test('batch: two starts lift the Off held of each part', async () => {
  const t = await setup();
  const f = t.world.fan();
  f.state.fanOn = true;
  f.state.lightOn = true;
  await t.start();
  f.deaf = true;
  const device = t.gladys.devices[0];
  const set = (k, v) => t.gladys.fake.setValue(device, { external_id: F(ID, k) }, v);
  await t.act(Promise.all([set('fan-speed', 0), set('light', 0)]));
  f.deaf = false;
  assert.equal(t.app.guards.size, 2);
  f.latency = 300;
  const acks = await t.act(Promise.all([set('fan-speed', 2), set('brightness', 30)]));
  assert.ok(acks.every((a) => a.success));
  assert.equal(t.app.guards.size, 0);
  t.app.stop();
});

test('batch (m-b): an Off of one part clicked before the write leaves cancels that part only', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.latency = 100;
  const device = t.gladys.devices[0];
  const set = (k, v) => t.gladys.fake.setValue(device, { external_id: F(ID, k) }, v);
  const light = set('brightness', 40);
  const speed = set('fan-speed', 3);
  // The read answers at ~101 ms; the batch is formed, its write waits the 10 ms of the lane.
  await t.wait(104);
  const off = set('fan-speed', 0);
  const acks = await t.act(Promise.all([light, speed, off]));
  assert.equal(acks[0].success, true, acks[0].error);
  assert.match(acks[1].error, /Annulée/);
  assert.equal(acks[2].success, true, acks[2].error);
  const offAt = offWrites(t)[0].sentAt;
  assert.ok(!t.world.writes().some((r) => r.body.fanSpeed === 3), 'the older start never left');
  assert.ok(t.world.writes().some((r) => r.body.lightBrightness === 40 && r.sentAt > offAt));
  assert.equal(f.state.fanOn, false);
  assert.equal(f.state.lightOn, true);
  t.app.stop();
});

test('batch: a member the fan cannot do (breeze without breeze) is refused, the others written', async () => {
  const world = fakeFans({ [KEY]: fan({ wind: false }) });
  const t = await setup({ world, devices: [created(ID, { wind: true })] });
  await t.start();
  world.fan(KEY).latency = 100;
  const device = t.gladys.devices[0];
  const set = (k, v) => t.gladys.fake.setValue(device, { external_id: F(ID, k) }, v);
  const acks = await t.act(Promise.all([set('direction', 1), set('wind', 2)]));
  assert.equal(acks[0].success, true, acks[0].error);
  assert.equal(acks[1].success, false);
  assert.ok(!t.world.writes().some((r) => 'wind' in r.body));
  t.app.stop();
});

test('batch: a member the answer does not show is no success', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.latency = 100;
  f.deaf = true;
  const device = t.gladys.devices[0];
  const set = (k, v) => t.gladys.fake.setValue(device, { external_id: F(ID, k) }, v);
  const acks = await t.act(Promise.all([set('fan-speed', 3), set('light', 1)]));
  assert.ok(acks.every((a) => !a.success));
  t.app.stop();
});

test('batch: a command arriving while the read is in flight gets a read of its own', async () => {
  const t = await setup();
  await t.start();
  const f = t.world.fan();
  f.latency = 600;
  t.world.requests.length = 0;
  const device = t.gladys.devices[0];
  const set = (k, v) => t.gladys.fake.setValue(device, { external_id: F(ID, k) }, v);
  const first = set('direction', 1);
  await t.wait(350);
  const late = set('brightness', 40);
  const acks = await t.act(Promise.all([first, late]));
  assert.ok(acks.every((a) => a.success));
  assert.ok(t.world.reads().length >= 2, `${t.world.reads().length} reads`);
  t.app.stop();
});

test('store: an older save whose rename is slower never puts its state back over a newer one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mf-rename-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  let renames = 0;
  const fs = {
    ...realFs,
    rename: async (a, b) => {
      renames += 1;
      if (renames === 1) await new Promise((resolve) => setTimeout(resolve, 300));
      return realFs.rename(a, b);
    },
  };
  const store = fileStore(file, { fs, queueWait: 20 });
  const p1 = store.save({ n: 1 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const p2 = store.save({ n: 2 });
  await Promise.all([p1, p2]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { n: 2 });
});

test('probe: the first send that ever leaves (after an outage) is no resend, even answered still on', async () => {
  const t = await setup();
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  f.down = true;
  await t.cmd(F(ID, 'fan-speed'), 0); // never left
  f.down = false;
  f.deaf = true;
  await t.wait(10 * SECOND + 500); // the probe sends it: its first send
  const guard = t.app.guards.get(`${ID}:fan`);
  assert.equal(guard.left, true);
  assert.equal(guard.resends, 0);
  t.app.stop();
});

test('probe: a lost answer, then a read showing the Off applied: the probe stops (nothing sent again)', async () => {
  const t = await setup();
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  f.latency = (r) => (r.body.fanOn === false ? 60 * SECOND : 20);
  await t.cmd(F(ID, 'fan-speed'), 0); // applied by the fan, the answer lost
  f.latency = 20;
  await t.act(t.app.readKey(KEY, 3));
  const guard = t.app.guards.get(`${ID}:fan`);
  assert.equal(guard.confirmed, true);
  assert.equal(guard.unanswered, false);
  f.state.fanOn = true; // the remote, at once
  const before = offWrites(t).length;
  await t.wait(11 * SECOND);
  assert.equal(offWrites(t).length, before, 'no probe send over the remote');
  t.app.stop();
});
