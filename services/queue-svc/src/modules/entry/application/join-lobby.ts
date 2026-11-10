// 로비 참가(openapi POST /v1/queues/{eventId}/lobby-participants, docs/features/queue-admission.md §2 '로비 참가와 커밋 공시의 첫 구현', FR-005, POL-002·004, ADR-0060·0171·0230).
// ① 사람 슬롯 선점 → 공시 기록 확인 → ② 위험 판정 → ③ 회차 슬롯 참가자 넣기 → ④ 사람 슬롯 기록. 사람 키와 회차 키는 해시 슬롯이 달라 한 Lua로 묶지 못한다.
// pid 키 전환 기간에는 ①·④를 옛 pid → 새 pid 두 키에 한다(§3 'pid 키 전환 기간'의 첫 구현, Q-T45).
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import { ALGORITHM, DRAND_CHAIN, drandRoundTimeMs } from '@peaket/shuffle';
import { DEGRADED_LIMITS, DEGRADED_RETRY_AFTER_SECONDS, type DegradedLimits, ELIGIBILITY_SIGNALS, type EligibilitySignals, ENTRY_STORE, type EntryStore, EVENT_SCHEDULES, type EventSchedules, FIRST_VISIT_COOKIES, FIRST_VISIT_SIGNALS, type FirstVisitCookies, type FirstVisitSignals, LOBBY_SIGNALS, type LobbySignals, noDegradedLimits, noEligibilitySignals, noFirstVisitSignals, noLobbySignals, QUEUE_TOKENS, type QueueTokens, RISK, type RiskClient, type RiskPort, type RiskVerdict } from '../domain/ports.js';
import { BATCH_SPREAD_SEC, eligibilityAt, LOBBY_UNLOCK_SPREAD_MS, lobbyOpensAtOf, PENDING_TTL_MS, type ReasonCategory, saleEndOf, SHUFFLE_PUBLISH_MS } from '../domain/queue.js';
import { EligibilityLog } from './eligibility-log.js';
import { EntryError } from './entry-error.js';
import { firstVisitAtMs } from './first-visit.js';
import { ShuffleCommits } from './shuffle-commits.js';

export interface JoinLobbyInput {
  eventId: string;
  accountId: string;
  pid: string;
  /** pid 키 전환 기간의 옛 pid(X-User-Pid-Prev). 위험 판정의 사람 식별값은 옛 pid다 */
  pidPrev?: string;
  body: { humanCheckToken?: string; deviceId?: string };
  /** 최초 방문 쿠키 값(있을 때만) */
  firstVisitCookie?: string;
  /** 게이트웨이가 넘긴 IP·ASN·UA·Client Hints(위험 판정 입력) */
  client?: RiskClient;
}

/** 201 본문(openapi LobbyToken) */
export interface JoinLobbyResult {
  lobbyToken: string;
  verification?: 'REQUIRED';
  verificationReason: ReasonCategory | null;
  seedHash: string;
  drandChain: string;
  drandRound: number;
  algorithmVersion: string;
  lobbyOpenedAt: string;
  shuffleResultAt: string;
  shuffleSpreadSec: number;
  serverTimeMs: number;
}

