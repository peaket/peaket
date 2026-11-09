// queue-svc → trust-svc ScoreRisk 호출(docs/features/bot-defense.md §4.6·§11.3, B-T6): 실제 gRPC로 흉내 서버를 부른다.
// 판정을 받지 못하면 통과로 보지 않고 UNAVAILABLE이다(축소 운영, hd).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { CircuitBreaker, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcTrustRisk } from '../src/modules/entry/adapters/grpc-trust-risk.js';
import type { RiskInput } from '../src/modules/entry/domain/ports.js';

const OPTIONS: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
const def = protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], OPTIONS);
const pkg = grpc.loadPackageDefinition(def) as unknown as { peaket: { trust: { v1: { TrustService: grpc.ServiceClientConstructor } } } };

type Behave = (req: Record<string, unknown>, cb: grpc.sendUnaryData<object>) => void;
let behave: Behave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW' });
const seen: Record<string, unknown>[] = [];
let server: grpc.Server;
let address = '';

beforeAll(async () => {
  server = new grpc.Server();
  server.addService(pkg.peaket.trust.v1.TrustService.service, {
    ScoreRisk: (call: grpc.ServerUnaryCall<Record<string, unknown>, object>, cb: grpc.sendUnaryData<object>) => {
      seen.push(call.request);
      behave(call.request, cb);
    },
  });
  const port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  address = `127.0.0.1:${port}`;
});
afterAll(() => {
  server.forceShutdown();
});

const input = (o: Partial<RiskInput> = {}): RiskInput => ({
  context: 'PREVERIFY',
  eventId: 'ev-1',
  accountId: 'acc-1',
  pid: 'pid-1',
  deviceId: 'dev-1',
  journeyId: 'jny-1',
  lobbyShuffle: false,
  ...o,
});

function make(breaker?: Pick<CircuitBreaker, 'run'>) {
  const reasons: string[] = [];
  const risk = new GrpcTrustRisk(address, 'service', breaker, { fallback: (r) => void reasons.push(r) });
  return { risk, reasons };
}

