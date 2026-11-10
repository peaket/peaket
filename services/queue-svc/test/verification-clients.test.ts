// 추가 검증이 부르는 바깥: trust-svc ScoreRisk(맥락 VERIFICATION, GrpcTrustRisk.verify), identity-svc CheckReverification(GrpcReverification),
// 건 요청 생산자(KafkaCaseRequests). 실제 gRPC로 흉내 서버를 부르고, 생산자는 가짜 생산자 객체로 본다(실제 Kafka는 test-int/case-requests.int.test.ts, CI).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { CaseRequested } from '@peaket/contracts/asyncapi';
import { identityV1Identity, trustV1Trust } from '@peaket/contracts/proto';
import { CircuitBreaker, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcTrustRisk } from '../src/modules/entry/adapters/grpc-trust-risk.js';
import { GrpcReverification } from '../src/modules/verification/adapters/grpc-reverification.js';
import { type CaseProducer, caseRequestValue, CASES_REQUESTED_TOPIC, KafkaCaseRequests } from '../src/modules/verification/adapters/kafka-case-requests.js';
import { ReverificationUnavailable } from '../src/modules/verification/domain/ports.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const trustPkg = grpc.loadPackageDefinition(protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS)) as unknown as { peaket: { trust: { v1: { TrustService: grpc.ServiceClientConstructor } } } };
const identityPkg = grpc.loadPackageDefinition(protoLoader.fromJSON(identityV1Identity as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS)) as unknown as {
  peaket: { identity: { v1: { ReverificationCheckService: grpc.ServiceClientConstructor } } };
};

type Behave = (req: Record<string, unknown>, cb: grpc.sendUnaryData<object>) => void;
let trustBehave: Behave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW' });
let identityBehave: Behave = (_r, cb) => cb(null, { result: 'REVERIFICATION_RESULT_PASSED', verified_at_ms: 1 });
const trustSeen: Record<string, unknown>[] = [];
const identitySeen: Record<string, unknown>[] = [];
let server: grpc.Server;
let address = '';

beforeAll(async () => {
  server = new grpc.Server();
  server.addService(trustPkg.peaket.trust.v1.TrustService.service, {
    ScoreRisk: (call: grpc.ServerUnaryCall<Record<string, unknown>, object>, cb: grpc.sendUnaryData<object>) => {
      trustSeen.push(call.request);
      trustBehave(call.request, cb);
    },
  });
  server.addService(identityPkg.peaket.identity.v1.ReverificationCheckService.service, {
    CheckReverification: (call: grpc.ServerUnaryCall<Record<string, unknown>, object>, cb: grpc.sendUnaryData<object>) => {
      identitySeen.push(call.request);
      identityBehave(call.request, cb);
    },
  });
  const port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  address = `127.0.0.1:${port}`;
});
afterAll(() => {
  server.forceShutdown();
});

const input = { eventId: 'ev-1', accountId: 'acc-1', pid: 'pid-1', deviceId: 'AQEBAQEBAQEBAQEBAQEBAQ', humanCheckToken: 'verify-token', client: { ip: '198.51.100.7', userAgent: 'UA', asn: 64512, clientHints: { 'sec-ch-ua-mobile': '?0' } } };

