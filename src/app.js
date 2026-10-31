// -----------------------------------------------------------------------------
// The fans of the configuration, read every poll interval through their local
// HTTP API (`POST /mf`, one lane of requests per address); one Gladys device
// per fan, keyed by its `clientId`; the commands; the "Test the connection"
// button. index.js only wires the SDK handlers (src/handlers.js).
//
// Identity: every answer carries the `clientId` of the fan. A read at an
// address tells which fan is there (`seen`); a device drives only its own fan:
//   - a non-protective command reads the fan first (a read that leaves after
//     the click, shared by the commands of a scene) and is written only if
//     that read shows the fan of the device, at an address of the
//     configuration;
//   - an Off goes to the address the fan was last read at (this session,
//     /data, the `address` param of the device, or the only address typed),
//     whatever is not known, unless another fan answered last at that address.
//
// Offs (fan speed 0, light 0, brightness 0) are protective: never refused by
// a pause, the queue, a read, a command in progress, the configuration not
// read yet (when the address is known), nor before the first read. Clicked,
// they cancel the commands of the same part still waiting (and stop one
// taken from the queue right before its first byte), cut the request in
// flight to that fan but another Off, are tried again for 250 ms, then kept
// (a guard, in /data) and sent again as soon as the lane is free and by the
// reads that contradict them (3 times at most, counted only when they left).
// A guard is lifted by a later command that starts the same part and left
// (not one the fan refused), by another Off, by the device deleted, or once
// a read showed it applied, by the part read on twice in a row (the remote,
// the app); never by the time. At start, the guards not yet seen applied are
// sent before the configuration is read and before the first read.
//
// Pace: one read per interval per address, whatever asks (a reconnection, a
// save of the form, the test button, Discover, a restart: the time of the
// attempt is put in /data before the read). Failed reads pause 10 s, 30 s, 1,
// 2 then 5 min (a minute at least on 429 / 503), the pause in /data. Answers
// are applied in the order their requests left, never the order they come
// back. Two clocks: `now` (wall) dates /data only; `monotonic` paces the
// reads, pauses, deadlines and the publication budget.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressOf, normalizeConfig } from './config.js';
import { FEATURES as F, LIMITS, PARTS, TIMINGS } from './constants.js';
import { buildDevice, paramAddress, parseExternalId } from './devices.js';
import { FanClient, PRIORITY } from './fan/client.js';
import { FanError, errorReason } from './fan/http.js';
import {
  commandOf,
  integerOf,
  parseInfo,
  parseState,
  partOn,
  shows,
  validBody,
  valuesOf,
} from './fan/model.js';
import {
  ERRORS,
  PART_NAMES,
  T,
  age,
  both,
  fanName,
  reasonOf,
  shortId,
  summaryOf,
  word,
} from './i18n.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, normalizeMemory } from './store.js';

const gkOf = (id, part) => `${id}:${part}`;
/** The body of an Off. */
const offBody = (part) => (part === PARTS.FAN ? { fanOn: false } : { lightOn: false });
/** Does this body start the part (lifting its guard once it left)? */
const starts = (body) => body.fanOn === true || body.lightOn === true;
/** A status is cut to this length (Gladys shows one block). */
const STATUS_MAX = 900;