describe('GrpcTrustRisk', () => {
  test('[Q-T39] 최초방문쿠키의발급시각은_first_visit_at으로_밀리초까지넘긴다', async () => {
    seen.length = 0;
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW' });
    const { risk } = make();
    await risk.score(input({ firstVisitAtMs: 1_800_000_000_123 }));
    expect(seen[0]!.first_visit_at).toMatchObject({ seconds: 1_800_000_000, nanos: 123_000_000 });
    seen.length = 0;
    await risk.score(input());
    expect(seen[0]!.first_visit_at).toBeNull();
  });

  test('HOT-040·BOT-050_로비는맥락LOBBY_ENTRY이고_journey_id·회차정렬·토큰·클라이언트신호를싣는다', async () => {
    seen.length = 0;
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW' });
    const { risk } = make();
    await expect(
      risk.score(input({ context: 'LOBBY', lobbyShuffle: true, humanCheckToken: 't-1', client: { ip: '198.51.100.7', userAgent: 'UA', asn: 64512, clientHints: { 'sec-ch-ua-mobile': '?0' } } })),
    ).resolves.toEqual({ kind: 'OK' });
    expect(seen[0]).toMatchObject({
      context: 'SCORE_CONTEXT_LOBBY_ENTRY',
      event_id: 'ev-1',
      pid: 'pid-1',
      account_id: 'acc-1',
      device_id: 'dev-1',
      human_check_token: 't-1',
      lobby_shuffle: 'LOBBY_SHUFFLE_ON',
      journey_id: 'jny-1',
      client: { ip: '198.51.100.7', user_agent: 'UA', asn: 64512, client_hints: { 'sec-ch-ua-mobile': '?0' } },
    });
    risk.close();
  });

  test('PRF-050_사전검증은맥락PREVERIFY이고_셔플을끈회차는OFF다_행동요약은이름을바꿔싣는다', async () => {
    seen.length = 0;
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW' });
    const { risk } = make();
    await risk.score(input({ behaviorSummary: { v: 1, windowMs: 1000, pointerMoves: 5, inputIntervalStdMs: 12.5 } }));
    expect(seen[0]).toMatchObject({ context: 'SCORE_CONTEXT_PREVERIFY', lobby_shuffle: 'LOBBY_SHUFFLE_OFF', behavior: { v: 1, window_ms: 1000, pointer_moves: 5, input_interval_std_ms: 12.5 } });
    risk.close();
  });

  test('CHALLENGE는추가검증이고사유범주를넘긴다', async () => {
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY' });
    const { risk } = make();
    await expect(risk.score(input())).resolves.toEqual({ kind: 'VERIFY', reason: 'DEVICE_HISTORY' });
    risk.close();
  });

  test('B-T6①_degraded가참인ALLOW는검증보류다', async () => {
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW', degraded: true });
    const { risk } = make();
    await expect(risk.score(input())).resolves.toEqual({ kind: 'HELD' });
    risk.close();
  });

  test('[ASVS v5.0.0-2.4.1] 모르는판정·사유없는CHALLENGE는통과가아니라받지못함이다', async () => {
    const { risk, reasons } = make();
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_BLOCK' });
    await expect(risk.score(input())).resolves.toEqual({ kind: 'UNAVAILABLE' });
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_CHALLENGE' });
    await expect(risk.score(input())).resolves.toEqual({ kind: 'UNAVAILABLE' });
    expect(reasons).toEqual(['invalid', 'invalid']);
    risk.close();
  });

  test('B-T6②_서버오류면받지못함이고까닭을센다', async () => {
    behave = (_r, cb) => cb({ code: grpc.status.UNAVAILABLE, details: 'down' });
    const { risk, reasons } = make();
    await expect(risk.score(input())).resolves.toEqual({ kind: 'UNAVAILABLE' });
    expect(reasons).toEqual(['error']);
    risk.close();
  });

  test('B-T6②_800ms안에답이없으면받지못함이다', async () => {
    behave = (_r, cb) => {
      setTimeout(() => cb(null, { verdict: 'VERDICT_ALLOW' }), 1_500);
    };
    const { risk, reasons } = make();
    const started = Date.now();
    await expect(risk.score(input())).resolves.toEqual({ kind: 'UNAVAILABLE' });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(700);
    expect(took).toBeLessThan(1_400);
    expect(reasons).toEqual(['deadline']);
    risk.close();
  });

  test('시험빈틈_B-T6②_기본값(20건·50%·5초)으로차단기가열리고5초뒤시험호출로닫힌다', async () => {
    seen.length = 0;
    behave = (_r, cb) => cb({ code: grpc.status.UNAVAILABLE, details: 'down' });
    const breaker = new CircuitBreaker({ service: 'queue-svc', dependency: 'trust-svc' });
    const { risk, reasons } = make(breaker);
    for (let i = 0; i < 20; i++) await risk.score(input());
    const calls = seen.length;
    expect(calls).toBe(20);
    await expect(risk.score(input())).resolves.toEqual({ kind: 'UNAVAILABLE' });
    expect(seen.length).toBe(20);
    expect(reasons.at(-1)).toBe('open');
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW' });
    await new Promise((r) => setTimeout(r, 5_300));
    await expect(risk.score(input())).resolves.toEqual({ kind: 'OK' });
    expect(seen.length).toBe(21);
    breaker.shutdown();
    risk.close();
  }, 15_000);

  test('[ASVS v5.0.0-16.3.4] B-T6②_차단기가열리면부르지않고받지못함이다', async () => {
    seen.length = 0;
    behave = (_r, cb) => cb({ code: grpc.status.UNAVAILABLE, details: 'down' });
    const breaker = new CircuitBreaker({ service: 'queue-svc', dependency: 'trust-svc', minCalls: 1, failureRatePercent: 1, openMs: 60_000, clock: systemClock });
    const { risk, reasons } = make(breaker);
    await risk.score(input());
    const calls = seen.length;
    await expect(risk.score(input())).resolves.toEqual({ kind: 'UNAVAILABLE' });
    expect(seen.length).toBe(calls);
    expect(reasons).toEqual(['error', 'open']);
    breaker.shutdown();
    risk.close();
  });
});
