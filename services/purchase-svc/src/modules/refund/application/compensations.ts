// 배상 목록·상세·계좌 입력(BAT-425 GAT-130 잔여, FR-056, ADR-0046 결정 5, ADR-0317, openapi /v1/compensations*).
// 목록·상세는 그 주문의 결제자 본인만 준다(없거나 남의 건은 같은 404). 계좌는 저장하지 않고 송금 요청에만 싣고, 기록에는 끝 4자리만 남긴다(POL-014).
// 계좌 입력은 ACCOUNT_PENDING일 때만 받고 재인증 op COMPENSATION_ACCOUNT·act FAN_HIGH_RISK를 본다.
// payment-svc RequestCompensationTransfer(compensation_id 멱등)가 REQUESTED·PAID면 202, FAILED면 422 + CS '배상 대기'(COMPENSATION_PENDING) 한 건,
// UNAVAILABLE이면 503 compensation-transfer-unavailable이다.
import { refundAccountShape } from '@peaket/validation/refund-account';
import { accountLast4Of, CompensationNotAccountPending, CompensationNotFound, CompensationTransferRejected, type CompensationPage, type CompensationView } from '../domain/compensation.js';
import { ReauthRequired } from '../domain/cancellation.js';
import { ReauthUnavailable, type CompensationCaseNotice, type CompensationStore, type CompensationTransfer, type ReauthGate } from '../domain/ports.js';
import type { RefundAccount } from '../domain/cancellation.js';
import { InvalidRefundAccount } from './request-refund-account.js';

/** 배상 목록·상세(openapi listCompensations·getCompensation). 계좌 입력은 RequestCompensationAccount가 맡는다 */
export class Compensations {
  constructor(private readonly store: CompensationStore) {}

  list(accountId: string, q?: { readonly cursor?: string; readonly limit?: number }): Promise<CompensationPage> {
    return this.store.list(accountId, q);
  }

  get(accountId: string, compensationId: string): Promise<CompensationView | undefined> {
    return this.store.get(accountId, compensationId);
  }
}

export interface RequestCompensationAccountInput {
  readonly accountId: string;
  readonly compensationId: string;
  readonly account: RefundAccount;
  readonly reauthToken: string | undefined;
  /** HTTP @Idempotent의 키. 같은 키의 다시 보냄은 송금을 새로 부르지 않는다(compensation_id 멱등이 깊은 방어) */
  readonly idempotencyKey: string;
  readonly sessionId?: string;
  readonly nowMs?: number;
}

export interface RequestCompensationAccountDeps {
  readonly store: CompensationStore;
  readonly transfer: CompensationTransfer;
  /** 송금 FAILED일 때 CS '배상 대기' 건을 연다. 없으면 건을 열지 않는다(시험 대역) */
  readonly notice?: CompensationCaseNotice;
  /** 없으면 재인증을 확인하지 않는다(단위 대역). 운영 조립은 늘 꽂는다 */
  readonly reauth?: ReauthGate;
  readonly nowMs?: () => number;
  /** purchase_compensation_total{result}: account_pending·requested·paid·failed·unavailable */
  readonly signals?: { readonly inc: (result: 'account_pending' | 'requested' | 'paid' | 'failed' | 'unavailable') => void };
  readonly log?: { warn(o: object, msg: string): void };
}

export class RequestCompensationAccount {
  constructor(private readonly o: RequestCompensationAccountDeps) {}

  async run(i: RequestCompensationAccountInput): Promise<CompensationView> {
    if (!refundAccountShape(i.account).ok) throw new InvalidRefundAccount();
    const record = await this.o.store.findForAccount(i.accountId, i.compensationId);
    if (!record) throw new CompensationNotFound();
    if (record.status !== 'ACCOUNT_PENDING') throw new CompensationNotAccountPending();
    if (this.o.reauth) {
      let passed: boolean;
      try {
        passed = await this.o.reauth.verify(i.reauthToken, {
          accountId: i.accountId,
          sessionId: i.sessionId ?? '',
          act: 'FAN_HIGH_RISK',
          op: 'COMPENSATION_ACCOUNT',
        });
      } catch (e) {
        if (e instanceof ReauthUnavailable) throw e;
        throw e;
      }
      if (!passed) throw new ReauthRequired();
    }
    const nowMs = i.nowMs ?? this.o.nowMs?.() ?? Date.now();
    const last4 = accountLast4Of(i.account.accountNumber);
    const result = await this.o.transfer.request({
      compensationId: record.compensationId,
      orderId: record.orderId,
      accountId: record.accountId,
      ...(record.promoterId !== undefined ? { promoterId: record.promoterId } : {}),
      eventId: record.eventId,
      amount: record.amount,
      account: i.account,
    });
    const saved = await this.o.store.saveTransfer({
      compensationId: record.compensationId,
      status: result.status,
      accountLast4: result.accountLast4 ?? last4,
      ...(result.transferId !== '' ? { transferId: result.transferId } : {}),
      ...(result.receivableId !== undefined ? { receivableId: result.receivableId } : {}),
      ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
      nowMs,
    });
    if (result.status === 'FAILED') {
      // 이 묶음에서는 재송금하지 않고 CS '배상 대기' 한 건으로 넘긴다(ADR-0317 결정 6). 건 열기 실패는 응답을 바꾸지 않는다
      try {
        await this.o.notice?.open({ compensationId: record.compensationId, orderId: record.orderId, nowMs });
      } catch (err) {
        this.o.log?.warn({ event: 'compensation-pending-case-failed', compensationId: record.compensationId, err: err instanceof Error ? err.name : 'unknown' }, '배상 대기 CS 건을 열지 못했다');
      }
      this.o.signals?.inc('failed');
      throw new CompensationTransferRejected();
    }
    this.o.signals?.inc(result.status === 'PAID' ? 'paid' : 'requested');
    const view = saved === undefined ? undefined : await this.o.store.get(i.accountId, record.compensationId);
    if (!view) throw new CompensationNotFound();
    return view;
  }
}
