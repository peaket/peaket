// SCR-017 계정 설정 상태별로 무엇을 보일지(캔버스 보드 SCR-017-m의 renderVals를 옮겼다. 태블릿·데스크톱 보드는 그 부분집합이다).
// '기기 목록 로딩'은 d5 §5.17 상태 표에서 더했다(스피너).
// '탈퇴 확인 · 부정 예매 …' 둘은 d5 §5.17 탈퇴 단계 그림의 두 줄(탈퇴 409 fraudHold의 state)이다(ADR-0173 결정 7).
// '본인확인 전'은 d5 §5.17 ①의 [ 지금 본인확인 ] 갈래다(2026-11-05, BOT-020이 넘긴 것).
// '스태프 세션 …' 넷은 d5 §5.17 '스태프 세션' 행들이다(2026-11-23, BUILD_ORDER F-05-7, ADR-0362 결정 7).
import type { Scr017State } from '@/shared/config/screens.account';

/** 처음 열린 채로 그릴 겹침 창 */
export type SettingsOverlay =
  | { kind: 'reauth'; failed: boolean }
  | { kind: 'withdraw'; refund: 'none' | 'vb-now' | 'vb-later'; fraudHold?: 'RESTRICTED' | 'CASE_OPEN' }
  | { kind: 'logout' };

export type SettingsDone = 'done' | 'deferred' | 'pay-wait';

export interface SettingsView {
  /** 탈퇴 뒤 화면(완료·미룸·결제 확정 대기). 없으면 계정 설정 본문 */
  done: SettingsDone | null;
  /** 예매 제한 중(소명 기한 배지 + 소명하기) */
  restricted: boolean;
  /** 원격 로그아웃을 마쳐 Safari · iPhone이 목록에서 빠지고 토스트를 띄운다 */
  remoteLoggedOut: boolean;
  devicesLoading: boolean;
  /** 본인확인을 마친 계정으로 그린다. false면 ① 자리에 [지금 본인확인] */
  verified: boolean;
  /** 현장 스캐너 세션 줄의 미리보기: 줄 있음(기본) · 끝냄(토스트, 줄 빠짐) · 이미 끝남(토스트, 줄 빠짐) · 못 불러옴(줄 자리에 실패 안내) */
  scanner: 'shown' | 'ended' | 'gone' | 'failed';
  overlay: SettingsOverlay | null;
}

export function settingsView(st: Scr017State): SettingsView {
  const done: SettingsDone | null =
    st === '탈퇴 완료' ? 'done' : st === '탈퇴 접수(미룸)' ? 'deferred' : st === '탈퇴 접수 · 결제 확정 대기' ? 'pay-wait' : null;
  let overlay: SettingsOverlay | null = null;
  if (st === '원격 로그아웃 재인증' || st === '재인증 실패') overlay = { kind: 'reauth', failed: st === '재인증 실패' };
  else if (st === '탈퇴 확인') overlay = { kind: 'withdraw', refund: 'none' };
  else if (st === '탈퇴 확인 · 가상계좌 지금 환급') overlay = { kind: 'withdraw', refund: 'vb-now' };
  else if (st === '탈퇴 확인 · 가상계좌 나중 환급') overlay = { kind: 'withdraw', refund: 'vb-later' };
  else if (st === '탈퇴 확인 · 부정 예매 이용 제한 중') overlay = { kind: 'withdraw', refund: 'none', fraudHold: 'RESTRICTED' };
  else if (st === '탈퇴 확인 · 부정 예매 소명 요청 받음') overlay = { kind: 'withdraw', refund: 'none', fraudHold: 'CASE_OPEN' };
  else if (st === '로그아웃 확인') overlay = { kind: 'logout' };
  return {
    done,
    restricted: st === '예매 제한 중',
    remoteLoggedOut: st === '원격 로그아웃 완료',
    devicesLoading: st === '기기 목록 로딩',
    verified: st !== '본인확인 전',
    scanner: st === '스태프 세션 끝냄' ? 'ended' : st === '이미 끝난 스태프 세션' ? 'gone' : st === '스태프 세션 못 불러옴' ? 'failed' : 'shown',
    overlay,
  };
}
