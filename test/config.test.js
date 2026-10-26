import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseHost, parseZoneKinds } from '../src/config.js';

test('the address: host, port, http only, nothing else', () => {
  assert.deepEqual(parseHost('192.168.1.10'), {
    origin: 'http://192.168.1.10:8088',
    hostname: '192.168.1.10',
    port: 8088,
    host: '192.168.1.10:8088',
  });
  assert.equal(parseHost('SPC.local:8080').origin, 'http://spc.local:8080');
  assert.equal(parseHost('http://10.0.0.2/').origin, 'http://10.0.0.2:8088');
  assert.deepEqual(parseHost(''), { error: 'empty' });
  assert.deepEqual(parseHost('https://10.0.0.2'), { error: 'https' });
  assert.deepEqual(parseHost('http://user:pw@10.0.0.2'), { error: 'credentials' });
  assert.deepEqual(parseHost('10.0.0.2/spc'), { error: 'invalid' });
  assert.deepEqual(parseHost('10.0.0.2?x=1'), { error: 'invalid' });
  assert.deepEqual(parseHost('ftp://10.0.0.2'), { error: 'invalid' });
});

test('credentials: both or none, sendable characters, the password never trimmed', () => {
  assert.equal(normalizeConfig({ host: 'a' }).credentials, null);
  assert.deepEqual(normalizeConfig({ host: 'a', username: ' u ', password: ' p ' }).credentials, {
    username: 'u',
    password: ' p ',
  });
  assert.equal(normalizeConfig({ host: 'a', password: 'p' }).credentialsError, 'password_alone');
  assert.equal(normalizeConfig({ host: 'a', username: 'u' }).credentialsError, 'username_alone');
  assert.equal(
    normalizeConfig({ host: 'a', username: 'u:x', password: 'p' }).credentialsError,
    'characters',
  );
  assert.equal(
    normalizeConfig({ host: 'a', username: 'u', password: 'p\r\nX: y' }).credentialsError,
    'characters',
  );
  assert.equal(normalizeConfig({ host: 'a', username: 'u', password: 'p\r\n' }).credentials, null);
});

test('unset is off by default; only true-like values allow it', () => {
  assert.equal(normalizeConfig({}).allowDisarm, false);
  assert.equal(normalizeConfig({ allow_disarm: 'yes' }).allowDisarm, false);
  assert.equal(normalizeConfig({ allow_disarm: true }).allowDisarm, true);
  assert.equal(normalizeConfig({ allow_disarm: 'true' }).allowDisarm, true);
});

test('zone kinds: number:kind, the rest counted, never kept', () => {
  const { kinds, invalid } = parseZoneKinds('5:opening, 012:motion;7:LEAK secret 9:door');
  assert.deepEqual(
    [...kinds],
    [
      ['5', 'opening'],
      ['12', 'motion'],
      ['7', 'leak'],
    ],
  );
  assert.equal(invalid, 2);
  assert.equal(normalizeConfig({ zone_kinds: 'x' }).zoneKindsInvalid, 1);
});
