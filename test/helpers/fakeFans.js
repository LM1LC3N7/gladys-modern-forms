// -----------------------------------------------------------------------------
// Fake Modern Forms fans behind the transport of the client (no network), on
// the virtual clock, built from the WAC reference and the mock fan of
// aiomodernforms 0.3.1 (MIT): `POST /mf` with `queryDynamicShadowData`,
// `queryStaticShadowData` or a command, answered with the whole state. A fan
// may be down (connection refused), slow (`latency`), frozen (`hang`: no
// answer, the request times out at its deadline), answer a status, ignore the
// commands (`deaf`), answer without `clientId`; it can be cut (onStart).
// Every request is recorded (`requests`, with the time it left).
// -----------------------------------------------------------------------------

import { FanError } from '../../src/fan/http.js';

export const ADDRESS = '192.168.1.60';
export const ADDRESS2 = '192.168.1.61';
export const ID = 'c82b9698e5ac';
export const ID2 = 'c8934683def0';

/** A fan of generation 3 (breeze, relative timers) with a light kit, as the WAC reference shows it. */
export function fan({ id = ID, light = true, wind = true, name = 'Living Room' } = {}) {
  const state = {
    clientId: `MF_${id.toUpperCase()}`,
    fanOn: false,
    fanSpeed: 3,
    fanDirection: 'forward',
    rfPairModeActive: false,
    resetRfPairList: false,
    factoryReset: false,
    awayModeEnabled: false,
    fanTimer: 0,
    decommission: false,
    schedule: '',
    adaptiveLearning: false,
    userData: 'local_wifi',
  };
  if (light) Object.assign(state, { lightOn: false, lightBrightness: 50, lightTimer: 0 });
  if (wind) Object.assign(state, { wind: false, windSpeed: 2 });
  return {
    state,
    info: {
      clientId: state.clientId,
      mac: id.match(/../g).join(':').toUpperCase(),
      lightType: light ? 'F4IN-120V-R1-30' : '',
      fanType: '2006-52',
      fanMotorType: 'DC156X08',
      brand: 1,
      dateCode: '2022-11-17',
      owner: 'someone@example.com',
      federatedIdentity: 'us-east-1:00000000-0000-0000-0000-000000000000',
      deviceName: name,
      firmwareVersion: '02.00.0043',
      mainMcuFirmwareVersion: '03.00.0000',
      firmwareUrl: '',
    },
    down: false,
    hang: false,
    deaf: false,
    status: undefined,
    latency: 20,
    noId: false,
  };
}

const COMMAND_KEYS = [
  'fanOn',
  'fanSpeed',
  'fanDirection',
  'wind',
  'windSpeed',
  'lightOn',
  'lightBrightness',
];

export function fakeFans(fans = { [`${ADDRESS}:80`]: fan() }) {
  const world = {
    clock: undefined,
    fans,
    requests: [],
    inFlight: 0,
    peak: 0,
    /** One answer forced per request (a function of the request, or { status, json, raw }). */
    queue: [],
    sleep(ms) {
      return new Promise((resolve) => world.clock.timers.setTimeout(resolve, ms));
    },
    transport: (options, hooks) => transport(world, options, hooks),
    fan: (address = `${ADDRESS}:80`) => world.fans[address],
    writes: (address) =>
      world.requests.filter(
        (r) => r.sentAt !== undefined && isWrite(r.body) && (!address || r.address === address),
      ),
    reads: (address) =>
      world.requests.filter(
        (r) => r.sentAt !== undefined && !isWrite(r.body) && (!address || r.address === address),
      ),
  };
  return world;
}

export const isWrite = (body) => COMMAND_KEYS.some((k) => k in (body ?? {}));

const json = (body, status = 200) => ({ status, body: Buffer.from(JSON.stringify(body), 'utf8') });

async function transport(world, options, { monotonic, deadline, beforeSend, onSent, onStart }) {
  const address = `${options.hostname}:${options.port}`;
  const record = { address, path: options.path, body: options.body, at: monotonic() };
  world.requests.push(record);
  world.inFlight += 1;
  world.peak = Math.max(world.peak, world.inFlight);
  let sent = false;
  let cut;
  const cutPromise = new Promise((_, reject) => {
    cut = () => reject(new FanError('cut', 'cut by an Off', { sent }));
  });
  cutPromise.catch(() => {});
  onStart?.(() => cut());
  try {
    const target = world.fans[address];
    await Promise.race([world.sleep(1), cutPromise]);
    if (deadline !== undefined && monotonic() >= deadline) {
      throw new FanError('late', 'no time left to send');
    }
    if (!target || target.down) {
      throw new FanError('network', 'connection refused', { reason: 'ECONNREFUSED' });
    }
    beforeSend?.();
    if (deadline !== undefined && monotonic() >= deadline) {
      throw new FanError('late', 'no time left to send');
    }
    sent = true;
    onSent?.();
    record.sentAt = monotonic();
    const answer = respond(world, target, record);
    const latency = typeof target.latency === 'function' ? target.latency(record) : target.latency;
    const wait = target.hang ? Infinity : latency;
    const left = deadline === undefined ? Infinity : deadline - monotonic();
    const outcome = await Promise.race([
      world.sleep(Math.min(wait, left)).then(() => (wait >= left ? 'timeout' : 'ok')),
      cutPromise,
    ]);
    if (outcome === 'timeout') throw new FanError('timeout', 'no answer in time', { sent: true });
    record.end = monotonic();
    return answer;
  } finally {
    world.inFlight -= 1;
  }
}

function respond(world, target, record) {
  let next = world.queue.shift();
  if (typeof next === 'function') next = next(record);
  if (next) return next.raw ?? json(next.json ?? {}, next.status ?? 200);
  if (target.status) return json({ message: 'error' }, target.status);
  if (record.path !== '/mf') return json({}, 404);
  const body = record.body ?? {};
  const strip = (s) => {
    if (!target.noId) return s;
    const { clientId: _drop, ...rest } = s;
    return rest;
  };
  if (body.queryStaticShadowData) return json(strip({ ...target.info }));
  if (!target.deaf) {
    const apply = () => {
      for (const key of COMMAND_KEYS) {
        if (key in body && key in target.state) target.state[key] = body[key];
      }
    };
    const delay = typeof target.applyDelay === 'function' ? target.applyDelay(record) : 0;
    // A fan that acts later than it answers (or whose answer is cut): applied late.
    if (delay > 0) world.sleep(delay).then(apply);
    else apply();
  }
  return json(strip({ ...target.state }));
}
