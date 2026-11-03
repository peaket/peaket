// 결제·발권 v0 통합 시험 도우미(docs/features/payment.md §13, docs/features/offline-gate.md §13, docs/features/seat-hold.md §14 동작 9).
// 좌석 v0 도우미(seat-harness.ts)와 같은 방식으로 띄우되 주문·결제·발권 v0(AppModule의 sale)를 함께 띄운다.
// - 파일마다 PostgreSQL 18·Valkey 컨테이너를 하나씩 띄우고, 시계만 가짜(fakeClock)로 둔다
// - PG 시뮬레이터는 프로세스 안에서 루프백 무작위 포트로 띄우고(실제 HTTP), 서비스는 createV0PaymentGateway로 그 주소를 부른다.
//   시뮬레이터의 시계는 서비스의 fakeClock과 같은 객체다(결제사 승인 시각과 주문 이력 시각이 같은 시계여야 불변식 P3·P4가 맞게 센다).
//   어댑터에는 시계를 넘기지 않는다(읽기 시간 초과는 실제 타이머). 시험 키는 실행마다 새로 만든다(ASVS v5.0.0-13.3.1)
// - 결제창 인증은 시뮬레이터의 시험용 인증 POST /sim/authenticate가 돌려준 paymentKey로 대신한다(payment §13 'v0에 없는 것')
// - 시뮬레이터가 받은 결제사 모양 호출(/v1/payments…)을 HTTP 서버에서 그대로 적어 둔다(승인 호출 수·조회 호출 유무를 본다)
// - 시뮬레이터가 만들 수 없는 결제사 응답(승인 금액이 다름·입금 대기)은 서비스 어댑터의 fetch에서 그 주문의 응답만 바꿔 만든다(tamperConfirm)
// - 잠금 경합은 시험 전용 연결이 행을 잠가(lockRows), 발권 실패는 그 회차 티켓만 막는 검사 조건으로(blockTicketsFor) 만든다
// - 서비스 로그는 버리지 않고 모아 둔다(결제 참조·시험 키·티켓 코드가 로그에 없는지 본다, ASVS v5.0.0-16.2.5)
// - 가격·스태프는 모듈 공개 함수(createBookingAdmin·createTicketAdmin)로 넣는다. 표 상태는 시험 전용 연결로 직접 읽는다
import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createDatabase, createService, fakeClock, type Database, type FakeClock, type PlatformService, type RedisCommander } from '@peaket/platform';
import { buildSimulatorApp, type SimulatorApp } from '@peaket/pg-simulator';
import pg from 'pg';
import { createClient } from 'redis';
import { expect } from 'vitest';
import { WebSocket } from 'ws';
import { migrateV0 } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { createBookingAdmin, type BookingAdmin } from '../src/modules/booking/index.js';
import {
  createPgDeltaFeed,
  createSeatAdmin,
  createSeatSales,
  type PgDeltaFeed,
  type SeatAdmin,
  type SeatDefinition,
  type SeatEventConfig,
  type SeatSales,
} from '../src/modules/inventory/index.js';
import { createV0PaymentGateway } from '../src/modules/payment/index.js';
import { createAdmissionReader, createQueueAdmin, type QueueAdmin } from '../src/modules/queue/index.js';
import { createTicketAdmin, type TicketAdmin } from '../src/modules/ticket/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { PROBLEM_CONTENT_TYPE, fanHeaders, type Headers } from './queue-harness.js';
import { ALLOWED_ORIGIN, DELTA_CHANNEL_NAME, DELTA_WAIT_MS, Inbox, type SeatReply, type WsOutcome } from './seat-harness.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

/** 기본 좌석 등급 가격(원). 시험이 정한 값이다 */
export const PRICES: Readonly<Record<string, number>> = { R: 50_000, S: 30_000 };
/** 홀드 TTL 기본값(POL-012, 7분). 모듈 상수를 믿지 않고 정책 값을 그대로 쓴다 */
export const TTL_MS = 7 * 60 * 1000;
/** 1회 연장 기본값(POL-012, 3분) */
export const EXTEND_MS = 3 * 60 * 1000;
/** 결제 참조 상한(출력 가능한 ASCII 1~200자, payment §13 동작 2) */
export const PAYMENT_KEY_MAX = 200;
/** 티켓 코드 모양: CSPRNG 16바이트를 base64url로 쓴 22자(offline-gate §13 동작 1) */
export const TICKET_CODE_SHAPE = /^[A-Za-z0-9_-]{22}$/;
/** 서비스 DB 풀 크기(동시 시험이 풀 대기로 429를 받지 않게 넉넉히) */
const POOL_MAX = 40;
/** 입장 루프 한 칸에 부를 수(시험 인원보다 크게) */
const ADMIT_PER_SECOND = 1_000;
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

/** 글자 순서 비교(DB 정렬 규칙에 기대지 않는다) */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 조건이 참이 될 때까지 기다린다 */
export async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`${what}: ${timeoutMs}ms 안에 되지 않았다`);
    await sleep(20);
  }
}

/** 등급 → 좌석 ID 목록으로 좌석 정의를 만든다(좌석 칸은 시험이 정한 단순한 값) */
export function gradedSeats(groups: Record<string, string[]>): SeatDefinition[] {
  const out: SeatDefinition[] = [];
  let n = 0;
  for (const [grade, list] of Object.entries(groups)) {
    for (const id of list) {
      n += 1;
      out.push({ id, section: 'A', row: '1', number: n, x: n * 10, y: 0, grade });
    }
  }
  return out;
}

