// F-02-5(OPS-300) purchase-svc 사전 모의 센 값: 시작 함수(src/start.ts)의 제어 전용 포트(PEAKET_PURCHASE_CONTROL_GRPC_PORT)로 PreviewControl을 실제로 불러,
// 명령 3 키 넷이 같은 시각 좌석 Redis·purchase DB에서 직접 센 값과 같은지 본다(C-T6 ①, ADR-0365 결정 11·16). 실제 PostgreSQL 18·Valkey 8.1.
// - 정본 셈(ADR-0365 결정 11 표·결정 16):
//   purchaseSessions = 정리 색인 s:{event:E}:sessions 멤버 수(ZCARD),
//   paymentSessions = 그 멤버 가운데 세션 상태 s:session:{jti}의 pay가 '1'인 수(docs/data.md §3 s:session 'pay는 주문을 만든 뒤 결제가 끝날 때까지 1'),
//   holdsPerSecond5m = purchase DB 홀드 원장 seat_hold에서 최근 5분에 잡힌(held_at) 홀드 수 ÷ 300,
//   paymentAcceptsPerSecond5m = 주문(purchase_order)의 결제 접수 시각(payment_attempt.accepted_at)이 최근 5분인 수 ÷ 300 — 세는 데 쓸 칸이 없다고 구현이 판단하면 no-source(결정 16).
//   홀드는 좌석 하나짜리로만 심어, 홀드 수를 행으로 세든 holdId로 세든 같게 둔다. 시각은 5분 경계에서 몇 초 떨어뜨려 실제 시계로도 갈리지 않게 한다.
// - 계획 14절 1: 색인 멤버가 10,000개 [가정]를 넘으면 세션 키 둘은 too-many(정각 10,000은 센다).
// - '아무것도 쓰지 않는다'(결정 16): 부르기 전후 색인·세션 상태가 같다. 색인 점수는 1시간 뒤라 파드의 정리 반복도 건드리지 않는다.
// - 시험 조립이 아니라 시작 파일 조립이다(계획 13절).
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createHotRedis, type HotRedis, systemClock, uuidv7 } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensurePurchaseOutboxPartitions, ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import { start, type StartedService } from '../src/start.js';
import { newKey } from '../test/admission-fixtures.js';
import { freePort, status } from '../../queue-svc/test-int/control-client.js';
import { type PreviewClient, previewClient } from '../../queue-svc/test-int/preview-client.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const POD = 'purchase-f025-a';
const MIN = 60_000;
const HOUR = 60 * MIN;
const FIVE_MIN_MS = 5 * MIN;
const PER_SECOND_DIVISOR = 300;
/** 계획 14절 1의 [가정] 상한 */
const PAYING_COUNT_MAX = 10_000;
const ADMISSION = newKey('it-f025-adm');
const ecdh = (() => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const j = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y!, d: j.d!, kid: 'it-f025-ecdh' };
})();

let pgc: PostgresContainer;
let admin: pg.Client;
let valkey: ValkeyContainer;
let redis: HotRedis;
let seatDir: string;
let svc: StartedService | undefined;
let client: PreviewClient;

beforeAll(async () => {
  [pgc, valkey] = await Promise.all([startPostgres(), startValkey()]);
  await migratePurchase(pgc.url);
  await ensurePurchaseOutboxPartitions(pgc.url);
  await ensureSeatHoldPartitions(pgc.url);
  admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  redis = await createHotRedis({ url: valkey.url });
  seatDir = await mkdtemp(join(tmpdir(), 'peaket-f025-'));
  const controlPort = await freePort();
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_POD: POD,
      HOSTNAME: POD,
      PEAKET_SEAT_REDIS_URL: valkey.url,
      PEAKET_DATABASE_URL: pgc.url,
      PEAKET_ORDER_CONSENT_VERSION: 'f025-v1',
      PEAKET_ADMISSION_JWKS: JSON.stringify({ keys: [{ ...ADMISSION.publicJwk, alg: 'ES256', use: 'sig' }] }),
      PEAKET_ADMISSION_ISSUER: 'https://queue.peaket.example',
      PEAKET_PURCHASE_ECDH_KEY: JSON.stringify(ecdh),
      PEAKET_SEATMAP_DIR: seatDir,
      PEAKET_PAYMENT_GRPC_ADDR: '127.0.0.1:1',
      PEAKET_TICKET_GRPC_ADDR: '127.0.0.1:1',
      PEAKET_PURCHASE_CONTROL_GRPC_PORT: String(controlPort),
      PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(await freePort()),
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'fatal',
    },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  client = previewClient(`127.0.0.1:${controlPort}`);
}, 240_000);

