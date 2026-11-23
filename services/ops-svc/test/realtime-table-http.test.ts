// 파트너 실시간 판매 현황 REST(GET /v1/partner/events/{eventId}/live-snapshot, FR-026, control-tower §11, C-T20, F-04-1).
// 실제 createService(메모리 조립)로 부른다. 보드 원천은 짝 가짜 MemoryRtSource, 소속은 EventOwners 짝 가짜(core 판매 설정의 promoterId),
// 보드 주기는 끄고(autoStart false) 시계는 보드에 주입한 변수다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { GetPartnerEventLiveSnapshotResponse } from '@peaket/contracts/openapi/partner';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryRtSource, RtBoard, type CumulativeRow, type EventOwners } from '../src/modules/realtime-table/index.js';
import { FakeIdentity, quiet } from './support.js';

const T0 = Date.parse('2026-11-23T10:00:00.000Z');
const TENANT = '0194f041-0000-7000-8000-00000000aa01';
const OTHER_TENANT = '0194f041-0000-7000-8000-00000000aa02';
const E = '0194f041-0000-7000-8000-0000000000e1';
const OTHER_E = '0194f041-0000-7000-8000-0000000000e2';
const NO_SEATMAP_E = '0194f041-0000-7000-8000-0000000000e3';
const MISSING_E = '0194f041-0000-7000-8000-0000000000e9';
const BROKEN_E = '0194f041-0000-7000-8000-0000000000eb';

class FakeOwners implements EventOwners {
  readonly owners = new Map<string, string>([
    [E, TENANT],
    [OTHER_E, OTHER_TENANT],
    [NO_SEATMAP_E, TENANT],
  ]);
  async find(eventId: string): Promise<{ promoterId: string } | undefined> {
    if (eventId === BROKEN_E) throw new Error('core-svc sale config 503');
    const promoterId = this.owners.get(eventId);
    return promoterId ? { promoterId } : undefined;
  }
}

const rows = (sold: number): CumulativeRow[] => [
  { metric: 'sold_seats', dim: '', value: sold },
  { metric: 'sold_seats_section', dim: 'A', value: sold },
  { metric: 'sold_seats_tier', dim: 'R', value: sold },
  { metric: 'queue_entries', dim: '', value: 800 },
  { metric: 'queue_admissions', dim: '', value: 200 },
  { metric: 'queue_removed', dim: '', value: 40 },
  { metric: 'sales_amount', dim: '', value: 5_500_000 },
];