@Injectable()
export class JoinLobby {
  constructor(
    @Inject(ENTRY_STORE) private readonly store: EntryStore,
    @Inject(EVENT_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(QUEUE_TOKENS) private readonly tokens: QueueTokens,
    @Inject(RISK) private readonly risk: RiskPort,
    private readonly commits: ShuffleCommits,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(LOBBY_SIGNALS) private readonly signals: LobbySignals = noLobbySignals,
    @Optional() @Inject(DEGRADED_LIMITS) private readonly limits: DegradedLimits = noDegradedLimits,
    @Optional() @Inject(FIRST_VISIT_COOKIES) private readonly firstVisit?: FirstVisitCookies,
    @Optional() @Inject(FIRST_VISIT_SIGNALS) private readonly visitSignals: FirstVisitSignals = noFirstVisitSignals,
    @Optional() @Inject(ELIGIBILITY_SIGNALS) private readonly eligibilitySignals: EligibilitySignals = noEligibilitySignals,
    @Optional() private readonly eligibilityLog?: EligibilityLog,
  ) {}

  async run(i: JoinLobbyInput): Promise<JoinLobbyResult> {
    const schedule = await this.schedules.get(i.eventId);
    if (!schedule || !schedule.lobbyShuffle) throw new EntryError('NOT_FOUND', '로비가 없는 회차다');
    const requestId = randomUUID();
    const persons = i.pidPrev && i.pidPrev !== i.pid ? [i.pidPrev, i.pid] : [i.pid];
    await this.#preempt(i, persons, requestId);

    let recorded: string[] = [];
    try {
      // 판매 자격(ADR-0265 결정 1·5): 로비 참가는 오픈 시각으로 창을 고른다(오픈 10분 전에 와도 오픈에 시작하는 창이면 명단 대조를 지난다).
      // 설정 모양이 틀리면 창을 알 수 없으므로 그 회차 로비를 모두 403으로 막는다
      const checkedAt = this.clock.now();
      const elig = eligibilityAt(schedule, schedule.opensAtMs);
      if (elig.kind === 'INVALID') {
        this.eligibilitySignals.check({ path: 'lobby', result: 'config_invalid' });
        this.eligibilityLog?.warn('config_invalid', i.eventId, [], checkedAt);
        throw new EntryError('SALE_ELIGIBILITY_REQUIRED', '판매 자격 설정이 틀렸다');
      }
      // 공시 기록을 만들거나 판정을 부르기 전에 서버 시각으로 창을 본다. 창 밖 요청이 시드·라운드를 그때 일정으로 굳히거나 사람 확인 토큰을 쓰지 않게 한다(ADR-0231 결정 3)
      const window = await this.store.lobbyWindow({
        eventId: i.eventId,
        opensAtMs: schedule.opensAtMs,
        lobbyOpensAtMs: lobbyOpensAtOf(schedule),
        ...(elig.kind === 'GATED' ? { eligibility: { accountId: i.accountId, listKeys: elig.lists } } : {}),
      });
      if (window.kind === 'DENIED' || window.kind === 'COPY_MISSING') {
        this.eligibilitySignals.check({ path: 'lobby', result: window.kind === 'DENIED' ? 'denied' : 'copy_missing' });
        if (window.kind === 'COPY_MISSING') this.eligibilityLog?.warn('copy_missing', i.eventId, window.listKeys, checkedAt);
        throw new EntryError('SALE_ELIGIBILITY_REQUIRED', '이 판매 단계의 예매 대상이 아니다');
      }
      if (window.kind !== 'OPEN') throw new EntryError(window.kind === 'NOT_OPEN' ? 'NOT_OPEN' : 'LOBBY_CLOSED', '로비 창 밖의 참가');
      if (elig.kind === 'GATED') this.eligibilitySignals.check({ path: 'lobby', result: 'allowed' });
      const rec = await this.commits.ensure(i.eventId, 'lobby', schedule);
      const now = this.clock.now();
      const device = i.body.deviceId ?? '';
      // 409(이미 참가·이미 입장·창 밖)면 여기까지 오지 않으므로 jny를 만들지 않는다(ADR-0171)
      const jny = uuidv7(this.clock);
      const verdict = await this.#score(i, device, jny, schedule.lobbyShuffle);
      // 판정을 받지 못한 동안에만 파드 메모리 한도를 건다(§11.2). 넘으면 선점을 풀고 429다
      if (verdict.kind === 'UNAVAILABLE' && !this.limits.allow({ deviceId: device, pid: i.pid, ...(i.client ? { client: i.client } : {}) })) {
        throw new EntryError('DEGRADED_LIMITED', '축소 운영의 요청 한도를 넘었다', DEGRADED_RETRY_AFTER_SECONDS);
      }
      const reason = verdict.kind === 'VERIFY' ? verdict.reason : null;
      const token = this.tokens.lobby({ e: i.eventId, a: i.accountId, d: device, iat: now, jny, ...(reason ? { vr: reason } : {}), ...(verdict.kind === 'UNAVAILABLE' || verdict.kind === 'HELD' ? { hd: true as const } : {}) });
      const tokenHash = this.tokens.hash(token);
      const saleEnd = saleEndOf(schedule);
      const added = await this.store.addLobbyMember({
        eventId: i.eventId,
        tokenHash,
        opensAtMs: schedule.opensAtMs,
        lobbyOpensAtMs: lobbyOpensAtOf(schedule),
        expireAtMs: saleEnd,
        ...(reason ? { verify: { value: `VERIFYING:${now}:${reason}`, expireAtMs: saleEnd } } : {}),
      });
      if (added !== 'ADDED') throw new EntryError(added === 'NOT_OPEN' ? 'NOT_OPEN' : 'LOBBY_CLOSED', '로비 창 밖의 참가');
      for (const pid of persons) {
        let r: 'RECORDED' | 'ADMITTED' | 'TAKEN';
        try {
          r = await this.store.recordLobby({ pid, eventId: i.eventId, requestId, tokenHash, expireAtMs: saleEnd });
        } catch (e) {
          // 저장소 오류: 넣은 참가자와 모든 키의 값을 되돌려(최선 노력) 같은 사람이 다시 보내면 지나가게 한다. 응답만 잃고 실제로는 기록됐을 수 있어 예외가 난 키도 지운다
          await this.#undo(i.eventId, persons, requestId, tokenHash, saleEnd).catch(() => undefined);
          recorded = [];
          throw e;
        }
        if (r !== 'RECORDED') {
          // 다른 요청이 그 키를 차지했다: 넣은 참가자와 앞 키의 기록을 되돌린다(한 사람이 참가자 둘이 되지 않게)
          await this.#undo(i.eventId, persons, requestId, tokenHash, saleEnd);
          recorded = [];
          throw new EntryError(r === 'ADMITTED' ? 'ALREADY_ADMITTED' : 'ALREADY_WAITING', '다른 요청이 사람 키를 차지했다');
        }
        recorded.push(pid);
      }
      this.#countEarly(i.eventId, device, lobbyOpensAtOf(schedule), now);
      return {
        lobbyToken: token,
        ...(verdict.kind === 'VERIFY' ? { verification: 'REQUIRED' as const } : {}),
        verificationReason: reason,
        seedHash: rec.commit,
        drandChain: DRAND_CHAIN,
        drandRound: rec.round,
        algorithmVersion: ALGORITHM,
        lobbyOpenedAt: new Date(lobbyOpensAtOf(schedule)).toISOString(),
        shuffleResultAt: new Date(drandRoundTimeMs(rec.round) + SHUFFLE_PUBLISH_MS).toISOString(),
        shuffleSpreadSec: BATCH_SPREAD_SEC,
        serverTimeMs: now,
      };
    } catch (e) {
      // 아직 기록하지 않은 키의 선점을 푼다(값이 내 PENDING일 때만, 최선 노력)
      await this.#release(i.eventId, persons.filter((p) => !recorded.includes(p)), requestId).catch(() => undefined);
      throw e;
    }
  }

  /** ① 옛 pid → 새 pid 차례로 선점. 뒤 키가 거절되거나 오류면 앞 키의 선점을 풀고 같은 결과를 낸다 */
  async #preempt(i: JoinLobbyInput, persons: readonly string[], requestId: string): Promise<void> {
    const held: string[] = [];
    try {
      for (const pid of persons) {
        const p = await this.store.preempt({ pid, eventId: i.eventId, requestId, pendingTtlMs: PENDING_TTL_MS });
        if (p.kind === 'ADMITTED') throw new EntryError('ALREADY_ADMITTED', '이 회차에 이미 입장했다');
        if (p.kind !== 'PROCEED') throw new EntryError('ALREADY_WAITING', '이미 참가 토큰이 있거나 다른 곳에서 대기 중이다');
        held.push(pid);
      }
    } catch (e) {
      await this.#release(i.eventId, held, requestId).catch(() => undefined);
      throw e;
    }
  }

