// 생산자 시작 확인(checkProducerSchemas)과 설정 파일 읽기의 단위 시험(F-04-2 계획 §6 ST-T16 ②, ADR-0357 결정 4·5, docs/streaming.md ST-T16, D-T39 ③).
// 레지스트리 HTTP는 바깥 경계라 전역 fetch 자리에 Confluent REST 응답 모양만 내는 가짜(test/schema-registry-fake.ts)를 끼우고, 조회 자체는 진짜
// schemaRegistrySource가 한다(checkProducerSchemas가 환경 값으로 만든다). 실제 포트로 띄운 purchase-svc의 같은 흐름은 purchase-svc test-int/schema-registry-down.int.test.ts다.
// 단언 값은 정본에서 적는다: 다름·404는 시작하지 않음, 닿지 못하면 설정의 ID로 계속·경고 한 줄 {kind, subject, result: 'unavailable'}(주소·자격 없음)·
// 게이지 schema_startup_check_unavailable{subject} 1, 키 차례 무시, 주소가 없으면 local·ci만 skipped(결정 5). 스키마 ID는 17·101로 고른다.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@prometheus-io/client';
import { avroSchemas } from '@peaket/contracts/avro';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAvroEncoder } from '../src/avro-encoder.js';
import { PlatformConfigError } from '../src/config.js';
import { checkProducerSchemas, readSchemaIdsFile } from '../src/producer-schemas.js';
import { fakeRegistryFetch, registryState, type RegistryState } from './schema-registry-fake.js';

const ORDER = 'trade.orders-peaket.trade.OrderEvent';
const HOLD = 'telemetry.purchase-peaket.telemetry.HoldAttempt';
const IDS = { [ORDER]: 17, [HOLD]: 101 } as const;
const PRODUCES = [
  { topic: 'trade.orders', record: 'peaket.trade.OrderEvent' },
  { topic: 'telemetry.purchase', record: 'peaket.telemetry.HoldAttempt' },
];
const URL_HTTPS = 'https://registry.peaket.example';
const USER = 'purchase-svc-reader';
const PASSWORD = 'Pa55-w0rd!ps';
/** RFC 7617 Basic 값(base64("purchase-svc-reader:Pa55-w0rd!ps")) */
const BASIC = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;
const GAUGE = 'schema_startup_check_unavailable';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peaket-schema-ids-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 설정 파일을 쓰고 환경 값을 돌려준다 */
function envWith(over: Record<string, string | undefined> = {}, ids: Record<string, number> = IDS): Record<string, string | undefined> {
  const file = join(dir, 'schema-ids.json');
  writeFileSync(file, JSON.stringify(ids));
  return { PEAKET_ENV: 'staging', PEAKET_SCHEMA_IDS_FILE: file, PEAKET_SCHEMA_REGISTRY_URL: URL_HTTPS, PEAKET_SCHEMA_REGISTRY_USER: USER, PEAKET_SCHEMA_REGISTRY_PASSWORD: PASSWORD, ...over };
}

/** 레지스트리가 아는 스키마: 계약 판 그대로 */
const sameSchemas = (): RegistryState => registryState({ 17: avroSchemas['peaket.trade.OrderEvent'], 101: avroSchemas['peaket.telemetry.HoldAttempt'] });

/** 전역 fetch를 가짜 레지스트리로 바꾸고 부른 횟수를 센다 */
function stubRegistry(state: RegistryState, o: Parameters<typeof fakeRegistryFetch>[1] = {}): { calls: () => number } {
  const inner = fakeRegistryFetch(state, o);
  let calls = 0;
  vi.stubGlobal('fetch', ((input, init) => {
    calls += 1;
    return inner(input, init);
  }) as typeof fetch);
  return { calls: () => calls };
}

