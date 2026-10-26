// -----------------------------------------------------------------------------
// The real HTTP transport on loopback: size cap, deadline, nothing sent when
// no connection, redirects never followed, a silent read cut.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { httpRequest } from '../src/spc/http.js';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('an answer above the cap is cut', async () => {
  const s = await serve((req, res) => res.end('x'.repeat(5000)));
  try {
    await assert.rejects(
      httpRequest({
        method: 'GET',
        origin: s.origin,
        path: '/spc/area',
        timeout: 2000,
        maxBytes: 1000,
      }),
      { code: 'too_large' },
    );
  } finally {
    await s.close();
  }
});

test('a redirect is returned, never followed (the credentials stay with the gateway)', async () => {
  const s = await serve((req, res) => {
    res.writeHead(302, { location: 'http://example.com/' });
    res.end();
  });
  try {
    const answer = await httpRequest({
      method: 'GET',
      origin: s.origin,
      path: '/spc/area',
      timeout: 2000,
      maxBytes: 1000,
    });
    assert.equal(answer.status, 302);
  } finally {
    await s.close();
  }
});

test('no connection: rejected, nothing sent', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  await new Promise((resolve) => blocker.close(resolve));
  let sent = false;
  await assert.rejects(
    httpRequest({
      method: 'PUT',
      origin: `http://127.0.0.1:${port}`,
      path: '/spc/area/1/set',
      timeout: 2000,
      maxBytes: 1000,
      onSent: () => {
        sent = true;
      },
    }),
    (err) => err.code === 'unreachable' && err.notSent === true,
  );
  assert.equal(sent, false);
});

test('a silent answer: the deadline, and the handle tells how long it was idle and cuts it', async () => {
  const s = await serve(() => {});
  try {
    await assert.rejects(
      httpRequest({
        method: 'GET',
        origin: s.origin,
        path: '/spc/area',
        timeout: 150,
        maxBytes: 1000,
      }),
      (err) => err.code === 'timeout' && err.notSent === false,
    );
    const pending = httpRequest({
      method: 'GET',
      origin: s.origin,
      path: '/spc/zone',
      timeout: 5000,
      maxBytes: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(pending.handle.idleFor() >= 100);
    pending.handle.abort();
    await assert.rejects(pending, { code: 'cut' });
  } finally {
    await s.close();
  }
});
