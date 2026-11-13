// 발권 호출과 재시도 큐의 어댑터(BUILD_ORDER PRF-170, docs/features/payment.md §2 '발권 호출과 재시도 큐의 첫 구현', ADR-0106 결정 2).
// - ticketIssuerFromEnv: 주소가 없으면 local·ci만 '늘 발권' 대역(경고 한 줄), 그 밖(PEAKET_ENV가 없으면 prod)은 던진다. 주소 모양이 틀려도 던진다
// - issuingTicketIssuer: 좌석마다 주문·좌석에서 정해지는 티켓 ID(UUID 버전 8, SHA-256('Ticket:' + 주문 ID + ':' + 좌석 ID)의 앞 16바이트)
// - ticketIssueCodeOf(gRPC 상태 번호 → 이름, 0·모르는 번호는 UNKNOWN)·issuedTicketsOf(답 모양 검사, 틀리면 BAD_ANSWER)
// - GrpcTicketIssuer: 차단기 열림 CIRCUIT_OPEN(부르지 않음)·동시 상한 RESOURCE_EXHAUSTED·남은 시간 없음 DEADLINE_EXCEEDED·gRPC가 아닌 예외 UNKNOWN,
//   같은 프로세스의 가짜 ticket-svc로 요청 칸·답·gRPC 오류 코드
// - PromTicketIssueSignals: 지표 이름·이름표(설계 9), LoggerTicketIssueLog: 칸(주문 ID·코드·csCase만, 좌석·계정·티켓 ID 없음)
// 실제 ticket-svc 서버와 도는 시험은 서버가 생기는 단계(HOT-160)의 몫이다.
import { createHash } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { type CircuitBreaker, deadlineExceeded, dependencyUnavailable, PlatformMetrics, type Registry, serverBusy } from '@peaket/platform';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  GRPC_STATUS_NAMES,
  GrpcTicketIssuer,
  issuedTicketsMatch,
  issuedTicketsOf,
  issuingTicketIssuer,
  voidingTicketVoider,
  LoggerTicketIssueLog,
  PromTicketIssueSignals,
  TICKET_DEPENDENCY,
  TICKET_GRPC_ADDR_ENV,
  TICKET_ISSUE_CALL_DEADLINE_MS,
  TICKET_ISSUE_CAP_MS,
  TICKET_STUB_ENVS,
  TicketIssueCallError,
  type TicketIssueCommand,
  ticketIssueCodeOf,
  ticketIssueDatabaseOptions,
  ticketIssuerFromEnv,
} from '../src/modules/booking/index.js';
import { ACCOUNT, EVENT } from './order-cases.js';

const ORDER_ID = '0190f3a1-7c2e-7f00-8000-0000000000f1';
const OTHER_ORDER = '0190f3a1-7c2e-7f00-8000-0000000000f2';
const SEAT_1 = '0190f3a1-7c2e-7a00-8000-00000000a001';
const SEAT_2 = '0190f3a1-7c2e-7a00-8000-00000000a002';
const TICKET_1 = '0190f3a1-7c2e-7b00-8000-0000000c0001';
const TICKET_2 = '0190f3a1-7c2e-7b00-8000-0000000c0002';

/** 발권 호출 입력(좌석 차례는 줄 번호 차례) */
function command(over: Partial<TicketIssueCommand> = {}): TicketIssueCommand {
  return { orderId: ORDER_ID, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_2, SEAT_1], deadlineMs: 2000, ...over };
}

/** 뼈대의 '구현 전' 오류(던지기만 보는 시험이 뼈대에서 그냥 통과하지 않게, 던진 오류가 이것이 아님을 본다) */
const NOT_BUILT = /구현 전\(뼈대\)/;
/** fn이 던진 Error. 던지지 않으면 실패 */
function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error('던지지 않았다');
}
/** p가 TicketIssueCallError로 거절한 그 오류 */
async function callErrorOf(p: Promise<unknown>): Promise<TicketIssueCallError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TicketIssueCallError);
  return err as TicketIssueCallError;
}

