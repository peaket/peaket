// F-03-3 OPS-380 T-30분 점검·Go/No-Go 판정 기록과 판단 위젯 원천(남은 허용 실패·포화도)의 실제 ops-svc + PostgreSQL 18 + Prometheus 통합 시험(시험 먼저, ADR-0372).
// 정본: docs/features/control-tower.md §2(필수 '노드 시계가 표준 시각과 어긋난 정도(오프셋) 20ms 이하', Go/No-Go 판정 문단: 필수 하나라도 실패면 No-Go, T-20분까지
// 다시 판정, 재판정도 감사 로그), C-T25 ①(오프셋 30ms → No-Go, 판정과 사유가 감사 로그), C-T30 ①(Redis 메모리가 주의 기준 위면 포화도 요약이 '주의'),
// §6의 3(연동 여정 넷: 좌석 홀드·좌석 상태 전파·결제 접수·결제 확정, ADR-0126), §2 '여정별 에러 버짓 잔량과 남은 허용 실패 건수(예: 결제 확정 12건 중 3건 사용)',
// docs/api/asyncapi.yaml OpsAlert.journey 열거(여정 일곱), 계획 docs/review/plans/F-03-3.md §4·§5 T1·T2·T3·T7·T8·6-3·6-4.
//
// 시험이 정한 원천 이름(정본에 이름이 없어 시험 먼저 절차에서 시험이 정한다. 구현은 같은 이름을 ADR-0371·docs/observability.md §8에 적는다. 다르게 하려면 계획 '시험 이의'):
//   시계 오프셋      node_timex_offset_seconds{instance}(node_exporter, 초. 노드마다 하나, 가장 크게 어긋난 노드로 판정)
//   남은 허용 실패   peaket:slo:onsale_allowed·peaket:slo:onsale_used·peaket:slo:onsale_burn_short·peaket:slo:onsale_burn_long{event_id,journey}(기록 규칙)
//   포화도           node_cpu_seconds_total{cpu,mode}(CPU = 1 − idle 비율), redis_memory_used_bytes·redis_memory_max_bytes{instance}(Redis 메모리 = 비율),
//                    kafka_consumergroup_lag{consumergroup,topic,partition}(Kafka 밀림), nodejs_eventloop_lag_p99_seconds{app}(이벤트 루프)
// 쿼리 문법은 구현이 정하고 진짜 Prometheus가 계산한다. 원천은 가짜 시계 시각에 묻는다(F-03-1 PrometheusWidgetSource처럼 time = 시계).
// core-svc 판매 설정은 대역 HTTP 서버(응답 모양은 core-svc internal-sale-config.controller.ts SaleConfigResponse)다.
// 시험은 가짜 시계를 앞으로만 옮기므로 파일 안 차례대로 돈다(at()이 뒤로 가면 던져 차례가 바뀐 것을 드러낸다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { auditHash, auditRecordFromJson } from '../src/modules/audit/index.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { OpenMetrics, type PrometheusContainer, startPrometheus } from './prometheus.js';
import { adminAccountsForCommands } from './reauth.js';

const MIN = 60_000;
/** 정본 값 */
const CANON = {
  checkFromMs: 30 * MIN, // 'T-30분 점검'
  judgeUntilMs: 20 * MIN, // 'T-20분까지 … 다시 판정'
  journeys: ['detail', 'queue_entry', 'queue_state', 'hold', 'seat_status', 'payment_accept', 'payment_confirm'], // asyncapi OpsAlert.journey
  linked: ['hold', 'seat_status', 'payment_accept', 'payment_confirm'], // control-tower §6의 3, ADR-0126
};
const P = 'https://peaket.example/problems/';
/** 가짜 시계 시작(분 단위로 맞춘 3시간 전). 지표는 이 시각 앞뒤로 채운다 */
const S = Math.floor(Date.now() / MIN) * MIN - 3 * 3_600_000;
const clock = fakeClock({ now: S });
/** 가짜 시계를 S + ms로 옮긴다(앞으로만) */
function at(ms: number): number {
  const d = S + ms - clock.now();
  if (d < 0) throw new Error(`시험 차례가 바뀌었다: 시계가 이미 S+${(clock.now() - S) / MIN}분이다`);
  clock.advance(d);
  return clock.now();
}

