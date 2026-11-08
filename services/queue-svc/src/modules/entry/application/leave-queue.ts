// 로비 참가 취소와 대기 취소(openapi DELETE /v1/queues/{eventId}/lobby-participants/me·entries/me, docs/features/queue-admission.md §4 '대기 취소·로비 참가 취소의 첫 구현', FR-007, POL-002, ADR-0060·0233).
// 사람 키와 회차 키는 해시 슬롯이 달라 Lua 하나로 묶지 못한다. ① 사람 키를 '취소 중'으로 잡고 ② 회차 슬롯의 일을 하고 ③ '취소 끝' 표지로 바꾼다.
// 잡는 동안에는 그 사람이 다시 참가하지 못하므로 회차 슬롯의 일이 새 참가를 건드리지 않는다. 중간에 실패해도 취소 중 표지가 원래 기록을 품어 같은 취소를 다시 보내면 끝난다.
// pid 키 전환 기간에는 옛 pid와 새 pid 두 키를 잡고, 서로 다른 기록을 한 번씩만 처리한다(§3 'pid 키 전환 기간'의 첫 구현). 이름은 명세 specs/queue.qnt의 leave다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ENTRY_STORE, type EntryStore, EVENT_SCHEDULES, type EventSchedules, LEAVE_SIGNALS, type LeaveSignals, noLeaveSignals, type ShuffleGroup } from '../domain/ports.js';
import { type EventSchedule, type HeldRecord, keepUntilOf, leavingOf, leftOf, saleEndOf } from '../domain/queue.js';
import { EntryError } from './entry-error.js';

export interface LeaveInput {
  eventId: string;
  pid: string;
  /** pid 키 전환 기간의 옛 pid(X-User-Pid-Prev) */
  pidPrev?: string;
}

interface Held {
  pid: string;
  rec: HeldRecord;
}

/** 값이 바뀐 사람 키를 다시 읽는 횟수 [가정]. 묶음 기록이 번호 기록으로 바뀌는 것 한 번이면 끝난다 */
const CLAIM_ATTEMPTS = 3;
const LOBBY_ROUTE = '/v1/queues/{eventId}/lobby-participants/me';
const ENTRY_ROUTE = '/v1/queues/{eventId}/entries/me';

/** 기록을 가리키는 값(두 pid 키에 같은 기록이 있으면 한 번만 처리한다) */
const idOf = (r: HeldRecord): string => (r.kind === 'NUMBER' ? `N:${r.seq}:${r.gen}` : `${r.kind}:${r.tokenHash}`);

@Injectable()
export class LeaveQueue {
  constructor(
    @Inject(ENTRY_STORE) private readonly store: EntryStore,
    @Inject(EVENT_SCHEDULES) private readonly schedules: EventSchedules,
    @Optional() @Inject(LEAVE_SIGNALS) private readonly signals: LeaveSignals = noLeaveSignals,
  ) {}

  /** 로비 참가 취소: 목록을 고정하기 전에만 받는다(그 뒤는 대기 취소로, §3 '표시가 선 뒤에는') */
  async lobby(i: LeaveInput): Promise<void> {
    const schedule = await this.schedules.get(i.eventId);
    if (!schedule || !schedule.lobbyShuffle) throw new EntryError('NOT_FOUND', '로비가 없는 회차다');
    const held = await this.#claim(i, (r) => r.kind === 'LOBBY');
    if (held.length === 0) throw new EntryError('LOBBY_PARTICIPANT_NOT_FOUND', '이 사람의 로비 참가 기록이 없다');
    const seen = new Set<string>();
    for (const { rec } of held) {
      if (rec.kind !== 'LOBBY' || seen.has(rec.tokenHash)) continue;
      seen.add(rec.tokenHash);
      const r = await this.store.leaveMember({ eventId: i.eventId, group: 'lobby', tokenHash: rec.tokenHash, closesAtMs: schedule.opensAtMs, verifyExpireAtMs: saleEndOf(schedule) });
      if (r === 'CLOSED') {
        // 409는 아무것도 바꾸지 않는다: 잡았던 기록을 되돌린다
        for (const h of held) await this.store.swapHeld({ pid: h.pid, eventId: i.eventId, from: leavingOf(h.rec), to: h.rec.plain });
        throw new EntryError('LOBBY_CLOSED', '로비가 닫혔다');
      }
    }
    await this.#finish(i.eventId, held);
    this.signals.left(LOBBY_ROUTE);
  }

