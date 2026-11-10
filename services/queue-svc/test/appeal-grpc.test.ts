// 받는 층: gRPC VerificationAppealService(queue.proto, B-T10 ④⑤)를 실제 gRPC 서버(src/grpc-server.ts)와 클라이언트로 돈다. 저장소는 메모리다
// (실제 Valkey는 test-int/verification-store.int.test.ts, queue-svc와 trust-svc를 함께 띄우는 것은 test-int/appeal-resolve.int.test.ts).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { queueV1Queue } from '@peaket/contracts/proto';
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { GetVerificationAppeal, ResolveVerificationAppeal } from '../src/modules/verification/application/appeals.js';
import { SubmitAppeal } from '../src/modules/verification/application/submit-appeal.js';
import type { VerificationStore } from '../src/modules/verification/domain/ports.js';
import { queuePackage, verificationAppealHandlers } from '../src/modules/verification/inbound/appeal.grpc.js';
import { ACCOUNT, newEvent, openSchedule, PID } from './support.js';
import { hashOf, numberDup, override, recordingCases, recordingLogger, recordingSignals, TEST_OPTIONS } from './verification-cases.js';

const NOW = Date.parse('2026-11-10T03:00:00Z');
const clock = fakeClock({ now: NOW });
const memory = new MemoryVerificationStore(clock);
/** 시험이 저장소 장애를 넣는다 */
let down = false;
const store: VerificationStore = override(memory, {
  findAppeal: (id) => (down ? Promise.reject(new QueueStoreUnavailable(new Error('down'))) : memory.findAppeal(id)),
});
const schedules = new MemoryEventSchedules();
const errors: string[] = [];
let server: { port: number; close(): Promise<void> };
type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
let client: grpc.Client & { GetVerificationAppeal: Unary; ResolveVerificationAppeal: Unary };

beforeAll(async () => {
  const log = recordingLogger();
  server = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: queuePackage().VerificationAppealService.service, handlers: verificationAppealHandlers({ get: new GetVerificationAppeal(store), resolve: new ResolveVerificationAppeal(store, clock, log.logger) }, (m) => void errors.push(m)) }],
  });
  const def = protoLoader.fromJSON(queueV1Queue as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = grpc.loadPackageDefinition(def) as unknown as { peaket: { queue: { v1: { VerificationAppealService: grpc.ServiceClientConstructor } } } };
  client = new pkg.peaket.queue.v1.VerificationAppealService(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as typeof client;
});
afterAll(async () => {
  client?.close();
  await server?.close();
});

const call = (method: 'GetVerificationAppeal' | 'ResolveVerificationAppeal', r: object) =>
  new Promise<Record<string, unknown>>((res, rej) => client[method](r, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v ?? {}))));
const statusOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: grpc.ServiceError) => e.code,
  );

/** VERIFYING 대기 참여 하나와 그 이의(접수까지 마친 것) */
async function appealed(text = '사람입니다') {
  const eventId = newEvent();
  await schedules.set(eventId, openSchedule(NOW));
  const ticket = hashOf(`grpc-${eventId}`);
  memory.db.dup.set(`${PID}|${eventId}`, numberDup(5, ticket));
  memory.db.verifyOf(eventId).set(ticket, `VERIFYING:${NOW - 60_000}:SHARED_PATTERN`);
  const out = await new SubmitAppeal(memory, schedules, recordingCases('ok'), TEST_OPTIONS, clock, recordingSignals()).run({ eventId, accountId: ACCOUNT, pid: PID, text });
  if (out.kind !== 'RECEIVED') throw new Error('접수되지 않았다');
  return { eventId, ticket, appealId: out.appealId, receivedAt: out.receivedAt, caseId: `case-${eventId}` };
}