export class App {
  constructor({
    gladys,
    logger = createLogger({ name: 'modern-forms' }),
    transport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
    publisher,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.transport = transport;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.publisher = publisher ?? new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.configLoaded = false;
    this.configTries = 0;
    this.configTimer = undefined;
    this.configGeneration = 0;
    this.configLoading = undefined;
    this.lastConfigAsk = -Infinity;
    this.memory = emptyMemory();
    this.memoryLoaded = false;
    this.memoryLoading = undefined;
    this.storeUnreadable = false;
    this.saveFailed = false;
    this.saving = undefined;
    this.saveTickets = 0;
    this.storeReading = undefined;
    /** address key -> FanClient (one lane per address, kept across sessions). */
    this.lanes = new Map();
    /** address key -> the polled link of this session (the addresses typed). */
    this.links = new Map();
    /** address key -> { id, at }: the fan of the last answer applied there (at: when it left). */
    this.seen = new Map();
    /** address key -> { lastReadAt, pause, failures, lastReason, offline }. */
    this.pace = new Map();
    /** id -> { id, address, state, at, info, infoAt }: the fans read by this process. */
    this.fans = new Map();
    /** `${id}:${part}` -> guard of an Off. */
    this.guards = new Map();
    /** `${id}:${part}` -> the last write starting that part that left: { sentAt, answered }. */
    this.lastWrites = new Map();
    /** address key -> { state, at, generation }: the last read applied there. */
    this.lastRead = new Map();
    this.probeTimer = undefined;
    this.seq = 0;
    this.generation = 0;
    this.started = false;
    this.ready = false;
    this.readyWaiters = new Set();
    this.lifecycle = Promise.resolve();
    this.configSeq = 0;
    this.keptSent = false;
    this.followUps = new Set();
    this.lastStatus = undefined;
    this.published = undefined;
    this.stopped = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Connected to Gladys (each time): /data read (once), the Offs it holds sent, then the
   * configuration read (`load`, the SDK's getConfig), read again on failure (5 s, 15 s, then
   * every minute) with a status saying so.
   */
  async onConnected(load) {
    this.configLoader = load;
    this.publisher.start();
    await this.ensureMemory();
    this.sendKept();
    this.configTries = 0;
    this.clearConfigTimer();
    await this.loadConfig();
  }

  loadConfig() {
    if (!this.configLoading) {
      this.configLoading = this.loadConfigNow().finally(() => {
        this.configLoading = undefined;
      });
    }
    return this.configLoading;
  }

  /** A command came before the configuration: read it now, or 2 s after the last read at most. */
  askConfig() {
    if (!this.configLoader || this.configLoading) return;
    const wait = Math.max(0, this.lastConfigAsk + TIMINGS.configAskGap - this.monotonic());
    this.clearConfigTimer();
    this.configTimer = this.timers.setTimeout(() => {
      this.configTimer = undefined;
      return this.loadConfig().catch(() => {});
    }, wait);
  }

  async loadConfigNow() {
    const generation = ++this.configGeneration;
    this.lastConfigAsk = this.monotonic();
    let raw;
    try {
      raw = await this.configLoader();
    } catch (err) {
      if (generation !== this.configGeneration) return;
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger.warn(
        `modern-forms: configuration not read (${err?.name ?? 'Error'}); new try in ${Math.round(wait / 1000)} s`,
      );
      this.clearConfigTimer();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.loadConfig().catch(() => {});
      }, wait);
      // Not awaited: a slow Gladys never delays the next read of the configuration.
      this.setStatus(false, T.configNotRead(age(wait))).catch(() => {});
      return;
    }
    if (generation !== this.configGeneration) return;
    this.configTries = 0;
    await this.connected(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** The configuration read at a connection to Gladys (a reconnection resends what Gladys forgot). */
  connected(raw = {}) {
    return this.enqueue(raw, true);
  }

  /** A configuration saved by the user. */
  configUpdated(raw = {}) {
    return this.enqueue(raw, false);
  }

  /** One configuration at a time, in order; one superseded by a newer one still waiting is skipped. */
  enqueue(raw, reconnection) {
    const seq = ++this.configSeq;
    const job = async () => {
      if (seq === this.configSeq) {
        await this.startSession(raw);
      }
      if (reconnection) {
        this.gladys.forgetPublishedStates?.();
        this.published = undefined;
        const status = this.lastStatus;
        this.lastStatus = undefined;
        if (status) {
          const [connected, message] = JSON.parse(status);
          await this.setStatus(connected, message ?? undefined);
        }
        await this.publishDevices();
      }
    };
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch((err) =>
      this.logger.error(`modern-forms: configuration not applied (${err?.name ?? 'Error'})`),
    );
    return this.lifecycle;
  }

  /** A session: the links of the addresses typed; the lanes, pace, guards and fans are kept. */
  async startSession(raw) {
    await this.ensureMemory();
    this.stopLinks();
    const generation = this.generation;
    this.config = normalizeConfig(raw);
    this.configLoaded = true;
    this.started = true;
    for (const [order, address] of this.config.addresses.entries()) {
      this.links.set(address.key, {
        key: address.key,
        order,
        timer: undefined,
        round: undefined,
        commands: [],
        serving: undefined,
        fresh: undefined,
        generation,
      });
      this.paceOf(address.key);
    }
    this.setReady();
    await this.refreshStatus();
    await this.publishDevices();
    if (generation !== this.generation) return;
    for (const link of this.links.values()) this.tick(link);
  }

  setReady() {
    this.ready = true;
    for (const resolve of this.readyWaiters) resolve(true);
    this.readyWaiters.clear();
  }

  /** Resolves true once a session started, false at `deadline` (monotonic). */
  waitReady(deadline) {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => {
        this.timers.clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = this.timers.setTimeout(
        () => done(false),
        Math.max(0, deadline - this.monotonic()),
      );
      this.readyWaiters.add(done);
    });
  }

  /** Ends the links of the session: timers, follow-ups, commands waiting. */
  stopLinks() {
    this.generation += 1;
    for (const link of this.links.values()) {
      if (link.timer !== undefined) this.timers.clearTimeout(link.timer);
      for (const job of link.commands.splice(0)) job.reject(this.refusal(ERRORS.restarting));
    }
    this.links.clear();
    for (const timer of this.followUps) this.timers.clearTimeout(timer);
    this.followUps.clear();
  }

  stop() {
    this.stopped = true;
    this.configGeneration += 1;
    this.clearConfigTimer();
    this.stopLinks();
    this.publisher.stop();
    if (this.probeTimer !== undefined) this.timers.clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    for (const lane of this.lanes.values()) lane.close();
    this.lanes.clear();
  }

  /** The container stops: /data written (bounded), then every timer and lane. */
  async shutdown() {
    this.configGeneration += 1;
    this.clearConfigTimer();
    this.stopLinks();
    await this.saveMemory();
    this.stop();
  }

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  laneOf(key) {
    let lane = this.lanes.get(key);
    if (!lane) {
      const address = addressOf(key);
      lane = new FanClient({
        host: address.host,
        port: address.port,
        transport: this.transport,
        monotonic: this.monotonic,
        timers: this.timers,
      });
      this.lanes.set(key, lane);
    }
    return lane;
  }

  // --- /data -------------------------------------------------------------------

  /**
   * `{ value }` once `promise` settles within `ms`, `{ late: true }` otherwise (it keeps
   * running, its outcome then ignored).
   */
  bounded(promise, ms = TIMINGS.storeWait) {
    let timer;
    return Promise.race([
      promise.then((value) => ({ value })),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve({ late: true }), Math.max(0, ms));
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  /** One read of /data at a time, waited TIMINGS.storeWait at most from its start. */
  loadStore() {
    let entry = this.storeReading;
    if (!entry) {
      let promise;
      try {
        promise = Promise.resolve(this.store.load());
      } catch (err) {
        promise = Promise.reject(err);
      }
      entry = { at: this.monotonic(), promise };
      this.storeReading = entry;
      promise
        .catch(() => {})
        .finally(() => {
          if (this.storeReading === entry) this.storeReading = undefined;
        });
    }
    const left = entry.at + TIMINGS.storeWait - this.monotonic();
    if (left <= 0) return Promise.resolve({ late: true });
    return this.bounded(entry.promise, left);
  }

  /** /data read once (bounded): unreadable is not empty, nothing is written over it. */
  ensureMemory() {
    if (this.memoryLoaded) return Promise.resolve();
    this.memoryLoading ??= (async () => {
      let loaded = null;
      try {
        const answer = await this.loadStore();
        if (answer.late) throw Object.assign(new Error('no answer'), { code: 'timeout' });
        loaded = answer.value;
        this.storeUnreadable = false;
      } catch (err) {
        this.storeUnreadable = true;
        this.logger.warn(`modern-forms: /data unreadable (${err?.code ?? err?.name ?? 'error'})`);
      }
      this.adoptMemory(normalizeMemory(loaded, this.now()));
      this.memoryLoaded = true;
    })().finally(() => {
      this.memoryLoading = undefined;
    });
    return this.memoryLoading;
  }

  /** What /data holds, merged with what this process already knows (which wins). */
  adoptMemory(saved) {
    const kept = this.memory;
    this.memory = saved;
    for (const [id, entry] of Object.entries(kept.fans)) this.memory.fans[id] = entry;
    for (const [key, entry] of Object.entries(kept.links)) this.memory.links[key] = entry;
    const mono = this.monotonic();
    for (const g of saved.guards) {
      const gk = gkOf(g.id, g.part);
      if (!this.guards.has(gk)) this.guards.set(gk, this.makeGuard(g, mono));
    }
  }

  /** /data reads again after it could not be read; true once it reads. */
  async reloadMemory() {
    let answer;
    try {
      answer = await this.loadStore();
    } catch {
      return false;
    }
    if (answer.late) return false;
    if (!this.storeUnreadable) return true;
    this.storeUnreadable = false;
    this.adoptMemory(normalizeMemory(answer.value, this.now()));
    this.logger.info('modern-forms: /data reads again');
    this.refreshStatus().catch(() => {});
    return true;
  }

  /** The guards and the pace into the memory written to /data. */
  syncMemory() {
    const now = this.now();
    const mono = this.monotonic();
    for (const [key, pace] of this.pace) {
      const entry = (this.memory.links[key] ??= {});
      if (pace.lastReadAt !== undefined) entry.lastAttemptAt = now - (mono - pace.lastReadAt);
      if (pace.pause && pace.pause.due > mono) {
        entry.pause = {
          until: now + (pace.pause.due - mono),
          failures: pace.failures,
          code: pace.pause.code,
        };
      } else {
        delete entry.pause;
      }
    }
    const trim = (object) => {
      const keys = Object.keys(object);
      for (const key of keys.slice(0, Math.max(0, keys.length - LIMITS.remembered))) {
        delete object[key];
      }
    };
    trim(this.memory.links);
    trim(this.memory.fans);
    this.memory.guards = [...this.guards.values()].slice(0, LIMITS.guards).map((g) => ({
      id: g.id,
      part: g.part,
      address: g.address,
      resends: g.resends,
      confirmed: g.confirmed,
      left: g.left,
      ...(g.other !== undefined ? { other: g.other } : {}),
    }));
  }

  /**
   * true when /data holds the state of now. Bounded: one save at a time, waited
   * TIMINGS.storeWait at most; a save that hangs is never stacked on. Taken from
   * gladys-ipx800 0.1.3.
   */
  async saveMemory() {
    if (!this.memoryLoaded) return false;
    if (this.storeUnreadable && !(await this.reloadMemory())) return false;
    const ticket = ++this.saveTickets;
    for (;;) {
      const entry = this.saving ?? this.startSave();
      const left = entry.at + TIMINGS.storeWait - this.monotonic();
      if (left <= 0) return this.storeFailed({ code: 'timeout' });
      const answer = await this.bounded(entry.done, left);
      if (answer.late) return this.storeFailed({ code: 'timeout' });
      if (entry.ticket >= ticket) {
        return answer.value === true ? this.storeWritten() : this.storeFailed(answer.value);
      }
    }
  }

  startSave() {
    this.syncMemory();
    let promise;
    try {
      promise = Promise.resolve(this.store.save(this.memory));
    } catch (err) {
      promise = Promise.reject(err);
    }
    const entry = { at: this.monotonic(), ticket: this.saveTickets };
    entry.done = promise
      .then(
        () => true,
        (err) => err ?? { code: 'error' },
      )
      .finally(() => {
        if (this.saving !== entry) return;
        this.saving = undefined;
        if (this.saveTickets > entry.ticket) this.saveMemory().catch(() => {});
      });
    this.saving = entry;
    return entry;
  }

  storeWritten() {
    if (this.saveFailed) {
      this.saveFailed = false;
      this.logger.info('modern-forms: /data written again');
      this.refreshStatus().catch(() => {});
    }
    return true;
  }

  storeFailed(err) {
    if (!this.saveFailed) {
      this.saveFailed = true;
      this.logger.warn(
        `modern-forms: saving the state to /data failed (${err?.code ?? err?.name ?? 'error'})`,
      );
      this.refreshStatus().catch(() => {});
    }
    return false;
  }

  /** Saved without waiting (an Off never waits for the disk). */
  saveSoon() {
    this.saveMemory().catch(() => {});
  }

  // --- Pace --------------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  /** The pace of an address, from /data the first time (wall clock -> monotonic). */
  paceOf(key) {
    let pace = this.pace.get(key);
    if (!pace) {
      pace = { lastReadAt: undefined, pause: undefined, failures: 0, lastReason: undefined };
      const saved = this.memory.links[key];
      const now = this.now();
      const mono = this.monotonic();
      if (saved?.lastAttemptAt !== undefined) pace.lastReadAt = mono - (now - saved.lastAttemptAt);
      if (saved?.pause && saved.pause.until > now) {
        pace.pause = {
          due: mono + Math.min(saved.pause.until - now, TIMINGS.pauseMax),
          code: saved.pause.code,
        };
        pace.failures = saved.pause.failures;
        pace.offline = true;
      }
      this.pace.set(key, pace);
    }
    return pace;
  }

  /** The rest of the pause (ms), capped at every use; 0 when none. */
  pauseLeft(pace, mono) {
    if (!pace.pause) return 0;
    return Math.min(Math.max(0, pace.pause.due - mono), TIMINGS.pauseMax);
  }

  /** The monotonic time from which the next read of an address may start. */
  dueAt(pace, mono) {
    const due = pace.lastReadAt === undefined ? mono : pace.lastReadAt + this.interval;
    return Math.max(due, mono + this.pauseLeft(pace, mono));
  }

  schedule(link) {
    if (link.timer !== undefined) this.timers.clearTimeout(link.timer);
    link.timer = undefined;
    if (link.generation !== this.generation) return;
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(this.paceOf(link.key), mono) - mono);
    link.timer = this.timers.setTimeout(() => {
      link.timer = undefined;
      this.tick(link);
    }, wait);
  }

  /** A read of the link when it is due (never sooner than the interval). */
  tick(link) {
    if (link.generation !== this.generation) return undefined;
    if (link.round) return link.round;
    const pace = this.paceOf(link.key);
    const mono = this.monotonic();
    if (this.dueAt(pace, mono) > mono) {
      this.schedule(link);
      return undefined;
    }
    // The attempt goes to /data before the read (a restart never reads sooner); not awaited.
    pace.lastReadAt = mono;
    this.saveSoon();
    link.round = this.readRound(link).finally(() => {
      link.round = undefined;
      this.schedule(link);
    });
    return link.round;
  }

  async readRound(link) {
    const pace = this.paceOf(link.key);
    try {
      const { state } = await this.readKey(link.key, PRIORITY.READ);
      if (link.generation !== this.generation) return;
      const failed = pace.failures > 0 || pace.offline;
      pace.failures = 0;
      pace.pause = undefined;
      pace.offline = false;
      pace.lastReason = undefined;
      if (failed) this.saveSoon();
      if (state.id) await this.readInfo(link, state.id);
    } catch (err) {
      if (link.generation !== this.generation) return;
      this.failed(link.key, err);
    }
    await this.refreshStatus();
    await this.publishDevices();
    await this.flush();
  }

  /** A failed read: a pause, kept in /data (a read cut by an Off is no failure). */
  failed(key, err) {
    if (err instanceof FanError && err.code === 'cut') return;
    const pace = this.paceOf(key);
    pace.failures += 1;
    let wait = TIMINGS.backoff[Math.min(pace.failures - 1, TIMINGS.backoff.length - 1)];
    const code = err instanceof FanError && err.code === 'busy' ? 'busy' : 'failed';
    if (code === 'busy') wait = Math.max(wait, TIMINGS.busyPause);
    pace.pause = { due: this.monotonic() + Math.min(wait, TIMINGS.pauseMax), code };
    pace.offline = true;
    pace.lastReason = reasonOf(err);
    this.logger.warn(`modern-forms: ${key} not read: ${errorReason(err)}`);
    this.saveSoon();
  }

  /** The information of a fan (name, model): a secondary read, never blocking, never a pause. */
  async readInfo(link, id) {
    const fan = this.fans.get(id);
    const mono = this.monotonic();
    if (!fan || (fan.info && mono - fan.infoAt < TIMINGS.infoEvery)) return;
    fan.infoAt = mono;
    try {
      const info = parseInfo(await this.laneOf(link.key).readInfo(PRIORITY.READ));
      if (info.id === id) fan.info = info;
    } catch (err) {
      this.logger.debug?.(
        `modern-forms: information of ${shortId(id)} not read: ${errorReason(err)}`,
      );
    }
  }

  /**
   * A read of the state at an address: `{ state, at }` (at: when it left); applied in the
   * order the requests left.
   */
  async readKey(key, priority, deadline, onSent) {
    let at;
    const json = await this.laneOf(key).readState(priority, {
      deadline,
      onSent: () => {
        at = this.monotonic();
        onSent?.(at);
      },
    });
    const state = parseState(json);
    if (this.applyAnswer(key, state, at, { judge: true })) {
      this.lastRead.set(key, { state, at, generation: this.generation });
    }
    return { state, at };
  }

  // --- What an answer changes ----------------------------------------------------------

  /**
   * An answer of the fan at `key` (a read, or the answer of a command), whose request left at
   * `at`: which fan is there, its states, the guards checked. An answer whose request left
   * before the last one applied there is dropped (applied in the order they left).
   */
  applyAnswer(key, state, at, { judge = false } = {}) {
    const last = this.seen.get(key);
    if (last && !(at > last.at)) return false;
    this.seen.set(key, { id: state.id, at });
    if (!state.id) return true;
    const fan = this.fans.get(state.id) ?? { id: state.id };
    fan.state = state;
    fan.at = at;
    if (fan.address !== key) {
      fan.address = key;
      if (this.memory.fans[state.id]?.address !== key) {
        delete this.memory.fans[state.id];
        this.memory.fans[state.id] = { address: key };
        this.saveSoon();
      }
    }
    this.fans.set(state.id, fan);
    // Only a read judges the guards: the answer of a write (another part, a command) never does.
    if (judge) {
      for (const part of Object.values(PARTS)) {
        const guard = this.guards.get(gkOf(state.id, part));
        if (!guard) continue;
        if (guard.address !== key) {
          // The fan moved (DHCP): its Off follows it.
          guard.address = key;
          this.saveSoon();
        }
        if (!guard.inFlight && at > guard.sentAt) this.checkGuard(guard, partOn(state, part), at);
      }
    }
    if (this.publishingKey(state.id) === key) this.queueStates(state.id, state);
    return true;
  }

  /** The address whose reads are published for a fan: the first link of the configuration showing it. */
  publishingKey(id) {
    for (const link of this.links.values()) {
      if (this.seen.get(link.key)?.id === id) return link.key;
    }
    return undefined;
  }

  /** Another fan answered last at `key` (an unreadable answer proves nothing). */
  provenOther(key, id) {
    const seen = this.seen.get(key)?.id;
    return seen !== undefined && seen !== id;
  }

  /** The address of a fan: this session, this process, /data, the device param, the only address typed. */
  locate(id, device) {
    const session = this.publishingKey(id);
    if (session) return session;
    const known = this.fans.get(id)?.address ?? this.memory.fans[id]?.address;
    if (known) return known;
    const param = paramAddress(device);
    if (param && addressOf(param)) return param;
    if (this.configLoaded && this.config.addresses.length === 1) {
      return this.config.addresses[0].key;
    }
    return undefined;
  }

  // --- Guards (the Offs held) -------------------------------------------------------

  makeGuard(
    {
      id,
      part,
      address,
      resends = 0,
      confirmed = false,
      other,
      seq = 0,
      inFlight = false,
      left = false,
    },
    mono = this.monotonic(),
  ) {
    return {
      id,
      part,
      address,
      resends,
      confirmed,
      other,
      seq,
      // Ever left (the first send is not a resend); its last send left without an answer.
      left,
      unanswered: false,
      sentAt: -Infinity,
      inFlight,
      userInFlight: inFlight,
      stale: this.mayLand(gkOf(id, part), mono),
    };
  }

  /** Our last write starting the part, if it left less than a request time ago without an answer. */
  mayLand(gk, mono) {
    const write = this.lastWrites.get(gk);
    if (!write || write.answered) return undefined;
    return mono - write.sentAt < TIMINGS.requestTimeout ? write : undefined;
  }

  /** A guard against the on / off of its part, read by a request that left at `at` after its last send. */
  checkGuard(guard, on, at) {
    if (on === undefined) return; // unknown is never "changed elsewhere"
    const gk = gkOf(guard.id, guard.part);
    const stale = guard.stale?.answered ? undefined : guard.stale;
    if (on === false) {
      const changed = !guard.confirmed || guard.other !== undefined;
      guard.confirmed = true;
      guard.other = undefined;
      // Seen applied: nothing left for the probe (a lost answer no longer matters).
      guard.unanswered = false;
      if (!stale || at > stale.sentAt + TIMINGS.requestTimeout) guard.stale = undefined;
      if (changed) this.saveSoon();
      return;
    }
    if (stale) {
      // Our own older command handled late: contradicted, never "changed elsewhere".
      guard.stale = undefined;
      guard.confirmed = false;
      guard.other = undefined;
    }
    if (guard.confirmed) {
      if (guard.other === true) {
        // Read on twice in a row after it was seen applied: started from the remote or the app.
        this.guards.delete(gk);
        this.logger.info(
          `modern-forms: ${shortId(guard.id)} ${guard.part} started elsewhere, Off no longer held`,
        );
      } else {
        guard.other = true;
      }
      this.saveSoon();
      return;
    }
    // One resend per read interval (10 s at most) : never a burst of the 3 within a few reads.
    if (
      guard.resends < TIMINGS.resendMax &&
      this.monotonic() - guard.sentAt >= Math.min(this.interval, TIMINGS.guardProbe)
    ) {
      this.resendGuard(guard);
    }
  }

  /** An Off held that never left, or whose last send got no answer: the probe sends it. */
  pending(guard) {
    // Never given up: a refusal, a cut or no answer is no try (only an answer still showing the
    // part on counts, see resendGuard).
    return !guard.confirmed && (!guard.left || guard.unanswered);
  }

  /**
   * The probe of the Offs held not yet answered: every TIMINGS.guardProbe, whatever the pause
   * of the reads, one Off per address (the others of that address right behind its answer).
   * An Off waits no read after its fan comes back.
   */
  armProbe() {
    if (this.probeTimer !== undefined || this.stopped) return;
    if (![...this.guards.values()].some((g) => this.pending(g))) return;
    this.probeTimer = this.timers.setTimeout(() => {
      this.probeTimer = undefined;
      this.probe();
    }, TIMINGS.guardProbe);
  }

  probe() {
    const sent = new Set();
    for (const guard of this.guards.values()) {
      if (!this.pending(guard) || guard.inFlight || sent.has(guard.address)) continue;
      sent.add(guard.address);
      this.resendGuard(guard);
    }
    this.armProbe();
  }

  /** At start (once): the guards of /data not seen applied, before the configuration and the first read. */
  sendKept() {
    if (this.keptSent) return;
    this.keptSent = true;
    for (const guard of this.guards.values()) {
      if (!guard.confirmed && guard.resends < TIMINGS.resendMax) this.resendGuard(guard);
    }
    this.armProbe();
  }

  /** Sends a guard again (no ack): counted when it leaves; cut before its first byte, sent right behind. */
  resendGuard(
    guard,
    priority = PRIORITY.GUARD,
    deadline = this.monotonic() + TIMINGS.requestTimeout,
  ) {
    const gk = gkOf(guard.id, guard.part);
    if (guard.inFlight || this.guards.get(gk) !== guard || this.stopped) return;
    if (this.provenOther(guard.address, guard.id)) return; // kept: sent when the fan is found
    guard.inFlight = true;
    const key = guard.address;
    let again = false;
    let at;
    let resend = false;
    this.laneOf(key)
      .write(offBody(guard.part), priority, {
        deadline,
        beforeSend: () => {
          if (this.guards.get(gk) !== guard) throw new FanError('late', 'superseded');
          if (this.provenOther(key, guard.id)) throw new FanError('late', 'another fan');
        },
        onSent: () => {
          // A resend when it left before; counted only once the fan answered it (below).
          resend = guard.left;
          guard.left = true;
          at = this.monotonic();
          guard.sentAt = at;
        },
      })
      .then((json) => {
        guard.unanswered = false;
        const state = parseState(json);
        // Its own answer judges this guard only (never the guard of the other part).
        this.applyAnswer(key, state, at);
        if (state.id === guard.id && partOn(state, guard.part) === false) {
          guard.confirmed = true;
          guard.other = undefined;
        } else if (resend && state.id === guard.id && partOn(state, guard.part) === true) {
          // Accepted by the fan and still on: a try without effect, counted (3 at most).
          guard.resends += 1;
        }
        // The fan answers again: the other Offs held for it go now.
        for (const other of this.guards.values()) {
          if (other !== guard && other.address === key && this.pending(other)) {
            this.resendGuard(other);
          }
        }
      })
      .catch((err) => {
        if (err instanceof FanError && err.sent) {
          // A refusal (429, 5xx), a cut or no answer: no try; the probe sends it again.
          guard.unanswered = true;
        }
        again = err instanceof FanError && err.code === 'cut' && !err.sent;
        this.logger.warn(
          `modern-forms: Off of ${shortId(guard.id)} sent again: ${errorReason(err)}`,
        );
      })
      .finally(() => {
        guard.inFlight = false;
        if (again && this.guards.get(gk) === guard) {
          this.resendGuard(guard, priority, deadline);
          return;
        }
        this.saveSoon();
        this.armProbe();
        this.refreshStatus().catch(() => {});
      });
  }

  // --- Commands --------------------------------------------------------------------

  /** A command from Gladys. */
  async setValue(device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const parsed = parseExternalId(feature?.external_id, this.gladys.selector);
    if (!parsed?.key) throw this.refusal(ERRORS.notCommandable);
    const command = commandOf(parsed.key, integerOf(value));
    if (!command) throw this.refusal(ERRORS.badValue);
    if (command.protective) return this.protective(parsed.id, command, received, device);
    if (!this.ready) {
      if (!this.configLoaded) this.askConfig();
      if (!(await this.waitReady(received + TIMINGS.configWait))) {
        throw this.refusal(ERRORS.configNotLoaded);
      }
    }
    const key = this.locate(parsed.id, device);
    const link = key && this.links.get(key);
    if (!link) throw this.refusal(key ? ERRORS.notConfigured : ERRORS.addressUnknown);
    this.checkNotPaused(key, received);
    const guard = this.guards.get(gkOf(parsed.id, command.part));
    if (guard?.userInFlight) throw this.refusal(ERRORS.stopPending);
    if (link.commands.length >= LIMITS.commandQueue) throw this.refusal(ERRORS.queueFull);
    const ahead = link.commands.length + (link.serving ? 1 : 0);
    return new Promise((resolve, reject) => {
      link.commands.push({
        id: parsed.id,
        key: parsed.key,
        ...command,
        received,
        ahead,
        seq: this.seq,
        resolve,
        reject,
      });
      this.serve(link);
    });
  }

  checkNotPaused(key, mono) {
    const pace = this.paceOf(key);
    const left = this.pauseLeft(pace, mono);
    if (left > 0) {
      throw this.refusal(
        ERRORS.paused(
          pace.lastReason ?? both('earlier reads failed', 'les lectures précédentes ont échoué'),
          age(left),
        ),
      );
    }
  }

  serve(link) {
    if (link.serving) return link.serving;
    link.serving = (async () => {
      while (link.commands.length > 0) {
        const job = link.commands.shift();
        try {
          job.resolve(await this.command(link, job));
        } catch (err) {
          job.reject(err);
        }
      }
    })().finally(() => {
      link.serving = undefined;
      if (link.commands.length > 0 && link.generation === this.generation) this.serve(link);
    });
    return link.serving;
  }

  /** The checks right before a non-protective command (or its read) leaves. */
  checkBeforeSend(job, link) {
    if (link.generation !== this.generation || this.links.get(link.key) !== link) {
      throw this.refusal(ERRORS.restarting);
    }
    const guard = this.guards.get(gkOf(job.id, job.part));
    if (guard && (guard.userInFlight || guard.seq > job.seq)) {
      throw this.refusal(ERRORS.cancelledByStop);
    }
    const mono = this.monotonic();
    this.checkNotPaused(link.key, mono);
    if (mono >= job.received + TIMINGS.commandSendBy) throw this.refusal(ERRORS.late(job.ahead));
  }

  /** A read that leaves after `after` (shared by the commands waiting for one), at command priority. */
  freshRead(link, after, deadline) {
    // A read already answered that left after the command arrived: shared (a scene on one fan
    // is one read, then its writes).
    const last = this.lastRead.get(link.key);
    if (last && last.generation === this.generation && last.at > after) {
      return Promise.resolve({ state: last.state, at: last.at });
    }
    const job = link.fresh;
    if (job && job.generation === this.generation && (!job.started || job.sentAt > after)) {
      return job.promise;
    }
    const next = { started: false, sentAt: undefined, generation: this.generation };
    next.promise = this.readKey(link.key, PRIORITY.COMMAND, deadline, (at) => {
      next.started = true;
      next.sentAt = at;
    });
    next.promise
      .catch(() => {})
      .finally(() => {
        if (link.fresh === next) link.fresh = undefined;
      });
    link.fresh = next;
    return next.promise;
  }

  /** The fan read shows the fan of the command, with the part it drives. */
  checkTarget(job, state, link) {
    if (state.id !== job.id) {
      throw this.refusal(state.id ? ERRORS.otherFan(link.key) : ERRORS.noIdentity(link.key));
    }
    if (
      (job.part === PARTS.LIGHT && !state.light.present) ||
      (job.key === F.WIND && !state.fan.hasWind)
    ) {
      throw this.refusal(ERRORS.notSupported);
    }
  }

  /** What the answer of a write says to one command of it: undefined (done) or the error. */
  outcomeOf(job, state, key) {
    if (state.id !== job.id) {
      return this.refusal(state.id ? ERRORS.answeredByOther(key) : ERRORS.unconfirmed);
    }
    const done = shows(state, job.body);
    if (done === true) return undefined;
    return this.refusal(done === false ? ERRORS.notApplied : ERRORS.unconfirmed);
  }

  /**
   * A non-protective command in its turn: the fan read (its identity), then the write. The
   * commands of the same fan waiting that this read serves (they arrived before it left) go in
   * the same write, each field once: a scene on one slow fan is one read and one write.
   */
  async command(link, job) {
    this.checkBeforeSend(job, link);
    let read;
    try {
      read = await this.freshRead(link, job.received, job.received + TIMINGS.commandSendBy);
    } catch (err) {
      if (err instanceof FanError && err.code === 'busy') this.failed(link.key, err);
      // Its read cut by an Off clicked meanwhile: said as such.
      this.checkBeforeSend(job, link);
      throw this.commandError(err, false, job.ahead);
    }
    this.checkBeforeSend(job, link);
    this.checkTarget(job, read.state, link);
    const batch = [job];
    const fields = new Map(Object.entries(job.body));
    for (const other of [...link.commands]) {
      if (other.id !== job.id || !(read.at > other.received)) continue;
      // Each field once (the same value asked twice is one field: light on + brightness).
      if (Object.entries(other.body).some(([k, v]) => fields.has(k) && fields.get(k) !== v)) {
        continue;
      }
      link.commands.splice(link.commands.indexOf(other), 1);
      try {
        this.checkBeforeSend(other, link);
        this.checkTarget(other, read.state, link);
      } catch (err) {
        other.reject(err);
        continue;
      }
      batch.push(other);
      for (const [k, v] of Object.entries(other.body)) fields.set(k, v);
    }
    const others = batch.slice(1);
    const settle = (outcomes) => {
      for (const [i, other] of others.entries()) {
        if (outcomes[i]) other.reject(outcomes[i]);
        else other.resolve(undefined);
      }
    };
    const body = Object.assign({}, ...batch.map((j) => j.body));
    if (!validBody(body)) {
      settle(others.map(() => this.refusal(ERRORS.badValue)));
      throw this.refusal(ERRORS.badValue);
    }
    const starting = batch
      .filter((j) => starts(j.body))
      .map((j) => {
        const gk = gkOf(j.id, j.part);
        return { gk, guard: this.guards.get(gk), record: { sentAt: undefined, answered: false } };
      });
    let left = false;
    let at;
    let json;
    try {
      json = await this.laneOf(link.key).write(body, PRIORITY.COMMAND, {
        deadline: job.received + TIMINGS.commandAnswerBy,
        beforeSend: () => {
          // Each command of the batch checked again; when only some are refused now (an Off of
          // their part clicked meanwhile), the batch is formed again without them.
          const refused = [];
          for (const j of batch) {
            try {
              this.checkBeforeSend(j, link);
            } catch (err) {
              refused.push([j, err]);
            }
          }
          if (refused.length === batch.length) throw refused[0][1];
          if (refused.length > 0) {
            throw Object.assign(new FanError('late', 'batch changed'), { refused });
          }
          if (this.provenOther(link.key, job.id)) throw this.refusal(ERRORS.otherFan(link.key));
          if (!validBody(body)) throw this.refusal(ERRORS.badValue);
        },
        onSent: () => {
          left = true;
          at = this.monotonic();
          for (const { gk, guard, record } of starting) {
            record.sentAt = at;
            this.lastWrites.set(gk, record);
            // A newer command starting the part that left: the Off held for it ends here.
            if (guard && this.guards.get(gk) === guard) {
              this.guards.delete(gk);
              this.saveSoon();
            }
          }
        },
      });
    } catch (err) {
      if (err?.refused && !left) {
        // Nothing left: the commands refused now get their own reason, the others go again.
        const refused = new Map(err.refused);
        for (const [j, reason] of refused) if (j !== job) j.reject(reason);
        const kept = batch.filter((j) => !refused.has(j));
        if (refused.has(job)) {
          link.commands.unshift(...kept);
          throw refused.get(job);
        }
        link.commands.unshift(...kept.slice(1));
        return this.command(link, job);
      }
      const answered =
        err instanceof FanError && ['busy', 'http', 'bad_response', 'size'].includes(err.code);
      for (const { gk, guard, record } of starting) {
        record.answered = answered;
        if (left && answered && guard && !this.guards.has(gk)) {
          // Refused by the fan: not a newer command, the Off stands.
          this.guards.set(gk, guard);
          this.saveSoon();
        }
      }
      if (err instanceof FanError && err.code === 'busy') this.failed(link.key, err);
      if (left) this.afterWrite(link.key);
      const error = this.commandError(err, left, job.ahead);
      settle(others.map(() => error));
      throw error;
    }
    for (const { record } of starting) record.answered = true;
    const state = parseState(json);
    this.applyAnswer(link.key, state, at);
    this.afterWrite(link.key);
    this.flush().catch(() => {});
    settle(others.map((j) => this.outcomeOf(j, state, link.key)));
    const outcome = this.outcomeOf(job, state, link.key);
    if (outcome) throw outcome;
    return undefined;
  }

  /** The error of a write: never "not sent" once it may have left. */
  commandError(err, left, ahead) {
    if (!(err instanceof FanError)) return err;
    if (!left || !err.sent) {
      if (err.code === 'late') return this.refusal(ERRORS.late(ahead));
      if (err.code === 'bad_request') return this.refusal(ERRORS.badValue);
      return this.refusal(ERRORS.notSent(reasonOf(err)));
    }
    if (err.code === 'busy' || err.code === 'http')
      return this.refusal(ERRORS.rejected(reasonOf(err)));
    return this.refusal(ERRORS.unconfirmed);
  }

  /** After a write that left: reads 5 s and 20 s later (never skipped). */
  afterWrite(key) {
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const timer = this.timers.setTimeout(() => {
        this.followUps.delete(timer);
        if (generation !== this.generation || this.stopped) return undefined;
        return this.readKey(key, PRIORITY.CONFIRM, this.monotonic() + TIMINGS.requestTimeout)
          .then(() => Promise.all([this.refreshStatus(), this.flush()]))
          .catch((err) =>
            this.logger.warn(`modern-forms: follow-up read failed: ${errorReason(err)}`),
          );
      }, delay);
      this.followUps.add(timer);
    }
  }

  /**
   * An Off: no pause, queue, read nor configuration stops it (the address known). It cancels
   * the commands of the same part waiting, cuts the request in flight to the fan, is tried
   * again for 250 ms, and stays as a guard (in /data) sent again until a read shows it.
   */
  async protective(id, command, received, device) {
    const part = command.part;
    const gk = gkOf(id, part);
    for (const link of this.links.values()) {
      for (const job of [...link.commands]) {
        if (job.id === id && job.part === part) {
          link.commands.splice(link.commands.indexOf(job), 1);
          job.reject(this.refusal(ERRORS.cancelledByStop));
        }
      }
    }
    let key = this.locate(id, device);
    if (!key && !this.configLoaded) {
      // Neither read nor kept: the configuration may say (one address typed).
      this.askConfig();
      await this.waitReady(received + TIMINGS.configWait);
      key = this.locate(id, device);
    }
    if (!key) throw this.refusal(ERRORS.addressUnknown);
    if (this.provenOther(key, id)) throw this.refusal(ERRORS.otherFan(key));
    this.seq += 1;
    const guard = this.makeGuard({ id, part, address: key, seq: this.seq, inFlight: true });
    this.guards.set(gk, guard);
    // Written to /data without waiting: an Off never waits for the disk.
    this.saveSoon();
    this.logger.info(`modern-forms: ${shortId(id)} ${part} off`);
    const sendBy = received + TIMINGS.commandSendBy;
    const lane = this.laneOf(key);
    const first = this.monotonic();
    let left = false;
    let lastError;
    let json;
    for (;;) {
      try {
        json = await lane.write(offBody(part), PRIORITY.PROTECTIVE, {
          deadline: received + TIMINGS.commandAnswerBy,
          beforeSend: () => {
            // At every try: a newer click on this part took its place; nothing leaves after it.
            if (this.guards.get(gk) !== guard) throw new FanError('late', 'superseded');
            if (this.provenOther(key, id)) throw new FanError('late', 'another fan');
            if (this.monotonic() >= sendBy) throw new FanError('late', 'no time left to send');
          },
          onSent: () => {
            left = true;
            guard.left = true;
            guard.sentAt = this.monotonic();
          },
        });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        const mono = this.monotonic();
        if (
          left ||
          !(err instanceof FanError) ||
          this.guards.get(gk) !== guard ||
          this.provenOther(key, id) ||
          mono - first >= TIMINGS.protectiveRetry ||
          mono >= sendBy ||
          this.stopped
        ) {
          break;
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.protectiveRetryGap));
        if (this.guards.get(gk) !== guard) break;
      }
    }
    guard.inFlight = false;
    guard.userInFlight = false;
    if (!left) {
      if (this.guards.get(gk) !== guard) throw this.refusal(ERRORS.cancelledByStop);
      if (this.provenOther(key, id)) {
        this.guards.delete(gk);
        this.saveSoon();
        throw this.refusal(ERRORS.otherFan(key));
      }
      // Never abandoned: kept, sent again as soon as the lane is free, by the probe (every
      // 10 s, whatever the pause of the reads) and by the reads.
      this.resendGuard(guard, PRIORITY.PROTECTIVE);
      this.armProbe();
      this.refreshStatus().catch(() => {});
      throw this.refusal(ERRORS.protectiveKept(reasonOf(lastError)));
    }
    this.afterWrite(key);
    if (lastError) {
      if (lastError instanceof FanError && lastError.code === 'busy') this.failed(key, lastError);
      // Left, but refused or not answered: the probe sends it again.
      guard.unanswered = true;
      this.armProbe();
      this.saveSoon();
      throw this.refusal(ERRORS.offUnconfirmed);
    }
    const state = parseState(json);
    this.applyAnswer(key, state, guard.sentAt);
    this.flush().catch(() => {});
    if (state.id && state.id !== id) {
      // Another fan answered (swapped at that address, not seen yet): nothing held for it.
      if (this.guards.get(gk) === guard) this.guards.delete(gk);
      this.saveSoon();
      throw this.refusal(ERRORS.answeredByOther(key));
    }
    const off = state.id === id ? partOn(state, part) === false : undefined;
    if (off && this.guards.get(gk) === guard) {
      guard.confirmed = true;
      guard.other = undefined;
    }
    this.saveSoon();
    this.refreshStatus().catch(() => {});
    if (off) return undefined;
    throw this.refusal(
      state.id === id && partOn(state, part) === true
        ? ERRORS.offNotApplied
        : ERRORS.offUnconfirmed,
    );
  }

