// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
//
// `fans`: the addresses of the fans, one per line or separated by commas,
// semicolons or spaces (`192.168.1.60`, `fan-kitchen.lan`, `192.168.1.61:8080`);
// up to LIMITS.fans, the same address once. A wrong entry is reported, never
// fatal for the others.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { API, LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * One address typed by the user: `{ host, port }`, `{ error: 'path' }` when it
 * holds a path, a query or credentials (a pasted URL), `{ error: 'https' }`,
 * `{ error: 'invalid' }`, `{}` when empty. Taken from gladys-ipx800 0.1.3.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (/^https:\/\//i.test(text)) {
    return { error: 'https' };
  }
  text = text.replace(/^http:\/\//i, '').replace(/\/$/, '');
  // eslint-disable-next-line no-control-regex
  if (/[/?#@\s\u0000-\u001f\u007f]/.test(text)) {
    return { error: 'path' };
  }
  let host = text;
  let port;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2];
  } else if (isIP(text) !== 6) {
    const withPort = /^([^:]+):(\d{1,5})$/.exec(text);
    if (withPort) {
      host = withPort[1];
      port = withPort[2];
    } else if (text.includes(':')) {
      return { error: 'invalid' };
    }
  }
  if (isIP(host) === 0 && !HOSTNAME.test(host)) {
    return { error: 'invalid' };
  }
  if (isIP(host) === 4 && /^(0\.|255\.255\.255\.255$|22[4-9]\.|23\d\.)/.test(host)) {
    // Neither "this network", the broadcast nor a multicast group.
    return { error: 'invalid' };
  }
  if (isIP(host) === 6 && /^(::$|ff)/i.test(host)) {
    // Neither the unspecified address nor a multicast group.
    return { error: 'invalid' };
  }
  const portNumber = port === undefined ? API.defaultPort : Number(port);
  if (portNumber < 1 || portNumber > 65535) {
    return { error: 'invalid' };
  }
  return { host: host.toLowerCase(), port: portNumber };
}

/** `host:port` (IPv6 in brackets): the key of an address everywhere (lanes, /data). */
export const addressKey = ({ host, port }) => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

/** An address key back to `{ host, port }`; undefined when it is not one. */
export function addressOf(key) {
  if (typeof key !== 'string' || key.length > 300) return undefined;
  const parsed = parseAddress(key);
  if (parsed.error || !parsed.host) return undefined;
  return addressKey(parsed) === key ? parsed : undefined;
}

/** The list of fans: `{ addresses: [{ host, port, key }], errors: [text], tooMany }`. */
export function parseFans(raw) {
  const addresses = [];
  const errors = [];
  let tooMany = false;
  const seen = new Set();
  for (const entry of String(raw ?? '').split(/[,;\s]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    const parsed = parseAddress(text);
    if (parsed.error || !parsed.host) {
      errors.push([...text].slice(0, 30).join(''));
      continue;
    }
    const key = addressKey(parsed);
    if (seen.has(key)) continue;
    if (addresses.length >= LIMITS.fans) {
      tooMany = true;
      continue;
    }
    seen.add(key);
    addresses.push({ ...parsed, key });
  }
  return { addresses, errors: errors.slice(0, 5), tooMany };
}

const number = (value) =>
  value === undefined || value === null || value === '' ? NaN : Number(value);

const clamp = (value, { min, max }, fallback) =>
  Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;

export function normalizeConfig(raw = {}) {
  const fans = parseFans(raw?.fans);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    addresses: fans.addresses,
    addressErrors: fans.errors,
    tooMany: fans.tooMany,
    pollInterval: clamp(number(raw?.poll_interval), POLL_INTERVAL, DEFAULTS.poll_interval),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
