// F-03-3 OPS-380 회차 단계·T-30분 점검·Go/No-Go 판정 REST 단위 시험(시험 먼저, ADR-0372). 구현 전 트리에는 경로가 없어 404로 실패한다.
// 정본: docs/features/control-tower.md §2('T-30분 점검'·'T=0 집중(최초 10분)'·'판매 진행 중'·'온세일 종료 후'·'공연 당일 입장' 단계, Go/No-Go 판정 문단),
// docs/design/d5-screen-blueprint.md §7.2('대상 없음'의 활성 회차 정의, 'viewer' 상태), ADR-0049, 계획 docs/review/plans/F-03-3.md §4(공개 인터페이스)·§6-3·6-4·6-5.
// 조립은 시작 조립 그대로의 AppModule 메모리 길이다(readiness는 LiveModule.register 안에서 실린다, 계획 '감독에게' 3 (가)). 환경 값은 process.env로 준다.
// 바깥 원천 둘은 HTTP 경계에서만 바꾼다(mock-policy 3절 '다른 서비스 호출'): core-svc 내부 판매 설정 GET /internal/v1/events/{eventId}/sale-config의
// 응답 모양은 core-svc internal-sale-config.controller.ts의 SaleConfigResponse 그대로이고, Prometheus는 이 파일에서 주지 않는다(PEAKET_PROMETHEUS_URL 없음 =
// 점검 항목 원천을 읽지 못함). 실제 Prometheus·PostgreSQL 위 같은 판정은 test-int/ops-readiness.int.test.ts가 본다.
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuditCheckpointService, MemoryAuditChain, MemoryAuditCheckpointStore } from '../src/modules/audit/index.js';
import { MemoryCommandStore } from '../src/modules/commands/index.js';
import { LiveModule, OpsLiveFeed } from '../src/modules/live/index.js';
import { FakeIdentity, quiet } from './support.js';

const MIN = 60_000;
/** 정본 값(control-tower §2, 계획 §6-4). 코드 상수를 가져오지 않는다 */
const CANON = {
  checkFromMs: 30 * MIN, // 'T-30분 점검'
  t0Ms: 10 * MIN, // 'T=0 집중(최초 10분)'
  judgeUntilMs: 20 * MIN, // 'T-20분까지 실패 항목이 회복되면 다시 판정해 Go로 바꿀 수 있다'(판정 창 T-30분~T-20분, 계획 6-4)
};
const NOW = Date.parse('2026-11-23T10:00:00.000Z');
const CORE = 'http://core-svc.test';
const P = 'https://peaket.example/problems/';

const clock = fakeClock({ now: NOW });
const identity = new FakeIdentity();

/** 회차마다의 core 판매 설정 답(없으면 404). status를 주면 그 상태로, raw를 주면 그 본문으로 답한다 */
const core = new Map<string, { status?: number; raw?: unknown; schedule?: { opensAtMs: number; saleEndsAtMs: number; entryOpensAtMs?: number | null; entryClosedAtMs?: number | null } }>();
const coreCalls: string[] = [];

/** core-svc SaleConfigResponse(.strict()) 모양 그대로 */
function saleConfig(eventId: string, s: { opensAtMs: number; saleEndsAtMs: number; entryOpensAtMs?: number | null; entryClosedAtMs?: number | null }) {
  return {
    eventId,
    productionId: randomUUID(),
    promoterId: randomUUID(),
    title: 'F-03-3 시험 회차',
    rev: 1,
    opensAtMs: s.opensAtMs,
    startsAtMs: s.saleEndsAtMs + 24 * 60 * MIN,
    lobbyMinutes: 10,
    lobbyShuffle: true,
    openBatch: false,
    perPersonLimit: 4,
    saleEndsAtMs: s.saleEndsAtMs,
    entryOpensAtMs: s.entryOpensAtMs ?? null,
    entryClosedAtMs: s.entryClosedAtMs ?? null,
    salePolicy: [],
    eligGates: [],
    eligLists: [],
  };
}

