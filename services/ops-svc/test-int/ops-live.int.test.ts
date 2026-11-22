// 관제 SSE 흐름 둘과 위젯 조회의 실제 ops-svc + PostgreSQL 18 통합 시험(F-03-1 OPS-340, FE-T28 ①②④⑥⑦, T8·T9).
// 정본: ADR-0100 결정 2(Last-Event-ID 다시 보내기·1시간 밖 reset·닫힘)·결정 4(알림 표는 원래 기록과 같은 트랜잭션, 접속자 15초 쓰기·45초 창),
// ADR-0360 결정 1(트리거)·4(받는 사람)·5(토큰 만료·세션 종료)·9(위젯 키 둘·Prometheus 원천), docs/frontend.md §4.4.4·§4.4.5, docs/data.md ops_push_event.
// 서비스 둘을 띄운다: (가) 시작 조립 그대로의 AppModule(실제 시계, DB 길을 스스로 고르는지 본다), (나) LiveModule만 짧은 주기로 바꿔 끼운 조립(가짜 시계로 45초 창을 본다).
// 위젯 원천은 실제 Prometheus 컨테이너(promtool로 채운 지표)와, 실패 모양만 내는 대역 HTTP 서버다(대역은 실패 경로만 맡는다).
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Module } from '@nestjs/common';
import { OpsWidgetPurchasePgStatusSummary, OpsWidgetQueueAdmissionRateSummary, OpsWidgetUnavailable } from '@peaket/contracts/openapi/model';
import { createDatabase, createService, databaseModule, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { AuditCheckpointService, MemoryAuditChain, MemoryAuditCheckpointStore } from '../src/modules/audit/index.js';
import { DrizzleCommandStore } from '../src/modules/commands/index.js';
import { LiveModule, OpsLiveFeed, PrometheusWidgetSource, WIDGET_KEYS, type WidgetKey, type WidgetReadQuery, type WidgetSource, type WidgetValue } from '../src/modules/live/index.js';
import { FakeIdentity } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { adminAccountsForCommands, reauthFor } from './reauth.js';

const PROMETHEUS_IMAGE = 'prom/prometheus:v3.14.0';
/** 정본 값 */
const CANON = { retryMs: 10_000, presenceWindowMs: 45_000 };
/** 위젯·접속자 조립(나)의 가짜 시계. Prometheus에 채울 지표의 시각과 같다(분 단위로 맞춘 3시간 전) */
const NOW_FAST = Math.floor(Date.now() / 60_000) * 60_000 - 3 * 3_600_000;
const Q: WidgetKey = 'queue-admission-rate.summary';
const P: WidgetKey = 'purchase-pg-status.summary';

const identity = new FakeIdentity();
let container: PostgresContainer | undefined;
let db: Database;
let admin: pg.Client;
/** 커밋을 늦추는 트랜잭션용 두 번째 연결(RV-01·RV-02) */
let late: pg.Client | undefined;
/** 진행 중 트랜잭션이 있을 때 새로 뜨는 파드(RV-01 ②) */
let extra: Awaited<ReturnType<typeof createService>> | undefined;

// ---------- 로그(닫힌 까닭) ----------
class LogLines extends Writable {
  readonly lines: Record<string, unknown>[] = [];
  override _write(chunk: Buffer, _e: BufferEncoding, cb: () => void): void {
    for (const l of String(chunk).split('\n')) {
      if (!l.trim()) continue;
      try {
        this.lines.push(JSON.parse(l) as Record<string, unknown>);
      } catch {
        // JSON이 아닌 줄은 버린다
      }
    }
    cb();
  }
  closedCount(reason?: string): number {
    return this.lines.filter((l) => l.event === 'ops-live-closed' && (reason === undefined || l.reason === reason)).length;
  }
}

// ---------- SSE 받는 쪽(표준 규칙대로 읽는다) ----------
interface Frame {
  id?: string;
  event: string;
  data: unknown;
}

class Sse {
  readonly frames: Frame[] = [];
  readonly openings: { retry?: number; id?: string }[] = [];
  comments = 0;
  ended = false;
  #buf = '';
  #block: { id?: string; event?: string; retry?: number; data: string[] } = { data: [] };

  private constructor(
    readonly status: number,
    readonly body: string | undefined,
    private readonly ac: AbortController,
  ) {}

  static async open(port: number, path: string, headers: Record<string, string>): Promise<Sse> {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal });
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return new Sse(res.status, await res.text(), ac);
    const s = new Sse(res.status, undefined, ac);
    void s.pump(res.body!);
    return s;
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#buf += dec.decode(value, { stream: true });
        for (let i = this.#buf.indexOf('\n'); i >= 0; i = this.#buf.indexOf('\n')) {
          const line = this.#buf.slice(0, i);
          this.#buf = this.#buf.slice(i + 1);
          this.line(line);
        }
      }
    } catch {
      // 끊었다(시험이 닫음)
    } finally {
      this.ended = true;
    }
  }

  private line(l: string): void {
    const b = this.#block;
    if (l === '') {
      this.#block = { data: [] };
      if (b.data.length > 0) this.frames.push({ ...(b.id !== undefined ? { id: b.id } : {}), event: b.event ?? 'message', data: JSON.parse(b.data.join('\n')) as unknown });
      else if (b.id !== undefined || b.retry !== undefined) this.openings.push({ ...(b.retry !== undefined ? { retry: b.retry } : {}), ...(b.id !== undefined ? { id: b.id } : {}) });
      return;
    }
    if (l.startsWith(':')) {
      this.comments += 1;
      return;
    }
    const c = l.indexOf(':');
    const field = c < 0 ? l : l.slice(0, c);
    const value = c < 0 ? '' : l.slice(c + 1).replace(/^ /, '');
    if (field === 'id') b.id = value;
    else if (field === 'event') b.event = value;
    else if (field === 'data') b.data.push(value);
    else if (field === 'retry') b.retry = Number(value);
  }

  of(event: string): Frame[] {
    return this.frames.filter((f) => f.event === event);
  }

  /** 마지막으로 받은 id(첫 덩이의 id 포함) */
  get lastId(): string | undefined {
    const ids = [...this.openings.map((o) => o.id), ...this.frames.map((f) => f.id)].filter((v): v is string => v !== undefined).map(Number);
    return ids.length ? String(Math.max(...ids)) : undefined;
  }

  close(): void {
    this.ac.abort();
  }
}