  /** 대기 취소: 번호·묶음·로비 기록 무엇이든 그 사람의 참가를 끝낸다. 기록이 없으면 아무것도 바꾸지 않는다 */
  async entry(i: LeaveInput): Promise<void> {
    const schedule = await this.schedules.get(i.eventId);
    if (!schedule) throw new EntryError('NOT_FOUND', '이 회차의 대기열이 열리지 않았다');
    const held = await this.#claim(i, () => true);
    if (held.length === 0) return;
    const seen = new Set<string>();
    for (const { rec } of held) {
      if (seen.has(idOf(rec))) continue;
      seen.add(idOf(rec));
      await this.#leave(i.eventId, schedule, rec);
    }
    await this.#finish(i.eventId, held);
    this.signals.left(ENTRY_ROUTE);
  }

  /**
   * 키마다(옛 pid → 새 pid) 기록을 읽어 '취소 중'으로 잡는다. 읽은 값과 같을 때만 바꾸므로 잡은 뒤에는 그 기록이 그대로다.
   * 값이 바뀌었으면 다시 읽는다: 같은 요청 ID면(묶음 기록이 번호 기록으로 바뀜) 그 기록을 잡고, 다른 요청 ID면 다시 참가한 새 기록이라 건드리지 않는다
   */
  async #claim(i: LeaveInput, wanted: (r: HeldRecord) => boolean): Promise<Held[]> {
    const persons = i.pidPrev && i.pidPrev !== i.pid ? [i.pidPrev, i.pid] : [i.pid];
    const out: Held[] = [];
    for (const pid of persons) {
      let requestId: string | undefined;
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
        const rec = await this.store.readHeld({ pid, eventId: i.eventId });
        if (!rec || !wanted(rec) || (requestId !== undefined && rec.requestId !== requestId)) break;
        requestId = rec.requestId;
        const leaving = leavingOf(rec);
        if (rec.value === leaving || (await this.store.swapHeld({ pid, eventId: i.eventId, from: rec.value, to: leaving }))) {
          out.push({ pid, rec });
          break;
        }
      }
    }
    return out;
  }

  /** 회차 슬롯의 일. 목록을 고정한 뒤의 참가는 표시를 쓴 뒤 결과 키를 읽는다(게시는 결과 키를 쓴 뒤 표시를 읽어 어떻게 겹쳐도 둘 중 하나가 번호를 돌린다) */
  async #leave(eventId: string, schedule: EventSchedule, rec: HeldRecord): Promise<void> {
    const expireAtMs = keepUntilOf(schedule);
    if (rec.kind === 'NUMBER') {
      await this.store.leaveNumber({ eventId, seq: rec.seq, ...(rec.ticketHash ? { ticketHash: rec.ticketHash } : {}), expireAtMs });
      return;
    }
    const group: ShuffleGroup = rec.kind === 'LOBBY' ? 'lobby' : 1;
    const r = await this.store.leaveMember({ eventId, group, tokenHash: rec.tokenHash, verifyExpireAtMs: saleEndOf(schedule) });
    if (r !== 'FIXED') return;
    const seat = await this.store.resultSeat({ group, tokenHash: rec.tokenHash });
    if (seat) await this.store.leaveNumber({ eventId, seq: seat.seq, ticketHash: rec.tokenHash, expireAtMs });
  }

  /** 회차 슬롯의 일을 마친 뒤 취소 끝 표지로 바꾼다. 다른 요청 ID의 다시 참가에는 빈 키와 같고, 같은 요청 ID의 재전송에는 '취소됨'이다 */
  async #finish(eventId: string, held: readonly Held[]): Promise<void> {
    for (const { pid, rec } of held) await this.store.swapHeld({ pid, eventId, from: leavingOf(rec), to: leftOf(rec) });
  }
}