const identity = new FakeIdentity();
let now = T0;
const source = new MemoryRtSource();
const board = new RtBoard({ source, seatMaps: source, now: () => now, expected: [] });
let svc: Awaited<ReturnType<typeof createService>>;
let noOwners: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  svc = await createService({
    name: 'ops-svc-live-snapshot',
    module: AppModule.register({ memory: true, realtimeTable: { board, owners: new FakeOwners(), autoStart: false } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: T0 }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
  noOwners = await createService({
    name: 'ops-svc-live-snapshot-no-owners',
    module: AppModule.register({ memory: true, realtimeTable: { board: new RtBoard({ source, seatMaps: source, now: () => now, expected: [] }), autoStart: false } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: T0 }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterAll(async () => {
  await svc?.close();
  await noOwners?.close();
});
beforeEach(() => {
  // 시험마다 다음 1분 칸으로 옮겨 파트너 값을 새로 계산하게 한다
  now += 61_000;
  source.failing.clear();
  source.cumulativeRows.set(E, rows(30));
  source.seatMapRows.set(E, [
    { layoutVersion: 3, sectionId: 'A', tierId: 'R', seatCount: 100 },
    { layoutVersion: 3, sectionId: 'B', tierId: 'S', seatCount: 50 },
  ]);
  source.cumulativeRows.set(NO_SEATMAP_E, rows(1));
});

const get = (eventId: string, who: Record<string, string>, on = svc) => on.http.inject({ method: 'GET', url: `/v1/partner/events/${eventId}/live-snapshot`, headers: who });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const PARTNER_KEYS = ['asOf', 'nextUpdateAt', 'projectedSoldOutAt', 'queueEntries', 'remaining', 'sections', 'sold', 'soldPerMinute', 'waiting'];

describe('F-04-1 파트너 실시간 판매 현황 REST', () => {
  test('F-04-1 C-T20 ⑨ 소속 파트너 두 역할은 200·Cache-Control no-store·계약 모양이고 판매 수가 관제 누적 뷰와 같으며 개인정보·봇 칸은 0건이다', async () => {
    for (const role of ['partner_admin', 'partner_member'] as const) {
      const r = await get(E, identity.partner(TENANT, role));
      expect(r.statusCode, `${role} ${r.payload}`).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const body = json(r);
      expect(GetPartnerEventLiveSnapshotResponse.safeParse(body).success).toBe(true);
      expect(Object.keys(body).sort()).toEqual(PARTNER_KEYS);
      const consoleView = await board.snapshot(E, now);
      expect(body).toEqual({
        asOf: new Date(now).toISOString(),
        nextUpdateAt: new Date(now + 60_000).toISOString(),
        sold: consoleView.cumulative.soldSeats,
        remaining: 120,
        projectedSoldOutAt: null,
        waiting: 560,
        queueEntries: 800,
        sections: [
          { sectionId: 'A', remaining: 70 },
          { sectionId: 'B', remaining: 50 },
        ],
        // 이 회차의 첫 조회라 분당 판매 점이 아직 없다
        soldPerMinute: [],
      });
      expect(body.sold).toBe(30);
      // 금액·퍼널·봇 판정 같은 관제 칸은 싣지 않는다
      for (const value of ['5500000', 'salesAmount', 'verdict', 'pid', 'accountId']) expect(r.payload).not.toContain(value);
    }
  });

  test('F-04-1 C-T20 ⑩ 다른 파트너 회차는 403(이름 없는 Problem)이고 보드를 읽지 않는다, 없는 회차는 404 not-found다', async () => {
    const before = source.reads.cumulative;
    const forbidden = await get(OTHER_E, identity.partner(TENANT));
    expect(forbidden.statusCode).toBe(403);
    expect(json(forbidden).type).toBe('about:blank');
    const missing = await get(MISSING_E, identity.partner(TENANT));
    expect(missing.statusCode).toBe(404);
    expect(json(missing)).toMatchObject({ type: 'https://peaket.example/problems/not-found', title: '찾을 수 없습니다' });
    expect(source.reads.cumulative).toBe(before);
  });

  test('F-04-1 C-T20 ⑪ 소속 확인 실패·테넌트 없는 세션·소속 확인 원천 없음은 503 authz-unavailable, 관제 세션은 401(토큰 대상이 파트너가 아님)이다', async () => {
    const broken = await get(BROKEN_E, identity.partner(TENANT));
    expect(broken.statusCode).toBe(503);
    expect(String(json(broken).type)).toMatch(/\/authz-unavailable$/);
    const noTenant = await get(E, identity.partner(undefined));
    expect(noTenant.statusCode).toBe(503);
    expect(String(json(noTenant).type)).toMatch(/\/authz-unavailable$/);
    const unwired = await get(E, identity.partner(TENANT), noOwners);
    expect(unwired.statusCode).toBe(503);
    expect(String(json(unwired).type)).toMatch(/\/authz-unavailable$/);
    for (const role of ['viewer', 'commander'] as const) expect((await get(E, identity.ops(role))).statusCode, role).toBe(401);
  });

  test('F-04-1 C-T20 ⑫ 실시간 표를 읽지 못하거나 판매 대상 좌석 수를 모르면 503 dependency-unavailable과 Retry-After 60이다', async () => {
    source.failing.add('cumulative');
    const down = await get(E, identity.partner(TENANT));
    expect(down.statusCode).toBe(503);
    expect(down.headers['retry-after']).toBe('60');
    expect(json(down)).toMatchObject({ type: 'https://peaket.example/problems/dependency-unavailable', title: '의존 서비스를 잠시 쓸 수 없습니다' });
    source.failing.clear();
    const noSeatMap = await get(NO_SEATMAP_E, identity.partner(TENANT));
    expect(noSeatMap.statusCode).toBe(503);
    expect(json(noSeatMap)).toMatchObject({ type: 'https://peaket.example/problems/dependency-unavailable' });
    expect(noSeatMap.headers['retry-after']).toBe('60');
  });
});
