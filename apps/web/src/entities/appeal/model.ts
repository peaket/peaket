// 소명 건 목업(SCR-042 캔버스 보드의 예매 제한·양도 회수 예시와 d5 §5.24 처리 일정을 옮겼다). 시각은 KST 표기 글, 값은 모두 합성이다.
// 공연·회차는 id로만 가진다(entities끼리 가져오지 않는다). 공연 이름·회차 글은 페이지가 production·performance에서 읽어 합친다.
// 부정 예매 소명(apl-0003)은 보드가 없어 d5 §5.24 '부정 예매 소명' 그림을 옮겼다. 팬 화면 사본(openapi FraudAppealView)에 있는 칸만 둔다.
// 이 파일은 fraud.test.mjs가 Node 타입 지우기로 그대로 읽는다(타입 import만 쓴다).
import type { FraudReasonCategory } from './fraud';

/** restriction(예매 제한) · reclaim(양도 회수, 계정 보호 절차) · fraud(부정 예매 소명 요청, POL-046 ③) */
export type AppealKind = 'restriction' | 'reclaim' | 'fraud';

export interface Appeal {
  id: string;
  kind: AppealKind;
  /** 사유 범주 '최근 1개월 취소가 많음'(restriction·reclaim) */
  reasonCategory?: string;
  /** 부정 예매 소명: 소명 제출의 대상 ID(사건 ID) */
  caseId?: string;
  /** 부정 예매 소명: 알린 사유 범주(하나 이상, 알린 순서) */
  reasonCategories?: readonly FraudReasonCategory[];
  /** 부정 예매 소명: 이 요청으로 양도가 잠긴 내 티켓의 좌석 글 */
  lockedSeatLabels?: readonly string[];
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
    caseId: 'CASE-2610-0004',
    reasonCategories: ['LIMIT_EVASION', 'ACCOUNT_LENDING'],
    deadlineText: '10/21(수) 16:00',
    remainingHours: 49,
    target: { productionId: 'prd-lumen', performanceId: 'evt-lumen-1025' },
    lockedSeatLabels: ['A구역 3열 14번', 'A구역 3열 15번'],
    submittedAtText: '10/20(화) 09:10',
  },
];

/** 대표 소명 id(경로 예시 /my/appeals/apl-0001) */
export const DEMO_APPEAL_ID = 'apl-0001';

export function getAppeal(id: string): Appeal | undefined {
  return APPEALS.find((a) => a.id === id);
}

/** 그 종류의 첫 소명 건(한 경로에서 두 종류 상태를 미리 볼 때) */
export function findAppealByKind(kind: AppealKind): Appeal | undefined {
  return APPEALS.find((a) => a.kind === kind);
}