// ---------- 서비스 (가): 시작 조립 그대로 ----------
const fullLogs = new LogLines();
let full: Awaited<ReturnType<typeof createService>>;
let fullPort = 0;

// ---------- 서비스 (나): LiveModule만, 짧은 주기·가짜 시계 ----------
/** 위젯 원천을 바꿔 끼우는 감싸개(실제 Prometheus 어댑터 ↔ 실패 대역 주소의 같은 어댑터) */
class SwitchSource implements WidgetSource {
  readonly keys: readonly WidgetKey[] = WIDGET_KEYS;
  constructor(public target: WidgetSource) {}
  read(key: WidgetKey, q: WidgetReadQuery): Promise<WidgetValue> {
    return this.target.read(key, q);
  }
}
const fastClock = fakeClock({ now: NOW_FAST });
const fastLogs = new LogLines();
let fast: Awaited<ReturnType<typeof createService>>;
let fastPort = 0;
let switchSource: SwitchSource;

// ---------- Prometheus ----------
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
let prometheusId: string | undefined;
let prometheusUrl = '';
let stub: Server | undefined;
let stubMode: 'status-500' | 'status-error' = 'status-500';
let stubUrl = '';

const E7 = randomUUID();
/** Prometheus에 채우는 값(OpenMetrics, promtool tsdb create-blocks-from openmetrics) */
const METRICS = { ratio: 0.42, target: 5000, slotsUsed: 3100, inFlight: 120, soonWaiting: 800, tossLimit: 0.7, portoneLimit: 0.3, tossInflight: 30, portoneInflight: 5 };
function openMetrics(): string {
  const out: string[] = [];
  // 20분 전부터 5분 뒤까지 15초 간격(앞 시험이 가짜 시계를 몇십 초 옮겨도 rate[1m] 창에 점이 있다)
  const t0 = NOW_FAST / 1000 - 20 * 60;
  const series = (name: string, type: 'gauge' | 'counter', rows: [string, (i: number) => number][]) => {
    out.push(`# TYPE ${name} ${type}`);
    for (const [labels, v] of rows) for (let i = 0; i <= 100; i += 1) out.push(`${name}${type === 'counter' ? '_total' : ''}{${labels}} ${v(i)} ${t0 + i * 15}`);
  };
  const ev = `event_id="${E7}"`;
  series('admission_ratio', 'gauge', [[ev, () => METRICS.ratio]]);
  series('admission_target', 'gauge', [[ev, () => METRICS.target]]);
  series('admission_slots_used', 'gauge', [[ev, () => METRICS.slotsUsed]]);
  series('admission_in_flight', 'gauge', [[ev, () => METRICS.inFlight]]);
  series('admission_soon_waiting', 'gauge', [[ev, () => METRICS.soonWaiting]]);
  series('payment_pg_limit_ratio', 'gauge', [
    ['pg="toss"', () => METRICS.tossLimit],
    ['pg="portone"', () => METRICS.portoneLimit],
  ]);
  series('payment_pg_circuit_open', 'gauge', [
    ['pg="toss"', () => 1],
    ['pg="portone"', () => 0],
  ]);
  series('payment_pg_inflight', 'gauge', [
    ['pg="toss"', () => METRICS.tossInflight],
    ['pg="portone"', () => METRICS.portoneInflight],
  ]);
  // 15초마다 1.5씩 늘어나는 계수기 = 분당 6
  series('payment_pg_saturated', 'counter', [
    ['pg="toss"', (i) => i * 1.5],
    ['pg="portone"', () => 0],
  ]);
  out.push('# EOF');
  return `${out.join('\n')}\n`;
}

async function startPrometheus(): Promise<void> {
  const prefix = process.env.PEAKET_TEST_CONTAINER_PREFIX;
  const name = prefix ? `${prefix}prom-${Math.random().toString(36).slice(2, 8)}` : undefined;
  // 지표 파일은 명령줄에 싣기에 커서(Windows 명령줄 상한) 만든 컨테이너에 docker cp로 넣은 뒤 시작한다
  const dir = mkdtempSync(join(tmpdir(), 'ops-live-prom-'));
  const file = join(dir, 'm.om');
  writeFileSync(file, openMetrics());
  const script = 'promtool tsdb create-blocks-from openmetrics /tmp/m.om /prometheus >/dev/null && exec prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus --storage.tsdb.retention.time=3650d';
  prometheusId = docker(['create', '--rm', ...(name ? ['--name', name] : []), '-p', '127.0.0.1::9090', '--entrypoint', 'sh', PROMETHEUS_IMAGE, '-c', script]);
  docker(['cp', file, `${prometheusId}:/tmp/m.om`]);
  rmSync(dir, { recursive: true, force: true });
  docker(['start', prometheusId]);
  const mapped = docker(['port', prometheusId, '9090/tcp']).split('\n')[0]!;
  prometheusUrl = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  // 채운 지표가 질의될 때까지(시작 조건, 시간 아님)
  await vi.waitFor(
    async () => {
      const r = await fetch(`${prometheusUrl}/api/v1/query?query=${encodeURIComponent(`max(admission_ratio{event_id="${E7}"})`)}&time=${NOW_FAST / 1000}`);
      const body = (await r.json()) as { data?: { result?: unknown[] } };
      expect(body.data?.result?.length).toBe(1);
    },
    { timeout: 90_000, interval: 500 },
  );
}

