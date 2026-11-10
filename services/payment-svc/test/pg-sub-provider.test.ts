// 포트원 채널의 하위 결제사 검사(domain/pg-sub-provider.ts, config loadPortoneChannelMap, 포트원 어댑터의 채널 알림, 선택기의 대체 후보 빼기, BUILD_ORDER PRF-203).
// 정본: docs/features/payment.md §2.2 '대체 채널의 하위 결제사'·'하위 결제사 검사의 첫 구현'·P-T46.
// 실제 PostgreSQL·시뮬레이터로 지정 거절·관측·전환을 잇는 것은 test-int/payment-sub-provider.int.test.ts가 본다.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type FakeClock, fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { loadPortoneChannelMap, loadPortoneGatewayConfig } from '../src/config.js';
import { StaticPaymentGateways } from '../src/modules/payment/adapters/pg/payment-gateways.js';
import { PortoneGateway } from '../src/modules/payment/adapters/pg/portone-gateway.js';
import { TossPaymentGateway } from '../src/modules/payment/adapters/pg/toss-gateway.js';
import { AssignEventPg } from '../src/modules/payment/application/assign-event-pg.js';
import { CachedPgChannelObservations, PG_CHANNEL_OBSERVED_MAX_STALE_MS, PortoneFallbackExclusions } from '../src/modules/payment/application/pg-channel-observations.js';
import { PrepareCheckout } from '../src/modules/payment/application/prepare-checkout.js';
import { PaymentInputError } from '../src/modules/payment/domain/confirm-command.js';
import { PAY_METHODS, type PayMethod } from '../src/modules/payment/domain/payment-gateway.js';
import { channelTableOf, type PgChannel, type PgPlatformDefaults, type PgSelectionState, selectPg } from '../src/modules/payment/domain/pg-selection.js';
import {
  assertPlatformSubProviders,
  excludedFallbackMethods,
  PgFallbackSameProviderError,
  PORTONE_PG_PROVIDERS,
  type PortoneChannelMap,
  portoneChannelMapOf,
  subProviderConflict,
} from '../src/modules/payment/domain/pg-sub-provider.js';
import type { EventPgAssignmentStore, EventPgAssignmentWrite, FallbackExclusionReader } from '../src/modules/payment/domain/ports.js';

const official = JSON.parse(readFileSync(new URL('./fixtures/portone/pg-provider-enum.json', import.meta.url), 'utf8')) as { _provenance: string; pgProvider: string[]; selectedChannelRequired: string[] };
const EVENT = '0195f3a0-0000-7000-8000-00000000e001';

const single = (provider: string): PortoneChannelMap => portoneChannelMapOf({ channelKey: 'ch-one' }, { 'ch-one': provider });
const byMethod = (providers: Record<string, string>): PortoneChannelMap => portoneChannelMapOf({ channelKey: 'ch-card', channelKeys: { CARD: 'ch-card', EASY_PAY: 'ch-easy' } }, providers);

const PORTONE_ENV = {
  PEAKET_ENV: 'staging',
  PEAKET_PG_PORTONE_SECRET: 'portone-secret-value',
  PEAKET_PG_PORTONE_STORE_ID: 'store-1',
  PEAKET_PG_PORTONE_CHANNEL_KEY: 'ch-one',
  PEAKET_PG_PORTONE_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
};

describe('하위 결제사 값 목록', () => {
  test('P-T46 하위 결제사 값 목록이 공식 스키마 사본(v2.openapi.json 1.16.0의 PgProvider)과 같다', () => {
    expect(official._provenance).toContain('1.16.0');
    expect([...PORTONE_PG_PROVIDERS]).toEqual(official.pgProvider);
    for (const name of ['TOSSPAYMENTS', 'TOSS_BRANDPAY', 'TOSSPAY', 'TOSSPAY_V2', 'KCP_V2']) expect(PORTONE_PG_PROVIDERS).toContain(name);
    // 답의 channel.key는 필수 칸이 아니다(대조가 키 없는 답을 다룬다)
    expect(official.selectedChannelRequired).toEqual(['type', 'pgProvider', 'pgMerchantId']);
  });
});

