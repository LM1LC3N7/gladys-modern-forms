// -----------------------------------------------------------------------------
// The only network access: one HTTP request to the fan over node:http, and
// the errors it ends with. The body read is bounded, the whole request is
// bounded in time (`deadline`, an absolute instant on the monotonic clock),
// and an error tells whether the request may have reached the fan (`sent`):
// a write that may have left is never told "not sent".
//
// The path holds the API key (the query string of both API versions): it is
// never logged nor put in an error; the reasons are error codes only. A
// request settles once its socket is closed (or 500 ms after it was
// destroyed): the next request never opens a connection while the previous
// one is still open. `cut()` (from `onStart`) ends a request at once: a
// protective command does not wait behind a read.
//
// Structure taken from gladys-roth-touchline (approved), changed: methods,
// JSON bodies, the cut, settling on close.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { TIMINGS } from '../constants.js';

/**
 * A failed request. `code`:
 * - `network`: no answer (socket error), `reason` from the error code;
 * - `timeout`: no answer in time;
 * - `late`: the deadline passed before the request left (nothing sent);
 * - `cut`: ended by an Off;
 * - `busy`: 429 / 503 (the fan asks to wait);
 * - `http`: another unexpected status (`status`);
 * - `size`, `bad_response`: not the expected answer;
 * - `bad_request`: refused before anything left (an invalid value).
 * `sent`: the request may have reached the fan.
 */
export class FanError extends Error {
  constructor(code, message, { status, reason, sent = false } = {}) {
    super(message);
    this.name = 'FanError';
    this.code = code;
    this.status = status;
    this.reason = reason;
    this.sent = sent;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> FanError, from its code only: Node's own message may hold the address. */
export function networkError(err, sent) {
  if (err instanceof FanError) {
    return err;
  }
  const code = typeof err?.code === 'string' && /^[A-Z_]{1,32}$/.test(err.code) ? err.code : '';
  if (code.startsWith('HPE_')) {
    return new FanError('bad_response', 'not the expected HTTP answer', { reason: code, sent });
  }
  return new FanError('network', NETWORK_REASONS[code] ?? 'network error', {
    reason: code || undefined,
    sent,
  });
}

/** A short reason for a log: never the address nor the body. */
export function errorReason(err) {
  if (err instanceof FanError) {
    const details = [err.reason, err.status ? `HTTP ${err.status}` : undefined].filter(Boolean);
    return details.length > 0 ? `${err.message} (${details.join(', ')})` : err.message;
  }
  return 'internal error';
}

/**
 * One request; resolves `{ status, body }` (body: a Buffer) whatever the
 * status. `deadline`: the monotonic instant by which the answer must be in;
 * `beforeSend` runs once the socket is connected, right before the request
 * leaves: it may throw to abort with nothing sent; `onSent` runs once the
 * request has really left; `onStart(cut)` hands the function that ends it.
 */
export function request(
  { hostname, port, method = 'POST', path, body },
  { monotonic = () => performance.now(), deadline, maxBytes, beforeSend, onSent, onStart } = {},
) {
  return new Promise((resolve, reject) => {
    const due = deadline ?? monotonic() + TIMINGS.requestTimeout;
    let timer;
    let closeTimer;
    let outcome;
    let delivered = false;
    let closed = false;
    let sent = false;
    let req;
    const deliver = () => {
      if (delivered || !outcome) return;
      delivered = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      outcome.fn(outcome.value);
    };
    /** The first outcome wins; it is delivered once the socket is closed. */
    const settle = (fn, value, destroy = false) => {
      if (outcome) return;
      outcome = { fn, value };
      clearTimeout(timer);
      if (destroy) req?.destroy();
      if (closed || !req) {
        deliver();
        return;
      }
      closeTimer = setTimeout(() => {
        req?.destroy();
        deliver();
      }, TIMINGS.cutWait);
    };
    const wait = due - monotonic();
    if (wait <= 0) {
      settle(reject, new FanError('late', 'no time left to send'));
      return;
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    try {
      req = http.request(
        {
          hostname,
          port,
          path,
          method,
          headers: {
            Accept: 'application/json',
            Connection: 'close',
            ...(payload === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': payload.length }),
          },
          agent: false,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              settle(reject, new FanError('size', 'answer too large', { sent: true }), true);
              return;
            }
            chunks.push(chunk);
          });
          // The answer is whole; it is delivered once the socket is closed (Node closes it after
          // a "Connection: close" exchange; destroyed 500 ms later otherwise).
          res.on('end', () =>
            settle(resolve, { status: res.statusCode, body: Buffer.concat(chunks) }),
          );
          res.on('error', (err) => settle(reject, networkError(err, true), true));
          res.on('aborted', () =>
            settle(reject, new FanError('network', 'answer cut short', { sent: true }), true),
          );
        },
      );
    } catch (err) {
      settle(reject, new FanError('network', 'invalid address', { reason: err?.code }));
      return;
    }
    let socketSeen = false;
    // Without a socket (refused before one), the end of the request is the end.
    req.on('close', () => {
      if (!socketSeen) {
        closed = true;
        deliver();
      }
    });
    onStart?.(() => settle(reject, new FanError('cut', 'cut by an Off', { sent }), true));
    timer = setTimeout(() => {
      settle(
        reject,
        new FanError('timeout', `no answer within ${Math.max(1, Math.round(wait / 1000))} s`, {
          sent,
        }),
        true,
      );
    }, wait);
    req.on('error', (err) => settle(reject, networkError(err, sent), true));
    req.on('socket', (socket) => {
      socketSeen = true;
      // Delivered once the socket itself is closed (the request's 'close' comes sooner).
      socket.once('close', () => {
        closed = true;
        deliver();
      });
      const send = () => {
        if (outcome) {
          return;
        }
        try {
          beforeSend?.();
        } catch (err) {
          settle(reject, err, true);
          return;
        }
        if (due - monotonic() <= 0) {
          settle(reject, new FanError('late', 'no time left to send'), true);
          return;
        }
        sent = true;
        onSent?.();
        req.end(payload);
      };
      if (socket.connecting) {
        socket.once('connect', send);
      } else {
        send();
      }
    });
  });
}
