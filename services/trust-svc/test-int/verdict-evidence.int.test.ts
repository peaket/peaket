// 통합 시험(docs/features/bot-defense.md §12 '판정에 쓰는 자료', B-T15 ①): 실제 Valkey에 실제 ScoreRisk 판정으로 판정 근거 키(tr:vb)와 기기 이력(tr:devhist)을 만들고,
// Redis 판 저장소를 쓰는 GetVerdictEvidence를 실제 gRPC 서버로 띄워 이의 심사(ops-svc, 아직 없음) 자리의 클라이언트로 부른다.
// 사람 확인은 대역(결과를 시험이 정한다). 재평가 격리의 근거(그 작업자는 아직 없다)와 키 회전의 이어 달기는 시험이 키를 직접 쓴다.
// 부르는 신원을 ops-svc로 줄이는 것은 메시 L7 허용 목록 몫이라 여기서 보지 않는다(B-T15 ②, BUILD_ORDER HOT-400).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { trustV1Trust } from '@peaket/contracts/proto';
import { createHotRedis, fakeClock, type FakeClock, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startGrpcServer } from '../src/grpc-server.js';
import { deviceRefsFromEnv } from '../src/modules/scoring/adapters/device-refs.js';
import { keys, RedisFeatureStore } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { GetVerdictEvidence } from '../src/modules/scoring/application/get-verdict-evidence.js';
import { ScoreRisk } from '../src/modules/scoring/application/score-risk.js';
import { parseRuleSet } from '../src/modules/scoring/domain/rules.js';
import { trustEvidenceServiceHandlers } from '../src/modules/scoring/inbound/evidence.grpc.js';
import { trustPackage } from '../src/modules/scoring/inbound/trust.grpc.js';
import { recordingHuman, recordingRecorder, recordingSignals, request, SYNTHETIC_RULES_JSON } from '../test/support.js';
import { startTcpProxy } from './tcp-proxy.js';
import { startValkey } from './valkey.js';

const DAY = 86_400_000;
/** 시험 코드가 직접 부르는 명령의 마감(제품 코드의 100ms와 다르다) */
const slow = (key: string) => ({ key, deadlineMs: 5_000 });
/** 코드의 합성 규칙(판 7)과 다른 두 자리 판 */
const RULES_10 = parseRuleSet(JSON.stringify({ ...(JSON.parse(SYNTHETIC_RULES_JSON) as object), version: 10 }));
/** 시험 라벨 키(합성 값) */
const devices = deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: Buffer.alloc(32, 13).toString('base64') }, systemClock).refs;
/** 형식에 맞는 기기 식별값(base64url 22자) */
const dev = (name: string) => `E${name.replace(/[^A-Za-z0-9]/g, '').padEnd(21, '0').slice(0, 21)}`;
const ref = (name: string) => devices.ref(dev(name))!;
const PID = 'pid-evidence-1';
const EVENT = 'ev-ev1';
const dayOf = (ms: number) => Math.floor(ms / DAY);
const ts = (ms: number) => ({ seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1_000_000 });

type Unary = (r: object, md: grpc.Metadata, o: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
/** 이의 심사 자리의 클라이언트: 계약 설명자로 만들고 보내지 않은 칸도 기본값으로 펼친다(칸 목록 전체를 견준다) */
const clientPkg = grpc.loadPackageDefinition(protoLoader.fromJSON(trustV1Trust as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true })) as unknown as {
  peaket: { trust: { v1: { TrustEvidenceService: grpc.ServiceClientConstructor } } };
};
const PATH = '/peaket.trust.v1.TrustEvidenceService/GetVerdictEvidence';
const NOT_FOUND = {
  found: false,
  reason: 'REASON_CATEGORY_UNSPECIFIED',
  hard_signal: 'HARD_SIGNAL_UNSPECIFIED',
  source: 'EVIDENCE_SOURCE_UNSPECIFIED',
  decided_at: null,
  profile_version: 0,
  device_challenges_sent: 0,
  device_challenges_passed: 0,
  device_challenges_failed: 0,
};

