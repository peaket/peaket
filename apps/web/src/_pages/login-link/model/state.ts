// SCR-039 계정 연결 제안 상태별로 무엇을 보일지(캔버스 보드 SCR-039-m의 renderVals를 옮겼다).
import type { AccountLinkStatus } from '@peaket/ds/AccountLinkPrompt';
import type { Scr039State } from '@/shared/config/screens.account';

export interface LinkView {
  /** 제안 카드(CMP-055)의 상태. 연결 성공이면 null(원래 화면으로 돌아간다) */
  prompt: AccountLinkStatus | null;
  /** 연결 성공: 원래 화면을 불러오는 뼈대 + 토스트 */
  success: boolean;
}

const PROMPT: Record<Scr039State, AccountLinkStatus | null> = {
  제안: 'proposed',
  '카카오 인증 중': 'verifying',
  '다른 계정으로 인증': 'error',
  '연결 성공': null,
  만료: 'expired',
};

export function linkView(st: Scr039State): LinkView {
  return { prompt: PROMPT[st], success: st === '연결 성공' };
}