/** 주문 응답의 모양(§13 동작 1·3) */
export interface OrderBody {
  orderId: string;
  eventId: string;
  holdId: string;
  status: string;
  amount: number;
  orderName: string;
  seatIds: string[];
  createdAt: string;
  tickets: { ticketId: string; seatId: string; code: string }[];
}

export const ORDER_KEYS = ['amount', 'createdAt', 'eventId', 'holdId', 'orderId', 'orderName', 'seatIds', 'status', 'tickets'];

/**
 * 같은 Problem 모양인지 견줄 것: 상태 코드·Content-Type과 본문 전체(detail과 확장 칸까지). 요청마다 다른 instance·traceId만 뺀다.
 * '남의 것과 없는 것은 똑같이 404'(§13 동작 1~3)라 어느 칸도 달라서는 안 된다
 */
export const problemShape = (r: SeatReply) => ({
  status: r.status,
  contentType: r.contentType,
  body: Object.fromEntries(Object.entries((r.body ?? {}) as Record<string, unknown>).filter(([k]) => k !== 'instance' && k !== 'traceId')),
});

/** 거절이 Problem 본문인지(이름 없는 400·401·403) */
export const expectStatus = (r: SeatReply, status: number, label: string) =>
  expect({ label, status: r.status, contentType: r.contentType }, r.raw).toEqual({ label, status, contentType: PROBLEM_CONTENT_TYPE });

/**
 * 검표 요청의 신원 머리(현장 스태프 계정). v0 검표는 팬 대상 신원으로 받는다(offline-gate §13 동작 2): 스캐너 대상 역할은 기기 증명(GAT-170)
 * 전에는 플랫폼이 막기 때문이다. 스코프·pid는 보지 않으므로 기본은 계정·세션·대상(fan)뿐이고, scope·pid는 시험이 따로 싣는다.
 * aud를 바꾸면(scanner·partner·ops) 그 대상의 신원 머리다
 */
export function staffHeaders(account: string, o: { session?: string; aud?: string; scope?: string; pid?: string } = {}): Headers {
  return {
    'x-user-id': account,
    'x-session-id': o.session ?? `ses-${account}`,
    'x-user-aud': o.aud ?? 'fan',
    ...(o.scope === undefined ? {} : { 'x-user-scope': o.scope }),
    ...(o.pid === undefined ? {} : { 'x-user-pid': o.pid }),
  };
}