beforeAll(async () => {
  container = await startPostgres();
  await migrateOps(container.url);
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-live-it' });
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();

  full = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, adminAccounts: adminAccountsForCommands, background: false }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: fullLogs,
    adminAuthz: identity,
  });
  await full.http.listen({ host: '127.0.0.1', port: 0 });
  fullPort = (full.http.server.address() as AddressInfo).port;

  await startPrometheus();
  stub = createServer((_req, res) => {
    if (stubMode === 'status-500') {
      res.writeHead(500, { 'content-type': 'text/plain' }).end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'error', errorType: 'bad_data', error: 'parse error' }));
  });
  await new Promise<void>((r) => stub!.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  switchSource = new SwitchSource(PrometheusWidgetSource.fromUrl(prometheusUrl));

  const checkpoints = new AuditCheckpointService(new MemoryAuditCheckpointStore(), new MemoryAuditChain(), () => fastClock.now());
  @Module({})
  class FastLiveRoot {}
  fast = await createService({
    name: 'ops-svc',
    module: {
      module: FastLiveRoot,
      imports: [
        databaseModule(db),
        LiveModule.register(new OpsLiveFeed({ commands: new DrizzleCommandStore(db), checkpoints }), {
          hub: { pollMs: 50, gapWaitMs: 300 },
          presenceOptions: { writeMs: 50, gatherMs: 50 },
          widgetOptions: { tickMs: 100 },
          widgetSources: [switchSource],
          retention: false,
        }),
      ],
    },
    env: { PEAKET_ENV: 'ci' },
    clock: fastClock,
    logDestination: fastLogs,
    adminAuthz: identity,
  });
  await fast.http.listen({ host: '127.0.0.1', port: 0 });
  fastPort = (fast.http.server.address() as AddressInfo).port;
}, 240_000);

afterAll(async () => {
  // 시험이 실패하거나 닫기가 던지고 멈춰도 컨테이너는 반드시 지운다(검증 때 실패한 실행마다 PostgreSQL·Prometheus가 남았다, F-03-1 검증 '남은 위험' 2)
  const bounded = (p: Promise<unknown> | undefined) => Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(r, 15_000).unref())]);
  try {
    await Promise.allSettled([bounded(full?.close()), bounded(fast?.close()), bounded(extra?.close())]);
    await Promise.allSettled([bounded(new Promise<void>((r) => (stub ? stub.close(() => r()) : r()))), bounded(late?.end()), bounded(admin?.end()), bounded(db?.close())]);
  } finally {
    if (prometheusId) {
      try {
        docker(['rm', '-f', '-v', prometheusId]);
      } catch {
        // 이미 멈췄다
      }
    }
    container?.stop();
  }
}, 120_000);

