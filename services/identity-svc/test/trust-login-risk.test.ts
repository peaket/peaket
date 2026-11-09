// identity-svc → trust-svc ScoreRisk(LOGIN) 호출(docs/features/identity.md §7, BOT-050): 실제 gRPC로 흉내 서버를 부른다. 데드라인 300ms [가정].
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { CircuitBreaker, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcTrustLoginRisk } from '../src/modules/session/adapters/grpc-trust-login-risk.js';

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

const input = { accountId: 'acc-1', deviceId: 'dev-1', clientIp: '198.51.100.7', asn: 64512, userAgent: 'UA' };
const make = (breaker?: Pick<CircuitBreaker, 'run'>) => new GrpcTrustLoginRisk(address, 'service', breaker);

describe('GrpcTrustLoginRisk', () => {
  test('BOT-050_맥락은LOGIN이고_회차·pid·토큰을비우고_기기·IP·ASN·UA를싣는다', async () => {
    seen.length = 0;
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW' });
    const risk = make();
    await expect(risk.score(input)).resolves.toEqual({ verdict: 'ALLOW' });
    expect(seen[0]).toMatchObject({
      context: 'SCORE_CONTEXT_LOGIN',
      event_id: '',
      pid: '',
      human_check_token: '',
      account_id: 'acc-1',
      device_id: 'dev-1',
      lobby_shuffle: 'LOBBY_SHUFFLE_UNSPECIFIED',
      client: { ip: '198.51.100.7', user_agent: 'UA', asn: 64512 },
    });
    risk.close();
  });

  test('리뷰1_degraded인ALLOW는UNKNOWN이다_재확인을건너뛰지않게', async () => {
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_ALLOW', degraded: true });
    const risk = make();
    await expect(risk.score(input)).resolves.toEqual({ verdict: 'UNKNOWN' });
    risk.close();
  });

  test('CHALLENGE는사유범주를낸다', async () => {
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_NETWORK' });
    const risk = make();
    await expect(risk.score(input)).resolves.toEqual({ verdict: 'CHALLENGE', reason: 'NETWORK' });
    risk.close();
  });

  test('[ASVS v5.0.0-2.4.1] 모르는판정·오류·데드라인넘김은UNKNOWN이다_ALLOW로보지않는다', async () => {
    const risk = make();
    behave = (_r, cb) => cb(null, { verdict: 'VERDICT_BLOCK' });
    await expect(risk.score(input)).resolves.toEqual({ verdict: 'UNKNOWN' });
    behave = (_r, cb) => cb({ code: grpc.status.INTERNAL, details: 'x' });
    await expect(risk.score(input)).resolves.toEqual({ verdict: 'UNKNOWN' });
    behave = (_r, cb) => {
      setTimeout(() => cb(null, { verdict: 'VERDICT_ALLOW' }), 1_000);
    };
    const start = Date.now();
    await expect(risk.score(input)).resolves.toEqual({ verdict: 'UNKNOWN' });
    expect(Date.now() - start).toBeLessThan(800);
    risk.close();
  });

  test('[ASVS v5.0.0-16.3.4] 차단기가열리면부르지않고UNKNOWN이다', async () => {
    seen.length = 0;
    behave = (_r, cb) => cb({ code: grpc.status.UNAVAILABLE, details: 'down' });
    const breaker = new CircuitBreaker({ service: 'identity-svc', dependency: 'trust-svc', minCalls: 1, failureRatePercent: 1, openMs: 60_000, clock: systemClock });
    const risk = make(breaker);
    await risk.score(input);
    const calls = seen.length;
    await expect(risk.score(input)).resolves.toEqual({ verdict: 'UNKNOWN' });
    expect(seen.length).toBe(calls);
    breaker.shutdown();
    risk.close();
  });
});
