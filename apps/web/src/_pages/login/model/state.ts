// SCR-004 로그인 상태별로 무엇을 보일지(캔버스 보드 SCR-004-m의 renderVals를 옮겼다. 세션 종료 사유 다섯은 d5 §3.5 표에서 더했다).
import type { SessionEndReason } from '@/entities/provider';
import type { Scr004State } from '@/shared/config/screens.account';

export interface LoginView {
  /** 누른 버튼(카카오)만 스피너, 나머지 비활성 */
  busy: boolean;
  error: boolean;
  /** 카카오만 장애(identity §10) */
  outage: boolean;
  /** 세션이 끝나서 왔을 때 사유(SessionTerminated) */
  sessionEnd: SessionEndReason | null;
}

const SESSION_END: Partial<Record<Scr004State, SessionEndReason>> = {
  '세션 종료 안내': 'LOGOUT',
  '세션 종료 · 운영자 강제 종료': 'ADMIN_FORCE',
  '세션 종료 · 재사용 탐지': 'REFRESH_REUSE',
  '세션 종료 · 기기 5대 초과': 'DEVICE_LIMIT',
  '세션 종료 · 계정 병합': 'MERGED',
  '세션 종료 · 탈퇴': 'DELETE',
};

export function loginView(st: Scr004State): LoginView {
  return {
    busy: st === '진행 중',
    error: st === '에러',
    outage: st === '제공자 장애',
    sessionEnd: SESSION_END[st] ?? null,
  };
}
