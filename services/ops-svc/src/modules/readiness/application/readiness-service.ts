// 회차 단계·T-30분 점검 조회와 Go/No-Go 판정(F-03-3 OPS-380, ADR-0371 결정 1~5).
// 판정은 요청 본문의 판정·항목을 받지 않고 서버가 항목을 다시 계산한 값으로 정한다(ASVS 8.2.3). 판정 창 밖·판매 설정 없음·실패 권고 사유 없음은 거절한다.
import { randomUUID } from 'node:crypto';
import {
  judgementWindowOf,
  previewOf,
  ReadinessSourceUnavailable,
  stageOf,
  type GoNoGoJudgement,
  type JudgementStore,
  type ReadinessItem,
  type ReadinessPreview,
  type ReadinessProbe,
  type SaleSchedule,
  type SaleScheduleSource,
  type Stage,
} from '../domain/readiness.js';

export interface ReadinessView {
  readonly eventId: string;
  readonly stage: Stage;
  readonly schedule?: SaleSchedule;
  readonly items: readonly ReadinessItem[];
  readonly preview: ReadinessPreview;
  readonly window?: { fromMs: number; untilMs: number };
  readonly lastJudgement?: GoNoGoJudgement;
}

/** 판정 거절(처리기가 Problem으로 바꾼다) */
export class JudgementRejected extends Error {
  constructor(readonly type: 'not-found' | 'judgement-window-closed' | 'recommended-reason-required', message: string) {
    super(message);
    this.name = 'JudgementRejected';
  }
}

/** 권고 실패 사유 하나의 길이 상한(openapi OpsGoNoGoJudgementRequest) */
export const RECOMMENDED_REASON_MAX = 500;

export interface ReadinessServiceDeps {
  readonly schedules: SaleScheduleSource;
  readonly probe: ReadinessProbe;
  readonly judgements: JudgementStore;
  readonly now: () => number;
  /** 판정자 계정 ID → 로그 가명 */
  readonly accountRef: (accountId: string) => string;
}

export class ReadinessService {
  constructor(private readonly deps: ReadinessServiceDeps) {}

  /** 점검 항목과 판정 미리 보기(회차와 무관한 항목들이라 위젯 흐름도 이것을 쓴다) */
  async checklist(nowMs = this.deps.now()): Promise<{ items: ReadinessItem[]; preview: ReadinessPreview }> {
    const items = await this.deps.probe.check(nowMs);
    return { items, preview: previewOf(items) };
  }

  /** 조회: 판매 설정을 못 읽으면 ReadinessSourceUnavailable을 던진다 */
  async view(eventId: string): Promise<ReadinessView> {
    const nowMs = this.deps.now();
    const [schedule, check, lastJudgement] = await Promise.all([this.deps.schedules.get(eventId), this.checklist(nowMs), this.deps.judgements.last(eventId)]);
    return {
      eventId,
      stage: schedule ? stageOf(schedule, nowMs) : 'none',
      ...(schedule ? { schedule, window: judgementWindowOf(schedule) } : {}),
      ...check,
      ...(lastJudgement ? { lastJudgement } : {}),
    };
  }

  /**
   * 판정을 기록한다. 판정 창 안에서만(재판정도 같다), 실패한 권고 항목마다 사유가 있어야 한다.
   * @param recommendedReasons 실패한 권고 항목 키 → 사유(그 밖의 키는 버린다)
   */
  async judge(eventId: string, input: { accountId: string; recommendedReasons: Readonly<Record<string, string>> }): Promise<GoNoGoJudgement> {
    const nowMs = this.deps.now();
    const schedule = await this.deps.schedules.get(eventId);
    if (!schedule) throw new JudgementRejected('not-found', '판매 설정이 없는 회차입니다');
    const w = judgementWindowOf(schedule);
    if (nowMs < w.fromMs || nowMs > w.untilMs) throw new JudgementRejected('judgement-window-closed', '판정은 판매 시작 30분 전부터 20분 전까지 받습니다');
    const { items, preview } = await this.checklist(nowMs);
    const reasons: Record<string, string> = {};
    for (const key of preview.failedRecommended) {
      const r = input.recommendedReasons[key]?.trim();
      if (!r) throw new JudgementRejected('recommended-reason-required', `실패한 권고 항목 ${key}의 사유가 없습니다`);
      reasons[key] = r.slice(0, RECOMMENDED_REASON_MAX);
    }
    return this.deps.judgements.record({
      judgementId: randomUUID(),
      eventId,
      verdict: preview.verdict,
      failedRequired: preview.failedRequired,
      failedRecommended: preview.failedRecommended,
      recommendedReasons: reasons,
      items,
      judgedAtMs: nowMs,
      judgedByRef: this.deps.accountRef(input.accountId),
    });
  }
}

export { ReadinessSourceUnavailable };