// ---------- 채울 지표 ----------
/** 노드 b의 시계 오프셋(초). 구간마다 다르고, 그 밖 노드 a는 1ms다. null이면 그 구간 표본이 없다 */
const OFFSET_B: [fromMin: number, toMin: number, value: number | null][] = [
  [-20, 4, 0.03], // T1·T3: +30ms → 실패
  [4, 8, 0.02], // T1 재판정: +20ms → 통과(경계 안)
  [8, 12, -0.03], // T2: −30ms → 실패(절댓값)
  [12, 16, -0.02], // T2: −20ms → 통과
  [16, 20, 0.020001], // T2: 20.001ms → 실패(경계 밖)
  [20, 30, null], // T2: 시계열 없음(5분 넘게 표본 없음) → 확인할 수 없음
  [30, 34, Number.NaN], // T2: NaN → 확인할 수 없음
  [34, 50, 0.001],
];
const EB = randomUUID(); // 남은 허용 실패를 볼 회차
const EX = randomUUID(); // 다른 회차(섞이면 안 된다)
const BUDGET: Record<string, { allowed: number; used: number; burnShort: number; burnLong: number }> = {
  payment_confirm: { allowed: 12, used: 3, burnShort: 2.5, burnLong: 1.2 },
  hold: { allowed: 40, used: 0, burnShort: 0, burnLong: 0 },
  queue_entry: { allowed: 50, used: 10, burnShort: 0.4, burnLong: 0.2 },
};

function metrics(): string {
  const om = new OpenMetrics();
  const t0 = S / 1000 - 20 * 60;
  const steps = (fromMin: number, toMin: number) => {
    const out: number[] = [];
    for (let t = S / 1000 + fromMin * 60; t < S / 1000 + toMin * 60; t += 15) out.push(t);
    return out;
  };
  const all = steps(-20, 50);
  // 시계 오프셋: a는 늘 1ms(NaN·없음 구간은 b와 같이), b는 구간별
  const aSamples: [number, number][] = [];
  const bSamples: [number, number][] = [];
  for (const [from, to, v] of OFFSET_B) {
    for (const t of steps(from, to)) {
      if (v === null) continue;
      aSamples.push([t, Number.isNaN(v) ? Number.NaN : 0.001]);
      bSamples.push([t, v]);
    }
  }
  om.gauge('node_timex_offset_seconds', 'instance="node-a"', aSamples).gauge('node_timex_offset_seconds', 'instance="node-b"', bSamples);
  // 남은 허용 실패(기록 규칙): EB의 세 여정, 다른 회차 EX의 결제 확정
  for (const [journey, b] of Object.entries(BUDGET)) {
    const l = `event_id="${EB}",journey="${journey}"`;
    om.gauge('peaket:slo:onsale_allowed', l, all.map((t) => [t, b.allowed]));
    om.gauge('peaket:slo:onsale_used', l, all.map((t) => [t, b.used]));
    om.gauge('peaket:slo:onsale_burn_short', l, all.map((t) => [t, b.burnShort]));
    om.gauge('peaket:slo:onsale_burn_long', l, all.map((t) => [t, b.burnLong]));
  }
  om.gauge('peaket:slo:onsale_allowed', `event_id="${EX}",journey="payment_confirm"`, all.map((t) => [t, 99]));
  om.gauge('peaket:slo:onsale_used', `event_id="${EX}",journey="payment_confirm"`, all.map((t) => [t, 98]));
  // 포화도: CPU 10%(idle 계수기가 CPU마다 초당 0.9), Redis 메모리 10% → 99%(S+40~44분) → 10%, Kafka 밀림 0(S+44분부터 없음), 이벤트 루프 5ms
  for (const cpu of ['0', '1']) {
    om.counter('node_cpu_seconds', `cpu="${cpu}",mode="idle"`, all.map((t) => [t, (t - t0) * 0.9]));
    om.counter('node_cpu_seconds', `cpu="${cpu}",mode="user"`, all.map((t) => [t, (t - t0) * 0.1]));
  }
  om.gauge('redis_memory_max_bytes', 'instance="redis-a"', all.map((t) => [t, 1e9]));
  om.gauge('redis_memory_used_bytes', 'instance="redis-a"', all.map((t) => [t, t >= S / 1000 + 40 * 60 && t < S / 1000 + 44 * 60 ? 9.9e8 : 1e8]));
  om.gauge('kafka_consumergroup_lag', 'consumergroup="peaket.purchase-svc.ci",topic="trade.orders",partition="0"', steps(-20, 44).map((t) => [t, 0]));
  om.gauge('nodejs_eventloop_lag_p99_seconds', 'app="purchase-svc"', all.map((t) => [t, 0.005]));
  return om.text();
}