afterAll(async () => {
  client?.close();
  await svc?.close().catch(() => undefined);
  await redis?.close();
  await admin?.end().catch(() => undefined);
  valkey?.stop();
  pgc?.stop();
  if (seatDir) await rm(seatDir, { recursive: true, force: true });
});

const k = {
  index: (e: string) => `s:{event:${e}}:sessions`,
  session: (jti: string) => `s:session:{${jti}}`,
};
const cmd = (args: string[]) => redis.command(args, { key: args[1]! });

/** 색인 멤버 n개를 심고, 그 가운데 paying개는 pay='1', active개는 pay 없는 세션 상태를 둔다(나머지는 상태 없는 멤버) */
async function seedSessions(e: string, o: { members: number; paying: number; active: number }): Promise<string[]> {
  const jtis = Array.from({ length: o.members }, () => randomUUID());
  const score = String(Date.now() + HOUR);
  for (let i = 0; i < jtis.length; i += 1_000) {
    const part = jtis.slice(i, i + 1_000);
    await cmd(['ZADD', k.index(e), ...part.flatMap((j) => [score, j])]);
  }
  const now = Date.now();
  for (const [i, jti] of jtis.slice(0, o.paying + o.active).entries()) {
    const fields = ['acct', randomUUID(), 'login', randomUUID(), 'event', e, 'jny', randomUUID(), 'seq', '0', 'idle', String(now + 5 * MIN), 'started', String(now - MIN), 'max', String(now + HOUR)];
    if (i < o.paying) fields.push('pay', '1');
    await cmd(['HSET', k.session(jti), ...fields]);
  }
  return jtis;
}

/** 좌석 하나짜리 홀드 원장 행을 heldAt마다 하나 넣는다(상태는 돌려 가며: 놓은·만료된 홀드도 잡힌 홀드다) */
async function seedHolds(e: string, heldAts: readonly number[]): Promise<void> {
  const statuses = ['HELD', 'RELEASED', 'EXPIRED'];
  for (const [i, at] of heldAts.entries()) {
    await admin.query(
      `insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, held_at, expires_at, hold_id, purchase_session_id)
       values ($1, $2, $3, $4, $5, 'FAN', $6, $7, $8, $9)`,
      [e, randomUUID(), randomUUID(), String(1_000 + i), statuses[i % 3], new Date(at), new Date(at + 7 * MIN), randomUUID(), randomUUID()],
    );
  }
}

/** 결제 접수 시각이 acceptedAt인 주문·결제 시도를 하나씩 넣는다(주문 상태 이력 지연 제약을 지키려고 같은 트랜잭션에 이력 행을 함께 쓴다) */
async function seedAccepts(e: string, acceptedAts: readonly number[]): Promise<void> {
  for (const at of acceptedAts) {
    const orderId = uuidv7(systemClock);
    await admin.query('begin');
    await admin.query(
      `insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
       values ($1, $2, $3, 'ACCEPTED', 110000, 1, $4, 'f025-v1', 'PICK', $5, $6, $7)`,
      [orderId, randomUUID(), e, randomUUID(), new Date(at - MIN), randomUUID(), randomUUID()],
    );
    await admin.query(`insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) values ($1, 1, null, 'ACCEPTED', 'f025-seed', 'test', $2)`, [orderId, new Date(at)]);
    await admin.query(`insert into payment_attempt (id, order_id, pg, status, created_at, authenticated_at, accepted_at) values ($1, $2, 'TOSS', 'ACCEPTED', $3, $4, $4)`, [
      uuidv7(systemClock),
      orderId,
      new Date(at - MIN),
      new Date(at),
    ]);
    await admin.query('commit');
  }
}

