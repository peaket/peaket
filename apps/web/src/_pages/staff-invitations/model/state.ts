// SCR-050 현장 스태프 초대 수락 상태별로 무엇을 보일지(캔버스 보드 SCR-050-m의 renderVals를 옮겼다. 태블릿·데스크톱 보드는 '동의 전' 한 상태).
import type { Scr050State } from '@/shared/config/screens.account';

/**
 * 본문 모양: 조회 중(뼈대) · 동의 폼 · 이메일 불일치 · 검증 이메일 없음 · 본인확인 필요 · 만료 · 이미 배정 · 수락 완료
 */
export type InvitationMode = 'loading' | 'form' | 'mismatch' | 'no-verified-email' | 'need-identity' | 'expired' | 'assigned' | 'done';

export interface InvitationView {
  mode: InvitationMode;
  /** 맨 위 소개 줄과 초대 요약 카드(조회 중·만료에는 없다) */
  summary: boolean;
  /** 초대 이메일이 이 계정 이메일과 다르다(카드의 초대 이메일이 다른 주소) */
  otherEmail: boolean;
  /** 동의 폼의 처음 체크 상태. provideError는 422(동의 누락) 뒤의 파트너 제공 동의 오류 */
  consent: { collect: boolean; provide: boolean; provideError: boolean };
}

const MODE: Record<Scr050State, InvitationMode> = {
  '동의 전': 'form',
  '동의 완료': 'form',
  '동의 누락': 'form',
  '이메일 불일치': 'mismatch',
  '검증 이메일 없음': 'no-verified-email',
  '본인확인 필요': 'need-identity',
  만료: 'expired',
  '이미 배정': 'assigned',
  '수락 완료': 'done',
  '조회 중': 'loading',
};

export function invitationView(st: Scr050State): InvitationView {
  const mode = MODE[st];
  return {
    mode,
    summary: mode !== 'loading' && mode !== 'expired',
    otherEmail: st === '이메일 불일치',
    consent: {
      collect: st === '동의 완료' || st === '동의 누락',
      provide: st === '동의 완료',
      provideError: st === '동의 누락',
    },
  };
}
