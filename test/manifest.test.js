// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS } from '../src/constants.js';
import { createdDevices } from './helpers/app.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; the version set by hand everywhere, never frozen here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.keywords, undefined, 'keywords need gladys_version >= 5.3.0 (TODO.md)');
  assert.equal(manifest.countries, undefined);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-vanderbilt-spc:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-vanderbilt-spc');
  assert.equal(lock.name, 'gladys-vanderbilt-spc');
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    '@gladysassistant/integration-sdk',
    'ws',
  ]);
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['security']);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien/);
  assert.match(read('docs/en.md'), /never been tested with a real panel/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec une vraie centrale/i);
});

test('the license and the notices ship in the image; no person named in LICENSE', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'the standard text');
  assert.match(read('THIRD_PARTY_NOTICES.md'), /pyspcwebgw[\s\S]*MIT License[\s\S]*Martin Berg/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /\bws\b[\s\S]*MIT/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; unsetting off by default; the secret without default', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'host',
    'username',
    'password',
    'allow_basic',
    'options_section',
    'allow_disarm',
    'zone_kinds',
    'language',
  ]);
  assert.equal(fields.allow_basic.type, 'boolean');
  assert.equal(fields.allow_basic.default, false);
  assert.match(fields.allow_basic.description.en, /readable by anyone listening/);
  assert.equal(fields.allow_disarm.type, 'boolean');
  assert.equal(fields.allow_disarm.default, false);
  assert.equal(fields.password.type, 'secret');
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.ok(!('default' in field), `${field.key}: no default on a secret`);
    assert.match(field.description.en, /Kept by Gladys in its database, never shown again/);
  }
  assert.ok(
    !manifest.config_schema.some((f) => f.key.startsWith('gladys_')),
    'GLADYS_* is the core',
  );
  assert.doesNotMatch(JSON.stringify(manifest), /chiffré|encrypted/i);
  assert.match(fields.options_section.description.en, /never a switch/);
  assert.match(fields.options_section.description.en, /listed in the documentation/);
  assert.match(fields.options_section.description.en, /false alarm/);
  for (const field of manifest.config_schema) {
    for (const text of Object.values(field.description ?? {})) assert.ok(text.length <= 1000);
  }
  assert.doesNotMatch(fields.options_section.description.en, /\b(always|never) (sent|refused)\b/);
});

test('sections store nothing', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('devices: no unit, no switch, no supported options; commands are push buttons', () => {
  const devices = createdDevices();
  for (const d of devices) {
    for (const f of d.features) {
      assert.equal(f.unit, undefined, f.external_id);
      assert.equal(f.supported_options, undefined, f.external_id);
      assert.notEqual(f.category, 'switch', f.external_id);
      if (!f.read_only) {
        assert.equal(f.category, 'button', f.external_id);
        assert.equal(f.type, 'push', f.external_id);
      }
    }
  }
  const area = devices.find((d) => d.external_id.endsWith(':area:1'));
  assert.deepEqual(
    area.features.filter((f) => !f.read_only).map((f) => f.external_id.split(':').at(-1)),
    ['arm-full', 'arm-part-a', 'arm-part-b', 'disarm'],
  );
});
