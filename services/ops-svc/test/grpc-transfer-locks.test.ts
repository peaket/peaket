// F-04-12 IR-20: 실제 SetTransferLock gRPC 어댑터가 잠금 판을 그대로 넘기고,
// ticket-svc의 "더 큰 판만 반영, 같거나 작은 판은 UNCHANGED" 규칙이 적용되는지 본다.
// 정본: docs/api/proto/peaket/ticket/v1/ticket.proto, services/ticket-svc/src/modules/ticket/domain/transfer.ts.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ticketV1Ticket } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcTransferLocks } from '../src/modules/investigations/index.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-26T00:00:00.000Z');
const CASE = '0194b220-0000-7000-8000-000000000001';
const EVENT = '0194b220-0000-7000-8000-000000000002';
const ACCOUNT = '0194b220-0000-7000-8000-000000000003';
const ACTOR = '0194b220-0000-7000-8000-000000000004';
const TICKET = '0194b220-0000-7000-8000-000000000005';

let server: grpc.Server;
let adapter: GrpcTransferLocks;
const accountLocks = new Map<string, { locked: boolean; version: number }>();
const ticketLocks = new Map<string, { caseId: string; locked: boolean; version: number }>();

beforeAll(async () => {
  const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { ticket: { v1: Record<string, grpc.ServiceClientConstructor> } } }).peaket.ticket.v1;
  server = new grpc.Server();
  server.addService(pkg.TransferLockService!.service, {
    SetTransferLock: (call: { request: Record<string, unknown> }, cb: (e: grpc.ServiceError | null, v?: unknown) => void) => {
      const req = call.request;
      const caseId = String(req.case_id);
      const version = Number(req.version);
      const locked = Boolean(req.locked);
      const outcomes = (req.account_ids as string[]).map((accountId) => {
        const existing = accountLocks.get(accountId);
        if (!existing) {
          if (locked) accountLocks.set(accountId, { locked: true, version });
        } else if (version > existing.version) {
          accountLocks.set(accountId, { locked, version });
        }
        const t = ticketLocks.get(TICKET);
        let result = 'TRANSFER_LOCK_RESULT_UNCHANGED';
        if (!t) {
          if (locked) {
            ticketLocks.set(TICKET, { caseId, locked: true, version });
            result = 'TRANSFER_LOCK_RESULT_LOCKED';
          }
        } else if (t.caseId === caseId && version > t.version) {
          ticketLocks.set(TICKET, { caseId, locked, version });
          result = locked ? 'TRANSFER_LOCK_RESULT_LOCKED' : 'TRANSFER_LOCK_RESULT_UNLOCKED';
        }
        return { ticket_id: TICKET, result, withdrawn_offer_id: '', holder_account_id: accountId };
      });
      cb(null, { outcomes });
    },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  adapter = new GrpcTransferLocks(`127.0.0.1:${port}`);
});

afterAll(() => {
  adapter?.close();
  server?.forceShutdown();
});

describe('F-04-12 SetTransferLock gRPC 어댑터', () => {
  test('FX-T15 ⑫ [ASVS v5.0.0-2.1.2] 어댑터는 잠금 판을 그대로 넘기고 같거나 작은 판은 ticket-svc가 무시한다', async () => {
    await adapter.set({ caseId: CASE, eventId: EVENT, accountIds: [ACCOUNT], version: 1, expiresAtMs: NOW + 14 * DAY, actedBy: ACTOR });
    expect(accountLocks.get(ACCOUNT)).toMatchObject({ locked: true, version: 1 });
    expect(ticketLocks.get(TICKET)).toMatchObject({ caseId: CASE, locked: true, version: 1 });

    // 같은 판 해제는 UNCHANGED다: 보상이 사건 판을 그대로 쓰면 안 되는 이유(IR-20)
    await adapter.release({ caseId: CASE, eventId: EVENT, accountIds: [ACCOUNT], version: 1, actedBy: ACTOR });
    expect(accountLocks.get(ACCOUNT)).toMatchObject({ locked: true, version: 1 });
    expect(ticketLocks.get(TICKET)).toMatchObject({ locked: true, version: 1 });

    // 더 큰 판만 실제로 푼다
    await adapter.release({ caseId: CASE, eventId: EVENT, accountIds: [ACCOUNT], version: 2, actedBy: ACTOR });
    expect(accountLocks.get(ACCOUNT)).toMatchObject({ locked: false, version: 2 });
    expect(ticketLocks.get(TICKET)).toMatchObject({ caseId: CASE, locked: false, version: 2 });

    // 같은 판 재잠금도 UNCHANGED다
    await adapter.set({ caseId: CASE, eventId: EVENT, accountIds: [ACCOUNT], version: 2, expiresAtMs: NOW + 14 * DAY, actedBy: ACTOR });
    expect(accountLocks.get(ACCOUNT)).toMatchObject({ locked: false, version: 2 });
    expect(ticketLocks.get(TICKET)).toMatchObject({ locked: false, version: 2 });

    // 재잠금은 해제 판보다 큰 판이어야 한다
    await adapter.set({ caseId: CASE, eventId: EVENT, accountIds: [ACCOUNT], version: 3, expiresAtMs: NOW + 14 * DAY, actedBy: ACTOR });
    expect(accountLocks.get(ACCOUNT)).toMatchObject({ locked: true, version: 3 });
    expect(ticketLocks.get(TICKET)).toMatchObject({ caseId: CASE, locked: true, version: 3 });
  });
});
