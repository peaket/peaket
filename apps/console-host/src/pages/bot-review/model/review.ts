// SCR-067 봇 판정 표본 검토 화면 모델(FR-049, BAT-197, d5 §7.15).
// API 값을 화면 표기로 바꾸는 순수 함수만 둔다. 실제 호출은 ui/ConnectedPage.tsx가 @peaket/api-client로 한다.
// 카드의 세션 가명·범주·타임라인은 글자 노드로만 그린다(ASVS 3.2.2). 판정·표본을 localStorage에 두지 않는다.

export type ReviewKind = 'PASSED_SAMPLE' | 'HUMAN_BASELINE';
export type Verdict = 'HUMAN' | 'BOT' | 'UNDECIDED';
export type EvidenceKind = 'CONFIRMED_SIGNAL' | 'SHARED_DEVICE_OR_PAYMENT' | 'POST_LABEL' | 'VERIFICATION_FAILED' | 'OTHER';
export type TimelineStep = 'ENTRY' | 'HOLD' | 'PAYMENT';

export const REVIEW_KINDS: readonly ReviewKind[] = ['PASSED_SAMPLE', 'HUMAN_BASELINE'];
export const VERDICTS: readonly Verdict[] = ['HUMAN', 'BOT', 'UNDECIDED'];

/** 봇 근거(사람 기준 표본에서 BOT일 때 하나 이상 필수). '그 밖'은 근거 종류 OTHER다(메모 칸은 계약에 없다) */
export const EVIDENCE_KINDS: readonly { readonly kind: EvidenceKind; readonly label: string }[] = [
  { kind: 'CONFIRMED_SIGNAL', label: '확정 신호(차단 기기 목록·허니팟)' },
  { kind: 'SHARED_DEVICE_OR_PAYMENT', label: '같은 기기·결제 수단 공유' },
  { kind: 'POST_LABEL', label: '사후 라벨' },
  { kind: 'VERIFICATION_FAILED', label: '추가 검증 실패' },
  { kind: 'OTHER', label: '그 밖' },
];

export const DEFAULT_REVIEW_KIND: ReviewKind = 'PASSED_SAMPLE';

export interface RawReview {
  eventId?: string;
  reviewKind?: string;
  reviewedCount?: number;
  targetCount?: number;
  deadlineAt?: string;
  r2DueAt?: string | null;
  interim?: { missedBotRate?: number; ci95Low?: number; ci95High?: number } | null;
}

export interface ReviewProgress {
  eventId: string;
  reviewKind: ReviewKind;
  reviewedCount: number;
  targetCount: number;
  remaining: number;
  percent: number;
  deadlineAt: string;
  r2DueAt: string | null;
  interim: { missedBotRate: number; ci95Low: number; ci95High: number } | null;
}

export interface RawSample {
  sampleId?: string;
  sessionRef?: string;
  status?: string;
  riskBand?: string | null;
  behaviorSummaryBand?: string | null;
  timeline?: readonly { step?: string; at?: string }[];
  evidenceAvailable?: readonly string[];
}

export interface SampleRow {
  sampleId: string;
  sessionRef: string;
  status: 'PENDING' | 'RECORDED';
  riskBand: string | null;
  behaviorSummaryBand: string | null;
  timeline: readonly { step: TimelineStep; at: string }[];
  evidenceAvailable: readonly EvidenceKind[];
}

export function parseReviewKind(raw: string | null | undefined): ReviewKind {
  return raw === 'HUMAN_BASELINE' ? 'HUMAN_BASELINE' : DEFAULT_REVIEW_KIND;
}

export function reviewKindLabel(kind: ReviewKind): string {
  return kind === 'HUMAN_BASELINE' ? '출시 뒤 사람 기준' : '통과 세션 표본';
}

export function reviewKindHint(kind: ReviewKind): string {
  return kind === 'HUMAN_BASELINE'
    ? '두 묶음을 섞어 무작위 순서로 보입니다. 이 세션이 어느 묶음인지, 판정이 무엇이었는지는 보이지 않습니다.'
    : '검증을 통과한 세션에서 무작위로 뽑은 표본입니다. 위험 점수 범주와 행동 신호 요약 범주만 보입니다.';
}

/** 화면 머리 설명. HUMAN_BASELINE은 통과 세션과 그림자 추가 검증 세션을 섞은 표본이다(d5 §7.15) */
export function reviewKindIntro(kind: ReviewKind): string {
  return kind === 'HUMAN_BASELINE'
    ? '출시 뒤 실제 사람 기준을 세우려고 통과 세션과 그림자 추가 검증 세션을 섞어 뽑은 표본을 사람이 검토합니다. 어느 묶음인지와 개인 식별 정보·판정 가중치는 보이지 않습니다.'
    : '온세일이 끝난 뒤 검증을 통과한 세션에서 무작위로 뽑은 표본을 사람이 검토합니다. 개인 식별 정보와 판정 가중치는 보이지 않습니다.';
}

