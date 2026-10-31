// -----------------------------------------------------------------------------
// A fan -> its Gladys device (pure).
//
// `ext:<selector>:fan:<id>`, `<id>` the 12 hex digits (lower case) of the
// `clientId` of the fan (its MAC address on the fans of the WAC reference):
// the id follows the fan, whatever its address. Feature keys (frozen):
//   - `fan-speed`   fan/speed 0-6: 0 = off, 1 to 6 = on at that speed;
//   - `direction`   fan/airflow-direction: 0 forward (summer), 1 reverse;
//   - `wind`        fan/wind-setting: 0 off, 2 breeze (generation 3 only);
//   - `light`       light/binary (a fan with a light kit);
//   - `brightness`  light/brightness 0-100 % (0 = light off).
// None is a `switch`: a "turn every switch on" never starts a fan. The light
// is a light: it obeys "turn the lights off / on" like any other light.
// A device published again never loses a feature: those of the device already
// created in Gladys are kept as they are. The address it was last read at is
// a param (`address`), updated in Gladys when the fan moves.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DIRECTION, FEATURES as F, RANGES, WIND } from './constants.js';
import { isId } from './fan/model.js';
import { FEATURE_NAMES, OPTION_NAMES, fanName, word } from './i18n.js';

export const KIND = 'fan';
export const FEATURE_KEYS = Object.values(F);

/** The features a fan has, from its state (the light and the breeze when it reports them). */
export function featureKeysOf(state) {
  const keys = [F.SPEED, F.DIRECTION];
  if (state?.fan?.hasWind) keys.push(F.WIND);
  if (state?.light?.present) keys.push(F.LIGHT, F.BRIGHTNESS);
  return keys;
}

/** One feature of the device. */
export function buildFeature(ids, key, language) {
  const base = {
    name: word(FEATURE_NAMES[key], language),
    external_id: ids.feature(key),
    read_only: false,
    has_feedback: true,
    keep_history: true,
  };
  switch (key) {
    case F.SPEED:
      return {
        ...base,
        category: C.FAN,
        type: T.FAN.SPEED,
        min: 0,
        max: RANGES.fanSpeed.max,
      };
    case F.DIRECTION:
      return {
        ...base,
        category: C.FAN,
        type: T.FAN.AIRFLOW_DIRECTION,
        min: DIRECTION.FORWARD,
        max: DIRECTION.REVERSE,
        supported_options: [
          { value: DIRECTION.FORWARD, label: word(OPTION_NAMES.forward, language) },
          { value: DIRECTION.REVERSE, label: word(OPTION_NAMES.reverse, language) },
        ],
      };
    case F.WIND:
      return {
        ...base,
        category: C.FAN,
        type: T.FAN.WIND_SETTING,
        min: WIND.OFF,
        max: WIND.NATURAL,
        supported_options: [
          { value: WIND.OFF, label: word(OPTION_NAMES.windOff, language) },
          { value: WIND.NATURAL, label: word(OPTION_NAMES.breeze, language) },
        ],
      };
    case F.LIGHT:
      return { ...base, category: C.LIGHT, type: T.LIGHT.BINARY, min: 0, max: 1 };
    case F.BRIGHTNESS:
      return {
        ...base,
        category: C.LIGHT,
        type: T.LIGHT.BRIGHTNESS,
        unit: U.PERCENT,
        min: 0,
        max: RANGES.brightness.max,
      };
    default:
      return undefined;
  }
}

/**
 * The device of a fan: `fan` = { id, info?, state?, address }. `created`: the device as
 * Gladys has it (its features kept as they are, the new ones added).
 */
export function buildDevice(gladys, fan, { language, created } = {}) {
  const ids = gladys.externalIds(KIND, fan.id);
  const keys = featureKeysOf(fan.state);
  const features = [];
  const have = new Set();
  for (const feature of created?.features ?? []) {
    const key = featureKeyOf(feature.external_id, ids.device);
    if (key) {
      features.push(feature);
      have.add(key);
    }
  }
  for (const key of keys) {
    if (!have.has(key)) features.push(buildFeature(ids, key, language));
  }
  return {
    name: created?.name ?? fanName(fan, language),
    external_id: ids.device,
    model: fan.info?.model ? `Modern Forms ${fan.info.model}` : 'Modern Forms',
    features,
    params: fan.address ? [{ name: 'address', value: fan.address }] : [],
  };
}

/** The feature key of an external id under a device id; undefined when not ours. */
export function featureKeyOf(externalId, deviceId) {
  if (typeof externalId !== 'string' || !externalId.startsWith(`${deviceId}:`)) return undefined;
  const key = externalId.slice(deviceId.length + 1);
  return FEATURE_KEYS.includes(key) ? key : undefined;
}

/** `ext:<selector>:fan:<id>[:<key>]` -> `{ id, key }`; undefined when not one of ours. */
export function parseExternalId(externalId, selector) {
  const prefix = `ext:${selector}:${KIND}:`;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return undefined;
  const [id, key, ...rest] = externalId.slice(prefix.length).split(':');
  if (!isId(id) || rest.length > 0) return undefined;
  if (key !== undefined && !FEATURE_KEYS.includes(key)) return undefined;
  return { id, key };
}

/** The `address` param of a device Gladys has; undefined when none. */
export function paramAddress(device) {
  const param = (device?.params ?? []).find((p) => p?.name === 'address');
  return typeof param?.value === 'string' ? param.value : undefined;
}
