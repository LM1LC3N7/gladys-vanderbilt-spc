import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanName,
  dataOf,
  parseArea,
  parseEvent,
  parseList,
  parseOne,
  parsePanel,
  parseZone,
} from '../src/spc/parse.js';
import { defaultAreas, defaultZones } from './helpers/fakeGateway.js';

const envelope = (data) => Buffer.from(JSON.stringify({ status: 'success', data }));

test('the envelope: data of a success, a failure is FAILED, anything else a bad answer', () => {
  assert.deepEqual(dataOf(envelope({ area: [] }), 'area'), []);
  assert.throws(() => dataOf(Buffer.from('{"status":"failed"}'), 'area'), { code: 'failed' });
  assert.throws(() => dataOf(Buffer.from('<html>'), 'area'), { code: 'bad_answer' });
  assert.throws(() => dataOf(envelope({}), 'area'), { code: 'bad_answer' });
  assert.throws(() => dataOf(Buffer.from('[1]'), 'area'), { code: 'bad_answer' });
  assert.equal(dataOf(Buffer.from('{"status":"success"}')), undefined);
});

test('areas and zones of the pyspcwebgw fixtures', () => {
  const areas = parseList(defaultAreas(), parseArea, 64);
  assert.deepEqual([...areas.byId.keys()], ['1', '3']);
  assert.deepEqual(areas.byId.get('1'), {
    id: '1',
    name: 'House',
    mode: 'unset',
    lastSetTime: 1485759851,
    lastUnsetTime: 1485800564,
  });
  const zones = parseList(defaultZones(), parseZone, 1024);
  assert.deepEqual(zones.byId.get('5'), {
    id: '5',
    name: 'Front door',
    area: '1',
    type: '1',
    input: '1',
    status: '0',
  });
  assert.equal(parseOne([defaultAreas()[0]], parseArea, '1').name, 'House');
  assert.throws(() => parseOne([defaultAreas()[0]], parseArea, '3'), { code: 'bad_answer' });
});

test('hostile entries: unknown codes unknown, bad ids dropped, duplicates and extras dropped', () => {
  assert.equal(parseArea({ id: '1', mode: '9' }).mode, null);
  assert.equal(parseArea({ id: '1', mode: '' }).mode, null);
  assert.equal(parseArea({ id: '1', mode: 3 }).mode, 'full_set');
  assert.equal(parseArea({ id: '1x', mode: '0' }), null);
  assert.equal(parseArea({ id: '12345', mode: '0' }), null);
  assert.equal(parseArea(JSON.parse('{"__proto__": {"id": "1"}}')), null);
  assert.equal(parseZone({ id: '2', input: '42', status: 'x' }).input, null);
  const list = parseList(
    [{ id: '1', mode: '0' }, { id: '01', mode: '3' }, null, 'x', { id: '2' }, { id: '3' }],
    parseArea,
    2,
  );
  assert.deepEqual([...list.byId.keys()], ['1', '2']);
  assert.equal(list.dropped, 4);
  assert.throws(() => parseList('x', parseArea, 2), { code: 'bad_answer' });
});

test('names: no control characters, capped', () => {
  assert.equal(cleanName('Front\r\ndoor '), 'Front  door');
  assert.equal(cleanName('x'.repeat(100)).length, 64);
  assert.equal(cleanName(12), '');
});

test('panel: the serial when it looks like one', () => {
  assert.equal(parsePanel({ sn: 'DEADBEEF', type: 'SPC4000' }).serial, 'DEADBEEF');
  assert.equal(parsePanel({ sn: 'a b' }).serial, null);
  assert.equal(parsePanel({}).serial, null);
  assert.throws(() => parsePanel(null), { code: 'bad_answer' });
});

test('websocket events: the code and the address, nothing else', () => {
  const text = JSON.stringify({
    data: { sia: { sia_code: 'NL', sia_address: '1', description: 'House¦Lisa¦9998' } },
  });
  assert.deepEqual(parseEvent(text), { code: 'NL', address: '1' });
  assert.equal(parseEvent('nope'), null);
  assert.equal(parseEvent('{"data":{"sia":{"sia_code":"nl"}}}'), null);
  assert.deepEqual(parseEvent('{"data":{"sia":{"sia_code":"CL","sia_address":"x"}}}'), {
    code: 'CL',
    address: null,
  });
});
