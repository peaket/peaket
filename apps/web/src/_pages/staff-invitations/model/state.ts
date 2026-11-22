// SCR-050 현장 스태프 초대 수락 상태별로 무엇을 보일지(캔버스 보드 SCR-050-m의 renderVals를 옮겼다. 태블릿·데스크톱 보드는 '동의 전' 한 상태).
// '로그인 필요'·'파트너 이름을 읽지 못함'·'거절 확인'·'거절함'은 d5 §5.26 상태 표에서 더했다(추천 적용 2026-11-23, BUILD_ORDER F-05-7, ADR-0362 결정 3·5·8).
// 실제 흐름(StaffInvitationsLive)도 같은 상태 이름으로 이 함수를 부른다. '불러오지 못함'은 d5에 없는 조회 실패(5xx·연결 끊김)다.
import type { Scr050State } from '@/shared/config/screens.account';

/**
 * 본문 모양: 조회 중(뼈대) · 동의 폼 · 이메일 불일치 · 검증 이메일 없음 · 본인확인 필요 · 만료 · 이미 배정 · 수락 완료 · 로그인 필요 · 거절함 · 불러오지 못함
 */
export type InvitationMode = 'loading' | 'form' | 'mismatch' | 'no-verified-email' | 'need-identity' | 'expired' | 'assigned' | 'done' | 'login' | 'rejected' | 'error';

export interface InvitationView {
  mode: InvitationMode;
  /** 맨 위 소개 줄과 초대 요약 카드(조회 중·만료·로그인 필요·거절함·불러오지 못함에는 없다) */
  summary: boolean;
  /** 초대 이메일이 이 계정 이메일과 다르다(카드의 초대 이메일이 다른 주소) */
  otherEmail: boolean;
  /** 초대 요약의 파트너 상호를 읽지 못했다(① 자리에 안내와 [다시 불러오기], 수락 꺼짐, ADR-0362 결정 3) */
  partnerUnreadable: boolean;
  /** 동의 폼의 처음 체크 상태. provideError는 422(동의 누락) 뒤의 파트너 제공 동의 오류 */
  consent: { collect: boolean; provide: boolean; provideError: boolean };
  /** [수락하지 않기]를 누른 뒤의 거절 확인 줄(ADR-0362 결정 5) */
  confirmReject: boolean;
}

const MODE: Record<Scr050State | '불러오지 못함', InvitationMode> = {
  '동의 전': 'form',
  '동의 완료': 'form',
  '동의 누락': 'form',
  '파트너 이름을 읽지 못함': 'form',
  '거절 확인': 'form',
  '이메일 불일치': 'mismatch',
  '검증 이메일 없음': 'no-verified-email',
  '본인확인 필요': 'need-identity',
  만료: 'expired',
  '이미 배정': 'assigned',
  '수락 완료': 'done',
  '조회 중': 'loading',
  '로그인 필요': 'login',
  거절함: 'rejected',
  '불러오지 못함': 'error',
};

export function invitationView(st: Scr050State | '불러오지 못함'): InvitationView {
  const mode = MODE[st];
  return {
    mode,
    summary: mode !== 'loading' && mode !== 'expired' && mode !== 'login' && mode !== 'rejected' && mode !== 'error',
    otherEmail: st === '이메일 불일치',
    partnerUnreadable: st === '파트너 이름을 읽지 못함',
    consent: {
      collect: st === '동의 완료' || st === '동의 누락',
      provide: st === '동의 완료',
      provideError: st === '동의 누락',
    },
    confirmReject: st === '거절 확인',
  };
}
