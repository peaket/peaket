// 탈퇴 참여자의 ticket-svc 몫(docs/features/identity.md §8, docs/features/transfer-refund.md §4, ADR-0284, I-T43 ①).
// 한 번 부르면 ① 받은 표를 결제자에게 돌려주고(동결 중이면 키만 폐기) ② 보낸 OFFERED를 WITHDRAWN(ACCOUNT_DELETED)
// ③ 받은 OFFERED를 REJECTED로 끝낸다. 남은 것이 없으면 DONE, 있으면 PENDING이다(다시 불러도 된다).
import type { Clock } from '@peaket/platform';
import type { TransferStore } from '../domain/transfer-ports.js';
import type { Transfers } from './transfers.js';

export interface TransferWithdrawalResult {
  readonly state: 'DONE' | 'PENDING';
  readonly returnedTickets: number;
  readonly withdrawnOffers: number;
  readonly rejectedOffers: number;
  readonly pendingReceivedTickets: number;
  readonly pendingSentOffers: number;
  readonly pendingReceivedOffers: number;
}

export interface TransferWithdrawalDeps {
  readonly transfers: Transfers;
  readonly store: TransferStore;
  readonly clock: Clock;
}

export class TransferWithdrawal {
  constructor(private readonly d: TransferWithdrawalDeps) {}

  async run(i: { readonly accountId: string; readonly nowMs?: number }): Promise<TransferWithdrawalResult> {
    const nowMs = i.nowMs ?? this.d.clock.now();
    const store = this.d.store;
    let returnedTickets = 0;
    let withdrawnOffers = 0;
    let rejectedOffers = 0;
    if (!store.accountTransfers) throw new Error('탈퇴 참여자 저장소가 accountTransfers를 구현하지 않았다');
    const listed = await store.accountTransfers({ accountId: i.accountId });

    for (const ticketId of listed.heldReceived) {
      try {
        if (!store.returnForAccount) throw new Error('returnForAccount가 없다');
        const r = await store.returnForAccount({ ticketId, accountId: i.accountId, nowMs });
        if (r === 'RETURNED') returnedTickets += 1;
      } catch {
        // 쓰기 실패·동결은 PENDING으로 남기고 다음 호출이 이어 간다(부분 성공을 DONE으로 접지 않는다)
      }
    }
    for (const offerId of listed.sentOffers) {
      try {
        if (!store.withdrawForAccount) throw new Error('withdrawForAccount가 없다');
        await store.withdrawForAccount({ offerId, accountId: i.accountId, nowMs });
        withdrawnOffers += 1;
      } catch {
        // 다음 호출이 다시 본다
      }
    }
    for (const offerId of listed.receivedOffers) {
      try {
        if (!store.rejectForAccount) throw new Error('rejectForAccount가 없다');
        await store.rejectForAccount({ offerId, accountId: i.accountId, nowMs });
        rejectedOffers += 1;
      } catch {
        // 다음 호출이 다시 본다
      }
    }

    const after = await store.accountTransfers({ accountId: i.accountId });
    const pendingReceivedTickets = after.heldReceived.length;
    const pendingSentOffers = after.sentOffers.length;
    const pendingReceivedOffers = after.receivedOffers.length;
    const state = pendingReceivedTickets + pendingSentOffers + pendingReceivedOffers === 0 ? 'DONE' : 'PENDING';
    return { state, returnedTickets, withdrawnOffers, rejectedOffers, pendingReceivedTickets, pendingSentOffers, pendingReceivedOffers };
  }
}
