// 결제 어댑터 공통 계약 시험 묶음(docs/features/payment.md §2.1 '어댑터 계약 테스트', ADR-0029 결정 3·6).
// 세 어댑터(시뮬레이터·토스페이먼츠·포트원)에 같은 시험을 돌린다. 어댑터마다 '대역 손잡이'(결제창 인증, 장애 넣기, 시계 밀기, 웹훅 꺼내기)를 준다.
// 토스·포트원은 wbs 2.7.1에서 붙인다(실제 샌드박스는 1일 1회 스모크).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CancelResult, CheckoutValues, ConfirmResult, PaymentGatewayPort } from '../src/modules/payment/domain/payment-gateway.js';

export interface PgContractHarness {
  gateway: PaymentGatewayPort;
  /** 구매자가 결제창 인증을 마친 것. 성공 주소로 받을 결제 참조를 돌려준다 */
  authenticate(orderId: string, amount: number): Promise<string>;
  /** 다음 승인을 결제사가 한도 초과로 거절한다 */
  declineNextConfirm(): Promise<void>;
  /** 다음 승인을 처리하되 응답을 잃는다(시간 초과와 같다) */
  dropNextConfirmAfterApply(): Promise<void>;
  /** 다음 승인을 ms만큼 늦춘다 */
  delayNextConfirm(ms: number): Promise<void>;
  /** 결제사 시계를 민다 */
  advance(ms: number): void;
  /** 그 결제의 마지막 상태 바뀜 웹훅(받은 그대로의 머리와 본문) */
  lastWebhook(paymentRef: string): Promise<{ headers: Record<string, string>; body: string }>;
  /** 결제사 원장에서 그 주문의 승인 수 */
  approvals(orderId: string): Promise<number>;
  close(): Promise<void>;
  /** 승인에 결제 토큰이 드는 결제사(포트원)의 토큰. 없으면 승인에 토큰을 싣지 않는다 */
  confirmTokenOf?(paymentRef: string): string;
  /**
   * 결제사에 그 뜻의 전용 코드가 없어 결과가 다른 항목의 기대값(없으면 묶음의 기본값). 항목을 건너뛰지 않고 값만 바꾼다(승인 0건은 그대로 본다, BUILD_ORDER HOT-140).
   * 포트원 공식 스키마의 승인 오류에는 카드 거절·승인 기한 만료 코드가 없고, 취소 답에는 남은 금액 칸이 없다(docs/features/payment.md §2.1 '포트원 어댑터의 첫 구현').
   * cancelled는 취소 답의 기대값이고, 남은 금액은 이어지는 조회로 그대로 본다
   */
  expectations?: { declined?: Partial<ConfirmResult>; expired?: Partial<ConfirmResult>; cancelled?: Partial<CancelResult> };
}

const checkoutOrder = (v: CheckoutValues): { orderRef: string; amount: number } => {
  if ('portone' in v) return { orderRef: v.portone.paymentId, amount: v.portone.totalAmount };
  const t = 'toss' in v ? v.toss : v.simulator;
  return { orderRef: t.orderId, amount: t.amount };
};

