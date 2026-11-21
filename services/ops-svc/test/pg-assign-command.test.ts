// 명령 12 결제사 지정(PG_ASSIGN)의 접수·미리보기·실행을 바깥 HTTP 경계와 모듈 공개 함수로 본다(BAT-360 OPS-290, ADR-0349 결정 1~5, 계획 6절 B13~B17).
// 정본 값: 허용 결제사 TOSS·PORTONE, 기본 = 대체는 422 invalid-command(결정 1), 온세일 윈도우 [T − 10분, T + 60분)(결정 2: T − 10분 − 1ms 받음·정각 거절,
// T + 60분 정각 받음), 판매 승인 전(404)은 창 밖, 판매 설정 5초 초과·실패 503 onsale-window-unavailable, 하위 결제사 판정 2초 초과·실패 503 pg-check-unavailable,
// 걸리면 422 pg-fallback-same-provider(하위 결제사 이름과 까닭만, 결정 3), dry-run은 동시 입장 목표 상한 = 승인 상한 × 평균 체류 180초 ÷ 결제 비율 1.0 × 안전 계수 0.5와
// 절대 상한 8,000의 작은 값(docs/features/queue-admission.md §5 '결제사별 상한', 결정 4), 실행은 같은 트랜잭션의 설정 사건 하나(키 '<회차>:PG_ASSIGNMENT:', 값 PgAssignmentValue)와 ACKED(결정 5).
// 판매 시작 원천과 하위 결제사 판정은 다른 서비스 경계라 포트(OnsaleStartSource·PgAssignmentCheck)를 구현한 짝 가짜를 쓰고, 판정 답은 payment.proto 응답 꼴을
// 제품 해독 함수(pgAssignmentVerdictOf)로 읽어 만든다. 시계는 가짜 시계다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { controlEventCodec, createService, fakeClock, type FakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  COMMAND_STORE,
  MemoryCommandStore,
  PgAssignmentGate,
  pgAssignmentVerdictOf,
  type OnsaleStartSource,
  type PgAssignmentCheck,
  type PgAssignmentVerdict,
  type PgName,
} from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const MIN = 60_000;
/** 온세일 윈도우 정본 값(ADR-0349 결정 2, control-tower §3 12행 'T-10분~T+60분') */
const BEFORE = 10 * MIN;
const AFTER = 60 * MIN;

type Headers = Record<string, string>;

/** 판매 시작 원천 짝 가짜: 회차마다 판매 시작(없으면 404 = undefined)을 주고, 실패·멈춤을 흉내 낸다. 부를 때마다 다음 답을 쓴다(실행 직전 확인을 바꿔 볼 때) */
class FakeOnsale implements OnsaleStartSource {
  readonly answers = new Map<string, (number | undefined | 'FAIL' | 'HANG')[]>();
  readonly calls: string[] = [];
  set(eventId: string, ...answers: (number | undefined | 'FAIL' | 'HANG')[]): void {
    this.answers.set(eventId, answers);
  }
  async saleStartMs(eventId: string): Promise<number | undefined> {
    this.calls.push(eventId);
    const list = this.answers.get(eventId) ?? [undefined];
    const a = list.length > 1 ? list.shift() : list[0];
    if (a === 'FAIL') throw new Error('core-svc 503');
    if (a === 'HANG') return new Promise<number | undefined>(() => undefined);
    return a;
  }
}

/** payment.proto CheckEventPgAssignmentResponse 꼴의 답(PgProvider 이름) */
type ProtoAnswer = { allowed: boolean; conflict_sub_provider?: string; conflict_reason?: string; current_primary_pg?: string; current_fallback_pg?: string; approval_limits?: { pg: string; approvals_per_second: number }[] };
const PROTO_PG: Record<PgName, string> = { TOSS: 'PG_PROVIDER_TOSS', PORTONE: 'PG_PROVIDER_PORTONE', SIMULATOR: 'PG_PROVIDER_SIMULATOR' };

