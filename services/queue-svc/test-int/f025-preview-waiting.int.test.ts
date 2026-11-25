// F-02-5(OPS-300) queue-svc 사전 모의 센 값: 시작 함수(src/start.ts)의 제어 전용 포트(PEAKET_QUEUE_CONTROL_GRPC_PORT)로 PreviewControl을 실제로 불러,
// 명령 3 키 waiting이 같은 시각 대기열 Redis에서 직접 센 값과 같은지 본다(C-T6 ①, ADR-0365 결정 11·16). 실제 Valkey 8.1.
// - 정본 셈(ADR-0365 결정 11 표, 계획 8.3): waiting = q:{event:E}:seq − q:{event:E}:serving − 건너뛴 구간의 번호 수.
//   건너뛴 구간은 q:{event:E}:skipped List의 줄 '{시작}:{끝}:{세대}'(docs/data.md §3, 끝 포함: 진입 Lua가 seq+1:seq+K로 적는다)이고,
//   serving 이하 번호는 이미 지났으므로(serving 전진은 구간째 뛴다, admission-ctrl TICK_LUA) serving보다 큰 번호만 뺀다. 아래 직접 셈(directWaiting)이 그 셈이다.
// - 시험 조립이 아니라 시작 파일 조립이다(계획 13절 '받는 쪽 셋의 PreviewControl 등록').
// - '아무것도 쓰지 않는다'(결정 16): 부르기 전후 그 회차 키의 값과 수명이 같고, 발급 원천이 없는 회차에는 키가 생기지 않는다.
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { start, type StartedService } from '../src/start.js';
import { freePort, status } from './control-client.js';
import { type PreviewClient, previewClient } from './preview-client.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const POD = 'queue-f025-a';
let valkey: ValkeyContainer;
let redis: HotRedis;
let svc: StartedService | undefined;
let client: PreviewClient;

const admissionKey = { ...(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'it-f025-q' };

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  const controlPort = await freePort();
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_POD: POD,
      PEAKET_QUEUE_REDIS_URL: valkey.url,
      PEAKET_QUEUE_TOKEN_KEY: `k1:${Buffer.alloc(32, 3).toString('base64')}`,
      PEAKET_ADMISSION_TOKEN_KEY: JSON.stringify(admissionKey),
      PEAKET_ADMISSION_TOKEN_ISSUER: 'https://queue.peaket.example',
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_QUEUE_CONTROL_GRPC_PORT: String(controlPort),
      PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(await freePort()),
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'fatal',
    },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  client = previewClient(`127.0.0.1:${controlPort}`);
}, 120_000);

afterAll(async () => {
  client?.close();
  await svc?.close();
  await redis?.close();
  valkey?.stop();
});

const k = {
  seq: (e: string) => `q:{event:${e}}:seq`,
  serving: (e: string) => `q:{event:${e}}:serving`,
  skipped: (e: string) => `q:{event:${e}}:skipped`,
};
const cmd = (args: string[]) => redis.command(args, { key: args[1]! });

/** 회차 하나의 대기열 상태를 심는다(수명은 판매 종료 + 1일과 비슷하게 하루 뒤) */
async function seed(e: string, o: { seq?: number; serving?: number; skipped?: readonly string[] }): Promise<void> {
  if (o.seq !== undefined) await cmd(['SET', k.seq(e), String(o.seq), 'PX', String(86_400_000)]);
  if (o.serving !== undefined) await cmd(['SET', k.serving(e), String(o.serving), 'PX', String(86_400_000)]);
  if (o.skipped?.length) await cmd(['RPUSH', k.skipped(e), ...o.skipped]);
}

/** 직접 센 대기 인원(정본 셈): seq − serving − (serving보다 크고 seq 이하인 건너뛴 번호 수) */
async function directWaiting(e: string): Promise<number> {
  const seq = Number((await cmd(['GET', k.seq(e)])) ?? 0);
  const serving = Number((await cmd(['GET', k.serving(e)])) ?? 0);
  const lines = ((await cmd(['LRANGE', k.skipped(e), '0', '-1'])) as unknown[]).map(String);
  let skipped = 0;
  for (const line of lines) {
    const [a, b] = line.split(':').map(Number) as [number, number];
    const lo = Math.max(a, serving + 1);
    const hi = Math.min(b, seq);
    if (hi >= lo) skipped += hi - lo + 1;
  }
  return seq - serving - skipped;
}