export function pgAdapterContract(name: string, setup: () => Promise<PgContractHarness>): void {
  describe(`결제 어댑터 공통 계약: ${name}`, () => {
    let h: PgContractHarness;
    beforeAll(async () => {
      h = await setup();
    });
    afterAll(async () => {
      await h?.close();
    });

    /** 승인 호출. 토큰이 드는 결제사면 토큰을 함께 싣는다 */
    const confirm = (c: { orderId: string; paymentRef: string; amount: number; idemKey: string }) => h.gateway.confirm({ ...c, ...(h.confirmTokenOf ? { confirmToken: h.confirmTokenOf(c.paymentRef) } : {}) });

    const approved = async (amount = 10_000) => {
      const orderId = randomUUID();
      const paymentRef = await h.authenticate(orderId, amount);
      const r = await confirm({ orderId, paymentRef, amount, idemKey: `confirm-${orderId}` });
      expect(r.outcome).toBe('APPROVED');
      return { orderId, paymentRef, amount };
    };

    it('결제창 값 생성: 주문·금액·돌아올 주소가 결제창 값에 든다', () => {
      const orderId = randomUUID();
      const v = h.gateway.checkout(
        { orderId, orderName: '공연 티켓 2매', amount: 154_000 },
        { attemptId: randomUUID(), successUrl: 'https://peaket.example/pay/success', failUrl: 'https://peaket.example/pay/fail' },
        'CARD',
      );
      const c = checkoutOrder(v);
      expect(c.orderRef.endsWith(orderId)).toBe(true);
      expect(c.amount).toBe(154_000);
      expect(JSON.stringify(v)).toContain('https://peaket.example/pay/success');
    });

    it('정상 승인: APPROVED이고 결제사 원장의 승인은 1건이다', async () => {
      const { orderId, paymentRef, amount } = await approved();
      expect(await h.approvals(orderId)).toBe(1);
      const q = await h.gateway.query(paymentRef);
      expect(q).toMatchObject({ kind: 'FOUND', status: 'APPROVED', amount, balanceAmount: amount, paymentRef });
    });

    it('한도 초과 거절: DECLINED, 실패 범주 CARD_DECLINED, 승인 0건', async () => {
      const orderId = randomUUID();
      const paymentRef = await h.authenticate(orderId, 10_000);
      await h.declineNextConfirm();
      const r = await confirm({ orderId, paymentRef, amount: 10_000, idemKey: `confirm-${orderId}` });
      expect(r).toMatchObject(h.expectations?.declined ?? { outcome: 'DECLINED', failureCategory: 'CARD_DECLINED' });
      expect(await h.approvals(orderId)).toBe(0);
    });

    it('동시 처리 중 경합: 같은 멱등키 둘 가운데 하나는 APPROVED, 하나는 IN_PROGRESS', async () => {
      const orderId = randomUUID();
      const paymentRef = await h.authenticate(orderId, 10_000);
      await h.delayNextConfirm(300);
      const c = { orderId, paymentRef, amount: 10_000, idemKey: `confirm-${orderId}` };
      const rs = await Promise.all([confirm(c), new Promise((r) => setTimeout(r, 50)).then(() => confirm(c))]);
      expect(rs.map((r) => r.outcome).sort()).toEqual(['APPROVED', 'IN_PROGRESS']);
      expect(await h.approvals(orderId)).toBe(1);
    });

    it('이미 승인된 건 재요청: 멱등 보관이 지난 뒤 다시 승인하면 조회로 맞춰 ALREADY_APPROVED, 승인 1건', async () => {
      const { orderId, paymentRef, amount } = await approved();
      h.advance(h.gateway.capabilities().idempotencyRetentionMs + 1);
      const r = await confirm({ orderId, paymentRef, amount, idemKey: `confirm-${orderId}` });
      expect(r).toMatchObject({ outcome: 'ALREADY_APPROVED', amount, paymentRef });
      expect(await h.approvals(orderId)).toBe(1);
    });

    it('시간 초과 뒤 단독 조회로 확정: 응답을 잃으면 UNKNOWN이고 조회는 APPROVED', async () => {
      const orderId = randomUUID();
      const paymentRef = await h.authenticate(orderId, 10_000);
      await h.dropNextConfirmAfterApply();
      const r = await confirm({ orderId, paymentRef, amount: 10_000, idemKey: `confirm-${orderId}` });
      expect(r.outcome).toBe('UNKNOWN');
      expect(await h.gateway.query(paymentRef)).toMatchObject({ kind: 'FOUND', status: 'APPROVED' });
      expect(await h.approvals(orderId)).toBe(1);
    });

    it('승인 기한 만료: 기한이 지나면 DECLINED, 실패 범주 EXPIRED, 승인 0건', async () => {
      const orderId = randomUUID();
      const paymentRef = await h.authenticate(orderId, 10_000);
      h.advance(h.gateway.capabilities().confirmDeadlineMs + 1_000);
      const r = await confirm({ orderId, paymentRef, amount: 10_000, idemKey: `confirm-${orderId}` });
      expect(r).toMatchObject(h.expectations?.expired ?? { outcome: 'DECLINED', failureCategory: 'EXPIRED' });
      expect(await h.approvals(orderId)).toBe(0);
    });

    it('부분 취소: CANCELLED이고 남은 금액이 준다', async () => {
      const { paymentRef } = await approved(10_000);
      const r = await h.gateway.cancel({ paymentRef, amount: 3_000, reason: '고객 요청', idemKey: `cancel-${randomUUID()}` });
      expect(r).toMatchObject(h.expectations?.cancelled ?? { outcome: 'CANCELLED', balanceAmount: 7_000 });
      expect(await h.gateway.query(paymentRef)).toMatchObject({ kind: 'FOUND', status: 'PARTIAL_CANCELED', balanceAmount: 7_000 });
    });

    it('전액 환불: CANCELLED, 남은 금액 0, 다시 전액 취소해도 CANCELLED', async () => {
      const { paymentRef } = await approved(10_000);
      expect(await h.gateway.cancel({ paymentRef, amount: 'ALL', reason: '회차 취소', idemKey: `cancel-${randomUUID()}` })).toMatchObject(h.expectations?.cancelled ?? { outcome: 'CANCELLED', balanceAmount: 0 });
      expect(await h.gateway.query(paymentRef)).toMatchObject({ kind: 'FOUND', status: 'CANCELED', balanceAmount: 0 });
      expect((await h.gateway.cancel({ paymentRef, amount: 'ALL', reason: '회차 취소', idemKey: `cancel-${randomUUID()}` })).outcome).toBe('CANCELLED');
    });

    it('웹훅 중복 수신: 같은 웹훅을 두 번 해석하면 같은 중복 제거 키이고 상태는 싣지 않는다', async () => {
      const { paymentRef } = await approved();
      const w = await h.lastWebhook(paymentRef);
      const a = h.gateway.parseWebhook(w.headers, w.body);
      const b = h.gateway.parseWebhook(w.headers, w.body);
      expect(a).not.toBeNull();
      expect(a).toEqual(b);
      expect(a!.dedupKey.length).toBeGreaterThan(0);
      expect(a!.paymentRef).toBe(paymentRef);
      expect(a).not.toHaveProperty('status');
    });
  });
}
