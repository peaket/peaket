// 입장 확정(openapi POST /v1/queues/{eventId}/admission, docs/features/queue-admission.md §6 '입장 확정의 첫 구현', FR-008, POL-002·008, ADR-0056·0104·0183).
// ① 회차 슬롯 확인(읽기만) → ② 사람 슬롯 q:adm → ③ 회차 슬롯 입장(빈자리·곧 입장) → ④ 사람 슬롯 마무리. 이름은 명세 specs/queue.qnt의 admit이다.
// ①에서 걸리는 대기표(만료·빠진 번호·차례 전)는 q:adm을 건드리지 않는다. ②가 새로 채운 값은 입장하지 않으면(SOON·장애) 지운다(ADR-0183 결정 3).
// 요청마다 표지(fresh) 하나를 만들어 q:adm 값의 표지와 새 자리의 jti로 함께 쓴다. 같은 대기표가 받은 자리는 회차 슬롯 slot_of가 가린다(결정 2).
// pid 키 전환 기간에는 ②·④와 15분 만료를 옛 pid → 새 pid 두 키에 차례로 한다(§3 'pid 키 전환 기간'의 첫 구현, BUILD_ORDER BOT-025, Q-T45).
// 추가 검증(§7, ADR-0259): 빠진 번호라도 verify가 PASSED면 받고(차례 전이면 NOT_YET), 유예는 차례와 통과 가운데 늦은 때부터 센다. BLOCKED는 410에 removeReason을 단다.
// 1인 1순번 위반(②의 DUP)으로 거절하는 대기표는 회차 슬롯에서 빠진 번호를 켜며 그 verify 칸(PASSED·VERIFYING)을 지운다(사람 슬롯이 먼저 정한다, docs/data.md §5 경합 ④).
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { candidateEligibilityLists, type EventSchedules, keepUntilOf, type QueueTokens, QueueStoreUnavailable, REASONS, saleEndOf, seatmapLayoutPathOf } from '../../entry/index.js';
import { ETA_MAX_AGE_MS, ETA_MAX_SEC, LOBBY_PENDING_RETRY_MS, TURN_GRACE_MS } from '../domain/admission.js';
import { ADMISSION_POLICY, ADMISSION_SIGNALS, ADMISSION_STORE, ADMISSION_TOKENS, type AdmissionPolicy, type AdmissionSignals, type AdmissionStore, type AdmissionTokens } from '../domain/ports.js';
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
  | { status: 'ADMITTED'; admissionToken: string; purchaseSessionExpiresAt: string; serverTimeMs: number; verificationReason: null; seatmapLayoutPath?: string; serverEcdhPublicKey?: Record<string, string> }
  | { status: 'SOON'; retryAfterSeconds: number; serverTimeMs: number; verificationReason: null }
  | { status: 'NOT_YET'; retryAfterMs: number; serverTimeMs: number; verificationReason: null }
  | { status: 'VERIFYING'; verificationReason: string | null; serverTimeMs: number };

@Injectable()
export class ConfirmAdmission {
  /** 차례(또는 통과) 뒤 유예(기본 15분) */
  readonly #graceMs: number;

