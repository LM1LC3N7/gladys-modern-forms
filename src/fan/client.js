// -----------------------------------------------------------------------------
// The lane of one fan (one address): one request at a time (a small embedded
// web server), in the order of their priority:
//   0  Offs clicked (fan off, light off);
//   1  Offs sent again by the integration (guards);
//   2  the other commands and the read that checks the fan before them;
//   3  the reads after a command;
//   4  the reads of the polling.
// An Off clicked cuts the request in flight, whatever it is, unless it is
// another Off clicked (a read cut does not count as a failure; a command cut
// that may have left is "sent, without confirmation"); any other write cuts
// a read of the polling. A request not started by its deadline leaves the
// queue ("nothing sent"). The next request opens its connection only once
// the previous one is closed (see http.js).
//
// Taken from gladys-ipx800 0.1.3 (approved, same author): the lane as is, the
// requests of the Modern Forms API instead of the IPX800 ones.
// -----------------------------------------------------------------------------

import { API, LIMITS, TIMINGS } from '../constants.js';
import { FanError, request } from './http.js';

export const PRIORITY = { PROTECTIVE: 0, GUARD: 1, COMMAND: 2, CONFIRM: 3, READ: 4 };

export class FanClient {
  constructor({ host, port, transport = request, monotonic, timers }) {
    this.host = host;
    this.port = port;
    this.transport = transport;
    this.monotonic = monotonic ?? (() => performance.now());
    this.timers = timers ?? globalThis;
    /** Jobs waiting: { priority, run, resolve, reject }. */
    this.queue = [];
    /** The job running: { priority, cut }. */
    this.current = undefined;
    this.closed = false;
  }

  /** Ends the client: what waits is refused (nothing sent), the request in flight is cut. */
  close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      this.timers.clearTimeout(job.timer);
      job.reject(new FanError('late', 'the connection to the fan was closed'));
    }
    this.current?.cut?.();
  }

  /** One request through the lane. */
  send(priority, options, hooks = {}) {
    if (this.closed) {
      return Promise.reject(new FanError('late', 'the connection to the fan was closed'));
    }
    return new Promise((resolve, reject) => {
      const job = { priority, options, hooks, resolve, reject };
      // FIFO within a priority, the more urgent first.
      const at = this.queue.findIndex((j) => j.priority > priority);
      if (at === -1) this.queue.push(job);
      else this.queue.splice(at, 0, job);
      if (hooks.deadline !== undefined) {
        // Not started by its deadline: out of the queue, nothing sent.
        job.timer = this.timers.setTimeout(
          () => {
            const index = this.queue.indexOf(job);
            if (index !== -1) {
              this.queue.splice(index, 1);
              reject(new FanError('late', 'no time left to send'));
            }
          },
          Math.max(0, hooks.deadline - this.monotonic()),
        );
      }
      // An Off clicked cuts whatever is not one; any other write cuts a read of the polling
      // (read again at the next round): a write never waits behind one.
      if (
        this.current &&
        ((priority === PRIORITY.PROTECTIVE && this.current.priority > priority) ||
          (priority <= PRIORITY.COMMAND && this.current.priority === PRIORITY.READ))
      ) {
        this.current.cut?.();
      } else if (
        priority === PRIORITY.PROTECTIVE &&
        this.current?.priority === PRIORITY.PROTECTIVE
      ) {
        this.armStuck(this.current);
      }
      this.pump();
    });
  }

  /**
   * An Off running while another Off waits: cut once it got no answer for 1 s (it may have left:
   * "sent, without confirmation"), so that the next one does not wait for its deadline. Armed
   * on the request running, when it starts or when an Off comes behind it.
   */
  armStuck(running) {
    if (running.stuckArmed) return;
    running.stuckArmed = true;
    this.timers.setTimeout(
      () => {
        if (this.current === running) running.cut?.();
      },
      Math.max(0, running.startedAt + TIMINGS.stuckProtective - this.monotonic()),
    );
  }

  pump() {
    if (this.current || this.cooling || this.queue.length === 0) {
      return;
    }
    const job = this.queue.shift();
    this.timers.clearTimeout(job.timer);
    const running = { priority: job.priority, cutAsked: false, startedAt: this.monotonic() };
    // Until the transport hands its own cut, a cut asked is remembered.
    running.cut = () => {
      running.cutAsked = true;
    };
    this.current = running;
    if (
      job.priority === PRIORITY.PROTECTIVE &&
      this.queue.some((j) => j.priority === PRIORITY.PROTECTIVE)
    ) {
      this.armStuck(running);
    }
    const { deadline, beforeSend, onSent } = job.hooks;
    this.transport(
      { hostname: this.host, port: this.port, ...job.options },
      {
        monotonic: this.monotonic,
        deadline: deadline ?? this.monotonic() + TIMINGS.requestTimeout,
        maxBytes: LIMITS.responseBytes,
        beforeSend,
        onSent,
        onStart: (cut) => {
          running.cut = cut;
          if (running.cutAsked) cut();
        },
      },
    )
      .then(job.resolve, job.reject)
      .finally(() => {
        this.current = undefined;
        // The next job a little later: the caller of this one may queue its own follow-up
        // first, and the fan has seen the previous connection closed before the next one opens.
        this.cooling = true;
        this.timers.setTimeout(() => {
          this.cooling = false;
          this.pump();
        }, TIMINGS.laneGap);
      });
  }

  /** `POST /mf` with `body`: the JSON object of a 200, or the error of the status. */
  async post(priority, body, hooks) {
    const { status, body: answer } = await this.send(
      priority,
      { method: 'POST', path: API.path, body },
      hooks,
    );
    if (status === 429 || status === 503) {
      throw new FanError('busy', 'the fan asks to wait', { status, sent: true });
    }
    if (status < 200 || status > 299) {
      throw new FanError('http', 'unexpected answer', { status, sent: true });
    }
    let json;
    try {
      json = JSON.parse(answer.toString('utf8'));
    } catch {
      throw new FanError('bad_response', 'not a JSON answer', { sent: true });
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new FanError('bad_response', 'not a JSON object', { sent: true });
    }
    return json;
  }

  /** The state of the fan (dynamic shadow). */
  readState(priority = PRIORITY.READ, hooks) {
    return this.post(priority, API.queryState, hooks);
  }

  /** The information of the fan (static shadow). */
  readInfo(priority = PRIORITY.READ, hooks) {
    return this.post(priority, API.queryInfo, hooks);
  }

  /** A command (a body built and bounded by src/fan/model.js): the state after it. */
  write(body, priority, hooks) {
    return this.post(priority, body, hooks);
  }
}