/** SHA-256(입력)의 앞 16바이트에 UUID 버전 8·변형 비트를 맞춘 글(정본 식을 시험 안에서 직접 계산한다) */
function uuid8Of(input: string): string {
  const b = Buffer.from(createHash('sha256').update(input).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const UUID8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 아무도 부르지 않는 주소(가짜 차단기가 호출 전에 끊는다) */
const ADDR = '127.0.0.1:9';
/** run이 action을 부르지 않고 err를 던지는 가짜 차단기(열린 차단기·동시 상한·남은 시간 없음) */
const refusing = (err: unknown, runs: unknown[] = []) =>
  ({
    run: async (action: unknown) => {
      runs.push(action);
      throw err;
    },
  }) as unknown as CircuitBreaker;

describe("'늘 발권' 대역(issuingTicketIssuer)", () => {
  test('좌석마다 티켓 하나(상태 ISSUED, 리뷰 고침 L8)이고 티켓 ID는 SHA-256("Ticket:" + 주문 ID + ":" + 좌석 ID)의 UUID 버전 8이라, 답이 주문 좌석과 맞는다 (P-T15)', async () => {
    const tickets = await issuingTicketIssuer.issue(command());
    expect([...tickets].sort((a, b) => a.seatId.localeCompare(b.seatId))).toEqual([
      { seatId: SEAT_1, ticketId: uuid8Of(`Ticket:${ORDER_ID}:${SEAT_1}`), status: 'ISSUED' },
      { seatId: SEAT_2, ticketId: uuid8Of(`Ticket:${ORDER_ID}:${SEAT_2}`), status: 'ISSUED' },
    ]);
    for (const t of tickets) expect(t.ticketId).toMatch(UUID8);
    expect(issuedTicketsMatch([SEAT_2, SEAT_1], tickets)).toBe(true);
  });

  test('같은 주문을 다시 부르면 같은 티켓이고(ticket-svc의 주문 ID 멱등과 같은 모양), 다른 주문의 같은 좌석은 다른 티켓이다 (P-T15)', async () => {
    const a = await issuingTicketIssuer.issue(command());
    const b = await issuingTicketIssuer.issue(command());
    expect(b).toEqual(a);
    const other = await issuingTicketIssuer.issue(command({ orderId: OTHER_ORDER }));
    expect(other.map((t) => t.ticketId)).not.toContain(a[0]!.ticketId);
  });
});

describe('ticketIssuerFromEnv', () => {
  test.each(['local', 'ci'])('PEAKET_ENV=%s이고 주소가 없으면(빈 글 포함) 늘 발권 대역과 경고 한 줄이다(빠진 설정 이름을 담는다)', async (env) => {
    expect([...TICKET_STUB_ENVS].sort()).toEqual(['ci', 'local']);
    for (const addr of [undefined, '']) {
      const t = ticketIssuerFromEnv({ PEAKET_ENV: env, [TICKET_GRPC_ADDR_ENV]: addr });
      expect(t.issuer).toBe(issuingTicketIssuer);
      expect(t.warnings).toHaveLength(1);
      expect(t.warnings[0]).toContain(TICKET_GRPC_ADDR_ENV);
      expect(await t.issuer.issue(command())).toHaveLength(2);
      expect(() => t.close()).not.toThrow();
    }
  });

  test.each(['prod', 'demo', 'staging', undefined, ''])(
    'PEAKET_ENV=%j(값이 없으면 prod로 본다)면 주소 없이 대역으로 뜨지 않고 던진다(시작 실패. 발권하지 않고 CONFIRMED가 되는 주문이 운영에 생기지 않게) [ASVS v5.0.0-16.5.3]',
    (env) => {
      for (const addr of [undefined, '']) {
        expect(() => ticketIssuerFromEnv({ ...(env === undefined ? {} : { PEAKET_ENV: env }), [TICKET_GRPC_ADDR_ENV]: addr })).toThrow(new RegExp(TICKET_GRPC_ADDR_ENV));
      }
    },
  );

  test('주소가 있으면 어느 환경이든 gRPC 클라이언트이고 경고가 없다. 넘긴 차단기를 클라이언트에 넘긴다', () => {
    const breaker = refusing(new Error('x'));
    const t = ticketIssuerFromEnv({ PEAKET_ENV: 'prod', [TICKET_GRPC_ADDR_ENV]: ADDR }, { breaker });
    try {
      expect(t.warnings).toEqual([]);
      expect(t.issuer).toBeInstanceOf(GrpcTicketIssuer);
      expect((t.issuer as GrpcTicketIssuer).o.breaker).toBe(breaker);
      expect((t.issuer as GrpcTicketIssuer).o.address).toBe(ADDR);
    } finally {
      t.close();
    }
  });

  test('주소가 host:port 모양이 아니면 던진다(시작 실패) [ASVS v5.0.0-16.5.3]', () => {
    for (const addr of ['ticket-svc', ':50051', 'ticket-svc:0', 'ticket-svc:x']) {
      expect(thrownBy(() => ticketIssuerFromEnv({ PEAKET_ENV: 'ci', [TICKET_GRPC_ADDR_ENV]: addr })).message, addr).not.toMatch(NOT_BUILT);
    }
  });
});

describe('ticketIssueCodeOf: gRPC 상태 번호 → 실패 코드', () => {
  test.each(Array.from({ length: 16 }, (_, i) => [i + 1, GRPC_STATUS_NAMES[i + 1]!] as const))('번호 %i → %s(grpc-js status 이름과 같다)', (code, name) => {
    expect(ticketIssueCodeOf(code)).toBe(name);
    expect((grpc.status as unknown as Record<string, number>)[name]).toBe(code);
  });

  test.each([0, 17, 99, -1])('번호 %i(OK·모르는 번호)는 UNKNOWN으로 접는다(다시 보낸다) [ASVS v5.0.0-16.5.2]', (code) => {
    expect(ticketIssueCodeOf(code)).toBe('UNKNOWN');
  });

  test('ADR-0106의 코드: 14 UNAVAILABLE·4 DEADLINE_EXCEEDED·8 RESOURCE_EXHAUSTED, 9 FAILED_PRECONDITION·3 INVALID_ARGUMENT·5 NOT_FOUND (P-T39 ④, ADR0106)', () => {
    expect([14, 4, 8, 9, 3, 5].map(ticketIssueCodeOf)).toEqual(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'INVALID_ARGUMENT', 'NOT_FOUND']);
  });
});

describe('issuedTicketsOf: 받은 답 → 좌석별 티켓 ID', () => {
  test('tickets[]의 seat_id·ticket_id·status를 차례 그대로 { seatId, ticketId, status }로 바꾸고 다른 칸은 버린다(좌석과 맞는지는 보지 않는다)', () => {
    const out = issuedTicketsOf({
      tickets: [
        { ticket_id: TICKET_2, seat_id: SEAT_2, status: 'TICKET_STATUS_ISSUED', extra: 'x' },
        { ticket_id: TICKET_1, seat_id: SEAT_1, status: 'TICKET_STATUS_ISSUED' },
      ],
    });
    expect(out).toEqual([
      { seatId: SEAT_2, ticketId: TICKET_2, status: 'ISSUED' },
      { seatId: SEAT_1, ticketId: TICKET_1, status: 'ISSUED' },
    ]);
    for (const t of out) expect(Object.keys(t).sort()).toEqual(['seatId', 'status', 'ticketId']);
    expect(issuedTicketsOf({ tickets: [] })).toEqual([]);
  });

  test('리뷰 고침 L8_답의 status(TicketStatus 이름)를 접두어 없이 싣고(칸이 없거나 모르는 값이면 UNSPECIFIED), ISSUED·ACTIVE가 아닌 티켓이 섞인 답은 issuedTicketsMatch가 false다(실행기가 BAD_ANSWER로 멈춘다) (P-T15)', () => {
    const statuses = [
      ['TICKET_STATUS_ISSUED', 'ISSUED'],
      ['TICKET_STATUS_ACTIVE', 'ACTIVE'],
      ['TICKET_STATUS_TRANSFER_PENDING', 'TRANSFER_PENDING'],
      ['TICKET_STATUS_CANCEL_REQUESTED', 'CANCEL_REQUESTED'],
      ['TICKET_STATUS_REFUNDED', 'REFUNDED'],
      ['TICKET_STATUS_VOIDED', 'VOIDED'],
      ['TICKET_STATUS_UNSPECIFIED', 'UNSPECIFIED'],
      [undefined, 'UNSPECIFIED'],
      [7, 'UNSPECIFIED'],
      ['VOIDED', 'UNSPECIFIED'],
      ['TICKET_STATUS_BOGUS', 'UNSPECIFIED'],
    ] as const;
    for (const [raw, want] of statuses) {
      const [t] = issuedTicketsOf({ tickets: [{ ticket_id: TICKET_1, seat_id: SEAT_1, ...(raw === undefined ? {} : { status: raw }) }] });
      expect(t, String(raw)).toEqual({ seatId: SEAT_1, ticketId: TICKET_1, status: want });
      expect(issuedTicketsMatch([SEAT_1], [t!]), String(raw)).toBe(want === 'ISSUED' || want === 'ACTIVE');
    }
    const mixed = issuedTicketsOf({
      tickets: [
        { ticket_id: TICKET_1, seat_id: SEAT_1, status: 'TICKET_STATUS_ISSUED' },
        { ticket_id: TICKET_2, seat_id: SEAT_2, status: 'TICKET_STATUS_VOIDED' },
      ],
    });
    expect(issuedTicketsMatch([SEAT_2, SEAT_1], mixed)).toBe(false);
  });

  test.each<[string, Record<string, unknown>]>([
    ['tickets 칸 없음', {}],
    ['tickets가 배열이 아님(글)', { tickets: 'x' }],
    ['tickets가 null', { tickets: null }],
    ['seat_id가 수', { tickets: [{ ticket_id: TICKET_1, seat_id: 1 }] }],
    ['ticket_id 없음', { tickets: [{ seat_id: SEAT_1 }] }],
    ['칸이 객체가 아님', { tickets: ['x'] }],
  ])('%s이면 TicketIssueCallError BAD_ANSWER를 던진다(다시 보내지 않을 실패) (P-T15)', (_name, v) => {
    const err = thrownBy(() => issuedTicketsOf(v));
    expect(err).toBeInstanceOf(TicketIssueCallError);
    expect((err as TicketIssueCallError).code).toBe('BAD_ANSWER');
  });
});

describe('GrpcTicketIssuer: 차단기·데드라인·예외 → 실패 코드', () => {
  test('상수: 데드라인 상한 2초(실행기 데드라인과 같다)·의존 이름 ticket-svc·주소 환경 값 PEAKET_TICKET_GRPC_ADDR (ADR0106)', () => {
    expect([TICKET_ISSUE_CAP_MS, TICKET_ISSUE_CALL_DEADLINE_MS]).toEqual([2000, 2000]);
    expect(TICKET_DEPENDENCY).toBe('ticket-svc');
    expect(TICKET_GRPC_ADDR_ENV).toBe('PEAKET_TICKET_GRPC_ADDR');
  });

  test.each<[string, () => unknown, string]>([
    ['차단기 열림(503 dependency-unavailable)', () => dependencyUnavailable(5), 'CIRCUIT_OPEN'],
    ['동시 호출 상한(429 server-busy)', () => serverBusy(), 'RESOURCE_EXHAUSTED'],
    ['남은 시간 없음(504 deadline-exceeded)', () => deadlineExceeded(), 'DEADLINE_EXCEEDED'],
    ['gRPC가 아닌 예외(TypeError)', () => new TypeError('Cannot read properties of undefined'), 'UNKNOWN'],
  ])('%s면 부르지 않고 TicketIssueCallError %s다(실행기가 다시 보낸다) (ADR0106) [ASVS v5.0.0-16.5.2]', async (_name, err, code) => {
    const runs: unknown[] = [];
    const c = new GrpcTicketIssuer({ address: ADDR, breaker: refusing(err(), runs) });
    try {
      const e = await callErrorOf(c.issue(command()));
      expect(e.code).toBe(code);
      expect(runs).toHaveLength(1);
      // 오류 글에 좌석·계정은 싣지 않는다
      for (const secret of [SEAT_1, SEAT_2, ACCOUNT]) expect(e.message, secret).not.toContain(secret);
    } finally {
      c.close();
    }
  });

  test('주소가 host:port 모양이 아니면 만들 때 던진다', () => {
    for (const address of ['ticket-svc', ':50051', 'ticket-svc:0']) {
      expect(thrownBy(() => new GrpcTicketIssuer({ address })).message, address).not.toMatch(NOT_BUILT);
    }
  });

  test('아무도 듣지 않는 주소면 DEADLINE_EXCEEDED나 UNAVAILABLE(다시 보낼 실패)이다 [ASVS v5.0.0-16.5.2]', async () => {
    const c = new GrpcTicketIssuer({ address: '127.0.0.1:1' });
    try {
      const e = await callErrorOf(c.issue(command({ deadlineMs: 50 })));
      expect(['DEADLINE_EXCEEDED', 'UNAVAILABLE']).toContain(e.code);
    } finally {
      c.close();
    }
  });
});

/** 같은 프로세스의 가짜 ticket-svc(TicketService.IssueTickets만). answer가 답(객체) 또는 gRPC 오류({ code })를 정한다 */
async function fakeTicketServer(answer: (req: Record<string, unknown>) => Promise<Record<string, unknown> | { error: grpc.status }> | Record<string, unknown> | { error: grpc.status }) {
  const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: { TicketService: grpc.ServiceClientConstructor } } } }).peaket.ticket.v1;
  const server = new grpc.Server();
  const requests: Record<string, unknown>[] = [];
  server.addService(pkg.TicketService.service, {
    VoidTickets: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      requests.push(call.request);
      void Promise.resolve(answer(call.request)).then((a) => {
        if ('error' in a) cb({ code: a.error as grpc.status, details: 'fake ticket-svc' });
        else cb(null, a);
      });
    },
    IssueTickets: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      requests.push(call.request);
      void Promise.resolve(answer(call.request)).then((a) => {
        if ('error' in a) cb({ code: a.error as grpc.status, details: 'fake ticket-svc' });
        else cb(null, a);
      });
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))),
  );
  return { address: `127.0.0.1:${port}`, requests, close: () => server.forceShutdown() };
}

