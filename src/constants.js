// -----------------------------------------------------------------------------
// Constants: the local API of the Modern Forms / WAC smart fans (generations
// 1, 2 and 3), the feature keys, the limits and the timings.
//
// API (WAC "Smart Fans IP API, Definition for 3rd Party Integrations", 2021,
// and aiomodernforms 0.3.1, MIT): every request is `POST /mf` on port 80 with
// a JSON body, answered with JSON:
//   - `{ "queryDynamicShadowData": 1 }`: the state (`clientId`, `fanOn`,
//     `fanSpeed` 1-6, `fanDirection` "forward" | "reverse", `lightOn`,
//     `lightBrightness` 1-100, generation 3: `wind`, `windSpeed` 1-3...);
//   - `{ "queryStaticShadowData": 1 }`: what rarely changes (`clientId`,
//     `mac`, `deviceName`, `fanType`, `lightType`, `firmwareVersion`; also
//     the e-mail of the owner and an AWS identity, never kept here);
//   - a command (`{ "fanOn": false }`, `{ "lightBrightness": 40 }`...) is
//     answered with the whole state after it.
// `clientId` (`MF_` or `WAC_` + the 12 hex digits of the MAC address) is in
// every answer: it is the identity of the fan (see src/fan/model.js).
// Generation 4 fans (`/device` + `/fixture`) are not handled (see TODO.md).
// -----------------------------------------------------------------------------

export const API = {
  defaultPort: 80,
  path: '/mf',
  queryState: { queryDynamicShadowData: 1 },
  queryInfo: { queryStaticShadowData: 1 },
};

/** What the API accepts (the WAC reference). */
export const RANGES = {
  fanSpeed: { min: 1, max: 6 },
  brightness: { min: 1, max: 100 },
};

/** The two parts of a fan an Off stops (the guards): the motor and the light. */
export const PARTS = { FAN: 'fan', LIGHT: 'light' };

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  /** Fan: 0 = off, 1 to 6 = on at that speed. */
  SPEED: 'fan-speed',
  /** Airflow direction: 0 forward (summer), 1 reverse (winter). */
  DIRECTION: 'direction',
  /** Breeze (wind) mode, generation 3: 0 off, 2 natural. */
  WIND: 'wind',
  LIGHT: 'light',
  BRIGHTNESS: 'brightness',
};

/** The part each feature drives (its Off is the guard of that part). */
export const PART_OF = {
  [FEATURES.SPEED]: PARTS.FAN,
  [FEATURES.DIRECTION]: PARTS.FAN,
  [FEATURES.WIND]: PARTS.FAN,
  [FEATURES.LIGHT]: PARTS.LIGHT,
  [FEATURES.BRIGHTNESS]: PARTS.LIGHT,
};

/** The values of the core (FAN_AIRFLOW_DIRECTION, FAN_WIND_SETTING). */
export const DIRECTION = { FORWARD: 0, REVERSE: 1 };
export const WIND = { OFF: 0, NATURAL: 2 };

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = { min: 5, max: 300, default: 10 };

export const LIMITS = {
  /** Fans of the configuration. */
  fans: 8,
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** An answer is read up to this size, then dropped (a state is ~500 bytes). */
  responseBytes: 16 * 1024,
  /** Names are cut to this length. */
  nameLength: 60,
  /** Non-protective commands waiting per fan (a scene). */
  commandQueue: 16,
  /** Offs kept in /data. */
  guards: 64,
  /** Fans and addresses remembered in /data. */
  remembered: 32,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request (a read, a write) at most. */
  requestTimeout: 3 * SECOND,
  /** Failed reads of a fan: 10 s, 30 s, 1, 2 then 5 min, never shorter than the interval. */
  backoff: [10 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The fan asks to wait (429, 503): at least a minute. */
  busyPause: MINUTE,
  /** A pause is never longer than this, whatever /data holds. */
  pauseMax: HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** "Test the connection" reads at most this often; it answers within 25 s (Gladys waits 30 s). */
  testCooldown: 10 * SECOND,
  testBudget: 25 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): written by 3.5 s after the click
   * or refused unsent; the answer awaited until 4.3 s, after which the command
   * is "sent, without confirmation" and read again later.
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** An Off not sent at once is tried again during this budget. */
  protectiveRetry: 250,
  protectiveRetryGap: 50,
  /** An Off without answer for this long is cut when another Off waits. */
  stuckProtective: SECOND,
  /** Between two requests to one fan (after the previous connection is closed). */
  laneGap: 10,
  /** A request cut by an Off is closed within this (socket destroyed). */
  cutWait: 500,
  /** Reads after a command: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /**
   * An Off held that never left (or whose last send got no answer) is sent again this often,
   * whatever the pause of the reads: it leaves within this once the fan answers again.
   */
  guardProbe: 10 * SECOND,
  /** An Off the reads contradict is sent again this many times at most (counted when sent). */
  resendMax: 3,
  /** The configuration of Gladys not read: new tries 5 s, 15 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE],
  /** A click while the configuration is unread asks for it (2 s apart at most) and waits this long. */
  configAskGap: 2 * SECOND,
  configWait: 3 * SECOND,
  /** A read or a save of /data is waited for this long at most (never a wait that holds an Off). */
  storeWait: 1_500,
  /** The information of a fan (name, model) is read again at most this often. */
  infoEvery: HOUR,
};
