// -----------------------------------------------------------------------------
// Review r3: the commands of a batch kept after an Off refused some of them are
// written again (I6); which answers count as a try of an Off (m-e); the probe
// also sends an Off the fan accepted but still showed on (m-d).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, MINUTE, SECOND, setup } from './helpers/app.js';
import { ADDRESS, ID, ID2, fan } from './helpers/fakeFans.js';

const KEY = `${ADDRESS}:80`;
const offWrites = (t, field = 'fanOn') =>
  t.world.writes().filter((r) => r.body[field] === false && Object.keys(r.body).length === 1);

// --- I6: an Off between the forming of a batch and its write ------------------------

for (const [label, commands] of [
  // The Off refuses a member: the job and the other member are written (kept.slice(1) queued again).
  [
    'the first command kept, a member refused',
    [
      ['brightness', 40],
      ['light', 1],
      ['fan-speed', 3],
    ],
  ],
  // The Off refuses the first command (the job): the two members kept are queued again.
  [
    'the first command refused, the members kept',
    [
      ['fan-speed', 3],
      ['brightness', 40],
      ['light', 1],
    ],
  ],
]) {
  test(`I6: an Off clicked once a batch is formed, before its write leaves (${label}): the others written once, acknowledged`, async (ctx) => {
    const t = await setup();
    ctx.after(() => t.app.stop());
    const f = t.world.fan();
    f.state.fanOn = true;
    f.state.fanSpeed = 2;
    await t.start();
    f.latency = 100;
    const device = t.gladys.devices[0];
    const set = (k, v) => t.gladys.fake.setValue(device, { external_id: F(ID, k) }, v);
    const acks = commands.map(([k, v]) => set(k, v));
    // The read answers at ~101 ms; the batch of the three is formed and its write waits the
    // 10 ms of the lane: the window this test is about, checked rather than assumed.
    await t.wait(104);
    const lane = t.app.lanes.get(KEY);
    assert.equal(lane.current, undefined, 'nothing in flight');
    assert.deepEqual(
      lane.queue.map((j) => j.options.body),
      [{ fanOn: true, fanSpeed: 3, lightOn: true, lightBrightness: 40 }],
      'the batch write waits in the lane',
    );
    assert.equal(t.app.links.get(KEY).commands.length, 0, 'every command joined the batch');
    const off = set('fan-speed', 0);
    // Bounded: a command lost (never acknowledged) fails here, not at the timeout of the runner.
    const all = await t.act(Promise.all([...acks, off]), 10 * SECOND);
    const ack = Object.fromEntries(commands.map(([k], i) => [k, all[i]]));
    assert.equal(all[3].success, true, all[3].error);
    assert.match(ack['fan-speed'].error, /Annulée/);
    assert.equal(ack.brightness.success, true, ack.brightness.error);
    assert.equal(ack.light.success, true, ack.light.error);
    // Written once, after the Off, without the start of the fan.
    const offAt = offWrites(t)[0].sentAt;
    const lights = t.world.writes().filter((r) => r.body.lightOn === true);
    assert.equal(lights.length, 1, 'the light commands written once');
    assert.deepEqual(lights[0].body, { lightOn: true, lightBrightness: 40 });
    assert.ok(lights[0].sentAt > offAt);
    assert.ok(!t.world.writes().some((r) => r.body.fanSpeed === 3), 'the older start never left');
    assert.equal(f.state.fanOn, false);
    assert.equal(f.state.lightOn, true);
    assert.equal(f.state.lightBrightness, 40);
  });
}

// --- m-e: which answer of an Off sent again counts as a try ---------------------------

