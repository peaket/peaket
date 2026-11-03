// 계약에서 만든 스키마가 계약대로 받고 거르는지 본다(바깥 행동, docs/api/guidelines.md §1, 기술 검토 중간-085)
import { describe, expect, test } from 'vitest';
import { OrderEvent, RumSample } from '@peaket/contracts/asyncapi';
import { BehaviorSummary, PaymentAcceptToss, Problem } from '@peaket/contracts/openapi/model';
import { PostV1QueuesEventIdLobbyParticipantsResponse } from '@peaket/contracts/openapi/queue';

describe('OpenAPI 구성 요소 스키마', () => {
  test('중간085_Problem본문을받고_상태코드가숫자가아니면_거른다', () => {
    const p = { type: 'https://peaket.example/problems/seat-already-held', title: '이미 잡힌 좌석', status: 409, suggestedSeats: ['A-1'] };
    expect(Problem.parse(p)).toEqual(p);
    expect(Problem.safeParse({ ...p, status: '409' }).success).toBe(false);
  });

  test('중간085_행동신호요약_필수칸·열거·범위·없는칸을_계약대로거른다', () => {
    const ok = { v: 1, windowMs: 60000, pointerMoves: 12 };
    expect(BehaviorSummary.parse(ok)).toEqual(ok);
    expect(BehaviorSummary.safeParse({ v: 1 }).success).toBe(false); // windowMs 필수
    expect(BehaviorSummary.safeParse({ v: 2, windowMs: 1 }).success).toBe(false); // v는 1만
    expect(BehaviorSummary.safeParse({ v: 1, windowMs: 3600001 }).success).toBe(false); // 최대 3,600,000
    expect(BehaviorSummary.safeParse({ v: 1, windowMs: 1, rawKeys: 'abc' }).success).toBe(false); // additionalProperties: false
  });

  test('중간085_토스결제접수_결제사열거와필수칸', () => {
    expect(PaymentAcceptToss.safeParse({ pg: 'TOSS', paymentKey: 'k', amount: 55000 }).success).toBe(true);
    expect(PaymentAcceptToss.safeParse({ pg: 'PORTONE', paymentKey: 'k', amount: 55000 }).success).toBe(false);
    expect(PaymentAcceptToss.safeParse({ pg: 'TOSS', paymentKey: 'k' }).success).toBe(false);
  });
});

describe('OpenAPI 작업별 스키마', () => {
  test('중간085_로비입장응답_추가검증사유는_열거값이나null만받는다', () => {
    expect(PostV1QueuesEventIdLobbyParticipantsResponse.safeParse({ lobbyToken: 't', verificationReason: null }).success).toBe(true);
    expect(PostV1QueuesEventIdLobbyParticipantsResponse.safeParse({ lobbyToken: 't', verificationReason: 'RAPID_REQUESTS' }).success).toBe(true);
    expect(PostV1QueuesEventIdLobbyParticipantsResponse.safeParse({ lobbyToken: 't', verificationReason: 'UNKNOWN' }).success).toBe(false);
  });
});

describe('AsyncAPI 메시지 본문 스키마', () => {
  const order = {
    eventId: 'evt-1', orderId: 'ord-1', accountId: 'acc-1', type: 'CREATED', amount: 110000, seatIds: ['A-1'],
    items: [{ seatId: 'A-1', tierId: 'R', sectionId: 'A', price: 110000 }], seatAssignment: 'PICK',
    occurredAt: '2026-11-01T10:00:00+09:00', eventKey: '0190f3a1-7c2e-7a00-8000-000000000001',
  };

  test('중간085_주문사건_필수칸이빠지거나_종류가열거밖이면_거른다', () => {
    expect(OrderEvent.safeParse(order).success).toBe(true);
    const { eventKey: _drop, ...noKey } = order;
    expect(OrderEvent.safeParse(noKey).success).toBe(false);
    expect(OrderEvent.safeParse({ ...order, type: 'SHIPPED' }).success).toBe(false);
  });

  test('중간085_주문사건_가명칸계산실패표시는_기본값false다', () => {
    expect(OrderEvent.parse(order).refMissing).toBe(false);
  });

  test('중간085_브라우저지표묶음_형식판은2만받는다', () => {
    const rum = { schemaVersion: 2, eventKey: '0190f3a1-7c2e-7a00-8000-000000000002', app: 'web', route: '/events/[id]' };
    expect(RumSample.safeParse(rum).success).toBe(true);
    expect(RumSample.safeParse({ ...rum, schemaVersion: 1 }).success).toBe(false);
  });
});