describe('GrpcTicketIssuer와 가짜 ticket-svc', () => {
  test('요청은 order_id·event_id·payer_account_id·seat_ids(줄 번호 차례)이고, 답의 tickets를 좌석별 티켓 ID로 돌려준다 (P-T15, ADR0106)', async () => {
    const srv = await fakeTicketServer(() => ({
      tickets: [
        { ticket_id: TICKET_1, seat_id: SEAT_1, status: 'TICKET_STATUS_ISSUED' },
        { ticket_id: TICKET_2, seat_id: SEAT_2, status: 'TICKET_STATUS_ISSUED' },
      ],
    }));
    const c = new GrpcTicketIssuer({ address: srv.address });
    try {
      const out = await c.issue(command());
      expect(out).toEqual([
        { seatId: SEAT_1, ticketId: TICKET_1, status: 'ISSUED' },
        { seatId: SEAT_2, ticketId: TICKET_2, status: 'ISSUED' },
      ]);
      expect(srv.requests).toHaveLength(1);
      // event_starts_at은 BAT-050에서 더한 google.protobuf.Timestamp 칸이다. 이 경로는 아직 회차 시작 시각을 싣지 않으므로
      // protoLoader defaults가 null로 채운다(payment-svc TicketGrpcIssuer는 eventStartsAtMs가 있으면 싣는다).
      expect(srv.requests[0]).toEqual({ order_id: ORDER_ID, event_id: EVENT, payer_account_id: ACCOUNT, seat_ids: [SEAT_2, SEAT_1], issue_generation: 0, event_starts_at: null });
    } finally {
      srv.close();
      c.close();
    }
  });

  test('리뷰 고침 L8_ticket-svc가 티켓 상태 VOIDED(enum 이름)로 답하면 status VOIDED로 돌려주고 좌석과 맞아도 issuedTicketsMatch가 false다. 상태 칸이 빠지면(기본값) UNSPECIFIED다 (P-T15)', async () => {
    const srv = await fakeTicketServer(() => ({
      tickets: [
        { ticket_id: TICKET_1, seat_id: SEAT_1, status: 'TICKET_STATUS_VOIDED' },
        { ticket_id: TICKET_2, seat_id: SEAT_2 },
      ],
    }));
    const c = new GrpcTicketIssuer({ address: srv.address });
    try {
      const out = await c.issue(command());
      expect(out).toEqual([
        { seatId: SEAT_1, ticketId: TICKET_1, status: 'VOIDED' },
        { seatId: SEAT_2, ticketId: TICKET_2, status: 'UNSPECIFIED' },
      ]);
      expect(issuedTicketsMatch([SEAT_2, SEAT_1], out)).toBe(false);
    } finally {
      srv.close();
      c.close();
    }
  });

  test.each<[grpc.status, string]>([
    [grpc.status.FAILED_PRECONDITION, 'FAILED_PRECONDITION'],
    [grpc.status.UNAVAILABLE, 'UNAVAILABLE'],
    [grpc.status.NOT_FOUND, 'NOT_FOUND'],
    [grpc.status.RESOURCE_EXHAUSTED, 'RESOURCE_EXHAUSTED'],
  ])('ticket-svc가 gRPC 상태 %i로 답하면 TicketIssueCallError(%s)이고 다시 묻지 않는다(다시 보내기는 실행기다) (P-T39 ④, ADR0106)', async (status, code) => {
    const srv = await fakeTicketServer(() => ({ error: status }));
    const c = new GrpcTicketIssuer({ address: srv.address });
    try {
      const e = await callErrorOf(c.issue(command()));
      expect(e.code).toBe(code);
      expect(srv.requests).toHaveLength(1);
      for (const secret of [SEAT_1, SEAT_2, ACCOUNT]) expect(e.message, secret).not.toContain(secret);
    } finally {
      srv.close();
      c.close();
    }
  });

  test('데드라인 안에 답하지 않으면 DEADLINE_EXCEEDED다(데드라인 = 명령의 deadlineMs, 상한 2초) [ASVS v5.0.0-16.5.2]', async () => {
    const srv = await fakeTicketServer(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { tickets: [] };
    });
    const c = new GrpcTicketIssuer({ address: srv.address });
    try {
      const e = await callErrorOf(c.issue(command({ deadlineMs: 50 })));
      expect(e.code).toBe('DEADLINE_EXCEEDED');
    } finally {
      srv.close();
      c.close();
    }
  });
});