// ---------- 도우미 ----------
const postCommand = async (headers: Record<string, string>, body: unknown) => {
  const url = '/v1/ops/commands';
  const r = await full.http.inject({ method: 'POST', url, headers: { ...reauthFor(url, headers), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
  expect(r.statusCode, r.payload).toBe(201);
  return JSON.parse(r.payload) as { commandId: string; state: string };
};
/** 2인 명령(명령 4, ASN이 있으면 2인, ADR-0339 결정 1). 승인 역할은 operator·commander */
const blockAsn = (headers: Record<string, string>) =>
  postCommand(headers, { type: 'BLOCK_ASN_IP', reason: '대역 차단', params: { asns: [64512 + Math.floor(Math.random() * 1000)], expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() } });
/** 경보 행을 넣는다(한 트랜잭션에 여럿이면 created_at·now()가 같다) */
async function insertAlerts(n: number, eventKey = randomUUID()): Promise<string[]> {
  const ids = Array.from({ length: n }, () => randomUUID());
  await admin.query('begin');
  for (const [i, id] of ids.entries())
    await admin.query(`insert into ops_alert (id, event_key, kind, severity, source, reason, created_at) values ($1, $2, $3, 'SEV2', 'it', '결제 실패율', now())`, [id, eventKey, ['slo', 'cause', 'flow', 'field'][i % 4]]);
  await admin.query('commit');
  return ids;
}
const rowsAfter = async (seq: number) =>
  (await admin.query<{ seq: string; kind: string; body: Record<string, unknown>; roles: string; event_id: string | null }>('select seq, kind, body, roles, event_id from ops_push_event where seq > $1 order by seq', [seq])).rows.map((r) => ({ ...r, seq: Number(r.seq) }));
const pushRowsOf = async (key: 'commandId' | 'alertId', id: string) =>
  (await admin.query<{ kind: string; roles: string; event_id: string | null; body: Record<string, unknown> }>(`select kind, roles, event_id, body from ops_push_event where body->>'${key}' = $1 order by seq`, [id])).rows;
const refOf = (f: Frame) => {
  const d = f.data as { commandId?: string; alertId?: string };
  return d.commandId ?? d.alertId;
};

describe('F-03-1 관제 늘 여는 흐름(실제 ops-svc·PostgreSQL)', () => {
  test('F-03-1 T1 FE-T28 ①-4 시작 조립이 알림 표 길을 고르고, 끊고 Last-Event-ID로 다시 붙으면 그 뒤 command·alert가 같은 시각 둘까지 하나도 빠지지 않는다', async () => {
    const viewer = identity.ops('viewer');
    const requester = identity.ops('operator');
    const a = await Sse.open(fullPort, '/v1/ops/live', viewer);
    expect(a.status).toBe(200);
    await vi.waitFor(() => expect(a.openings.length).toBe(1));
    expect(a.openings[0]!.retry).toBe(CANON.retryMs);
    const start = Number(a.openings[0]!.id);
    expect(Number.isSafeInteger(start)).toBe(true);

    // 연 동안: 명령 하나(REST)와 경보 하나(경보 표 행) — 메모리 길에는 경보가 없어 DB 길을 골랐는지 함께 본다
    const c1 = await blockAsn(requester);
    const [al1] = await insertAlerts(1);
    await vi.waitFor(() => expect(a.frames.map(refOf)).toEqual(expect.arrayContaining([c1.commandId, al1])), { timeout: 10_000 });
    const liveRows = (await rowsAfter(start)).filter((r) => r.kind !== 'approval');
    expect(a.frames.map((f) => [Number(f.id), f.event])).toEqual(liveRows.map((r) => [r.seq, r.kind]));
    expect(a.of('command')[0]!.data).toMatchObject({ commandId: c1.commandId, type: 'BLOCK_ASN_IP', state: 'PENDING_APPROVAL', requestedBy: { adminAccountId: requester['x-user-id'] }, canApprove: false });
    expect(a.of('alert')[0]!.data).toMatchObject({ alertId: al1, status: 'firing', severity: 'SEV2', kind: 'slo' });
    const last = a.lastId!;
    a.close();

    // 끊긴 동안: 명령 하나와 한 트랜잭션의 경보 둘(created_at이 같다)
    const c2 = await blockAsn(requester);
    const [al2, al3] = await insertAlerts(2);
    const same = await admin.query<{ n: string }>(`select count(distinct created_at) as n from ops_push_event where body->>'alertId' in ($1, $2)`, [al2, al3]);
    expect(Number(same.rows[0]!.n)).toBe(1);

    const b = await Sse.open(fullPort, '/v1/ops/live', { ...viewer, 'last-event-id': last });
    await vi.waitFor(() => expect(b.frames.map(refOf)).toEqual(expect.arrayContaining([c2.commandId, al2, al3])), { timeout: 10_000 });
    const missed = (await rowsAfter(Number(last))).filter((r) => r.kind !== 'approval');
    expect(b.frames.map((f) => [Number(f.id), f.event, refOf(f)])).toEqual(missed.map((r) => [r.seq, r.kind, (r.body.commandId ?? r.body.alertId) as string]));
    expect(b.of('reset')).toEqual([]);
    // 이어서 생긴 것도 받는다(중복 없음)
    const [al4] = await insertAlerts(1);
    await vi.waitFor(() => expect(b.frames.map(refOf)).toContain(al4));
    const ids = b.frames.map((f) => Number(f.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    b.close();
  });

  test('F-03-1 T2 FE-T28 ②-5 1시간 밖·지운 순번·숫자 아님·만든 적 없는 순번이면 첫 사건이 reset이고, reset의 id로 다시 붙으면 reset 없이 이어진다', async () => {
    const viewer = identity.ops('viewer');
    const firstOf = async (lastEventId: string) => {
      const s = await Sse.open(fullPort, '/v1/ops/live', { ...viewer, 'last-event-id': lastEventId });
      await vi.waitFor(() => expect(s.frames.length).toBeGreaterThan(0), { timeout: 10_000 });
      return s;
    };
    for (const bad of ['abc', '-3']) {
      const s = await firstOf(bad);
      expect(s.frames[0]).toEqual({ id: s.openings[0]!.id, event: 'reset', data: { reason: 'invalid' } });
      s.close();
    }
    const latest = Number((await admin.query<{ v: string }>('select last_value as v from ops_push_event_seq')).rows[0]!.v);
    const future = await firstOf(String(latest + 1_000));
    expect(future.frames[0]).toMatchObject({ event: 'reset', data: { reason: 'invalid' } });
    future.close();

    // 표를 비우고 61분 전·59분 전·지금 행을 둔다(창은 1시간). 파드의 읽기가 셋을 지나갈 때까지 지켜보는 흐름을 하나 둔다
    await admin.query('delete from ops_push_event');
    const sentinel = await Sse.open(fullPort, '/v1/ops/live', viewer);
    await vi.waitFor(() => expect(sentinel.openings.length).toBe(1));
    const ins = async (minutesAgo: number) =>
      Number(
        (
          await admin.query<{ seq: string }>(
            `insert into ops_push_event (kind, event_id, roles, body, created_at) values ('alert', null, 'viewer,operator,commander', jsonb_build_object('alertId', gen_random_uuid()::text, 'status', 'firing'), now() - make_interval(mins => $1)) returning seq`,
            [minutesAgo],
          )
        ).rows[0]!.seq,
      );
    const r61 = await ins(61);
    const r59 = await ins(59);
    const r0 = await ins(0);
    await vi.waitFor(() => expect(sentinel.frames.map((f) => Number(f.id))).toEqual([r61, r59, r0]), { timeout: 10_000 });
    sentinel.close();
    // r61까지 받은 사람은 창 안 r59·r0만 놓쳤다: 다시 보낸다
    const ok = await firstOf(String(r61));
    await vi.waitFor(() => expect(ok.frames.map((f) => Number(f.id))).toEqual([r59, r0]));
    expect(ok.of('reset')).toEqual([]);
    ok.close();
    // r61을 못 받은 사람은 1시간 밖을 놓쳤다: reset(too-old)
    const old = await firstOf(String(r61 - 1));
    expect(old.frames[0]).toMatchObject({ event: 'reset', data: { reason: 'too-old' } });
    expect(old.frames.filter((f) => f.event !== 'reset')).toEqual([]);
    const resetId = old.frames[0]!.id!;
    expect(Number(resetId)).toBeGreaterThanOrEqual(r0);
    old.close();
    // 창 안이어도 지운 순번 뒤면 too-old
    await admin.query('delete from ops_push_event where seq = $1', [r59]);
    const gone = await firstOf(String(r61));
    expect(gone.frames[0]).toMatchObject({ event: 'reset', data: { reason: 'too-old' } });
    gone.close();
    // reset의 id로 다시 붙으면 reset 없이 그 뒤를 받는다
    const again = await Sse.open(fullPort, '/v1/ops/live', { ...viewer, 'last-event-id': resetId });
    const [al] = await insertAlerts(1);
    await vi.waitFor(() => expect(again.frames.map(refOf)).toContain(al), { timeout: 10_000 });
    expect(again.of('reset')).toEqual([]);
    again.close();
  });

  test('F-03-1 T4 FE-T28 ④-9 X-User-Token-Exp 시각에 서버가 흐름을 닫고(token-expired), 세션이 끝나면 종료 세션 목록으로 닫는다(session-ended)', async () => {
    const before = { exp: fullLogs.closedCount('token-expired'), ended: fullLogs.closedCount('session-ended') };
    const op = identity.ops('operator');
    const exp = Math.floor(Date.now() / 1000) + 2;
    const s = await Sse.open(fullPort, '/v1/ops/live', { ...op, 'x-user-token-exp': String(exp) });
    await vi.waitFor(() => expect(s.openings.length).toBe(1));
    await vi.waitFor(() => expect(s.ended).toBe(true), { timeout: 10_000, interval: 100 });
    // 바로 닫은 것이 아니다(만료 시각 근처에서 닫았다)
    expect(Date.now()).toBeGreaterThanOrEqual(exp * 1000 - 200);
    await vi.waitFor(() => expect(fullLogs.closedCount('token-expired')).toBe(before.exp + 1));

    const op2 = identity.ops('operator');
    const t = await Sse.open(fullPort, '/v1/ops/live', op2);
    const other = await Sse.open(fullPort, '/v1/ops/live', identity.ops('operator'));
    await vi.waitFor(() => expect(t.openings.length).toBe(1));
    full.auth.terminateSession({ sessionId: op2['x-session-id']! });
    await vi.waitFor(() => expect(t.ended).toBe(true), { timeout: 12_000, interval: 100 });
    await vi.waitFor(() => expect(fullLogs.closedCount('session-ended')).toBe(before.ended + 1));
    expect(other.ended).toBe(false);
    other.close();
  });

  test('F-03-1 T8 승인 대기 사건은 요청자 본인과 viewer·CS에게 가지 않고 다른 operator·commander에게만 간다', async () => {
    const requester = identity.ops('operator');
    const people = { requester, operator: identity.ops('operator'), commander: identity.ops('commander'), viewer: identity.ops('viewer'), cs: identity.ops('cs_agent') };
    const s = Object.fromEntries(await Promise.all(Object.entries(people).map(async ([k, h]) => [k, await Sse.open(fullPort, '/v1/ops/live', h)] as const))) as Record<keyof typeof people, Sse>;
    for (const x of Object.values(s)) await vi.waitFor(() => expect(x.openings.length).toBe(1));
    const c = await blockAsn(requester);
    const approvalRow = (await pushRowsOf('commandId', c.commandId)).find((r) => r.kind === 'approval')!;
    expect(approvalRow.roles).toBe('operator,commander');
    for (const k of ['operator', 'commander'] as const) {
      await vi.waitFor(() => expect(s[k].of('approval').length).toBe(1), { timeout: 10_000 });
      // 흐름은 트리거가 쓴 시각 글을 ISO로 맞춰 낸다
      expect(s[k].of('approval')[0]!.data).toEqual({ commandId: c.commandId, type: 'BLOCK_ASN_IP', state: 'PENDING_APPROVAL', approvalExpiresAt: new Date(String(approvalRow.body.approvalExpiresAt)).toISOString() });
    }
    // 뒤 묶음(경보)이 viewer에게 닿을 때까지 기다린 뒤, 앞 묶음의 승인 대기가 요청자·viewer·CS에게 없었는지 본다
    const [marker] = await insertAlerts(1);
    for (const k of ['requester', 'viewer'] as const) await vi.waitFor(() => expect(s[k].frames.map(refOf)).toContain(marker), { timeout: 10_000 });
    expect(s.requester.of('approval')).toEqual([]);
    expect(s.requester.of('command').map(refOf)).toEqual([c.commandId]);
    expect(s.requester.of('command')[0]!.data).toMatchObject({ canApprove: false });
    expect(s.operator.of('command')[0]!.data).toMatchObject({ canApprove: true });
    expect(s.viewer.of('approval')).toEqual([]);
    expect(s.cs.frames).toEqual([]);
    for (const x of Object.values(s)) x.close();
  });
});

describe('F-03-1 알림 행은 원래 기록과 같은 트랜잭션(실제 PostgreSQL 트리거)', () => {
  test('F-03-1 T9 V-T9 명령 상태를 바꾼 트랜잭션을 되돌리면 알림 행이 없고, 커밋하면 정확한 행(kind·event_id·roles·본문)이 생긴다. 상태가 같으면(SET state = state 포함) 행이 없다', async () => {
    const id = randomUUID();
    const eventId = randomUUID();
    const insert = `insert into ops_command (id, type, state, reason, params, requested_by, requested_role, event_id, approval_expires_at, created_at, updated_at)
      values ($1, 'ADMISSION_TARGET', 'PENDING_APPROVAL', 'T9', '{}'::jsonb, $2, 'operator', $3, '2026-11-23T05:00:00Z', now(), now())`;
    const requester = randomUUID();
    await admin.query('begin');
    await admin.query(insert, [id, requester, eventId]);
    expect((await pushRowsOf('commandId', id)).length).toBe(2); // 트랜잭션 안에서는 보인다
    await admin.query('rollback');
    expect(await pushRowsOf('commandId', id)).toEqual([]);

    await admin.query('begin');
    await admin.query(insert, [id, requester, eventId]);
    await admin.query('commit');
    const body = { commandId: id, type: 'ADMISSION_TARGET', state: 'PENDING_APPROVAL', eventId, approvalExpiresAt: '2026-11-23T05:00:00+00:00' };
    expect(await pushRowsOf('commandId', id)).toEqual([
      { kind: 'command', roles: 'viewer,operator,commander', event_id: eventId, body },
      { kind: 'approval', roles: 'operator,commander', event_id: eventId, body },
    ]);

    await admin.query('begin');
    await admin.query(`update ops_command set state = 'APPROVED', updated_at = now() where id = $1`, [id]);
    await admin.query('rollback');
    expect((await pushRowsOf('commandId', id)).length).toBe(2);
    await admin.query(`update ops_command set reason = '사유만 바꿈', updated_at = now() where id = $1`, [id]);
    expect((await pushRowsOf('commandId', id)).length).toBe(2);
    await admin.query(`update ops_command set state = 'APPROVED', updated_at = now() where id = $1`, [id]);
    const after = await pushRowsOf('commandId', id);
    expect(after.length).toBe(3);
    // V-T9: state 칸을 SET해도 값이 같으면 쓰지 않는다(트리거가 UPDATE OF state로 불려도 IS NOT DISTINCT FROM으로 거른다)
    await admin.query(`update ops_command set state = state, updated_at = now() where id = $1`, [id]);
    await admin.query(`update ops_command set state = 'APPROVED' where id = $1`, [id]);
    expect((await pushRowsOf('commandId', id)).length).toBe(3);
    expect(after[2]).toEqual({ kind: 'command', roles: 'viewer,operator,commander', event_id: eventId, body: { ...body, state: 'APPROVED' } });

    // 경보: 되돌리면 없고, 커밋하면 한 줄, 풀리면 한 줄 더
    const alertId = randomUUID();
    const ins = `insert into ops_alert (id, event_key, kind, severity, source, reason, created_at) values ($1, $2, 'invariant', 'SEV1', 'it', '오버셀', now())`;
    await admin.query('begin');
    await admin.query(ins, [alertId, eventId]);
    await admin.query('rollback');
    expect(await pushRowsOf('alertId', alertId)).toEqual([]);
    await admin.query(ins, [alertId, eventId]);
    const fired = await pushRowsOf('alertId', alertId);
    expect(fired.map((r) => [r.kind, r.roles, r.event_id])).toEqual([['alert', 'viewer,operator,commander', eventId]]);
    expect(fired[0]!.body).toMatchObject({ alertId, status: 'firing', severity: 'SEV1', kind: 'invariant', sourceKind: 'invariant', title: '오버셀', eventId });
    await admin.query(`update ops_alert set resolved_at = now(), resolved_reason = 'ok' where id = $1`, [alertId]);
    const resolved = await pushRowsOf('alertId', alertId);
    expect(resolved.map((r) => r.body.status)).toEqual(['firing', 'resolved']);
    // 파트너 역할은 알림 표를 읽지 못한다(0028 권한)
    const grants = await admin.query<{ ok: boolean }>(`select has_table_privilege('ops_partner', 'ops_push_event', 'select') as ok`);
    expect(grants.rows[0]!.ok).toBe(false);
  });
});

describe('F-03-1 접속자와 위젯(실제 ops-svc·PostgreSQL·Prometheus)', () => {
  test('F-03-1 T6 FE-T28 ⑥ 운영자 둘이 같은 회차를 열면 둘 다 presence에 보이고, 하나가 닫으면 44초에는 남고 45초에 빠진다', async () => {
    const event = randomUUID();
    const a = identity.ops('operator');
    const b = identity.ops('commander');
    const refs = (s: Sse) => s.of('presence').map((f) => (f.data as { operators: { accountRef: string }[] }).operators.map((o) => o.accountRef));
    const sorted = (...xs: string[]) => [...xs].sort();
    const sa = await Sse.open(fastPort, `/v1/ops/live?eventId=${event}&screen=dashboard`, a);
    await vi.waitFor(() => expect(refs(sa).at(-1)).toEqual([a['x-user-id']]));
    const sb = await Sse.open(fastPort, `/v1/ops/live?eventId=${event}&screen=commands`, b);
    await vi.waitFor(() => expect(refs(sb).at(-1)).toEqual(sorted(a['x-user-id']!, b['x-user-id']!)));
    await vi.waitFor(() => expect(refs(sa).at(-1)).toEqual(sorted(a['x-user-id']!, b['x-user-id']!)));
    expect(sb.of('presence').at(-1)!.data).toEqual({
      eventId: event,
      operators: [
        { accountRef: a['x-user-id'], role: 'operator', screen: 'dashboard' },
        { accountRef: b['x-user-id'], role: 'commander', screen: 'commands' },
      ].sort((x, y) => (x.accountRef! < y.accountRef! ? -1 : 1)),
    });
    expect(sb.of('presence').at(-1)!.id).toBeUndefined();

    const closedBefore = fastLogs.closedCount('client');
    sa.close();
    await vi.waitFor(() => expect(fastLogs.closedCount('client')).toBe(closedBefore + 1));
    const seenOf = async (ref: string) => Number((await admin.query<{ ms: string }>(`select extract(epoch from last_seen_at) * 1000 as ms from ops_presence where account_ref = $1 and event_id = $2`, [ref, event])).rows[0]!.ms);
    const aSeen = await seenOf(a['x-user-id']!);

    // 44초: a의 마지막 기록에서 44초 뒤(b는 계속 고쳐 쓴다)
    fastClock.advance(aSeen + CANON.presenceWindowMs - 1_000 - fastClock.now());
    await vi.waitFor(async () => expect(await seenOf(b['x-user-id']!)).toBe(fastClock.now()));
    const c = identity.ops('viewer');
    const sc = await Sse.open(fastPort, `/v1/ops/live?eventId=${event}&screen=dashboard`, c);
    await vi.waitFor(() => expect(refs(sc).length).toBeGreaterThan(0));
    expect(refs(sc)[0]).toEqual(sorted(a['x-user-id']!, b['x-user-id']!, c['x-user-id']!));

    // 45초: a가 빠진다
    fastClock.advance(1_000);
    await vi.waitFor(() => expect(refs(sb).at(-1)).toEqual(sorted(b['x-user-id']!, c['x-user-id']!)), { timeout: 10_000 });
    await vi.waitFor(() => expect(refs(sc).at(-1)).toEqual(sorted(b['x-user-id']!, c['x-user-id']!)));
    sb.close();
    sc.close();
  });

  test('F-03-1 T7 FE-T28 ⑦-1 두 위젯 키마다 위젯 흐름의 value와 위젯 조회 응답이 같은 모양·같은 값이다(실제 Prometheus 원천)', async () => {
    switchSource.target = PrometheusWidgetSource.fromUrl(prometheusUrl);
    const viewer = identity.ops('viewer');
    // 앞 시험(T6)이 가짜 시계를 옮겼을 수 있어 지금 시계 값을 쓴다(채운 지표는 질의 시각 5분 안이라 같은 값이다)
    const nowMs = fastClock.now();
    const atIso = new Date(nowMs).toISOString();
    const qs = `eventId=${E7}&from=${encodeURIComponent(new Date(nowMs - 15 * 60_000).toISOString())}&to=${encodeURIComponent(atIso)}`;
    const restQ = await fast.http.inject({ method: 'GET', url: `/v1/ops/widgets/${Q}?${qs}`, headers: viewer });
    const restP = await fast.http.inject({ method: 'GET', url: `/v1/ops/widgets/${P}?${qs}`, headers: viewer });
    expect(restQ.statusCode, restQ.payload).toBe(200);
    expect(restQ.headers['cache-control']).toBe('no-store');
    const q = OpsWidgetQueueAdmissionRateSummary.parse(JSON.parse(restQ.payload));
    const p = OpsWidgetPurchasePgStatusSummary.parse(JSON.parse(restP.payload));
    expect({ ...q, series: undefined }).toEqual({ widgetKey: Q, source: 'prometheus', at: atIso, eventId: E7, ratio: METRICS.ratio, target: METRICS.target, slotsUsed: METRICS.slotsUsed, inFlight: METRICS.inFlight, soonWaiting: METRICS.soonWaiting, series: undefined });
    // 15분 창, 15초 간격 = 61점
    expect(q.series).toHaveLength(61);
    expect(new Set(q.series!.map((x) => x.ratio))).toEqual(new Set([METRICS.ratio]));
    expect(p.pgs.map((x) => x.pg)).toEqual(['portone', 'toss']);
    expect(p.pgs[1]).toMatchObject({ pg: 'toss', limitRatio: METRICS.tossLimit, circuitOpen: true, inflight: METRICS.tossInflight });
    expect(p.pgs[1]!.saturatedPerMin).toBeCloseTo(6, 5);
    expect(p.pgs[0]).toEqual({ pg: 'portone', limitRatio: METRICS.portoneLimit, circuitOpen: false, inflight: METRICS.portoneInflight, saturatedPerMin: 0 });

    const s = await Sse.open(fastPort, `/v1/ops/events/${E7}/live?widgets=${encodeURIComponent(`${Q},${P}`)}`, viewer);
    expect(s.status).toBe(200);
    await vi.waitFor(() => expect(new Set(s.of('widget').map((f) => (f.data as { widgetKey: string }).widgetKey))).toEqual(new Set([Q, P])), { timeout: 10_000 });
    for (const [key, rest] of [
      [Q, q],
      [P, p],
    ] as const) {
      const f = s.of('widget').find((x) => (x.data as { widgetKey: string }).widgetKey === key)!;
      expect(f.id).toBe(String(nowMs));
      const { series: _drop, ...restValue } = rest as typeof rest & { series?: unknown };
      expect(f.data).toEqual({ widgetKey: key, at: atIso, value: restValue });
    }
    s.close();
  });

  test('F-03-1 T7 FE-T28 ⑦-2 모르는 위젯 키는 흐름 422(unknown-widget-key)·조회 404이고, 원천이 실패하면 둘 다 source-unavailable 값이다', async () => {
    const viewer = identity.ops('viewer');
    for (const widgets of ['nope.summary', `${Q},nope.summary`, '']) {
      const s = await Sse.open(fastPort, `/v1/ops/events/${E7}/live?widgets=${encodeURIComponent(widgets)}`, viewer);
      expect(s.status, widgets).toBe(422);
      expect((JSON.parse(s.body!) as { type: string }).type).toBe('https://peaket.example/problems/unknown-widget-key');
    }
    expect((await fast.http.inject({ method: 'GET', url: '/v1/ops/widgets/nope.summary', headers: viewer })).statusCode).toBe(404);

    const atIso = new Date(fastClock.now()).toISOString();
    const unavailable = (key: WidgetKey) => ({ widgetKey: key, source: 'prometheus', at: atIso, eventId: E7, error: 'source-unavailable' });
    for (const target of ['status-500', 'status-error', 'closed-port'] as const) {
      if (target === 'closed-port') switchSource.target = PrometheusWidgetSource.fromUrl('http://127.0.0.1:9');
      else {
        stubMode = target;
        switchSource.target = PrometheusWidgetSource.fromUrl(stubUrl);
      }
      const rest = await fast.http.inject({ method: 'GET', url: `/v1/ops/widgets/${Q}?eventId=${E7}`, headers: viewer });
      expect(rest.statusCode, target).toBe(200);
      expect(OpsWidgetUnavailable.parse(JSON.parse(rest.payload))).toEqual(unavailable(Q));
      const s = await Sse.open(fastPort, `/v1/ops/events/${E7}/live?widgets=${P}`, viewer);
      // 앞 시험이 남긴 같은 (회차, 키) 값이 먼저 올 수 있어, 원천을 바꾼 뒤 계산한 값이 올 때까지 본다(계산 주기 100ms)
      await vi.waitFor(() => expect(s.of('widget').at(-1)?.data).toEqual({ widgetKey: P, at: atIso, value: unavailable(P) }), { timeout: 10_000 });
      s.close();
    }
    switchSource.target = PrometheusWidgetSource.fromUrl(prometheusUrl);
  });
});

describe('F-03-1 리뷰 반영: 파드의 알림 표 읽기(실제 ops-svc·PostgreSQL)', () => {
  /** 다른 연결에서 커밋하지 않고 경보 행 하나를 넣는다(트리거가 순번을 받는다). 돌려준 함수로 커밋한다 */
  async function holdAlert(): Promise<{ alertId: string; seq: number; commit: () => Promise<void> }> {
    if (!late) {
      late = new pg.Client({ connectionString: container!.url });
      await late.connect();
    }
    const alertId = randomUUID();
    await late.query('begin');
    await late.query(`insert into ops_alert (id, event_key, kind, severity, source, reason, created_at) values ($1, $2, 'slo', 'SEV3', 'it', '늦은 커밋', now())`, [alertId, randomUUID()]);
    const seq = Number((await late.query<{ seq: string }>(`select seq from ops_push_event where body->>'alertId' = $1`, [alertId])).rows[0]!.seq);
    return {
      alertId,
      seq,
      commit: async () => {
        await late!.query('commit');
      },
    };
  }
  const seqOf = async (alertId: string) => Number((await admin.query<{ seq: string }>(`select seq from ops_push_event where body->>'alertId' = $1`, [alertId])).rows[0]!.seq);
  const arrives = async (s: Sse, ref: string, timeout = 8_000) =>
    vi.waitFor(() => expect(s.frames.map(refOf)).toContain(ref), { timeout, interval: 100 }).then(
      () => true,
      () => false,
    );

  test('F-03-1 RV-01 ① 마지막 연결이 닫혀 읽기가 멈춘 뒤 Last-Event-ID 없이 연 연결은 첫 id가 지금 순번이고 멈춘 동안의 지난 경보를 받지 않는다(openapi /v1/ops/live, ADR-0360 결정 2)', async () => {
    const viewer = identity.ops('viewer');
    const closedBefore = fullLogs.closedCount('client');
    const a = await Sse.open(fullPort, '/v1/ops/live', viewer);
    await vi.waitFor(() => expect(a.openings.length).toBe(1));
    a.close();
    await vi.waitFor(() => expect(fullLogs.closedCount('client')).toBe(closedBefore + 1));
    const [x, y] = await insertAlerts(2);
    const ySeq = await seqOf(y!);
    const b = await Sse.open(fullPort, '/v1/ops/live', viewer);
    await vi.waitFor(() => expect(b.openings.length).toBe(1));
    expect(Number(b.openings[0]!.id), '첫 덩이 id는 지금 순번').toBeGreaterThanOrEqual(ySeq);
    const [z] = await insertAlerts(1);
    await vi.waitFor(() => expect(b.frames.map(refOf)).toContain(z), { timeout: 10_000 });
    expect(b.frames.map(refOf)).not.toContain(x);
    expect(b.frames.map(refOf)).not.toContain(y);
    expect(b.frames.map(refOf)).toEqual([z]);
    b.close();
  });

  test('F-03-1 RV-01 ② 커밋 전 트랜잭션이 순번을 쥔 채 파드가 새로 뜨면, 그 행이 커밋된 뒤 Last-Event-ID 없이 연 연결이 받는다(시퀀스 값을 정한 번호로 잡지 않는다)', async () => {
    const held = await holdAlert();
    extra = await createService({
      name: 'ops-svc',
      module: AppModule.register({ database: db, adminAccounts: adminAccountsForCommands, background: false }),
      env: { PEAKET_ENV: 'ci' },
      logDestination: new LogLines(),
      adminAuthz: identity,
    });
    await extra.http.listen({ host: '127.0.0.1', port: 0 });
    const port = (extra.http.server.address() as AddressInfo).port;
    const c = await Sse.open(port, '/v1/ops/live', identity.ops('viewer'));
    await vi.waitFor(() => expect(c.openings.length).toBe(1));
    expect(Number(c.openings[0]!.id), '첫 id가 커밋 전 순번을 넘지 않는다').toBeLessThan(held.seq);
    await held.commit();
    const [marker] = await insertAlerts(1);
    await vi.waitFor(() => expect(c.frames.map(refOf)).toContain(marker), { timeout: 10_000 });
    expect(c.frames.map(refOf)).toContain(held.alertId);
    c.close();
  });

  test('F-03-1 RV-02 ADR-0100 결정 2 빠지지 않게 다시 붙기(ADR-0360 남는 한계에 늦은 커밋의 빠짐이 없어 정본은 빠지지 않음) 3초 늦게 커밋된 경보는 늘 여는 흐름에도 다시 붙기에도 온다', async () => {
    const viewer = identity.ops('viewer');
    const live = await Sse.open(fullPort, '/v1/ops/live', viewer);
    const gone = await Sse.open(fullPort, '/v1/ops/live', viewer);
    await vi.waitFor(() => expect([live.openings.length, gone.openings.length]).toEqual([1, 1]));
    const held = await holdAlert();
    const [after] = await insertAlerts(1);
    // 파드는 빈 번호를 2초 기다린 뒤 뒤 번호를 보낸다(ADR-0360 결정 2)
    // (RV-01이 남아 있으면 멈췄던 파드가 지난 행을 함께 보낼 수 있어, 이 시험은 늦은 행과 뒤 행만 본다)
    await vi.waitFor(() => expect([live.frames.map(refOf), gone.frames.map(refOf)]).toEqual([expect.arrayContaining([after]), expect.arrayContaining([after])]), { timeout: 10_000, interval: 100 });
    expect(live.frames.map(refOf)).not.toContain(held.alertId);
    const resumeFrom = gone.lastId!;
    expect(Number(resumeFrom)).toBeGreaterThan(held.seq);
    gone.close();
    // 2초를 넘겨 커밋한다(위 기다림이 이미 2초를 넘겼다)
    await held.commit();
    const back = await Sse.open(fullPort, '/v1/ops/live', { ...viewer, 'last-event-id': resumeFrom });
    const got = { live: await arrives(live, held.alertId), resume: await arrives(back, held.alertId) };
    expect(got, `늦게 커밋된 순번 ${held.seq}(커서 ${resumeFrom})`).toEqual({ live: true, resume: true });
    live.close();
    back.close();
  });
});