/** 직접 센 값(같은 시각, nowMs 기준 최근 5분) */
async function direct(e: string, nowMs: number) {
  const purchaseSessions = Number(await cmd(['ZCARD', k.index(e)]));
  const members = ((await cmd(['ZRANGE', k.index(e), '0', '-1'])) as unknown[]).map(String);
  let paying = 0;
  for (const jti of members) if (String((await cmd(['HGET', k.session(jti), 'pay'])) ?? '') === '1') paying += 1;
  const since = new Date(nowMs - FIVE_MIN_MS);
  const holds = Number((await admin.query('select count(*)::int as n from seat_hold where event_id = $1 and held_at > $2', [e, since])).rows[0].n);
  const accepts = Number(
    (await admin.query('select count(*)::int as n from payment_attempt a join purchase_order o on o.id = a.order_id where o.event_id = $1 and a.accepted_at > $2', [e, since])).rows[0].n,
  );
  return { purchaseSessions, paymentSessions: paying, holdsPerSecond5m: holds / PER_SECOND_DIVISOR, paymentAcceptsPerSecond5m: accepts / PER_SECOND_DIVISOR, holds, accepts };
}

async function sessionSnapshot(e: string): Promise<unknown> {
  const index = await cmd(['ZRANGE', k.index(e), '0', '-1', 'WITHSCORES']);
  const members = ((await cmd(['ZRANGE', k.index(e), '0', '-1'])) as unknown[]).map(String);
  const states: unknown[] = [];
  for (const jti of members.slice(0, 50)) states.push(await cmd(['HGETALL', k.session(jti)]));
  return { index, states };
}

const KEYS = ['purchaseSessions', 'paymentSessions', 'holdsPerSecond5m', 'paymentAcceptsPerSecond5m'];
const previewOf = (scope: string, keys: readonly string[] = KEYS) => client.preview({ scope, kind: 'CONTROL_KIND_SALE_PAUSE', keys });

