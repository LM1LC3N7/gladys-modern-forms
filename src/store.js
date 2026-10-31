// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), bounded and checked when read back:
//   - per address: the time of the last read attempt (a restart never reads
//     sooner) and the pause after failed reads;
//   - per fan (its id, the 12 hex digits of its `clientId`): the address it
//     was last read at (an Off can leave before the first read);
//   - the Offs to send again (guards): fan or light, the address, how many
//     times they were sent again, whether a read showed them applied.
// Nothing else (no name, no e-mail of the owner). A small JSON file, written
// through a temporary file and a rename, one save after the other (never
// stuck behind one that hangs), readable by the container user only (0600).
// Only a plain file is read (a FIFO would never end, a link points
// elsewhere). The app bounds every read and save of it (src/app.js): a /data
// that does not answer is unreadable or not written, never a wait.
// -----------------------------------------------------------------------------

import * as fsPromises from 'node:fs/promises';
import { constants } from 'node:fs';
import { LIMITS, PARTS, TIMINGS } from './constants.js';
import { addressOf } from './config.js';
import { isId } from './fan/model.js';

export const STATE_FILE = '/data/modern-forms-state.json';
export const FORMAT = 1;
/** A larger file is not ours: refused (read bounded). */
const MAX_STATE_BYTES = 128 * 1024;

/**
 * The /data file. Saves go one after the other, but a save never waits more than
 * `queueWait` for the one before it (a frozen fsync, say): it then writes through a
 * temporary file of its own, and an older write that ends after a newer one is in place
 * drops its file instead of renaming it over the newer state. Taken from gladys-ipx800
 * 0.1.3; the read refuses what is not a plain file.
 */
export function fileStore(
  path = STATE_FILE,
  { fs = fsPromises, timers = globalThis, queueWait = TIMINGS.storeWait } = {},
) {
  let previous = Promise.resolve();
  let count = 0;
  let placed = 0;
  let sharedBusy = false;
  return {
    /** null when there is no file (a fresh install); throws when it cannot be read or parsed. */
    async load() {
      let stats;
      try {
        stats = await fs.lstat(path);
      } catch (err) {
        if (err?.code === 'ENOENT') return null;
        throw err;
      }
      if (!stats.isFile()) throw Object.assign(new Error('not a plain file'), { code: 'EFTYPE' });
      if (stats.size > MAX_STATE_BYTES) throw new Error('state file too large');
      // Opened without blocking (a FIFO put there meanwhile would hold the open), checked again.
      const file = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const again = await file.stat();
        if (!again.isFile()) throw Object.assign(new Error('not a plain file'), { code: 'EFTYPE' });
        if (again.size > MAX_STATE_BYTES) throw new Error('state file too large');
        const text = await file.readFile('utf8');
        if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error('state file too large');
        return JSON.parse(text);
      } finally {
        await file.close();
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const seq = ++count;
      const before = previous;
      const write = (async () => {
        let timer;
        await Promise.race([
          before,
          new Promise((resolve) => {
            timer = timers.setTimeout(resolve, queueWait);
          }),
        ]);
        timers.clearTimeout(timer);
        const shared = !sharedBusy;
        if (shared) sharedBusy = true;
        const temporary = shared ? `${path}.tmp` : `${path}.tmp-${seq}`;
        try {
          const file = await fs.open(temporary, 'w', 0o600);
          try {
            await file.writeFile(text, 'utf8');
            await file.sync();
          } finally {
            await file.close();
          }
          if (seq < placed) {
            await fs.unlink(temporary).catch(() => {});
            return;
          }
          await fs.rename(temporary, path);
          placed = Math.max(placed, seq);
        } finally {
          if (shared) sharedBusy = false;
        }
      })();
      previous = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests). `fail`: the next saves throw; `unreadable`: load throws; `hang`: never answers. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    fail: false,
    unreadable: false,
    hang: false,
    hangLoad: false,
    async load() {
      if (this.hangLoad) return new Promise(() => {});
      if (this.unreadable) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const time = (value) => (Number.isFinite(value) && value > 0 ? value : undefined);
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value);

/** A guard read back; undefined when not valid. A count of tries that cannot be read is 0. */
function guardOf(raw) {
  if (!plain(raw) || !isId(raw.id) || !Object.values(PARTS).includes(raw.part)) return undefined;
  if (!addressOf(raw.address)) return undefined;
  return {
    id: raw.id,
    part: raw.part,
    address: raw.address,
    resends: Number.isInteger(raw.resends) ? Math.min(Math.max(raw.resends, 0), 99) : 0,
    confirmed: raw.confirmed === true,
    other: typeof raw.other === 'boolean' ? raw.other : undefined,
  };
}

/** An empty memory. */
export const emptyMemory = () => ({ format: FORMAT, fans: {}, links: {}, guards: [] });

/**
 * The persisted state, repaired; a time in the future is invalid (dropped), the end of a
 * pause is capped from `now`, so a clock jump or a hand-edited file never stops the reads
 * for good.
 */
export function normalizeMemory(raw, now = Date.now()) {
  const memory = emptyMemory();
  if (!plain(raw)) return memory;
  if (plain(raw.fans)) {
    for (const [id, entry] of Object.entries(raw.fans).slice(0, LIMITS.remembered)) {
      if (isId(id) && plain(entry) && addressOf(entry.address)) {
        memory.fans[id] = { address: entry.address };
      }
    }
  }
  if (plain(raw.links)) {
    for (const [key, entry] of Object.entries(raw.links).slice(0, LIMITS.remembered)) {
      if (!addressOf(key) || !plain(entry)) continue;
      const out = {};
      const last = time(entry.lastAttemptAt);
      // A date in the future is not one (a clock set back, a hand-edited file).
      if (last !== undefined && last <= now) out.lastAttemptAt = last;
      const p = entry.pause;
      if (plain(p) && time(p.until)) {
        out.pause = {
          until: Math.min(p.until, now + TIMINGS.pauseMax),
          failures: Number.isInteger(p.failures) && p.failures >= 0 ? Math.min(p.failures, 10) : 0,
          code: p.code === 'busy' ? 'busy' : 'failed',
        };
      }
      memory.links[key] = out;
    }
  }
  if (Array.isArray(raw.guards)) {
    const seen = new Set();
    for (const entry of raw.guards.slice(0, LIMITS.guards)) {
      const guard = guardOf(entry);
      const key = guard && `${guard.id}:${guard.part}`;
      if (guard && !seen.has(key)) {
        seen.add(key);
        memory.guards.push(guard);
      }
    }
  }
  return memory;
}