describe('규칙(subProviderConflict)', () => {
  test('P-T46 ① 기본 토스페이먼츠의 대체로 하위 결제사가 TOSSPAYMENTS인 포트원 채널은 같은 결제사다', () => {
    expect(subProviderConflict('TOSS', 'PORTONE', single('TOSSPAYMENTS'))).toEqual({ provider: 'TOSSPAYMENTS', reason: 'SAME_PROVIDER' });
  });

  test('P-T46 ② 브랜드페이는 같은 결제사이고 토스페이·토스페이 V2는 확인 전이라 둘 다 걸린다', () => {
    expect(subProviderConflict('TOSS', 'PORTONE', single('TOSS_BRANDPAY'))).toEqual({ provider: 'TOSS_BRANDPAY', reason: 'SAME_PROVIDER' });
    expect(subProviderConflict('TOSS', 'PORTONE', single('TOSSPAY'))).toEqual({ provider: 'TOSSPAY', reason: 'UNCONFIRMED' });
    expect(subProviderConflict('TOSS', 'PORTONE', single('TOSSPAY_V2'))).toEqual({ provider: 'TOSSPAY_V2', reason: 'UNCONFIRMED' });
  });

  test('P-T46 ① 반대 방향(기본 포트원 토스 계열 채널, 대체 토스페이먼츠)도 걸린다', () => {
    expect(subProviderConflict('PORTONE', 'TOSS', single('TOSSPAYMENTS'))).toEqual({ provider: 'TOSSPAYMENTS', reason: 'SAME_PROVIDER' });
    expect(subProviderConflict('PORTONE', 'TOSS', single('TOSSPAY'))).toEqual({ provider: 'TOSSPAY', reason: 'UNCONFIRMED' });
  });

  test('P-T46 ⑤ 하위 결제사가 다른 채널, 대체가 없는 지정, 토스·포트원 짝이 아닌 지정은 걸리지 않는다', () => {
    expect(subProviderConflict('TOSS', 'PORTONE', single('KCP_V2'))).toBeUndefined();
    expect(subProviderConflict('TOSS', undefined, single('TOSSPAYMENTS'))).toBeUndefined();
    expect(subProviderConflict('SIMULATOR', 'PORTONE', single('TOSSPAYMENTS'))).toBeUndefined();
    expect(subProviderConflict('TOSS', 'PORTONE', undefined)).toBeUndefined();
  });

  test('P-T46 ② 수단별 채널 가운데 하나라도 걸리면 걸리고, 같은 결제사가 확인 전보다 먼저 보고된다', () => {
    expect(subProviderConflict('TOSS', 'PORTONE', byMethod({ 'ch-card': 'KCP_V2', 'ch-easy': 'TOSSPAY' }))).toEqual({ provider: 'TOSSPAY', reason: 'UNCONFIRMED' });
    expect(subProviderConflict('TOSS', 'PORTONE', byMethod({ 'ch-card': 'TOSSPAY', 'ch-easy': 'TOSSPAYMENTS' }))).toEqual({ provider: 'TOSSPAYMENTS', reason: 'SAME_PROVIDER' });
  });

  test('P-T46 값이 없는 채널은 규칙이 보지 못한다(local·ci뿐)', () => {
    expect(subProviderConflict('TOSS', 'PORTONE', portoneChannelMapOf({ channelKey: 'ch-one' }, undefined))).toBeUndefined();
  });
});