  // --- Gladys --------------------------------------------------------------------

  createdDevices() {
    return (this.gladys.devices ?? []).filter((d) =>
      parseExternalId(d?.external_id, this.gladys.selector),
    );
  }

  createdOf(id) {
    const deviceId = this.gladys.externalIds('fan', id).device;
    return this.createdDevices().find((d) => d.external_id === deviceId);
  }

  /** The states of a fan, for the features its device has in Gladys. */
  queueStates(id, state) {
    const created = this.createdOf(id);
    if (!created) return;
    const ids = this.gladys.externalIds('fan', id);
    const have = new Set((created.features ?? []).map((f) => f.external_id));
    for (const [key, value] of valuesOf(state)) {
      const featureId = ids.feature(key);
      if (have.has(featureId)) this.publisher.push(featureId, { state: value });
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The Discover list: the fans read at the addresses of this session. */
  async publishDevices() {
    const devices = [];
    for (const link of this.links.values()) {
      const id = this.seen.get(link.key)?.id;
      if (!id || this.publishingKey(id) !== link.key) continue;
      const fan = this.fans.get(id);
      devices.push(
        buildDevice(
          this.gladys,
          { ...fan, address: link.key },
          { language: this.config.language, created: this.createdOf(id) },
        ),
      );
    }
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    this.published = json;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.published = undefined;
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** Created or updated: nothing old republished; the next read publishes its states. */
  async deviceCreated(device) {
    const parsed = parseExternalId(device?.external_id, this.gladys.selector);
    if (!parsed) return;
    this.gladys.forgetPublishedStates?.(device.external_id);
    this.published = undefined;
    await this.publishDevices();
    await this.refreshStatus();
  }

  /** Deleted: its Offs held are dropped (no device to drive any more). */
  async deviceDeleted(device) {
    const parsed = parseExternalId(device?.external_id, this.gladys.selector);
    if (!parsed) return;
    this.publisher.forget(device.external_id);
    let dropped = false;
    for (const part of Object.values(PARTS))
      dropped = this.guards.delete(gkOf(parsed.id, part)) || dropped;
    if (dropped) this.saveSoon();
    this.published = undefined;
    await this.publishDevices();
    await this.refreshStatus();
  }

  /** Discover: the addresses due are read now (never sooner than the interval), then the list. */
  async scan() {
    const rounds = [...this.links.values()].map((link) => this.tick(link)).filter(Boolean);
    let timer;
    await Promise.race([
      Promise.allSettled(rounds),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, TIMINGS.requestTimeout * 2);
      }),
    ]);
    this.timers.clearTimeout(timer);
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Status --------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  nameOf(id) {
    const created = this.createdOf(id);
    return created?.name ?? fanName(this.fans.get(id) ?? { id }, this.config.language);
  }

  async refreshStatus() {
    if (!this.configLoaded) return;
    const mono = this.monotonic();
    const parts = [];
    let connected = this.links.size > 0;
    if (this.links.size === 0) parts.push(T.noFans);
    if (this.config.addressErrors.length > 0) {
      parts.push(T.addressErrors(this.config.addressErrors.join(', ')));
      connected = false;
    }
    if (this.config.tooMany) parts.push(T.tooMany(LIMITS.fans));
    const names = [];
    let toAdd = 0;
    for (const link of this.links.values()) {
      const pace = this.paceOf(link.key);
      const seen = this.seen.get(link.key);
      if (pace.offline) {
        connected = false;
        parts.push(
          T.unreachable(
            link.key,
            pace.lastReason ?? both('earlier reads failed', 'les lectures précédentes ont échoué'),
            age(Math.max(0, this.dueAt(pace, mono) - mono)),
          ),
        );
      } else if (!seen) {
        connected = false;
        parts.push(T.waiting(link.key));
      } else if (!seen.id) {
        connected = false;
        parts.push(T.noIdentity(link.key));
      } else if (this.publishingKey(seen.id) !== link.key) {
        parts.push(T.duplicate(link.key, this.publishingKey(seen.id)));
      } else {
        names.push(this.nameOf(seen.id));
        if (!this.createdOf(seen.id)) toAdd += 1;
      }
    }
    if (names.length > 0) parts.unshift(T.read(names.join(', ')));
    if (toAdd > 0) parts.push(T.toAdd(toAdd));
    for (const guard of this.guards.values()) {
      if (guard.confirmed) continue;
      const name = this.nameOf(guard.id);
      const part = PART_NAMES[guard.part];
      parts.push(
        guard.resends >= TIMINGS.resendMax
          ? T.guardExhausted(name, part)
          : T.guardPending(name, part, guard.resends),
      );
    }
    if (this.storeUnreadable) parts.push(T.storeUnreadable);
    else if (this.saveFailed) parts.push(T.storeProblem);
    const cut = (text) => (text.length > STATUS_MAX ? `${text.slice(0, STATUS_MAX - 1)}…` : text);
    const message = both(
      cut(parts.map((p) => p.en).join(' ')),
      cut(parts.map((p) => p.fr).join(' ')),
    );
    await this.setStatus(connected, message);
  }

  // --- Configuration button -------------------------------------------------------

  /** "Test the connection": each address read now unless read within the interval (then that read). */
  async testConnection() {
    if (!this.configLoaded) {
      this.askConfig();
      await this.waitReady(this.monotonic() + TIMINGS.configWait);
    }
    const links = [...this.links.values()];
    if (links.length === 0) return word(T.test.none, this.config.language);
    const lines = await Promise.all(
      links.map(async (link) => {
        const pace = this.paceOf(link.key);
        const mono = this.monotonic();
        const recent =
          pace.lastReadAt !== undefined &&
          mono - pace.lastReadAt < Math.max(this.interval, TIMINGS.testCooldown);
        if (!recent || pace.offline) {
          const round = this.tick(link);
          if (round) {
            let timer;
            await Promise.race([
              round,
              new Promise((resolve) => {
                timer = this.timers.setTimeout(resolve, TIMINGS.testBudget);
              }),
            ]);
            this.timers.clearTimeout(timer);
          }
        }
        const seen = this.seen.get(link.key);
        if (pace.offline || !seen) {
          return T.test.failed(link.key, pace.lastReason ?? both('not read yet', 'pas encore lu'));
        }
        if (!seen.id) return T.test.noIdentity(link.key);
        const fan = this.fans.get(seen.id);
        const summary = summaryOf(fan.state);
        const name = `${this.nameOf(seen.id)} (${shortId(seen.id)})`;
        const ago = this.monotonic() - seen.at;
        return ago > 2 * TIMINGS.requestTimeout
          ? T.test.recent(link.key, name, summary, age(ago))
          : T.test.ok(link.key, name, summary);
      }),
    );
    await this.refreshStatus();
    return both(lines.map((l) => l.en).join(' '), lines.map((l) => l.fr).join(' '));
  }
}