describe('C-T6 ① purchase-svc PreviewControl 센 값 = 같은 시각 좌석 Redis·purchase DB (시작 파일 조립)', () => {
  test('C-T6 ① 명령 3 키의 센 값이 같은 시각 좌석 Redis·purchase DB에서 직접 센 값과 같다', async () => {
    const e = uuidv7(systemClock);
    const other = uuidv7(systemClock);
    const now = Date.now();
    await seedSessions(e, { members: 23, paying: 6, active: 9 });
    await seedSessions(other, { members: 4, paying: 4, active: 0 });
    // 최근 5분 안 17건(10초 전 ~ 4분 50초 전), 밖 5건(5분 10초 전·1시간 전), 다른 회차 3건
    await seedHolds(e, [...Array.from({ length: 17 }, (_, i) => now - 10_000 - i * 16_000), ...Array.from({ length: 4 }, () => now - FIVE_MIN_MS - 10_000), now - HOUR]);
    await seedHolds(other, [now - 1_000, now - 2_000, now - 3_000]);
    await seedAccepts(e, [now - 20_000, now - 2 * MIN, now - FIVE_MIN_MS + 15_000, now - FIVE_MIN_MS - 15_000]);
    await seedAccepts(other, [now - 5_000]);
    const before = await sessionSnapshot(e);

    const t0 = Date.now();
    const r = await previewOf(e);
    const t1 = Date.now();
    const d = await direct(e, t1);
    expect(d, '시험 세계(손 계산)').toMatchObject({ purchaseSessions: 23, paymentSessions: 6, holds: 17, accepts: 3 });

    const byKey = Object.fromEntries(r.counts.map((c) => [c.key, c]));
    expect(byKey.purchaseSessions?.value).toBe(d.purchaseSessions);
    expect(byKey.paymentSessions?.value).toBe(d.paymentSessions);
    expect(byKey.holdsPerSecond5m?.value).toBe(d.holdsPerSecond5m);
    // 결제 접수: 센 값이면 직접 센 값과 같아야 하고, 아니면 no-source(세는 칸이 없다는 구현 판단, ADR-0365 결정 16)만 된다. 0으로 덮지 않는다
    const accepts = byKey.paymentAcceptsPerSecond5m;
    if (accepts) expect(accepts.value).toBe(d.paymentAcceptsPerSecond5m);
    else expect(r.unavailable).toContainEqual({ key: 'paymentAcceptsPerSecond5m', reason: 'no-source' });
    expect(r.counts.length + r.unavailable.length).toBe(KEYS.length);
    for (const c of r.counts) {
      expect(c.measuredAtMs).toBeGreaterThanOrEqual(t0 - 1_000);
      expect(c.measuredAtMs).toBeLessThanOrEqual(t1 + 1_000);
    }
    expect(r.podName.startsWith(POD), `pod_name=${r.podName}`).toBe(true);
    expect(await sessionSnapshot(e), 'PreviewControl은 색인·세션 상태를 바꾸지 않는다').toEqual(before);
  });

  test('C-T6 ① 아무 기록도 세션도 없는 회차는 센 값 0이다(원천이 있고 0을 셌을 때)', async () => {
    const e = uuidv7(systemClock);
    const r = await previewOf(e, ['purchaseSessions', 'paymentSessions', 'holdsPerSecond5m']);
    expect(r.unavailable).toEqual([]);
    expect(Object.fromEntries(r.counts.map((c) => [c.key, c.value]))).toEqual({ purchaseSessions: 0, paymentSessions: 0, holdsPerSecond5m: 0 });
  });
});

describe('F025-PREVIEW purchase-svc 실제 포트의 세지 못함·꼴 (B21·B22)', () => {
  test(`F025-PREVIEW ⑩ 색인 멤버 ${PAYING_COUNT_MAX}개(상한 정각)는 세고, ${PAYING_COUNT_MAX + 1}개면 세션 키 둘이 too-many다`, async () => {
    const atMax = uuidv7(systemClock);
    await seedSessions(atMax, { members: PAYING_COUNT_MAX, paying: 2, active: 1 });
    const a = await previewOf(atMax, ['purchaseSessions', 'paymentSessions']);
    expect(Object.fromEntries(a.counts.map((c) => [c.key, c.value]))).toEqual({ purchaseSessions: PAYING_COUNT_MAX, paymentSessions: 2 });
    expect(a.unavailable).toEqual([]);

    const over = uuidv7(systemClock);
    await seedSessions(over, { members: PAYING_COUNT_MAX + 1, paying: 2, active: 1 });
    const b = await previewOf(over, ['purchaseSessions', 'paymentSessions', 'holdsPerSecond5m']);
    expect([...b.unavailable].sort((x, y) => x.key.localeCompare(y.key))).toEqual([
      { key: 'paymentSessions', reason: 'too-many' },
      { key: 'purchaseSessions', reason: 'too-many' },
    ]);
    expect(b.counts.map((c) => [c.key, c.value])).toEqual([['holdsPerSecond5m', 0]]);
  }, 120_000);

  test('F025-PREVIEW ⑪ 대문자 범위·PLATFORM·키 0개는 INVALID_ARGUMENT, 명령 1 종류는 UNIMPLEMENTED다', async () => {
    const e = uuidv7(systemClock);
    await expect(previewOf(e.toUpperCase())).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(previewOf('PLATFORM')).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(previewOf(e, [])).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(client.preview({ scope: e, kind: 'CONTROL_KIND_ADMISSION_TARGET', keys: ['currentTarget'] })).rejects.toMatchObject({ code: status.UNIMPLEMENTED });
  });
});
