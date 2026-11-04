// 입장 확정(openapi POST /v1/queues/{eventId}/admission, docs/features/queue-admission.md §6 '입장 확정의 첫 구현', FR-008, POL-002·008, ADR-0056·0104·0183).
// ① 회차 슬롯 확인(읽기만) → ② 사람 슬롯 q:adm → ③ 회차 슬롯 입장(빈자리·곧 입장) → ④ 사람 슬롯 마무리. 이름은 명세 specs/queue.qnt의 admit이다.
// ①에서 걸리는 대기표(만료·빠진 번호·차례 전)는 q:adm을 건드리지 않는다. ②가 새로 채운 값은 입장하지 않으면(SOON·장애) 지운다(ADR-0183 결정 3).
// 요청마다 표지(fresh) 하나를 만들어 q:adm 값의 표지와 새 자리의 jti로 함께 쓴다. 같은 대기표가 받은 자리는 회차 슬롯 slot_of가 가린다(결정 2).
// pid 키 전환 기간에는 ②·④와 15분 만료를 옛 pid → 새 pid 두 키에 차례로 한다(§3 'pid 키 전환 기간'의 첫 구현, BUILD_ORDER BOT-025, Q-T45).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { type EventSchedules, keepUntilOf, type QueueTokens, QueueStoreUnavailable, REASONS, saleEndOf } from '../../entry/index.js';
import { ETA_MAX_AGE_MS, ETA_MAX_SEC } from '../domain/admission.js';
import { ADMISSION_SIGNALS, ADMISSION_STORE, ADMISSION_TOKENS, type AdmissionSignals, type AdmissionStore, type AdmissionTokens } from '../domain/ports.js';
import { AdmissionError } from './admission-error.js';

export const ADMISSION_SCHEDULES = Symbol('queue.AdmissionSchedules');
export const ADMISSION_TICKETS = Symbol('queue.AdmissionTickets');

export interface ConfirmInput {
  accountId: string;
  pid: string;
  /** pid 키 전환 기간의 옛 pid(X-User-Pid-Prev). 있고 pid와 다르면 두 키에 한다 */
  pidPrev?: string;
  /** 로그인 세션(입장 토큰 sid) */
  sessionId: string;
  eventId: string;
  /** firstEtaSec·firstEtaAtMs는 관측용이라 모양을 묻지 않고 받아, 맞지 않으면 버린다(입장을 막지 않는다, ADR-0183 결정 10) */
  body: { queueTicket?: string; lobbyToken?: string; priorityGrantId?: string; firstEtaSec?: unknown; firstEtaAtMs?: unknown };
}

/** 200 본문(openapi AdmissionResult) */
export type ConfirmResult =
  | { status: 'ADMITTED'; admissionToken: string; serverTimeMs: number; verificationReason: null; serverEcdhPublicKey?: Record<string, string> }
  | { status: 'SOON'; retryAfterSeconds: number; serverTimeMs: number; verificationReason: null }
  | { status: 'NOT_YET'; retryAfterMs: number; serverTimeMs: number; verificationReason: null }
  | { status: 'VERIFYING'; verificationReason: string | null; serverTimeMs: number };

