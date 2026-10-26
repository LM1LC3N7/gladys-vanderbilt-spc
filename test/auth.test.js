import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorization, parseChallenge } from '../src/spc/auth.js';
import { GatewayClient } from '../src/spc/client.js';
import { createFakeClock } from './helpers/fakeClock.js';
import { createFakeGateway } from './helpers/fakeGateway.js';

test('Digest: the RFC 2617 example (MD5, qop auth)', () => {
  const challenge = parseChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  );
  assert.equal(challenge.scheme, 'digest');
  const header = authorization(
    challenge,
    { username: 'Mufasa', password: 'Circle Of Life' },
    'GET',
    '/dir/index.html',
    () => Buffer.from('0a4f113b', 'hex'),
  );
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /nc=00000001/);
  assert.match(header, /cnonce="0a4f113b"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  // The nonce counted.
  assert.match(
    authorization(challenge, { username: 'a', password: 'b' }, 'GET', '/', () => Buffer.alloc(8)),
    /nc=00000002/,
  );
});

test('challenges: Digest before Basic, unknown algorithms and auth-int only refused', () => {
  assert.equal(parseChallenge(['Basic realm="x"', 'Digest realm="x", nonce="n"']).scheme, 'digest');
  assert.equal(parseChallenge('Basic realm="x"').scheme, 'basic');
  assert.equal(parseChallenge('Digest realm="x", nonce="n", algorithm=SHA-512'), null);
  assert.equal(parseChallenge('Digest realm="x", nonce="n", qop="auth-int"'), null);
  assert.equal(parseChallenge('Bearer x'), null);
  assert.equal(parseChallenge(undefined), null);
  assert.equal(parseChallenge(`Basic realm="${'x'.repeat(3000)}"`), null);
  assert.equal(parseChallenge('Digest realm="x", nonce="n", stale=TRUE').stale, true);
  assert.equal(
    authorization({ scheme: 'basic' }, { username: 'u', password: 'p' }, 'GET', '/'),
    'Basic dTpw',
  );
});

function client(fake, credentials, options = {}) {
  const { clock, timers } = createFakeClock(0);
  fake.timers = timers;
  fake.clock = clock;
  return new GatewayClient({
    origin: 'http://gw:8088',
    credentials,
    request: fake.request,
    monotonic: () => clock.now,
    random: (n) => Buffer.alloc(n, 1),
    ...options,
  });
}

test('no credentials asked: nothing sent but the request; asked without credentials: AUTH_REQUIRED', async () => {
  const open = createFakeGateway();
  await client(open, { username: 'u', password: 'p' }).readAreas();
  assert.deepEqual(
    open.requests.map((r) => r.authorization),
    [false],
  );
  const closed = createFakeGateway({ auth: { scheme: 'digest', username: 'u', password: 'p' } });
  await assert.rejects(client(closed, null).readAreas(), { code: 'auth_required' });
});

test('Digest: answered once, the nonce reused, a stale nonce answered again', async () => {
  const fake = createFakeGateway({ auth: { scheme: 'digest', username: 'u', password: 'p' } });
  const c = client(fake, { username: 'u', password: 'p' });
  await c.readAreas();
  await c.readZones();
  assert.deepEqual(
    fake.requests.map((r) => r.authorization),
    [false, true, true],
  );
  fake.nonce = 'nonce-2';
  await c.readAreas();
  assert.equal(fake.requests.length, 5, 'the old nonce refused, answered on the new one');
});

test('refused: credentials built on a fresh challenge, or Basic credentials', async () => {
  const digest = createFakeGateway({ auth: { scheme: 'digest', username: 'u', password: 'p' } });
  await assert.rejects(client(digest, { username: 'u', password: 'bad' }).readAreas(), {
    code: 'auth_refused',
  });
  assert.equal(digest.requests.length, 2);
  const basic = createFakeGateway({ auth: { scheme: 'basic', username: 'u', password: 'p' } });
  const c = client(basic, { username: 'u', password: 'p' }, { allowBasic: true });
  await c.readAreas();
  basic.auth.password = 'changed';
  await assert.rejects(c.readAreas(), { code: 'auth_refused' });
  assert.equal(basic.requests.length, 3, 'a Basic refusal is final at once');
});

test('Basic: never answered unless allowed; never after Digest worked (no downgrade)', async () => {
  const basic = createFakeGateway({ auth: { scheme: 'basic', username: 'u', password: 'p' } });
  await assert.rejects(client(basic, { username: 'u', password: 'p' }).readAreas(), {
    code: 'auth_basic',
  });
  assert.deepEqual(
    basic.requests.map((r) => r.authorization),
    [false],
    'the password never sent',
  );
  const fake = createFakeGateway({ auth: { scheme: 'digest', username: 'u', password: 'p' } });
  const c = client(fake, { username: 'u', password: 'p' }, { allowBasic: true });
  await c.readAreas();
  assert.equal(c.learnedScheme, 'digest');
  fake.auth.scheme = 'basic';
  const before = fake.requests.length;
  await assert.rejects(c.readAreas(), { code: 'auth_downgrade' });
  assert.equal(fake.requests.length, before + 1, 'nothing sent in Basic');
  const pinned = client(
    fake,
    { username: 'u', password: 'p' },
    {
      allowBasic: true,
      pinnedScheme: 'digest',
    },
  );
  await assert.rejects(pinned.readAreas(), { code: 'auth_downgrade' });
});

test('a command answered after a challenge: the PUT is sent again once', async () => {
  const fake = createFakeGateway({ auth: { scheme: 'digest', username: 'u', password: 'p' } });
  const c = client(fake, { username: 'u', password: 'p' });
  await c.setMode('1', 'full_set', { deadline: 4000, sendBy: 3000 });
  assert.equal(fake.areas.get('1').mode, '3');
  assert.deepEqual(
    fake.requests.map((r) => `${r.method} ${r.authorization}`),
    ['PUT false', 'PUT true'],
  );
});
