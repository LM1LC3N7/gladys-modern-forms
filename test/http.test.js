// -----------------------------------------------------------------------------
// The client over real HTTP on 127.0.0.1 (the kit's server): the requests of
// the WAC reference, a big answer cut, a 404, a timeout, a cut by an Off.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FanClient, PRIORITY } from '../src/fan/client.js';
import { FanError } from '../src/fan/http.js';
import { httpServer, reply } from './kit/index.mjs';
import { fan } from './helpers/fakeFans.js';

async function server(t, routes, options = {}) {
  const srv = await httpServer({ routes, ...options });
  t.after(() => srv.close());
  return { srv, client: new FanClient({ host: '127.0.0.1', port: srv.port }) };
}

test('POST /mf with a JSON body; the state answered', async (t) => {
  const f = fan();
  const { srv, client } = await server(t, {
    'POST /mf': (r) => (r.json.queryStaticShadowData ? f.info : f.state),
  });
  const state = await client.readState();
  assert.equal(state.clientId, 'MF_C82B9698E5AC');
  const info = await client.readInfo(PRIORITY.READ);
  assert.equal(info.deviceName, 'Living Room');
  assert.equal(srv.requests[0].headers['content-type'], 'application/json');
  assert.equal(srv.requests[0].headers.accept, 'application/json');
  assert.deepEqual(srv.requests[0].json, { queryDynamicShadowData: 1 });
});

test('an answer larger than 16 KB is cut before it is read whole', async (t) => {
  const { client } = await server(t, { 'POST /mf': () => reply(200, 'x'.repeat(200_000)) });
  await assert.rejects(client.readState(), (err) => err instanceof FanError && err.code === 'size');
});

test('404 (generation 4), 503, a page that is not JSON, a JSON that is not an object', async (t) => {
  const { client: c404 } = await server(t, { 'POST /other': () => ({}) });
  await assert.rejects(c404.readState(), (err) => err.code === 'http' && err.status === 404);
  const { client: c503 } = await server(t, { 'POST /mf': () => reply(503, 'busy') });
  await assert.rejects(c503.readState(), (err) => err.code === 'busy' && err.sent === true);
  const { client: html } = await server(t, { 'POST /mf': () => reply(200, '<html>') });
  await assert.rejects(html.readState(), (err) => err.code === 'bad_response');
  const { client: list } = await server(t, { 'POST /mf': () => [1, 2] });
  await assert.rejects(list.readState(), (err) => err.code === 'bad_response');
});

test('a frozen answer times out at its deadline; an Off cuts a read at once', async (t) => {
  const { client } = await server(t, { 'POST /mf': 'silent' });
  const started = performance.now();
  await assert.rejects(
    client.readState(PRIORITY.READ, { deadline: performance.now() + 200 }),
    (err) => err.code === 'timeout' && err.sent === true,
  );
  assert.ok(performance.now() - started < 1500);
  const read = client.readState(PRIORITY.READ, { deadline: performance.now() + 5000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const off = client.write({ fanOn: false }, PRIORITY.PROTECTIVE, {
    deadline: performance.now() + 300,
  });
  await assert.rejects(read, (err) => err.code === 'cut');
  await assert.rejects(off, (err) => err instanceof FanError);
});

test('connection refused: "network", nothing sent', async () => {
  const client = new FanClient({ host: '127.0.0.1', port: 1 });
  await assert.rejects(client.readState(), (err) => err.code === 'network' && err.sent === false);
});