/** 하위 결제사 판정 짝 가짜: 답은 proto 꼴을 제품 해독 함수로 읽는다. 차례대로 쓰고 마지막 답을 되풀이한다 */
class FakePgCheck implements PgAssignmentCheck {
  answers: (ProtoAnswer | 'FAIL' | 'HANG')[] = [{ allowed: true, current_primary_pg: PROTO_PG.TOSS, approval_limits: [{ pg: PROTO_PG.TOSS, approvals_per_second: 40 }, { pg: PROTO_PG.PORTONE, approvals_per_second: 25 }] }];
  readonly calls: { eventId: string; primaryPg: PgName; fallbackPg?: PgName }[] = [];
  async check(q: { eventId: string; primaryPg: PgName; fallbackPg?: PgName }): Promise<PgAssignmentVerdict> {
    this.calls.push({ ...q });
    const a = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
    if (a === 'FAIL') throw new Error('UNAVAILABLE');
    if (a === 'HANG') return new Promise<PgAssignmentVerdict>(() => undefined);
    return pgAssignmentVerdictOf(a);
  }
}

interface Harness {
  readonly svc: Awaited<ReturnType<typeof createService>>;
  readonly clock: FakeClock;
  readonly identity: FakeIdentity;
  readonly audit: MemoryAuditChain;
  readonly store: MemoryCommandStore;
  readonly onsale: FakeOnsale;
  readonly pg: FakePgCheck;
  post(url: string, who: Headers, body: unknown): Promise<{ statusCode: number; payload: string }>;
  get(url: string, who: Headers): Promise<{ statusCode: number; payload: string }>;
}

const opened: Harness[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.svc.close();
  vi.useRealTimers();
});

async function harness(o: { wire?: boolean } = {}): Promise<Harness> {
  const clock = fakeClock({ now: NOW });
  const identity = new FakeIdentity();
  const audit = new MemoryAuditChain();
  const onsale = new FakeOnsale();
  const pg = new FakePgCheck();
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, auditChain: audit, ...(o.wire === false ? {} : { commandExtras: { pgAssignment: { onsale, pgCheck: pg } } }) }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  const found: unknown = svc.app.get(COMMAND_STORE);
  if (!(found instanceof MemoryCommandStore)) throw new Error('메모리 조립의 명령 저장소가 아니다');
  const h: Harness = {
    svc,
    clock,
    identity,
    audit,
    store: found,
    onsale,
    pg,
    post: (url, who, body) =>
      svc.http.inject({ method: 'POST', url, headers: { ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), ...who, 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
    get: (url, who) => svc.http.inject({ method: 'GET', url, headers: who }),
  };
  opened.push(h);
  return h;
}

const json = (r: { payload: string }) => (r.payload === '' ? {} : (JSON.parse(r.payload) as Record<string, unknown>));
const slug = (r: { payload: string }) => String(json(r).type ?? '').split('/').pop();
const assign = (params: Record<string, unknown>) => ({ type: 'PG_ASSIGN', reason: '회차 결제사 지정', params });
/** 명령 행·감사 기록·설정 사건 수(거절 뒤 0건을 본다) */
const counts = async (h: Harness, who: Headers) => ({
  commands: (json(await h.get('/v1/ops/commands?limit=100', who)).items as unknown[]).length,
  audits: h.audit.entries.filter((e) => e.recordType.startsWith('COMMAND_')).length,
  settings: h.store.outboxSettings().length,
});

describe('B360-PG 명령 12 매개변수 허용 목록(ADR-0349 결정 1, B13)', () => {
  test('B360-PG ① 허용 목록 밖 칸·결제사·대문자 회차·기본 = 대체는 422 invalid-command이고 명령 행·사건·감사·설정 사건이 0건이다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    const bad: [string, Record<string, unknown>][] = [
      ['모르는 칸', { eventId, primaryPg: 'TOSS', channel: 'A' }],
      ['허용 밖 결제사', { eventId, primaryPg: 'KAKAOPAY' }],
      ['시뮬레이터는 지정 대상이 아님', { eventId, primaryPg: 'SIMULATOR' }],
      ['대문자 회차', { eventId: eventId.toUpperCase(), primaryPg: 'TOSS' }],
      ['기본 없음', { eventId, fallbackPg: 'TOSS' }],
      ['기본 = 대체', { eventId, primaryPg: 'PORTONE', fallbackPg: 'PORTONE' }],
    ];
    for (const [label, params] of bad) {
      const r = await h.post('/v1/ops/commands', op, assign(params));
      expect(r.statusCode, label).toBe(422);
      expect(slug(r), label).toBe('invalid-command');
    }
    expect(await counts(h, op)).toEqual({ commands: 0, audits: 0, settings: 0 });
    // 판정을 부르기 전에 막는다(원천을 부르지 않는다)
    expect(h.onsale.calls).toEqual([]);
    expect(h.pg.calls).toEqual([]);
  });

  test('B360-PG ② 요청은 operator 이상 1인이고 재인증 없이 받는다(viewer는 403), 대체 없는 지정도 받는다', async () => {
    const h = await harness();
    const viewer = h.identity.ops('viewer');
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    expect((await h.post('/v1/ops/commands', viewer, assign({ eventId, primaryPg: 'TOSS' }))).statusCode).toBe(403);
    const r = await h.post('/v1/ops/commands', op, assign({ eventId, primaryPg: 'PORTONE' }));
    expect(r.statusCode, r.payload).toBe(201);
    expect(json(r)).toMatchObject({ type: 'PG_ASSIGN', state: 'ACKED' });
    expect(h.pg.calls).toEqual([
      { eventId, primaryPg: 'PORTONE' },
      { eventId, primaryPg: 'PORTONE' },
    ]);
  });
});