@Injectable()
export class ConfirmAdmission {
  constructor(
    @Inject(ADMISSION_STORE) private readonly store: AdmissionStore,
    @Inject(ADMISSION_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(ADMISSION_TICKETS) private readonly tickets: QueueTokens,
    @Inject(ADMISSION_TOKENS) private readonly signer: AdmissionTokens,
    @Inject(ADMISSION_SIGNALS) private readonly signals: AdmissionSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: ConfirmInput): Promise<ConfirmResult> {
    const now = this.clock.now();
    const b = i.body;
    // 우선 구매 권리(GAT-135)와 참가 토큰(HOT-040)은 아직 받지 않는다. 사본·발급이 없으니 정본의 '없음'과 같은 응답이다
    if (b.priorityGrantId) throw new AdmissionError('PRIORITY_GRANT_NOT_FOUND', '우선 구매 권리 사본이 없다(GAT-135 전)');
    if (!b.queueTicket) throw new AdmissionError('TICKET_INVALID', '대기표가 없다(참가 토큰 입장 확정은 HOT-040)');
    const t = this.tickets.readTicket(b.queueTicket);
    if (!t || t.e !== i.eventId || t.a !== i.accountId) throw new AdmissionError('TICKET_INVALID', '대기표의 MAC·회차·계정이 맞지 않는다');
    const schedule = await this.schedules.get(i.eventId);
    if (!schedule) throw new AdmissionError('NOT_FOUND', '회차 일정 사본이 없다');
    const saleEnd = saleEndOf(schedule);
    if (now >= saleEnd) throw new AdmissionError('SALE_ENDED', '판매 종료 뒤의 입장 확정');
    const hash = this.tickets.hash(b.queueTicket);
    const keepUntil = keepUntilOf(schedule);
    // 사람 키를 부를 pid들(옛 pid부터, 교체 직전 토큰과 두 pid 토큰이 옛 키에서 만나게)
    const persons = i.pidPrev && i.pidPrev !== i.pid ? [i.pidPrev, i.pid] : [i.pid];

    const pre = await this.store.precheck({ eventId: i.eventId, seq: t.s, gen: t.g, ticketHash: hash });
    switch (pre.kind) {
      case 'SOLD_OUT':
        throw new AdmissionError('SOLD_OUT', '매진으로 끝난 대기');
      case 'ENDED':
        throw new AdmissionError('SALE_ENDED', '판매 상태가 ENDED다');
      case 'REMOVED':
        throw new AdmissionError('REMOVED', '빠진 번호');
      case 'VERIFYING': {
        const reason = REASONS.find((r) => r === pre.reason) ?? null;
        return { status: 'VERIFYING', verificationReason: reason, serverTimeMs: now };
      }
      case 'NOT_YET':
        return { status: 'NOT_YET', retryAfterMs: pre.retryAfterMs, serverTimeMs: now, verificationReason: null };
      case 'EXPIRED': {
        let admittedBefore = false;
        for (const pid of persons) admittedBefore = (await this.store.expire({ pid, eventId: i.eventId, seq: t.s, gen: t.g })).admittedBefore || admittedBefore;
        this.signals.turnEntryFailed('user');
        throw new AdmissionError('EXPIRED', '차례 뒤 15분이 지났다', !admittedBefore && now < saleEnd);
      }
      case 'OK':
        break;
    }

    // 차례가 왔다. 여기부터의 저장소 일시 장애는 차례가 온 사람의 시스템 원인 실패다(Q-T28)
    const fresh = randomUUID();
    // 이 요청이 새로 채운 q:adm의 pid들. 입장하지 않으면(SOON·장애·다른 키의 DUP) 지운다
    let claimed: string[] = [];
    try {
      for (const pid of persons) {
        const claim = await this.store.claim({ pid, eventId: i.eventId, ticketHash: hash, nonce: fresh, expireAtMs: saleEnd });
        if (claim.kind === 'DUP') {
          await this.#release(i, claimed, hash, fresh, saleEnd);
          claimed = [];
          await this.store.markRemoved({ eventId: i.eventId, seq: t.s, expireAtMs: keepUntil });
          throw new AdmissionError('DUPLICATE_ADMISSION', '같은 사람이 다른 대기표로 이미 입장했다');
        }
        if (claim.kind === 'NEW') claimed.push(pid);
      }
      const r = await this.store.admit({
        eventId: i.eventId,
        seq: t.s,
        ticketHash: hash,
        freshJti: fresh,
        ...(pre.turnAtMs !== undefined ? { turnAtMs: pre.turnAtMs } : {}),
        skipped: pre.skipped,
        keepUntilMs: keepUntil,
        soonExpireAtMs: saleEnd,
      });
      if ('arrivalDelayMs' in r && r.arrivalDelayMs !== undefined) this.signals.arrivalDelay(r.arrivalDelayMs / 1000);
      if (r.kind === 'ADMITTED') {
        // 입장했으니 되돌리지 않는다: 마무리가 중간에 오류로 끝나도 이미 마무리한 키의 q:adm을 지우지 않는다(같은 대기표로 다시 오면 마무리한다)
        claimed = [];
        // ADMITTED면 q:adm을 이 요청의 표지로 다시 쓰고(없으면 되살린다) q:dup을 지운다(두 키면 둘 다)
        for (const pid of persons) await this.store.settle({ pid, eventId: i.eventId, ticketHash: hash, outcome: 'ADMITTED', nonce: fresh, expireAtMs: saleEnd });
        // 입장 Lua가 이미 막으므로 늘 0이다. 그 확인이 빠지는 코드 퇴행을 잡는 감시다(ADR-0183 결정 7)
        if (t.s > r.serving) this.signals.admittedBeforeTurn();
        if (r.soonWaitMs !== undefined) this.signals.soonWait(r.soonWaitMs / 1000);
        if (r.firstSlot) this.#eta(b, pre.turnAtMs, now);
        const { token } = this.signer.sign({ jti: r.jti, accountId: i.accountId, sessionId: i.sessionId, eventId: i.eventId, jny: t.jny, nowMs: now });
        const ecdh = this.signer.serverEcdhPublicKey();
        return { status: 'ADMITTED', admissionToken: token, serverTimeMs: now, verificationReason: null, ...(ecdh ? { serverEcdhPublicKey: ecdh } : {}) };
      }
      await this.#release(i, claimed, hash, fresh, saleEnd);
      claimed = [];
      if (r.kind === 'SOON') return { status: 'SOON', retryAfterSeconds: r.retryAfterSeconds, serverTimeMs: now, verificationReason: null };
      // 확인과 입장 사이에 빠진 번호가 됐거나 serving이 모자라다(장애 전환으로 serving이 되돌아감)
      if (r.kind === 'REMOVED') throw new AdmissionError('REMOVED', '확인 뒤 빠진 번호가 됐다');
      return { status: 'NOT_YET', retryAfterMs: 1_000, serverTimeMs: now, verificationReason: null };
    } catch (e) {
      if (e instanceof QueueStoreUnavailable) {
        this.signals.turnEntryFailed('system');
        // 입장하지 않았으니 이 요청이 새로 채운 q:adm은 지운다(최선 노력)
        await this.#release(i, claimed, hash, fresh, saleEnd).catch(() => undefined);
      }
      throw e;
    }
  }

  /** 이 요청이 새로 채운 q:adm만 지운다(값이 이 요청이 채운 그대로일 때만) */
  async #release(i: ConfirmInput, pids: readonly string[], hash: string, nonce: string, saleEnd: number): Promise<void> {
    for (const pid of pids) await this.store.settle({ pid, eventId: i.eventId, ticketHash: hash, outcome: 'RELEASE', nonce, expireAtMs: saleEnd });
  }

  /** 예상 대기 오차(관측용): (차례 시각 − 처음 보인 시각) ÷ 처음 예상 대기. 범위 밖이면 버린다(ADR-0183 결정 10) */
  #eta(b: ConfirmInput['body'], turnAtMs: number | undefined, now: number): void {
    const sec = b.firstEtaSec;
    const at = b.firstEtaAtMs;
    if (turnAtMs === undefined || typeof sec !== 'number' || typeof at !== 'number') return;
    if (!Number.isFinite(sec) || sec <= 0 || sec > ETA_MAX_SEC || !Number.isFinite(at) || at > now || at < now - ETA_MAX_AGE_MS || turnAtMs < at) return;
    this.signals.etaError((turnAtMs - at) / 1000 / sec);
  }
}
