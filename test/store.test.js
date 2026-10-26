import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialsMark,
  fileStore,
  normalizeMemory,
  refusalOf,
  sameRefused,
  serializeMemory,
} from '../src/store.js';

const NOW = Date.parse('2026-10-26T08:00:00Z');

test('normalized: unknown keys dropped, times capped to now, old guards dropped', () => {
  const memory = normalizeMemory(
    JSON.parse(
      JSON.stringify({
        panel: 'DEADBEEF',
        lastAttemptAt: NOW + 1e9,
        extra: 1,
        guards: [
          { area: '1', mode: 'full_set', at: NOW + 5000, resends: 99, delivered: true },
          { area: '2', mode: 'unset', at: NOW },
          { area: '3', mode: 'part_set_a', at: NOW - 11 * 60_000 },
          { area: 'x', mode: 'full_set', at: NOW },
        ],
      }),
    ),
    NOW,
  );
  assert.equal(memory.panel, 'DEADBEEF');
  assert.equal(memory.lastAttemptAt, NOW);
  assert.deepEqual([...memory.guards.keys()], ['1']);
  assert.equal(memory.guards.get('1').at, NOW);
  assert.equal(memory.guards.get('1').resends, 3);
  assert.equal(normalizeMemory({ panel: 'a b' }, NOW).panel, null);
  assert.equal(normalizeMemory(JSON.parse('{"__proto__":{"panel":"X"}}'), NOW).panel, null);
  const round = serializeMemory(memory);
  assert.deepEqual(Object.keys(round), ['panel', 'lastAttemptAt', 'refused', 'guards']);
});

test('a refused password is kept as an 8-bit marker: never found back by brute force', () => {
  const refused = refusalOf({ username: 'u', password: '1234' }, NOW);
  assert.match(refused.mark, /^[0-9a-f]{2}$/);
  assert.ok(sameRefused(refused, { username: 'u', password: '1234' }));
  assert.ok(!sameRefused(refused, null));
  // Every 4-digit PIN tried: about 1 in 256 matches, the right one hides among ~40.
  let matches = 0;
  for (let pin = 0; pin < 10_000; pin += 1) {
    const candidate = { username: 'u', password: String(pin).padStart(4, '0') };
    if (credentialsMark(candidate, refused.salt) === refused.mark) matches += 1;
  }
  assert.ok(matches > 10, `${matches} candidates`);
  const kept = normalizeMemory({ refused }, NOW).refused;
  assert.deepEqual(kept, refused);
  assert.equal(normalizeMemory({ refused: { salt: 'x', mark: 'zz' } }, NOW).refused, null);
});

test('the file: 0600, written whole; an unreadable file is not a first start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spc-'));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ panel: 'DEADBEEF' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { panel: 'DEADBEEF' });
  await writeFile(path, 'not json');
  await assert.rejects(store.load(), { code: 'EINVAL' });
  await writeFile(path, 'x'.repeat(20_000));
  await assert.rejects(store.load(), { code: 'EFBIG' });
});
