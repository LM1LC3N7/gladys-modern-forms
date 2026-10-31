// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, fake fans and the virtual clock of
// the shared test kit: every read of `now()` or `monotonic()` moves the time
// by 1 µs, so a decision reading the clock twice is caught.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { testClock } from '../kit/index.mjs';
import { App } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { parseState } from '../../src/fan/model.js';
import { ADDRESS, ID, fakeFans, fan } from './fakeFans.js';

export const SELECTOR = 'mf';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const START = Date.UTC(2026, 9, 31, 12, 0, 0);
export const CONFIG = { fans: ADDRESS };

/** The external id of a feature: `F(ID, 'fan-speed')`. */
export const F = (id, key) => `ext:${SELECTOR}:fan:${id}${key ? `:${key}` : ''}`;

/** A device as the user created it from the Discovery list (light and breeze by default). */
export function created(id = ID, { light = true, wind = true, address = `${ADDRESS}:80` } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const state = parseState(fan({ id, light, wind }).state);
  return buildDevice(gladys, { id, state, address }, { language: 'fr' });
}

export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

export async function setup({
  config = CONFIG,
  devices = [created()],
  store = memoryStore(),
  clock = testClock({ start: START }),
  world = fakeFans(),
  getConfig,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  if (getConfig) gladys.getConfig = getConfig;
  world.clock = clock;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new App({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    transport: world.transport,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app, { error: log });
  async function wait(ms) {
    await clock.advance(ms);
    await settle();
  }
  /** Connects as the SDK does ('connected' -> onConnected), then lets 1 s pass. */
  const start = async () => {
    let finished = false;
    app
      .onConnected(() => gladys.getConfig())
      .finally(() => {
        finished = true;
      });
    // Not awaited for ever: a Gladys that never answers getConfig is a case under test.
    for (let i = 0; i < 50 && !finished; i += 1) await wait(20);
    await wait(1000);
  };
  /** Awaits a promise while the virtual clock moves (10 ms steps). */
  const act = async (promise, max = 60_000) => {
    let done = false;
    const result = promise.then(
      (value) => {
        done = true;
        return { value };
      },
      (error) => {
        done = true;
        return { error };
      },
    );
    await settle();
    for (let t = 0; !done && t < max; t += 10) {
      await clock.advance(10);
      await settle(3);
    }
    if (!done) throw new Error('the promise did not settle');
    const { value, error } = await result;
    if (error) throw error;
    return value;
  };
  /** A command through the fake Gladys; its ack awaited while the clock moves. */
  const cmd = (featureId, value, device = devices[0]) =>
    act(gladys.fake.setValue(device, { external_id: featureId }, value));
  const status = () => gladys.fake.connectionStatus;
  return { app, gladys, clock, store, world, start, wait, act, cmd, lines, status };
}
