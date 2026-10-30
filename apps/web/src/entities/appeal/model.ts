// 소명 건 목업(SCR-042 캔버스 보드의 예매 제한·양도 회수 예시와 d5 §5.24 처리 일정을 옮겼다). 시각은 KST 표기 글, 값은 모두 합성이다.
// 공연·회차는 id로만 가진다(entities끼리 가져오지 않는다). 공연 이름·회차 글은 페이지가 production·performance에서 읽어 합친다.

/** restriction(예매 제한) · reclaim(양도 회수, 계정 보호 절차) */
export type AppealKind = 'restriction' | 'reclaim';

export interface Appeal {
  id: string;
  kind: AppealKind;
  /** 사유 범주 '최근 1개월 취소가 많음' */
  reasonCategory: string;
  /** 소명 기한 '10/27(화) 18:00' */
  deadlineText: string;
  /** 기한까지 남은 시간(시간 단위) */
  remainingHours: number;
  /** 양도 회수 대상 티켓(받은 티켓) */
  target?: { productionId: string; performanceId: string; quantity: number };
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