describe('PromTicketIssueSignals(설계 9)', () => {
  /** 노출 글에서 이름이 name인 표본 줄(이름표가 있으면 그대로 남는다) */
  async function sampleLines(registry: Registry, name: string): Promise<string[]> {
    return (await registry.metrics()).split('\n').filter((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
  }

  test('register는 다섯 지표를 서비스 레지스트리에 붙이고 자신을 돌려준다. 이름표 값은 처음부터 0으로 보인다(jobs{state}: pending·stopped, attempts_total{result}: issued·retry·stopped·stale)', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromTicketIssueSignals();
    expect(prom.register(metrics.registry)).toBe(prom);
    const text = await metrics.registry.metrics();
    for (const [name, type] of [
      ['ticket_issue_jobs', 'gauge'],
      ['ticket_issue_oldest_seconds', 'gauge'],
      ['ticket_issue_attempts_total', 'counter'],
      ['ticket_issue_delayed_total', 'counter'],
      ['ticket_issue_overdue_total', 'counter'],
    ] as const) {
      expect(text, name).toContain(`# TYPE ${name} ${type}`);
      expect(text, name).toContain(`# HELP ${name} `);
    }
    expect((await sampleLines(metrics.registry, 'ticket_issue_jobs')).sort()).toEqual(['ticket_issue_jobs{state="pending"} 0', 'ticket_issue_jobs{state="stopped"} 0']);
    expect((await sampleLines(metrics.registry, 'ticket_issue_attempts_total')).sort()).toEqual(
      ['issued', 'retry', 'stale', 'stopped'].map((r) => `ticket_issue_attempts_total{result="${r}"} 0`),
    );
  });

  test('jobs는 pending·stopped 게이지와 가장 오래된 행의 나이를 둔다(더하지 않고 바꾼다)', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromTicketIssueSignals().register(metrics.registry);
    s.jobs({ pending: 3, stopped: 1, oldestAgeSeconds: 42 });
    s.jobs({ pending: 2, stopped: 1, oldestAgeSeconds: 17 });
    expect((await sampleLines(metrics.registry, 'ticket_issue_jobs')).sort()).toEqual(['ticket_issue_jobs{state="pending"} 2', 'ticket_issue_jobs{state="stopped"} 1']);
    expect(await sampleLines(metrics.registry, 'ticket_issue_oldest_seconds')).toEqual(['ticket_issue_oldest_seconds 17']);
  });

  test('attempt는 그 result를 1 올리고, 모르는 값은 버려 이름표 수가 늘지 않는다(던지지 않는다)', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromTicketIssueSignals().register(metrics.registry);
    s.attempt('retry');
    s.attempt('retry');
    s.attempt('issued');
    expect(() => s.attempt('bogus' as never)).not.toThrow();
    const lines = await sampleLines(metrics.registry, 'ticket_issue_attempts_total');
    expect(lines).toContain('ticket_issue_attempts_total{result="retry"} 2');
    expect(lines).toContain('ticket_issue_attempts_total{result="issued"} 1');
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).not.toContain('bogus');
  });

  test('delayed·overdue는 count만큼 올리고 0이면 그대로다 (P-T39 ①②)', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromTicketIssueSignals().register(metrics.registry);
    s.delayed(3);
    s.delayed(0);
    s.overdue(2);
    s.overdue(0);
    expect(await sampleLines(metrics.registry, 'ticket_issue_delayed_total')).toEqual(['ticket_issue_delayed_total 3']);
    expect(await sampleLines(metrics.registry, 'ticket_issue_overdue_total')).toEqual(['ticket_issue_overdue_total 2']);
  });

  test('붙이기 전에 불러도 던지지 않고, 두 번 만든 신호가 서로의 레지스트리를 더럽히지 않는다', async () => {
    const loose = new PromTicketIssueSignals();
    expect(() => {
      loose.jobs({ pending: 1, stopped: 0, oldestAgeSeconds: 1 });
      loose.attempt('issued');
      loose.delayed(1);
      loose.overdue(1);
    }).not.toThrow();
    const a = new PlatformMetrics('purchase-svc');
    const b = new PlatformMetrics('purchase-svc');
    const sa = new PromTicketIssueSignals().register(a.registry);
    new PromTicketIssueSignals().register(b.registry);
    sa.delayed(5);
    expect(await sampleLines(a.registry, 'ticket_issue_delayed_total')).toEqual(['ticket_issue_delayed_total 5']);
    expect(await sampleLines(b.registry, 'ticket_issue_delayed_total')).not.toContain('ticket_issue_delayed_total 5');
  });
});

