// 명령 12 사전 판정 gRPC CheckEventPgAssignment의 받는 쪽(BAT-360 리뷰 RV-02, ADR-0349 결정 1·3·4, docs/api/proto/peaket/payment/v1/payment.proto,
// docs/features/payment.md §2.2 '하위 결제사 검사의 첫 구현')과 승인 상한 설정 PEAKET_PG_APPROVAL_TPS 읽기.
// 정본 값: 판정은 AssignEventPg와 같은 규칙(토스페이먼츠와 같은 결제사 TOSSPAYMENTS·TOSS_BRANDPAY, 확인 전 TOSSPAY·TOSSPAY_V2, 토스·포트원 짝이면
// 어느 쪽이 기본이든, 같은 결제사가 확인 전보다 먼저)이고 아무것도 쓰지 않는다. 명령 12의 결제사는 TOSS·PORTONE뿐이고 기본과 대체가 같으면 입력 오류다(결정 1).
// 응답은 허용 여부·걸린 하위 결제사와 까닭(SAME_PROVIDER·UNCONFIRMED)·지금 지정·결제사별 승인 상한(설정에 있는 것만, 없으면 빈 목록, 결정 4)이다.
// 실제 grpc-js 서버를 루프백에 띄우고 계약 설명자로 만든 클라이언트로 부른다(payment-grpc.test.ts와 같은 꼴). 판정 규칙은 진짜이고, 회차 지정 읽기만 포트 짝 가짜다.
import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, test } from 'vitest';
import { loadPgApprovalTps } from '../src/config.js';
import { CheckEventPgAssignment } from '../src/modules/payment/application/check-event-pg-assignment.js';
import type { PgName } from '../src/modules/payment/domain/payment-gateway.js';
import type { PgSelectionState } from '../src/modules/payment/domain/pg-selection.js';
import { type PortoneChannelMap, portoneChannelMapOf } from '../src/modules/payment/domain/pg-sub-provider.js';
import type { CallBudget, EventPgAssignmentStore, EventPgAssignmentWrite, PgSelectionReader } from '../src/modules/payment/domain/ports.js';
import { checkEventPgAssignmentInputOf, paymentPackage, paymentServiceHandlers } from '../src/modules/payment/inbound/payment.grpc.js';
import { startGrpcServer } from '../src/grpc-server.js';

type Message = Record<string, unknown>;
type Cb = (e: grpc.ServiceError | null, v?: Message) => void;
type Client = grpc.Client & { CheckEventPgAssignment: (req: Message, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb) => void };

const EVENT = '0195f3a0-0000-7000-8000-0000000b3601';
/** 승인 상한 시험 값(정본 추정 토스 300·포트원 50과 다르게 고른다) */
const TPS = new Map<PgName, number>([
  ['TOSS', 280],
  ['PORTONE', 47.5],
]);
const single = (provider: string): PortoneChannelMap => portoneChannelMapOf({ channelKey: 'ch-b360' }, { 'ch-b360': provider });

