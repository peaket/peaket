// 판정 근거 조회(trust.proto TrustEvidenceService.GetVerdictEvidence, docs/features/bot-defense.md §12·B-T15 ①)의 단위 시험.
// 이의 심사(ops-svc, 아직 없음) 자리에서 실제 gRPC 서버를 띄워 클라이언트로 부른다. 저장소는 메모리 판(실제 Valkey는 test-int/verdict-evidence.int.test.ts).
// 근거 키는 실제 ScoreRisk 판정으로 만든다(재평가 출처만 그 작업자가 아직 없어 시험 도구로 넣는다).
// 부르는 신원을 ops-svc로 줄이는 것은 메시 L7 허용 목록 몫이라 여기서 보지 않는다(B-T15 ②, BUILD_ORDER HOT-400).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { GetVerdictEvidence } from '../src/modules/scoring/application/get-verdict-evidence.js';
import { TrustError } from '../src/modules/scoring/application/trust-error.js';
import type { EvidenceView } from '../src/modules/scoring/domain/evidence.js';
import { parseRuleSet } from '../src/modules/scoring/domain/rules.js';
import { trustEvidenceServiceHandlers } from '../src/modules/scoring/inbound/evidence.grpc.js';
import { trustPackage } from '../src/modules/scoring/inbound/trust.grpc.js';
import { deviceId, EVENT, PID, request, SYNTHETIC_RULES_JSON, world, type World } from './support.js';

const DAY = 86_400_000;
/** 코드의 합성 규칙(판 7)과 다른 두 자리 판 */
const RULES_12 = parseRuleSet(JSON.stringify({ ...(JSON.parse(SYNTHETIC_RULES_JSON) as object), version: 12 }));
const DEVICE_A = deviceId(31);
const DEVICE_B = deviceId(32);
const REF_A = `k1.ref-of-${DEVICE_A}`;
const REF_B = `k1.ref-of-${DEVICE_B}`;
const PATH = '/peaket.trust.v1.TrustEvidenceService/GetVerdictEvidence';

type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
type EvidenceClient = grpc.Client & { GetVerdictEvidence: Unary };

/** 이의 심사 자리의 클라이언트: 계약 설명자로 만들고, 보내지 않은 칸도 기본값으로 펼쳐(defaults) 칸 목록 전체를 견준다 */
const clientPkg = grpc.loadPackageDefinition(protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true })) as unknown as {
  peaket: { trust: { v1: { TrustEvidenceService: grpc.ServiceClientConstructor } } };
};

let w: World;
/** 시험마다 바꾸는 유스케이스(서버는 하나를 나눠 쓴다) */
let uc: { run(i: { eventId: string; pid: string }): Promise<EvidenceView> };
const errors: unknown[] = [];
let srv: { port: number; close(): Promise<void> };
let client: EvidenceClient;

beforeAll(async () => {
  srv = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: trustPackage().TrustEvidenceService.service, handlers: trustEvidenceServiceHandlers({ run: (i) => uc.run(i) }, (_m, e) => void errors.push(e)) }],
  });
  client = new clientPkg.peaket.trust.v1.TrustEvidenceService(`127.0.0.1:${srv.port}`, grpc.credentials.createInsecure()) as unknown as EvidenceClient;
});

afterAll(async () => {
  client.close();
  await srv.close();
});

const call = (req: object) =>
  new Promise<Record<string, unknown>>((res, rej) => {
    client.GetVerdictEvidence(req, new grpc.Metadata(), { deadline: Date.now() + 2_000 }, (e, v) => (e ? rej(e) : res(v ?? {})));
  });

/** 응답의 직렬화된 바이트 그대로(역직렬화하지 않는다). 계약 밖 칸이나 글이 실려 오는지 본다 */
const callRaw = (req: object) =>
  new Promise<Buffer>((res, rej) => {
    const def = trustPackage().TrustEvidenceService.service.GetVerdictEvidence!;
    client.makeUnaryRequest(PATH, def.requestSerialize, (b: Buffer) => b, req, new grpc.Metadata(), { deadline: Date.now() + 2_000 }, (e, v) => (e ? rej(e) : res(v ?? Buffer.alloc(0))));
  });