describe('LoggerTicketIssueLog', () => {
  const recording = () => {
    const lines: { level: 'warn' | 'error'; obj: Record<string, unknown> }[] = [];
    const logger = {
      warn: (obj: unknown) => void lines.push({ level: 'warn', obj: obj as Record<string, unknown> }),
      error: (obj: unknown) => void lines.push({ level: 'error', obj: obj as Record<string, unknown> }),
    };
    return { lines, log: new LoggerTicketIssueLog(logger as never) };
  };
  /** 받은 객체에 몰래 섞인 칸(좌석·계정·티켓 ID·결제 키) */
  const SMUGGLED = { seatIds: [SEAT_1], payerAccountId: ACCOUNT, ticketId: TICKET_1, paymentKey: 'pk_secret' };

  test('stopped는 error 한 줄 { kind ticket-issue, severity SEV2, orderId, code, csCase TICKET_NOT_ISSUED }이고 그 밖의 칸이 없다 (P-T39 ④, ADR0106) [ASVS v5.0.0-16.3.4]', () => {
    const r = recording();
    r.log.stopped({ orderId: ORDER_ID, code: 'FAILED_PRECONDITION', ...SMUGGLED } as never);
    expect(r.lines).toEqual([{ level: 'error', obj: { kind: 'ticket-issue', severity: 'SEV2', orderId: ORDER_ID, code: 'FAILED_PRECONDITION', csCase: 'TICKET_NOT_ISSUED' } }]);
  });

  test('overdue는 error 한 줄 { kind ticket-issue-overdue, severity SEV1, orderId, csCase TICKET_NOT_ISSUED }다 (P-T39 ②, ADR0106) [ASVS v5.0.0-16.3.4]', () => {
    const r = recording();
    r.log.overdue({ orderId: ORDER_ID, ...SMUGGLED } as never);
    expect(r.lines).toEqual([{ level: 'error', obj: { kind: 'ticket-issue-overdue', severity: 'SEV1', orderId: ORDER_ID, csCase: 'TICKET_NOT_ISSUED' } }]);
  });

  test('staleAnswer는 warn 한 줄 { kind ticket-issue, event stale_answer, orderId, current? }이고 current가 없으면 그 칸도 없다 [ASVS v5.0.0-2.3.1]', () => {
    const r = recording();
    r.log.staleAnswer({ orderId: ORDER_ID, current: 'COMPENSATED', ...SMUGGLED } as never);
    r.log.staleAnswer({ orderId: ORDER_ID });
    expect(r.lines).toEqual([
      { level: 'warn', obj: { kind: 'ticket-issue', event: 'stale_answer', orderId: ORDER_ID, current: 'COMPENSATED' } },
      { level: 'warn', obj: { kind: 'ticket-issue', event: 'stale_answer', orderId: ORDER_ID } },
    ]);
  });

  test('runError는 error 한 줄 { kind ticket-issue, event run_error, what, orderId?, err(플랫폼 errorSummary: "이름: 글") }이고 스택·원인·다른 칸은 싣지 않는다 [ASVS v5.0.0-16.3.4]', () => {
    const r = recording();
    const err = new Error('db down', { cause: new Error(SEAT_1) });
    r.log.runError({ what: 'complete', orderId: ORDER_ID, err, ...SMUGGLED } as never);
    r.log.runError({ what: 'claim', err: new TypeError('x') });
    expect(r.lines).toEqual([
      { level: 'error', obj: { kind: 'ticket-issue', event: 'run_error', what: 'complete', orderId: ORDER_ID, err: 'Error: db down' } },
      { level: 'error', obj: { kind: 'ticket-issue', event: 'run_error', what: 'claim', err: 'TypeError: x' } },
    ]);
    const text = JSON.stringify(r.lines);
    for (const secret of [SEAT_1, ACCOUNT, TICKET_1, 'pk_secret']) expect(text, secret).not.toContain(secret);
  });

  test('리뷰 고침 M2_runError의 err가 Drizzle 쿼리 오류면 쿼리 틀과 SQLSTATE만 싣고 매개변수(글의 params: …에 든 주문·좌석·티켓 UUID)는 싣지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const r = recording();
    const query = 'update order_item i set ticket_id = v.ticket_id from (values ($1::uuid, $2::uuid)) as v(seat_id, ticket_id) where i.order_id = $3::uuid';
    const err = new DrizzleQueryError(query, [SEAT_1, TICKET_1, ORDER_ID], Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }));
    // 전제: 원래 오류 글에는 매개변수가 들어 있다
    expect(err.message).toContain('params:');
    expect(err.message).toContain(SEAT_1);
    r.log.runError({ what: 'complete', orderId: ORDER_ID, err });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.obj.err).toBe(`DrizzleQueryError: Failed query: ${query} (23505)`);
    const errText = JSON.stringify(r.lines[0]!.obj.err);
    for (const secret of [SEAT_1, TICKET_1, ORDER_ID, 'params:']) expect(errText, secret).not.toContain(secret);
  });

  test('로거가 던져도 삼킨다(실행기를 막지 않는다)', () => {
    const throwing = {
      warn: () => {
        throw new Error('x');
      },
      error: () => {
        throw new Error('y');
      },
    };
    const log = new LoggerTicketIssueLog(throwing as never);
    expect(() => log.stopped({ orderId: ORDER_ID, code: 'NOT_FOUND' })).not.toThrow();
    expect(() => log.overdue({ orderId: ORDER_ID })).not.toThrow();
    expect(() => log.staleAnswer({ orderId: ORDER_ID })).not.toThrow();
    expect(() => log.runError({ what: 'gauges', err: new Error('z') })).not.toThrow();
  });
});