describe('B360-PG 온세일 윈도우(ADR-0349 결정 2, B14)', () => {
  test('[ASVS v5.0.0-2.1.2] 온세일 윈도우 경계 넷: T − 10분 − 1ms 받음, T − 10분 정각 422, T + 60분 − 1ms 422, T + 60분 정각 받음', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    // 지금(NOW)이 각 경계가 되도록 판매 시작 T를 정한다
    const cases: [string, number, number | 'out'][] = [
      ['T − 10분 − 1ms', NOW + BEFORE + 1, 201],
      ['T − 10분 정각', NOW + BEFORE, 422],
      ['T + 60분 − 1ms', NOW - AFTER + 1, 422],
      ['T + 60분 정각', NOW - AFTER, 201],
    ];
    for (const [label, saleStart, status] of cases) {
      const eventId = randomUUID();
      h.onsale.set(eventId, saleStart);
      const r = await h.post('/v1/ops/commands', op, assign({ eventId, primaryPg: 'TOSS', fallbackPg: 'PORTONE' }));
      expect(r.statusCode, `${label} ${r.payload}`).toBe(status);
      if (status === 422) {
        expect(slug(r), label).toBe('command-out-of-range');
        expect(json(r).detail, label).toBe('onsaleWindow');
      } else {
        expect(json(r).state, label).toBe('ACKED');
      }
    }
    // 받은 둘만 명령·설정 사건이 남는다
    const c = await counts(h, op);
    expect(c.commands).toBe(2);
    expect(c.settings).toBe(2);
  });

  test('[ASVS v5.0.0-2.1.2] 판매 승인 전(core 404)은 창 밖으로 받고, 판매 설정 실패는 503 onsale-window-unavailable이며 명령·감사·설정 사건이 없다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const before = randomUUID();
    h.onsale.set(before, undefined);
    const ok = await h.post('/v1/ops/commands', op, assign({ eventId: before, primaryPg: 'TOSS' }));
    expect(ok.statusCode, ok.payload).toBe(201);
    expect(json(ok).state).toBe('ACKED');
    const after = await counts(h, op);
    expect(after.commands).toBe(1);
    const down = randomUUID();
    h.onsale.set(down, 'FAIL');
    const r = await h.post('/v1/ops/commands', op, assign({ eventId: down, primaryPg: 'TOSS' }));
    expect(r.statusCode).toBe(503);
    expect(slug(r)).toBe('onsale-window-unavailable');
    expect(await counts(h, op)).toEqual(after);
    // 503 쪽 회차로는 명령도 감사 기록도 없다
    expect(h.audit.entries.some((e) => JSON.stringify(e).includes(down))).toBe(false);
    // 창을 보지 못했으므로 하위 결제사 판정도 묻지 않았다
    expect(h.pg.calls.map((c) => c.eventId)).not.toContain(down);
  });

  test('[ASVS v5.0.0-2.1.2] 원천을 잇지 않은 조립은 닫힌 쪽(503 onsale-window-unavailable)이다', async () => {
    const h = await harness({ wire: false });
    const op = h.identity.ops('operator');
    const r = await h.post('/v1/ops/commands', op, assign({ eventId: randomUUID(), primaryPg: 'TOSS' }));
    expect(r.statusCode).toBe(503);
    expect(slug(r)).toBe('onsale-window-unavailable');
    expect(await counts(h, op)).toEqual({ commands: 0, audits: 0, settings: 0 });
  });

  test('[ASVS v5.0.0-2.1.2] 판매 설정 읽기는 5초 정각에 503으로 끊고, 4,999ms에는 아직 기다린다(공개 판정 객체, 가짜 타이머)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onsale = new FakeOnsale();
    const eventId = randomUUID();
    onsale.set(eventId, 'HANG');
    const gate = new PgAssignmentGate({ onsale, pgCheck: new FakePgCheck() });
    let settled = false;
    const p = gate.checkPgAssign({ eventId, primaryPg: 'TOSS' }, NOW);
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toMatchObject({ slug: 'onsale-window-unavailable', status: 503 });
  });
});