/** 회차 지정 읽기 짝 가짜. 쓰기 면(EventPgAssignmentStore)도 갖추어, 판정이 쓰지 않음을 호출 수로 본다 */
class FakeSelection implements PgSelectionReader, EventPgAssignmentStore {
  readonly reads: string[] = [];
  readonly writes: EventPgAssignmentWrite[] = [];
  fail: Error | undefined;
  constructor(private readonly state: PgSelectionState = {}) {}
  async read(eventId: string, _budget?: CallBudget): Promise<PgSelectionState> {
    this.reads.push(eventId);
    if (this.fail) throw this.fail;
    return this.state;
  }
  async assignEvent(w: EventPgAssignmentWrite): Promise<boolean> {
    this.writes.push(w);
    return true;
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function serve(o: { selection: FakeSelection; portone?: PortoneChannelMap; approvalTps?: ReadonlyMap<PgName, number> }) {
  const errors: [string, unknown][] = [];
  const useCase = new CheckEventPgAssignment({ selection: o.selection, ...(o.portone ? { portone: o.portone } : {}), approvalTps: o.approvalTps ?? TPS });
  const handlers = paymentServiceHandlers(
    {
      accept: { execute: async () => Promise.reject(new Error('부르지 않는다')) },
      batchGet: { execute: async () => [] },
      checkEventPgAssignment: useCase,
    },
    (method, err) => errors.push([method, err]),
  );
  const server = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: paymentPackage().PaymentService.service, handlers }] });
  // type-escape: grpc-js 동적 클라이언트는 메서드 타입이 없다(payment-grpc.test.ts와 같은 꼴) BAT-360
  const client = new (paymentPackage().PaymentService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  closers.push(async () => {
    client.close();
    await server.close();
  });
  const call = (req: Message) => new Promise<Message>((res, rej) => client.CheckEventPgAssignment(req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
  const failure = async (req: Message): Promise<string> => {
    try {
      await call(req);
    } catch (e) {
      return grpc.status[(e as grpc.ServiceError).code]!;
    }
    return 'OK';
  };
  return { call, failure, errors };
}

describe('B360-PAY CheckEventPgAssignment 판정(ADR-0349 결정 3)', () => {
  test('B360-PAY ① 토스 기본·포트원 대체에 TOSSPAYMENTS 채널이면 걸림(SAME_PROVIDER)이고, 지금 지정과 결제사별 승인 상한(이름 차례)을 싣고 아무것도 쓰지 않는다', async () => {
    const selection = new FakeSelection({ assignment: { primary: 'PORTONE', fallback: 'TOSS' } });
    const s = await serve({ selection, portone: single('TOSSPAYMENTS') });
    const r = await s.call({ event_id: EVENT, primary_pg: 'PG_PROVIDER_TOSS', fallback_pg: 'PG_PROVIDER_PORTONE' });
    expect(r).toEqual({
      allowed: false,
      conflict_sub_provider: 'TOSSPAYMENTS',
      conflict_reason: 'SAME_PROVIDER',
      current_primary_pg: 'PG_PROVIDER_PORTONE',
      current_fallback_pg: 'PG_PROVIDER_TOSS',
      approval_limits: [
        { pg: 'PG_PROVIDER_PORTONE', approvals_per_second: 47.5 },
        { pg: 'PG_PROVIDER_TOSS', approvals_per_second: 280 },
      ],
    });
    expect(selection.reads).toEqual([EVENT]);
    expect(selection.writes).toEqual([]);
  });

  test('B360-PAY ② 확인 전 하위 결제사(TOSSPAY·TOSSPAY_V2)는 UNCONFIRMED, 반대 방향(포트원 기본·토스 대체)도 걸리고, 브랜드페이는 같은 결제사다', async () => {
    const cases: [string, Message, string, string][] = [
      ['TOSSPAY', { primary_pg: 'PG_PROVIDER_TOSS', fallback_pg: 'PG_PROVIDER_PORTONE' }, 'TOSSPAY', 'UNCONFIRMED'],
      ['TOSSPAY_V2', { primary_pg: 'PG_PROVIDER_TOSS', fallback_pg: 'PG_PROVIDER_PORTONE' }, 'TOSSPAY_V2', 'UNCONFIRMED'],
      ['TOSS_BRANDPAY', { primary_pg: 'PG_PROVIDER_PORTONE', fallback_pg: 'PG_PROVIDER_TOSS' }, 'TOSS_BRANDPAY', 'SAME_PROVIDER'],
    ];
    for (const [channel, pgs, provider, reason] of cases) {
      const s = await serve({ selection: new FakeSelection(), portone: single(channel) });
      expect(await s.call({ event_id: EVENT, ...pgs })).toMatchObject({ allowed: false, conflict_sub_provider: provider, conflict_reason: reason });
    }
  });

  test('B360-PAY ③ 걸리지 않는 채널·대체 없음(UNSPECIFIED)은 허용이고 까닭 칸은 빈 글, 지정이 없으면 지금 지정 칸은 UNSPECIFIED, 승인 상한 설정이 없으면 빈 목록이다', async () => {
    const none = await serve({ selection: new FakeSelection(), portone: single('KCP_V2'), approvalTps: new Map() });
    expect(await none.call({ event_id: EVENT, primary_pg: 'PG_PROVIDER_TOSS', fallback_pg: 'PG_PROVIDER_PORTONE' })).toEqual({
      allowed: true,
      conflict_sub_provider: '',
      conflict_reason: '',
      current_primary_pg: 'PG_PROVIDER_UNSPECIFIED',
      current_fallback_pg: 'PG_PROVIDER_UNSPECIFIED',
      approval_limits: [],
    });
    // 대체가 없으면 하위 결제사가 같아도 걸리지 않는다
    const solo = await serve({ selection: new FakeSelection({ assignment: { primary: 'TOSS' } }), portone: single('TOSSPAYMENTS') });
    expect(await solo.call({ event_id: EVENT, primary_pg: 'PG_PROVIDER_TOSS', fallback_pg: 'PG_PROVIDER_UNSPECIFIED' })).toMatchObject({
      allowed: true,
      current_primary_pg: 'PG_PROVIDER_TOSS',
      current_fallback_pg: 'PG_PROVIDER_UNSPECIFIED',
    });
  });

  test('B360-PAY ④ 시뮬레이터·기본과 같은 대체·기본 없음·소문자 UUID가 아닌 회차는 INVALID_ARGUMENT이고 지정을 읽지도 쓰지도 않는다', async () => {
    const selection = new FakeSelection();
    const s = await serve({ selection, portone: single('KCP_V2') });
    const bad: Message[] = [
      { event_id: EVENT, primary_pg: 'PG_PROVIDER_SIMULATOR' },
      { event_id: EVENT, primary_pg: 'PG_PROVIDER_TOSS', fallback_pg: 'PG_PROVIDER_SIMULATOR' },
      { event_id: EVENT, primary_pg: 'PG_PROVIDER_PORTONE', fallback_pg: 'PG_PROVIDER_PORTONE' },
      { event_id: EVENT, primary_pg: 'PG_PROVIDER_UNSPECIFIED' },
      { event_id: EVENT },
      { event_id: EVENT.toUpperCase(), primary_pg: 'PG_PROVIDER_TOSS' },
      { event_id: 'not-a-uuid', primary_pg: 'PG_PROVIDER_TOSS' },
    ];
    for (const req of bad) expect(await s.failure(req), JSON.stringify(req)).toBe('INVALID_ARGUMENT');
    expect(selection.reads).toEqual([]);
    expect(selection.writes).toEqual([]);
    expect(s.errors).toEqual([]);
  });

  test('B360-PAY ⑤ 지정을 읽지 못하면 허용으로 답하지 않고 UNAVAILABLE이다(부르는 쪽 ops-svc가 503 pg-check-unavailable로 닫는다)', async () => {
    const selection = new FakeSelection();
    selection.fail = Object.assign(new Error('connection terminated'), { code: '57P01' });
    const s = await serve({ selection, portone: single('KCP_V2') });
    expect(await s.failure({ event_id: EVENT, primary_pg: 'PG_PROVIDER_TOSS', fallback_pg: 'PG_PROVIDER_PORTONE' })).toBe('UNAVAILABLE');
    expect(s.errors.map(([m]) => m)).toEqual(['CheckEventPgAssignment']);
  });

  test('B360-PAY ⑥ proto 결제사 이름은 앞머리 PG_PROVIDER_를 떼고, 대체 UNSPECIFIED·빈 칸은 대체 없음이며 기본이 비면 UNSPECIFIED로 둔다', () => {
    expect(checkEventPgAssignmentInputOf({ event_id: EVENT, primary_pg: 'PG_PROVIDER_PORTONE', fallback_pg: 'PG_PROVIDER_TOSS' })).toEqual({ eventId: EVENT, primary: 'PORTONE', fallback: 'TOSS' });
    expect(checkEventPgAssignmentInputOf({ event_id: EVENT, primary_pg: 'PG_PROVIDER_TOSS', fallback_pg: 'PG_PROVIDER_UNSPECIFIED' })).toEqual({ eventId: EVENT, primary: 'TOSS' });
    expect(checkEventPgAssignmentInputOf({ event_id: EVENT, primary_pg: 'PG_PROVIDER_TOSS' })).toEqual({ eventId: EVENT, primary: 'TOSS' });
    expect(checkEventPgAssignmentInputOf({ event_id: EVENT })).toEqual({ eventId: EVENT, primary: 'UNSPECIFIED' });
  });
});

describe('B360-PAY 결제사별 승인 상한 설정(PEAKET_PG_APPROVAL_TPS, ADR-0349 결정 4)', () => {
  test('B360-PAY ⑦ 없거나 빈 값이면 빈 표, TOSS·PORTONE 양의 수는 그대로 읽는다', () => {
    expect([...loadPgApprovalTps({})]).toEqual([]);
    expect([...loadPgApprovalTps({ PEAKET_PG_APPROVAL_TPS: '  ' })]).toEqual([]);
    expect([...loadPgApprovalTps({ PEAKET_PG_APPROVAL_TPS: '{"TOSS":280,"PORTONE":47.5}' })]).toEqual([
      ['TOSS', 280],
      ['PORTONE', 47.5],
    ]);
    expect([...loadPgApprovalTps({ PEAKET_PG_APPROVAL_TPS: '{"PORTONE":12}' })]).toEqual([['PORTONE', 12]]);
  });

  test.each([
    ['JSON 아님', 'TOSS=280'],
    ['배열', '[280]'],
    ['null', 'null'],
    ['모르는 결제사', '{"SIMULATOR":10}'],
    ['소문자 이름', '{"toss":10}'],
    ['0', '{"TOSS":0}'],
    ['음수', '{"TOSS":-1}'],
    ['글자 값', '{"TOSS":"280"}'],
  ])('B360-PAY ⑧ 꼴이 틀리면(%s) 시작하지 않고 오류 글에 값을 싣지 않는다', (_why, raw) => {
    let err: unknown;
    try {
      loadPgApprovalTps({ PEAKET_PG_APPROVAL_TPS: raw });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^PEAKET_PG_APPROVAL_TPS/);
    if (raw.length > 4) expect((err as Error).message).not.toContain(raw);
  });
});