describe('회차 지정 쓰임새(AssignEventPg)', () => {
  class FakeStore implements EventPgAssignmentStore {
    readonly writes: EventPgAssignmentWrite[] = [];
    async assignEvent(w: EventPgAssignmentWrite): Promise<boolean> {
      this.writes.push(w);
      return true;
    }
  }

  test('P-T46 ① 걸린 지정은 이름 붙은 오류 pg-fallback-same-provider(422)로 거절하고 저장소를 부르지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const store = new FakeStore();
    const use = new AssignEventPg({ store, portone: single('TOSSPAYMENTS') });
    const err = await use.execute({ eventId: EVENT, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PgFallbackSameProviderError);
    expect(err).toMatchObject({ code: 'FAILED_PRECONDITION', problem: 'pg-fallback-same-provider', status: 422, message: 'pg-fallback-same-provider', conflict: { provider: 'TOSSPAYMENTS', reason: 'SAME_PROVIDER' } });
    expect(store.writes).toEqual([]);
  });

  test('P-T46 ⑤ 걸리지 않는 지정은 그대로 쓴다', async () => {
    const store = new FakeStore();
    await expect(new AssignEventPg({ store, portone: single('KCP_V2') }).execute({ eventId: EVENT, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: 7 })).resolves.toEqual({ written: true });
    expect(store.writes).toEqual([{ eventId: EVENT, primary: 'TOSS', fallback: 'PORTONE', updatedAtMs: 7 }]);
  });

  test.each([
    ['event_id', { eventId: 'NOT-A-UUID', primary: 'TOSS' }],
    ['primary', { eventId: EVENT, primary: 'KAKAO' }],
    ['fallback', { eventId: EVENT, primary: 'TOSS', fallback: 'KAKAO' }],
    ['fallback', { eventId: EVENT, primary: 'TOSS', fallback: 'TOSS' }],
    ['updated_at', { eventId: EVENT, primary: 'TOSS', updatedAtMs: Number.NaN }],
  ])('P-T46 입력이 틀리면(%s) 쓰지 않는다', async (field, input) => {
    const store = new FakeStore();
    const err = await new AssignEventPg({ store }).execute({ updatedAtMs: 1, ...input }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentInputError);
    expect((err as PaymentInputError).field).toBe(field);
    expect(store.writes).toEqual([]);
  });
});

