// -----------------------------------------------------------------------------
// What the answers of a fan mean, and what a command writes (pure functions).
//
// Answers are untrusted data: only the fields used are read, each checked
// strictly (a boolean is `true` or `false`, a number an integer within the
// range of the WAC reference); anything else is unknown, never 0. The e-mail
// of the owner (`owner`) and the AWS identity (`federatedIdentity`) of the
// information answer are never read.
//
// Identity: `clientId`, `MF_` or `WAC_` and the 12 hex digits of the MAC
// address of the fan (WAC reference: "Unique identifier specific to a single
// device"), in every answer, commands included. Its 12 hex digits, lower
// case, are the platform id of the device (its external id). An answer
// without a valid `clientId` has no identity: unreadable, never another fan.
// -----------------------------------------------------------------------------

import { DIRECTION, FEATURES as F, LIMITS, PARTS, RANGES, WIND } from '../constants.js';

const CLIENT_ID = /^(?:MF|WAC)_([0-9A-F]{12})$/i;
const MAC = /^([0-9A-F]{2})(?::([0-9A-F]{2})){5}$/i;

/** The 12 hex digits (lower case) of a `clientId`; undefined when it is not one. */
export function idOf(clientId) {
  if (typeof clientId !== 'string') return undefined;
  const match = CLIENT_ID.exec(clientId);
  return match ? match[1].toLowerCase() : undefined;
}

/** A platform id as typed in a device external id: 12 lower-case hex digits. */
export const isId = (text) => typeof text === 'string' && /^[0-9a-f]{12}$/.test(text);

const bool = (value) => (value === true || value === false ? value : undefined);
const int = (value, { min, max }) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** Printable text (no control characters), trimmed and cut; undefined when empty. */
export function textOf(value, max = LIMITS.nameLength) {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  if (text === '') return undefined;
  return [...text].slice(0, max).join('');
}

/**
 * A state answer (the dynamic shadow, also the answer of a command):
 * `{ id, fan: { on, speed, direction, hasWind, wind }, light: { present, on, brightness } }`.
 * A light is present when the answer has `lightOn` (a fan without light kit has no light
 * fields); breeze when it has `wind` (generation 3).
 */
export function parseState(json) {
  const fanDirection =
    json?.fanDirection === 'forward'
      ? DIRECTION.FORWARD
      : json?.fanDirection === 'reverse'
        ? DIRECTION.REVERSE
        : undefined;
  const hasWind = typeof json?.wind === 'boolean';
  const lightPresent = typeof json?.lightOn === 'boolean';
  return {
    id: idOf(json?.clientId),
    fan: {
      on: bool(json?.fanOn),
      speed: int(json?.fanSpeed, RANGES.fanSpeed),
      direction: fanDirection,
      hasWind,
      wind: hasWind ? json.wind : undefined,
    },
    light: {
      present: lightPresent,
      on: lightPresent ? json.lightOn : undefined,
      brightness: lightPresent ? int(json?.lightBrightness, RANGES.brightness) : undefined,
    },
  };
}

/** The information answer (static shadow): `{ id, mac, name, model, firmware }`. */
export function parseInfo(json) {
  const mac =
    typeof json?.mac === 'string' && MAC.test(json.mac)
      ? json.mac.replace(/:/g, '').toLowerCase()
      : undefined;
  return {
    id: idOf(json?.clientId),
    mac,
    name: textOf(json?.deviceName),
    model: textOf(json?.fanType, 32),
    firmware: textOf(json?.firmwareVersion, 32),
  };
}

/**
 * The value of each feature in a state (what is published): fan speed 0 when off, the
 * speed when on; direction 0 / 1; breeze 0 / 2; light 0 / 1; brightness 1-100. A value
 * not known is absent (never published).
 */