/** 받는 층이 응답으로 넘기는 객체(직렬화 전). 직렬화는 계약 밖 칸을 버리므로 처리기의 값 자체를 견준다 */
const handlerOutput = (req: Record<string, unknown>) =>
  new Promise<unknown>((res, rej) => {
    const h = trustEvidenceServiceHandlers({ run: (i) => uc.run(i) }, () => undefined).GetVerdictEvidence as grpc.handleUnaryCall<Record<string, unknown>, unknown>;
    h({ request: req } as grpc.ServerUnaryCall<Record<string, unknown>, unknown>, (e, v) => (e ? rej(e) : res(v)));
  });

/** 응답 뒤로 미룬 쓰기까지 끝낸 판정 한 번 */
async function judge(x: World, o: Parameters<typeof request>[0], human: 'PASSED' | 'FAILED' = 'PASSED') {
  x.human.set(human);
  const r = await x.score.run(request(o));
  await x.flush();
  return r;
}

const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

describe('판정 근거 조회', () => {
  test('B-T15 ① 근거 조회는 사유 범주·확정 신호·출처·시각·프로필 판·30일 수만 주고 점수·가중치·기기 가명이 없다', async () => {
    w = world({ rules: RULES_12 });
    uc = new GetVerdictEvidence({ store: w.features, clock: w.clock });
    w.features.blockDevice(REF_A);
    // 31일 전: 기기 A의 다른 회차 판정과 추가 검증 실패(지난 30일 밖이라 세지 않는다)
    await judge(w, { pid: PID, eventId: 'ev-old', deviceId: DEVICE_A });
    await judge(w, { context: 'VERIFICATION', shuffle: 'NONE', pid: PID, eventId: 'ev-old', deviceId: DEVICE_A }, 'FAILED');
    w.clock.advance(31 * DAY + 40_250);
    // 첫 판정: 차단 기기 목록(확정 신호)으로 추가 검증. 이 판정이 근거 키에 남는다
    const decidedAt = w.clock.now();
    expect(await judge(w, { pid: PID, eventId: EVENT, deviceId: DEVICE_A })).toEqual({ verdict: 'CHALLENGE', reason: 'DEVICE_HISTORY', degraded: false });
    const eventKey = w.recorder.records.at(-1)!.eventKey;
    // 같은 회차의 뒤 판정 둘(근거는 덮지 않고 보냄 수만 오른다)과 기기 A의 추가 검증 실패 둘·통과 하나
    for (const step of [70_000, 70_000]) {
      w.clock.advance(step);
      await judge(w, { pid: PID, eventId: EVENT, deviceId: DEVICE_A }, 'FAILED');
    }
    await judge(w, { context: 'VERIFICATION', shuffle: 'NONE', pid: PID, eventId: EVENT, deviceId: DEVICE_A }, 'FAILED');
    await judge(w, { context: 'VERIFICATION', shuffle: 'NONE', pid: PID, eventId: EVENT, deviceId: DEVICE_A }, 'FAILED');
    await judge(w, { context: 'VERIFICATION', shuffle: 'NONE', pid: PID, eventId: EVENT, deviceId: DEVICE_A });
    // 같은 사람의 다른 기기 B: 같은 회차·다른 회차에서 추가 검증으로 가고 통과를 여럿 쌓는다(A의 수에 섞이면 안 된다)
    await judge(w, { pid: PID, eventId: EVENT, deviceId: DEVICE_B }, 'FAILED');
    await judge(w, { pid: PID, eventId: 'ev-b', deviceId: DEVICE_B }, 'FAILED');
    for (let i = 0; i < 4; i++) await judge(w, { context: 'VERIFICATION', shuffle: 'NONE', pid: PID, eventId: EVENT, deviceId: DEVICE_B });
    expect(w.features.history(REF_B, w.clock.now())).toEqual({ sent: 2, passed: 4, failed: 0 });
    w.clock.advance(90_000);

    const view = { found: true, reason: 'DEVICE_HISTORY', hardSignal: 'BLOCK_LIST', source: 'REALTIME', decidedAtMs: decidedAt, profileVersion: 12, deviceChallenges: { sent: 3, passed: 1, failed: 2 } };
    expect(await uc.run({ eventId: EVENT, pid: PID })).toEqual(view);

    const wire = {
      found: true,
      reason: 'REASON_CATEGORY_DEVICE_HISTORY',
      hard_signal: 'HARD_SIGNAL_BLOCK_LIST',
      source: 'EVIDENCE_SOURCE_REALTIME',
      decided_at: ts(decidedAt),
      profile_version: 12,
      device_challenges_sent: 3,
      device_challenges_passed: 1,
      device_challenges_failed: 2,
    };
    // 처리기가 넘기는 객체: 계약의 칸 아홉 개 그대로(기기 가명·판정 키·점수 칸이 없다)
    const out = await handlerOutput({ event_id: EVENT, pid: PID });
    expect(out).toEqual(wire);
    // 이의 심사 자리의 클라이언트가 받는 값
    expect(await call({ event_id: EVENT, pid: PID })).toEqual(wire);
    // 직렬화 바이트 어디에도 기기 가명(A·B)·판정 키·pid 글이 없다
    const raw = (await callRaw({ event_id: EVENT, pid: PID })).toString('latin1');
    const text = JSON.stringify(out);
    for (const secret of [REF_A, REF_B, eventKey, PID]) {
      expect(raw).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
  });

  test('B-T15 ① 근거 키가 없으면 found false다', async () => {
    w = world({ rules: RULES_12 });
    uc = new GetVerdictEvidence({ store: w.features, clock: w.clock });
    // 기기 A에는 이력이 있지만, 이 사람은 통과(ALLOW)라 근거 키가 없다
    await judge(w, { pid: 'pid-other', eventId: EVENT, deviceId: DEVICE_A }, 'FAILED');
    expect(await judge(w, { pid: PID, eventId: EVENT, deviceId: DEVICE_A })).toMatchObject({ verdict: 'ALLOW' });
    expect(w.features.history(REF_A, w.clock.now()).sent).toBe(1);
    // 다른 회차의 근거만 있는 사람
    await judge(w, { pid: 'pid-elsewhere', eventId: 'ev-2', deviceId: DEVICE_A }, 'FAILED');

    for (const [eventId, pid] of [
      [EVENT, PID],
      [EVENT, 'pid-elsewhere'],
      ['ev-never', 'pid-never'],
    ] as const) {
      expect(await uc.run({ eventId, pid })).toEqual({ found: false });
      expect(await handlerOutput({ event_id: eventId, pid })).toEqual({ found: false });
      // 오류가 아니다. 다른 칸은 모두 기본값이고 기기 수도 0이다(기기 이력을 흘리지 않는다)
      expect(await call({ event_id: eventId, pid })).toEqual({
        found: false,
        reason: 'REASON_CATEGORY_UNSPECIFIED',
        hard_signal: 'HARD_SIGNAL_UNSPECIFIED',
        source: 'EVIDENCE_SOURCE_UNSPECIFIED',
        decided_at: null,
        profile_version: 0,
        device_challenges_sent: 0,
        device_challenges_passed: 0,
        device_challenges_failed: 0,
      });
    }
    expect(errors).toHaveLength(0);
  });

  test('B-T15 ① 허니팟 확정 신호와 재평가 출처·사유를 계약의 이름으로 싣고, 근거에 기기가 없으면 30일 수는 0이다', async () => {
    w = world({ rules: RULES_12 });
    uc = new GetVerdictEvidence({ store: w.features, clock: w.clock });
    // 허니팟 적중 뒤의 판정(확정 신호). 기기 식별값 없이 왔다
    w.features.markHoneypot('pid-hp');
    const at = w.clock.now();
    expect(await judge(w, { pid: 'pid-hp', eventId: EVENT, deviceId: '' })).toMatchObject({ verdict: 'CHALLENGE', reason: 'INTERACTION' });
    expect(await handlerOutput({ event_id: EVENT, pid: 'pid-hp' })).toEqual({
      found: true,
      reason: 'REASON_CATEGORY_INTERACTION',
      hard_signal: 'HARD_SIGNAL_HONEYPOT',
      source: 'EVIDENCE_SOURCE_REALTIME',
      decided_at: ts(at),
      profile_version: 12,
      device_challenges_sent: 0,
      device_challenges_passed: 0,
      device_challenges_failed: 0,
    });
    // 대기 중 재평가의 격리(그 작업자는 아직 없어 근거 키를 시험 도구로 넣는다): 사유 SHARED_PATTERN, 출처 REASSESS
    await judge(w, { pid: 'pid-z', eventId: 'ev-z', deviceId: DEVICE_B }, 'FAILED');
    await judge(w, { context: 'VERIFICATION', shuffle: 'NONE', pid: 'pid-z', eventId: 'ev-z', deviceId: DEVICE_B }, 'FAILED');
    w.features.putEvidence('pid-ra', EVENT, { eventKey: '0190f3a1-7c2e-7a00-8000-0000000000ee', deviceRef: REF_B, hardSignal: 'NONE', reason: 'SHARED_PATTERN', source: 'REASSESS', profileVersion: 15, decidedAtMs: at - 123_456 });
    expect(await call({ event_id: EVENT, pid: 'pid-ra' })).toEqual({
      found: true,
      reason: 'REASON_CATEGORY_SHARED_PATTERN',
      hard_signal: 'HARD_SIGNAL_NONE',
      source: 'EVIDENCE_SOURCE_REASSESS',
      decided_at: ts(at - 123_456),
      profile_version: 15,
      device_challenges_sent: 1,
      device_challenges_passed: 0,
      device_challenges_failed: 1,
    });
  });

  test('근거 조회는 회차 ID·pid 모양이 틀리면 INVALID_ARGUMENT이고 저장소를 읽지 않는다', async () => {
    w = world();
    let reads = 0;
    uc = new GetVerdictEvidence({
      store: {
        verdictEvidence: async (i) => {
          reads += 1;
          return w.features.verdictEvidence(i);
        },
      },
      clock: w.clock,
    });
    for (const req of [{ event_id: EVENT }, { pid: PID }, { event_id: 'ev}1', pid: PID }, { event_id: EVENT, pid: 'p'.repeat(65) }, { event_id: EVENT, pid: 'pid:x' }]) {
      await expect(call(req)).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    }
    expect(reads).toBe(0);
  });

  test('근거 저장소를 읽지 못하면 UNAVAILABLE이고 found false로 답하지 않는다_예상 못 한 오류는 고정 문구 INTERNAL이다', async () => {
    w = world();
    uc = new GetVerdictEvidence({ store: w.features, clock: w.clock });
    w.features.fail(true);
    await expect(call({ event_id: EVENT, pid: PID })).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
    errors.length = 0;
    uc = {
      run: async () => {
        throw new Error('pid-secret이 든 내부 문구');
      },
    };
    await expect(call({ event_id: EVENT, pid: PID })).rejects.toMatchObject({ code: grpc.status.INTERNAL, details: '처리하지 못했다' });
    expect(errors).toHaveLength(1);
    uc = {
      run: async () => {
        throw new TrustError('UNAVAILABLE', '고정 문구');
      },
    };
    await expect(call({ event_id: EVENT, pid: PID })).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE, details: '고정 문구' });
    expect(errors).toHaveLength(1);
  });
});
