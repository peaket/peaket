// SCR-027 [부정 예매 조치] 탭(기획사 보고)의 집계 목업·고정 문구·글 만들기(d5 §6.10, OpenSpec apply-legal-review-to-screens design.md 결정 5).
// 정본: openapi `GET /v1/partner/events/{eventId}/fraud-report`(200 `PromoterFraudReport`, 404 `fraud-report-not-ready`)와 `FraudCountCell`,
// docs/features/forensic-replay.md §6.7.7 '기획사 보고의 칸 합치기', FR-074, POL-046 ⑧. 기획사에는 회차 집계만 보이고 사람 단위 행·좌석·계정·주문·점수는 없다.
// 칸 합치기(1~4건 가림, 2차 가림)는 서버가 한다. 화면은 받은 `suppressed`를 '가림'으로 그릴 뿐이고, 아래 목업은 그 규칙을 지킨 값이다(fraud-report.test.mjs).
// Node 시험 실행기가 타입 지우기로 그대로 읽으므로 런타임 import 없이, 지울 수 있는 TS 문법만 쓴다(enum 금지).

/** openapi FraudCountCell: 1~4건 칸과 빼기로 그런 칸을 알아낼 수 있는 칸은 value null·suppressed true, 0건은 0 */
export interface FraudCountCell {
  value: number | null;
  suppressed: boolean;
}

/** openapi PromoterFraudReport.byReasonCategory[].category(5건 미만 칸은 OTHER로 합친다) */
export type FraudReportCategory = 'MACRO_BOT' | 'QUEUE_BYPASS' | 'CAPTCHA_BYPASS' | 'ACCOUNT_LENDING' | 'LIMIT_EVASION' | 'OTHER';

/** openapi PromoterFraudReport(칸 이름 그대로) */
export interface PromoterFraudReport {
  eventId: string;
  /** 집계 시각(하루 한 번 06:00 KST [가정]) */
  asOf: string;
  closedCaseCount: FraudCountCell;
  cancelActionCount: FraudCountCell;
  restrictActionCount: FraudCountCell;
  cancelledTicketCount: FraudCountCell;
  resoldAtFaceValueCount: FraudCountCell;
  byReasonCategory: readonly { category: FraudReportCategory; count: FraudCountCell }[];
  /** 소명 인정 비율. 분모(소명 판단을 받은 계정 수)가 5건 [가정] 미만이면 null */
  appealAcceptedRatio: number | null;
}

type CountKey = 'closedCaseCount' | 'cancelActionCount' | 'restrictActionCount' | 'cancelledTicketCount' | 'resoldAtFaceValueCount';

/* ---------- 고정 문구(d5 §6.10 글자 그대로) ---------- */

/** 탭 머리 설명 */
export const FRAUD_REPORT_INTRO = 'PEAKET이 이 회차의 부정 예매를 조사해 조치한 결과의 집계입니다. 개인을 알아볼 수 있는 정보는 없습니다.';
/** 상태 '부정 예매 집계 전'(온세일 윈도우 전, 404 fraud-report-not-ready) */
export const FRAUD_REPORT_NOT_READY = '판매가 시작되고 1시간 뒤부터 집계합니다';
/** 표 아래 안내 */
export const FRAUD_REPORT_FOOTNOTE = '5건 미만인 칸과, 빼기로 그 칸을 알아낼 수 있는 칸은 가려 보입니다. 집계는 하루 한 번 바뀝니다';
/** 소명 인정 비율을 보이지 않을 때(분모 5건 [가정] 미만) */
export const APPEAL_RATIO_HIDDEN = '5건 미만이라 보이지 않습니다';

/* ---------- 타일 다섯과 사유 범주 이름표 ---------- */

/** 타일 다섯(d5 순서). 단위는 사건·조치는 '건', 표는 '장'(추천 적용 2026-10-31) */
export const FRAUD_TILES: readonly { key: CountKey; label: string; unit: string }[] = [
  { key: 'closedCaseCount', label: '끝난 사건', unit: '건' },
  { key: 'cancelActionCount', label: '표 취소 조치', unit: '건' },
  { key: 'restrictActionCount', label: '이용 제한 조치', unit: '건' },
  { key: 'cancelledTicketCount', label: '취소한 표', unit: '장' },
  { key: 'resoldAtFaceValueCount', label: '정가 재판매로 돌린 표', unit: '장' },
];

/** 사유 범주 이름표(POL-046 ①의 쉬운 말, 표 머리 순서) */
export const FRAUD_REASON_LABEL: Readonly<Record<FraudReportCategory, string>> = {
  MACRO_BOT: '자동화 프로그램(매크로·봇)',
  QUEUE_BYPASS: '대기열 우회 링크',
  CAPTCHA_BYPASS: '보안문자 우회',
  ACCOUNT_LENDING: '명의 대여·사들인 계정',
  LIMIT_EVASION: '1인 매수 제한 회피',
  OTHER: '그 밖(합친 칸)',
};

