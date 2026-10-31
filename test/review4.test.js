// -----------------------------------------------------------------------------
// Review r4: the probe sends only the Offs it watches (I7: never one seen
// applied nor one given up, even while another Off keeps it running), and one
// Off per address per turn (m-h), also for Offs accepted still on.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, SECOND, setup } from './helpers/app.js';
import { ADDRESS, ID } from './helpers/fakeFans.js';

const isOff = (field) => (r) => r.body?.[field] === false && Object.keys(r.body).length === 1;
const offWrites = (t, field = 'fanOn') => t.world.writes().filter(isOff(field));

test('I7: an Off seen applied is never sent by the probe that another Off keeps running (the remote start stays)', async (ctx) => {
  const t = await setup({ config: { fans: ADDRESS, poll_interval: 60 } });
  ctx.after(() => t.app.stop());
  const f = t.world.fan();
  f.state.fanOn = true;
  f.state.lightOn = true;
  await t.start();
  const light = await t.cmd(F(ID, 'light'), 0); // applied, confirmed by its answer
  assert.equal(light.success, true, light.error);
  await t.wait(21 * SECOND); // its follow-up reads (5 s, 20 s) see it off
  const lightGuard = t.app.guards.get(`${ID}:light`);
  assert.equal(lightGuard.confirmed, true);
  f.deaf = true;
  await t.cmd(F(ID, 'fan-speed'), 0); // accepted, still on: watched, the probe runs
  f.deaf = false;
  f.state.lightOn = true; // the remote lights it again
  // The follow-up of the fan Off (5 s) reads the light on once: the guard stays (lifted by a
  // second read, at 20 s), while the probe turns at 10 s.
  await t.wait(6 * SECOND);
  assert.equal(t.app.guards.get(`${ID}:light`), lightGuard, 'still held at the probe turn');
  const before = offWrites(t, 'lightOn').length;
  await t.wait(29 * SECOND);
  assert.equal(offWrites(t, 'fanOn').length, 2, 'the probe ran (the fan Off sent again)');
  assert.equal(offWrites(t, 'lightOn').length, before, 'no light Off from the probe');
  assert.equal(f.state.lightOn, true);
});

test('I7: an Off given up (3 tries) is never sent again by the probe that another Off keeps running', async (ctx) => {
  const t = await setup();
  ctx.after(() => t.app.stop());
  const f = t.world.fan();
  f.state.fanOn = true;
  f.state.lightOn = true;
  await t.start();
  f.deaf = true;
  await t.cmd(F(ID, 'fan-speed'), 0);
  const fanGuard = t.app.guards.get(`${ID}:fan`);
  for (let i = 0; i < 120 && fanGuard.resends < 3; i += 1) await t.wait(SECOND);
  assert.equal(fanGuard.resends, 3, 'given up');
  await t.wait(SECOND);
  const before = offWrites(t, 'fanOn').length;
  assert.equal(before, 4, 'the click and 3 tries');
  await t.cmd(F(ID, 'light'), 0); // deaf: accepted, still on, watched
  await t.wait(45 * SECOND);
  assert.ok(offWrites(t, 'lightOn').length >= 3, 'the probe ran (the light Off sent again)');
  assert.equal(offWrites(t, 'fanOn').length, before, 'the Off given up stays at rest');
  assert.equal(fanGuard.resends, 3);
});

test('m-h: one Off per address per probe turn, also for two Offs accepted still on while the fan is down', async (ctx) => {
  const t = await setup();
  ctx.after(() => t.app.stop());
  const f = t.world.fan();
  f.state.fanOn = true;
  f.state.lightOn = true;
  await t.start();
  f.deaf = true;
  const device = t.gladys.devices[0];
  await t.act(
    Promise.all([
      t.gladys.fake.setValue(device, { external_id: F(ID, 'fan-speed') }, 0),
      t.gladys.fake.setValue(device, { external_id: F(ID, 'light') }, 0),
    ]),
  );
  f.down = true; // connection refused: nothing leaves, both stay due at every turn
  const from = t.clock.elapsed;
  await t.wait(60 * SECOND);
  const tries = t.world.requests
    .filter((r) => r.at > from && (isOff('fanOn')(r) || isOff('lightOn')(r)))
    .map((r) => r.at);
  assert.ok(tries.length >= 5, `${tries.length} attempts`);
  for (let i = 1; i < tries.length; i += 1) {
    assert.ok(tries[i] - tries[i - 1] >= 9 * SECOND, `${tries[i] - tries[i - 1]} ms apart`);
  }
  f.down = false;
  f.deaf = false;
  await t.wait(25 * SECOND);
  assert.equal(f.state.fanOn, false);
  assert.equal(f.state.lightOn, false);
});