/** 문자열을 PostgreSQL md5(값)::uuid와 같은 UUID로 바꾼다(불변식 뷰의 회차·좌석·계정 ID, payment §13 '불변식 검사') */
export function md5Uuid(value: string): string {
  const hex = createHash('md5').update(value, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 결제사 응답 바꾸기(시험 대역). 시뮬레이터는 요청한 금액만 승인하고 입금 대기를 내지 않으므로, '승인 금액이 주문 금액과 다름'·'입금 대기'
 * (payment §13 동작 2 ③)를 보려면 서비스가 받는 응답을 바꾼다. 시뮬레이터 안의 상태(원장)는 실제로 처리한 그대로다
 */
export interface PgTamper {
  /** 결제사 경로(예 /v1/payments/confirm) */
  path: string;
  /** 요청 본문의 orderId가 이것일 때만 바꾼다(다른 시험과 섞이지 않게) */
  orderId: string;
  rewrite(r: { status: number; json: Record<string, unknown> | undefined }): { status: number; json: unknown };
}

// ───────────── 표 행 ─────────────

export interface OrderRow {
  orderId: string;
  eventId: string;
  accountId: string;
  holdId: string;
  seatIds: string[];
  amount: number;
  orderName: string;
  status: string;
  createdAtMs: number;
}
export interface OrderItemRow {
  lineNo: number;
  seatId: string;
  grade: string;
  price: number;
  ticketId: string | null;
}
export interface OrderEventRow {
  seq: number;
  toStatus: string;
  reason: string;
  occurredAtMs: number;
}
export interface PaymentRow {
  paymentId: string;
  orderId: string;
  eventId: string;
  pg: string;
  paymentKey: string;
  amount: number;
  status: string;
  failure: string | null;
  approvedAtMs: number | null;
  createdAtMs: number;
}
export interface TicketRow {
  ticketId: string;
  orderId: string;
  eventId: string;
  seatId: string;
  accountId: string;
  code: string;
  status: string;
  issuedAtMs: number;
  enteredAtMs: number | null;
  enteredBy: string | null;
}
export interface SaleSeatRow {
  seatId: string;
  status: string;
  holdId: string | null;
  orderId: string | null;
}
export interface SaleHoldRow {
  holdId: string;
  eventId: string;
  accountId: string;
  /** 홀드에 적힌 순서 그대로 */
  seatIds: string[];
  status: string;
  extended: boolean;
  expiresAtMs: number;
}
export interface QuotaCounts {
  held: number;
  sold: number;
}
export interface SaleSnapshot {
  seats: SaleSeatRow[];
  holds: SaleHoldRow[];
  quotas: { accountId: string; held: number; sold: number }[];
  orders: OrderRow[];
  items: (OrderItemRow & { orderId: string })[];
  events: (OrderEventRow & { orderId: string })[];
  payments: PaymentRow[];
  tickets: TicketRow[];
}

/** 시뮬레이터 원장 한 건(GET /sim/ledger, 불변식 검사기 pg_charge 형식) */
export interface LedgerRecord {
  kind: string;
  pg: string;
  payment_ref: string;
  order_ref: string;
  amount: number;
  status: string;
  approved_at: string | null;
  canceled_amount: number;
}

/** 시뮬레이터가 받은 결제사 모양 호출 하나 */
export interface PgCall {
  method: string;
  path: string;
  idempotencyKey: string | undefined;
}

/** 변경분 한 칸(받은 순서대로 펼친 것) */
export interface Change {
  seatId: string;
  status: string;
  atMs: number;
}

export interface NotifyListener {
  inbox: Inbox;
  close(): Promise<void>;
}

/** 그 회차 변경분을 받은 순서대로 칸 하나씩 편다(from: 받은 알림의 몇 번째부터 볼지) */
export function changesFor(inbox: Inbox, eventId: string, from = 0): Change[] {
  return inbox.messages
    .slice(from)
    .filter((m) => m.eventId === eventId)
    .flatMap((m) => m.changes.map((c) => ({ seatId: c.seatId, status: c.status, atMs: m.atMs })));
}

/** 그 회차 변경분이 조건을 채울 때까지 기다린다 */
export async function waitChanges(inbox: Inbox, eventId: string, from: number, pred: (cs: Change[]) => boolean, what: string): Promise<Change[]> {
  const end = Date.now() + DELTA_WAIT_MS;
  for (;;) {
    const cs = changesFor(inbox, eventId, from);
    if (pred(cs)) return cs;
    if (Date.now() > end) throw new Error(`${what}: ${DELTA_WAIT_MS}ms 안에 받지 못했다(받은 것: ${JSON.stringify(cs)})`);
    await sleep(20);
  }
}

/** 좌석들이 모두 그 상태로 바뀐 변경분이 있는지 */
export const hasAll = (cs: Change[], seatIds: string[], status: string) => seatIds.every((id) => cs.some((c) => c.seatId === id && c.status === status));

// ───────────── 불변식 검사기(peaket-invariants, docs/verification.md §2.5) ─────────────

/** 빌드된 검사기 명령(services/invariant-checker/dist/cli.js) */
export const INVARIANT_CLI = fileURLToPath(new URL('../../invariant-checker/dist/cli.js', import.meta.url));

/** 검사기가 v0 뷰 묶음(스키마 v0_check)을 읽도록 원본 주소에 붙이는 연결 설정(payment §13 '불변식 검사') */
export const V0_CHECK_OPTIONS = 'options=-c%20search_path%3Dv0_check';

export interface InvariantRow {
  id: string;
  name: string;
  sources: string;
  violations: string;
  unknown: string;
  result: string;
  as_of: string;
}

export interface InvariantRun {
  code: number | null;
  stdout: string;
  stderr: string;
  rows: InvariantRow[];
  /** 불변식 ID → 행 */
  byId: Record<string, InvariantRow>;
}

/** CSV 한 줄을 칸으로 나눈다(큰따옴표로 감싼 칸과 ""를 푼다, services/invariant-checker/src/report.ts의 cell과 짝) */
export function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** invariants.csv를 읽는다(머리 줄: id,name,sources,violations,unknown,result,as_of) */
export function parseInvariantsCsv(text: string): InvariantRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const head = csvCells(lines[0] ?? '');
  expect(head, 'invariants.csv 머리 줄').toEqual(['id', 'name', 'sources', 'violations', 'unknown', 'result', 'as_of']);
  return lines.slice(1).map((l) => {
    const c = csvCells(l);
    return { id: c[0]!, name: c[1]!, sources: c[2]!, violations: c[3]!, unknown: c[4]!, result: c[5]!, as_of: c[6]! };
  });
}

/**
 * peaket-invariants를 자식 프로세스로 돌린다. 검사 연결은 v0 DB 그대로, 원본 셋(purchase·payment·ticket)은 v0 DB 주소에
 * search_path=v0_check를 붙인 주소다. 결제사 원장은 시뮬레이터 GET /sim/ledger 본문을 파일로 넘긴다
 */
export async function runInvariantChecker(o: { databaseUrl: string; ledgerNdjson: string; enqueueWithinSec?: number }): Promise<InvariantRun> {
  if (!existsSync(INVARIANT_CLI)) {
    throw new Error(`불변식 검사기 명령이 없다: ${INVARIANT_CLI}. 먼저 'pnpm --filter @peaket/invariant-checker build'로 빌드한다`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'peaket-v0-inv-'));
  try {
    const records = join(dir, 'pg-ledger.ndjson');
    writeFileSync(records, o.ledgerNdjson);
    const out = join(dir, 'run');
    const source = `${o.databaseUrl}${o.databaseUrl.includes('?') ? '&' : '?'}${V0_CHECK_OPTIONS}`;
    const args = [INVARIANT_CLI, '--out', out, '--records', records, ...(o.enqueueWithinSec === undefined ? [] : ['--enqueue-within-sec', String(o.enqueueWithinSec)])];
    const env = {
      ...process.env,
      INVARIANT_CHECK_DB_URL: o.databaseUrl,
      INVARIANT_PURCHASE_DB_URL: source,
      INVARIANT_PAYMENT_DB_URL: source,
      INVARIANT_TICKET_DB_URL: source,
    };
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '';
      let se = '';
      child.stdout.on('data', (d) => (so += String(d)));
      child.stderr.on('data', (d) => (se += String(d)));
      child.on('error', reject);
      child.on('close', (c) => resolve({ code: c, stdout: so, stderr: se }));
    });
    const csvPath = join(out, 'invariants.csv');
    if (!existsSync(csvPath)) throw new Error(`검사기가 invariants.csv를 쓰지 않았다(종료 코드 ${code}): ${stderr}${stdout}`);
    const rows = parseInvariantsCsv(readFileSync(csvPath, 'utf8'));
    return { code, stdout, stderr, rows, byId: Object.fromEntries(rows.map((r) => [r.id, r])) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let eventCounter = 0;

export class SaleHarness {
  private admin_: SeatAdmin | undefined;
  private booking_: BookingAdmin | undefined;
  private ticket_: TicketAdmin | undefined;
  private sales_: SeatSales | undefined;
  private readonly sockets = new Set<WebSocket>();
  private readonly closers: (() => Promise<unknown>)[] = [];
  /** 회차마다 좌석 → 등급, 등급 → 가격(시험이 기대 금액을 셀 때 쓴다) */
  private readonly grades = new Map<string, Map<string, string>>();
  private readonly prices = new Map<string, Record<string, number>>();

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
    readonly sim: SimulatorApp,
    readonly simUrl: string,
    /** 이 실행의 시뮬레이터 시험 키(응답·로그에 실리지 않는지 본다) */
    readonly simKey: string,
    /** 시뮬레이터가 받은 결제사 모양 호출(받은 순서) */
    readonly pgCalls: PgCall[],
    /** 서비스 로그 줄(받은 순서) */
    readonly logLines: string[],
    /** 지금 걸어 둔 결제사 응답 바꾸기(clearFaults가 함께 지운다) */
    private readonly tampers: PgTamper[],
    closers: (() => Promise<unknown>)[],
  ) {
    this.closers.push(...closers);
  }

  /** 컨테이너 둘·마이그레이션·PG 시뮬레이터·모놀리스(입장 루프·만료 루프 끔, 주문·결제·발권 켬)를 띄우고 실제 포트를 연다 */
  static async start(): Promise<SaleHarness> {
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
      // 실행마다 새 시험 키(ASVS v5.0.0-13.3.1). 코드에 고정 비밀을 두지 않는다
      const simKey = `sim_sk_${randomBytes(18).toString('hex')}`;
      const sim = buildSimulatorApp({ secretKey: simKey, clock, confirmLatency: { kind: 'none' } });
      const pgCalls: PgCall[] = [];
      // 시뮬레이터 인증 훅보다 앞, HTTP 서버에서 받은 요청을 그대로 적는다(시험 제어 API /sim/*는 빼고)
      sim.server.on('request', (req: IncomingMessage) => {
        const path = (req.url ?? '').split('?')[0]!;
        if (!path.startsWith('/v1/payments')) return;
        const idem = req.headers['idempotency-key'];
        pgCalls.push({ method: req.method ?? '', path, idempotencyKey: typeof idem === 'string' ? idem : undefined });
      });
      const simUrl = await sim.listen({ host: '127.0.0.1', port: 0 });
      closers.push(() => sim.close());
      await deltaFeed.ready();

      // 서비스의 결제사 어댑터가 쓰는 fetch. 바꾸기가 걸린 주문의 응답만 바꾸고, 나머지는 실제 HTTP 응답 그대로다
      const tampers: PgTamper[] = [];
      const pgFetch: typeof fetch = async (input, init) => {
        const res = await fetch(input, init);
        if (tampers.length === 0) return res;
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        let orderId: unknown;
        try {
          orderId = typeof init?.body === 'string' ? (JSON.parse(init.body) as { orderId?: unknown }).orderId : undefined;
        } catch {
          orderId = undefined;
        }
        const t = tampers.find((x) => x.path === url.pathname && x.orderId === orderId);
        if (!t) return res;
        const text = await res.text();
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          json = undefined;
        }
        const out = t.rewrite({ status: res.status, json });
        return new Response(JSON.stringify(out.json), { status: out.status, headers: { 'content-type': 'application/json' } });
      };

      const logLines: string[] = [];
      const logs = new Writable({
        write: (chunk, _enc, cb) => {
          logLines.push(String(chunk));
          cb();
        },
      });
      const svc = await createService({
        name: 'v0-monolith',
        module: AppModule.register({
          queue: { redis, tickIntervalMs: false },
          inventory: { database, admission: createAdmissionReader(redis), deltaFeed, allowedOrigins: [ALLOWED_ORIGIN], expiryIntervalMs: false },
          sale: { gateway: createV0PaymentGateway({ baseUrl: simUrl, secretKey: simKey, fetch: pgFetch }) },
        }),
        env: { PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' },
        clock,
        logDestination: logs,
      });
      // 서비스는 다른 연결보다 먼저 닫는다
      closers.unshift(() => svc.close());
      const { port } = await svc.listen('127.0.0.1');
      return new SaleHarness(postgres, valkey, database, deltaFeed, inspect, svc, clock, createQueueAdmin(redis), port, sim, simUrl, simKey, pgCalls, logLines, tampers, closers);
    } catch (err) {
      // 띄우다 실패하면 afterAll이 닫을 것이 없다. 연결과 컨테이너가 남지 않게 여기서 지운다
      for (const close of closers) await bounded((async () => close())(), CLOSE_STEP_MS);
      for (const stop of stops) stop();
      throw err;
    }
  }

  /** DB 접속 주소(불변식 검사기에 넘긴다. 응답·로그에 실리지 않는지도 본다) */
  get databaseUrl(): string {
    return this.postgres.url;
  }

  get seatAdmin(): SeatAdmin {
    return (this.admin_ ??= createSeatAdmin(this.database));
  }

  get bookingAdmin(): BookingAdmin {
    return (this.booking_ ??= createBookingAdmin(this.database));
  }

  get ticketAdmin(): TicketAdmin {
    return (this.ticket_ ??= createTicketAdmin(this.database));
  }

  /** 좌석 판매 공개 함수(seat-hold §14 동작 9, 서비스와 같은 DB 풀) */
  get seatSales(): SeatSales {
    return (this.sales_ ??= createSeatSales(this.database));
  }

  /** 시험마다 새 회차 ID(영숫자·-·_ 1~64자) */
  newEventId(): string {
    eventCounter += 1;
    return `so${eventCounter}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * 판매할 회차를 연다: 좌석(기본 R-1~R-4는 R석, S-1~S-4는 S석), 1인 한도(기본 4), 등급 가격(기본 PRICES, null이면 넣지 않는다)
   */
  async openSaleEvent(
    o: { seats?: Record<string, string[]>; limit?: number; prices?: Record<string, number> | null; config?: Partial<SeatEventConfig>; eventId?: string } = {},
  ): Promise<string> {
    const eventId = o.eventId ?? this.newEventId();
    const groups = o.seats ?? { R: ['R-1', 'R-2', 'R-3', 'R-4'], S: ['S-1', 'S-2', 'S-3', 'S-4'] };
    await this.seatAdmin.open(eventId, { perPersonLimit: o.limit ?? 4, ...o.config }, gradedSeats(groups));
    const byId = new Map<string, string>();
    for (const [grade, list] of Object.entries(groups)) for (const id of list) byId.set(id, grade);
    this.grades.set(eventId, byId);
    const prices = o.prices === undefined ? PRICES : o.prices;
    if (prices !== null) {
      await this.bookingAdmin.setPrices(eventId, { ...prices });
      this.prices.set(eventId, { ...prices });
    }
    return eventId;
  }

  /** 그 좌석들의 기대 금액(시험이 넣은 등급 가격의 합) */
  amountOf(eventId: string, seatIds: string[]): number {
    const grades = this.grades.get(eventId);
    const prices = this.prices.get(eventId);
    if (!grades || !prices) throw new Error(`시험이 연 회차가 아니다: ${eventId}`);
    return seatIds.reduce((sum, id) => {
      const price = prices[grades.get(id) ?? ''];
      if (price === undefined) throw new Error(`좌석 ${id}의 가격을 넣지 않았다`);
      return sum + price;
    }, 0);
  }

  gradeOf(eventId: string, seatId: string): string {
    const g = this.grades.get(eventId)?.get(seatId);
    if (!g) throw new Error(`좌석 ${seatId}을 이 회차에 열지 않았다`);
    return g;
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

  // ───────────── HTTP(inject) ─────────────

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

  hold(eventId: string, seatIds: string[], headers: Headers): Promise<SeatReply> {
    return this.http('POST', `/v1/events/${eventId}/holds`, headers, { seatIds });
  }

  /** 홀드가 201이어야 하는 준비 단계. holdId를 돌려준다 */
  async holdOk(eventId: string, seatIds: string[], headers: Headers): Promise<string> {
    const r = await this.hold(eventId, seatIds, headers);
    expect(r.status, `홀드 준비 ${seatIds.join(',')}: ${r.raw}`).toBe(201);
    return r.body.holdId as string;
  }

  release(holdId: string, headers: Headers): Promise<SeatReply> {
    return this.http('DELETE', `/v1/holds/${holdId}`, headers);
  }

  extend(holdId: string, headers: Headers): Promise<SeatReply> {
    return this.http('POST', `/v1/holds/${holdId}/extension`, headers);
  }

  /** 주문 만들기(§13 동작 1) */
  createOrder(holdId: string, headers: Headers): Promise<SeatReply> {
    return this.http('POST', '/v0/orders', headers, { holdId });
  }

  /** 주문이 201이어야 하는 준비 단계 */
  async createOrderOk(holdId: string, headers: Headers): Promise<OrderBody> {
    const r = await this.createOrder(holdId, headers);
    expect(r.status, `주문 준비 ${holdId}: ${r.raw}`).toBe(201);
    return r.body as OrderBody;
  }

  /** 결제 확정(§13 동작 2) */
  pay(orderId: string, body: unknown, headers: Headers): Promise<SeatReply> {
    return this.http('POST', `/v0/orders/${orderId}/payment`, headers, body);
  }

  /** 주문 보기(§13 동작 3) */
  viewOrder(orderId: string, headers: Headers): Promise<SeatReply> {
    return this.http('GET', `/v0/orders/${orderId}`, headers);
  }

  /** 검표(offline-gate §13 동작 2) */
  scan(eventId: string, body: unknown, headers: Headers): Promise<SeatReply> {
    return this.http('POST', `/v0/events/${eventId}/scans`, headers, body);
  }

  /** 홀드 → 주문 → 결제창 인증(시뮬레이터)까지 한다. 결제 확정은 하지 않는다 */
  async prepareOrder(
    eventId: string,
    pid: string,
    seatIds: string[],
    o: { account?: string; session?: string } = {},
  ): Promise<{ headers: Headers; holdId: string; order: OrderBody; paymentKey: string }> {
    const headers = fanHeaders(pid, o);
    const holdId = await this.holdOk(eventId, seatIds, headers);
    const order = await this.createOrderOk(holdId, headers);
    const paymentKey = await this.authenticate(order.orderId, order.amount, order.orderName);
    return { headers, holdId, order, paymentKey };
  }

  /** 홀드부터 결제 확정(200)까지 한다. 확정 응답 본문을 함께 돌려준다 */
  async buy(
    eventId: string,
    pid: string,
    seatIds: string[],
    o: { account?: string; session?: string } = {},
  ): Promise<{ headers: Headers; holdId: string; order: OrderBody; paymentKey: string; paid: OrderBody }> {
    const prepared = await this.prepareOrder(eventId, pid, seatIds, o);
    const r = await this.pay(prepared.order.orderId, { paymentKey: prepared.paymentKey, amount: prepared.order.amount }, prepared.headers);
    expect(r.status, `결제 확정 준비 ${prepared.order.orderId}: ${r.raw}`).toBe(200);
    return { ...prepared, paid: r.body as OrderBody };
  }

  // ───────────── PG 시뮬레이터 ─────────────

  /** 시험 키 기본 인증으로 시뮬레이터 제어 API를 부른다 */
  simControl(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
    const authorization = `Basic ${Buffer.from(`${this.simKey}:`).toString('base64')}`;
    return fetch(`${this.simUrl}${path}`, {
      method,
      headers: { authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** 결제창 인증을 마친 것으로 하고 paymentKey를 받는다(POST /sim/authenticate) */
  async authenticate(orderId: string, amount: number, orderName?: string): Promise<string> {
    const r = await this.simControl('POST', '/sim/authenticate', { orderId, amount, ...(orderName === undefined ? {} : { orderName }) });
    const text = await r.text();
    expect(r.status, `시뮬레이터 결제창 인증 ${orderId}: ${text}`).toBe(200);
    return (JSON.parse(text) as { paymentKey: string }).paymentKey;
  }

  /** 장애를 넣는다(POST /sim/faults). 다른 시험과 섞이지 않게 주문 ID로 좁힌다 */
  async addFault(f: Record<string, unknown>): Promise<void> {
    const r = await this.simControl('POST', '/sim/faults', f);
    expect(r.status, `장애 넣기 ${JSON.stringify(f)}: ${await r.text()}`).toBe(204);
  }

  /** 시뮬레이터 장애와 결제사 응답 바꾸기를 함께 지운다 */
  async clearFaults(): Promise<void> {
    this.tampers.length = 0;
    const r = await this.simControl('DELETE', '/sim/faults');
    expect(r.status).toBe(204);
  }

  /** 그 주문의 승인 응답을 바꾼다(서비스가 받는 응답만. 시뮬레이터는 실제로 처리한다) */
  tamperConfirm(orderId: string, rewrite: PgTamper['rewrite']): void {
    this.tampers.push({ path: '/v1/payments/confirm', orderId, rewrite });
  }

  /**
   * 서비스를 거치지 않고 시뮬레이터에 직접 승인을 보낸다(다른 멱등키). 서비스가 나중에 같은 결제를 승인하면 결제사는
   * ALREADY_PROCESSED_PAYMENT로 답하고, 어댑터가 조회로 금액을 확인해 ALREADY_APPROVED로 돌려준다(payment §13 동작 2 ③)
   */
  async approveDirectly(o: { paymentKey: string; orderId: string; amount: number }): Promise<Record<string, unknown>> {
    const authorization = `Basic ${Buffer.from(`${this.simKey}:`).toString('base64')}`;
    const r = await fetch(`${this.simUrl}/v1/payments/confirm`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `direct-${o.orderId}` },
      body: JSON.stringify(o),
    });
    const text = await r.text();
    expect(r.status, `시뮬레이터 직접 승인: ${text}`).toBe(200);
    return JSON.parse(text) as Record<string, unknown>;
  }

  /**
   * 시험 전용 연결의 트랜잭션에서 행을 잠근다(SELECT … FOR UPDATE). 돌려준 함수를 부르면 되돌리고 연결을 돌려준다.
   * 서비스의 판정이 잠금 경합(문장 시간 상한 1초)으로 끊기는 경우를 만든다(payment §13 '동작')
   */
  async lockRows(sqlText: string, args: unknown[]): Promise<() => Promise<void>> {
    const c = await this.inspect.connect();
    let done = false;
    const release = async () => {
      if (done) return;
      done = true;
      await c.query('rollback').catch(() => {});
      c.release();
    };
    try {
      await c.query('begin');
      const r = await c.query(sqlText, args);
      if ((r.rowCount ?? 0) === 0) throw new Error(`시험: 잠글 행이 없다(${sqlText})`);
    } catch (err) {
      await release();
      throw err;
    }
    this.closers.unshift(release);
    return release;
  }

  /**
   * 그 회차의 발권을 실패하게 한다(시험 DB에 그 회차 티켓만 막는 검사 조건을 잠깐 건다). 돌려준 함수를 부르면 지운다.
   * 발권이 실패한 결제 확정(payment §13 동작 2 ⑤)을 만든다
   */
  async blockTicketsFor(eventId: string): Promise<() => Promise<void>> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(eventId)) throw new Error('시험: 회차 ID 형식');
    const name = `test_block_${createHash('md5').update(eventId).digest('hex').slice(0, 12)}`;
    await this.inspect.query(`alter table v0_ticket add constraint ${name} check (event_id <> '${eventId}') not valid`);
    let done = false;
    const unblock = async () => {
      if (done) return;
      done = true;
      await this.inspect.query(`alter table v0_ticket drop constraint if exists ${name}`);
    };
    this.closers.unshift(unblock);
    return unblock;
  }

  /** 시뮬레이터 원장 본문(NDJSON 그대로) */
  async ledgerText(): Promise<string> {
    const r = await this.simControl('GET', '/sim/ledger');
    expect(r.status).toBe(200);
    return r.text();
  }

  /** 시뮬레이터 원장(승인된 적 있는 결제만) */
  async ledger(): Promise<LedgerRecord[]> {
    return (await this.ledgerText())
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LedgerRecord);
  }

  /** 그 주문의 결제사 승인(원장) */
  async approvalsOf(orderId: string): Promise<LedgerRecord[]> {
    return (await this.ledger()).filter((r) => r.order_ref === orderId);
  }

  /** 그 주문의 승인 호출(승인 멱등키 confirm-{orderId}) */
  confirmCallsOf(orderId: string): PgCall[] {
    return this.pgCalls.filter((c) => c.method === 'POST' && c.path === '/v1/payments/confirm' && c.idempotencyKey === `confirm-${orderId}`);
  }

  /** 그 주문·결제 참조로 간 결제사 호출 전부(승인·조회·취소) */
  pgCallsOf(orderId: string, paymentKey?: string): PgCall[] {
    return this.pgCalls.filter(
      (c) => c.idempotencyKey === `confirm-${orderId}` || c.path.includes(orderId) || (paymentKey !== undefined && c.path.includes(encodeURIComponent(paymentKey))),
    );
  }

  /** 결제사에 결과를 묻는 호출(조회 두 경로) */
  queryCalls(): PgCall[] {
    return this.pgCalls.filter((c) => c.method === 'GET');
  }

  // ───────────── 표 읽기 ─────────────

  async orderRow(orderId: string): Promise<OrderRow | undefined> {
    return (await this.orderRowsWhere('order_id = $1', [orderId]))[0];
  }

  async ordersOf(eventId: string): Promise<OrderRow[]> {
    return this.orderRowsWhere('event_id = $1', [eventId]);
  }

  private async orderRowsWhere(where: string, args: unknown[]): Promise<OrderRow[]> {
    const r = await this.inspect.query<{
      order_id: string;
      event_id: string;
      account_id: string;
      hold_id: string;
      seat_ids: string[];
      amount: number;
      order_name: string;
      status: string;
      created_at: Date;
    }>(`select order_id, event_id, account_id, hold_id, seat_ids, amount, order_name, status, created_at from v0_order where ${where} order by created_at, order_id`, args);
    return r.rows.map((x) => ({
      orderId: x.order_id,
      eventId: x.event_id,
      accountId: x.account_id,
      holdId: x.hold_id,
      seatIds: x.seat_ids,
      amount: x.amount,
      orderName: x.order_name,
      status: x.status,
      createdAtMs: x.created_at.getTime(),
    }));
  }

  async orderItems(orderId: string): Promise<OrderItemRow[]> {
    const r = await this.inspect.query<{ line_no: number; seat_id: string; grade: string; price: number; ticket_id: string | null }>(
      'select line_no, seat_id, grade, price, ticket_id from v0_order_item where order_id = $1 order by line_no',
      [orderId],
    );
    return r.rows.map((x) => ({ lineNo: x.line_no, seatId: x.seat_id, grade: x.grade, price: x.price, ticketId: x.ticket_id }));
  }

  async orderEvents(orderId: string): Promise<OrderEventRow[]> {
    const r = await this.inspect.query<{ seq: number; to_status: string; reason: string; occurred_at: Date }>(
      'select seq, to_status, reason, occurred_at from v0_order_event where order_id = $1 order by seq',
      [orderId],
    );
    return r.rows.map((x) => ({ seq: x.seq, toStatus: x.to_status, reason: x.reason, occurredAtMs: x.occurred_at.getTime() }));
  }

  /** 이력의 (번호, 새 상태)만 */
  async orderTrail(orderId: string): Promise<[number, string][]> {
    return (await this.orderEvents(orderId)).map((e) => [e.seq, e.toStatus]);
  }

  async paymentRows(orderId: string): Promise<PaymentRow[]> {
    return this.paymentRowsWhere('order_id = $1', [orderId]);
  }

  private async paymentRowsWhere(where: string, args: unknown[]): Promise<PaymentRow[]> {
    const r = await this.inspect.query<{
      payment_id: string;
      order_id: string;
      event_id: string;
      pg: string;
      payment_key: string;
      amount: number;
      status: string;
      failure: string | null;
      approved_at: Date | null;
      created_at: Date;
    }>(`select payment_id, order_id, event_id, pg, payment_key, amount, status, failure, approved_at, created_at from v0_payment where ${where} order by created_at, payment_id`, args);
    return r.rows.map((x) => ({
      paymentId: x.payment_id,
      orderId: x.order_id,
      eventId: x.event_id,
      pg: x.pg,
      paymentKey: x.payment_key,
      amount: x.amount,
      status: x.status,
      failure: x.failure,
      approvedAtMs: x.approved_at === null ? null : x.approved_at.getTime(),
      createdAtMs: x.created_at.getTime(),
    }));
  }

  async ticketRows(where: { orderId: string } | { eventId: string }): Promise<TicketRow[]> {
    const [col, val] = 'orderId' in where ? ['order_id', where.orderId] : ['event_id', where.eventId];
    const r = await this.inspect.query<{
      ticket_id: string;
      order_id: string;
      event_id: string;
      seat_id: string;
      account_id: string;
      code: string;
      status: string;
      issued_at: Date;
      entered_at: Date | null;
      entered_by: string | null;
    }>(
      `select ticket_id, order_id, event_id, seat_id, account_id, code, status, issued_at, entered_at, entered_by from v0_ticket where ${col} = $1`,
      [val],
    );
    const rows = r.rows.map((x) => ({
      ticketId: x.ticket_id,
      orderId: x.order_id,
      eventId: x.event_id,
      seatId: x.seat_id,
      accountId: x.account_id,
      code: x.code,
      status: x.status,
      issuedAtMs: x.issued_at.getTime(),
      enteredAtMs: x.entered_at === null ? null : x.entered_at.getTime(),
      enteredBy: x.entered_by,
    }));
    return rows.sort((a, b) => cmp(a.seatId, b.seatId) || cmp(a.orderId, b.orderId));
  }

  async ticketByCode(code: string): Promise<TicketRow | undefined> {
    const r = await this.inspect.query<{ order_id: string }>('select order_id from v0_ticket where code = $1', [code]);
    if (r.rows.length === 0) return undefined;
    return (await this.ticketRows({ orderId: r.rows[0]!.order_id })).find((t) => t.code === code);
  }

  async saleSeats(eventId: string): Promise<SaleSeatRow[]> {
    const r = await this.inspect.query<{ seat_id: string; status: string; hold_id: string | null; order_id: string | null }>(
      'select seat_id, status, hold_id, order_id from v0_seat where event_id = $1',
      [eventId],
    );
    return r.rows.map((x) => ({ seatId: x.seat_id, status: x.status, holdId: x.hold_id, orderId: x.order_id })).sort((a, b) => cmp(a.seatId, b.seatId));
  }

  /** 좌석 ID → 상태 */
  async seatStatus(eventId: string): Promise<Record<string, string>> {
    return Object.fromEntries((await this.saleSeats(eventId)).map((s) => [s.seatId, s.status]));
  }

  async holdRows(eventId: string): Promise<SaleHoldRow[]> {
    const r = await this.inspect.query<{
      hold_id: string;
      event_id: string;
      account_id: string;
      seat_ids: string[];
      status: string;
      extended: boolean;
      expires_at: Date;
    }>('select hold_id, event_id, account_id, seat_ids, status, extended, expires_at from v0_hold where event_id = $1 order by held_at, hold_id', [eventId]);
    return r.rows.map((x) => ({
      holdId: x.hold_id,
      eventId: x.event_id,
      accountId: x.account_id,
      seatIds: x.seat_ids,
      status: x.status,
      extended: x.extended,
      expiresAtMs: x.expires_at.getTime(),
    }));
  }

  async holdRow(holdId: string): Promise<SaleHoldRow | undefined> {
    const r = await this.inspect.query<{ event_id: string }>('select event_id from v0_hold where hold_id = $1', [holdId]);
    if (r.rows.length === 0) return undefined;
    return (await this.holdRows(r.rows[0]!.event_id)).find((x) => x.holdId === holdId);
  }

  /** 계정이 그 회차에서 잡고 있는 좌석 수와 판 좌석 수(행이 없으면 둘 다 0) */
  async quota(eventId: string, accountId: string): Promise<QuotaCounts> {
    const r = await this.inspect.query<{ held: number; sold: number }>('select held, sold from v0_quota where event_id = $1 and account_id = $2', [eventId, accountId]);
    return r.rows[0] ? { held: r.rows[0].held, sold: r.rows[0].sold } : { held: 0, sold: 0 };
  }

  async priceRows(eventId: string): Promise<{ grade: string; price: number }[]> {
    const r = await this.inspect.query<{ grade: string; price: number }>('select grade, price from v0_price where event_id = $1', [eventId]);
    return r.rows.map((x) => ({ grade: x.grade, price: x.price })).sort((a, b) => cmp(a.grade, b.grade));
  }

  /** 그 회차의 좌석·홀드·보유 수·주문·주문 좌석·이력·결제·티켓 전부(아무것도 바뀌지 않았는지 견줄 때) */
  async snapshot(eventId: string): Promise<SaleSnapshot> {
    const orders = await this.ordersOf(eventId);
    const items: SaleSnapshot['items'] = [];
    const events: SaleSnapshot['events'] = [];
    for (const o of orders) {
      for (const i of await this.orderItems(o.orderId)) items.push({ orderId: o.orderId, ...i });
      for (const e of await this.orderEvents(o.orderId)) events.push({ orderId: o.orderId, ...e });
    }
    const q = await this.inspect.query<{ account_id: string; held: number; sold: number }>(
      'select account_id, held, sold from v0_quota where event_id = $1',
      [eventId],
    );
    q.rows.sort((a, b) => cmp(a.account_id, b.account_id));
    return {
      seats: await this.saleSeats(eventId),
      holds: await this.holdRows(eventId),
      // 0인 보유 수 행은 없는 것과 같게 본다(행을 남길지 지울지는 정본이 정하지 않는다)
      quotas: q.rows.filter((x) => x.held !== 0 || x.sold !== 0).map((x) => ({ accountId: x.account_id, held: x.held, sold: x.sold })),
      orders,
      items,
      events,
      payments: await this.paymentRowsWhere('event_id = $1', [eventId]),
      tickets: await this.ticketRows({ eventId }),
    };
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

  /** 실제 포트로 변경분 WebSocket을 연다(열려야 하는 준비 단계) */
  async openDeltas(eventId: string, headers: Headers, origin = ALLOWED_ORIGIN): Promise<{ ws: WebSocket; inbox: Inbox }> {
    const o = await new Promise<WsOutcome>((resolve) => {
      let settled = false;
      const done = (x: WsOutcome) => {
        if (settled) return;
        settled = true;
        resolve(x);
      };
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/v0/events/${eventId}/seat-deltas`, { headers, origin, handshakeTimeout: DELTA_WAIT_MS });
      this.sockets.add(ws);
      const inbox = new Inbox();
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
    if (o.kind !== 'open') throw new Error(`변경분 연결 ${eventId}이 열리지 않았다: ${JSON.stringify(o)}`);
    return o;
  }

  closeSockets(): void {
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
  }

  /** 서비스 로그 전부(한 글로 이은 것) */
  logText(from = 0): string {
    return this.logLines.slice(from).join('');
  }

  async close(): Promise<void> {
    try {
      this.closeSockets();
      for (const close of this.closers) await bounded((async () => close())(), CLOSE_STEP_MS);
    } finally {
      this.postgres?.stop();
      this.valkey?.stop();
    }
  }
}
