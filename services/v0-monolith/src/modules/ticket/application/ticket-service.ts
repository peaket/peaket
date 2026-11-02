// 검표 v0 유스케이스(docs/features/offline-gate.md §13 동작 2). 온라인 전용: 찍을 때마다 서버가 판정한다(K10의 v0).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, ProblemError, serverBusy } from '@peaket/platform';
import { kstIso } from '../../inventory/index.js';
import { TICKET_STORE, type TicketStore } from '../domain/ports.js';
import type { ScanVerdict } from '../domain/ticket.js';

const notAssigned = () => new ProblemError({ type: 'not-assigned', status: 403, title: '이 회차의 검표 스태프가 아닙니다' });

@Injectable()
export class TicketService {
  constructor(
    @Inject(TICKET_STORE) private readonly store: TicketStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 배정되지 않은 스태프는 403 not-assigned */
  async scan(eventId: string, staffAccountId: string, code: string): Promise<ScanVerdict> {
    const r = await this.store.scan(eventId, staffAccountId, code, this.clock.now());
    switch (r.kind) {
      case 'not-assigned':
        throw notAssigned();
      case 'busy':
        throw serverBusy();
      case 'invalid':
        return { result: 'INVALID' };
      case 'wrong-event':
        return { result: 'WRONG_EVENT' };
      case 'admitted':
        return { result: 'ADMIT', ticketId: r.ticketId, seatId: r.seatId, enteredAt: kstIso(r.enteredAtMs) };
      case 'already-entered':
        return { result: 'ALREADY_ENTERED', ticketId: r.ticketId, seatId: r.seatId, enteredAt: kstIso(r.enteredAtMs) };
    }
  }
}