// ---------- core-svc 판매 설정 대역 ----------
const schedules = new Map<string, { opensAtMs: number; saleEndsAtMs: number }>();
let core: Server | undefined;
let coreUrl = '';
function saleConfig(eventId: string, s: { opensAtMs: number; saleEndsAtMs: number }) {
  return {
    eventId,
    productionId: randomUUID(),
    promoterId: randomUUID(),
    title: 'F-03-3 시험 회차',
    rev: 1,
    opensAtMs: s.opensAtMs,
    startsAtMs: s.saleEndsAtMs + 24 * 60 * MIN,
    lobbyMinutes: 10,
    lobbyShuffle: true,
    openBatch: false,
    perPersonLimit: 4,
    saleEndsAtMs: s.saleEndsAtMs,
    entryOpensAtMs: null,
    entryClosedAtMs: null,
    salePolicy: [],
    eligGates: [],
    eligLists: [],
  };
}
/** 지금(가짜 시계)에서 opensInMs 뒤에 판매를 여는 회차 */
function eventOpensIn(opensInMs: number): string {
  const id = randomUUID();
  schedules.set(id, { opensAtMs: clock.now() + opensInMs, saleEndsAtMs: clock.now() + opensInMs + 120 * MIN });
  return id;
}

// ---------- 서비스 ----------
const identity = new FakeIdentity();
let pgc: PostgresContainer | undefined;
let prom: PrometheusContainer | undefined;
let db: Database;
let admin: pg.Client;
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  pgc = await startPostgres();
  await migrateOps(pgc.url);
  db = createDatabase({ url: pgc.url, applicationName: 'ops-svc-readiness-it' });
  admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  prom = await startPrometheus(metrics(), async (url) => {
    const r = await fetch(`${url}/api/v1/query?query=${encodeURIComponent('count(node_timex_offset_seconds)')}&time=${S / 1000}`);
    const body = (await r.json()) as { data?: { result?: { value?: [number, string] }[] } };
    return body.data?.result?.[0]?.value?.[1] === '2';
  });
  core = createServer((req, res) => {
    const m = /^\/internal\/v1\/events\/([^/?]+)\/sale-config/.exec(req.url ?? '');
    const s = m ? schedules.get(decodeURIComponent(m[1]!)) : undefined;
    if (!m || !s) {
      res.writeHead(404, { 'content-type': 'application/problem+json' }).end(JSON.stringify({ type: `${P}not-found`, status: 404 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(saleConfig(decodeURIComponent(m[1]!), s)));
  });
  await new Promise<void>((r) => core!.listen(0, '127.0.0.1', r));
  coreUrl = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
  vi.stubEnv('PEAKET_PROMETHEUS_URL', prom.url);
  vi.stubEnv('PEAKET_CORE_HTTP_URL', coreUrl);
  vi.stubEnv('PEAKET_QUEUE_REDIS_URL', '');
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, adminAccounts: adminAccountsForCommands, background: false }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 240_000);

afterAll(async () => {
  const bounded = (p: Promise<unknown> | undefined) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(r, 15_000).unref())]);
  try {
    await Promise.allSettled([bounded(svc?.close())]);
    await Promise.allSettled([bounded(new Promise<void>((r) => (core ? core.close(() => r()) : r()))), bounded(admin?.end()), bounded(db?.close())]);
  } finally {
    vi.unstubAllEnvs();
    prom?.stop();
    pgc?.stop();
  }
}, 120_000);

