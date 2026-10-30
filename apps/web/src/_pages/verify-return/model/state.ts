// SCR-006 본인확인 흐름 상태별로 무엇을 그릴지(캔버스 보드 SCR-006-m·t·d의 renderVals를 옮겼다).
// 복귀 화면만 이 경로(/verify/return)의 실제 화면이고, 나머지 상태는 부르는 화면(공연 상세·마이 티켓 부스 재발급·추가 검증) 위의 창·대화상자다.
import type { VerifyFlowInitial, VerifyPurpose } from '@/features/identity-verify';
import type { Scr006State } from '@/shared/config/screens.account';

export type VerifyCaller = 'detail' | 'booth' | 'reverify' | 'return';

export interface VerifyView {
  caller: VerifyCaller;
  purpose: VerifyPurpose;
  /** 흐름의 처음 모양(기관 창·결과 대화상자·동의 시트·완료) */
  initial: VerifyFlowInitial;
}

const OUTCOME: Partial<Record<Scr006State, NonNullable<VerifyFlowInitial['outcome']>>> = {
  '창을 닫음·실패': 'closed',
  '기관 장애': 'down',
  '다른 계정의 본인': 'other',
  '만 14세 미만': 'under14',
  '부스 대조 불일치': 'mismatch',
  '팝업 차단': 'popup',
};

export function verifyView(st: Scr006State): VerifyView {
  const booth = st === '부스 대조 목적' || st === '부스 대조 불일치' || st === '부스 대조 동의 없음';
  const rev = st === '재확인 목적';
  const caller: VerifyCaller = st === '복귀 화면' ? 'return' : booth ? 'booth' : rev ? 'reverify' : 'detail';
  return {
    caller,
    purpose: booth ? 'booth' : rev ? 'reverify' : 'first',
    initial: {
      waiting: st === '기관 응답 대기' || st === '부스 대조 목적' || rev,
      outcome: OUTCOME[st] ?? null,
      consentError: st === '부스 대조 동의 없음',
      consented: booth ? st !== '부스 대조 동의 없음' : true,
      done: st === '완료 토스트',
    },
  };
}
