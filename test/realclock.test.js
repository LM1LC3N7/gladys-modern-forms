// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), sped
// up 20 times, against a real local HTTP server playing a fan: the reads start
// at the interval, never sooner, never a cycle late; a command and an Off
// still read back and resolve. The app is stopped in `finally` (t.after).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { httpServer, measurePeriod, realClock, spyOn } from './kit/index.mjs';
import { fan } from './helpers/fakeFans.js';
import { created } from './helpers/app.js';

const SPEED = 20;
const INTERVAL = POLL_INTERVAL.default * 1000;

test('real clock x20: one read per interval (measured), a command and an Off confirmed', async (t) => {
  const f = fan();
  const srv = await httpServer({
    latencyMs: 5,
    routes: {
      'POST /mf': (r) => {
        if (r.json.queryStaticShadowData) return f.info;
        for (const key of ['fanOn', 'fanSpeed', 'lightOn', 'lightBrightness']) {
          if (key in r.json) f.state[key] = r.json[key];
        }
        return f.state;
      },
    },
  });
  const clock = realClock({ speed: SPEED });
  t.after(async () => {
    clock.close();
    await srv.close();
  });
  const device = created('c82b9698e5ac', { address: `127.0.0.1:${srv.port}` });
  const gladys = createFakeGladys({
    selector: 'mf',
    config: { fans: `127.0.0.1:${srv.port}` },
    devices: [device],
  });
  await gladys.connect();
  const quiet = () => {};
  const app = new App({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  const spy = spyOn(app, 'readRound', clock);
  await app.onConnected(() => gladys.getConfig());
  const gaps = await measurePeriod(spy, { count: 4, period: INTERVAL });
  assert.equal(gaps.length, 3);
  const speed = await gladys.fake.setValue(
    device,
    { external_id: `${device.external_id}:fan-speed` },
    5,
  );
  assert.equal(speed.success, true, speed.error);
  assert.equal(f.state.fanSpeed, 5);
  const off = await gladys.fake.setValue(device, { external_id: `${device.external_id}:light` }, 0);
  assert.equal(off.success, true, off.error);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  app.stop();
  assert.ok(clock.timersSet < 60, `${clock.timersSet} timers`);
});