const CATEGORY_ORDER: readonly FraudReportCategory[] = ['MACRO_BOT', 'QUEUE_BYPASS', 'CAPTCHA_BYPASS', 'ACCOUNT_LENDING', 'LIMIT_EVASION', 'OTHER'];

/* ---------- 글 만들기 ---------- */

/** 칸 하나의 글: 가린 칸은 '가림', 아니면 천 단위 쉼표와 단위('0건'·'27장') */
export function countText(cell: FraudCountCell, unit: string): string {
  if (cell.suppressed || cell.value === null) return '가림';
  return `${cell.value.toLocaleString('ko-KR')}${unit}`;
}

/** 소명 인정 비율 글: null이면 안내 글, 아니면 반올림한 백분율('40%') */
export function ratioText(ratio: number | null): string {
  if (ratio === null) return APPEAL_RATIO_HIDDEN;
  return `${Math.round(ratio * 100)}%`;
}

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'] as const;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 집계 시각을 KST(Asia/Seoul, 서머타임 없음 +09:00 고정)로 '10/26(월) 06:00 KST' */
export function asOfText(iso: string): string {
  const d = new Date(Date.parse(iso) + KST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY[d.getUTCDay()]}) ${hh}:${mm} KST`;
}

/**
 * 사유 범주별 표의 여섯 줄(정해진 순서). 응답에 없는 범주는 5건 미만이라 서버가 '그 밖'으로 합친 것이므로 '그 밖에 합침'이다
 * (forensic-replay.md §6.7.7. 줄을 늘 여섯으로 두는 것은 추천 적용 2026-10-31).
 */
export function reasonRows(report: Pick<PromoterFraudReport, 'byReasonCategory'>): { category: FraudReportCategory; label: string; text: string }[] {
  return CATEGORY_ORDER.map((category) => {
    const row = report.byReasonCategory.find((r) => r.category === category);
    return { category, label: FRAUD_REASON_LABEL[category], text: row ? countText(row.count, '건') : '그 밖에 합침' };
  });
}

/* ---------- 목업(합성, d5 §7.19 사건 예와 맞춤. eventId는 10/25(일) 18:00 KST 회차) ---------- */

const cell = (value: number): FraudCountCell => ({ value, suppressed: false });
const hidden: FraudCountCell = { value: null, suppressed: true };

/**
 * 상태 '부정 예매 집계'. 끝난 사건 14건: 자동화 6 · 보안문자 우회 0 · 대기열 우회 1·명의 대여 2(5건 미만이라 그 밖으로 합침 → 그 밖 3) ·
 * 1인 매수 제한 회피 5. 그 밖이 5건 미만이라 가리고, 합계에서 빼면 되살아나므로 그다음으로 작은 1인 매수 제한 회피도 함께 가린다(2차 가림).
 * 표 27장 취소·정가 재판매는 d5 §7.19 '조치됨' 예. 소명 인정 비율 40%(소명 판단을 받은 계정 10 가운데 4, [예시]).
 */
export const FRAUD_REPORT: PromoterFraudReport = {
  eventId: 'perf-lumen-1025',
  asOf: '2026-10-25T21:00:00Z',
  closedCaseCount: cell(14),
  cancelActionCount: cell(9),
  restrictActionCount: cell(6),
  cancelledTicketCount: cell(27),
  resoldAtFaceValueCount: cell(27),
  byReasonCategory: [
    { category: 'MACRO_BOT', count: cell(6) },
    { category: 'CAPTCHA_BYPASS', count: cell(0) },
    { category: 'LIMIT_EVASION', count: hidden },
    { category: 'OTHER', count: hidden },
  ],
  appealAcceptedRatio: 0.4,
};

/** 끝난 사건이 없을 때(d5 '끝난 사건이 없으면 타일 모두 0'): 타일과 사유 범주 칸 모두 0(0건은 가리지 않는다), 비율 없음 */
export const FRAUD_REPORT_EMPTY: PromoterFraudReport = {
  eventId: 'perf-lumen-1025',
  asOf: '2026-10-25T21:00:00Z',
  closedCaseCount: cell(0),
  cancelActionCount: cell(0),
  restrictActionCount: cell(0),
  cancelledTicketCount: cell(0),
  resoldAtFaceValueCount: cell(0),
  byReasonCategory: CATEGORY_ORDER.map((category) => ({ category, count: cell(0) })),
  appealAcceptedRatio: null,
};