function harness(env: Record<string, string | undefined>) {
  const metrics = new Registry();
  const logs: { level: 'info' | 'warn'; o: object }[] = [];
  const encoder = createAvroEncoder({ schemaIds: readSchemaIdsFile(env), schemas: avroSchemas, produces: PRODUCES });
  const run = () =>
    checkProducerSchemas({ env, encoder, schemas: avroSchemas, metrics, logger: { info: (o) => void logs.push({ level: 'info', o }), warn: (o) => void logs.push({ level: 'warn', o }) } });
  const gauge = async (): Promise<Record<string, number>> => {
    const m = metrics.getSingleMetric(GAUGE);
    if (!m) return {};
    const got = await m.get();
    return Object.fromEntries(got.values.map((v) => [String(v.labels.subject), v.value]));
  };
  return { run, logs, gauge, metrics };
}

const sorted = (r: { subject: string; result: string }[]) => [...r].sort((a, b) => a.subject.localeCompare(b.subject));

describe('ST-T16 ② 레지스트리에 닿지 못함(ADR-0357 결정 5)', () => {
  test('ST-T16 ② 레지스트리에 닿지 못하면 설정의 ID로 계속하고 게이지가 1이다', async () => {
    for (const [name, opts, status] of [
      ['연결 거부', { down: () => true }, undefined],
      ['503', {}, 503],
      ['401', {}, 401],
    ] as const) {
      const state = sameSchemas();
      if (status !== undefined) state.status = status;
      const fetches = stubRegistry(state, opts);
      const h = harness(envWith());
      const result = await h.run();
      expect(sorted(result), name).toEqual([
        { subject: HOLD, result: 'unavailable' },
        { subject: ORDER, result: 'unavailable' },
      ]);
      expect(await h.gauge(), name).toEqual({ [ORDER]: 1, [HOLD]: 1 });
      // 레지스트리에 실제로 물었다(묻지 않고 'unavailable'로 끝나지 않는다)
      expect(fetches.calls(), name).toBeGreaterThanOrEqual(2);
      // 경고 한 줄씩, 주제와 결과만
      expect(h.logs.filter((l) => l.level === 'warn').map((l) => l.o).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), name).toEqual([
        { kind: 'schema-startup-check', subject: HOLD, result: 'unavailable' },
        { kind: 'schema-startup-check', subject: ORDER, result: 'unavailable' },
      ]);
      const text = JSON.stringify(h.logs);
      for (const banned of ['registry.peaket.example', USER, PASSWORD, BASIC.slice(6)]) expect(text.includes(banned), `${name}: ${banned}`).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  test('ST-T16 ② 응답이 시간 한도 안에 오지 않으면 닿지 못한 것으로 보고 계속한다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubRegistry(sameSchemas(), { delayMs: 60_000 });
    const h = harness(envWith());
    const p = h.run();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sorted(await p)).toEqual([
      { subject: HOLD, result: 'unavailable' },
      { subject: ORDER, result: 'unavailable' },
    ]);
    expect(await h.gauge()).toEqual({ [ORDER]: 1, [HOLD]: 1 });
  });

  test('ST-T16 ② 한 주제만 닿지 못하면 그 주제만 게이지 1이고 나머지는 0이다', async () => {
    const state = sameSchemas();
    stubRegistry(state, { reply: (r) => (state.requests.at(-1)?.endsWith('/101') ? new Response('{}', { status: 502 }) : new Response(r.body, { status: r.status, headers: r.headers })) });
    const h = harness(envWith());
    expect(sorted(await h.run())).toEqual([
      { subject: HOLD, result: 'unavailable' },
      { subject: ORDER, result: 'ok' },
    ]);
    expect(await h.gauge()).toEqual({ [ORDER]: 0, [HOLD]: 1 });
  });
});

