// 입장 기록 대조(ticket.proto GetEntryRecords, BAT-420 GAT-090 A5, P-T19 ①③, docs/features/transfer-refund.md §3.1 '입장 기록 대조와 환급 집기').
// 메모리 저장소 + TicketService + 실제 grpc-js 서버로 돈다(Docker 없음). scanner 스키마 scan_event를 읽는 Drizzle 구현은 test-int/ticket.int.test.ts가 본다.
// 정본 값: 들어감(IN)·통과(PASS)만 입장, 가장 이른 시각, 1~100장 [가정], 소문자 UUID, 같은 표 두 번 금지, 요청 차례. 시험 담당이 구현 전에 썼다(ADR-0270).
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemoryTicketStore } from '../src/modules/ticket/adapters/memory-ticket-store.js';
import { TicketService } from '../src/modules/ticket/application/ticket-service.js';
import { normalizeEntryRecordsInput, TicketInputError, type TicketRecord } from '../src/modules/ticket/domain/ticket.js';
import { ticketPackage, ticketServiceHandlers } from '../src/modules/ticket/inbound/ticket.grpc.js';

const NOW = Date.parse('2026-11-16T10:30:00+09:00');
const AT_1001 = Date.parse('2026-11-16T10:01:00+09:00');
const AT_1005 = Date.parse('2026-11-16T10:05:00+09:00');
const EVENT = randomUUID();
const PAYER = randomUUID();

let store: MemoryTicketStore;
let service: TicketService;

beforeEach(() => {
  store = new MemoryTicketStore();
  service = new TicketService({ store, clock: fakeClock({ now: NOW - 86_400_000 }) });
});

async function issued(n = 1): Promise<TicketRecord[]> {
  const orderId = randomUUID();
  const out: TicketRecord[] = [];
  for (let g = 0; out.length < n; g++) {
    const seatIds = Array.from({ length: Math.min(10, n - out.length) }, () => randomUUID());
    out.push(...(await service.issue({ orderId, eventId: EVENT, payerAccountId: PAYER, seatIds, issueGeneration: g })).tickets);
  }
  return out;
}

describe('GAT-090 A5 ticket-svc 입장 기록 대조(메모리)', () => {
  test('GAT-090 A5 GetEntryRecords는 들어감·통과만 입장으로 세고 가장 이른 시각을 주며 거절·나감·스캔 없음·없는 표는 입장이 아니다', async () => {
    const [enteredTwice, rejectedOnly, outOnly, noScan] = await issued(4);
    store.recordScan(enteredTwice!.ticketId, 'IN', 'PASS', AT_1005);
    store.recordScan(enteredTwice!.ticketId, 'IN', 'PASS', AT_1001);
    store.recordScan(enteredTwice!.ticketId, 'IN', 'REJECT', AT_1001 - 60_000);
    store.recordScan(rejectedOnly!.ticketId, 'IN', 'REJECT', AT_1001);
    store.recordScan(outOnly!.ticketId, 'OUT', 'PASS', AT_1001);
    const unknown = randomUUID();
    const records = await service.entryRecords([noScan!.ticketId, unknown, enteredTwice!.ticketId, rejectedOnly!.ticketId, outOnly!.ticketId]);
    expect(records).toEqual([
      { ticketId: noScan!.ticketId, found: true, entered: false },
      { ticketId: unknown, found: false, entered: false },
      { ticketId: enteredTwice!.ticketId, found: true, entered: true, firstEnteredAtMs: AT_1001 },
      { ticketId: rejectedOnly!.ticketId, found: true, entered: false },
      { ticketId: outOnly!.ticketId, found: true, entered: false },
    ]);
  });

  test('GAT-090 A5 입장 기록 대조는 읽기만 하고 표를 바꾸지 않는다', async () => {
    const [t] = await issued();
    store.recordScan(t!.ticketId, 'IN', 'PASS', AT_1001);
    const before = { ...store.tickets.get(t!.ticketId)! };
    await service.entryRecords([t!.ticketId]);
    expect(store.tickets.get(t!.ticketId)).toEqual(before);
  });

  test('GAT-090 A5 입력이 틀리면 TicketInputError다(0장·101장·같은 표 두 번·대문자 UUID·UUID 아님)이고 100장은 받는다', async () => {
    const hundred = Array.from({ length: 100 }, () => randomUUID());
    const [t] = await issued();
    const bad: [string, string[]][] = [
      ['0장', []],
      ['101장', [...hundred, randomUUID()]],
      ['같은 표 두 번', [t!.ticketId, t!.ticketId]],
      ['대문자 UUID', [t!.ticketId.toUpperCase()]],
      ['UUID 아님', ['ticket-1']],
    ];
    for (const [name, ids] of bad) {
      await expect(service.entryRecords(ids), name).rejects.toBeInstanceOf(TicketInputError);
      expect(() => normalizeEntryRecordsInput(ids), name).toThrow(TicketInputError);
    }
    const ok = await service.entryRecords(hundred);
    expect(ok).toHaveLength(100);
    expect(ok.map((r) => r.ticketId)).toEqual(hundred);
    expect(ok.every((r) => !r.found && !r.entered)).toBe(true);
  });
});

describe('GAT-090 A5 GetEntryRecords gRPC', () => {
  interface Client {
    GetEntryRecords(req: Record<string, unknown>, cb: (err: grpc.ServiceError | null, res: Record<string, unknown>) => void): void;
  }
  let server: Awaited<ReturnType<typeof startGrpcServer>>;
  let client: Client;
  const grpcStore = new MemoryTicketStore();
  const grpcService = new TicketService({ store: grpcStore, clock: fakeClock({ now: NOW - 86_400_000 }) });
  const call = (req: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((res, rej) => client.GetEntryRecords(req, (err, r) => (err ? rej(err) : res(r))));

  beforeAll(async () => {
    server = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [{ definition: ticketPackage().TicketService.service, handlers: ticketServiceHandlers({ ticket: grpcService, nowMs: () => NOW }, () => {}) }],
    });
    client = new (ticketPackage().TicketService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  });
  afterAll(async () => {
    (client as unknown as grpc.Client | undefined)?.close();
    await server?.close();
  });

  test('GAT-090 A5 gRPC 답은 요청 차례의 records(ticket_id·found·entered·first_entered_at)이고 틀린 입력은 INVALID_ARGUMENT다', async () => {
    const r = await grpcService.issue({ orderId: randomUUID(), eventId: EVENT, payerAccountId: PAYER, seatIds: [randomUUID(), randomUUID()], issueGeneration: 0 });
    const [a, b] = r.tickets;
    const atMs = AT_1001 + 250;
    grpcStore.recordScan(b!.ticketId, 'IN', 'PASS', atMs);
    const unknown = randomUUID();
    const out = await call({ ticket_ids: [b!.ticketId, a!.ticketId, unknown] });
    const records = out.records as Array<Record<string, unknown>>;
    expect(records.map((x) => [x.ticket_id, x.found, x.entered])).toEqual([
      [b!.ticketId, true, true],
      [a!.ticketId, true, false],
      [unknown, false, false],
    ]);
    expect(records[0]!.first_entered_at).toMatchObject({ seconds: Math.floor(atMs / 1000), nanos: (atMs % 1000) * 1_000_000 });
    expect(records[1]!.first_entered_at ?? null).toBeNull();
    for (const ticket_ids of [[], [a!.ticketId, a!.ticketId], ['not-a-uuid']]) {
      await expect(call({ ticket_ids })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    }
  });
});
