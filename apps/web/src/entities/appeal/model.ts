// 소명 건 목업(SCR-042 캔버스 보드의 예매 제한·양도 회수 예시와 d5 §5.24 처리 일정을 옮겼다). 시각은 KST 표기 글, 값은 모두 합성이다.
// 공연·회차는 id로만 가진다(entities끼리 가져오지 않는다). 공연 이름·회차 글은 페이지가 production·performance에서 읽어 합친다.
// 부정 예매 소명(apl-0003 결제자, apl-0004 받은 사람)은 보드가 없어 d5 §5.24 '부정 예매 소명'·'받은 사람의 변형' 그림을 옮겼다.
// 팬 화면 사본(openapi FraudAppealView)에 있는 칸만 둔다. 받은 사람(party HOLDER)에게는 사유 범주·잠긴 표·잠금 기한·이용 제한·이의 기한·우선 구매가 없다.
// 날짜는 d5 그림의 예(소명 요청 10/18(일) 16:00, 기한 3일, 잠금 기한 = 요청 + 14일 [가정])다(apply-legal-review-to-screens design.md 결정 4).
// 이 파일은 fraud.test.mjs가 Node 타입 지우기로 그대로 읽는다(타입 import만 쓴다).
import type { FraudParty, FraudReasonCategory } from './fraud';

/** restriction(예매 제한) · reclaim(양도 회수, 계정 보호 절차) · fraud(부정 예매 소명 요청, POL-046 ③) */
export type AppealKind = 'restriction' | 'reclaim' | 'fraud';

/** 부정 예매 조치 결과(openapi FraudAppealView.actionResult·objectionDueAt을 글로) */
export interface FraudActionResult {
  /** 취소한 내 표의 좌석 글(받은 사람이면 내가 가진 표 가운데 취소된 표) */
  cancelledSeatLabels: readonly string[];
  /** 이용 제한 끝(결제자만, 없으면 제한 없음) */
  restrictedUntilText?: string;
  /** 이의 창 끝(결과를 알린 날 + 30일 [가정], 결제자만) */
  objectionDueText?: string;
}

/** 이의 인정 뒤 우선 구매 권리(openapi FraudAppealView.priorityPurchases 하나, forensic-replay §6.7.5) */
export interface FraudPriorityPurchase {
  /** '좌석 A구역 3열 14번·15번' */
  seatText: string;
  /** '₩308,000(원래 가격, 수수료 없음)' */
  priceText: string;
  /** 권리를 연 때부터 48시간 [가정] '11/7(토) 10:00' */
  deadlineText: string;
}

export interface Appeal {
  id: string;
  kind: AppealKind;
  /** 부정 예매 소명: 결제자(PAYER) · 받은 사람(HOLDER) */
  party?: FraudParty;
  /** 사유 범주 '최근 1개월 취소가 많음'(restriction·reclaim) */
  reasonCategory?: string;
  /** 부정 예매 소명: 소명 제출의 대상 ID(사건 ID) */
  caseId?: string;
  /** 부정 예매 소명(결제자): 알린 사유 범주(하나 이상, 알린 순서) */
  reasonCategories?: readonly FraudReasonCategory[];
  /** 부정 예매 소명(결제자): 이 요청으로 양도가 잠긴 내 티켓의 좌석 글 */
  lockedSeatLabels?: readonly string[];
  /** 부정 예매 소명(결제자): 양도 잠금 최대 기한(lockExpiresAt) '11/1(일) 16:00' */
  lockExpiresAtText?: string;
  /** 부정 예매 소명(받은 사람): 내가 가진 이 사건의 표(heldTicketIds)의 좌석 글 */
  heldSeatLabels?: readonly string[];
  /** 부정 예매 소명: 조치 결과(조치 결과·이의 결과 상태에서 보인다) */
  actionResult?: FraudActionResult;
  /** 부정 예매 소명(결제자): 이의 결과의 이유(조사관이 적은 글, objectionNote). 그림 시안은 자리 표시 */
  objectionNote?: string;
  /** 부정 예매 소명(결제자): 이의 인정 뒤 우선 구매 권리 */
  priorityPurchase?: FraudPriorityPurchase;
  /** 소명 기한 '10/27(화) 18:00' */
  deadlineText: string;
  /** 기한까지 남은 시간(시간 단위) */
  remainingHours: number;
  /** 양도 회수 대상 티켓(받은 티켓, quantity) · 부정 예매 소명의 회차(quantity 없음) */
  target?: { productionId: string; performanceId: string; quantity?: number };
  /** 작성 중 예시 글(보드 '작성' 상태) */
  draftText?: string;
  /** 제출 시각 '10/25(일) 15:20' */
  submittedAtText: string;
  /** 예매 제한 소명의 결과 안내 기한(제출일부터 3영업일 [가정]) '10/28(수)' */
  resultDueText?: string;
  /** 제한 유지 때 담당자가 적은 검토 사유(합성 글) */
  reviewNote?: string;
}