describe('VerificationAppealService', () => {
  test('B-T10 ① GetVerificationAppeal은 이의 글·사유 범주·접수 시각·지금 상태를 주고 없으면 NOT_FOUND다', async () => {
    const a = await appealed('설명을 바랍니다');
    const r = await call('GetVerificationAppeal', { appeal_id: a.appealId });
    expect(r).toEqual({
      appeal_id: a.appealId,
      event_id: a.eventId,
      account_id: ACCOUNT,
      pid: PID,
      text: '설명을 바랍니다',
      reason_category: 'REASON_CATEGORY_SHARED_PATTERN',
      received_at: { seconds: Math.floor(Date.parse(a.receivedAt) / 1000), nanos: (Date.parse(a.receivedAt) % 1000) * 1_000_000 },
      entry_state: 'APPEAL_ENTRY_STATE_VERIFYING',
    });
    expect(await statusOf(call('GetVerificationAppeal', { appeal_id: '0190f3a1-7c2e-7a00-8000-0000000000ff' }))).toBe(grpc.status.NOT_FOUND);
    expect(await statusOf(call('GetVerificationAppeal', { appeal_id: '' }))).toBe(grpc.status.INVALID_ARGUMENT);
  });

  test('B-T10 ④ 기각하면 BLOCKED로 끝나고 라벨 호출이 없다(결과 APPLIED, 상태 ENDED)', async () => {
    const a = await appealed();
    expect(await call('ResolveVerificationAppeal', { appeal_id: a.appealId, case_id: a.caseId, case_version: 1, outcome: 'APPEAL_OUTCOME_REJECTED' })).toEqual({ result: 'RESOLVE_APPEAL_RESULT_APPLIED' });
    expect(memory.db.verify.get(a.eventId)!.get(a.ticket)).toMatch(/^BLOCKED:\d+:SHARED_PATTERN$/);
    expect((await call('GetVerificationAppeal', { appeal_id: a.appealId })).entry_state).toBe('APPEAL_ENTRY_STATE_ENDED');
  });

  test('B-T10 ⑤ 같은 건 ID·판을 두 번 부르면 한 번만 반영되고 작은 판은 UNCHANGED·다른 이의 ID는 ALREADY_EXISTS다', async () => {
    const a = await appealed();
    const resolve = (v: number, outcome = 'APPEAL_OUTCOME_ACCEPTED', o: { appealId?: string; caseId?: string } = {}) =>
      call('ResolveVerificationAppeal', { appeal_id: o.appealId ?? a.appealId, case_id: o.caseId ?? a.caseId, case_version: v, outcome });
    expect((await resolve(9)).result).toBe('RESOLVE_APPEAL_RESULT_APPLIED');
    expect((await resolve(9)).result).toBe('RESOLVE_APPEAL_RESULT_UNCHANGED');
    expect((await resolve(8, 'APPEAL_OUTCOME_REJECTED')).result).toBe('RESOLVE_APPEAL_RESULT_UNCHANGED');
    expect((await resolve(10, 'APPEAL_OUTCOME_REJECTED')).result).toBe('RESOLVE_APPEAL_RESULT_NOT_ISOLATED');
    expect(memory.db.verify.get(a.eventId)!.get(a.ticket)).toMatch(/^PASSED:/);
    expect((await call('GetVerificationAppeal', { appeal_id: a.appealId })).entry_state).toBe('APPEAL_ENTRY_STATE_PASSED');
    const b = await appealed();
    expect(await statusOf(resolve(1, 'APPEAL_OUTCOME_ACCEPTED', { appealId: b.appealId }))).toBe(grpc.status.ALREADY_EXISTS);
    expect(memory.db.verify.get(b.eventId)!.get(b.ticket)).toMatch(/^VERIFYING:/);
  });

  test('B-T10 ⑤ 요청 모양이 틀리면 INVALID_ARGUMENT이고 대기열 Redis가 안 되면 UNAVAILABLE(작업 워커가 다시 보낸다)이다', async () => {
    const a = await appealed();
    for (const bad of [
      { appeal_id: a.appealId, case_id: a.caseId, case_version: 1, outcome: 'APPEAL_OUTCOME_UNSPECIFIED' },
      { appeal_id: a.appealId, case_id: '', case_version: 1, outcome: 'APPEAL_OUTCOME_ACCEPTED' },
      { appeal_id: a.appealId, case_id: a.caseId, case_version: 0, outcome: 'APPEAL_OUTCOME_ACCEPTED' },
      { appeal_id: 'x', case_id: a.caseId, case_version: 1, outcome: 'APPEAL_OUTCOME_ACCEPTED' },
    ])
      expect(await statusOf(call('ResolveVerificationAppeal', bad))).toBe(grpc.status.INVALID_ARGUMENT);
    down = true;
    try {
      expect(await statusOf(call('ResolveVerificationAppeal', { appeal_id: a.appealId, case_id: a.caseId, case_version: 1, outcome: 'APPEAL_OUTCOME_ACCEPTED' }))).toBe(grpc.status.UNAVAILABLE);
      expect(await statusOf(call('GetVerificationAppeal', { appeal_id: a.appealId }))).toBe(grpc.status.UNAVAILABLE);
    } finally {
      down = false;
    }
    expect(memory.db.verify.get(a.eventId)!.get(a.ticket)).toMatch(/^VERIFYING:/);
    // 장애가 풀린 뒤 같은 건·판으로 다시 보내면 반영된다
    expect((await call('ResolveVerificationAppeal', { appeal_id: a.appealId, case_id: a.caseId, case_version: 1, outcome: 'APPEAL_OUTCOME_ACCEPTED' })).result).toBe('RESOLVE_APPEAL_RESULT_APPLIED');
    expect(errors).toEqual([]);
  });
});