describe('B360-PG 하위 결제사 판정(ADR-0349 결정 3, B15)', () => {
  test('[ASVS v5.0.0-2.2.3] 하위 결제사가 같으면 422 pg-fallback-same-provider이고 본문 detail은 하위 결제사 이름과 까닭뿐이며 명령이 없다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    h.pg.answers = [{ allowed: false, conflict_sub_provider: 'TOSSPAYMENTS', conflict_reason: 'SAME_PROVIDER', approval_limits: [] }];
    const r = await h.post('/v1/ops/commands', op, assign({ eventId, primaryPg: 'TOSS', fallbackPg: 'PORTONE' }));
    expect(r.statusCode).toBe(422);
    expect(slug(r)).toBe('pg-fallback-same-provider');
    expect(json(r).detail).toBe('TOSSPAYMENTS:SAME_PROVIDER');
    // 회차 ID·결제사 값·채널 같은 다른 값은 싣지 않는다
    expect(r.payload).not.toContain(eventId);
    expect(h.pg.calls).toEqual([{ eventId, primaryPg: 'TOSS', fallbackPg: 'PORTONE' }]);
    expect(await counts(h, op)).toEqual({ commands: 0, audits: 0, settings: 0 });
  });

  test('[ASVS v5.0.0-2.2.3] 판정 실패는 허용으로 읽지 않고 503 pg-check-unavailable이며 명령·설정 사건이 없다(M9)', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    h.pg.answers = ['FAIL'];
    const r = await h.post('/v1/ops/commands', op, assign({ eventId: randomUUID(), primaryPg: 'PORTONE', fallbackPg: 'TOSS' }));
    expect(r.statusCode).toBe(503);
    expect(slug(r)).toBe('pg-check-unavailable');
    expect(await counts(h, op)).toEqual({ commands: 0, audits: 0, settings: 0 });
    // 걸렸는데 하위 결제사 이름이 빈 답(모양이 틀린 답)도 허용이 아니다
    h.pg.answers = [{ allowed: false, conflict_sub_provider: '', conflict_reason: 'SAME_PROVIDER' }];
    const empty = await h.post('/v1/ops/commands', op, assign({ eventId: randomUUID(), primaryPg: 'PORTONE' }));
    expect(empty.statusCode).toBe(503);
    expect(slug(empty)).toBe('pg-check-unavailable');
    expect(await counts(h, op)).toEqual({ commands: 0, audits: 0, settings: 0 });
  });

  test('[ASVS v5.0.0-2.2.3] 판정은 2초 정각에 503으로 끊고 1,999ms에는 아직 기다린다(공개 판정 객체, 가짜 타이머)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pg = new FakePgCheck();
    pg.answers = ['HANG'];
    const gate = new PgAssignmentGate({ onsale: new FakeOnsale(), pgCheck: pg });
    let settled = false;
    const p = gate.checkPgAssign({ eventId: randomUUID(), primaryPg: 'TOSS', fallbackPg: 'PORTONE' }, NOW);
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).rejects.toMatchObject({ slug: 'pg-check-unavailable', status: 503 });
  });

  test('B360-PG ③ 접수 검사를 지났어도 실행 직전에 걸리면 FAILED(사유 그 Problem 이름)이고 설정 사건을 내지 않는다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    // 하위 결제사: 접수 때는 허용, 실행 직전에는 걸림
    const a = randomUUID();
    h.pg.answers = [{ allowed: true, approval_limits: [] }, { allowed: false, conflict_sub_provider: 'NICE', conflict_reason: 'UNCONFIRMED' }];
    const r1 = await h.post('/v1/ops/commands', op, assign({ eventId: a, primaryPg: 'TOSS', fallbackPg: 'PORTONE' }));
    expect(r1.statusCode, r1.payload).toBe(201);
    expect(json(r1)).toMatchObject({ state: 'FAILED', lastError: 'pg-fallback-same-provider' });
    // 온세일 윈도우: 접수 때는 판매 승인 전(404), 실행 직전에는 창 안
    const b = randomUUID();
    h.pg.answers = [{ allowed: true, approval_limits: [] }];
    h.onsale.set(b, undefined, NOW + 5 * MIN);
    const r2 = await h.post('/v1/ops/commands', op, assign({ eventId: b, primaryPg: 'PORTONE' }));
    expect(r2.statusCode, r2.payload).toBe(201);
    expect(json(r2)).toMatchObject({ state: 'FAILED', lastError: 'command-out-of-range' });
    expect(h.store.outboxSettings()).toEqual([]);
  });
});