// ---------- 도우미 ----------
interface Item {
  key: string;
  group: 'required' | 'recommended' | 'display';
  status: string;
}
interface Readiness {
  stage: string;
  items: Item[];
  preview: { verdict: 'go' | 'no-go'; failedRequired: string[]; failedRecommended: string[] };
  lastJudgement?: Record<string, unknown>;
}
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const readiness = async (eventId: string): Promise<Readiness> => {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/events/${eventId}/readiness`, headers: identity.ops('viewer') });
  expect(r.statusCode, r.payload).toBe(200);
  return json(r) as unknown as Readiness;
};
const judge = (eventId: string, headers: Record<string, string>, body: unknown = {}) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/events/${eventId}/go-no-go-judgements`,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    payload: JSON.stringify(body),
  });
const clockItem = (r: Readiness) => r.items.find((i) => i.key === 'clock-offset');
const widget = async (key: string, eventId?: string) => {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/ops/widgets/${key}${eventId ? `?eventId=${eventId}` : ''}`, headers: identity.ops('viewer') });
  expect(r.statusCode, r.payload).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  return json(r);
};

interface ChainRow {
  seq: string;
  record_type: string;
  record_id: string;
  hash: string;
  prev: string;
  record_json: unknown;
}
const chain = async () =>
  (await admin.query<ChainRow>("select seq, record_type, record_id::text as record_id, encode(record_sha256, 'hex') as hash, encode(prev_hash, 'hex') as prev, record_json from audit_chain order by seq")).rows;
const judged = async () => (await chain()).filter((r) => r.record_type === 'GO_NO_GO_JUDGED');
/** 해시 사슬 검증: 행마다 직전 해시와 정규화 기록으로 다시 계산한 해시가 같고, 직전 해시가 앞 행의 해시다 */
async function expectChainValid(): Promise<void> {
  const rows = await chain();
  expect(rows.length).toBeGreaterThan(0);
  rows.forEach((row, i) => {
    expect(row.prev, `seq ${row.seq}의 직전 해시`).toBe(i === 0 ? '' : rows[i - 1]!.hash);
    const record = auditRecordFromJson(row.record_json);
    expect(record, `seq ${row.seq}의 정규화 기록`).toBeDefined();
    expect(auditHash(row.prev, record!), `seq ${row.seq}의 해시`).toBe(row.hash);
  });
}

describe('F-03-3 판정 권한·입력(실제 PostgreSQL·감사 체인)', () => {
  test('F-03-3 T3 C-T25 ①-12 viewer·cs_agent·cs_lead의 판정과 창 밖 판정은 판정 기록·감사 체인을 늘리지 않고, 본문 verdict go는 서버가 다시 계산한 No-Go로 남으며 판정자 계정 ID는 기록에 없다', async () => {
    at(2 * MIN);
    const e = eventOpensIn(25 * MIN);
    const before = (await judged()).length;
    for (const role of ['viewer', 'cs_agent', 'cs_lead'] as const) expect((await judge(e, identity.ops(role))).statusCode).toBe(403);
    const early = eventOpensIn(CANON.checkFromMs + 1);
    expect((await judge(early, identity.ops('operator'))).statusCode).toBe(409);
    expect((await judged()).length).toBe(before);
    expect((await readiness(e)).lastJudgement).toBeUndefined();

    const op = identity.ops('operator');
    const r = await judge(e, op, { verdict: 'go', items: [{ key: 'clock-offset', group: 'required', status: 'pass' }], failedRequired: [], failedRecommended: [] });
    expect(r.statusCode, r.payload).toBe(201);
    expect(json(r)).toMatchObject({ verdict: 'no-go' });
    const rows = (await judged()).filter((x) => x.record_id === json(r).judgementId);
    expect(rows).toHaveLength(1);
    const record = auditRecordFromJson(rows[0]!.record_json)!;
    expect(record.payload).toMatchObject({ eventId: e, verdict: 'no-go' });
    expect(record.payload.failedRequired).toContain('clock-offset');
    expect(JSON.stringify(rows[0]!.record_json)).not.toContain(op['x-user-id']!);
  });
});

describe('F-03-3 Go/No-Go 판정과 재판정(실제 Prometheus 시계 오프셋)', () => {
  test('F-03-3 T1 C-T25 ①-13 노드 시계 오프셋 30ms면 필수 clock-offset이 실패하고 No-Go 판정이 사유와 함께 감사 체인(GO_NO_GO_JUDGED)에 남으며, 20ms로 회복한 뒤 T-20분 전 재판정이 다음 순번으로 남고 사슬이 검증된다', async () => {
    at(2 * MIN);
    const e = eventOpensIn(25 * MIN); // 판정 창 [S−3분, S+7분]
    const r1 = await readiness(e);
    expect(r1.stage).toBe('t30');
    expect(clockItem(r1)).toMatchObject({ group: 'required', status: 'fail' });
    expect(r1.preview).toMatchObject({ verdict: 'no-go' });
    expect(r1.preview.failedRequired).toContain('clock-offset');

    const first = await judge(e, identity.ops('operator'), { recommendedReasons: {} });
    expect(first.statusCode, first.payload).toBe(201);
    const j1 = json(first);
    expect(j1).toMatchObject({ verdict: 'no-go', judgedAt: new Date(clock.now()).toISOString() });
    expect(j1.failedRequired).toContain('clock-offset');

    at(6 * MIN);
    const r2 = await readiness(e);
    expect(clockItem(r2)).toMatchObject({ group: 'required', status: 'pass' });
    expect(r2.preview.failedRequired).not.toContain('clock-offset');
    const second = await judge(e, identity.ops('commander'), { recommendedReasons: {} });
    expect(second.statusCode, second.payload).toBe(201);
    const j2 = json(second);
    expect(j2.sequence).toBe((j1.sequence as number) + 1);
    // 재판정 결과는 그때 서버가 계산한 미리 보기와 같다
    expect({ verdict: j2.verdict, failedRequired: [...(j2.failedRequired as string[])].sort() }).toEqual({ verdict: r2.preview.verdict, failedRequired: [...r2.preview.failedRequired].sort() });

    const rows = (await judged()).filter((x) => x.record_id === j1.judgementId || x.record_id === j2.judgementId);
    expect(rows.map((x) => x.record_id)).toEqual([j1.judgementId, j2.judgementId]);
    expect(Number(rows[1]!.seq)).toBeGreaterThan(Number(rows[0]!.seq));
    const [p1, p2] = rows.map((x) => auditRecordFromJson(x.record_json)!.payload);
    expect(p1).toMatchObject({ eventId: e, verdict: 'no-go' });
    expect(p1!.failedRequired).toContain('clock-offset');
    expect(p2).toMatchObject({ eventId: e, verdict: j2.verdict });
    expect(p2!.failedRequired).not.toContain('clock-offset');
    await expectChainValid();
    expect((await readiness(e)).lastJudgement).toMatchObject({ judgementId: j2.judgementId, sequence: j2.sequence });
  });

  test('F-03-3 T2 [ASVS v5.0.0-16.2.2] 시계 오프셋은 절댓값으로 판정하고(−30ms 실패·−20ms 통과·20.001ms 실패), 시계열이 없거나 NaN이면 확인할 수 없음이며 필수 확인할 수 없음은 No-Go다', async () => {
    const seen: [string, string | undefined, boolean, string][] = [];
    for (const [name, minute] of [
      ['−30ms', 10],
      ['−20ms', 14],
      ['20.001ms', 18],
      ['시계열 없음', 27],
      ['NaN', 32],
    ] as const) {
      at(minute * MIN);
      const r = await readiness(eventOpensIn(25 * MIN));
      seen.push([name, clockItem(r)?.status, r.preview.failedRequired.includes('clock-offset'), r.preview.verdict]);
    }
    // 통과한 때의 판정은 다른 항목에 달렸다(이 시험은 시계 오프셋만 본다)
    expect(seen).toEqual([
      ['−30ms', 'fail', true, 'no-go'],
      ['−20ms', 'pass', false, expect.any(String)],
      ['20.001ms', 'fail', true, 'no-go'],
      ['시계열 없음', 'unknown', true, 'no-go'],
      ['NaN', 'unknown', true, 'no-go'],
    ]);
  });

  test('F-03-3 T1 C-T25 ①-14 T-30분 탭의 실시간 항목(위젯 ops-readiness.checklist)은 조회(readiness)와 같은 항목·같은 판정 미리 보기다', async () => {
    at(34 * MIN);
    const e = eventOpensIn(25 * MIN);
    const r = await readiness(e);
    const w = await widget('ops-readiness.checklist', e);
    expect(w).toMatchObject({ widgetKey: 'ops-readiness.checklist', source: 'prometheus', eventId: e });
    expect(w.items).toEqual(r.items);
    expect(w.preview).toEqual(r.preview);
  });
});

describe('F-03-3 판단 위젯 원천(실제 Prometheus)', () => {
  test('F-03-3 T8 C-T30 ①-1 Redis 메모리가 주의 기준 위로 오르면 그 칸과 포화도 요약이 주의 이상이 되고(요약은 가장 나쁜 칸), 값이 없는 칸은 받지 못함이라 요약을 정상으로 만들지 않는다', async () => {
    type Field = { value: number | null; level: string };
    type Sat = { widgetKey: string; level: string; cpu: Field; redisMemory: Field; kafkaLag: Field; eventLoop: Field };
    at(38 * MIN);
    const calm = (await widget('ops-saturation.summary')) as unknown as Sat;
    expect(calm.widgetKey).toBe('ops-saturation.summary');
    expect([calm.cpu.level, calm.redisMemory.level, calm.kafkaLag.level, calm.eventLoop.level, calm.level]).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(calm.redisMemory.value).toBeCloseTo(0.1, 6);

    at(42 * MIN);
    const hot = (await widget('ops-saturation.summary')) as unknown as Sat;
    expect(hot.redisMemory.value).toBeCloseTo(0.99, 6);
    expect(['warn', 'danger']).toContain(hot.redisMemory.level);
    // 다른 칸은 그대로 정상이라 요약은 Redis 칸과 같다
    expect([hot.cpu.level, hot.kafkaLag.level, hot.eventLoop.level]).toEqual(['ok', 'ok', 'ok']);
    expect(hot.level).toBe(hot.redisMemory.level);

    at(49 * MIN);
    const missing = (await widget('ops-saturation.summary')) as unknown as Sat;
    expect(missing.redisMemory.level).toBe('ok');
    expect(missing.kafkaLag).toEqual({ value: null, level: 'unknown' });
    expect(missing.level).not.toBe('ok');
  });

  test('F-03-3 T7 ① 남은 허용 실패: 기록 규칙 값으로 여정마다 허용·사용·남은 건수와 소진 배수를 내고, 연동 여정 넷만 linked이며, 시계열이 없는 여정은 0이 아니라 null과 까닭이다', async () => {
    at(49 * MIN);
    type J = { journey: string; linked: boolean; allowed: number | null; used: number | null; remaining: number | null; burnShort?: number | null; burnLong?: number | null; reason?: string };
    const w = (await widget('ops-budget.journeys', EB)) as unknown as { widgetKey: string; eventId: string; journeys: J[] };
    expect(w).toMatchObject({ widgetKey: 'ops-budget.journeys', eventId: EB });
    const by = new Map(w.journeys.map((j) => [j.journey, j]));
    expect([...by.keys()].sort()).toEqual([...CANON.journeys].sort());
    expect(w.journeys.filter((j) => j.linked).map((j) => j.journey).sort()).toEqual([...CANON.linked].sort());
    expect(by.get('payment_confirm')).toMatchObject({ linked: true, allowed: 12, used: 3, remaining: 9, burnShort: 2.5, burnLong: 1.2 });
    expect(by.get('hold')).toMatchObject({ linked: true, allowed: 40, used: 0, remaining: 40 });
    expect(by.get('queue_entry')).toMatchObject({ linked: false, allowed: 50, used: 10, remaining: 40 });
    for (const j of ['detail', 'queue_state', 'seat_status', 'payment_accept']) {
      expect(by.get(j), j).toMatchObject({ allowed: null, used: null, remaining: null });
      expect(typeof by.get(j)!.reason, `${j}의 까닭`).toBe('string');
    }
  });
});