/** 그 회차 대기열 키의 값·수명 사진(쓰기 0 확인용) */
async function snapshot(e: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of [k.seq(e), k.serving(e), k.skipped(e)]) {
    const type = String(await cmd(['TYPE', key]));
    const value = type === 'list' ? await cmd(['LRANGE', key, '0', '-1']) : type === 'string' ? await cmd(['GET', key]) : null;
    const ttl = Number(await cmd(['PTTL', key]));
    out[key] = { type, value, ttlKnown: ttl === -2 ? 'none' : ttl === -1 ? 'persist' : 'set' };
  }
  return out;
}

const waitingOf = (scope: string) => client.preview({ scope, kind: 'CONTROL_KIND_SALE_PAUSE', keys: ['waiting'] });

describe('C-T6 ① queue-svc PreviewControl waiting = 같은 시각 대기열 Redis (시작 파일 조립)', () => {
  const cases: { name: string; seq: number; serving?: number; skipped?: string[]; expected: number }[] = [
    { name: '건너뛴 구간 없음', seq: 1_000, serving: 200, expected: 800 },
    { name: 'serving 없음(아직 아무도 안 부름)', seq: 300, expected: 300 },
    { name: 'serving 위 건너뛴 구간 둘(세대 1·2)', seq: 5_000, serving: 1_000, skipped: ['3001:3500:1', '4001:4100:2'], expected: 3_400 },
    { name: '이미 지난 건너뛴 구간(serving 아래)은 빼지 않는다', seq: 2_000, serving: 1_500, skipped: ['101:600:1'], expected: 500 },
    { name: 'serving에 걸친 건너뛴 구간은 serving 위 몫만 뺀다', seq: 2_000, serving: 1_200, skipped: ['1001:1400:1'], expected: 600 },
    { name: '모두 불렀으면 0', seq: 9_999, serving: 9_999, expected: 0 },
  ];

  for (const c of cases) {
    test(`C-T6 ① waiting 센 값 = seq − serving − 건너뛴 구간 번호 수 (${c.name})`, async () => {
      const e = randomUUID();
      await seed(e, c);
      const before = await snapshot(e);
      const t0 = Date.now();
      const r = await waitingOf(e);
      const t1 = Date.now();
      const direct = await directWaiting(e);
      expect(direct, '직접 셈이 정본 셈의 손 계산과 같다').toBe(c.expected);
      expect(r.unavailable).toEqual([]);
      expect(r.counts.map((x) => [x.key, x.value])).toEqual([['waiting', direct]]);
      // 센 시각은 읽은 때다(컨테이너 시계 차이를 1초까지 둔다)
      expect(r.counts[0]!.measuredAtMs).toBeGreaterThanOrEqual(t0 - 1_000);
      expect(r.counts[0]!.measuredAtMs).toBeLessThanOrEqual(t1 + 1_000);
      expect(r.podName).toMatch(new RegExp(`^${POD}`));
      expect(await snapshot(e), 'PreviewControl은 아무것도 쓰지 않는다').toEqual(before);
    });
  }
});

describe('F025-PREVIEW queue-svc 실제 포트의 세지 못함·꼴 (B21·B22)', () => {
  test('F025-PREVIEW ⑧ 발급 번호 키가 없는 회차는 no-source이고 그 회차의 키를 만들지 않는다', async () => {
    const e = randomUUID();
    const r = await waitingOf(e);
    expect(r.counts).toEqual([]);
    expect(r.unavailable).toEqual([{ key: 'waiting', reason: 'no-source' }]);
    const made = (await redis.command(['KEYS', `q:{event:${e}}*`], { key: `q:{event:${e}}` })) as unknown[];
    expect(made).toEqual([]);
  });

  test('F025-PREVIEW ⑨ 대문자 범위·키 17개는 INVALID_ARGUMENT, 명령 1 종류는 UNIMPLEMENTED다', async () => {
    const e = randomUUID();
    await seed(e, { seq: 10, serving: 1 });
    await expect(client.preview({ scope: e.toUpperCase(), kind: 'CONTROL_KIND_SALE_PAUSE', keys: ['waiting'] })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(client.preview({ scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', keys: Array.from({ length: 17 }, (_, i) => `k${i}`) })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(client.preview({ scope: e, kind: 'CONTROL_KIND_ADMISSION_TARGET', keys: ['currentTarget'] })).rejects.toMatchObject({ code: status.UNIMPLEMENTED });
  });
});
