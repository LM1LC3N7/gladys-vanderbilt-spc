// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, never mojibake
// (UTF-8 bytes read as Latin-1 / Windows-1252 and saved again), never a
// control byte, and never describe a secret as "encrypted".
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Ã, Â: the first byte of a two-byte UTF-8 sequence read as Latin-1 (none of
// them is used in these English and French texts); â€: the curly quotes,
// dashes and ellipsis read as Windows-1252; Å’ / Å“: "Œ" / "œ" read so.
const MOJIBAKE = /Ã|Â|â€|Å[’“]/;
const sources = (dir) =>
  readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true })
    .filter((name) => String(name).endsWith('.js'))
    .map((name) => `${dir}/${String(name).replace(/\\/g, '/')}`);
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'index.js',
  ...sources('src'),
  // This file holds mojibake samples on purpose: every other test file is checked.
  ...sources('test').filter((name) => name !== 'test/encoding.test.js'),
];

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no mojibake, no control byte`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const line = text.split('\n').findIndex((l) => MOJIBAKE.test(l));
    assert.equal(line, -1, `mojibake on line ${line + 1}`);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(text, /[\x00-\x08\x0b\x0c\x0e-\x1f]/, 'control byte');
  });
}

test('no secret is described as encrypted', () => {
  for (const file of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
  ]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /chiffré|encrypted/i, file);
  }
});

test('the sources are all checked', () => {
  assert.ok(FILES.includes('src/i18n.js'));
  assert.ok(FILES.includes('src/spc/parse.js'));
  assert.ok(FILES.includes('test/helpers/fakeGateway.js'));
});

test('the mojibake pattern catches what it should', () => {
  assert.match('FranÃ§ais', MOJIBAKE, 'ç read as Latin-1');
  assert.match('Â«', MOJIBAKE, '« read as Latin-1');
  assert.match('lâ€™app', MOJIBAKE, '’ read as Windows-1252');
  assert.match('finâ€¦', MOJIBAKE, '… read as Windows-1252');
  assert.match('Å“uvre', MOJIBAKE, 'œ read as Windows-1252');
  assert.match('Ã ', MOJIBAKE, 'à read as Latin-1 (second byte lost)');
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app… 5 °C', MOJIBAKE);
});
