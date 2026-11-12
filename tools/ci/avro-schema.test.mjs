// Avro 스키마 검사(BUILD_ORDER BAS-030, docs/api/avro/README.md §1·§3, D-T39·ST-T15) 시험.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSchema, compareWithBase, listAvsc, registerToRegistry, validateFile, validateTree } from './avro-schema.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(REPO, 'docs', 'api', 'avro');
const record = (name, fields = [], namespace = 'peaket.trade') => ({ type: 'record', name, namespace, fields });
const enumType = (name, symbols = ['UNRECOGNIZED', 'A'], def = 'UNRECOGNIZED') => ({ type: 'enum', name, symbols, default: def });
const field = (name, type, extra = {}) => ({ name, type, ...extra });
const temp = () => mkdtempSync(join(tmpdir(), 'avro-schema-'));

test('BAS-030: 저장소의 Avro 파일은 경로·네임스페이스·열거 기본 기호·필드 기본값 규칙을 지난다', () => {
  assert.equal(validateTree(ROOT).length, 0);
  assert.ok(listAvsc(ROOT).length >= 20);
  // 기본 root는 절대 경로다. contract-check가 --base와 함께 불러도 git 경로가 맞아야 한다
  assert.deepEqual(compareWithBase(ROOT, 'HEAD'), []);
});