/** 소명 글 최대 글자 수(grapheme) */
export const APPEAL_MAX_LENGTH = 2000;

export const APPEALS: readonly Appeal[] = [
  {
    id: 'apl-0001',
    kind: 'restriction',
    reasonCategory: '최근 1개월 취소가 많음',
    deadlineText: '10/27(화) 18:00',
    remainingHours: 51,
    draftText: '회사 단체 관람 일정이 바뀌어 한꺼번에 취소했습니다. 되팔 목적은 없었습니다.',
    submittedAtText: '10/25(일) 15:20',
    resultDueText: '10/28(수)',
    reviewNote: '단체 관람 일정이 바뀐 것을 확인할 수 있는 내용이 없어 제한을 그대로 둡니다',
  },
  {
    id: 'apl-0002',
    kind: 'reclaim',
    reasonCategory: '계정 보호 절차',
    deadlineText: '10/24(토) 18:00',
    remainingHours: 18,
    target: { productionId: 'prd-lumen', performanceId: 'evt-lumen-1025', quantity: 1 },
    submittedAtText: '10/24(토) 00:20',
  },
  {
    // 데모 팬의 R구역 12열 7·8번 티켓과 섞이지 않게 다른 좌석을 둔다
    id: 'apl-0003',
    kind: 'fraud',
    party: 'PAYER',
    caseId: 'CASE-2610-0004',
    reasonCategories: ['LIMIT_EVASION', 'ACCOUNT_LENDING'],
    deadlineText: '10/21(수) 16:00',
    remainingHours: 49,
    target: { productionId: 'prd-lumen', performanceId: 'evt-lumen-1025' },
    lockedSeatLabels: ['A구역 3열 14번', 'A구역 3열 15번'],
    lockExpiresAtText: '11/1(일) 16:00',
    submittedAtText: '10/20(화) 09:10',
    // 조치 결과를 10/23(금) 18:00에 알렸다고 보고 이의 창은 + 30일 [가정]. 이용 제한 끝은 요청 + 1년 [가정] 안(추천 적용 2026-10-31)
    actionResult: {
      cancelledSeatLabels: ['A구역 3열 14번', 'A구역 3열 15번'],
      restrictedUntilText: '2027년 10월 22일(금)',
      objectionDueText: '11/22(일) 18:00',
    },
    objectionNote: '[조사관이 적은 이유]',
    // 이의 인정(11/5(목) 10:00 권리 열림) 뒤 같은 좌석을 원래 가격으로, 48시간 [가정](forensic-replay §6.7.5 ①, 추천 적용 2026-10-31)
    priorityPurchase: {
      seatText: 'A구역 3열 14번·15번',
      priceText: '₩308,000(원래 가격, 수수료 없음)',
      deadlineText: '11/7(토) 10:00',
    },
  },
  {
    // 받은 사람(사건 밖 계정): apl-0003 결제자가 결제해 양도한 표를 가진 분. 같은 사건·같은 기한(d5 §5.24 '받은 사람의 변형')
    id: 'apl-0004',
    kind: 'fraud',
    party: 'HOLDER',
    caseId: 'CASE-2610-0004',
    deadlineText: '10/21(수) 16:00',
    remainingHours: 49,
    target: { productionId: 'prd-lumen', performanceId: 'evt-lumen-1025' },
    heldSeatLabels: ['A구역 3열 16번'],
    submittedAtText: '10/20(화) 11:40',
    actionResult: { cancelledSeatLabels: ['A구역 3열 16번'] },
  },
];

/** 대표 소명 id(경로 예시 /my/appeals/apl-0001) */
export const DEMO_APPEAL_ID = 'apl-0001';
/** 부정 예매 소명(결제자) 예시 id. 양도 잠김 화면의 ( 소명 보기 › )가 간다 */
export const DEMO_FRAUD_APPEAL_ID = 'apl-0003';

export function getAppeal(id: string): Appeal | undefined {
  return APPEALS.find((a) => a.id === id);
}

/** 그 종류의 첫 소명 건(한 경로에서 두 종류 상태를 미리 볼 때). 부정 예매는 party로 결제자·받은 사람을 고른다 */
export function findAppealByKind(kind: AppealKind, party?: FraudParty): Appeal | undefined {
  return APPEALS.find((a) => a.kind === kind && (party === undefined || a.party === party));
}