  constructor(
    @Inject(ADMISSION_STORE) private readonly store: AdmissionStore,
    @Inject(ADMISSION_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(ADMISSION_TICKETS) private readonly tickets: QueueTokens,
    @Inject(ADMISSION_TOKENS) private readonly signer: AdmissionTokens,
    @Inject(ADMISSION_SIGNALS) private readonly signals: AdmissionSignals,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(ADMISSION_POLICY) policy?: AdmissionPolicy,
  ) {
    const g = policy?.turnGraceMs ?? TURN_GRACE_MS;
    if (!Number.isInteger(g) || g <= 0) throw new Error(`입장 확정 유예는 양의 정수(ms)여야 한다: ${g}`);
    this.#graceMs = g;
  }

  async run(i: ConfirmInput): Promise<ConfirmResult> {
    const now = this.clock.now();
    const b = i.body;
    // 우선 구매 권리(GAT-135)는 아직 받지 않는다. 사본이 없으니 정본의 '없음'과 같은 응답이다
    if (b.priorityGrantId) throw new AdmissionError('PRIORITY_GRANT_NOT_FOUND', '우선 구매 권리 사본이 없다(GAT-135 전)');
    const presented = b.queueTicket ?? b.lobbyToken;
    if (!presented) throw new AdmissionError('TICKET_INVALID', '대기표도 참가 토큰도 없다');
    const hash = this.tickets.hash(presented);
    // MAC·회차·계정을 먼저 보고, 일정·판매 종료를 본 뒤에 번호를 읽는다(판매 종료 뒤 참가 토큰이 NOT_YET을 끝없이 받지 않게)
    const ticket = b.queueTicket ? this.tickets.readTicket(b.queueTicket) : null;
    const lobby = b.queueTicket ? null : this.tickets.readLobby(b.lobbyToken!);
    if (b.queueTicket ? !ticket || ticket.e !== i.eventId || ticket.a !== i.accountId : !lobby || lobby.e !== i.eventId || lobby.a !== i.accountId) {
      throw new AdmissionError('TICKET_INVALID', '대기표·참가 토큰의 MAC·회차·계정이 맞지 않는다');
    }
    const schedule = await this.schedules.get(i.eventId);
    if (!schedule) throw new AdmissionError('NOT_FOUND', '회차 일정 사본이 없다');
    const saleEnd = saleEndOf(schedule);
    if (now >= saleEnd) throw new AdmissionError('SALE_ENDED', '판매 종료 뒤의 입장 확정');
    // 대기표는 번호·세대를 스스로 지니고, 참가 토큰은 셔플 결과에서 번호를 읽는다(ADR-0231 결정 10). 만료 때 지울 q:dup 값의 앞머리도 다르다
    let subject: { s: number; g: number; jny: string; dupPrefix?: string };
    if (ticket) {
      subject = { s: ticket.s, g: ticket.g, jny: ticket.jny };
    } else {
      const seat = await this.store.lobbySeat({ eventId: i.eventId, tokenHash: hash, nowMs: now });
      if (seat.kind === 'PENDING') return { status: 'NOT_YET', retryAfterMs: LOBBY_PENDING_RETRY_MS, serverTimeMs: now, verificationReason: null };
      if (seat.kind === 'REPAIRING') throw new AdmissionError('LOBBY_REPAIRING', '셔플 결과 키를 잃어 다시 쓰기를 기다린다');
      if (seat.kind === 'GONE') throw new AdmissionError('TICKET_INVALID', '이 회차 로비 참가자가 아니다');
      subject = { s: seat.seq, g: seat.gen, jny: lobby!.jny, dupPrefix: `LOBBY:${hash}:` };
    }
    const t = subject;
    const keepUntil = keepUntilOf(schedule);
    // 사람 키를 부를 pid들(옛 pid부터, 교체 직전 토큰과 두 pid 토큰이 옛 키에서 만나게)
    const persons = i.pidPrev && i.pidPrev !== i.pid ? [i.pidPrev, i.pid] : [i.pid];

    const pre = await this.store.precheck({ eventId: i.eventId, seq: t.s, gen: t.g, ticketHash: hash, graceMs: this.#graceMs });
    switch (pre.kind) {
      case 'SOLD_OUT':
        throw new AdmissionError('SOLD_OUT', '매진으로 끝난 대기');
      case 'ENDED':
        throw new AdmissionError('SALE_ENDED', '판매 상태가 ENDED다');
      case 'REMOVED':
        throw new AdmissionError('REMOVED', pre.removeReason ? '이의 기각으로 끝난 대기 참여' : '빠진 번호', undefined, pre.removeReason);
      case 'VERIFYING': {
        const reason = REASONS.find((r) => r === pre.reason) ?? null;
        return { status: 'VERIFYING', verificationReason: reason, serverTimeMs: now };
      }
      case 'NOT_YET':
        return { status: 'NOT_YET', retryAfterMs: pre.retryAfterMs, serverTimeMs: now, verificationReason: null };
      case 'EXPIRED': {
        let admittedBefore = false;
        for (const pid of persons) admittedBefore = (await this.store.expire({ pid, eventId: i.eventId, seq: t.s, gen: t.g, ...(t.dupPrefix ? { dupPrefix: t.dupPrefix } : {}) })).admittedBefore || admittedBefore;
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
          // 거절하는 이 대기표의 번호를 빠진 번호로 켜고 verify 칸(통과·추가 검증 중)을 지운다. 여기서 끊기면 503이고, 다시 오면 사람 슬롯이 또 DUP을 정한다
          await this.store.markRemoved({ eventId: i.eventId, seq: t.s, ticketHash: hash, expireAtMs: keepUntil });
          throw new AdmissionError('DUPLICATE_ADMISSION', '같은 사람이 다른 대기표로 이미 입장했다');
        }
        if (claim.kind === 'NEW') claimed.push(pid);
      }
      // 입장 토큰 `lst`의 후보(eligLists와 모든 창 lists의 합). 설정이 틀리면 undefined라 싣지 않는다(ADR-0265 결정 7)
      const candidates = candidateEligibilityLists(schedule);
      const r = await this.store.admit({
        eventId: i.eventId,
        seq: t.s,
        ticketHash: hash,
        freshJti: fresh,
        ...(pre.turnAtMs !== undefined ? { turnAtMs: pre.turnAtMs } : {}),
        skipped: pre.skipped,
        keepUntilMs: keepUntil,
        soonExpireAtMs: saleEnd,
        ...(candidates && candidates.length > 0 ? { eligibility: { accountId: i.accountId, listKeys: candidates } } : {}),
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
        const { token, expiresAtMs } = this.signer.sign({ jti: r.jti, accountId: i.accountId, sessionId: i.sessionId, eventId: i.eventId, jny: t.jny, nowMs: now, ...(r.issuedAtMs !== undefined ? { firstIssuedAtMs: r.issuedAtMs } : {}), ...(r.lists && r.lists.length > 0 ? { lists: r.lists } : {}) });
        const ecdh = this.signer.serverEcdhPublicKey();
        // 입장 토큰의 exp(구매 세션이 끝나는 가장 늦은 때)를 화면이 토큰을 읽지 않고 알게 싣는다(BAS-042, ADR-0214 결정 8)
        const purchaseSessionExpiresAt = new Date(expiresAtMs).toISOString();
        const seatmapLayoutPath = seatmapLayoutPathOf(i.eventId, schedule);
        return { status: 'ADMITTED', admissionToken: token, purchaseSessionExpiresAt, serverTimeMs: now, verificationReason: null, ...(ecdh ? { serverEcdhPublicKey: ecdh } : {}), ...(seatmapLayoutPath ? { seatmapLayoutPath } : {}) };
      }
      await this.#release(i, claimed, hash, fresh, saleEnd);
      claimed = [];
      if (r.kind === 'SOON') return { status: 'SOON', retryAfterSeconds: r.retryAfterSeconds, serverTimeMs: now, verificationReason: null };
      if (r.kind === 'EXPIRED') {
        // 같은 자리를 다시 줄 수 있지만 첫 발급 + 최대 체류가 지났다: exp < iat 토큰을 내지 않고 만료로 답한다(만료 410과 같은 꼴, HOT-010 리뷰)
        let admittedBefore = false;
        for (const pid of persons) admittedBefore = (await this.store.expire({ pid, eventId: i.eventId, seq: t.s, gen: t.g, ...(t.dupPrefix ? { dupPrefix: t.dupPrefix } : {}) })).admittedBefore || admittedBefore;
        throw new AdmissionError('EXPIRED', '첫 발급 뒤 최대 체류가 지났다', !admittedBefore && now < saleEnd);
      }
      // 확인과 입장 사이에 빠진 번호가 됐거나(대기 취소·1인 1순번 위반이 통과 칸을 지움) serving이 모자라다(장애 전환으로 serving이 되돌아감)
      if (r.kind === 'REMOVED') throw new AdmissionError('REMOVED', '확인 뒤 빠진 번호가 됐다', undefined, r.removeReason);
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