/** 서비스 한 조각: 실제 Valkey 위의 RedisFeatureStore 하나를 ScoreRisk(근거 키를 쓴다)와 GetVerdictEvidence(읽는다)가 함께 쓴다 */
async function evidenceWorld(url: string, o: { serviceUrl?: string; wrap?: (r: HotRedis) => HotRedis; clock?: FakeClock } = {}) {
  const direct = await createHotRedis({ url });
  const serviceRedis = await createHotRedis({ url: o.serviceUrl ?? url });
  const svc = o.wrap ? o.wrap(serviceRedis) : serviceRedis;
  const clock = o.clock ?? fakeClock({ now: Date.UTC(2026, 10, 10, 3, 0, 0) });
  const features = new RedisFeatureStore(svc);
  const human = recordingHuman();
  const recorder = recordingRecorder();
  const pending: Promise<unknown>[] = [];
  const score = new ScoreRisk({
    rules: { current: () => RULES_10, intensity: () => 'BASE' },
    human,
    features,
    devices,
    asn: { classify: () => 'OTHER' },
    recorder,
    behaviors: { behavior: () => undefined },
    signals: recordingSignals(),
    clock,
    after: (w) => void pending.push(w()),
  });
  const errors: unknown[] = [];
  const srv = await startGrpcServer({
    host: '127.0.0.1',
    port: 0,
    services: [{ definition: trustPackage().TrustEvidenceService.service, handlers: trustEvidenceServiceHandlers(new GetVerdictEvidence({ store: features, clock }), (_m, e) => void errors.push(e)) }],
  });
  const client = new clientPkg.peaket.trust.v1.TrustEvidenceService(`127.0.0.1:${srv.port}`, grpc.credentials.createInsecure()) as unknown as grpc.Client & { GetVerdictEvidence: Unary };
  /** 응답 뒤로 미룬 쓰기(근거 키·기기 이력)까지 끝낸 판정 한 번 */
  const judge = async (r: Parameters<typeof request>[0], result: 'PASSED' | 'FAILED' = 'PASSED') => {
    human.set(result);
    const out = await score.run(request(r));
    await Promise.all(pending.splice(0));
    return out;
  };
  const verify = (r: Parameters<typeof request>[0], result: 'PASSED' | 'FAILED') => judge({ context: 'VERIFICATION', shuffle: 'NONE', ...r }, result);
  const call = (req: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      client.GetVerdictEvidence(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v ?? {})));
    });
  /** 응답의 직렬화된 바이트 그대로 */
  const callRaw = (req: object) =>
    new Promise<Buffer>((res, rej) => {
      const def = trustPackage().TrustEvidenceService.service.GetVerdictEvidence!;
      client.makeUnaryRequest(PATH, def.requestSerialize, (b: Buffer) => b, req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v ?? Buffer.alloc(0))));
    });
  const cmd = (args: string[]) => direct.command(args, slow(args[1]!));
  return {
    clock,
    recorder,
    errors,
    serviceRedis,
    judge,
    verify,
    call,
    callRaw,
    cmd,
    close: async () => {
      client.close();
      await srv.close();
      await serviceRedis.close();
      await direct.close();
    },
  };
}

const valkey = startValkey();
let w: Awaited<ReturnType<typeof evidenceWorld>>;

beforeAll(async () => {
  w = await evidenceWorld(valkey.url);
});

afterAll(async () => {
  await w?.close();
  valkey.stop();
});