const coreFetch = vi.fn<typeof fetch>(async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  coreCalls.push(url.href);
  const m = /^\/internal\/v1\/events\/([^/]+)\/sale-config$/.exec(url.pathname);
  if (url.origin !== CORE || !m) return new Response('not found', { status: 404 });
  const e = core.get(decodeURIComponent(m[1]!));
  if (!e) return new Response(JSON.stringify({ type: `${P}not-found`, status: 404, title: '찾을 수 없습니다' }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
  if (e.status) return new Response(JSON.stringify({ type: `${P}internal`, status: e.status }), { status: e.status, headers: { 'content-type': 'application/problem+json' } });
  const body = e.raw ?? saleConfig(decodeURIComponent(m[1]!), e.schedule!);
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
});

/** 판매 시작이 지금(NOW)에서 offsetMs 뒤인 회차(판매 끝은 시작 + 2시간) */
function eventOpensIn(offsetMs: number, extra: { saleEndsInMs?: number; entryOpensInMs?: number; entryClosesInMs?: number } = {}): string {
  const id = randomUUID();
  core.set(id, {
    schedule: {
      opensAtMs: NOW + offsetMs,
      saleEndsAtMs: NOW + (extra.saleEndsInMs ?? offsetMs + 120 * MIN),
      ...(extra.entryOpensInMs !== undefined ? { entryOpensAtMs: NOW + extra.entryOpensInMs } : {}),
      ...(extra.entryClosesInMs !== undefined ? { entryClosedAtMs: NOW + extra.entryClosesInMs } : {}),
    },
  });
  return id;
}

let svc: Awaited<ReturnType<typeof createService>>;
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

interface ReadinessItem {
  key: string;
  group: 'required' | 'recommended' | 'display';
  status: 'pass' | 'fail' | 'unknown' | 'not-in-env' | 'deferred' | 'display-only';
}
interface Readiness {
  eventId: string;
  stage: string;
  items: ReadinessItem[];
  preview: { verdict: 'go' | 'no-go'; failedRequired: string[]; failedRecommended: string[] };
  judgeableUntil?: string;
  lastJudgement?: Record<string, unknown>;
}

const getReadiness = async (eventId: string, headers: Record<string, string> = identity.ops('viewer')) =>
  svc.http.inject({ method: 'GET', url: `/v1/ops/events/${eventId}/readiness`, headers });
const judge = async (eventId: string, headers: Record<string, string>, body: unknown = {}) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/ops/events/${eventId}/go-no-go-judgements`,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    payload: JSON.stringify(body),
  });
const readiness = async (eventId: string): Promise<Readiness> => {
  const r = await getReadiness(eventId);
  expect(r.statusCode, r.payload).toBe(200);
  return json(r) as unknown as Readiness;
};

/** 판정 규칙(control-tower §2 '필수 항목이 하나라도 실패하면 No-Go', 계획 6-3 '필수 unknown은 실패로 센다', 'local·ci에서 이 환경에 없음은 판정에서 뺀다', '권고 실패는 사유를 받아 계속') */
function expectVerdictRule(r: Readiness) {
  const failedRequired = r.items.filter((i) => i.group === 'required' && (i.status === 'fail' || i.status === 'unknown')).map((i) => i.key);
  const failedRecommended = r.items.filter((i) => i.group === 'recommended' && i.status === 'fail').map((i) => i.key);
  expect([...r.preview.failedRequired].sort()).toEqual([...failedRequired].sort());
  expect([...r.preview.failedRecommended].sort()).toEqual([...failedRecommended].sort());
  expect(r.preview.verdict).toBe(failedRequired.length > 0 ? 'no-go' : 'go');
  // 이 환경에 없음·표시만은 실패 목록에 없다
  const notCounted = new Set(r.items.filter((i) => i.status === 'not-in-env' || i.status === 'display-only').map((i) => i.key));
  expect(r.preview.failedRequired.filter((k) => notCounted.has(k))).toEqual([]);
}

beforeAll(async () => {
  vi.stubGlobal('fetch', coreFetch);
  vi.stubEnv('PEAKET_ENV', 'ci');
  vi.stubEnv('PEAKET_CORE_HTTP_URL', CORE);
  vi.stubEnv('PEAKET_PROMETHEUS_URL', '');
  vi.stubEnv('PEAKET_QUEUE_REDIS_URL', '');
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, auditChain: new MemoryAuditChain() }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});

afterAll(async () => {
  await svc?.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('F-03-3 회차 단계(가짜 시계·대역 core)', () => {
  test('F-03-3 T4 C-T25 ①-1 단계 경계: 판매 시작 − 30분은 t30이고 1ms 전은 none, 시작 1ms 전까지 t30, 시작부터 +10분 전까지 t0, +10분부터 판매 끝 전까지 live, 판매 끝부터 after', async () => {
    const cases: [string, number, { saleEndsInMs?: number }, string][] = [
      ['T-30분 정각', CANON.checkFromMs, {}, 't30'],
      ['T-30분 1ms 전', CANON.checkFromMs + 1, {}, 'none'],
      ['시작 1ms 전', 1, {}, 't30'],
      ['시작 정각', 0, {}, 't0'],
      ['시작 + 10분 − 1ms', -(CANON.t0Ms - 1), {}, 't0'],
      ['시작 + 10분', -CANON.t0Ms, {}, 'live'],
      ['판매 끝 1ms 전', -60 * MIN, { saleEndsInMs: 1 }, 'live'],
      ['판매 끝 정각', -60 * MIN, { saleEndsInMs: 0 }, 'after'],
    ];
    const seen: [string, string][] = [];
    for (const [name, opensIn, extra] of cases) {
      const r = await readiness(eventOpensIn(opensIn, extra));
      seen.push([name, r.stage]);
    }
    expect(seen).toEqual(cases.map(([name, , , stage]) => [name, stage]));
  });

  test('F-03-3 T4 C-T25 ①-2 입장 창(entryOpensAt~entryClosedAt)이면 entry이고, 입장 시작 1ms 전은 after다', async () => {
    const entry = await readiness(eventOpensIn(-3 * 24 * 60 * MIN, { saleEndsInMs: -2 * 24 * 60 * MIN, entryOpensInMs: 0, entryClosesInMs: 4 * 60 * MIN }));
    expect(entry.stage).toBe('entry');
    const before = await readiness(eventOpensIn(-3 * 24 * 60 * MIN, { saleEndsInMs: -2 * 24 * 60 * MIN, entryOpensInMs: 1, entryClosesInMs: 4 * 60 * MIN }));
    expect(before.stage).toBe('after');
  });

  test('F-03-3 T4 C-T25 ①-3 판매 설정이 없으면(core 404) 200 stage none이고, core가 실패하거나 모양이 틀리면 503 readiness-source-unavailable이다', async () => {
    const missing = randomUUID();
    const r = await readiness(missing);
    expect(r).toMatchObject({ eventId: missing, stage: 'none' });
    expect(coreCalls.some((u) => u.endsWith(`/internal/v1/events/${missing}/sale-config`))).toBe(true);

    const broken = randomUUID();
    core.set(broken, { status: 500 });
    const failed = await getReadiness(broken);
    expect(failed.statusCode, failed.payload).toBe(503);
    expect(json(failed)).toMatchObject({ type: `${P}readiness-source-unavailable`, status: 503 });

    const wrongShape = randomUUID();
    core.set(wrongShape, { raw: { eventId: wrongShape, opensAtMs: 'soon' } });
    const bad = await getReadiness(wrongShape);
    expect(bad.statusCode, bad.payload).toBe(503);
    expect(json(bad)).toMatchObject({ type: `${P}readiness-source-unavailable` });
  });

  test('F-03-3 T4 C-T25 ①-4 조회는 viewer·operator·commander·cs_agent·cs_lead가 하고 Cache-Control: no-store이며 judgeableUntil은 판매 시작 − 20분이다', async () => {
    const e = eventOpensIn(25 * MIN);
    for (const role of ['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'] as const) {
      const r = await getReadiness(e, identity.ops(role));
      expect(r.statusCode, `${role}: ${r.payload}`).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    const r = await readiness(e);
    expect(r.stage).toBe('t30');
    expect(r.judgeableUntil).toBe(new Date(NOW + 25 * MIN - CANON.judgeUntilMs).toISOString());
  });
});

describe('F-03-3 T-30분 점검 판정 규칙(원천 없음)', () => {
  test('F-03-3 T2 [ASVS v5.0.0-16.2.2] 원천을 읽지 못한 필수 항목은 unknown이고 실패로 세어 No-Go다(0이나 통과로 읽지 않는다)', async () => {
    const r = await readiness(eventOpensIn(25 * MIN));
    const clockOffset = r.items.find((i) => i.key === 'clock-offset');
    // 시계 오프셋은 필수 항목이고, Prometheus 주소가 없으니 읽지 못했다
    expect(clockOffset).toMatchObject({ key: 'clock-offset', group: 'required', status: 'unknown' });
    expect(r.preview.failedRequired).toContain('clock-offset');
    expect(r.preview.verdict).toBe('no-go');
    expectVerdictRule(r);
  });

  test('F-03-3 T3 C-T25 ①-5 local·ci에서 이 환경에 없음(클라우드 전용) 항목은 배지로 보이고 판정에서 빠진다', async () => {
    const r = await readiness(eventOpensIn(25 * MIN));
    // 프리워밍·CloudFront 한도·교차 리전 백업 같은 클라우드 전용 필수 항목이 있다(control-tower §2, 계획 6-2)
    expect(r.items.filter((i) => i.group === 'required' && i.status === 'not-in-env').length).toBeGreaterThan(0);
    // 필수 13 · 권고 2(d5 §7.2 체크리스트 머리 '필수 13 · 권고 2')
    expect(r.items.filter((i) => i.group === 'required')).toHaveLength(13);
    expect(r.items.filter((i) => i.group === 'recommended')).toHaveLength(2);
    expectVerdictRule(r);
  });
});

describe('F-03-3 Go/No-Go 판정 기록(권한·입력·창)', () => {
  test('F-03-3 T3 C-T25 ①-6 viewer·cs_agent·cs_lead의 판정은 403이고 마지막 판정이 생기지 않는다', async () => {
    const e = eventOpensIn(25 * MIN);
    for (const role of ['viewer', 'cs_agent', 'cs_lead'] as const) {
      const r = await judge(e, identity.ops(role));
      expect(r.statusCode, `${role}: ${r.payload}`).toBe(403);
    }
    expect((await readiness(e)).lastJudgement).toBeUndefined();
  });

  test('F-03-3 T3 C-T25 ①-7 본문의 verdict·items·failedRequired는 쓰지 않고 서버가 다시 계산한 값(No-Go)을 기록하며, 판정자 계정 ID는 응답에 없다', async () => {
    const e = eventOpensIn(25 * MIN);
    const operator = identity.ops('operator');
    const r = await judge(e, operator, { verdict: 'go', items: [{ key: 'clock-offset', group: 'required', status: 'pass' }], failedRequired: [] });
    expect(r.statusCode, r.payload).toBe(201);
    const body = json(r);
    expect(body).toMatchObject({ verdict: 'no-go', judgedAt: new Date(NOW).toISOString() });
    expect(body.failedRequired).toContain('clock-offset');
    expect(typeof body.judgementId).toBe('string');
    expect(r.payload).not.toContain(operator['x-user-id']!);
    const after = await readiness(e);
    expect(after.lastJudgement).toMatchObject({ judgementId: body.judgementId, verdict: 'no-go', sequence: body.sequence });
    expect(JSON.stringify(after)).not.toContain(operator['x-user-id']!);
  });

  test('F-03-3 T3 C-T25 ①-8 commander도 판정하고, 같은 회차의 재판정은 다음 순번이다', async () => {
    const e = eventOpensIn(25 * MIN);
    const first = await judge(e, identity.ops('operator'));
    const second = await judge(e, identity.ops('commander'));
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(json(second).sequence).toBe((json(first).sequence as number) + 1);
    expect((await readiness(e)).lastJudgement).toMatchObject({ judgementId: json(second).judgementId, sequence: json(second).sequence });
  });

  test('F-03-3 T3 C-T25 ①-9 판정 창은 T-30분부터 T-20분까지다: T-30분 1ms 전과 T-20분 1ms 뒤는 409 judgement-window-closed, 두 경계 정각은 201', async () => {
    const op = identity.ops('operator');
    const at = async (opensIn: number) => {
      const e = eventOpensIn(opensIn);
      const r = await judge(e, op);
      return { status: r.statusCode, type: r.statusCode >= 400 ? json(r).type : undefined, last: (await readiness(e)).lastJudgement };
    };
    const tooEarly = await at(CANON.checkFromMs + 1);
    const opens = await at(CANON.checkFromMs);
    const closes = await at(CANON.judgeUntilMs);
    const tooLate = await at(CANON.judgeUntilMs - 1);
    expect([tooEarly.status, opens.status, closes.status, tooLate.status]).toEqual([409, 201, 201, 409]);
    expect([tooEarly.type, tooLate.type]).toEqual([`${P}judgement-window-closed`, `${P}judgement-window-closed`]);
    // 거절한 판정은 기록이 없다
    expect([tooEarly.last, tooLate.last]).toEqual([undefined, undefined]);
  });

  test('F-03-3 T3 C-T25 ①-10 판매 설정이 없는 회차의 판정은 404다', async () => {
    const r = await judge(randomUUID(), identity.ops('operator'));
    expect(r.statusCode, r.payload).toBe(404);
    // 경로가 없어서 난 404(about:blank)가 아니라 회차를 찾지 못한 문제 응답이다
    expect(json(r)).toMatchObject({ type: `${P}not-found`, status: 404 });
  });
});

describe('F-03-3 시작 조립(운영 환경 원천 없음)', () => {
  const feed = () =>
    new OpsLiveFeed({ commands: new MemoryCommandStore(new MemoryAuditChain()), checkpoints: new AuditCheckpointService(new MemoryAuditCheckpointStore(), new MemoryAuditChain(), () => NOW) });
  /** 시작해 보고 뜨면 닫는다. 결과는 'started' 또는 던진 글 */
  const start = async (env: Record<string, string>): Promise<{ started: true } | { error: string }> => {
    @Module({})
    class Root {}
    try {
      const s = await createService({
        name: 'ops-svc',
        module: { module: Root, imports: [LiveModule.register(feed(), { env, retention: false })] },
        // 운영 환경은 로그 가명 키 없이 뜨지 않는다(ADR-0053 결정 1). 이 시험이 보는 원천 밖의 까닭으로 멈추지 않게 준다
        env: { PEAKET_ENV: env.PEAKET_ENV!, PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 5).toString('base64') },
        clock,
        logDestination: quiet(),
        adminAuthz: identity,
      });
      await s.close();
      return { started: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  test('F-03-3 T3 C-T25 ①-11 staging에서 점검·제어 원천 주소가 없으면 시작하지 않고(없는 이름을 알린다), ci는 둘 다 없어도 뜬다', async () => {
    // 둘 다 없으면 어느 쪽을 먼저 보든 그 이름을 알린다(어느 쪽을 먼저 볼지는 구현이 정한다)
    expect(await start({ PEAKET_ENV: 'staging', PEAKET_CORE_HTTP_URL: CORE })).toEqual({ error: expect.stringMatching(/PEAKET_PROMETHEUS_URL|PEAKET_QUEUE_REDIS_URL/) });
    // Prometheus만 있으면 대기열 Redis가 없다고 알린다(제어 입력 없음 표시의 원천, 계획 6-7)
    expect(await start({ PEAKET_ENV: 'staging', PEAKET_CORE_HTTP_URL: CORE, PEAKET_PROMETHEUS_URL: 'http://prometheus.test:9090' })).toEqual({ error: expect.stringMatching(/PEAKET_QUEUE_REDIS_URL/) });
    expect(await start({ PEAKET_ENV: 'ci', PEAKET_CORE_HTTP_URL: CORE })).toEqual({ started: true });
  });
});
