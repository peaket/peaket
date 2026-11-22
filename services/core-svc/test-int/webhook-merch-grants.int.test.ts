// 웹훅 끝점·굿즈 주문·상품 수수료율의 앱 역할 쓰기 권한 통합 시험(실제 PostgreSQL 18 컨테이너, AZ-T18, W12-core-rls2, ADR-0338, docs/security/authz-matrix.md §5.3·§7).
// 시드는 admin(슈퍼유저, 행 보안을 지난다)으로 시험마다 새로 넣는다. 시험은 운영과 같은 그룹 역할(core_app·core_partner)의 로그인 사용자로
// 조건이 빠진 쿼리를 보내 DB 가드(칸 권한·정책·트리거)만 본다. 겹친 가드는 하나씩 본다(계획 3.2: ①은 허용된 끄기와 함께, ②는 허용된 세 칸만, ④는 자기 테넌트 값).
// 단언 값은 정본에서: 정책 이름·식·칸 목록·트리거(ADR-0338 결정 1~4), 재시도 간격·실패 끄기 기준(notify.md §9 [가정]),
// 정산 기준일(settlement.md §4.5 '받은 날부터 7일이 지난 다음 날'), 계약 없는 게시 23514(ADR-0338 결정 4). 시험 값은 코드 기본값(1000bp)과 다르게 고른다.
import 'reflect-metadata';
import { createDatabase, createService, type Database, type DbTransaction, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import { eq, inArray, sql } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { webhookDelivery, webhookEndpoint } from '../src/modules/notify/adapters/db/schema.js';
import { DrizzleWebhookStore, WebhookDispatcher, type WebhookTransport } from '../src/modules/notify/index.js';
import { merchOrder, merchOrderItem, product } from '../src/modules/shop/adapters/db/schema.js';
import { DrizzleShopOrderStore } from '../src/modules/shop/index.js';
import { FakeIdentity, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const NOW = Date.parse('2026-11-20T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'az-t18-internal-token';

let pg: PostgresContainer;
let admin: Database;
let app: Database;
let partner: Database;
let partnerSvc: Database;
let svc: Awaited<ReturnType<typeof createService>>;

const A = randomUUID();
const B = randomUUID();
/** 계약(promoter_contract)이 없는 판매자 */
const C = randomUUID();
const PLACE = randomUUID();
const PROD_A = randomUUID();
const EVENT_A = randomUUID();

// ---- 웹훅 끝점 시드 ----
const A1 = randomUUID();
const A2 = randomUUID();
const B1 = randomUUID();
/** 발송기용: 켜짐, 구독 order.confirmed, 옛 비밀이 아직 유효 */
const E = randomUUID();
/** 발송기용: 파트너가 끔 */
const F = randomUUID();

type EndpointRow = typeof webhookEndpoint.$inferSelect;
const endpointSeed = (id: string, promoterId: string, o: Partial<EndpointRow>): EndpointRow => ({
  id,
  promoterId,
  url: 'https://seed.example/hook',
  eventTypes: ['order.confirmed'],
  status: 'ACTIVE',
  disabledReason: null,
  secret: 'whsec_seed',
  previousSecret: null,
  secretIssuedAt: new Date('2026-11-01T00:00:00.000Z'),
  previousSecretValidUntil: null,
  version: 1,
  ...o,
});
const SEED_ENDPOINTS: Record<string, EndpointRow> = {
  [A1]: endpointSeed(A1, A, { url: 'https://a1.partner-a.example/hook', secret: 'whsec_seed_a1' }),
  [A2]: endpointSeed(A2, A, { url: 'https://a2.partner-a.example/hook', eventTypes: ['order.cancelled'], status: 'DISABLED', disabledReason: 'PARTNER', secret: 'whsec_seed_a2', version: 3 }),
  // B1은 payout.completed만 구독해 ③의 사건(order.confirmed)을 받지 않는다
  [B1]: endpointSeed(B1, B, { url: 'https://b1.partner-b.example/hook', eventTypes: ['payout.completed'], secret: 'whsec_seed_b1' }),
  [E]: endpointSeed(E, B, {
    url: 'https://e.partner-b.example/hook',
    secret: 'whsec_seed_e',
    previousSecret: 'whsec_seed_e_old',
    secretIssuedAt: new Date(NOW - DAY),
    previousSecretValidUntil: new Date(NOW + 3 * DAY),
  }),
  [F]: endpointSeed(F, B, { url: 'https://f.partner-b.example/hook', status: 'DISABLED', disabledReason: 'PARTNER', secret: 'whsec_seed_f' }),
};
/** admin(행 보안을 지난다)으로 본 모든 끝점 */
const endpointsNow = async () => Object.fromEntries((await admin.db.select().from(webhookEndpoint)).map((r) => [r.id, r]));

// ---- 굿즈 주문 시드 ----
const OA1 = randomUUID();
const IA1 = randomUUID();
const OA2 = randomUUID();
const IA2 = randomUUID();
const OB = randomUUID();
const IB = randomUUID();
const GOODS_A = randomUUID();
const GOODS_B = randomUUID();
/** KST 10-22에 받음 → 7일이 지난 다음 날 10-30이 정산 기준일(settlement.md §4.5) */
const DELIVERED = new Date('2026-10-22T00:00:00.000Z');
const BASIS = '2026-10-30';
const ORDERED = new Date('2026-10-15T01:00:00.000Z');

// ---- 상품·계약 시드 ----
/** 판매자 A의 지금 계약 수수료율(시험 값, 코드 기본값 1000과 다르게) */
const RATE_A = 1234;
/** 계약 변경 뒤 수수료율 */
const RATE_A_NEXT = 2000;
const CONTRACT_FROM = new Date('2026-01-01T00:00:00.000Z');
const CONTRACT_CHANGE_AT = new Date('2026-11-10T00:00:00.000Z');
/** A의 게시 상품(처음 게시 때 계약 값으로 정해진 상태) */
const P1 = randomUUID();
/** A의 초안 상품(수수료율 비어 있음) */
const P2 = randomUUID();

const productValues = (id: string, promoterId: string, status: 'PUBLISHED' | 'DRAFT', commissionRateBp: number | null): typeof product.$inferInsert => ({
  id,
  promoterId,
  type: 'MERCH',
  name: status === 'PUBLISHED' ? '시험 게시 굿즈' : '시험 초안 굿즈',
  status,
  price: 30_000,
  fulfillments: ['DELIVERY'],
  commissionRateBp,
  publishedAt: status === 'PUBLISHED' ? new Date(NOW) : null,
  updatedAt: new Date(NOW),
});
/** admin으로 본 상품 수수료율 */
const storedRates = async (ids: readonly string[]) =>
  Object.fromEntries((await admin.db.select({ id: product.id, rate: product.commissionRateBp }).from(product).where(inArray(product.id, [...ids]))).map((r) => [r.id, r.rate]));

/** 계약 변경(2인 승인 적용과 같은 꼴): 지금 기간을 닫고 새 기간을 연다(promoter-contract.int.test.ts의 WITHOUT OVERLAPS 꼴) */
async function changeContract(promoterId: string, rateBp: number, at: Date): Promise<void> {
  await admin.pool.query(`update promoter_contract set valid_during = tstzrange(lower(valid_during), $2, '[)') where promoter_id = $1 and upper_inf(valid_during)`, [promoterId, at]);
  await admin.pool.query(
    `insert into promoter_contract (id, promoter_id, commission_rate_bp, guarantee_rate_bp, guarantee_kind, valid_during) values ($1, $2, $3, 1000, 'DEPOSIT', tstzrange($4, NULL, '[)'))`,
    [randomUUID(), promoterId, rateBp, at],
  );
}

/** 거부된 쿼리의 SQLSTATE. Drizzle은 pg 오류를 cause로 감싼다. DB 오류가 아니면 그 글을 돌려 단언 차이에 드러낸다 */
const sqlState = (e: unknown): string => {
  const cause = e instanceof Error ? e.cause : undefined;
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : `DB 오류 아님: ${String(e)}`;
};
/** 쿼리 하나의 결과: 바뀐 행 수(rowCount) 또는 거부된 SQLSTATE */
const run = (q: Promise<{ rowCount: number | null }>): Promise<number | null | string> => q.then((r) => r.rowCount, sqlState);
/** 파트너 A 트랜잭션(연결 하나짜리 풀) */
const inA = <T>(fn: (tx: DbTransaction) => Promise<T>) => partner.transaction(fn, { tenantId: A });

/** 시험마다 admin으로 시드를 새로 넣는다. 구현 전 트리에서는 시험의 고치기가 실제로 되므로, 실패한 시험의 변경도 다음 시험 전에 지운다 */
async function seed(): Promise<void> {
  // 발송 행은 끝점과 함께 지워진다(on delete cascade), 주문 항목은 주문과 함께 지워진다
  await admin.pool.query('delete from webhook_endpoint');
  await admin.pool.query('delete from merch_order');
  await admin.pool.query('delete from product');
  await admin.pool.query('delete from promoter_contract');
  await admin.db.insert(webhookEndpoint).values(Object.values(SEED_ENDPOINTS));
  await admin.db.insert(merchOrder).values([
    { id: OA1, promoterId: A, eventId: EVENT_A, fulfillment: 'DELIVERY', buyerName: '김민수', buyerPhone: '010-1234-5678', status: 'PAID', amount: 33_000, pg: 'TOSS', pgStore: 'STANDARD', shippingFee: 3000, paidAt: ORDERED, orderedAt: ORDERED },
    { id: OA2, promoterId: A, eventId: EVENT_A, fulfillment: 'DELIVERY', buyerName: '이서', buyerPhone: '010-9876-5432', status: 'CREATED', amount: 12_000, pgStore: 'STANDARD', shippingFee: 0, orderedAt: ORDERED },
    { id: OB, promoterId: B, eventId: null, fulfillment: 'DELIVERY', buyerName: '박비', buyerPhone: '010-5555-0000', status: 'PAID', amount: 20_000, pg: 'TOSS', pgStore: 'STANDARD', shippingFee: 0, paidAt: ORDERED, orderedAt: ORDERED },
  ]);
  await admin.db.insert(merchOrderItem).values([
    {
      id: IA1,
      orderId: OA1,
      promoterId: A,
      eventId: EVENT_A,
      productId: GOODS_A,
      productName: 'LUMEN 응원봉',
      quantity: 2,
      unitAmount: 15_000,
      commissionRateBp: 1000,
      status: 'DELIVERED',
      fulfillment: 'DELIVERY',
      shippedAt: new Date('2026-10-20T00:00:00.000Z'),
      deliveredAt: DELIVERED,
      trackingNo: '6000-1111-2222',
    },
    { id: IA2, orderId: OA2, promoterId: A, eventId: EVENT_A, productId: GOODS_A, productName: 'LUMEN 응원봉', quantity: 1, unitAmount: 12_000, commissionRateBp: 1000, status: 'READY', fulfillment: 'DELIVERY' },
    { id: IB, orderId: OB, promoterId: B, eventId: null, productId: GOODS_B, productName: 'B 머플러', quantity: 1, unitAmount: 20_000, commissionRateBp: 1000, status: 'DELIVERED', fulfillment: 'DELIVERY', deliveredAt: DELIVERED },
  ]);
  // 계약 먼저(게시 상품 시드가 계약 값과 같게)
  await admin.pool.query(
    `insert into promoter_contract (id, promoter_id, commission_rate_bp, guarantee_rate_bp, guarantee_kind, valid_during) values ($1, $2, $3, 1000, 'DEPOSIT', tstzrange($4, NULL, '[)'))`,
    [randomUUID(), A, RATE_A, CONTRACT_FROM],
  );
  await admin.db.insert(product).values([productValues(P1, A, 'PUBLISHED', RATE_A), productValues(P2, A, 'DRAFT', null)]);
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-webhook-merch-grants-int', max: 2 });
  await ensureOutboxPartitions(admin, systemClock);
  app = await loginFor(admin, pg, 'core_app_login', 'core_app', 2);
  // 연결 하나짜리 풀: 앞 트랜잭션의 SET LOCAL이 끝난 연결을 다시 쓰는 경우를 만든다(rls.int.test.ts와 같은 꼴)
  partner = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 1);
  partnerSvc = await loginFor(admin, pg, 'core_partner_svc_login', 'core_partner', 2);
  await admin.db.insert(promoter).values([
    { id: A, legalName: '(주)에이' },
    { id: B, legalName: '(주)비' },
    { id: C, legalName: '(주)계약없음' },
  ]);
  await admin.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: A });
  await admin.db.insert(production).values({ id: PROD_A, promoterId: A, placeId: PLACE, title: 'LUMEN 콘서트', genre: '콘서트', saleReview: 'DRAFT' });
  await admin.db.insert(event).values({ id: EVENT_A, productionId: PROD_A, promoterId: A, venueId: null, openAt: new Date('2027-01-01T00:00:00Z'), startsAt: new Date('2027-02-01T10:00:00Z'), endsAt: new Date('2027-02-01T12:00:00Z') });
  vi.stubEnv('PEAKET_INTERNAL_TOKEN', TOKEN);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database: app, notifyDatabase: app, partnerDatabase: partnerSvc, media: testMedia() }),
    env: { PEAKET_ENV: 'ci' },
    clock: systemClock,
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
beforeEach(seed);
afterAll(async () => {
  await svc?.close();
  await partnerSvc?.close();
  await partner?.close();
  await app?.close();
  await admin?.close();
  pg?.stop();
  vi.unstubAllEnvs();
});