export function valuesOf(state) {
  const out = new Map();
  if (state.fan.on === false) out.set(F.SPEED, 0);
  else if (state.fan.on === true && state.fan.speed !== undefined)
    out.set(F.SPEED, state.fan.speed);
  if (state.fan.direction !== undefined) out.set(F.DIRECTION, state.fan.direction);
  if (state.fan.hasWind) out.set(F.WIND, state.fan.wind ? WIND.NATURAL : WIND.OFF);
  if (state.light.present) {
    out.set(F.LIGHT, state.light.on ? 1 : 0);
    if (state.light.brightness !== undefined) out.set(F.BRIGHTNESS, state.light.brightness);
  }
  return out;
}

/** The on / off of a part in a state (what a guard checks); undefined when not known. */
export function partOn(state, part) {
  return part === PARTS.FAN ? state.fan.on : state.light.on;
}

/** A command value from Gladys: an integer (or its plain text); undefined otherwise. */
export function integerOf(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d{1,3}$/.test(value)) return Number(value);
  return undefined;
}

/**
 * The command of a feature and a value: `{ body, part, protective }`; undefined when the
 * value is not one the feature takes. Offs: fan speed 0, light 0, brightness 0.
 */
export function commandOf(key, value) {
  switch (key) {
    case F.SPEED:
      if (value === 0) return { body: { fanOn: false }, part: PARTS.FAN, protective: true };
      if (int(value, RANGES.fanSpeed) !== undefined)
        return { body: { fanOn: true, fanSpeed: value }, part: PARTS.FAN, protective: false };
      return undefined;
    case F.DIRECTION:
      if (value === DIRECTION.FORWARD || value === DIRECTION.REVERSE)
        return {
          body: { fanDirection: value === DIRECTION.FORWARD ? 'forward' : 'reverse' },
          part: PARTS.FAN,
          protective: false,
        };
      return undefined;
    case F.WIND:
      if (value === WIND.OFF || value === WIND.NATURAL)
        return { body: { wind: value === WIND.NATURAL }, part: PARTS.FAN, protective: false };
      return undefined;
    case F.LIGHT:
      if (value === 0) return { body: { lightOn: false }, part: PARTS.LIGHT, protective: true };
      if (value === 1) return { body: { lightOn: true }, part: PARTS.LIGHT, protective: false };
      return undefined;
    case F.BRIGHTNESS:
      if (value === 0) return { body: { lightOn: false }, part: PARTS.LIGHT, protective: true };
      if (int(value, RANGES.brightness) !== undefined)
        return {
          body: { lightOn: true, lightBrightness: value },
          part: PARTS.LIGHT,
          protective: false,
        };
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The last check of a body right before it is written: only the fields and values the
 * WAC reference takes (fan speed 1-6, brightness 1-100). false: never written.
 */
export function validBody(body) {
  if (!body || typeof body !== 'object') return false;
  const entries = Object.entries(body);
  if (entries.length === 0 || entries.length > 2) return false;
  return entries.every(([key, value]) => {
    switch (key) {
      case 'fanOn':
      case 'lightOn':
      case 'wind':
        return value === true || value === false;
      case 'fanSpeed':
        return int(value, RANGES.fanSpeed) !== undefined;
      case 'lightBrightness':
        return int(value, RANGES.brightness) !== undefined;
      case 'fanDirection':
        return value === 'forward' || value === 'reverse';
      default:
        return false;
    }
  });
}

/**
 * Does a state show what a body asked? true, false, or undefined when a field asked is not
 * in the state (unknown, never "not applied").
 */
export function shows(state, body) {
  let known = true;
  for (const [key, value] of Object.entries(body)) {
    let read;
    if (key === 'fanOn') read = state.fan.on;
    else if (key === 'fanSpeed') read = state.fan.speed;
    else if (key === 'wind') read = state.fan.wind;
    else if (key === 'lightOn') read = state.light.on;
    else if (key === 'lightBrightness') read = state.light.brightness;
    else if (key === 'fanDirection')
      read =
        state.fan.direction === undefined
          ? undefined
          : state.fan.direction === DIRECTION.FORWARD
            ? 'forward'
            : 'reverse';
    if (read === undefined) known = false;
    else if (read !== value) return false;
  }
  return known ? true : undefined;
}
