// 공연 상세 응답의 값 판정(openapi EventPublicSummary, ADR-0118, ADR-0200 결정 4·5, BUILD_ORDER HOT-306)
import { describe, expect, test } from 'vitest';
import { lobbyOpensAt, publicRounds, queueOrder, sellerInfo, type SellerRow } from '../src/modules/catalog/domain/event-detail.js';

const full: SellerRow = { legalName: '(주)피켓공연', representative: '김피켓', address: '서울 어딘가 1', phone: '02-0000-0000', email: 'seller@peaket.example', businessRegNo: '123-45-67890', mailOrderReportNo: '제2026-1호', exemptionBasis: null };
const round = (id: string, startsAt: string, status: 'SCHEDULED' | 'CANCELLED' | 'POSTPONED' = 'SCHEDULED') => ({ id, startsAt: new Date(startsAt), openAt: new Date('2026-12-01T00:00:00Z'), status });
const NOW = new Date('2026-12-10T00:00:00Z');

describe('정렬 방식(ADR-0118)', () => {
  test('두_설정에서_이름을_계산한다', () => {
    expect(queueOrder(true, true)).toBe('HYBRID');
    expect(queueOrder(true, false)).toBe('PREQUEUE_SHUFFLE');
    expect(queueOrder(false, true)).toBe('FIFO');
  });

  test('로비개방은_오픈에서_로비분을뺀시각이고_셔플을끈회차는_null이다', () => {
    const openAt = new Date('2026-12-01T11:00:00Z');
    expect(lobbyOpensAt(openAt, 10, true)?.toISOString()).toBe('2026-12-01T10:50:00.000Z');
    expect(lobbyOpensAt(openAt, 10, false)).toBeNull();
  });
});

describe('판매자 신원정보(전자상거래법 §20②, ADR-0200 결정 4)', () => {
  test('일곱항목이_다있을때만_싣는다', () => {
    expect(sellerInfo(full)).toEqual({ legalName: '(주)피켓공연', representative: '김피켓', address: '서울 어딘가 1', phone: '02-0000-0000', email: 'seller@peaket.example', businessRegNo: '123-45-67890', mailOrderReportNo: '제2026-1호' });
    for (const k of ['representative', 'address', 'phone', 'email', 'businessRegNo'] as const) expect(sellerInfo({ ...full, [k]: null })).toBeUndefined();
    expect(sellerInfo({ ...full, phone: '  ' })).toBeUndefined();
  });

  test('신고번호가없으면_면제사유가있어야하고_그값을싣는다', () => {
    expect(sellerInfo({ ...full, mailOrderReportNo: null, exemptionBasis: '간이과세자' })).toMatchObject({ exemptionBasis: '간이과세자' });
    expect(sellerInfo({ ...full, mailOrderReportNo: null })).toBeUndefined();
    expect(sellerInfo({ ...full, mailOrderReportNo: null, exemptionBasis: ' ' })).toBeUndefined();
  });
});

describe('공개 회차 목록(ADR-0200 결정 5)', () => {
  test('시작순이고_취소와판매종료지난회차를뺀다', () => {
    const rows = [round('c', '2026-12-30T10:00:00Z'), round('a', '2026-12-20T10:00:00Z'), round('x', '2026-12-25T10:00:00Z', 'CANCELLED'), round('old', '2026-12-10T10:00:00Z')];
    expect(publicRounds(rows, 'a', NOW).map((r) => r.eventId)).toEqual(['a', 'c']);
  });

  test('이회차는_취소되거나_판매가끝나도_늘넣는다', () => {
    const rows = [round('old', '2026-12-10T10:00:00Z'), round('x', '2026-12-25T10:00:00Z', 'CANCELLED'), round('a', '2026-12-20T10:00:00Z')];
    expect(publicRounds(rows, 'old', NOW).map((r) => r.eventId)).toEqual(['old', 'a']);
    expect(publicRounds(rows, 'x', NOW).map((r) => r.eventId)).toEqual(['a', 'x']);
  });

  test('판매종료는_공연시작24시간전이다', () => {
    const r = publicRounds([round('a', '2026-12-20T10:00:00Z')], 'a', NOW)[0];
    expect(r).toEqual({ eventId: 'a', startsAt: '2026-12-20T10:00:00.000Z', openAt: '2026-12-01T00:00:00.000Z', saleEndsAt: '2026-12-19T10:00:00.000Z', status: 'SCHEDULED' });
  });

  test('60개까지이고_이회차는_잘리지않는다', () => {
    const rows = Array.from({ length: 70 }, (_, i) => round(`r${String(i).padStart(2, '0')}`, new Date(Date.parse('2027-01-01T00:00:00Z') + i * 86_400_000).toISOString()));
    const out = publicRounds(rows, 'r69', NOW);
    expect(out).toHaveLength(60);
    expect(out.at(-1)?.eventId).toBe('r69');
    expect(out.map((r) => r.eventId)).toEqual([...out.map((r) => r.eventId)].sort());
  });
});