  /** ④가 막혔을 때 되돌리기: 참가자를 빼고(목록을 고정한 뒤면 저장소가 주인 없는 자리로 적는다) 키마다 이 요청의 LOBBY 값을 지운다(값이 이 요청의 것일 때만 지워진다) */
  async #undo(eventId: string, persons: readonly string[], requestId: string, tokenHash: string, expireAtMs: number): Promise<void> {
    await this.store.removeLobbyMember({ eventId, tokenHash, expireAtMs });
    for (const pid of persons) await this.store.dropLobbyRecord({ pid, eventId, requestId, tokenHash });
  }

  async #release(eventId: string, pids: readonly string[], requestId: string): Promise<void> {
    for (const pid of pids) await this.store.release({ pid, eventId, requestId });
  }

  async #score(i: JoinLobbyInput, deviceId: string, journeyId: string, lobbyShuffle: boolean): Promise<RiskVerdict> {
    try {
      const firstVisitAt = firstVisitAtMs(this.firstVisit, i.firstVisitCookie, this.clock.now(), this.visitSignals);
      return await this.risk.score({ context: 'LOBBY', eventId: i.eventId, accountId: i.accountId, pid: i.pidPrev ?? i.pid, deviceId, journeyId, lobbyShuffle, ...(firstVisitAt !== undefined ? { firstVisitAtMs: firstVisitAt } : {}), ...(i.body.humanCheckToken ? { humanCheckToken: i.body.humanCheckToken } : {}), ...(i.client ? { client: i.client } : {}) });
    } catch {
      // 받지 못하면 축소 운영이다(docs/features/bot-defense.md §11). 로비 참가는 막지 않는다
      return { kind: 'UNAVAILABLE' };
    }
  }

  /** 그 기기의 로비 입장 버튼이 열리는 시각보다 먼저 온 참가를 센다(막지 않는다, §2 '로비 참가 퍼뜨리기') */
  #countEarly(eventId: string, deviceId: string, lobbyOpensAtMs: number, now: number): void {
    const h = createHash('sha256').update(`PEAKET-lobby-open-v1${eventId}${deviceId}`).digest();
    if (now < lobbyOpensAtMs + (h.readUInt32BE(0) % LOBBY_UNLOCK_SPREAD_MS)) this.signals.joinedBeforeUnlock(eventId);
  }
}