describe('판정 근거 조회 통합(실제 Valkey)', () => {
  test('B-T15 ① 실제 Valkey에서 근거 조회는 사유 범주·확정 신호·출처·시각·프로필 판·근거 기기의 30일 수만 주고 점수·가중치·기기 가명이 없다', async () => {
    // 기기 A는 차단 기기 목록에 있다(올리는 길은 라벨 반영뿐이지만 여기서는 판정의 확정 신호만 본다)
    await w.cmd(['SET', keys.block(ref('a')), 'x', 'PX', String(60 * DAY)]);
    w.clock.advance(437);
    const decidedAt = w.clock.now();
    // 첫 판정: 차단 기기 목록(확정 신호)으로 추가 검증. 이 판정이 근거 키에 남는다
    expect(await w.judge({ pid: PID, eventId: EVENT, deviceId: dev('a') })).toEqual({ verdict: 'CHALLENGE', reason: 'DEVICE_HISTORY', degraded: false });
    const eventKey = w.recorder.records.at(-1)!.eventKey;
    // 같은 회차의 뒤 판정(근거는 덮지 않고 보냄 수만 오른다)과 기기 A의 추가 검증 실패·통과
    w.clock.advance(65_000);
    await w.judge({ pid: PID, eventId: EVENT, deviceId: dev('a') }, 'FAILED');
    await w.verify({ pid: PID, eventId: EVENT, deviceId: dev('a') }, 'FAILED');
    await w.verify({ pid: PID, eventId: EVENT, deviceId: dev('a') }, 'PASSED');
    // 같은 사람의 다른 기기 B: 같은 회차·다른 회차에서 추가 검증으로 가고 통과를 쌓는다(A의 수에 섞이면 안 된다)
    await w.judge({ pid: PID, eventId: EVENT, deviceId: dev('b') }, 'FAILED');
    await w.judge({ pid: PID, eventId: 'ev-ev1b', deviceId: dev('b') }, 'FAILED');
    for (let i = 0; i < 3; i++) await w.verify({ pid: PID, eventId: EVENT, deviceId: dev('b') }, 'PASSED');
    // 30일 경계 양쪽: 지난 30일 밖(30일 전 칸)과 안(29일 전 칸)을 기기 A 이력에 직접 둔다(뒤의 판정이 옛 칸을 지우지 않게 마지막에 둔다)
    const today = dayOf(w.clock.now());
    await w.cmd(['HINCRBY', keys.devHistory(ref('a')), `sent:${today - 30}`, '7']);
    await w.cmd(['HINCRBY', keys.devHistory(ref('a')), `failed:${today - 29}`, '1']);
    // 근거 키에는 기기 가명과 판정 키가 실제로 있다(응답이 그것을 떼어 낸다)
    expect(JSON.parse(String(await w.cmd(['GET', keys.evidence(PID, EVENT)])))).toEqual({ eventKey, deviceRef: ref('a'), hardSignal: 'BLOCK_LIST', reason: 'DEVICE_HISTORY', profileVersion: 10, decidedAtMs: decidedAt });

    const wire = {
      found: true,
      reason: 'REASON_CATEGORY_DEVICE_HISTORY',
      hard_signal: 'HARD_SIGNAL_BLOCK_LIST',
      source: 'EVIDENCE_SOURCE_REALTIME',
      decided_at: ts(decidedAt),
      profile_version: 10,
      device_challenges_sent: 2,
      device_challenges_passed: 1,
      device_challenges_failed: 2,
    };
    expect(await w.call({ event_id: EVENT, pid: PID })).toEqual(wire);
    const raw = (await w.callRaw({ event_id: EVENT, pid: PID })).toString('latin1');
    for (const secret of [ref('a'), ref('b'), eventKey, PID]) expect(raw).not.toContain(secret);
    // '지난 30일'은 조회 시각에서 센다: 하루 뒤에는 29일 전 칸이 밖으로 나간다
    w.clock.advance(DAY);
    expect(await w.call({ event_id: EVENT, pid: PID })).toEqual({ ...wire, device_challenges_failed: 1 });
    expect(w.errors).toEqual([]);
  });

  test('B-T15 ① 실제 Valkey에서 근거 키가 없으면 found false다(통과 판정·다른 회차·사라진 키·읽을 수 없는 값)', async () => {
    // 기기 C에는 다른 사람의 추가 검증 이력이 있지만, 이 사람은 통과(ALLOW)라 근거 키가 없다
    await w.judge({ pid: 'pid-ev-other', eventId: EVENT, deviceId: dev('c') }, 'FAILED');
    expect(await w.judge({ pid: 'pid-ev-pass', eventId: EVENT, deviceId: dev('c') })).toMatchObject({ verdict: 'ALLOW' });
    expect(await w.cmd(['EXISTS', keys.evidence('pid-ev-pass', EVENT)])).toBe(0);
    // 다른 회차의 근거만 있는 사람
    await w.judge({ pid: 'pid-ev-else', eventId: 'ev-ev2', deviceId: dev('c') }, 'FAILED');
    // 30일이 지나 사라진 근거 키(수명을 줄여 지운다)
    await w.judge({ pid: 'pid-ev-gone', eventId: EVENT, deviceId: dev('c') }, 'FAILED');
    expect(await w.cmd(['EXISTS', keys.evidence('pid-ev-gone', EVENT)])).toBe(1);
    await w.cmd(['PEXPIRE', keys.evidence('pid-ev-gone', EVENT), '1']);
    for (let i = 0; i < 50 && Number(await w.cmd(['EXISTS', keys.evidence('pid-ev-gone', EVENT)])) === 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await w.cmd(['EXISTS', keys.evidence('pid-ev-gone', EVENT)])).toBe(0);
    // 읽을 수 없는 값(글이 깨졌거나 계약에 없는 사유·확정 신호): 틀린 값을 보이지 않고 근거가 없는 것으로 본다
    await w.cmd(['SET', keys.evidence('pid-ev-bad1', EVENT), '{not json', 'PX', '60000']);
    await w.cmd(['SET', keys.evidence('pid-ev-bad2', EVENT), JSON.stringify({ eventKey: 'x', deviceRef: ref('c'), hardSignal: 'BLOCK_LIST', reason: 'SCORE_0_93', profileVersion: 10, decidedAtMs: 1 }), 'PX', '60000']);
    await w.cmd(['SET', keys.evidence('pid-ev-bad3', EVENT), JSON.stringify({ eventKey: 'x', deviceRef: ref('c'), hardSignal: 'MAYBE', reason: 'NETWORK', profileVersion: 10, decidedAtMs: 1 }), 'PX', '60000']);
    for (const [eventId, pid] of [
      [EVENT, 'pid-ev-pass'],
      [EVENT, 'pid-ev-else'],
      [EVENT, 'pid-ev-gone'],
      [EVENT, 'pid-ev-bad1'],
      [EVENT, 'pid-ev-bad2'],
      [EVENT, 'pid-ev-bad3'],
      ['ev-never', 'pid-never'],
    ] as const) {
      // 오류가 아니다. 다른 칸은 모두 기본값이고 기기 수도 0이다(기기 이력을 흘리지 않는다)
      expect(await w.call({ event_id: eventId, pid })).toEqual(NOT_FOUND);
    }
    expect(w.errors).toEqual([]);
  });

  test('B-T15 ① 실제 Valkey에서 재평가 격리 근거는 출처 REASSESS·사유 SHARED_PATTERN이고, 키 회전으로 옮겨진 기기는 이어 달기를 따라 새 판 값의 이력을 센다', async () => {
    const today = dayOf(w.clock.now());
    const oldRef = `k1.${'o'.repeat(43)}`;
    const newRef = `k2.${'n'.repeat(43)}`;
    // 재평가 작업자(아직 없다)가 쓸 근거: 옛 판 기기 가명. 그 기기의 키는 이음에서 새 판 값으로 옮겨졌고 이어 달기가 있다
    await w.cmd(['SET', keys.evidence('pid-ev-ra', EVENT), JSON.stringify({ eventKey: '0190f3a1-7c2e-7a00-8000-0000000000ef', deviceRef: oldRef, hardSignal: 'NONE', reason: 'SHARED_PATTERN', source: 'REASSESS', profileVersion: 15, decidedAtMs: 1_762_740_000_321 }), 'PX', String(DAY)]);
    await w.cmd(['SET', keys.refNext(oldRef), newRef, 'PX', String(DAY)]);
    await w.cmd(['HINCRBY', keys.devHistory(newRef), `sent:${today}`, '2']);
    await w.cmd(['HINCRBY', keys.devHistory(newRef), `failed:${today - 3}`, '1']);
    // 옮기기가 지우지 못한 옛 판 키가 남아 있어도 세지 않는다
    await w.cmd(['HINCRBY', keys.devHistory(oldRef), `passed:${today}`, '9']);
    expect(await w.call({ event_id: EVENT, pid: 'pid-ev-ra' })).toEqual({
      found: true,
      reason: 'REASON_CATEGORY_SHARED_PATTERN',
      hard_signal: 'HARD_SIGNAL_NONE',
      source: 'EVIDENCE_SOURCE_REASSESS',
      decided_at: ts(1_762_740_000_321),
      profile_version: 15,
      device_challenges_sent: 2,
      device_challenges_passed: 0,
      device_challenges_failed: 1,
    });
    // 허니팟 적중 뒤의 실제 판정(기기 식별값 없이 왔다): 확정 신호 HONEYPOT, 근거에 기기가 없어 수는 0이다
    await w.cmd(['SET', keys.honeypot('pid-ev-hp'), JSON.stringify({ atMs: 0, eventId: '' }), 'PX', '60000']);
    const at = w.clock.now();
    expect(await w.judge({ pid: 'pid-ev-hp', eventId: EVENT, deviceId: '' })).toMatchObject({ verdict: 'CHALLENGE', reason: 'INTERACTION' });
    expect(await w.call({ event_id: EVENT, pid: 'pid-ev-hp' })).toEqual({
      found: true,
      reason: 'REASON_CATEGORY_INTERACTION',
      hard_signal: 'HARD_SIGNAL_HONEYPOT',
      source: 'EVIDENCE_SOURCE_REALTIME',
      decided_at: ts(at),
      profile_version: 10,
      device_challenges_sent: 0,
      device_challenges_passed: 0,
      device_challenges_failed: 0,
    });
  });

  test('근거 키를 읽은 뒤 피처 Redis 연결을 실제로 끊으면 UNAVAILABLE이고 found false나 기기 수 0으로 답하지 않는다', async () => {
    const proxy = await startTcpProxy(valkey.url);
    let armed = false;
    let cutAfter: string | undefined;
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      command: async (args, o) => {
        const out = await r.command(args, o);
        // 근거 키 GET이 Valkey에서 답한 바로 뒤(기기 이력을 읽기 전)에 실제 연결을 끊는다
        if (armed && args[0] === 'GET' && args[1]?.startsWith('tr:vb:')) {
          armed = false;
          cutAfter = args[1];
          proxy.cut();
          await new Promise((res) => setTimeout(res, 50));
        }
        return out;
      },
    });
    const x = await evidenceWorld(valkey.url, { serviceUrl: proxy.url, wrap, clock: w.clock });
    try {
      // 이 사람의 근거와 그 기기 이력(같은 Valkey에 있다)
      await x.judge({ pid: 'pid-ev-cut', eventId: EVENT, deviceId: dev('cut') }, 'FAILED');
      const ok = await x.call({ event_id: EVENT, pid: 'pid-ev-cut' });
      expect(ok).toMatchObject({ found: true, reason: 'REASON_CATEGORY_HUMAN_CHECK', device_challenges_sent: 1 });
      armed = true;
      const err = await x.call({ event_id: EVENT, pid: 'pid-ev-cut' }).then(
        () => null,
        (e: grpc.ServiceError) => e,
      );
      // 끊긴 사례가 실제로 있었다: 끊은 자리는 근거 키를 읽은 뒤다
      expect(proxy.cuts).toBe(1);
      expect(cutAfter).toBe(keys.evidence('pid-ev-cut', EVENT));
      expect(err?.code).toBe(grpc.status.UNAVAILABLE);
      expect(err!.details).not.toContain('pid-ev-cut');
      // 끊긴 채로는 처음부터 닿지 못해도 UNAVAILABLE이다
      await expect(x.call({ event_id: EVENT, pid: 'pid-ev-cut' })).rejects.toMatchObject({ code: grpc.status.UNAVAILABLE });
      // 되살리면 같은 답이다(읽기만 하므로 아무것도 바뀌지 않았다)
      proxy.restore();
      for (let i = 0; ; i++) {
        try {
          await x.serviceRedis.command(['PING'], { deadlineMs: 500 });
          break;
        } catch (e) {
          if (i > 50) throw e;
          await new Promise((res) => setTimeout(res, 100));
        }
      }
      expect(await x.call({ event_id: EVENT, pid: 'pid-ev-cut' })).toEqual(ok);
      expect(x.errors).toEqual([]);
    } finally {
      await x.close();
      await proxy.close();
    }
  });

  test('근거 조회는 회차 ID·pid 모양이 틀리면 INVALID_ARGUMENT다(실제 gRPC)', async () => {
    for (const req of [{ event_id: EVENT }, { pid: PID }, { event_id: 'ev}1', pid: PID }, { event_id: EVENT, pid: 'p'.repeat(65) }, { event_id: EVENT, pid: 'pid:x' }]) {
      await expect(w.call(req)).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
    }
  });
});
