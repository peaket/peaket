// 로그인한 팬 요약 목업(d5 §10.3 '지민(카카오, 본인확인 완료)'). 셸 머리·메뉴와 화면의 개인 영역이 읽는다.
// 로그인 전 모양은 null(GUEST)이다. 실제 연락처·실명을 쓰지 않는다.
export interface MeSummary {
  id: string;
  /** 표시 이름(닉네임) */
  name: string;
  avatarText: string;
  provider: 'kakao' | 'naver' | 'google';
  /** 휴대폰 본인확인 완료 */
  verified: boolean;
  /** 현장 스태프 배정이 있다(메뉴 '현장 근무', SCR-061) */
  hasStaffAssignment: boolean;
  /** 찜한 공연 id(공연 단위, ADR-0093) */
  likedProductionIds: string[];
  /** 오픈 알림을 신청한 공연 id */
  openAlertProductionIds: string[];
}

export const ME: MeSummary = {
  id: 'fan-jimin',
  name: '지민',
  avatarText: '지',
  provider: 'kakao',
  verified: true,
  hasStaffAssignment: false,
  likedProductionIds: ['prd-lumen', 'prd-musical', 'prd-fanmeet', 'prd-fest'],
  openAlertProductionIds: ['prd-starlight-gala'],
};

/** 받는 사람이자 현장 책임자(d5 §10.3 '하늘(구글)'). 스태프 화면 예시에 쓴다 */
export const ME_HANEUL: MeSummary = {
  id: 'fan-haneul',
  name: '하늘',
  avatarText: '하',
  provider: 'google',
  verified: true,
  hasStaffAssignment: true,
  likedProductionIds: ['prd-lumen'],
  openAlertProductionIds: [],
};

/** 로그인 전 */
export const GUEST = null;
