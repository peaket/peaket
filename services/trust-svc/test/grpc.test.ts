// 받는 층: 계약(trust.proto)의 모양을 유스케이스 입력으로 바꾸고, 응답에 허용한 칸만 싣는다(B-T3, POL-006).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { TrustError } from '../src/modules/scoring/application/trust-error.js';
import type { ScoreRequest, ScoreResult } from '../src/modules/scoring/domain/types.js';
import { trustPackage, trustServiceHandlers } from '../src/modules/scoring/inbound/trust.grpc.js';

const seen: ScoreRequest[] = [];
let next: () => Promise<ScoreResult> = async () => ({ verdict: 'ALLOW', degraded: false });
let srv: { port: number; close(): Promise<void> };
type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
let client: grpc.Client & { ScoreRisk: Unary };

beforeAll(async () => {
  const pkg = trustPackage();
  srv = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [
      {
        definition: pkg.TrustService.service,
        handlers: trustServiceHandlers(
          {
            run: (i) => {
              seen.push(i);
              return next();
            },
          },
          () => undefined,
        ),
      },
    ],
  });
  // 부르는 쪽은 서비스들과 같이 기본값을 채워 읽는다(응답의 빈 칸을 시험이 본다)
  const clientPkg = grpc.loadPackageDefinition(protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true })) as unknown as { peaket: { trust: { v1: { TrustService: grpc.ServiceClientConstructor } } } };
  client = new clientPkg.peaket.trust.v1.TrustService(`127.0.0.1:${srv.port}`, grpc.credentials.createInsecure()) as unknown as grpc.Client & { ScoreRisk: Unary };
});

afterAll(async () => {
  client.close();
  await srv.close();
});

const call = (req: object, deadlineMs = 2_000) =>
  new Promise<Record<string, unknown>>((res, rej) => {
    client.ScoreRisk(req, new grpc.Metadata(), { deadline: Date.now() + deadlineMs }, (e, v) => (e ? rej(e) : res(v ?? {})));
  });

describe('ScoreRisk 받는 층', () => {
  test('계약의 enum·칸을 입력으로 바꾸고 데드라인을 넘긴다', async () => {
    seen.length = 0;
    const before = Date.now();
    await call({
      context: 'SCORE_CONTEXT_LOBBY_ENTRY',
      event_id: 'ev-1',
      pid: 'pid-1',
      account_id: 'acc-1',
      human_check_token: 'tok',
      device_id: 'dev',
      client: { ip: '198.51.100.7', user_agent: 'UA', client_hints: { 'sec-ch-ua-platform': '"Windows"' }, asn: 64512 },
      lobby_shuffle: 'LOBBY_SHUFFLE_ON',
      journey_id: 'jny',
      first_visit_at: { seconds: 1000, nanos: 500_000_000 },
    });
    expect(seen[0]).toMatchObject({
      context: 'LOBBY_ENTRY',
      eventId: 'ev-1',
      pid: 'pid-1',
      accountId: 'acc-1',
      humanCheckToken: 'tok',
      deviceId: 'dev',
      shuffle: 'ON',
      journeyId: 'jny',
      firstVisitAtMs: 1_000_500,
      client: { ip: '198.51.100.7', userAgent: 'UA', clientHints: { 'sec-ch-ua-platform': '"Windows"' }, asn: 64512 },
    });
    expect(seen[0]!.behavior).toBeUndefined();
    expect(seen[0]!.deadlineAtMs).toBeGreaterThan(before);
    expect(seen[0]!.deadlineAtMs).toBeLessThanOrEqual(Date.now() + 2_000);
  });

  test('B-T3_응답에는판정·사유범주·degraded만있고_쓰지않는reason_category는비어있다', async () => {
    next = async () => ({ verdict: 'CHALLENGE', reason: 'NETWORK', degraded: true });
    const r = await call({ context: 'SCORE_CONTEXT_PREVERIFY', lobby_shuffle: 'LOBBY_SHUFFLE_OFF' });
    expect(r).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_NETWORK', degraded: true, reason_category: '' });
    expect(Object.keys(r).sort()).toEqual(['degraded', 'reason', 'reason_category', 'verdict']);
  });

  test('ALLOW에는사유가없다', async () => {
    next = async () => ({ verdict: 'ALLOW', degraded: false });
    expect(await call({ context: 'SCORE_CONTEXT_LOGIN' })).toMatchObject({ verdict: 'VERDICT_ALLOW', reason: 'REASON_CATEGORY_UNSPECIFIED' });
  });

  test('행동요약칸을받아넘긴다', async () => {
    seen.length = 0;
    next = async () => ({ verdict: 'ALLOW', degraded: false });
    await call({ context: 'SCORE_CONTEXT_PREVERIFY', lobby_shuffle: 'LOBBY_SHUFFLE_OFF', behavior: { v: 1, window_ms: 1000, pointer_moves: 5, pointer_entropy: 1.5 } });
    expect(seen[0]!.behavior).toMatchObject({ v: 1, windowMs: 1000, pointerMoves: 5, pointerEntropy: 1.5 });
  });

  test('낮음10_없는칸은값없음이고_보낸0은0이다(gRPC기본값0과구분)', async () => {
    seen.length = 0;
    next = async () => ({ verdict: 'ALLOW', degraded: false });
    await call({ context: 'SCORE_CONTEXT_PREVERIFY', lobby_shuffle: 'LOBBY_SHUFFLE_OFF', behavior: { v: 1, window_ms: 1000, pointer_moves: 5 } });
    expect(seen[0]!.behavior!.pointerEntropy).toBeUndefined();
    expect(seen[0]!.behavior!.inputIntervalStdMs).toBeUndefined();
    await call({ context: 'SCORE_CONTEXT_PREVERIFY', lobby_shuffle: 'LOBBY_SHUFFLE_OFF', behavior: { v: 1, window_ms: 1000, pointer_moves: 5, pointer_entropy: 0, input_interval_std_ms: 0 } });
    expect(seen[1]!.behavior).toMatchObject({ pointerEntropy: 0, inputIntervalStdMs: 0 });
  });

  test('맥락이없으면INVALID_ARGUMENT다', async () => {
    await expect(call({})).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  });

  test('업무오류는상태코드로_예상못한오류는고정문구INTERNAL이다', async () => {
    next = async () => {
      throw new TrustError('UNAVAILABLE', '설정을 읽지 못했다');
    };
    await expect(call({ context: 'SCORE_CONTEXT_LOGIN' })).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    next = async () => {
      throw new Error('비밀이 든 내부 문구');
    };
    await expect(call({ context: 'SCORE_CONTEXT_LOGIN' })).rejects.toMatchObject({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
  });
});
