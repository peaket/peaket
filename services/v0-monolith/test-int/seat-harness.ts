// 좌석 v0 통합 시험 도우미(docs/features/seat-hold.md §14).
// 파일마다 PostgreSQL 18 컨테이너와 Valkey 컨테이너를 하나씩 띄워 같이 쓰고, 시계만 가짜(fakeClock)로 둔다.
// - 좌석 열기·만료는 모듈 공개 함수(createSeatAdmin), 입장은 대기열 v0 HTTP(진입 → 입장 루프 한 칸 → 입장 확정, queue-admission §13)로 한다
// - HTTP는 inject로, 변경분 WebSocket은 실제 포트(svc.listen)로 부른다(inject는 업그레이드를 하지 못한다)
// - 표 상태는 시험 전용 연결로 직접 읽는다. 시험마다 회차 ID를 새로 만들어 서로 섞이지 않게 한다
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createDatabase, createService, fakeClock, type Database, type FakeClock, type PlatformService, type RedisCommander } from '@peaket/platform';
import pg from 'pg';
import { createClient } from 'redis';
import { expect } from 'vitest';
import { WebSocket } from 'ws';
import { migrateV0 } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import {
  createPgDeltaFeed,
  createSeatAdmin,
  type PgDeltaFeed,
  type SeatAdmin,
  type SeatDefinition,
  type SeatEventConfig,
} from '../src/modules/inventory/index.js';
import { createAdmissionReader, createQueueAdmin, type QueueAdmin } from '../src/modules/queue/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { fanHeaders, type Headers, type Reply } from './queue-harness.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

/** 홀드 TTL 기본값(POL-012, 7분). 모듈 상수를 믿지 않고 정책 값을 그대로 쓴다 */
export const TTL_MS = 7 * 60 * 1000;
/** 1회 연장 기본값(POL-012, 3분) */
export const EXTEND_MS = 3 * 60 * 1000;
/** 변경분 pg_notify 채널(§14 동작 6) */
export const DELTA_CHANNEL_NAME = 'v0_seat_delta';
/** 변경분 WebSocket의 허용 출처(시험 설정. 실제 포트와 상관없이 Origin 머리로만 대조한다, ASVS 4.4.2) */
export const ALLOWED_ORIGIN = 'http://127.0.0.1:8088';
export const SECOND_ALLOWED_ORIGIN = 'http://localhost:8088';
/** 변경분을 기다리는 한도(커밋 뒤 pg_notify → LISTEN → WebSocket) */
export const DELTA_WAIT_MS = 5_000;
/** 받지 않아야 할 변경분을 기다려 보는 시간(이 시간 안에 오지 않으면 오지 않은 것으로 본다. 보통은 표지 변경분으로 순서를 대신 본다) */
export const QUIET_MS = 300;
/** 앞 시험이 남긴 홀드를 모두 풀 때 지금보다 앞당겨 보는 시간(TTL 상한 60분 + 연장 상한 30분보다 길게) */
export const FLUSH_AHEAD_MS = 3 * 60 * 60 * 1000;
/** 서비스 DB 풀 크기. 동시 시험(S-T1 25명)이 풀 대기(핫패스 100ms)로 429를 받지 않게 넉넉히 둔다 */
const POOL_MAX = 40;
/** 입장 루프 한 칸에 부를 수(시험 인원보다 크게) */
const ADMIT_PER_SECOND = 1_000;

const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

/** 닫기 한 단계를 기다리는 한도 */
const CLOSE_STEP_MS = 10_000;