for (const [label, answer] of [
  // A 2xx without the field of the part: unknown, no try.
  [
    'without the field of the part',
    () => {
      const { fanOn: _drop, ...rest } = fan().state;
      return rest;
    },
  ],
  // A 2xx of another fan (swapped at that address) showing its own fan on: not this Off.
  ['from another fan, on', () => ({ ...fan({ id: ID2 }).state, fanOn: true })],
]) {
  test(`m-e: an answer to an Off sent again ${label} is no try; the Off goes on until applied`, async (ctx) => {
    const t = await setup();
    ctx.after(() => t.app.stop());
    const f = t.world.fan();
    f.state.fanOn = true;
    await t.start();
    f.deaf = true;
    const ack = await t.cmd(F(ID, 'fan-speed'), 0); // its first send: accepted, still on
    assert.equal(ack.success, false);
    f.deaf = false;
    // Every Off from now on answered so; the reads still show this fan on.
    f.answerFor = (r) => (r.body.fanOn === false ? answer() : undefined);
    await t.wait(3 * MINUTE);
    const guard = t.app.guards.get(`${ID}:fan`);
    assert.ok(offWrites(t).length >= 5, `${offWrites(t).length} sends`);
    assert.equal(guard.resends, 0, 'none of them counts');
    assert.equal(f.state.fanOn, true);
    f.answerFor = undefined;
    await t.wait(25 * SECOND);
    assert.equal(f.state.fanOn, false, 'applied once the fan answers it');
  });
}

// --- m-d: an Off accepted but still on is watched by the probe too -------------------

for (const [label, counted] of [
  ['right after its click', 0],
  ['after one counted answer', 1],
]) {
  test(`m-d: an Off accepted still on, then an outage (503) ${label}: probed every 10 s, applied within 10 s of the fan's return`, async (ctx) => {
    const t = await setup();
    ctx.after(() => t.app.stop());
    const f = t.world.fan();
    f.state.fanOn = true;
    await t.start();
    f.deaf = true;
    await t.cmd(F(ID, 'fan-speed'), 0);
    const guard = () => t.app.guards.get(`${ID}:fan`);
    for (let i = 0; i < 60 && guard().resends < counted; i += 1) await t.wait(SECOND);
    assert.equal(guard().resends, counted);
    f.deaf = false;
    f.status = 503; // every request, the reads too: they pause a minute at least
    const before = offWrites(t).length;
    await t.wait(70 * SECOND);
    assert.ok(offWrites(t).length - before >= 5, `${offWrites(t).length - before} sends`);
    assert.equal(guard().resends, counted, 'a 503 is no try');
    f.status = undefined;
    await t.wait(10 * SECOND + 100);
    assert.equal(f.state.fanOn, false, 'applied without waiting for the reads');
  });
}

test('m-d: the probe and the reads never send an Off accepted still on twice within 10 s; 3 counted, then held', async (ctx) => {
  const t = await setup();
  ctx.after(() => t.app.stop());
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  f.deaf = true;
  await t.cmd(F(ID, 'fan-speed'), 0);
  await t.wait(5 * MINUTE);
  const sends = offWrites(t).map((r) => r.sentAt);
  assert.equal(sends.length, 4, 'the click and 3 counted');
  for (let i = 1; i < sends.length; i += 1) {
    assert.ok(sends[i] - sends[i - 1] >= 10 * SECOND, `${sends[i] - sends[i - 1]} ms apart`);
  }
  assert.equal(t.app.guards.get(`${ID}:fan`).resends, 3);
});

test('m-d: with a long read interval, an Off accepted still on is sent again by the probe (10 s), not at the next read', async (ctx) => {
  const t = await setup({ config: { fans: ADDRESS, poll_interval: 300 } });
  ctx.after(() => t.app.stop());
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  f.deaf = true;
  await t.cmd(F(ID, 'fan-speed'), 0);
  f.deaf = false;
  // The reads of the click (5 s, 20 s) fail: only the probe can send it.
  f.statusFor = (r) => (r.body.fanOn === false ? undefined : 503);
  await t.wait(10 * SECOND + 100);
  assert.equal(offWrites(t).length, 2);
  assert.equal(f.state.fanOn, false);
});