export function mapReview(raw: RawReview, fallbackKind: ReviewKind): ReviewProgress {
  const targetCount = Math.max(0, Math.trunc(raw.targetCount ?? 0));
  const reviewedCount = Math.max(0, Math.trunc(raw.reviewedCount ?? 0));
  const remaining = Math.max(0, targetCount - reviewedCount);
  const interim = raw.interim
    ? {
        missedBotRate: raw.interim.missedBotRate ?? 0,
        ci95Low: raw.interim.ci95Low ?? 0,
        ci95High: raw.interim.ci95High ?? 0,
      }
    : null;
  return {
    eventId: raw.eventId ?? '',
    reviewKind: parseReviewKind(raw.reviewKind ?? fallbackKind),
    reviewedCount,
    targetCount,
    remaining,
    percent: targetCount === 0 ? 0 : Math.min(100, (reviewedCount / targetCount) * 100),
    deadlineAt: raw.deadlineAt ?? '',
    r2DueAt: raw.r2DueAt ?? null,
    interim,
  };
}

/** 목록 응답을 화면 행으로. sampleId·sessionRef가 없는 항목은 버리고, 받은 순서를 그대로 쓴다(다시 정렬하지 않는다) */
export function mapSamples(raw: { items?: readonly RawSample[] } | null | undefined): SampleRow[] {
  return (raw?.items ?? []).flatMap((s): SampleRow[] => {
    if (!s.sampleId || !s.sessionRef) return [];
    return [
      {
        sampleId: s.sampleId,
        sessionRef: s.sessionRef,
        status: s.status === 'RECORDED' ? 'RECORDED' : 'PENDING',
        riskBand: s.riskBand ?? null,
        behaviorSummaryBand: s.behaviorSummaryBand ?? null,
        timeline: (s.timeline ?? []).flatMap((t) =>
          t.step === 'ENTRY' || t.step === 'HOLD' || t.step === 'PAYMENT' ? [{ step: t.step, at: t.at ?? '' }] : [],
        ),
        evidenceAvailable: (s.evidenceAvailable ?? []).filter((e): e is EvidenceKind =>
          EVIDENCE_KINDS.some((x) => x.kind === e && e !== 'OTHER'),
        ),
      },
    ];
  });
}

/** 사람 기준 표본의 BOT은 행동 요약 밖의 근거가 하나 이상 필요하다(openapi 422, d5 3677) */
export function needsEvidence(kind: ReviewKind, verdict: Verdict | null): boolean {
  return kind === 'HUMAN_BASELINE' && verdict === 'BOT';
}

export function canSubmit(kind: ReviewKind, verdict: Verdict | null, selectedEvidence: readonly EvidenceKind[]): boolean {
  if (verdict === null) return false;
  if (needsEvidence(kind, verdict)) return selectedEvidence.length > 0;
  return true;
}

/** 기록 버튼이 비활성인 까닭. 누를 수 있으면 null */
export function submitBlockReason(kind: ReviewKind, verdict: Verdict | null, selectedEvidence: readonly EvidenceKind[]): string | null {
  if (verdict === null) return '판정을 고르면 기록할 수 있습니다';
  if (needsEvidence(kind, verdict) && selectedEvidence.length === 0) return '봇으로 기록하려면 행동 요약 밖의 근거를 하나 이상 골라 주세요';
  return null;
}

export function verdictLabel(verdict: Verdict): string {
  return verdict === 'HUMAN' ? '사람' : verdict === 'BOT' ? '봇' : '판단 불가';
}

export function stepLabel(step: TimelineStep): string {
  return step === 'ENTRY' ? '진입' : step === 'HOLD' ? '홀드' : '결제';
}

/** 퍼센트 글자. 0~100 밖은 자른다 */
export function formatPercent(value: number): string {
  const pct = Math.min(100, Math.max(0, value));
  return `${pct.toFixed(1)}%`;
}

/** 0~1 비율을 소수 첫째 자리 퍼센트로 */
export function formatRate(value: number): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(1)}%`;
}

export function formatRateRange(low: number, high: number): string {
  return `${formatRate(low)}~${formatRate(high)}`;
}

const KST = 'Asia/Seoul';
const formatter = new Intl.DateTimeFormat('ko-KR', {
  timeZone: KST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** ISO를 KST 'YYYY. MM. DD. HH:mm'로. 값이 없거나 틀리면 '—' */
export function formatKst(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return formatter.format(new Date(ms));
}
