// F-04-9 합성 시나리오·시드 재현 시험. 정본: docs/features/forensic-replay.md §5.1~§5.4·§8 FX-T1·FX-T2.
// 같은 시드·매개변수·생성기 판이면 열 배열이 같은 바이트가 되는지, 공유 주소가 그 값을 보존하는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COLUMN_SPECS, EVENT_KIND, MAX_EVENTS, SCHEMA_NAME, validateFile } from './events.ts';
import {
  DEFAULT_GENERATOR_VERSION,
  PRESETS,
  defaultParams,
  generateScenario,
  parseShareSearch,
  shareSearch,
  validateParams,
} from './scenario.ts';

const SMALL = {
  seats: 1_200,
  sectionCount: 4,
  queueSize: 3_000,
  windowMs: 120_000,
  botRatio: 0.3,
};

function smallParams(overrides = {}) {
  return { ...defaultParams('concert', 'seed-a'), ...SMALL, ...overrides };
}

function columnBytes(columns) {
  const chunks = [];
  for (const spec of COLUMN_SPECS) {
    const array = columns[spec.name];
    const width = { int32: 4, uint32: 4, uint16: 2, uint8: 1, float32: 4 }[spec.type];
    const view = new DataView(new ArrayBuffer(array.length * width));
    for (let i = 0; i < array.length; i += 1) {
      if (spec.type === 'int32') view.setInt32(i * width, array[i], true);
      else if (spec.type === 'uint32') view.setUint32(i * width, array[i], true);
      else if (spec.type === 'uint16') view.setUint16(i * width, array[i], true);
      else if (spec.type === 'uint8') view.setUint8(i * width, array[i]);
      else view.setFloat32(i * width, array[i], true);
    }
    chunks.push(Buffer.from(view.buffer));
  }
  return Buffer.concat(chunks);
}

function digest(scenario) {
  const meta = scenario.meta;
  const hash = createHash('sha256');
  hash.update(
    [
      meta.schema,
      meta.source,
      meta.seatCount,
      meta.sectionCount,
      meta.seed,
      meta.generatorVersion,
      meta.windowToMs,
      scenario.columns.t_ms.length,
    ].join('|'),
  );
  hash.update(columnBytes(scenario.columns));
  return hash.digest('hex');
}

test('FX-T1 ① 같은 시드·매개변수·생성기 판이면 같은 지문이다', () => {
  const a = generateScenario(smallParams());
  const b = generateScenario(smallParams());
  assert.equal(digest(a), digest(b));
  assert.ok(a.columns.t_ms.length > 0);
  assert.ok(a.columns.t_ms.length <= MAX_EVENTS);
  for (let i = 1; i < a.columns.t_ms.length; i += 1) assert.ok(a.columns.t_ms[i] >= a.columns.t_ms[i - 1]);
});

test('FX-T1 ② 다른 시드·매개변수·생성기 판이면 지문이 다르다', () => {
  const base = digest(generateScenario(smallParams()));
  assert.notEqual(digest(generateScenario(smallParams({ seed: 'seed-b' }))), base);
  assert.notEqual(digest(generateScenario(smallParams({ seats: 1_300 }))), base);
  assert.notEqual(digest(generateScenario(smallParams({ windowMs: 180_000 }))), base);
  assert.notEqual(digest(generateScenario(smallParams({ botRatio: 0.1 }))), base);
});

test('FX-T1 ③ 공유 주소는 시드와 매개변수만 싣고 왕복해도 같은 지문이다', () => {
  const params = smallParams({ seed: 'share-me', ordering: 'fifo', layout: 'circular', mimicBots: false });
  const search = shareSearch(params);
  assert.match(search, /^[?]/);
  assert.ok(!search.includes('state='));
  const parsed = parseShareSearch(search);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.params, params);
  assert.equal(digest(generateScenario(parsed.params)), digest(generateScenario(params)));

  const defaultRound = parseShareSearch('');
  assert.equal(defaultRound.ok, true);
  assert.equal(defaultRound.params.preset, 'concert');
  assert.equal(defaultRound.params.generatorVersion, DEFAULT_GENERATOR_VERSION);

  const wrongVersion = parseShareSearch(`?scenario=concert&seed=x&v=${DEFAULT_GENERATOR_VERSION + 1}`);
  assert.equal(wrongVersion.ok, false);
  assert.equal(wrongVersion.code, 'version');
  const badSeed = parseShareSearch('?scenario=concert&seed=%20bad&v=2');
  assert.equal(badSeed.ok, false);
  assert.equal(badSeed.code, 'seed');
  const badPreset = parseShareSearch('?scenario=nope&seed=x&v=2');
  assert.equal(badPreset.ok, false);
  assert.equal(badPreset.code, 'preset');
});

test('FX-T1 ③ 공유 주소는 windowMs와 botRatio를 반올림 없이 그대로 왕복한다', () => {
  const params = smallParams({ seed: 'decimal-share', windowMs: 120_500, botRatio: 0.335 });
  const parsed = parseShareSearch(shareSearch(params));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.params.windowMs, 120_500);
  assert.equal(parsed.params.botRatio, 0.335);
  assert.deepEqual(parsed.params, params);
});