/** 가짜 수신기(파트너 주소 대역, 웹훅 전송 포트를 구현). 받은 요청을 남기고 늘 500을 준다(계속 실패하는 끝점) */
class FailingReceiver implements WebhookTransport {
  readonly calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  async send(input: { url: string; headers: Record<string, string>; body: string }) {
    this.calls.push(input);
    return { status: 500 };
  }
}

/** Standard Webhooks 서명 v1(notify.md §9: base64 HMAC-SHA256(비밀, id.timestamp.본문)). 제품 코드의 서명 함수를 쓰지 않고 따로 만든다 */
const sign = (secret: string, id: string, timestamp: string, body: string) => `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64')}`;

describe('웹훅 끝점·굿즈 주문·상품 수수료율의 앱 역할 쓰기 권한(ADR-0338)', () => {
  test('AZ-T18 ① 팬 경로 사용자는 허용된 끄기와 함께여도 웹훅 끝점의 주소·비밀·구독·판매자·끝점 ID 칸을 칸마다 고치지 못한다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]', async () => {
    // 허용된 끄기(켜진 끝점 → DISABLED·FAILING)를 함께 SET해 정책이 통과하게 두고 칸 권한만 본다(계획 3.2)
    const disableToo = { status: 'DISABLED', disabledReason: 'FAILING' };
    const onA1 = eq(webhookEndpoint.id, A1);
    const outcome = {
      url: await run(app.db.update(webhookEndpoint).set({ url: 'https://attacker.example/hook', ...disableToo }).where(onA1)),
      secret: await run(app.db.update(webhookEndpoint).set({ secret: 'whsec_attacker', ...disableToo }).where(onA1)),
      previousSecret: await run(app.db.update(webhookEndpoint).set({ previousSecret: 'whsec_attacker_old', ...disableToo }).where(onA1)),
      previousSecretValidUntil: await run(app.db.update(webhookEndpoint).set({ previousSecretValidUntil: new Date('2027-06-01T00:00:00.000Z'), ...disableToo }).where(onA1)),
      eventTypes: await run(app.db.update(webhookEndpoint).set({ eventTypes: ['payout.completed', 'order.confirmed'], ...disableToo }).where(onA1)),
      secretIssuedAt: await run(app.db.update(webhookEndpoint).set({ secretIssuedAt: new Date('2026-11-19T00:00:00.000Z'), ...disableToo }).where(onA1)),
      promoterId: await run(app.db.update(webhookEndpoint).set({ promoterId: B, ...disableToo }).where(onA1)),
      id: await run(app.db.update(webhookEndpoint).set({ id: sql`${webhookEndpoint.id}`, ...disableToo }).where(onA1)),
    };
    expect({ outcome, endpoints: await endpointsNow() }).toEqual({
      outcome: { url: '42501', secret: '42501', previousSecret: '42501', previousSecretValidUntil: '42501', eventTypes: '42501', secretIssuedAt: '42501', promoterId: '42501', id: '42501' },
      endpoints: SEED_ENDPOINTS,
    });
  });

  test('AZ-T18 ② 팬 경로 사용자는 켜진 끝점을 FAILING으로 끄는 것 말고는 상태·사유·판을 바꾸지 못하고 꺼진 끝점을 다시 켜지 못한다 [ASVS v5.0.0-8.4.1]', async () => {
    // 허용된 세 칸(status·disabled_reason·version)만 SET해 정책만 본다(계획 3.2). 고치기 정책 USING에 안 맞으면 0행, WITH CHECK에 걸리면 42501
    const outcome = {
      '가 꺼진 A2 다시 켜기': await run(app.db.update(webhookEndpoint).set({ status: 'ACTIVE', disabledReason: null }).where(eq(webhookEndpoint.id, A2))),
      '나 켜진 A1 사유만 PARTNER': await run(app.db.update(webhookEndpoint).set({ disabledReason: 'PARTNER' }).where(eq(webhookEndpoint.id, A1))),
      '다 켜진 A1 사유 PARTNER로 끄기': await run(app.db.update(webhookEndpoint).set({ status: 'DISABLED', disabledReason: 'PARTNER' }).where(eq(webhookEndpoint.id, A1))),
      '라 켜진 A1 판만 올리기': await run(app.db.update(webhookEndpoint).set({ version: sql`${webhookEndpoint.version} + 1` }).where(eq(webhookEndpoint.id, A1))),
    };
    expect({ outcome, endpoints: await endpointsNow() }).toEqual({
      outcome: { '가 꺼진 A2 다시 켜기': 0, '나 켜진 A1 사유만 PARTNER': '42501', '다 켜진 A1 사유 PARTNER로 끄기': '42501', '라 켜진 A1 판만 올리기': '42501' },
      endpoints: SEED_ENDPOINTS,
    });
  });

  test('AZ-T18 ③ 발송기는 팬 경로 사용자로 켜진 끝점을 읽어 서명해 보내고 계속 실패하면 FAILING으로 끄며 이미 꺼진 끝점의 사유는 바꾸지 않는다 [ASVS v5.0.0-8.4.1]', async () => {
    // E에 5일 [가정] 창 안의 DEAD 49건(성공 없음)을 둔다. 이번 사건이 DEAD가 되면 50건이라 끈다(notify.md §9 [가정])
    await admin.pool.query(
      `insert into webhook_delivery (id, endpoint_id, webhook_id, event_type, status, attempt_count, last_http_status, created_at, finished_at)
       select gen_random_uuid(), $1, 'seed-dead-' || g, 'order.confirmed', 'DEAD', 7, 500, $2, $2 from generate_series(1, 49) g`,
      [E, new Date(NOW - 60 * 60 * 1000)],
    );
    const clock = fakeClock({ now: NOW });
    const store = new DrizzleWebhookStore(app);
    const receiver = new FailingReceiver();
    const disabledNotices: string[] = [];
    const dispatcher = new WebhookDispatcher({ store, transport: receiver, clock, onDisabled: (e) => disabledNotices.push(e.endpointId) });
    const orderId = randomUUID();
    const views = await dispatcher.enqueue({ promoterId: B, eventType: 'order.confirmed', data: { orderId }, occurredAt: new Date(NOW) });
    // B의 켜진 끝점 가운데 order.confirmed 구독은 E 하나다(B1은 구독 밖, F는 꺼짐)
    expect(views).toHaveLength(1);
    const view = views[0]!;
    // 처음 보냄 뒤 1분·5분·30분·2시간·6시간·12시간 [가정]에 다시 보내고 모두 실패하면 DEAD(notify.md §9)
    const sentAt: number[] = [];
    const results: Awaited<ReturnType<WebhookDispatcher['processDue']>>[] = [];
    for (const wait of [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000]) {
      clock.advance(wait);
      sentAt.push(clock.now());
      results.push(await dispatcher.processDue(new Date(clock.now())));
    }
    const retrying = { attempted: 1, succeeded: 0, retrying: 1, dead: 0, disabled: [] };
    expect(results).toEqual([retrying, retrying, retrying, retrying, retrying, retrying, { attempted: 1, succeeded: 0, retrying: 0, dead: 1, disabled: [E] }]);
    // 보낸 요청: 모두 E의 주소, 지금 비밀·옛 비밀(기한 안) 두 서명을 공백으로 이은 값(시험에서 따로 만든 HMAC)
    const sent = receiver.calls.map((c) => ({ url: c.url, id: c.headers['webhook-id'], timestamp: c.headers['webhook-timestamp'], signature: c.headers['webhook-signature'], body: JSON.parse(c.body) as unknown }));
    expect(sent).toEqual(
      sentAt.map((at, i) => {
        const timestamp = String(Math.floor(at / 1000));
        const body = receiver.calls[i]?.body ?? '';
        return {
          url: 'https://e.partner-b.example/hook',
          id: view.webhookId,
          timestamp,
          signature: `${sign('whsec_seed_e', view.webhookId, timestamp, body)} ${sign('whsec_seed_e_old', view.webhookId, timestamp, body)}`,
          body: { type: 'order.confirmed', timestamp: new Date(NOW).toISOString(), data: { orderId } },
        };
      }),
    );
    const delivery = await admin.db
      .select({ endpointId: webhookDelivery.endpointId, status: webhookDelivery.status, attemptCount: webhookDelivery.attemptCount, lastHttpStatus: webhookDelivery.lastHttpStatus })
      .from(webhookDelivery)
      .where(eq(webhookDelivery.id, view.deliveryId));
    expect(delivery).toEqual([{ endpointId: E, status: 'DEAD', attemptCount: 7, lastHttpStatus: 500 }]);
    expect(disabledNotices).toEqual([E]);
    // 이미 꺼진(파트너가 끈) 끝점에 끄기를 부르면 오류 없이 끝나고 사유·판이 그대로다(ADR-0338 결정 1 '행동 바뀜')
    await expect(store.disableEndpoint(F, new Date(clock.now()))).resolves.toBeUndefined();
    const readF = await store.findEndpointById(F);
    expect({ endpoints: await endpointsNow(), readF }).toEqual({
      endpoints: { ...SEED_ENDPOINTS, [E]: { ...SEED_ENDPOINTS[E], status: 'DISABLED', disabledReason: 'FAILING', version: 2 } },
      readF: {
        endpointId: F,
        promoterId: B,
        url: 'https://f.partner-b.example/hook',
        eventTypes: ['order.confirmed'],
        status: 'DISABLED',
        disabledReason: 'PARTNER',
        secret: 'whsec_seed_f',
        previousSecret: null,
        secretIssuedAt: new Date('2026-11-01T00:00:00.000Z'),
        previousSecretValidUntil: null,
        version: 1,
      },
    });
  });

  test('AZ-T18 ④ 파트너 트랜잭션은 자기 테넌트 끝점만 읽고 고치며 자기 끝점이라도 판매자·끝점 ID 칸은 고치지 못한다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]', async () => {
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
    const ownRead = (await inA(async (tx) => tx.select({ id: webhookEndpoint.id, secret: webhookEndpoint.secret }).from(webhookEndpoint))).sort(byId);
    // WHERE·RETURNING 없이 고친다. 칸을 읽지 않아 읽기 정책이 끼지 않고 고치기 정책만 행을 거른다(PostgreSQL 18 CREATE POLICY '명령별 적용 정책')
    const unconditional = await run(inA(async (tx) => tx.update(webhookEndpoint).set({ url: 'https://a2.example.com/hook' })));
    const afterUnconditional = await endpointsNow();
    // 연결 하나짜리 풀이라 다음 트랜잭션이 A가 쓴 연결을 받는다(app.tenant_id가 빈 문자열)
    const tenantless = await partner.transaction(async (tx) => ({
      read: await tx.select({ id: webhookEndpoint.id }).from(webhookEndpoint),
      update: (await tx.update(webhookEndpoint).set({ url: 'https://tenantless.example/hook' })).rowCount,
    }));
    const outside = await partner.db.select({ id: webhookEndpoint.id }).from(webhookEndpoint);
    const onA1 = eq(webhookEndpoint.id, A1);
    const denied = {
      promoterId: await run(inA(async (tx) => tx.update(webhookEndpoint).set({ promoterId: A }).where(onA1))),
      id: await run(inA(async (tx) => tx.update(webhookEndpoint).set({ id: sql`${webhookEndpoint.id}` }).where(onA1))),
      insertForB: await run(
        inA(async (tx) =>
          tx.insert(webhookEndpoint).values({ ...endpointSeed(randomUUID(), B, { url: 'https://intruder.partner-a.example/hook', secret: 'whsec_intruder' }) }),
        ),
      ),
    };
    // 코드가 고치는 아홉 칸(ADR-0338 결정 2)을 모두 새 값으로
    const NINE = {
      url: 'https://a1-new.partner-a.example/hook',
      eventTypes: ['order.confirmed', 'event.sold_out'],
      status: 'DISABLED',
      disabledReason: 'PARTNER',
      secret: 'whsec_new_a1',
      previousSecret: 'whsec_seed_a1',
      secretIssuedAt: new Date('2026-11-21T00:00:00.000Z'),
      previousSecretValidUntil: new Date('2026-11-22T00:00:00.000Z'),
    };
    const nine = await inA(async (tx) => tx.update(webhookEndpoint).set({ ...NINE, version: sql`${webhookEndpoint.version} + 1` }).where(onA1).returning({ id: webhookEndpoint.id }));
    expect({ ownRead, unconditional, afterUnconditional, tenantless, outside, denied, nine, final: await endpointsNow() }).toEqual({
      ownRead: [
        { id: A1, secret: 'whsec_seed_a1' },
        { id: A2, secret: 'whsec_seed_a2' },
      ].sort(byId),
      unconditional: 2,
      afterUnconditional: {
        ...SEED_ENDPOINTS,
        [A1]: { ...SEED_ENDPOINTS[A1], url: 'https://a2.example.com/hook' },
        [A2]: { ...SEED_ENDPOINTS[A2], url: 'https://a2.example.com/hook' },
      },
      tenantless: { read: [], update: 0 },
      outside: [],
      denied: { promoterId: '42501', id: '42501', insertForB: '42501' },
      nine: [{ id: A1 }],
      final: {
        ...SEED_ENDPOINTS,
        [A1]: { ...SEED_ENDPOINTS[A1], ...NINE, version: 2 },
        [A2]: { ...SEED_ENDPOINTS[A2], url: 'https://a2.example.com/hook' },
      },
    });
  });

  test('AZ-T18 ⑤ 파트너 트랜잭션은 자기 테넌트의 굿즈 주문·주문 항목을 넣거나 칸마다 고치거나 지우지 못하고 상품 정산 원천 응답이 그대로다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    const settlement = async () => {
      const r = await svc.http.inject({ method: 'GET', url: `/internal/v1/shop/product-settlement-items?from=${BASIS}&to=${BASIS}`, headers: { 'x-peaket-internal-token': TOKEN } });
      return { statusCode: r.statusCode, body: JSON.parse(r.payload) as unknown };
    };
    const snapshot = async () => ({
      orders: await admin.db.select().from(merchOrder).orderBy(merchOrder.id),
      items: await admin.db.select().from(merchOrderItem).orderBy(merchOrderItem.id),
    });
    const before = await settlement();
    // 시작 응답: 배송 완료 항목 둘. A의 총액 = 단가 15,000 × 2 + 배송비 3,000(주문에 한 번, settlement.md §4.5)
    expect(before).toEqual({
      statusCode: 200,
      body: {
        from: BASIS,
        to: BASIS,
        items: [
          { itemId: IA1, orderId: OA1, promoterId: A, eventId: EVENT_A, pg: 'TOSS', pgStore: 'STANDARD', productId: GOODS_A, productName: 'LUMEN 응원봉', quantity: 2, grossAmount: 33_000, refundedAmount: 0, commissionRateBp: 1000, basisDate: BASIS, returnStatus: 'DELIVERED', eventEndsAt: null },
          { itemId: IB, orderId: OB, promoterId: B, eventId: null, pg: 'TOSS', pgStore: 'STANDARD', productId: GOODS_B, productName: 'B 머플러', quantity: 1, grossAmount: 20_000, refundedAmount: 0, commissionRateBp: 1000, basisDate: BASIS, returnStatus: 'DELIVERED', eventEndsAt: null },
        ].sort((x, y) => (x.itemId < y.itemId ? -1 : 1)),
      },
    });
    const rowsBefore = await snapshot();
    // WHERE·RETURNING 없이 칸마다 따로 고친다(정산이 읽는 칸·상태·처리 시각·송장). 0행이 아니라 권한 거절이어야 한다(계획 3.2)
    const item = {
      unitAmount: await run(inA(async (tx) => tx.update(merchOrderItem).set({ unitAmount: 15_001 }))),
      quantity: await run(inA(async (tx) => tx.update(merchOrderItem).set({ quantity: 3 }))),
      commissionRateBp: await run(inA(async (tx) => tx.update(merchOrderItem).set({ commissionRateBp: 0 }))),
      refundedAmount: await run(inA(async (tx) => tx.update(merchOrderItem).set({ refundedAmount: 15_000 }))),
      status: await run(inA(async (tx) => tx.update(merchOrderItem).set({ status: 'CANCELLED' }))),
      shippedAt: await run(inA(async (tx) => tx.update(merchOrderItem).set({ shippedAt: new Date('2026-09-01T00:00:00.000Z') }))),
      deliveredAt: await run(inA(async (tx) => tx.update(merchOrderItem).set({ deliveredAt: new Date('2026-09-02T00:00:00.000Z') }))),
      trackingNo: await run(inA(async (tx) => tx.update(merchOrderItem).set({ trackingNo: '9999-0000-1111' }))),
    };
    const order = {
      status: await run(inA(async (tx) => tx.update(merchOrder).set({ status: 'PAID' }))),
      shippingFee: await run(inA(async (tx) => tx.update(merchOrder).set({ shippingFee: 0 }))),
      pg: await run(inA(async (tx) => tx.update(merchOrder).set({ pg: 'PORTONE' }))),
      purchaseConfirmedAt: await run(inA(async (tx) => tx.update(merchOrder).set({ purchaseConfirmedAt: new Date('2026-10-01T00:00:00.000Z') }))),
      amount: await run(inA(async (tx) => tx.update(merchOrder).set({ amount: 1 }))),
    };
    // 결제가 없는 PAID 주문과 그 배송 완료 항목을 넣어 정산에 올리기
    const forged = randomUUID();
    const write = {
      insertOrder: await run(
        inA(async (tx) => tx.insert(merchOrder).values({ id: forged, promoterId: A, eventId: EVENT_A, fulfillment: 'DELIVERY', status: 'PAID', amount: 50_000, pg: 'TOSS', pgStore: 'STANDARD', shippingFee: 0, orderedAt: ORDERED })),
      ),
      insertItem: await run(
        inA(async (tx) =>
          tx.insert(merchOrderItem).values({ id: randomUUID(), orderId: forged, promoterId: A, eventId: EVENT_A, productId: GOODS_A, productName: 'LUMEN 응원봉', quantity: 1, unitAmount: 50_000, commissionRateBp: 0, status: 'DELIVERED', fulfillment: 'DELIVERY', deliveredAt: DELIVERED }),
        ),
      ),
      deleteItems: await run(inA(async (tx) => tx.delete(merchOrderItem))),
      deleteOrders: await run(inA(async (tx) => tx.delete(merchOrder))),
    };
    const denied = '42501';
    expect({ item, order, write, settlement: await settlement() }).toEqual({
      item: { unitAmount: denied, quantity: denied, commissionRateBp: denied, refundedAmount: denied, status: denied, shippedAt: denied, deliveredAt: denied, trackingNo: denied },
      order: { status: denied, shippingFee: denied, pg: denied, purchaseConfirmedAt: denied, amount: denied },
      write: { insertOrder: denied, insertItem: denied, deleteItems: denied, deleteOrders: denied },
      settlement: before,
    });
    expect(await snapshot()).toEqual(rowsBefore);
  });

  test('AZ-T18 ⑥ 파트너 트랜잭션의 굿즈 주문·주문 항목 읽기는 자기 테넌트 행뿐이고 테넌트 없이는 0건이다(앞 트랜잭션이 쓴 연결을 다시 써도 오류 없이) [ASVS v5.0.0-8.4.1]', async () => {
    const read = (tenantId: string) =>
      partner.transaction(
        async (tx) => ({
          orders: (await tx.select({ id: merchOrder.id }).from(merchOrder)).map((r) => r.id).sort(),
          items: (await tx.select({ id: merchOrderItem.id }).from(merchOrderItem)).map((r) => r.id).sort(),
        }),
        { tenantId },
      );
    const a = await read(A);
    const b = await read(B);
    // 연결 하나짜리 풀: 테넌트 없는 트랜잭션이 B가 쓴 연결(app.tenant_id = '')을 받는다. nullif가 없으면 22P02다
    const tenantless = await partner.transaction(async (tx) => ({
      orders: await tx.select({ id: merchOrder.id }).from(merchOrder),
      items: await tx.select({ id: merchOrderItem.id }).from(merchOrderItem),
    }));
    const outside = { orders: await partner.db.select({ id: merchOrder.id }).from(merchOrder), items: await partner.db.select({ id: merchOrderItem.id }).from(merchOrderItem) };
    expect({ a, b, tenantless, outside }).toEqual({
      a: { orders: [OA1, OA2].sort(), items: [IA1, IA2].sort() },
      b: { orders: [OB], items: [IB] },
      tenantless: { orders: [], items: [] },
      outside: { orders: [], items: [] },
    });
  });

  test('AZ-T18 ⑦ 세 표의 행 보안이 켜져 있고 FORCE가 없으며 소유자가 앱 역할이 아니고 정책과 칸 권한이 정한 모양이다 [ASVS v5.0.0-8.4.1]', async () => {
    const rows = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await admin.pool.query<T>(text, params)).rows;
    const TABLES = ['merch_order', 'merch_order_item', 'webhook_endpoint'];
    const tables = await rows<{ relname: string; rls: boolean; forced: boolean; owner: string }>(
      `select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner) as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1) order by c.relname collate "C"`,
      [TABLES],
    );
    const policies = await rows<{ tablename: string; policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null }>(
      `select tablename, policyname, cmd, roles::text[] as roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = any($1) order by tablename collate "C", policyname collate "C"`,
      [TABLES],
    );
    // 파트너 테넌트 식은 production_partner_tenant(0004, ADR-0241 결정 3)의 식과 같은 글이다
    const base = await rows<{ qual: string }>(`select qual from pg_policies where schemaname = 'public' and tablename = 'production' and policyname = 'production_partner_tenant'`);
    expect(base).toHaveLength(1);
    expect(base[0]!.qual).toMatch(/\bpromoter_id = /);
    const tenant = base[0]!.qual;
    /** 그 역할이 고칠(또는 넣을) 수 있는 칸 이름(칸 권한 또는 표 권한), 글자 차례 */
    const columnsWith = async (role: string, table: string, privilege: 'UPDATE' | 'INSERT') =>
      (
        await rows<{ attname: string }>(
          `select a.attname from pg_attribute a where a.attrelid = ('public.' || $2::text)::regclass and a.attnum > 0 and not a.attisdropped and has_column_privilege($1::name, a.attrelid, a.attnum, $3::text)`,
          [role, table, privilege],
        )
      )
        .map((r) => r.attname)
        .sort();
    const tablePriv = async (role: string, table: string, privilege: string) =>
      (await rows<{ ok: boolean }>(`select has_table_privilege($1::name, 'public.' || $2::text, $3::text) as ok`, [role, table, privilege]))[0]!.ok;
    const privileges = {
      appEndpointUpdateTable: await tablePriv('core_app', 'webhook_endpoint', 'UPDATE'),
      appEndpointUpdateColumns: await columnsWith('core_app', 'webhook_endpoint', 'UPDATE'),
      appEndpointSelect: await tablePriv('core_app', 'webhook_endpoint', 'SELECT'),
      partnerEndpointUpdateTable: await tablePriv('core_partner', 'webhook_endpoint', 'UPDATE'),
      partnerEndpointUpdateColumns: await columnsWith('core_partner', 'webhook_endpoint', 'UPDATE'),
      partnerEndpointSelectInsert: [await tablePriv('core_partner', 'webhook_endpoint', 'SELECT'), await tablePriv('core_partner', 'webhook_endpoint', 'INSERT')],
      partnerOrder: {
        select: await tablePriv('core_partner', 'merch_order', 'SELECT'),
        insertTable: await tablePriv('core_partner', 'merch_order', 'INSERT'),
        updateTable: await tablePriv('core_partner', 'merch_order', 'UPDATE'),
        insertColumns: await columnsWith('core_partner', 'merch_order', 'INSERT'),
        updateColumns: await columnsWith('core_partner', 'merch_order', 'UPDATE'),
      },
      partnerOrderItem: {
        select: await tablePriv('core_partner', 'merch_order_item', 'SELECT'),
        insertTable: await tablePriv('core_partner', 'merch_order_item', 'INSERT'),
        updateTable: await tablePriv('core_partner', 'merch_order_item', 'UPDATE'),
        insertColumns: await columnsWith('core_partner', 'merch_order_item', 'INSERT'),
        updateColumns: await columnsWith('core_partner', 'merch_order_item', 'UPDATE'),
      },
      // 팬 경로 역할의 주문 권한(읽기·넣기·고치기)은 그대로다(ADR-0338 결정 3)
      appOrders: {
        merch_order: [await tablePriv('core_app', 'merch_order', 'SELECT'), await tablePriv('core_app', 'merch_order', 'INSERT'), await tablePriv('core_app', 'merch_order', 'UPDATE')],
        merch_order_item: [await tablePriv('core_app', 'merch_order_item', 'SELECT'), await tablePriv('core_app', 'merch_order_item', 'INSERT'), await tablePriv('core_app', 'merch_order_item', 'UPDATE')],
      },
    };
    expect({ tables: tables.map((t) => ({ relname: t.relname, rls: t.rls, forced: t.forced })), policies, privileges }).toEqual({
      tables: TABLES.map((relname) => ({ relname, rls: true, forced: false })),
      policies: [
        { tablename: 'merch_order', policyname: 'merch_order_app_all', cmd: 'ALL', roles: ['core_app'], qual: 'true', with_check: 'true' },
        { tablename: 'merch_order', policyname: 'merch_order_partner_read', cmd: 'SELECT', roles: ['core_partner'], qual: tenant, with_check: null },
        { tablename: 'merch_order_item', policyname: 'merch_order_item_app_all', cmd: 'ALL', roles: ['core_app'], qual: 'true', with_check: 'true' },
        { tablename: 'merch_order_item', policyname: 'merch_order_item_partner_read', cmd: 'SELECT', roles: ['core_partner'], qual: tenant, with_check: null },
        {
          tablename: 'webhook_endpoint',
          policyname: 'webhook_endpoint_app_disable',
          cmd: 'UPDATE',
          roles: ['core_app'],
          qual: "(status = 'ACTIVE'::text)",
          with_check: "((status = 'DISABLED'::text) AND (disabled_reason = 'FAILING'::text))",
        },
        { tablename: 'webhook_endpoint', policyname: 'webhook_endpoint_app_read', cmd: 'SELECT', roles: ['core_app'], qual: 'true', with_check: null },
        {
          tablename: 'webhook_endpoint',
          policyname: 'webhook_endpoint_notify_disable',
          cmd: 'UPDATE',
          roles: ['core_notify'],
          qual: "(status = 'ACTIVE'::text)",
          with_check: "((status = 'DISABLED'::text) AND (disabled_reason = 'FAILING'::text))",
        },
        { tablename: 'webhook_endpoint', policyname: 'webhook_endpoint_notify_read', cmd: 'SELECT', roles: ['core_notify'], qual: 'true', with_check: null },
        { tablename: 'webhook_endpoint', policyname: 'webhook_endpoint_partner_tenant', cmd: 'ALL', roles: ['core_partner'], qual: tenant, with_check: tenant },
      ],
      privileges: {
        appEndpointUpdateTable: false,
        appEndpointUpdateColumns: ['disabled_reason', 'status', 'version'],
        appEndpointSelect: true,
        partnerEndpointUpdateTable: false,
        partnerEndpointUpdateColumns: ['disabled_reason', 'event_types', 'previous_secret', 'previous_secret_valid_until', 'secret', 'secret_issued_at', 'status', 'url', 'version'],
        partnerEndpointSelectInsert: [true, true],
        partnerOrder: { select: true, insertTable: false, updateTable: false, insertColumns: [], updateColumns: [] },
        partnerOrderItem: { select: true, insertTable: false, updateTable: false, insertColumns: [], updateColumns: [] },
        appOrders: { merch_order: [true, true, true], merch_order_item: [true, true, true] },
      },
    });
    const appRoles = ['core_app', 'core_partner', 'core_ops', 'core_maintenance', 'core_search', 'core_app_login', 'core_partner_login', 'core_partner_svc_login'];
    expect(tables.map((t) => [t.relname, appRoles.includes(t.owner)])).toEqual(TABLES.map((t) => [t, false]));
  });

  test('AZ-T18 ⑧가 파트너 트랜잭션이 수수료율 0을 적어 넣은 게시 상품은 지금 계약 값으로 저장된다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    const id = randomUUID();
    const inserted = await run(inA(async (tx) => tx.insert(product).values(productValues(id, A, 'PUBLISHED', 0))));
    expect({ inserted, rates: await storedRates([id]) }).toEqual({ inserted: 1, rates: { [id]: RATE_A } });
  });

  test('AZ-T18 ⑧나 파트너 트랜잭션이 수수료율을 적어 넣은 초안 상품은 수수료율이 비어 있다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    const id = randomUUID();
    const inserted = await run(inA(async (tx) => tx.insert(product).values(productValues(id, A, 'DRAFT', 5))));
    expect({ inserted, rates: await storedRates([id]) }).toEqual({ inserted: 1, rates: { [id]: null } });
  });

  test('AZ-T18 ⑧다 파트너 트랜잭션이 초안을 수수료율을 적어 게시하면 지금 계약 값으로 정해진다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    const published = await run(inA(async (tx) => tx.update(product).set({ status: 'PUBLISHED', commissionRateBp: 7, publishedAt: new Date(NOW) }).where(eq(product.id, P2))));
    expect({ published, rates: await storedRates([P2]) }).toEqual({ published: 1, rates: { [P2]: RATE_A } });
  });

  test('AZ-T18 ⑧라 파트너 트랜잭션이 수수료율을 조건 없이 고쳐도 게시 상품은 처음 정한 값, 초안은 비움 그대로다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    // WHERE·RETURNING 없이 고친다(테넌트 A의 모든 상품)
    const changed = await run(inA(async (tx) => tx.update(product).set({ commissionRateBp: 0 })));
    expect({ changed, rates: await storedRates([P1, P2]) }).toEqual({ changed: 2, rates: { [P1]: RATE_A, [P2]: null } });
  });

  test('AZ-T18 ⑧마 계약을 바꾼 뒤 이미 게시한 상품을 고쳐도 처음 정한 값 그대로이고 그 뒤 처음 게시한 상품은 새 계약 값이다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    await changeContract(A, RATE_A_NEXT, CONTRACT_CHANGE_AT);
    const P3 = randomUUID();
    const outcome = {
      renameP1: await run(inA(async (tx) => tx.update(product).set({ name: 'LUMEN 응원봉 2차' }).where(eq(product.id, P1)))),
      publishP2: await run(inA(async (tx) => tx.update(product).set({ status: 'PUBLISHED', commissionRateBp: 1, publishedAt: new Date(NOW) }).where(eq(product.id, P2)))),
      insertP3: await run(inA(async (tx) => tx.insert(product).values(productValues(P3, A, 'PUBLISHED', 9)))),
    };
    expect({ outcome, rates: await storedRates([P1, P2, P3]) }).toEqual({
      outcome: { renameP1: 1, publishP2: 1, insertP3: 1 },
      rates: { [P1]: RATE_A, [P2]: RATE_A_NEXT, [P3]: RATE_A_NEXT },
    });
  });

  test('AZ-T18 ⑧바 계약이 없는 판매자의 게시는 23514로 거절되고 초안은 수수료율 없이 들어간다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    const published = randomUUID();
    const draft = randomUUID();
    const inC = <T>(fn: (tx: DbTransaction) => Promise<T>) => partner.transaction(fn, { tenantId: C });
    const outcome = {
      published: await run(inC(async (tx) => tx.insert(product).values(productValues(published, C, 'PUBLISHED', 3)))),
      draft: await run(inC(async (tx) => tx.insert(product).values(productValues(draft, C, 'DRAFT', 3)))),
    };
    const stored = (await admin.db.select({ id: product.id, rate: product.commissionRateBp }).from(product).where(eq(product.promoterId, C))).map((r) => [r.id, r.rate]);
    expect({ outcome, stored }).toEqual({ outcome: { published: '23514', draft: 1 }, stored: [[draft, null]] });
  });

  test('AZ-T18 ⑧사 파트너 트랜잭션은 자기 상품이라도 상품 ID·판매자 칸을 고치지 못한다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]', async () => {
    // 판매자 칸은 자기 테넌트 값으로 골라 WITH CHECK가 지나게 하고 칸 권한만 본다(계획 3.2)
    const outcome = {
      promoterId: await run(inA(async (tx) => tx.update(product).set({ promoterId: A }).where(eq(product.id, P1)))),
      id: await run(inA(async (tx) => tx.update(product).set({ id: sql`${product.id}` }).where(eq(product.id, P1)))),
    };
    expect({ outcome, rates: await storedRates([P1]) }).toEqual({ outcome: { promoterId: '42501', id: '42501' }, rates: { [P1]: RATE_A } });
  });

  test('AZ-T18 ⑧아 팬 경로 주문 저장소가 읽는 상품 수수료율(주문 항목이 복사하는 값)도 게시 때의 계약 값이다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    const P4 = randomUUID();
    const P5 = randomUUID();
    const first = await run(inA(async (tx) => tx.insert(product).values(productValues(P4, A, 'PUBLISHED', 0))));
    await changeContract(A, RATE_A_NEXT, CONTRACT_CHANGE_AT);
    const second = await run(inA(async (tx) => tx.insert(product).values(productValues(P5, A, 'PUBLISHED', 9))));
    const fanRead = await new DrizzleShopOrderStore(app, fakeClock({ now: NOW })).products([P1, P4, P5]);
    expect({ first, second, fan: Object.fromEntries(fanRead.map((p) => [p.productId, p.commissionRateBp])) }).toEqual({
      first: 1,
      second: 1,
      fan: { [P1]: RATE_A, [P4]: RATE_A, [P5]: RATE_A_NEXT },
    });
  });

  test('AZ-T18 ⑧자 상품 트리거가 호출자 권한 함수로 넣기·고치기 전 행마다 돌고 파트너의 상품 고치기 칸이 ADR-0338 결정 4의 목록이다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]', async () => {
    const rows = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await admin.pool.query<T>(text, params)).rows;
    // tgtype 비트: 1 행마다, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE(PostgreSQL pg_trigger)
    const triggers = await rows(
      `select t.tgname, t.tgenabled, (t.tgtype & 1) <> 0 as for_each_row, (t.tgtype & 2) <> 0 as before, (t.tgtype & 4) <> 0 as on_insert, (t.tgtype & 8) <> 0 as on_delete,
              (t.tgtype & 16) <> 0 as on_update, cardinality(t.tgattr::int2[]) as of_columns, t.tgqual is null as no_when,
              p.proname, p.prosecdef, p.proconfig
       from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.product'::regclass and not t.tgisinternal order by t.tgname collate "C"`,
    );
    const updateColumns = (
      await rows<{ attname: string }>(
        `select a.attname from pg_attribute a where a.attrelid = 'public.product'::regclass and a.attnum > 0 and not a.attisdropped and has_column_privilege('core_partner', a.attrelid, a.attnum, 'UPDATE')`,
      )
    )
      .map((r) => r.attname)
      .sort();
    const table = (
      await rows<{ update: boolean; insert: boolean; select: boolean }>(
        `select has_table_privilege('core_partner', 'public.product', 'UPDATE') as update, has_table_privilege('core_partner', 'public.product', 'INSERT') as insert, has_table_privilege('core_partner', 'public.product', 'SELECT') as select`,
      )
    )[0];
    expect({ triggers, updateColumns, table }).toEqual({
      triggers: [
        {
          tgname: 'product_commission_from_contract',
          tgenabled: 'O',
          for_each_row: true,
          before: true,
          on_insert: true,
          on_delete: false,
          on_update: true,
          of_columns: 0,
          no_when: true,
          proname: 'product_commission_from_contract',
          prosecdef: false,
          proconfig: ['search_path=pg_catalog, pg_temp'],
        },
      ],
      // 상품 22칸 가운데 상품 ID·판매자를 뺀 스물(수수료율 칸은 축소 마이그레이션까지 남긴다, ADR-0338 결정 4 '두 번에 나눔', 계획 13.2)
      updateColumns: [
        'attributes',
        'commission_rate_bp',
        'fulfillments',
        'limited_qty',
        'linked_event_id',
        'name',
        'price',
        'published_at',
        'return_address',
        'return_shipping_fee',
        'sale_ends_at',
        'sale_starts_at',
        'schema_version',
        'shipping_fee',
        'status',
        'ticket_linked',
        'transferable',
        'type',
        'updated_at',
        'version',
      ],
      table: { update: false, insert: true, select: true },
    });
  });

  // 트리거가 도는 '파트너 역할'은 그 역할의 권한을 그대로 쓰는 사용자다(감독 결정 2026-11-22: pg_has_role 판정 USAGE).
  // 상속으로 쓰는 앱 로그인은 ⑧가~아가 본다(core_partner_login은 GRANT 기본값 INHERIT·SET 참). 여기서는 관리 자격만 가진 사용자와 SET ROLE을 본다
  test('AZ-T18 ⑧차 역할을 만들 수 있는 비슈퍼유저 관리자(파트너 역할의 관리 자격만, 상속·SET 없음)가 상품을 넣거나 고치면 트리거가 돌지 않아 적은 값 그대로다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    // PostgreSQL 16부터 CREATEROLE 비슈퍼유저가 역할을 만들면 그 역할의 ADMIN 자격만 저절로 받는다(createrole_self_grant 기본값 '': INHERIT·SET 거짓).
    // 운영 마이그레이션 계정이 0004에서 core_partner를 만든 경우와 같은 꼴을, 이미 있는 core_partner에는 같은 선택지의 GRANT로 만든다
    const MGR = 'core_mgr_login';
    await admin.pool.query(`CREATE ROLE ${MGR} LOGIN PASSWORD 'peaket-test' NOSUPERUSER NOBYPASSRLS CREATEROLE`);
    const mgr = createDatabase({ url: pg.urlFor(MGR, 'peaket-test'), applicationName: 'core-svc-mgr', max: 1 });
    try {
      await mgr.pool.query('CREATE ROLE az_t18_probe NOLOGIN');
      await admin.pool.query(`GRANT core_partner TO ${MGR} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
      // 시험 준비: 관리자가 상품 표를 읽고 쓰게 한다(운영 마이그레이션 계정은 표 소유자라 행 보안을 지난다. 여기서는 그 몫을 정책 하나로 준다)
      await admin.pool.query(`GRANT SELECT, INSERT, UPDATE ON product TO ${MGR}`);
      await admin.pool.query(`CREATE POLICY az_t18_mgr_all ON product FOR ALL TO ${MGR} USING (true) WITH CHECK (true)`);
      const memberships = (
        await admin.pool.query<{ role: string; admin_option: boolean; inherit_option: boolean; set_option: boolean }>(
          `select r.rolname as role, m.admin_option, m.inherit_option, m.set_option from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = $1 order by r.rolname collate "C"`,
          [MGR],
        )
      ).rows;
      const judged = (await admin.pool.query<{ member: boolean; usage: boolean }>(`select pg_has_role($1::name, 'core_partner', 'MEMBER') as member, pg_has_role($1::name, 'core_partner', 'USAGE') as usage`, [MGR])).rows[0];
      const published = randomUUID();
      const draft = randomUUID();
      const noContract = randomUUID();
      const outcome = {
        publishedA: await run(mgr.db.insert(product).values(productValues(published, A, 'PUBLISHED', 0))),
        draftA: await run(mgr.db.insert(product).values(productValues(draft, A, 'DRAFT', 5))),
        publishedNoContract: await run(mgr.db.insert(product).values(productValues(noContract, C, 'PUBLISHED', 3))),
        updateP1: await run(mgr.db.update(product).set({ commissionRateBp: 0 }).where(eq(product.id, P1))),
      };
      expect({ memberships, judged, outcome, rates: await storedRates([published, draft, noContract, P1]) }).toEqual({
        // 저절로 받은 자격과 시험이 만든 자격이 같은 꼴이다
        memberships: [
          { role: 'az_t18_probe', admin_option: true, inherit_option: false, set_option: false },
          { role: 'core_partner', admin_option: true, inherit_option: false, set_option: false },
        ],
        judged: { member: true, usage: false },
        outcome: { publishedA: 1, draftA: 1, publishedNoContract: 1, updateP1: 1 },
        rates: { [published]: 0, [draft]: 5, [noContract]: 3, [P1]: 0 },
      });
    } finally {
      await mgr.close();
      await admin.pool.query('DROP POLICY IF EXISTS az_t18_mgr_all ON product');
      await admin.pool.query(`REVOKE ALL ON product FROM ${MGR}`);
      await admin.pool.query('DROP ROLE IF EXISTS az_t18_probe');
      await admin.pool.query(`DROP ROLE IF EXISTS ${MGR}`);
    }
  });

  test('AZ-T18 ⑧카 파트너 로그인이 SET ROLE로 파트너 역할 자체가 되어도(current_user = core_partner) 수수료율은 계약 값이고 계약 없는 게시는 23514다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]', async () => {
    const id = randomUUID();
    const asRole = <T>(tenantId: string, fn: (tx: DbTransaction) => Promise<T>) =>
      partner.transaction(async (tx) => {
        await tx.execute(sql`set local role core_partner`);
        const who = (await tx.execute(sql`select current_user as u`)).rows as { u: string }[];
        return { who: who[0]?.u, result: await fn(tx) };
      }, { tenantId });
    const outcome = {
      publishedA: await asRole(A, async (tx) => (await tx.insert(product).values(productValues(id, A, 'PUBLISHED', 0))).rowCount),
      publishedNoContract: await asRole(C, async (tx) => tx.insert(product).values(productValues(randomUUID(), C, 'PUBLISHED', 3))).then(
        (r) => r.result.rowCount,
        sqlState,
      ),
    };
    expect({ outcome, rates: await storedRates([id]) }).toEqual({
      outcome: { publishedA: { who: 'core_partner', result: 1 }, publishedNoContract: '23514' },
      rates: { [id]: RATE_A },
    });
  });
});