/** 정한 시간까지만 기다린다(실패도 삼킨다) */
async function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([p.catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SeatReply extends Reply {
  headers: Record<string, string | string[] | number | undefined>;
}

/** 좌석 ID 목록으로 좌석 정의를 만든다(좌석 칸은 시험이 정한 단순한 값. 같은 열에 10 간격) */
export function seatDefs(ids: string[], o: { section?: string; grade?: string } = {}): SeatDefinition[] {
  return ids.map((id, i) => ({ id, section: o.section ?? 'A', row: '1', number: i + 1, x: i * 10, y: 0, grade: o.grade ?? 'R' }));
}

/** prefix-1 … prefix-n */
export const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);

/** 기준식: 유닉스 밀리초 → KST 오프셋의 ISO 8601(밀리초 세 자리, +09:00) */
export function refKst(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00');
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SeatRow {
  seatId: string;
  status: string;
  holdId: string | null;
}
export interface HoldRow {
  holdId: string;
  eventId: string;
  accountId: string;
  seatIds: string[];
  status: string;
  extended: boolean;
  heldAtMs: number;
  expiresAtMs: number;
}
export interface QuotaRow {
  accountId: string;
  held: number;
}
export interface EventSnapshot {
  seats: SeatRow[];
  holds: HoldRow[];
  quotas: QuotaRow[];
}

/** 변경분 한 건의 모양(§14 동작 6) */
export interface DeltaMessage {
  eventId: string;
  changes: { seatId: string; status: string }[];
  atMs: number;
}

/** 비교용: changes를 좌석 ID 순으로 정렬한다(한 변경분 안의 좌석 순서는 정본이 정하지 않는다) */
export function sortedDelta(d: DeltaMessage): DeltaMessage {
  return { ...d, changes: [...d.changes].sort((a, b) => (a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0)) };
}

export function changesOf(seatIds: string[], status: string): { seatId: string; status: string }[] {
  return [...seatIds].sort().map((seatId) => ({ seatId, status }));
}

/** 받은 글을 차례대로 모아 두고, 정한 수가 올 때까지 기다린다 */
export class Inbox {
  readonly raw: string[] = [];
  readonly binary: boolean[] = [];
  private wake: (() => void)[] = [];

  push(text: string, isBinary: boolean): void {
    this.raw.push(text);
    this.binary.push(isBinary);
    const w = this.wake;
    this.wake = [];
    for (const f of w) f();
  }

  /** 받은 글을 JSON으로 읽는다 */
  get messages(): DeltaMessage[] {
    return this.raw.map((r) => JSON.parse(r) as DeltaMessage);
  }

  /** n건이 될 때까지 기다린다. 한도를 넘으면 받은 것을 실어 실패한다 */
  async waitForCount(n: number, timeoutMs = DELTA_WAIT_MS, what = '변경분'): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.raw.length < n) {
      const left = end - Date.now();
      if (left <= 0) throw new Error(`${what} ${n}건을 ${timeoutMs}ms 안에 받지 못했다(받은 것 ${this.raw.length}건: ${JSON.stringify(this.raw)})`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.wake.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}

export type WsOutcome =
  | { kind: 'open'; ws: WebSocket; inbox: Inbox }
  | { kind: 'rejected'; status: number }
  | { kind: 'error'; message: string };

/** 시험 전용 LISTEN 연결: 서비스가 낸 pg_notify를 그대로 받는다(변경분 포트와 상관없이 원본을 본다) */
export interface NotifyListener {
  inbox: Inbox;
  close(): Promise<void>;
}

let eventCounter = 0;

export class SeatHarness {
  private admin_: SeatAdmin | undefined;
  private feedReady_: Promise<void> | undefined;
  private readonly sockets = new Set<WebSocket>();
  private readonly closers: (() => Promise<unknown>)[] = [];

  private constructor(
    private readonly postgres: PostgresContainer,
    private readonly valkey: ValkeyContainer,
    readonly database: Database,
    readonly deltaFeed: PgDeltaFeed,
    readonly inspect: pg.Pool,
    readonly svc: PlatformService,
    readonly clock: FakeClock,
    readonly queueAdmin: QueueAdmin,
    readonly port: number,
    closers: (() => Promise<unknown>)[],
  ) {
    this.closers.push(...closers);
  }

  /** 컨테이너 둘·마이그레이션·모놀리스(입장 루프·만료 루프 끔)를 띄우고 실제 포트를 연다 */
  static async start(): Promise<SeatHarness> {
    const stops: (() => void)[] = [];
    const closers: (() => Promise<unknown>)[] = [];
    try {
      const [p, v] = await Promise.allSettled([startPostgres(), startValkey()]);
      if (p.status === 'fulfilled') stops.push(() => p.value.stop());
      if (v.status === 'fulfilled') stops.push(() => v.value.stop());
      if (p.status === 'rejected') throw p.reason;
      if (v.status === 'rejected') throw v.reason;
      const postgres = p.value;
      const valkey = v.value;
      await migrateV0(postgres.url);

      const client = createClient({ url: valkey.url });
      client.on('error', () => {});
      await client.connect();
      closers.push(() => client.quit());
      const redis: RedisCommander = { sendCommand: (args) => client.sendCommand(args) };

      const database = createDatabase({ url: postgres.url, applicationName: 'v0-monolith', profile: 'hot', max: POOL_MAX });
      closers.push(() => database.close());
      const deltaFeed = createPgDeltaFeed(postgres.url);
      closers.push(() => deltaFeed.close());
      const inspect = new pg.Pool({ connectionString: postgres.url, max: 4 });
      inspect.on('error', () => {});
      closers.push(() => inspect.end());

      const clock = fakeClock();
      const svc = await createService({
        name: 'v0-monolith',
        module: AppModule.register({
          queue: { redis, tickIntervalMs: false },
          inventory: {
            database,
            admission: createAdmissionReader(redis),
            deltaFeed,
            allowedOrigins: [ALLOWED_ORIGIN, SECOND_ALLOWED_ORIGIN],
            expiryIntervalMs: false,
          },
        }),
        env: { PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' },
        clock,
        logDestination: quiet(),
      });
      // 서비스는 다른 연결보다 먼저 닫는다
      closers.unshift(() => svc.close());
      const { port } = await svc.listen('127.0.0.1');
      return new SeatHarness(postgres, valkey, database, deltaFeed, inspect, svc, clock, createQueueAdmin(redis), port, closers);
    } catch (err) {
      // 띄우다 실패하면 afterAll이 닫을 것이 없다. 연결과 컨테이너가 남지 않게 여기서 지운다
      for (const close of closers) await bounded((async () => close())(), CLOSE_STEP_MS);
      for (const stop of stops) stop();
      throw err;
    }
  }

  /** DB 접속 주소(오류 응답에 실리지 않는지 본다) */
  get databaseUrl(): string {
    return this.postgres.url;
  }

  /** 좌석 열기·만료 공개 함수(서비스와 같은 DB 풀). 처음 쓸 때 만든다 */
  get seatAdmin(): SeatAdmin {
    return (this.admin_ ??= createSeatAdmin(this.database));
  }

  /** 다른 복제본처럼 따로 연 DB 풀로 공개 함수를 하나 더 만든다 */
  secondSeatAdmin(): SeatAdmin {
    const db = createDatabase({ url: this.postgres.url, applicationName: 'v0-monolith-2', profile: 'hot', max: 5 });
    this.closers.push(() => db.close());
    return createSeatAdmin(db);
  }

  /** 변경분 LISTEN이 시작될 때까지 기다린다(변경분 시험은 먼저 부른다) */
  feedReady(): Promise<void> {
    return (this.feedReady_ ??= this.deltaFeed.ready());
  }

  /** 시험마다 새 회차 ID(영숫자·-·_ 1~64자) */
  newEventId(): string {
    eventCounter += 1;
    return `sv${eventCounter}-${randomUUID().slice(0, 8)}`;
  }

  /** 좌석을 연다. 기본은 좌석 6개(<회차>-s-1…), 1인 한도 4, TTL·연장은 기본값 */
  async openEvent(seatIds?: string[], config: Partial<SeatEventConfig> = {}, eventId = this.newEventId()): Promise<string> {
    await this.seatAdmin.open(eventId, { perPersonLimit: 4, ...config }, seatDefs(seatIds ?? ids('S', 6)));
    return eventId;
  }

  /** 대기열 v0로 사람들을 그 회차에 입장시킨다(진입 → 1초 뒤 입장 루프 한 칸 → 입장 확정). 시계가 1초 간다 */
  async admit(eventId: string, pids: string[]): Promise<void> {
    await this.queueAdmin.open(eventId, { admitPerSecond: ADMIT_PER_SECOND });
    for (const pid of pids) {
      const r = await this.http('POST', `/v1/queues/${eventId}/entries`, fanHeaders(pid));
      expect(r.status, `진입 ${pid}: ${r.raw}`).toBe(201);
    }
    this.clock.advance(1000);
    await this.queueAdmin.tick(this.clock.now());
    for (const pid of pids) {
      const r = await this.http('POST', `/v1/queues/${eventId}/admission`, fanHeaders(pid));
      expect({ status: r.status, state: r.body?.status }, `입장 확정 ${pid}: ${r.raw}`).toEqual({ status: 200, state: 'ADMITTED' });
    }
  }

  /** 대기열에 진입만 시킨다(차례 전) */
  async enterOnly(eventId: string, pid: string): Promise<void> {
    await this.queueAdmin.open(eventId, { admitPerSecond: ADMIT_PER_SECOND });
    const r = await this.http('POST', `/v1/queues/${eventId}/entries`, fanHeaders(pid));
    expect(r.status, r.raw).toBe(201);
  }

  // ───────────── HTTP ─────────────

  async http(method: 'GET' | 'POST' | 'DELETE', url: string, headers: Headers, body?: unknown, rawBody?: string): Promise<SeatReply> {
    const h: Headers = { ...headers };
    let payload: string | undefined;
    if (rawBody !== undefined) {
      payload = rawBody;
      h['content-type'] = 'application/json';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    const res = await this.svc.http.inject({ method, url, headers: h, ...(payload !== undefined ? { payload } : {}) });
    const raw = res.payload;
    const ct = res.headers['content-type'];
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.statusCode, contentType: ct === undefined ? undefined : String(ct), raw, body: parsed, headers: res.headers };
  }

  seats(eventId: string, headers: Headers): Promise<SeatReply> {
    return this.http('GET', `/v0/events/${eventId}/seats`, headers);
  }

  hold(eventId: string, seatIds: string[], headers: Headers): Promise<SeatReply> {
    return this.http('POST', `/v1/events/${eventId}/holds`, headers, { seatIds });
  }

  release(holdId: string, headers: Headers): Promise<SeatReply> {
    return this.http('DELETE', `/v1/holds/${holdId}`, headers);
  }

  extend(holdId: string, headers: Headers): Promise<SeatReply> {
    return this.http('POST', `/v1/holds/${holdId}/extension`, headers);
  }

  /** 홀드가 201이어야 하는 준비 단계. holdId를 돌려준다 */
  async holdOk(eventId: string, seatIds: string[], headers: Headers): Promise<string> {
    const r = await this.hold(eventId, seatIds, headers);
    expect(r.status, `홀드 준비 ${seatIds.join(',')}: ${r.raw}`).toBe(201);
    return r.body.holdId as string;
  }

  /**
   * 동시 시험 직전에 서비스 DB 풀의 연결을 미리 연다. 핫패스 풀은 연결을 100ms까지만 기다리므로
   * 빈 풀에서 수십 개를 한꺼번에 열면 경합 판정이 아니라 풀 대기로 429가 날 수 있다(쉬는 연결은 10초 뒤 닫힌다)
   */
  async warmPool(n = POOL_MAX): Promise<void> {
    const clients: pg.PoolClient[] = [];
    try {
      for (let i = 0; i < n; i += 1) {
        for (let attempt = 0; ; attempt += 1) {
          try {
            clients.push(await this.database.pool.connect());
            break;
          } catch (err) {
            if (attempt >= 5) throw err;
          }
        }
      }
    } finally {
      for (const c of clients) c.release();
    }
  }

  // ───────────── 표 읽기 ─────────────

  async seatRows(eventId: string): Promise<SeatRow[]> {
    const r = await this.inspect.query<{ seat_id: string; status: string; hold_id: string | null }>(
      'select seat_id, status, hold_id from v0_seat where event_id = $1 order by seat_id',
      [eventId],
    );
    return r.rows.map((x) => ({ seatId: x.seat_id, status: x.status, holdId: x.hold_id }));
  }

  async holdRows(eventId: string): Promise<HoldRow[]> {
    const r = await this.inspect.query<{
      hold_id: string;
      event_id: string;
      account_id: string;
      seat_ids: string[];
      status: string;
      extended: boolean;
      held_at: Date;
      expires_at: Date;
    }>('select hold_id, event_id, account_id, seat_ids, status, extended, held_at, expires_at from v0_hold where event_id = $1 order by held_at, hold_id', [eventId]);
    return r.rows.map((x) => ({
      holdId: x.hold_id,
      eventId: x.event_id,
      accountId: x.account_id,
      seatIds: [...x.seat_ids].sort(),
      status: x.status,
      extended: x.extended,
      heldAtMs: x.held_at.getTime(),
      expiresAtMs: x.expires_at.getTime(),
    }));
  }

  async holdRow(holdId: string): Promise<HoldRow | undefined> {
    const r = await this.inspect.query<{ event_id: string }>('select event_id from v0_hold where hold_id = $1', [holdId]);
    if (r.rows.length === 0) return undefined;
    return (await this.holdRows(r.rows[0]!.event_id)).find((x) => x.holdId === holdId);
  }

  async quotaRows(eventId: string): Promise<QuotaRow[]> {
    const r = await this.inspect.query<{ account_id: string; held: number }>(
      'select account_id, held from v0_quota where event_id = $1 order by account_id',
      [eventId],
    );
    return r.rows.map((x) => ({ accountId: x.account_id, held: x.held }));
  }

  /** 계정이 그 회차에서 잡고 있는 좌석 수(행이 없으면 0) */
  async held(eventId: string, accountId: string): Promise<number> {
    return (await this.quotaRows(eventId)).find((q) => q.accountId === accountId)?.held ?? 0;
  }

  /** 행이 0인 보유 수는 없는 것과 같게 본다(행을 남길지 지울지는 정본이 정하지 않는다) */
  async snapshot(eventId: string): Promise<EventSnapshot> {
    return {
      seats: await this.seatRows(eventId),
      holds: await this.holdRows(eventId),
      quotas: (await this.quotaRows(eventId)).filter((q) => q.held !== 0),
    };
  }

  /** 좌석이 그 회차에서 어느 상태인지(좌석 ID → 상태) */
  async seatStatus(eventId: string): Promise<Record<string, string>> {
    return Object.fromEntries((await this.seatRows(eventId)).map((s) => [s.seatId, s.status]));
  }

  /**
   * 좌석·홀드·보유 수가 서로 어긋나지 않는지 본다(S-T4·S-T10 '부분 홀드 0', POL-011):
   * HELD 좌석은 그 좌석을 가진 HELD 홀드 하나를 가리키고, HELD 홀드의 좌석은 모두 그 홀드로 HELD이며,
   * 계정마다 보유 수 = 그 계정의 HELD 홀드 좌석 수의 합이다
   */
  async expectConsistent(eventId: string): Promise<EventSnapshot> {
    const snap = await this.snapshot(eventId);
    const live = snap.holds.filter((x) => x.status === 'HELD');
    const byHold = new Map(live.map((x) => [x.holdId, x]));
    const bySeat = new Map(snap.seats.map((s) => [s.seatId, s]));
    for (const s of snap.seats) {
      if (s.status === 'HELD') {
        expect(byHold.get(s.holdId ?? '')?.seatIds, `좌석 ${s.seatId}가 가리키는 HELD 홀드`).toContain(s.seatId);
      } else {
        expect(s.holdId, `좌석 ${s.seatId}(${s.status})의 hold_id`).toBeNull();
      }
    }
    const owners = new Map<string, number>();
    for (const x of live) {
      for (const id of x.seatIds) {
        expect(bySeat.get(id), `홀드 ${x.holdId}의 좌석 ${id}`).toEqual({ seatId: id, status: 'HELD', holdId: x.holdId });
        owners.set(id, (owners.get(id) ?? 0) + 1);
      }
    }
    for (const [id, n] of owners) expect(n, `좌석 ${id}를 가진 HELD 홀드 수`).toBe(1);
    const accounts = new Set([...snap.quotas.map((q) => q.accountId), ...live.map((x) => x.accountId)]);
    for (const a of accounts) {
      const sum = live.filter((x) => x.accountId === a).reduce((n, x) => n + x.seatIds.length, 0);
      expect(snap.quotas.find((q) => q.accountId === a)?.held ?? 0, `계정 ${a}의 보유 수`).toBe(sum);
    }
    return snap;
  }

  /**
   * 서비스 DB 연결에 끝나지 않은 트랜잭션이 없는지 본다(S-T10 '남은 잠금 없음'). 행 잠금은 트랜잭션이 끝날 때 풀리므로,
   * 응답을 모두 받은 뒤에는 그 요청들의 트랜잭션이 커밋이나 되돌리기로 끝나 있어야 한다(교착으로 끊긴 쪽 포함)
   */
  async expectNoOpenTransactions(label = ''): Promise<void> {
    const r = await this.inspect.query<{ application_name: string; state: string; query: string }>(
      `select application_name, state, left(query, 160) as query from pg_stat_activity
       where application_name like 'v0-monolith%' and pid <> pg_backend_pid()
         and (state like 'idle in transaction%' or backend_xid is not null)`,
    );
    expect(r.rows, `끝나지 않은 트랜잭션 ${label}`).toEqual([]);
  }

  /** 앞 시험이 남긴 홀드를 모두 푼다(만료는 모든 회차를 보므로, 푼 수를 셀 시험은 먼저 부른다) */
  async flushExpired(): Promise<void> {
    await this.seatAdmin.expire(this.clock.now() + FLUSH_AHEAD_MS);
  }

  // ───────────── 변경분 ─────────────

  /** 시험 전용 LISTEN 연결로 v0_seat_delta 알림을 받는다 */
  async listenNotifications(): Promise<NotifyListener> {
    const client = new pg.Client({ connectionString: this.postgres.url });
    client.on('error', () => {});
    await client.connect();
    const inbox = new Inbox();
    client.on('notification', (n) => {
      if (n.channel === DELTA_CHANNEL_NAME) inbox.push(n.payload ?? '', false);
    });
    await client.query(`LISTEN ${DELTA_CHANNEL_NAME}`);
    const close = async () => {
      await client.end().catch(() => {});
    };
    this.closers.push(close);
    return { inbox, close };
  }

  /** 그 회차 알림만 고른다(from: 받은 순서의 몇 번째 알림부터 볼지) */
  static forEvent(inbox: Inbox, eventId: string, from = 0): DeltaMessage[] {
    return inbox.messages.slice(from).filter((m) => m.eventId === eventId);
  }

  /**
   * 표지 변경분이 올 때까지 기다린 뒤 그 회차 알림을 돌려준다(from부터, 표지 포함). PostgreSQL은 알림을 트랜잭션이
   * 커밋된 순서로 넘기므로(NOTIFY 문서), 표지보다 먼저 커밋된 변경분은 이때 모두 와 있다. 그래서 '나가지 않은 변경분'을
   * 시간을 기다리지 않고 본다. 표지와 같은 모양의 변경분이 앞에 또 있으면 occurrences로 몇 번째 것까지 기다릴지 정한다
   */
  static async untilMarker(inbox: Inbox, eventId: string, marker: DeltaMessage, from = 0, occurrences = 1): Promise<DeltaMessage[]> {
    // 칸 순서와 상관없이 견준다
    const key = (m: DeltaMessage) => JSON.stringify([m.eventId, sortedDelta(m).changes.map((c) => [c.seatId, c.status]), m.atMs]);
    const want = key(marker);
    const seen = () => SeatHarness.forEvent(inbox, eventId, from).filter((m) => key(m) === want).length >= occurrences;
    const end = Date.now() + DELTA_WAIT_MS;
    while (!seen()) {
      if (Date.now() > end) throw new Error(`표지 변경분 ${want}을 ${DELTA_WAIT_MS}ms 안에 받지 못했다(받은 것: ${JSON.stringify(SeatHarness.forEvent(inbox, eventId, from))})`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return SeatHarness.forEvent(inbox, eventId, from).map(sortedDelta);
  }

  /** 실제 포트로 WebSocket 업그레이드를 보낸다. 101이면 열린 연결, 아니면 받은 상태 코드 */
  connect(path: string, headers: Headers, origin?: string): Promise<WsOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (o: WsOutcome) => {
        if (settled) return;
        settled = true;
        resolve(o);
      };
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}${path}`, {
        headers,
        ...(origin !== undefined ? { origin } : {}),
        handshakeTimeout: DELTA_WAIT_MS,
      });
      this.sockets.add(ws);
      const inbox = new Inbox();
      // 열리자마자 오는 글을 놓치지 않게 먼저 붙인다
      ws.on('message', (data, isBinary) => inbox.push(String(data), isBinary));
      ws.on('open', () => done({ kind: 'open', ws, inbox }));
      ws.on('unexpected-response', (_req, res) => {
        res.resume();
        done({ kind: 'rejected', status: res.statusCode ?? 0 });
        ws.terminate();
      });
      ws.on('error', (err) => done({ kind: 'error', message: err.message }));
      ws.on('close', () => this.sockets.delete(ws));
    });
  }

  deltaPath(eventId: string): string {
    return `/v0/events/${eventId}/seat-deltas`;
  }

  /** 변경분 연결이 열려야 하는 준비 단계 */
  async openDeltas(eventId: string, headers: Headers, origin = ALLOWED_ORIGIN): Promise<{ ws: WebSocket; inbox: Inbox }> {
    const o = await this.connect(this.deltaPath(eventId), headers, origin);
    if (o.kind !== 'open') throw new Error(`변경분 연결 ${eventId}이 열리지 않았다: ${JSON.stringify(o)}`);
    return o;
  }

  closeSockets(): void {
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
  }

  async close(): Promise<void> {
    try {
      this.closeSockets();
      // 닫기 하나가 매달려도(끝나지 않은 업그레이드 소켓 등) 다음으로 넘어가 컨테이너를 꼭 지운다
      for (const close of this.closers) await bounded((async () => close())(), CLOSE_STEP_MS);
    } finally {
      // 앞에서 무엇이 실패해도 컨테이너는 지운다
      this.postgres?.stop();
      this.valkey?.stop();
    }
  }
}