test('FX-T1 ④ 생성기 코드에 금지 함수가 없다', () => {
  const files = ['prng.ts', 'cdf.ts', 'scenario.ts', 'checkpoint.ts', 'events.ts'];
  const forbidden =
    /Math\.(?:random|log|log10|log2|log1p|exp|expm1|pow|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot)\s*\(|Date\.now|performance\.now|new\s+Date\s*\(/;
  for (const file of files) {
    const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, forbidden, `${file}에 금지 함수가 있다`);
  }
});

test('FX-T1 ⑤ 프리셋 셋이 정본 §5.1과 같다', () => {
  assert.deepEqual(PRESETS.concert, {
    id: 'concert',
    label: '인기 콘서트 오픈',
    seats: 50_000,
    queueSize: 300_000,
    botRatio: 0.3,
    ordering: 'hybrid',
    layout: 'arena',
    mimicBots: false,
  });
  assert.deepEqual(PRESETS.sports, {
    id: 'sports',
    label: '스포츠 플레이오프 오픈',
    seats: 30_000,
    queueSize: 150_000,
    botRatio: 0.1,
    ordering: 'fifo',
    layout: 'circular',
    mimicBots: false,
  });
  assert.deepEqual(PRESETS.mimic, {
    id: 'mimic',
    label: '사람 흉내 봇',
    seats: 30_000,
    queueSize: 150_000,
    botRatio: 0.3,
    ordering: 'hybrid',
    layout: 'circular',
    mimicBots: true,
  });
  for (const id of ['concert', 'sports', 'mimic']) {
    const params = defaultParams(id, 'preset');
    assert.equal(params.preset, id);
    assert.equal(params.seats, PRESETS[id].seats);
    assert.equal(params.queueSize, PRESETS[id].queueSize);
    assert.equal(params.botRatio, PRESETS[id].botRatio);
  }
});

test('FX-T1 ⑥ 매개변수 허용 목록이 좌석·대기·시간창·봇 비율·판을 지킨다', () => {
  assert.equal(validateParams(smallParams()).ok, true);
  for (const bad of [
    smallParams({ seats: 999 }),
    smallParams({ seats: 100_001 }),
    smallParams({ sectionCount: 0 }),
    smallParams({ queueSize: 0 }),
    smallParams({ windowMs: 59_999 }),
    smallParams({ windowMs: 1_800_001 }),
    smallParams({ botRatio: -0.01 }),
    smallParams({ botRatio: 0.61 }),
    smallParams({ generatorVersion: 3 }),
    smallParams({ seed: '' }),
    smallParams({ seed: 'bad seed' }),
  ]) {
    assert.equal(validateParams(bad).ok, false, JSON.stringify(bad));
  }
});

test('FX-T2 ⑦ 생성한 파일이 v2 검증을 통과하고 원천별 칸을 지킨다', () => {
  const scenario = generateScenario(smallParams());
  const result = validateFile({
    meta: scenario.meta,
    schema: COLUMN_SPECS.map((c) => ({ name: c.name, type: c.type })),
    columns: scenario.columns,
    envelope: { fileName: 'scenario.arrow', byteLength: 1, magicHead: 'ARROW1', magicTail: 'ARROW1' },
    openedSource: 'SYNTHETIC',
  });
  assert.equal(result.ok, true);
  assert.equal(result.dropped, 0);
  assert.equal(result.kept, scenario.columns.t_ms.length);
  assert.equal(scenario.meta.schema, SCHEMA_NAME);
  assert.equal(scenario.meta.source, 'SYNTHETIC');
  for (let i = 0; i < scenario.columns.t_ms.length; i += 1) {
    assert.ok(scenario.columns.t_ms[i] >= -600_000 && scenario.columns.t_ms[i] <= scenario.meta.windowToMs);
    assert.equal(scenario.columns.member[i], 0);
    assert.equal(scenario.columns.post_seat[i], 0);
    if (scenario.columns.seat[i] !== 0xffffffff) {
      assert.ok(scenario.columns.seat[i] < scenario.meta.seatCount);
      assert.ok(scenario.columns.section[i] < scenario.meta.sectionCount);
    }
  }
  assert.ok(scenario.columns.kind.includes(EVENT_KIND.QUEUE_ENTER));
  assert.ok(scenario.columns.kind.includes(EVENT_KIND.ADMIT));
  assert.ok(scenario.columns.kind.includes(EVENT_KIND.HOLD_TRY));
  assert.ok(scenario.columns.kind.includes(EVENT_KIND.SALE));
  assert.ok(scenario.truth.sessions.some((s) => s.isBot));
  assert.ok(scenario.truth.sessions.some((s) => !s.isBot));
});

test('FX-T1 ⑧ 사람 흉내 봇 프리셋은 봇 등급 3단계이고 정답에 봇 클래스가 있다', () => {
  const params = { ...defaultParams('mimic', 'mimic-seed'), ...SMALL, preset: 'mimic', botRatio: 0.3, mimicBots: true };
  const scenario = generateScenario(params);
  const bots = scenario.truth.sessions.filter((s) => s.isBot);
  assert.ok(bots.length > 0);
  for (const bot of bots) {
    assert.equal(bot.botTier, 3);
    assert.ok(bot.botClass === 'VOLUME' || bot.botClass === 'SPEED' || bot.botClass === 'ACCOUNT' || bot.botClass === 'QUEUE');
  }
  assert.equal(scenario.stats.botCount, bots.length);
});