describe('ST-T16 ② 레지스트리 답과 견주기(ADR-0357 결정 5)', () => {
  test('ST-T16 ② 같은 스키마면 ok·게이지 0이고 자격을 Basic으로 보낸다. 키 차례만 다르면 같다', async () => {
    const state = sameSchemas();
    stubRegistry(state);
    const h = harness(envWith());
    expect(sorted(await h.run())).toEqual([
      { subject: HOLD, result: 'ok' },
      { subject: ORDER, result: 'ok' },
    ]);
    expect(await h.gauge()).toEqual({ [ORDER]: 0, [HOLD]: 0 });
    expect(h.logs.filter((l) => l.level === 'warn')).toEqual([]);
    expect([...state.requests].sort()).toEqual(['/schemas/ids/101', '/schemas/ids/17']);
    expect(state.authorization).toEqual([BASIC, BASIC]);

    // 키 차례를 뒤집은 같은 스키마(배열 차례는 그대로)
    const reversed = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reversed) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v;
    const flipped = registryState({ 17: reversed(avroSchemas['peaket.trade.OrderEvent']), 101: reversed(avroSchemas['peaket.telemetry.HoldAttempt']) });
    expect(JSON.stringify(flipped.schemas.get(17))).not.toBe(JSON.stringify(avroSchemas['peaket.trade.OrderEvent']));
    vi.unstubAllGlobals();
    stubRegistry(flipped);
    expect(sorted(await harness(envWith()).run()).map((r) => r.result)).toEqual(['ok', 'ok']);
  });

  test('ST-T16 ② 그 ID가 다른 스키마를 가리키거나(다름) 레지스트리가 모르면(404) 시작하지 않는다', async () => {
    // 다름: 17번이 칸 하나가 빠진 OrderEvent(이번 판 전의 계약처럼)
    const order = avroSchemas['peaket.trade.OrderEvent'] as { fields: { name: string }[] };
    const older = { ...order, fields: order.fields.filter((f) => f.name !== 'fanNoticeReason') };
    stubRegistry(registryState({ 17: older, 101: avroSchemas['peaket.telemetry.HoldAttempt'] }));
    const mismatch = await harness(envWith()).run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(mismatch).toBeInstanceOf(PlatformConfigError);
    expect((mismatch as Error).message).toContain(ORDER);
    expect((mismatch as Error).message).not.toContain(HOLD);
    vi.unstubAllGlobals();

    // 404: 레지스트리가 101번을 모른다
    stubRegistry(registryState({ 17: avroSchemas['peaket.trade.OrderEvent'] }));
    const unknown = await harness(envWith()).run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(unknown).toBeInstanceOf(PlatformConfigError);
    expect((unknown as Error).message).toContain(HOLD);
  });
});

describe('ST-T16 ② 주소가 없을 때와 설정 파일(ADR-0357 결정 4·5, D-T39 ③)', () => {
  test('ST-T16 ② 주소가 없으면 local·ci는 확인을 건너뛰고(skipped) staging·prod·demo는 시작하지 않는다', async () => {
    const fetches = stubRegistry(sameSchemas());
    for (const env of ['local', 'ci']) {
      const h = harness(envWith({ PEAKET_ENV: env, PEAKET_SCHEMA_REGISTRY_URL: undefined, PEAKET_SCHEMA_REGISTRY_USER: undefined, PEAKET_SCHEMA_REGISTRY_PASSWORD: undefined }));
      expect(sorted(await h.run()), env).toEqual([
        { subject: HOLD, result: 'skipped' },
        { subject: ORDER, result: 'skipped' },
      ]);
      expect(await h.gauge(), env).toEqual({ [ORDER]: 0, [HOLD]: 0 });
      expect(h.logs.map((l) => l.level), env).toEqual(['info']);
    }
    for (const env of ['staging', 'prod', 'demo']) {
      const h = harness(envWith({ PEAKET_ENV: env, PEAKET_SCHEMA_REGISTRY_URL: undefined }));
      await expect(h.run(), env).rejects.toBeInstanceOf(PlatformConfigError);
    }
    expect(fetches.calls()).toBe(0);
  });

  test('ST-T16 ② 설정 파일이 없거나 틀리면 PlatformConfigError이고, 있으면 주제 → ID를 그대로 읽는다', () => {
    expect(readSchemaIdsFile(envWith())).toEqual({ [ORDER]: 17, [HOLD]: 101 });
    expect(() => readSchemaIdsFile({})).toThrow(PlatformConfigError);
    expect(() => readSchemaIdsFile({ PEAKET_SCHEMA_IDS_FILE: join(dir, 'none.json') })).toThrow(PlatformConfigError);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"trade.orders-peaket.trade.OrderEvent": "17"}');
    expect(() => readSchemaIdsFile({ PEAKET_SCHEMA_IDS_FILE: bad })).toThrow(PlatformConfigError);
  });
});