describe('발권 실행기 전용 DB 풀(리뷰 고침 H1)', () => {
  test('리뷰 고침 H1_발권 실행기의 큐 쓰기는 핫패스 풀과 따로인 전용 일반 풀(profile general, 연결 24개 [가정], 이름 purchase-svc-ticket-issue)을 쓴다. 주소는 받은 그대로다 (ADR0106, BAT-029) [ASVS v5.0.0-16.5.2]', () => {
    const url = 'postgres://purchase:secret@db.internal:5432/purchase';
    expect(ticketIssueDatabaseOptions(url)).toEqual({ url, profile: 'general', max: 24, applicationName: 'purchase-svc-ticket-issue' });
  });
});

describe('재발권 세대와 티켓 무효(P-T36 ④)', () => {
  test('P-T36 ④_무효 호출은 주문·회차·세대를 싣고, 발권 호출은 새 세대를 싣는다', async () => {
    const srv = await fakeTicketServer(() => ({ voided: 2, tickets: [] }));
    const c = new GrpcTicketIssuer({ address: srv.address });
    try {
      await c.voidTickets({ orderId: ORDER_ID, eventId: EVENT, issueGeneration: 3, deadlineMs: 1_000 });
      await c.issue(command({ issueGeneration: 5 }));
      expect(srv.requests[0]).toEqual({ order_id: ORDER_ID, event_id: EVENT, issue_generation: 3 });
      expect(srv.requests[1]).toMatchObject({ order_id: ORDER_ID, issue_generation: 5 });
    } finally {
      srv.close();
      c.close();
    }
  });

  test('P-T36 ④_리뷰 고침 M6: 무효 답의 입장 기록 수를 돌려준다(칸이 없으면 0이다, 대역도 0이다)', async () => {
    const srv = await fakeTicketServer(() => ({ voided: 2, already_entered: 1 }));
    const old = await fakeTicketServer(() => ({ voided: 2 }));
    const c = new GrpcTicketIssuer({ address: srv.address });
    const d = new GrpcTicketIssuer({ address: old.address });
    try {
      await expect(c.voidTickets({ orderId: ORDER_ID, eventId: EVENT, issueGeneration: 3, deadlineMs: 1_000 })).resolves.toEqual({ alreadyEntered: 1 });
      await expect(d.voidTickets({ orderId: ORDER_ID, eventId: EVENT, issueGeneration: 3, deadlineMs: 1_000 })).resolves.toEqual({ alreadyEntered: 0 });
      await expect(voidingTicketVoider.voidTickets({ orderId: ORDER_ID, eventId: EVENT, issueGeneration: 3, deadlineMs: 1_000 })).resolves.toEqual({ alreadyEntered: 0 });
    } finally {
      srv.close();
      old.close();
      c.close();
      d.close();
    }
  });

  test('P-T36 ④_무효 호출의 실패는 코드로 온다 [ASVS v5.0.0-16.5.2]', async () => {
    const srv = await fakeTicketServer(() => ({ error: grpc.status.UNAVAILABLE }));
    const c = new GrpcTicketIssuer({ address: srv.address });
    try {
      await expect(c.voidTickets({ orderId: ORDER_ID, eventId: EVENT, issueGeneration: 3, deadlineMs: 1_000 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      srv.close();
      c.close();
    }
  });

  test('P-T36 ④_대역의 티켓 ID는 세대마다 다르다(같은 세대는 같다)', async () => {
    const one = await issuingTicketIssuer.issue(command({ issueGeneration: 3 }));
    const same = await issuingTicketIssuer.issue(command({ issueGeneration: 3 }));
    const next = await issuingTicketIssuer.issue(command({ issueGeneration: 5 }));
    expect(same).toEqual(one);
    expect(next.map((t) => t.ticketId)).not.toEqual(one.map((t) => t.ticketId));
  });

  test('P-T36 ④_주소가 없는 local은 무효도 대역이고 운영은 시작 실패다', () => {
    const t = ticketIssuerFromEnv({ PEAKET_ENV: 'local' });
    expect(t.voider).toBe(voidingTicketVoider);
    expect(() => ticketIssuerFromEnv({ PEAKET_ENV: 'prod' })).toThrow();
  });
});