describe('시작 설정(loadPortoneChannelMap·assertPlatformSubProviders)', () => {
  const env = (over: Record<string, string | undefined>) => ({ ...PORTONE_ENV, ...over });
  const mapOf = (e: Record<string, string | undefined>) => loadPortoneChannelMap(e, loadPortoneGatewayConfig(e));

  test('P-T46 ③ 플랫폼 기본값(기본 토스·대체 포트원)에 하위 결제사가 TOSSPAYMENTS인 채널을 넣으면 시작을 멈춘다 [ASVS v5.0.0-16.5.3]', () => {
    const map = mapOf(env({ PEAKET_PG_PORTONE_CHANNEL_PROVIDERS: JSON.stringify({ 'ch-one': 'TOSSPAYMENTS' }) }));
    expect(() => assertPlatformSubProviders({ primary: 'TOSS', fallback: 'PORTONE' }, map)).toThrow(/pg-fallback-same-provider.*TOSSPAYMENTS/);
  });

  test.each(['TOSS_BRANDPAY', 'TOSSPAY', 'TOSSPAY_V2'])('P-T46 ③ 하위 결제사 %s도 시작을 멈춘다', (provider) => {
    const map = mapOf(env({ PEAKET_PG_PORTONE_CHANNEL_PROVIDERS: JSON.stringify({ 'ch-one': provider }) }));
    expect(() => assertPlatformSubProviders({ primary: 'TOSS', fallback: 'PORTONE' }, map)).toThrow(provider);
  });

  test('P-T46 ③ 하위 결제사가 다르거나 대체가 없으면 시작한다', () => {
    const map = mapOf(env({ PEAKET_PG_PORTONE_CHANNEL_PROVIDERS: JSON.stringify({ 'ch-one': 'KCP_V2' }) }));
    expect(() => assertPlatformSubProviders({ primary: 'TOSS', fallback: 'PORTONE' }, map)).not.toThrow();
    const tossy = mapOf(env({ PEAKET_PG_PORTONE_CHANNEL_PROVIDERS: JSON.stringify({ 'ch-one': 'TOSSPAYMENTS' }) }));
    expect(() => assertPlatformSubProviders({ primary: 'TOSS' }, tossy)).not.toThrow();
  });

  test('P-T46 local·ci 밖에서 쓰는 포트원 채널의 하위 결제사 값이 없으면 시작하지 않는다 [ASVS v5.0.0-16.5.3]', () => {
    expect(() => mapOf(env({}))).toThrow(/PEAKET_PG_PORTONE_CHANNEL_PROVIDERS/);
    const keys = { PEAKET_PG_PORTONE_CHANNEL_KEYS: JSON.stringify({ CARD: 'ch-card', EASY_PAY: 'ch-easy' }) };
    expect(() => mapOf(env({ ...keys, PEAKET_PG_PORTONE_CHANNEL_PROVIDERS: JSON.stringify({ 'ch-card': 'KCP_V2' }) }))).toThrow(/PEAKET_PG_PORTONE_CHANNEL_PROVIDERS/);
    const map = mapOf(env({ ...keys, PEAKET_PG_PORTONE_CHANNEL_PROVIDERS: JSON.stringify({ 'ch-card': 'KCP_V2', 'ch-easy': 'NICE_V2' }) }));
    expect(map?.providers).toEqual(new Map([['ch-card', 'KCP_V2'], ['ch-easy', 'NICE_V2']]));
    expect(map?.byMethod).toEqual(new Map<PayMethod, string>([['CARD', 'ch-card'], ['EASY_PAY', 'ch-easy']]));
  });

  test('P-T46 local·ci는 값이 없어도 시작하고 규칙은 그 채널을 보지 않는다', () => {
    const map = mapOf(env({ PEAKET_ENV: 'local' }));
    expect(map?.providers).toEqual(new Map());
    expect(map?.byMethod).toEqual(new Map(PAY_METHODS.map((m) => [m, 'ch-one'])));
  });

  test.each([
    ['JSON이 아님', '{ch-one: KCP_V2'],
    ['배열', '["KCP_V2"]'],
    ['공식 목록 밖의 값', JSON.stringify({ 'ch-one': 'TOSS' })],
    ['쓰지 않는 채널 키', JSON.stringify({ 'ch-one': 'KCP_V2', 'ch-typo': 'KCP_V2' })],
    ['빈 값', JSON.stringify({ 'ch-one': '' })],
  ])('P-T46 하위 결제사 설정이 틀리면(%s) 시작하지 않고 글에 값을 싣지 않는다', (_what, raw) => {
    let message = '';
    try {
      mapOf(env({ PEAKET_ENV: 'local', PEAKET_PG_PORTONE_CHANNEL_PROVIDERS: raw }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('PEAKET_PG_PORTONE_CHANNEL_PROVIDERS');
    expect(message).not.toContain('ch-typo');
    expect(message).not.toContain(PORTONE_ENV.PEAKET_PG_PORTONE_SECRET);
  });

  test('P-T46 포트원 설정이 없는데 하위 결제사 설정만 있으면 시작하지 않는다', () => {
    expect(() => loadPortoneChannelMap({ PEAKET_ENV: 'local', PEAKET_PG_PORTONE_CHANNEL_PROVIDERS: '{}' }, undefined)).toThrow(/PEAKET_PG_PORTONE_CHANNEL_PROVIDERS/);
    expect(loadPortoneChannelMap({ PEAKET_ENV: 'local' }, undefined)).toBeUndefined();
  });
});

describe('응답 대조와 대체 후보 빼기', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/portone/official-schema-responses.json', import.meta.url), 'utf8')) as Record<string, { status: number; body: Record<string, unknown> }>;
  const ORDER_ID = '0195f3a0-0000-7000-8000-00000000a001';
  const PAYMENT_ID = `pay-${ORDER_ID}`;

  function gateway(bodies: { status: number; body: unknown }[], seen: unknown[]) {
    const queue = [...bodies];
    const fetchStub: typeof fetch = async () => {
      const next = queue.shift()!;
      return new Response(JSON.stringify(next.body), { status: next.status });
    };
    return new PortoneGateway({ baseUrl: 'http://pg.test', secret: `portone_${randomBytes(8).toString('hex')}`, storeId: 'store-fixture', channelKey: 'channel-fixture', webhookSecrets: [`whsec_${randomBytes(32).toString('base64')}`], isTest: true, fetch: fetchStub, onChannel: (c) => seen.push(c) });
  }

  test('P-T46 ④ 포트원 어댑터가 승인 뒤 조회와 단독 조회 답의 channel(키·하위 결제사)을 알리고 결제 답은 그대로다', async () => {
    const seen: unknown[] = [];
    const paid = fixtures.paidCard!;
    const g = gateway([fixtures.confirmPaid!, paid, paid], seen);
    await expect(g.confirm({ orderId: ORDER_ID, paymentRef: PAYMENT_ID, amount: 10_000, idemKey: `confirm-${ORDER_ID}`, confirmToken: 'token-fixture' })).resolves.toMatchObject({ outcome: 'APPROVED' });
    await expect(g.query(PAYMENT_ID)).resolves.toMatchObject({ kind: 'FOUND', status: 'APPROVED' });
    expect(seen).toEqual([
      { key: 'channel-key-fixture', pgProvider: 'KCP_V2' },
      { key: 'channel-key-fixture', pgProvider: 'KCP_V2' },
    ]);
  });

  test('P-T46 ④ 채널 키가 없는 답은 하위 결제사만 알리고, 채널이 없거나 다른 결제의 답이면 알리지 않는다', async () => {
    const seen: unknown[] = [];
    const paid = fixtures.paidCard!;
    const noKey = { status: 200, body: { ...paid.body, channel: { type: 'LIVE', pgProvider: 'TOSSPAYMENTS', pgMerchantId: 'm' } } };
    const noChannel = { status: 200, body: { ...paid.body, channel: undefined } };
    const other = { status: 200, body: { ...paid.body, id: 'pay-other' } };
    const g = gateway([noKey, noChannel, other], seen);
    await g.query(PAYMENT_ID);
    await g.query(PAYMENT_ID);
    await g.query(PAYMENT_ID);
    expect(seen).toEqual([{ pgProvider: 'TOSSPAYMENTS' }]);
  });

  test('P-T46 ④ 관측 값이 설정과 다른 채널의 수단만 대체 후보에서 뺀다(같으면 빼지 않는다)', () => {
    const map = byMethod({ 'ch-card': 'KCP_V2', 'ch-easy': 'NICE_V2' });
    expect(excludedFallbackMethods(map, new Map([['ch-card', 'TOSSPAYMENTS']]), 'TOSS')).toEqual(new Set(['CARD']));
    expect(excludedFallbackMethods(map, new Map([['ch-card', 'KCP_V2']]), 'TOSS')).toEqual(new Set());
    expect(excludedFallbackMethods(map, new Map([['ch-unknown', 'TOSSPAYMENTS']]), 'TOSS')).toEqual(new Set());
    // 설정 값이 없는 채널(local·ci)은 관측 불일치로는 빼지 않고, 관측 값이 기준 결제사와 규칙에 걸릴 때만 뺀다(코드 리뷰 F1)
    const local = portoneChannelMapOf({ channelKey: 'ch-one' }, undefined);
    expect(excludedFallbackMethods(local, new Map([['ch-one', 'KCP_V2']]), 'TOSS')).toEqual(new Set());
    expect(excludedFallbackMethods(local, new Map(), 'TOSS')).toEqual(new Set());
    expect(excludedFallbackMethods(local, new Map([['ch-one', 'TOSSPAYMENTS']]), 'TOSS')).toEqual(new Set(PAY_METHODS));
  });

  test('P-T46 ④ 전환이 고른 대체가 그 수단에서 빠졌으면 기준 결제사로 가고, 다른 수단·고정 재생·기본 결제사는 그대로다', () => {
    const ON: PgChannel = { active: true, payMethods: new Set(PAY_METHODS) };
    const channels = new Map([
      ['TOSS', ON],
      ['PORTONE', ON],
    ] as const);
    const base = {
      defaults: { primary: 'TOSS', fallback: 'PORTONE' } as const,
      channels,
      eventSwitch: { scope: EVENT, active: true, fromPg: 'TOSS' as const, version: 1, changedAtMs: 1 },
      fallbackExcluded: new Map([['PORTONE', new Set<PayMethod>(['CARD'])]] as const),
    };
    expect(selectPg({ ...base, payMethod: 'CARD' })).toMatchObject({ kind: 'SELECTED', pg: 'TOSS', switched: false });
    expect(selectPg({ ...base, payMethod: 'EASY_PAY' })).toMatchObject({ kind: 'SELECTED', pg: 'PORTONE', switched: true });
    expect(selectPg({ ...base, payMethod: 'CARD', pinnedPg: 'PORTONE' })).toMatchObject({ kind: 'SELECTED', pg: 'PORTONE', switched: true });
    expect(selectPg({ ...base, eventSwitch: undefined, assignment: { primary: 'PORTONE', fallback: 'TOSS' }, payMethod: 'CARD' })).toMatchObject({ kind: 'SELECTED', pg: 'PORTONE', switched: false });
  });
});

describe('대체 후보 빼기의 하위 결제사 규칙(코드 리뷰 F1)', () => {
  const ORDER = '0195f3a0-0000-7000-8000-00000000b001';
  const ATTEMPT = '0195f3a0-0000-7000-8000-00000000b002';
  const SW = { scope: 'PLATFORM', active: true, version: 1, changedAtMs: 1 } as const;

  /** 결제창 준비 한 벌(저장소는 대역, 어댑터는 실제 값 만들기). exclusions가 관측 표 읽기를 대신한다 */
  function checkout(o: { defaults: PgPlatformDefaults; state: PgSelectionState; exclusions: FallbackExclusionReader; clock?: FakeClock }) {
    const gateways = new StaticPaymentGateways([
      new TossPaymentGateway({ baseUrl: 'http://toss.test', secretKey: 'test_sk_unused_000000', clientKey: 'test_ck_unused_000000' }),
      new PortoneGateway({ baseUrl: 'http://pg.test', secret: `portone_${randomBytes(8).toString('hex')}`, storeId: 'store-unit', channelKey: 'ch-one', webhookSecrets: [`whsec_${randomBytes(32).toString('base64')}`], isTest: true }),
    ]);
    return new PrepareCheckout({
      selection: { read: async () => o.state },
      pauses: { read: async () => new Map() },
      trials: { isAdmitted: async () => false, admit: async () => undefined },
      gateways,
      channels: channelTableOf(gateways),
      defaults: o.defaults,
      webOrigin: 'https://www.unit.example',
      virtualAccountReady: true,
      clock: o.clock ?? fakeClock({ now: Date.parse('2026-11-10T01:00:00.000Z') }),
      log: { pgUnavailable: () => undefined, methodUnsupported: () => undefined },
      signals: { prepared: () => undefined },
      fallbackExclusions: o.exclusions,
    });
  }
  const input = { orderKind: 'TICKET', orderId: ORDER, attemptId: ATTEMPT, eventId: EVENT, amount: 39_000, orderName: '공연 티켓', payMethod: 'CARD' };

  test('P-T46 ④ 관측 값이 없으면 설정 값으로, 있으면 관측 값으로 기준 결제사(토스)와의 규칙을 보고 걸리는 채널의 수단을 뺀다(같은 결제사·확인 전)', () => {
    expect(excludedFallbackMethods(single('TOSSPAYMENTS'), new Map(), 'TOSS')).toEqual(new Set(PAY_METHODS));
    expect(excludedFallbackMethods(single('TOSSPAY'), new Map(), 'TOSS')).toEqual(new Set(PAY_METHODS));
    expect(excludedFallbackMethods(single('KCP_V2'), new Map([['ch-one', 'TOSS_BRANDPAY']]), 'TOSS')).toEqual(new Set(PAY_METHODS));
    expect(excludedFallbackMethods(byMethod({ 'ch-card': 'KCP_V2', 'ch-easy': 'TOSSPAY_V2' }), new Map(), 'TOSS')).toEqual(new Set(['EASY_PAY']));
    // 기준 결제사가 토스가 아니면 규칙은 걸리지 않고, 관측 값이 설정과 다른 채널만 뺀다
    expect(excludedFallbackMethods(single('TOSSPAYMENTS'), new Map(), 'SIMULATOR')).toEqual(new Set());
    expect(excludedFallbackMethods(single('KCP_V2'), new Map([['ch-one', 'NICE_V2']]), 'SIMULATOR')).toEqual(new Set(PAY_METHODS));
  });

  test('P-T46 ④ 설정 값이 처음부터 TOSSPAYMENTS인 채널은 전환이 포트원을 골라도 관측 표가 비어 있으면서도 빠져 기준 결제사로 간다 [ASVS v5.0.0-16.5.3]', async () => {
    const exclusions = new PortoneFallbackExclusions({ portone: single('TOSSPAYMENTS'), observations: { readAll: async () => new Map() } });
    const uc = checkout({ defaults: { primary: 'TOSS', fallback: 'PORTONE' }, state: { assignment: { primary: 'TOSS', fallback: 'PORTONE' }, platformSwitch: { ...SW, fromPg: 'TOSS' } }, exclusions });
    await expect(uc.execute(input)).resolves.toMatchObject({ pg: 'TOSS', switched: false });
  });

  test('P-T46 ④ 관측 표 읽기가 실패하면 나이 10,000ms까지의 마지막 값을 쓰고 10,001ms면 결제창 준비가 실패하며, 마지막 값이 없으면 값을 지어내지 않고 실패한다 [ASVS v5.0.0-16.5.3]', async () => {
    const clock = fakeClock({ now: Date.parse('2026-11-10T01:00:00.000Z') });
    let fail = false;
    const failures: string[] = [];
    const observations = new CachedPgChannelObservations({
      reader: { readAll: async () => (fail ? Promise.reject(new Error('관측 표 읽기 실패')) : new Map([['ch-one', 'KCP_V2']])) },
      clock,
      signals: { channelObservedFailed: (step) => failures.push(step) },
    });
    const exclusions = new PortoneFallbackExclusions({ portone: single('KCP_V2'), observations });
    const uc = checkout({ defaults: { primary: 'TOSS', fallback: 'PORTONE' }, state: { platformSwitch: { ...SW, fromPg: 'TOSS' } }, exclusions, clock });
    await expect(uc.execute(input)).resolves.toMatchObject({ pg: 'PORTONE', switched: true });
    fail = true;
    clock.advance(PG_CHANNEL_OBSERVED_MAX_STALE_MS);
    await expect(uc.execute(input)).resolves.toMatchObject({ pg: 'PORTONE', switched: true });
    clock.advance(1);
    await expect(uc.execute(input)).rejects.toThrow('관측 표 읽기 실패');
    expect(failures).toEqual(['read', 'read']);

    const empty = new CachedPgChannelObservations({ reader: { readAll: async () => Promise.reject(new Error('관측 표 읽기 실패')) }, clock, signals: { channelObservedFailed: () => undefined } });
    const none = checkout({ defaults: { primary: 'TOSS', fallback: 'PORTONE' }, state: { platformSwitch: { ...SW, fromPg: 'TOSS' } }, exclusions: new PortoneFallbackExclusions({ portone: single('KCP_V2'), observations: empty }), clock });
    await expect(none.execute(input)).rejects.toThrow('관측 표 읽기 실패');
  });

  test('P-T46 ④ 전환 대상이 포트원이 아니면(기본 포트원 → 대체 토스) 관측 표를 읽지 않는다(읽기가 실패해도 결제창 준비는 그대로다)', async () => {
    let reads = 0;
    const exclusions: FallbackExclusionReader = {
      pg: 'PORTONE',
      read: async () => {
        reads += 1;
        throw new Error('관측 표 읽기 실패');
      },
    };
    const uc = checkout({ defaults: { primary: 'PORTONE', fallback: 'TOSS' }, state: { platformSwitch: { ...SW, fromPg: 'PORTONE' } }, exclusions });
    await expect(uc.execute(input)).resolves.toMatchObject({ pg: 'TOSS', switched: true });
    expect(reads).toBe(0);
  });
});
