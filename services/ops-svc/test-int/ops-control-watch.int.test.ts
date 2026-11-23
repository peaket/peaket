// F-03-3 OPS-380 제어 입력 없음 표시와 자동 제어 다섯 값의 실제 ops-svc + PostgreSQL 18 + Valkey 통합 시험(시험 먼저, ADR-0372).
// 정본: docs/features/control-tower.md §6의 6('admission-ctrl이 상태를 q:{event:E}:ctl에 쓰면 ops-svc가 읽어, 위 상태 바에 <입력 없음>을, 경보 패널에 SEV2를 띄운다
// (Alertmanager는 거치지 않는다)', '긴급 정지, 입력 없음, 일시정지, 자동 증액 멈춤 순으로 앞의 것'), §8('제어 입력 없음 SEV2는 … Alertmanager가 멈춰도 뜬다'),
// C-T31 ①(30초 [가정] 안, 동시 입장 목표는 바뀌지 않는다), docs/data.md §3 q:{event:E}:ctl·q:{admission}:ctl·q:{admission}:events 칸 이름과 값(쓰는 쪽 admission-ctrl
// domain/aimd.ts memoryToFields·adapters/redis-leader-store.ts와 같은 이름), docs/design/d5-screen-blueprint.md §7.2 '제어 입력 없음' 상태 줄의 경보 글,
// 계획 docs/review/plans/F-03-3.md §4 'SSE control'(본문 모양)·1-6·1-7·6-6·6-7.
// 파드 둘을 띄운다: 둘 다 시작 조립 그대로의 AppModule(DB 길)이고, 대기열 Redis는 읽기만 허락한 사용자로 붙는다. Prometheus·Alertmanager 주소는 주지 않는다.
// 리더 대신 시험이 기본 사용자로 칸을 쓴다(쓰는 쪽 이름 짝은 위 정본과 admission-ctrl 코드).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createDatabase, createService, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands } from './reauth.js';
import { Sse } from './sse.js';
import { type ValkeyContainer, startValkey } from './valkey.js';

/** 정본 값 */
const CANON = {
  noInputVisibleMs: 30_000, // C-T31 ① '30초 [가정] 안에 위 상태 바가 <입력 없음>'
  noInputAlertTitle: '관측 경로와 별개로 입장 제어가 알린 경보입니다', // d5 §7.2 '제어 입력 없음' 상태 줄
};

const identity = new FakeIdentity();
let pgc: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let db: Database;
let admin: pg.Client;
const pods: { svc: Awaited<ReturnType<typeof createService>>; port: number }[] = [];

const ctlKey = (e: string) => `q:{event:${e}}:ctl`;
const PLATFORM_CTL = 'q:{admission}:ctl';
const EVENTS = 'q:{admission}:events';

/** 진행 중 회차 목록에 넣고(점수 = 키 수명, 지금 + 하루) ctl 칸을 쓴다. 빈 글자 칸은 없는 것과 같아(data.md) 시험은 빈 칸을 쓰지 않고 지운다 */
function seedEvent(e: string, fields: Record<string, string> | null): void {
  valkey!.cli(['ZADD', EVENTS, String(Date.now() + 24 * 3_600_000), e]);
  if (fields && Object.keys(fields).length > 0) valkey!.cli(['HSET', ctlKey(e), ...Object.entries(fields).flat()]);
}
const hgetall = (key: string): Record<string, string> => {
  const lines = valkey!.cli(['HGETALL', key]).split('\n').map((l) => l.trim());
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < lines.length; i += 2) out[lines[i]!] = lines[i + 1]!;
  return out;
};

const controlAlerts = async (e: string) =>
  (await admin.query<{ id: string; severity: string; resolved_at: Date | null }>(`select id, severity, resolved_at from ops_alert where event_key = $1 and kind = 'control'`, [e])).rows;

const openLive = (podIndex: number, eventId: string) => Sse.open(pods[podIndex]!.port, `/v1/ops/live?eventId=${eventId}&screen=dashboard`, identity.ops('viewer'));
const controlOf = (s: Sse) => s.of('control').map((f) => f.data as Record<string, unknown>);

beforeAll(async () => {
  pgc = await startPostgres();
  valkey = await startValkey();
  await migrateOps(pgc.url);
  db = createDatabase({ url: pgc.url, applicationName: 'ops-svc-control-it' });
  admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  // 시작 조립 그대로(LiveModule이 환경 값을 읽는다). 대기열 Redis는 읽기 전용 사용자, Prometheus·Alertmanager 주소는 없다
  vi.stubEnv('PEAKET_QUEUE_REDIS_URL', valkey.readOnlyUrl);
  vi.stubEnv('PEAKET_PROMETHEUS_URL', '');
  for (let i = 0; i < 2; i += 1) {
    const svc = await createService({
      name: 'ops-svc',
      module: AppModule.register({ database: db, adminAccounts: adminAccountsForCommands, background: false }),
      env: { PEAKET_ENV: 'ci' },
      logDestination: quiet(),
      adminAuthz: identity,
    });
    await svc.http.listen({ host: '127.0.0.1', port: 0 });
    pods.push({ svc, port: (svc.http.server.address() as AddressInfo).port });
  }
}, 240_000);

