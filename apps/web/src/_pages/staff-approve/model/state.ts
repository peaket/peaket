// SCR-051 스캐너 승인(휴대폰 쪽) 상태별로 무엇을 보일지(캔버스 보드 SCR-051-m·t·d의 renderVals를 옮겼다. 세 보드의 분기는 같다).
import type { Scr051State } from '@/shared/config/screens.account';

/** 본문 모양: 로그인 필요 · 조회 중 · 승인 대기(코드 대조) · 권한 없음 · 승인됨 · 거부함 · 코드 만료 · 시도 초과 */
export type ApproveMode = 'login' | 'loading' | 'ready' | 'denied' | 'approved' | 'rejected' | 'expired' | 'limited';

/** 권한 없음의 까닭(조회 403 세 가지 + 대리 승인 요청 403) */
export type DenyReason = 'no-assignment' | 'other-partner' | 'off-hours' | 'proxy';

export interface ApproveView {
  mode: ApproveMode;
  /** 셸의 로그아웃(로그인 필요에서는 로그인 전 모양) */
  signedIn: boolean;
  /** 맨 위 설명 줄의 '내 계정': lead = 하늘 · 현장 책임자, staff = 도윤 · 현장 스태프(대리 승인 거절), null = 없음 */
  introAs: 'lead' | 'staff' | null;
  /** ① '현장 스캐너에 로그인하려고 합니다' 경고 */
  warning: boolean;
  /** ② 기기 이름·배정 파트너 카드. 조회 403 세 가지는 이유만 보이고 숨긴다(d5 §5.27) */
  device: boolean;
  /** 회차 공개 요약을 읽어 파트너 상호·공연명을 안다 */
  partnerKnown: boolean;
  /** ④ 내 배정: 하나(그대로 보임) · 둘 이상(고르기) */
  pick: 'single' | 'multi';
  /** ⑥ 대리 승인 칸을 켠 채로 */
  proxy: boolean;
  deny: DenyReason | null;
}

const DENY: Partial<Record<Scr051State, DenyReason>> = {
  '권한 없음 · 배정 없음': 'no-assignment',
  '권한 없음 · 다른 파트너 기기': 'other-partner',
  '권한 없음 · 운영 시간 밖': 'off-hours',
  '권한 없음 · 대리 승인': 'proxy',
};

const MODE: Record<Scr051State, ApproveMode> = {
  '승인 대기': 'ready',
  '로그인 필요': 'login',
  '조회 중': 'loading',
  '배정 고르기': 'ready',
  '대리 승인': 'ready',
  승인됨: 'approved',
  거부함: 'rejected',
  '코드 만료': 'expired',
  '시도 초과': 'limited',
  '권한 없음 · 배정 없음': 'denied',
  '권한 없음 · 다른 파트너 기기': 'denied',
  '권한 없음 · 운영 시간 밖': 'denied',
  '권한 없음 · 대리 승인': 'denied',
  '파트너 이름을 읽지 못함': 'ready',
};

export function approveView(st: Scr051State): ApproveView {
  const mode = MODE[st];
  const deny = DENY[st] ?? null;
  return {
    mode,
    signedIn: mode !== 'login',
    introAs: mode === 'login' ? null : deny === 'proxy' ? 'staff' : 'lead',
    warning: mode === 'ready' || mode === 'denied' || mode === 'loading',
    device: mode === 'ready' || deny === 'proxy',
    partnerKnown: st !== '파트너 이름을 읽지 못함',
    pick: st === '배정 고르기' ? 'multi' : 'single',
    proxy: st === '대리 승인',
    deny,
  };
}