test('m-d: our own start landing late un-confirms an Off, then the reads fail: the probe sends it', async (ctx) => {
  const t = await setup({ config: { fans: ADDRESS, poll_interval: 300 } });
  ctx.after(() => t.app.stop());
  await t.start();
  const f = t.world.fan();
  f.latency = (r) => (r.body.lightOn === true ? 3 * SECOND : 20);
  f.applyDelay = (r) => (r.body.lightOn === true ? 1500 : 0);
  const device = t.gladys.devices[0];
  const set = (k, v) => t.gladys.fake.setValue(device, { external_id: F(ID, k) }, v);
  const start = set('light', 1);
  await t.wait(200); // its read answered, the write left
  const [, off] = await t.act(Promise.all([start, set('light', 0)]));
  assert.equal(off.success, true, off.error);
  const guard = t.app.guards.get(`${ID}:light`);
  assert.equal(guard.confirmed, true);
  // The follow-up read (5 s) shows the light on (our start landed): no longer applied, too soon to
  // send again (10 s).
  await t.wait(5 * SECOND + 100);
  assert.equal(guard.confirmed, false);
  assert.equal(offWrites(t, 'lightOn').length, 1);
  f.statusFor = (r) => (r.body.lightOn === false ? undefined : 503); // the reads fail from now on
  await t.wait(12 * SECOND);
  assert.equal(offWrites(t, 'lightOn').length, 2);
  assert.equal(f.state.lightOn, false);
});

test('m-d: an Off restored after a start the fan refused (503) is probed again, the reads paused', async (ctx) => {
  const t = await setup({ config: { fans: ADDRESS, poll_interval: 300 } });
  ctx.after(() => t.app.stop());
  const f = t.world.fan();
  f.state.fanOn = true;
  await t.start();
  f.deaf = true;
  await t.cmd(F(ID, 'fan-speed'), 0); // accepted, still on: held
  f.deaf = false;
  await t.wait(9 * SECOND); // the follow-up read (5 s) shows it on: too soon to send again
  assert.equal(offWrites(t).length, 1);
  let readsFail = false;
  f.latency = (r) => (r.body.fanOn === true ? 3 * SECOND : 20);
  f.statusFor = (r) =>
    r.body.fanOn === true || (readsFail && r.body.fanOn === undefined) ? 503 : undefined;
  const device = t.gladys.devices[0];
  const start = t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 3);
  await t.wait(100); // its read answered, its write left: the guard lifted meanwhile
  assert.equal(t.app.guards.has(`${ID}:fan`), false);
  readsFail = true;
  const ack = await t.act(start); // refused (503) at ~12 s: the Off stands, the reads paused
  assert.equal(ack.success, false);
  assert.equal(t.app.guards.has(`${ID}:fan`), true);
  await t.wait(15 * SECOND);
  assert.equal(offWrites(t).length, 2);
  assert.equal(f.state.fanOn, false);
});

test('m-a with m-d: a read 10 s or more after the last send of an Off still on sends it at once, with a 60 s interval', async (ctx) => {
  const t = await setup({ config: { fans: ADDRESS, poll_interval: 60 } });
  ctx.after(() => t.app.stop());
  const f = t.world.fan();
  f.state.lightOn = true;
  await t.start();
  f.deaf = true; // every send accepted, the light still on
  f.latency = (r) => (r.body.queryDynamicShadowData ? 500 : 20);
  await t.cmd(F(ID, 'light'), 0);
  await t.wait(11 * SECOND); // the probe sent it again at 10 s
  assert.equal(offWrites(t, 'lightOn').length, 2);
  // The follow-up read of the click (20 s) shows it on 10.5 s after the probe sent it: sent at
  // once by that read (the gate of the reads is 10 s at most), not 10 s later by the probe.
  await t.wait(10 * SECOND);
  const sends = offWrites(t, 'lightOn');
  assert.equal(sends.length, 3);
  assert.ok(
    t.world.reads().some((r) => r.sentAt > sends[1].sentAt && r.sentAt < sends[2].sentAt),
    'sent by a read',
  );
});
