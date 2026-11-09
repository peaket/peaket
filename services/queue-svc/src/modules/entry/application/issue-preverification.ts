// 사전 검증 토큰 발급·갱신(openapi POST /v1/queues/{eventId}/pre-verifications, docs/features/queue-admission.md §3, ADR-0041·0062·0171).
// 만료 전 갱신은 최초 발급 시각과 여정 ID(jny)를 옮기고, 그 밖은 새 여정이다. 위험 판정을 받지 못하면 축소 운영(사람 확인 보류)으로 발급한다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import { DEGRADED_LIMITS, DEGRADED_RETRY_AFTER_SECONDS, type DegradedLimits, EVENT_SCHEDULES, type EventSchedules, FIRST_VISIT_COOKIES, FIRST_VISIT_SIGNALS, type FirstVisitCookies, type FirstVisitSignals, noDegradedLimits, noFirstVisitSignals, QUEUE_TOKENS, type QueueTokens, RISK, type RiskClient, type RiskPort, type RiskVerdict } from '../domain/ports.js';
import { PREVERIFY_TTL_MS, type PreverifyClaims } from '../domain/queue.js';
import { EntryError } from './entry-error.js';
import { firstVisitAtMs } from './first-visit.js';

export interface PreverifyInput {
  accountId: string;
  pid: string;
  /** pid 키 전환 기간의 옛 pid. 위험 판정에 넘기는 사람 식별값은 옛 pid다(docs/features/queue-admission.md §3 'pid 키 전환 기간') */
  pidPrev?: string;
  eventId: string;
  body: { humanCheckToken?: string; deviceId?: string; preverifyToken?: string; behaviorSummary?: Record<string, unknown> };
  /** 게이트웨이가 넘긴 IP·ASN·UA·Client Hints(위험 판정 입력) */
  client?: RiskClient;
  /** 최초 방문 쿠키 값(있을 때만) */
  firstVisitCookie?: string;
}

export interface PreverifyResult {
  preverifyToken: string;
  expiresAt: string;
  serverTimeMs: number;
}

@Injectable()
export class IssuePreverification {
  constructor(
    @Inject(EVENT_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(QUEUE_TOKENS) private readonly tokens: QueueTokens,
    @Inject(RISK) private readonly risk: RiskPort,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(DEGRADED_LIMITS) private readonly limits: DegradedLimits = noDegradedLimits,
    @Optional() @Inject(FIRST_VISIT_COOKIES) private readonly firstVisit?: FirstVisitCookies,
    @Optional() @Inject(FIRST_VISIT_SIGNALS) private readonly visitSignals: FirstVisitSignals = noFirstVisitSignals,
  ) {}

  async run(i: PreverifyInput): Promise<PreverifyResult> {
    const schedule = await this.schedules.get(i.eventId);
    if (!schedule) throw new EntryError('NOT_FOUND', '이 회차의 대기열이 열리지 않았다');
    const now = this.clock.now();
    const device = i.body.deviceId ?? '';
    const carried = this.#carry(i, device, now);
    const jny = carried?.jny ?? uuidv7(this.clock);
    const i0 = carried?.i0 ?? now;

    const firstVisitAt = firstVisitAtMs(this.firstVisit, i.firstVisitCookie, now, this.visitSignals);

    let verdict: RiskVerdict;
    try {
      verdict = await this.risk.score({
        context: 'PREVERIFY',
        eventId: i.eventId,
        accountId: i.accountId,
        pid: i.pidPrev ?? i.pid,
        deviceId: device,
        journeyId: jny,
        lobbyShuffle: schedule.lobbyShuffle,
        ...(i.body.humanCheckToken ? { humanCheckToken: i.body.humanCheckToken } : {}),
        ...(i.body.behaviorSummary ? { behaviorSummary: i.body.behaviorSummary } : {}),
        ...(i.client ? { client: i.client } : {}),
        ...(firstVisitAt !== undefined ? { firstVisitAtMs: firstVisitAt } : {}),
      });
    } catch {
      // 오류·데드라인 넘김·차단기 열림은 축소 운영이다(docs/features/bot-defense.md §11). 진입은 막지 않는다
      verdict = { kind: 'UNAVAILABLE' };
    }
    // 판정을 받지 못한 동안에만 파드 메모리 한도를 건다(§11.2). 통과로 보지 않고 토큰에 hd를 서명한다
    if (verdict.kind === 'UNAVAILABLE' && !this.limits.allow({ deviceId: device, pid: i.pid, ...(i.client ? { client: i.client } : {}) })) {
      throw new EntryError('DEGRADED_LIMITED', '축소 운영의 요청 한도를 넘었다', DEGRADED_RETRY_AFTER_SECONDS);
    }
    const exp = now + PREVERIFY_TTL_MS;
    const claims: PreverifyClaims = {
      e: i.eventId,
      a: i.accountId,
      d: device,
      i0,
      iat: now,
      exp,
      jny,
      ...(verdict.kind === 'VERIFY' ? { vr: verdict.reason } : {}),
      // 받지 못했거나(UNAVAILABLE) trust-svc가 일부 신호 없이 판정했으면(HELD) 사람 확인을 보류로 서명하고, 갱신 때 다시 판정받는다
      ...(verdict.kind === 'UNAVAILABLE' || verdict.kind === 'HELD' ? { hd: true as const } : {}),
    };
    return { preverifyToken: this.tokens.preverify(claims), expiresAt: new Date(exp).toISOString(), serverTimeMs: now };
  }

  /** 옮길 수 있는 지금 토큰(서명·회차·계정·기기가 같고 만료 전) */
  #carry(i: PreverifyInput, device: string, now: number): PreverifyClaims | null {
    if (!i.body.preverifyToken) return null;
    const c = this.tokens.readPreverify(i.body.preverifyToken);
    if (!c || c.e !== i.eventId || c.a !== i.accountId || c.d !== device || now >= c.exp) return null;
    return c;
  }
}