describe('B360-PG dry-run 예측(ADR-0349 결정 4, B16)', () => {
  test('B360-PG ④ 미리보기는 동시 입장 목표 상한 지금 → 새 값을 정본 식(승인 상한 × 180 ÷ 1.0 × 0.5, 8,000 상한)과 넣은 값·가정으로 보인다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    // 지금 TOSS(초당 40), 새 PORTONE(초당 25): 40 × 180 × 0.5 = 3,600, 25 × 180 × 0.5 = 2,250
    h.pg.answers = [{ allowed: true, current_primary_pg: PROTO_PG.TOSS, approval_limits: [{ pg: PROTO_PG.TOSS, approvals_per_second: 40 }, { pg: PROTO_PG.PORTONE, approvals_per_second: 25 }] }];
    const r = await h.post('/v1/ops/command-dry-runs', op, assign({ eventId, primaryPg: 'PORTONE', fallbackPg: 'TOSS' }));
    expect(r.statusCode, r.payload).toBe(200);
    const d = json(r) as { predicted: { key: string; value: number; formula: string; inputs: Record<string, number>; assumptions: string[] }[]; unavailable: unknown[]; counted: { key: string; value: number }[] };
    const byValue = Object.fromEntries(d.predicted.map((p) => [p.value, p]));
    expect(Object.keys(byValue).map(Number).sort((x, y) => x - y)).toEqual([2_250, 3_600]);
    expect(byValue[3_600]!.inputs).toMatchObject({ pgTps: 40, avgDwellSeconds: 180, paymentRatio: 1, safetyFactor: 0.5, admissionTargetMax: 8_000 });
    expect(byValue[2_250]!.inputs).toMatchObject({ pgTps: 25, avgDwellSeconds: 180, paymentRatio: 1, safetyFactor: 0.5 });
    for (const p of d.predicted) {
      expect(p.formula.length).toBeGreaterThan(0);
      expect(p.assumptions.length).toBeGreaterThan(0);
    }
    expect(d.counted.map((c) => c.value).sort((x, y) => x - y)).toEqual([25, 40]);
    expect(d.unavailable).toEqual([]);
    // 미리보기는 저장하지 않는다
    expect(await counts(h, op)).toEqual({ commands: 0, audits: 0, settings: 0 });
  });

  test('B360-PG ⑤ 상한은 절대 상한 8,000을 넘지 않고(초당 300 → 27,000 대신 8,000), 승인 상한을 받지 못한 쪽은 unavailable이다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    // 지금 PORTONE(값 없음), 새 TOSS(초당 300)
    h.pg.answers = [{ allowed: true, current_primary_pg: PROTO_PG.PORTONE, approval_limits: [{ pg: PROTO_PG.TOSS, approvals_per_second: 300 }] }];
    const r = await h.post('/v1/ops/command-dry-runs', op, assign({ eventId: randomUUID(), primaryPg: 'TOSS' }));
    expect(r.statusCode, r.payload).toBe(200);
    const d = json(r) as { predicted: { value: number }[]; unavailable: { key: string; reason: string }[] };
    expect(d.predicted.map((p) => p.value)).toEqual([8_000]);
    // 지금 결제사 상한과 그 예측 둘 다 '세지 못함'으로 남는다(0으로 읽지 않는다)
    expect(d.unavailable.length).toBeGreaterThanOrEqual(2);
    expect(d.unavailable.every((u) => u.reason.length > 0)).toBe(true);
    // 승인 상한이 하나도 없으면 예측이 없고 모두 unavailable이다
    h.pg.answers = [{ allowed: true, current_primary_pg: PROTO_PG.TOSS, approval_limits: [] }];
    const none = json(await h.post('/v1/ops/command-dry-runs', op, assign({ eventId: randomUUID(), primaryPg: 'PORTONE' }))) as { predicted: unknown[]; unavailable: unknown[] };
    expect(none.predicted).toEqual([]);
    expect(none.unavailable.length).toBe(4);
  });
});

