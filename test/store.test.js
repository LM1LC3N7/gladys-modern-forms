// -----------------------------------------------------------------------------
// /data: the file read back strictly, bounded; a special file refused; the
// temporary folders of the tests removed.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory } from '../src/store.js';

async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mf-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const NOW = Date.UTC(2026, 9, 31, 12);

test('saved and read back; the file is 0600; no file is null', async (t) => {
  const dir = await folder(t);
  const store = fileStore(join(dir, 's.json'));
  assert.equal(await store.load(), null);
  const memory = {
    format: 1,
    fans: { c82b9698e5ac: { address: '192.168.1.60:80' } },
    links: {},
    guards: [],
  };
  await store.save(memory);
  assert.deepEqual(await store.load(), memory);
  assert.equal((await stat(join(dir, 's.json'))).mode & 0o777, 0o600);
});

test('a FIFO, a link, a folder, a large or broken file: unreadable (throws), never a wait', async (t) => {
  const dir = await folder(t);
  const fifo = join(dir, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(fileStore(fifo).load(), /not a plain file/);
  await writeFile(join(dir, 'real.json'), '{}');
  await symlink(join(dir, 'real.json'), join(dir, 'link.json'));
  await assert.rejects(fileStore(join(dir, 'link.json')).load(), /not a plain file/);
  await assert.rejects(fileStore(dir).load(), /not a plain file/);
  await writeFile(join(dir, 'big.json'), ' '.repeat(200 * 1024));
  await assert.rejects(fileStore(join(dir, 'big.json')).load(), /too large/);
  await writeFile(join(dir, 'broken.json'), '{');
  await assert.rejects(fileStore(join(dir, 'broken.json')).load());
});

test('normalizeMemory: only valid entries; future dates dropped; pauses capped; tries unreadable = 0', () => {
  const memory = normalizeMemory(
    {
      fans: {
        c82b9698e5ac: { address: '192.168.1.60:80' },
        nothex: { address: '192.168.1.61:80' },
        c8934683def0: { address: 'http://x/y' },
        __proto__: { address: '192.168.1.62:80' },
      },
      links: {
        '192.168.1.60:80': {
          lastAttemptAt: NOW + 60_000,
          pause: { until: NOW + 10 * 3600_000, failures: 3, code: 'busy' },
        },
        '192.168.1.61:80': { lastAttemptAt: NOW - 5000 },
        nope: { lastAttemptAt: NOW },
      },
      guards: [
        {
          id: 'c82b9698e5ac',
          part: 'fan',
          address: '192.168.1.60:80',
          resends: 'x',
          confirmed: 'yes',
        },
        { id: 'c82b9698e5ac', part: 'fan', address: '192.168.1.60:80', resends: 2 },
        { id: 'c82b9698e5ac', part: 'motor', address: '192.168.1.60:80' },
        { id: 'c82b9698e5ac', part: 'light', address: 'bad address', resends: 1 },
      ],
    },
    NOW,
  );
  assert.deepEqual(Object.keys(memory.fans), ['c82b9698e5ac']);
  assert.equal(memory.links['192.168.1.60:80'].lastAttemptAt, undefined, 'future: dropped');
  assert.equal(memory.links['192.168.1.60:80'].pause.until, NOW + 3600_000, 'capped to an hour');
  assert.equal(memory.links['192.168.1.61:80'].lastAttemptAt, NOW - 5000);
  assert.equal(memory.links.nope, undefined);
  assert.deepEqual(memory.guards, [
    {
      id: 'c82b9698e5ac',
      part: 'fan',
      address: '192.168.1.60:80',
      resends: 0,
      confirmed: false,
      left: false,
      other: undefined,
    },
  ]);
  assert.deepEqual(normalizeMemory('garbage', NOW).guards, []);
});

test('a save that hangs never blocks the next one (its own temporary file)', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 's.json');
  let hang = true;
  const fs = await import('node:fs/promises');
  const slow = {
    ...fs,
    open: async (...args) => {
      if (hang) {
        hang = false;
        return new Promise(() => {});
      }
      return fs.open(...args);
    },
  };
  const store = fileStore(path, { fs: slow, queueWait: 20 });
  store.save({ n: 1 });
  await store.save({ n: 2 });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 2 });
});

test('m2: a FIFO or a link left as the temporary file never blocks nor redirects a save', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 's.json');
  execFileSync('mkfifo', [`${path}.tmp`]);
  const store = fileStore(path);
  await store.save({ n: 1 });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 1 });
  await writeFile(join(dir, 'victim'), 'keep');
  await symlink(join(dir, 'victim'), `${path}.tmp`);
  await store.save({ n: 2 });
  assert.equal(await readFile(join(dir, 'victim'), 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 2 });
});

test('m2: an older save that ends after a newer one never puts its state back', async (t) => {
  const dir = await folder(t);
  const path = join(dir, 's.json');
  const fs = await import('node:fs/promises');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const slow = {
    ...fs,
    open: async (...args) => {
      const file = await fs.open(...args);
      if (!first) return file;
      first = false;
      return {
        ...file,
        writeFile: async (...w) => {
          await gate;
          return file.writeFile(...w);
        },
        sync: () => file.sync(),
        close: () => file.close(),
      };
    },
  };
  const store = fileStore(path, { fs: slow, queueWait: 20 });
  const old = store.save({ n: 1 });
  await store.save({ n: 2 });
  await store.save({ n: 3 });
  release();
  await old;
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { n: 3 });
});
