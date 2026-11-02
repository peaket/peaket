// 좌석 v0 유스케이스(docs/features/seat-hold.md §14): 좌석 목록, 홀드, 해제, 연장, 만료.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, ProblemError, serverBusy } from '@peaket/platform';
import { EXPIRE_BATCH, kstIso, type HoldRecord, type HoldView, type SeatView } from '../domain/inventory.js';
import { ADMISSION_CHECK, SEAT_STORE, type AdmissionCheck, type SeatStore } from '../domain/ports.js';

/** 요청한 사람(게이트웨이 신원 머리) */
export interface Requester {
  accountId: string;
  pid: string;
}

// 오류 이름(§14 '오류 이름'). 경합 패배 409는 업무상 정상 분기라 오류 통계와 따로 센다(guidelines §2, NFR-003)
const notAdmitted = () => new ProblemError({ type: 'not-admitted', status: 403, title: '이 회차에 입장하지 않았습니다' });
const seatsNotFound = () => new ProblemError({ type: 'seats-not-found', status: 404, title: '좌석을 열지 않은 회차입니다' });
const invalidSeat = () => new ProblemError({ type: 'invalid-seat', status: 422, title: '고를 수 없는 좌석이 있습니다' });
const seatAlreadyHeld = () => new ProblemError({ type: 'seat-already-held', status: 409, title: '좌석이 이미 선택되었습니다', normalBranch: true });
const purchaseLimit = () => new ProblemError({ type: 'purchase-limit-exceeded', status: 422, title: '1인 매수 한도를 넘습니다' });
const holdNotFound = () => new ProblemError({ type: 'hold-not-found', status: 404, title: '홀드를 찾을 수 없습니다' });
const alreadyExtended = () => new ProblemError({ type: 'hold-already-extended', status: 409, title: '홀드는 한 번만 연장할 수 있습니다', normalBranch: true });

const view = (h: HoldRecord): HoldView => ({ holdId: h.holdId, seatIds: [...h.seatIds], expiresAt: kstIso(h.expiresAtMs), extendable: !h.extended });

@Injectable()
export class InventoryService {
  constructor(
    @Inject(SEAT_STORE) private readonly store: SeatStore,
    @Inject(ADMISSION_CHECK) private readonly admission: AdmissionCheck,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 그 회차에 입장했는지(아니면 403 not-admitted) */
  async requireAdmitted(eventId: string, pid: string): Promise<void> {
    if (!(await this.admission.isAdmitted(eventId, pid))) throw notAdmitted();
  }

  async seats(eventId: string, who: Requester): Promise<{ eventId: string; seats: SeatView[] }> {
    await this.requireAdmitted(eventId, who.pid);
    const seats = await this.store.seats(eventId);
    if (!seats) throw seatsNotFound();
    return { eventId, seats };
  }

  async hold(eventId: string, who: Requester, seatIds: string[]): Promise<HoldView> {
    await this.requireAdmitted(eventId, who.pid);
    if (new Set(seatIds).size !== seatIds.length) throw invalidSeat();
    const r = await this.store.hold(eventId, who.accountId, seatIds, this.clock.now());
    switch (r.kind) {
      case 'held':
        return view(r.hold);
      case 'seats-not-found':
        throw seatsNotFound();
      case 'invalid-seat':
        throw invalidSeat();
      case 'seat-already-held':
        throw seatAlreadyHeld();
      case 'purchase-limit-exceeded':
        throw purchaseLimit();
      case 'busy':
        throw serverBusy();
    }
  }

  async release(holdId: string, who: Requester): Promise<void> {
    const r = await this.store.release(holdId, who.accountId, this.clock.now());
    switch (r.kind) {
      case 'released':
      case 'already-ended':
        return;
      case 'hold-not-found':
        throw holdNotFound();
      case 'busy':
        throw serverBusy();
    }
  }

  async extend(holdId: string, who: Requester): Promise<HoldView> {
    const r = await this.store.extend(holdId, who.accountId, this.clock.now());
    switch (r.kind) {
      case 'extended':
        return view(r.hold);
      case 'hold-already-extended':
        throw alreadyExtended();
      case 'hold-not-found':
        throw holdNotFound();
      case 'busy':
        throw serverBusy();
    }
  }

  /** 만료 시각이 지난 홀드를 푼다(만료 루프가 부른다). 푼 수 */
  async expireDue(): Promise<number> {
    return this.store.expireDue(this.clock.now(), EXPIRE_BATCH);
  }
}