afterAll(async () => {
  const bounded = (p: Promise<unknown> | undefined) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(r, 15_000).unref())]);
  try {
    await Promise.allSettled(pods.map((p) => bounded(p.svc.close())));
    await Promise.allSettled([bounded(admin?.end()), bounded(db?.close())]);
  } finally {
    vi.unstubAllEnvs();
    valkey?.stop();
    pgc?.stop();
  }
}, 120_000);

describe('F-03-3 제어 입력 없음(실제 ops-svc·PostgreSQL·Valkey)', () => {
  test(
    'F-03-3 T5 C-T31 ①-1 리더가 쓰는 칸으로 입력 없음을 켜면 30초 안에 그 회차 control no-input과 경보 기록 표의 control SEV2 하나(파드 둘)가 가고, 끄면 풀리며 목표 칸은 그대로다',
    async () => {
      const E = randomUUID();
      // 리더가 평소에 쓰는 칸(aimd.ts memoryToFields)과 지금 목표 targetNow
      seedEvent(E, { aimdTarget: '1500', aimdChangeAt: String(Date.now() - 60_000), targetNow: '1234', inputStale: '0' });
      const before = hgetall(ctlKey(E));
      const a = await openLive(0, E);
      const b = await openLive(1, E);
      expect([a.status, b.status]).toEqual([200, 200]);
      // 붙을 때 한 번: 지금 값(정상)
      await vi.waitFor(() => expect(controlOf(a).at(-1)).toMatchObject({ eventId: E, kind: 'ok' }), { timeout: 10_000 });
      // control은 알림 표 순번이 없는 지금 값이다(계획 6-6)
      expect(a.of('control')[0]!.id).toBeUndefined();

      const staleAt = Date.now() - 31_000;
      const t0 = Date.now();
      valkey!.cli(['HSET', ctlKey(E), 'inputStale', '1', 'inputStaleAt', String(staleAt), 'inputStaleKinds', 'downstream_latency,budget_burn']);
      for (const s of [a, b]) {
        await vi.waitFor(() => expect(controlOf(s).at(-1)).toMatchObject({ eventId: E, kind: 'no-input' }), { timeout: CANON.noInputVisibleMs, interval: 200 });
      }
      const noInput = controlOf(a).at(-1)!;
      expect(noInput).toMatchObject({ eventId: E, kind: 'no-input', inputStaleKinds: ['downstream_latency', 'budget_burn'], targetNow: 1234, since: new Date(staleAt).toISOString() });
      // 경보 패널 SEV2: 그 회차의 kind control(Alertmanager·Prometheus 없이)
      await vi.waitFor(() => expect(a.of('alert').map((f) => f.data)).toContainEqual(expect.objectContaining({ kind: 'control', eventId: E, severity: 'SEV2', status: 'firing', title: CANON.noInputAlertTitle })), {
        timeout: CANON.noInputVisibleMs,
        interval: 200,
      });
      expect(Date.now() - t0).toBeLessThanOrEqual(CANON.noInputVisibleMs);
      // 파드 둘이 함께 읽어도 경보는 한 건이다
      await vi.waitFor(() => expect(b.of('alert').some((f) => (f.data as { kind?: string; eventId?: string }).kind === 'control' && (f.data as { eventId?: string }).eventId === E)).toBe(true), { timeout: 10_000 });
      const rows = await controlAlerts(E);
      expect(rows.map((r) => [r.severity, r.resolved_at])).toEqual([['SEV2', null]]);

      // 동시 입장 목표는 바뀌지 않는다: ops-svc는 대기열 Redis에 쓰지 않았다(시험이 쓴 세 칸 밖은 처음 그대로)
      expect(hgetall(ctlKey(E))).toEqual({ ...before, inputStale: '1', inputStaleAt: String(staleAt), inputStaleKinds: 'downstream_latency,budget_burn' });

      // 입력이 돌아오면 control이 바뀌고 경보가 풀린다
      valkey!.cli(['HSET', ctlKey(E), 'inputStale', '0']);
      valkey!.cli(['HDEL', ctlKey(E), 'inputStaleAt', 'inputStaleKinds']);
      await vi.waitFor(() => expect(controlOf(a).at(-1)).toMatchObject({ eventId: E, kind: 'ok' }), { timeout: CANON.noInputVisibleMs, interval: 200 });
      await vi.waitFor(async () => expect((await controlAlerts(E)).map((r) => r.resolved_at !== null)).toEqual([true]), { timeout: CANON.noInputVisibleMs, interval: 300 });
      await vi.waitFor(() => expect(a.of('alert').map((f) => f.data)).toContainEqual(expect.objectContaining({ kind: 'control', eventId: E, status: 'resolved' })), { timeout: 10_000 });
      a.close();
      b.close();

      // 읽기 전용 사용자로 쓰기를 하려 한 적이 없다(ACL 거절 기록 없음)
      expect(valkey!.cli(['ACL', 'LOG'])).not.toContain(valkey!.readOnlyUser);
    },
    120_000,
  );
});