test('BAS-030: 열거의 첫 기호와 기본값이 UNRECOGNIZED가 아니거나 기호가 겹치면 잡는다', () => {
  const dir = temp();
  try {
    const file = join(dir, 'peaket', 'trade', 'Thing.avsc');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record('Thing', [field('kind', enumType('ThingKind', ['A', 'UNRECOGNIZED'], 'A'))])));
    const errors = validateFile(dir, file, JSON.stringify(record('Thing', [field('kind', enumType('ThingKind', ['A', 'UNRECOGNIZED'], 'A'))])));
    assert.ok(errors.some((e) => e.includes('첫 기호')));
    assert.ok(errors.some((e) => e.includes('default')));
    writeFileSync(file, JSON.stringify(record('Thing', [field('kind', enumType('ThingKind', ['UNRECOGNIZED', 'A', 'A']))])));
    assert.ok(validateFile(dir, file, JSON.stringify(record('Thing', [field('kind', enumType('ThingKind', ['UNRECOGNIZED', 'A', 'A']))]))).some((e) => e.includes('겹친다')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BAS-030: 파일 경로와 네임스페이스·이름이 맞지 않으면 잡는다', () => {
  const dir = temp();
  try {
    const file = join(dir, 'peaket', 'trade', 'Wrong.avsc');
    mkdirSync(dirname(file), { recursive: true });
    const text = JSON.stringify(record('Thing', [], 'peaket.control'));
    writeFileSync(file, text);
    const errors = validateFile(dir, file, text);
    assert.ok(errors.some((e) => e.includes('namespace')));
    assert.ok(errors.some((e) => e.includes('name')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D-T39 ①: BACKWARD_TRANSITIVE에서 열거 기호를 지우거나 옛 기호 뒤에 새 기호를 끼우면 깨진다', () => {
  const old = record('Thing', [field('kind', enumType('ThingKind', ['UNRECOGNIZED', 'A', 'B']))]);
  const removed = record('Thing', [field('kind', enumType('ThingKind', ['UNRECOGNIZED', 'A']))]);
  assert.ok(compareSchema(old, removed).some((e) => e.includes('B')));
  const inserted = record('Thing', [field('kind', enumType('ThingKind', ['UNRECOGNIZED', 'A', 'C', 'B']))]);
  assert.ok(compareSchema(old, inserted).some((e) => e.includes('끝에 있지 않다')));
  const appended = record('Thing', [field('kind', enumType('ThingKind', ['UNRECOGNIZED', 'A', 'B', 'C']))]);
  assert.deepEqual(compareSchema(old, appended), []);
});

test('D-T39 ①: 기본값 없는 새 필드와 좁아진 형은 깨지고, null 유니온으로 넓힌 형은 통과한다', () => {
  const old = record('Thing', [field('n', 'long')]);
  assert.ok(compareSchema(old, record('Thing', [field('n', 'long'), field('x', 'string')])).some((e) => e.includes('기본값 없이')));
  assert.ok(compareSchema(old, record('Thing', [field('n', ['null', 'long'], { default: null }), field('x', 'string', { default: '' })])).length === 0);
  assert.ok(compareSchema(old, record('Thing', [field('n', 'int')])).some((e) => e.includes('형이 바뀌었다')));
  assert.deepEqual(compareSchema(old, record('Thing', [field('n', ['null', 'long'], { default: null })])), []);
});

test('D-T39 ①: 새 배열 필드는 기본값 []가 있어야 하고, 없으면 잡는다', () => {
  const old = record('EventSaleChanged', [field('status', 'string')]);
  const noDefault = record('EventSaleChanged', [field('status', 'string'), field('soldOutTiers', { type: 'array', items: 'string' })]);
  assert.ok(compareSchema(old, noDefault).some((e) => e.includes('soldOutTiers') && e.includes('기본값 없이')));
  const withDefault = record('EventSaleChanged', [
    field('status', 'string'),
    field('soldOutTiers', { type: 'array', items: 'string' }, { default: [] }),
  ]);
  assert.deepEqual(compareSchema(old, withDefault), []);
});

test('D-T39 ①: null 유니온 안 named enum의 기호 추가는 통과하고, 삭제·끼워 넣기는 잡는다', () => {
  const base = ['UNRECOGNIZED', 'CARD_DECLINED', 'PG_ERROR'];
  const schema = (symbols) => record('PaymentEvent', [
    field('failureCategory', ['null', enumType('PaymentEventFailureCategory', symbols)], { default: null }),
  ]);
  const old = schema(base);
  assert.deepEqual(compareSchema(old, schema([...base, 'DEPOSIT_CANCELED'])), []);
  assert.ok(compareSchema(old, schema(base.filter((s) => s !== 'PG_ERROR'))).some((e) => e.includes('PG_ERROR')));
  assert.ok(compareSchema(old, schema(['UNRECOGNIZED', 'CARD_DECLINED', 'DEPOSIT_CANCELED', 'PG_ERROR'])).some((e) => e.includes('끝에 있지 않다')));
  // 유니온에서 옛 갈래가 통째로 빠지는 것도 잡는다
  const oldUnion = record('Thing', [field('v', ['null', 'string'], { default: null })]);
  const narrowed = record('Thing', [field('v', ['null'], { default: null })]);
  assert.ok(compareSchema(oldUnion, narrowed).some((e) => e.includes('옛 갈래 string')));
});

test('D-T39 ④: 같은 판을 다시 등록해도 같은 스키마 ID가 돌아온다', async () => {
  const dir = temp();
  let id = 7;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const file = join(dir, 'peaket', 'trade', 'Thing.avsc');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record('Thing', [])));
    const url = `http://127.0.0.1:${server.address().port}`;
    const map = { 'peaket/trade/Thing.avsc': 'trade.things' };
    const a = await registerToRegistry(dir, url, map);
    id = 7;
    const b = await registerToRegistry(dir, url, map);
    assert.deepEqual(a.ids, { 'trade.things': 7 });
    assert.deepEqual(b.ids, { 'trade.things': 7 });
  } finally {
    await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ST-T15: 모르는 열거 기호를 UNRECOGNIZED로 바꾸는 공용 규칙은 스키마의 기본값과 함께 있어야 한다', () => {
  const schema = record('Thing', [field('kind', enumType('ThingKind', ['UNRECOGNIZED', 'A']))]);
  const kind = schema.fields[0].type;
  assert.equal(kind.symbols[0], 'UNRECOGNIZED');
  assert.equal(kind.default, 'UNRECOGNIZED');
  assert.ok(compareSchema(schema, schema).length === 0);
});

test('D-T39 ②④: 등록 도구는 주제-레코드 이름으로 스키마를 올리고 응답의 스키마 ID를 주제별로 돌려준다', async () => {
  const dir = temp();
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 42 }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const file = join(dir, 'peaket', 'trade', 'Thing.avsc');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record('Thing', [])));
    const url = `http://127.0.0.1:${server.address().port}`;
    const r = await registerToRegistry(dir, url, { 'peaket/trade/Thing.avsc': 'trade.things' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.ids, { 'trade.things': 42 });
    assert.equal(seen[0].url, `/subjects/${encodeURIComponent('trade.things-peaket.trade.Thing')}/versions`);
    assert.equal(JSON.parse(seen[0].body.schema).name, 'Thing');
    // 주제가 빠진 스키마는 올리지 않고 실패로 센다
    const bad = await registerToRegistry(dir, url, {});
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /topic-map/);
  } finally {
    await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
  }
});