describe('B360-PG 실행과 설정 사건(ADR-0349 결정 5, B17)', () => {
  test('B360-PG ⑥ 실행은 ACKED와 같은 쓰기의 control.settings 사건 하나(키 <회차>:PG_ASSIGNMENT:, 값 PgAssignmentValue)를 남기고, 받는 쪽 해독기가 그대로 읽는다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    h.clock.advance(1_234);
    const r = await h.post('/v1/ops/commands', op, assign({ eventId, primaryPg: 'PORTONE', fallbackPg: 'TOSS' }));
    expect(r.statusCode, r.payload).toBe(201);
    const commandId = json(r).commandId as string;
    expect(json(r).state).toBe('ACKED');
    const rows = h.store.outboxSettings();
    expect(rows).toHaveLength(1);
    const m = rows[0]!.message;
    expect(m.topic).toBe('control.settings');
    expect(m.key).toBe(`${eventId}:PG_ASSIGNMENT:`);
    const decoded = controlEventCodec.setting(Buffer.from(m.payload));
    expect(decoded).toMatchObject({ commandId, key: 'PG_ASSIGNMENT', scope: eventId, value: { primaryPg: 'PORTONE', fallbackPg: 'TOSS' }, occurredAt: NOW + 1_234, expiresAt: null });
    // actor는 명령 기록의 가명 참조이고 관리 계정 ID가 아니다(asyncapi actor)
    expect(decoded.actor).toBe(h.store.requesterRefOf(commandId));
    expect(decoded.actor).not.toBe(op['x-user-id']);
    expect(Buffer.from(m.payload).toString('utf8')).not.toContain(op['x-user-id']);
    // 명령 사건 차례에 ACKED가 있고 실행기 없이 끝났다
    expect(h.store.eventsOf(commandId).map((e) => e.type)).toContain('ACKED');
  });

  test('B360-PG ⑦ 대체가 없는 지정의 설정 값에는 대체 칸이 없거나 null이다', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    const r = await h.post('/v1/ops/commands', op, assign({ eventId, primaryPg: 'TOSS' }));
    expect(r.statusCode, r.payload).toBe(201);
    const decoded = controlEventCodec.setting(Buffer.from(h.store.outboxSettings()[0]!.message.payload));
    const value = decoded.value as Record<string, unknown>;
    expect(value.primaryPg).toBe('TOSS');
    expect(value.fallbackPg ?? null).toBeNull();
  });
});