describe('F-03-3 자동 제어 다섯 값의 우선순위(실제 Valkey 칸)', () => {
  test(
    'F-03-3 T6 C-T31 ①-2 입력 없음 > 일시정지(입장·판매·판매 중지) > 자동 증액 멈춤 > 정상이고, 틀린 칸·지난 만료는 없는 것으로 보며, 회차 키가 없으면 unknown이다',
    async () => {
      const now = Date.now();
      const cases: [string, Record<string, string> | null, string][] = [
        ['입력 없음 + 입장 일시정지 + 버짓 감축', { targetNow: '900', inputStale: '1', inputStaleAt: String(now - 40_000), inputStaleKinds: 'seat_store', admitPaused: '1', budgetHoldAt: String(now - 5_000) }, 'no-input'],
        ['입장 일시정지(만료 없음) + 버짓 감축', { targetNow: '900', inputStale: '0', admitPaused: '1', budgetHoldAt: String(now - 5_000) }, 'paused'],
        ['입장 일시정지(만료 전)', { targetNow: '900', inputStale: '0', admitPaused: '1', admitPausedUntil: String(now + 10 * 60_000) }, 'paused'],
        ['판매 일시정지(명령 3)', { targetNow: '900', inputStale: '0', paused: '1' }, 'paused'],
        ['판매 중지', { targetNow: '900', inputStale: '0', suspended: '1' }, 'paused'],
        ['입장 일시정지 만료가 지남', { targetNow: '900', inputStale: '0', admitPaused: '1', admitPausedUntil: String(now - 1_000) }, 'ok'],
        ['버짓 연동 감축 뒤 자동 증액 멈춤', { targetNow: '900', inputStale: '0', budgetHoldAt: String(now - 5_000) }, 'raise-stopped'],
        ['정상', { targetNow: '900', inputStale: '0' }, 'ok'],
        ['뜻이 틀린 칸(1·0이 아님)', { targetNow: '900', inputStale: 'yes', admitPaused: 'true', paused: '2' }, 'ok'],
        ['회차 키 없음', null, 'unknown'],
      ];
      const events = cases.map(([name, fields, kind]) => ({ name, kind, id: randomUUID(), fields }));
      for (const e of events) seedEvent(e.id, e.fields);
      const streams = await Promise.all(events.map((e) => openLive(0, e.id)));
      const seen = async () => events.map((e, i) => [e.name, controlOf(streams[i]!).at(-1)?.kind]);
      await vi.waitFor(async () => expect(await seen()).toEqual(events.map((e) => [e.name, e.kind])), { timeout: 30_000, interval: 300 });
      // 자동 증액 멈춤에는 감축 시각을, 정상이 아닌 값에는 회차 ID를 싣는다
      const raise = controlOf(streams[events.findIndex((e) => e.kind === 'raise-stopped')]!).at(-1)!;
      expect(raise).toMatchObject({ kind: 'raise-stopped', budgetHoldAt: new Date(now - 5_000).toISOString(), targetNow: 900 });
      for (const s of streams) s.close();
    },
    90_000,
  );

  test(
    'F-03-3 T6 C-T31 ①-3 회차와 무관한 긴급 정지(autoStopped)는 입력 없음보다 앞이고, 전체 범위 판매 일시정지(allPaused)는 일시정지다',
    async () => {
      const stale = randomUUID();
      const calm = randomUUID();
      seedEvent(stale, { targetNow: '700', inputStale: '1', inputStaleAt: String(Date.now() - 40_000), inputStaleKinds: 'downstream_errors' });
      seedEvent(calm, { targetNow: '700', inputStale: '0' });
      const s1 = await openLive(1, stale);
      const s2 = await openLive(1, calm);
      await vi.waitFor(() => expect([controlOf(s1).at(-1)?.kind, controlOf(s2).at(-1)?.kind]).toEqual(['no-input', 'ok']), { timeout: 30_000, interval: 300 });
      try {
        valkey!.cli(['HSET', PLATFORM_CTL, 'autoStopped', '1']);
        await vi.waitFor(() => expect([controlOf(s1).at(-1)?.kind, controlOf(s2).at(-1)?.kind]).toEqual(['emergency-stop', 'emergency-stop']), { timeout: 30_000, interval: 300 });
        valkey!.cli(['HSET', PLATFORM_CTL, 'autoStopped', '0', 'allPaused', '1']);
        await vi.waitFor(() => expect([controlOf(s1).at(-1)?.kind, controlOf(s2).at(-1)?.kind]).toEqual(['no-input', 'paused']), { timeout: 30_000, interval: 300 });
      } finally {
        valkey!.cli(['DEL', PLATFORM_CTL]);
        s1.close();
        s2.close();
      }
    },
    120_000,
  );
});