describe('GrpcTrustRisk.verify(VERIFICATION)', () => {
  test('B-T11 추가 검증 제출은 맥락 VERIFICATION으로만 부르고 여정 ID·회차 정렬·행동 요약을 싣지 않는다', async () => {
    trustSeen.length = 0;
    trustBehave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW', degraded: false });
    const risk = new GrpcTrustRisk(address);
    await expect(risk.verify(input)).resolves.toBe('ALLOW');
    expect(trustSeen).toHaveLength(1);
    expect(trustSeen[0]).toMatchObject({
      context: 'SCORE_CONTEXT_VERIFICATION',
      event_id: 'ev-1',
      pid: 'pid-1',
      account_id: 'acc-1',
      device_id: 'AQEBAQEBAQEBAQEBAQEBAQ',
      human_check_token: 'verify-token',
      journey_id: '',
      lobby_shuffle: 'LOBBY_SHUFFLE_UNSPECIFIED',
      client: expect.objectContaining({ ip: '198.51.100.7', asn: 64512 }),
    });
    expect(trustSeen[0]!.behavior).toBeNull();
    risk.close();
  });

  test('B-T11 CHALLENGE는 사람 확인 실패이고 degraded면 검증 보류(HELD), 모르는 판정은 받지 못함이다', async () => {
    const risk = new GrpcTrustRisk(address);
    trustBehave = (_r, cb) => cb(null, { verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_HUMAN_CHECK' });
    await expect(risk.verify(input)).resolves.toBe('CHALLENGE');
    trustBehave = (_r, cb) => cb(null, { verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_HUMAN_CHECK', degraded: true });
    await expect(risk.verify(input)).resolves.toBe('HELD');
    trustBehave = (_r, cb) => cb(null, { verdict: 'VERDICT_BLOCK' });
    await expect(risk.verify(input)).resolves.toBe('UNAVAILABLE');
    risk.close();
  });

  test('B-T6 ④ trust-svc 서킷이 열리면 VERIFICATION 판정은 UNAVAILABLE이고 trust-svc를 부르지 않는다', async () => {
    trustSeen.length = 0;
    trustBehave = (_r, cb) => cb({ code: grpc.status.UNAVAILABLE, details: 'down' });
    const breaker = new CircuitBreaker({ service: 'queue-svc', dependency: 'trust-svc', minCalls: 1, failureRatePercent: 1, openMs: 60_000, clock: systemClock });
    const reasons: string[] = [];
    const risk = new GrpcTrustRisk(address, 'service', breaker, { fallback: (r) => void reasons.push(r) });
    await expect(risk.verify(input)).resolves.toBe('UNAVAILABLE');
    const calls = trustSeen.length;
    await expect(risk.verify(input)).resolves.toBe('UNAVAILABLE');
    // 열린 차단기는 부르지 않는다(진입 판정과 같은 차단기다)
    expect(trustSeen.length).toBe(calls);
    await expect(risk.score({ context: 'PREVERIFY', eventId: 'ev-1', accountId: 'a', pid: 'p', deviceId: '', journeyId: 'j', lobbyShuffle: false })).resolves.toEqual({ kind: 'UNAVAILABLE' });
    expect(reasons).toEqual(['error', 'open', 'open']);
    breaker.shutdown();
    risk.close();
  });

  test('B-T6 ④ 800ms 안에 답이 없으면 VERIFICATION 판정은 UNAVAILABLE이다', async () => {
    trustBehave = (_r, cb) => setTimeout(() => cb(null, { verdict: 'VERDICT_ALLOW' }), 1_500);
    const reasons: string[] = [];
    const risk = new GrpcTrustRisk(address, 'service', undefined, { fallback: (r) => void reasons.push(r) });
    const started = Date.now();
    await expect(risk.verify(input)).resolves.toBe('UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(1_400);
    expect(reasons).toEqual(['deadline']);
    risk.close();
  }, 10_000);
});

describe('GrpcReverification', () => {
  test('I-T56 ① 계정·pid·추가 검증 시작 시각을 싣고 결과를 그대로 옮긴다', async () => {
    identitySeen.length = 0;
    const rev = new GrpcReverification(address);
    for (const [wire, out] of [
      ['REVERIFICATION_RESULT_PASSED', 'PASSED'],
      ['REVERIFICATION_RESULT_NOT_FOUND', 'NOT_FOUND'],
      ['REVERIFICATION_RESULT_PERSON_MISMATCH', 'PERSON_MISMATCH'],
    ] as const) {
      identityBehave = (_r, cb) => cb(null, { result: wire });
      await expect(rev.check({ accountId: 'acc-1', pid: 'pid-1', notBeforeMs: 1_794_279_540_123 })).resolves.toBe(out);
    }
    expect(identitySeen[0]).toEqual({ account_id: 'acc-1', pid: 'pid-1', not_before_ms: 1_794_279_540_123 });
    rev.close();
  });

  test('I-T56 ④ identity-svc가 답하지 않거나 오류·모르는 결과면 ReverificationUnavailable이다(통과가 아니다)', async () => {
    const rev = new GrpcReverification(address);
    identityBehave = (_r, cb) => cb({ code: grpc.status.UNAVAILABLE, details: 'down' });
    await expect(rev.check({ accountId: 'a', pid: 'p', notBeforeMs: 1 })).rejects.toBeInstanceOf(ReverificationUnavailable);
    identityBehave = (_r, cb) => cb(null, { result: 'REVERIFICATION_RESULT_UNSPECIFIED' });
    await expect(rev.check({ accountId: 'a', pid: 'p', notBeforeMs: 1 })).rejects.toBeInstanceOf(ReverificationUnavailable);
    identityBehave = (_r, cb) => setTimeout(() => cb(null, { result: 'REVERIFICATION_RESULT_PASSED' }), 1_500);
    const started = Date.now();
    await expect(rev.check({ accountId: 'a', pid: 'p', notBeforeMs: 1 })).rejects.toBeInstanceOf(ReverificationUnavailable);
    expect(Date.now() - started).toBeLessThan(1_400);
    rev.close();
  }, 10_000);

  test('I-T56 ④ identity-svc 차단기가 열리면 부르지 않고 ReverificationUnavailable이다', async () => {
    identitySeen.length = 0;
    identityBehave = (_r, cb) => cb({ code: grpc.status.INTERNAL, details: 'boom' });
    const breaker = new CircuitBreaker({ service: 'queue-svc', dependency: 'identity-svc', minCalls: 1, failureRatePercent: 1, openMs: 60_000, clock: systemClock });
    const rev = new GrpcReverification(address, 'service', breaker);
    await expect(rev.check({ accountId: 'a', pid: 'p', notBeforeMs: 1 })).rejects.toBeInstanceOf(ReverificationUnavailable);
    const calls = identitySeen.length;
    await expect(rev.check({ accountId: 'a', pid: 'p', notBeforeMs: 1 })).rejects.toBeInstanceOf(ReverificationUnavailable);
    expect(identitySeen.length).toBe(calls);
    breaker.shutdown();
    rev.close();
  });
});

describe('KafkaCaseRequests', () => {
  const req = { eventKey: '0190f3a1-7c2e-7a00-8000-0000000000e1', sourceId: '0190f3a1-7c2e-7a00-8000-0000000000a1', category: 'REASON_CATEGORY_DEVICE_HISTORY', createdAtMs: 1_794_279_600_000 };

  function producer(o: { connectFails?: number; sendFails?: boolean } = {}) {
    const sent: { topic: string; key: string; value: Buffer; headers?: Record<string, string> }[] = [];
    let connects = 0;
    let disconnects = 0;
    const p: CaseProducer = {
      connect: async () => {
        connects++;
        if (connects <= (o.connectFails ?? 0)) throw new Error('브로커 없음');
      },
      send: async (r) => {
        if (o.sendFails) throw new Error('보내기 실패');
        for (const m of r.messages) sent.push({ topic: r.topic, ...m });
      },
      disconnect: async () => void disconnects++,
    };
    return { p, sent, connects: () => connects, disconnects: () => disconnects };
  }

  test('B-T10 ① 건 요청 값은 계약 모양(CaseRequested, kind VERIFICATION_APPEAL)이고 키는 이의 ID이며 이의 글·pid·계정이 없다', async () => {
    const pr = producer();
    const cases = new KafkaCaseRequests(() => pr.p, () => ({ traceparent: '00-abc-def-01' }));
    await cases.publish(req);
    expect(pr.sent).toHaveLength(1);
    const m = pr.sent[0]!;
    expect(m.topic).toBe(CASES_REQUESTED_TOPIC);
    expect(m.key).toBe(req.sourceId);
    expect(m.headers).toEqual({ traceparent: '00-abc-def-01' });
    const value = JSON.parse(m.value.toString('utf8')) as Record<string, unknown>;
    expect(CaseRequested.safeParse(value).success).toBe(true);
    expect(value).toEqual({ eventKey: req.eventKey, kind: 'VERIFICATION_APPEAL', sourceId: req.sourceId, category: 'REASON_CATEGORY_DEVICE_HISTORY', followUp: false, hold: false, createdAt: '2026-11-10T03:00:00.000Z' });
    expect(Object.keys(value).sort()).toEqual(['category', 'createdAt', 'eventKey', 'followUp', 'hold', 'kind', 'sourceId']);
    expect(caseRequestValue(req).equals(m.value)).toBe(true);
    await cases.close();
    expect(pr.disconnects()).toBe(1);
  });

  test('B-T10 ② 연결에 실패하면 그 생산자를 버리고 다음 보내기에서 새로 잇는다', async () => {
    const made: ReturnType<typeof producer>[] = [];
    const cases = new KafkaCaseRequests(() => {
      const pr = producer({ connectFails: made.length === 0 ? 1 : 0 });
      made.push(pr);
      return pr.p;
    });
    await expect(cases.publish(req)).rejects.toThrow('브로커 없음');
    await cases.publish(req);
    expect(made).toHaveLength(2);
    expect(made[0]!.disconnects()).toBe(1);
    expect(made[1]!.sent).toHaveLength(1);
  });

  test('B-T10 ② 생산자 보내기가 잇달아 정한 횟수만큼 실패하면 그 생산자를 버리고 새로 만든다(성공하면 다시 센다)', async () => {
    const made: ReturnType<typeof producer>[] = [];
    let failing = true;
    const cases = new KafkaCaseRequests(
      () => {
        const pr = producer();
        pr.p.send = async (r) => {
          if (failing) throw new Error('보내기 실패');
          for (const m of r.messages) pr.sent.push({ topic: r.topic, ...m });
        };
        made.push(pr);
        return pr.p;
      },
      () => ({}),
      // 시험 값: 2번(코드 기본 3번 [가정]과 다르다)
      { maxSendFailures: 2 },
    );
    await expect(cases.publish(req)).rejects.toThrow('보내기 실패');
    expect(made).toHaveLength(1);
    await expect(cases.publish(req)).rejects.toThrow('보내기 실패');
    // 두 번째 실패에서 버렸다
    expect(made[0]!.disconnects()).toBe(1);
    failing = false;
    await cases.publish(req);
    expect(made).toHaveLength(2);
    expect(made[1]!.sent).toHaveLength(1);
    // 성공 뒤에는 다시 센다: 한 번 실패로는 버리지 않는다
    failing = true;
    await expect(cases.publish(req)).rejects.toThrow('보내기 실패');
    failing = false;
    await cases.publish(req);
    expect(made).toHaveLength(2);
  });

  test('B-T10 ② 보내기가 실패하면 던진다(삼키지 않는다)', async () => {
    const pr = producer({ sendFails: true });
    const cases = new KafkaCaseRequests(() => pr.p);
    await expect(cases.publish(req)).rejects.toThrow('보내기 실패');
  });
});
