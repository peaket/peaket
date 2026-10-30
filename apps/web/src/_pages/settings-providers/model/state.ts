// SCR-040 로그인 수단·계정 합치기 상태별로 무엇을 보일지(캔버스 보드 SCR-040-m·d의 renderVals를 옮겼다.
// '병합 확인'은 데스크톱 보드, '요약 계산 중'은 d5 §5.22 상태 표의 loading에서 더했다).
import type { MergeSummaryStatus } from '@peaket/ds/MergeSummary';
import type { Scr040State } from '@/shared/config/screens.account';

export interface ProvidersView {
  /** 지금 계정이 흡수되어 세션이 끝났다(세션 종료 MERGED) */
  absorbed: boolean;
  /** 연결된 수단이 카카오 하나(합치기 제안 중인 예시 계정) */
  onlyOne: boolean;
  /** 계정 합치기 카드(CMP-056) 상태. 없으면 null */
  merge: MergeSummaryStatus | null;
  /** 재인증 뒤 '두 계정을 합칩니다' 확인 창(CMP-020)이 열려 있다 */
  confirm: boolean;
}

const MERGE: Partial<Record<Scr040State, MergeSummaryStatus>> = {
  '병합 요약': 'ready',
  '병합 확인': 'ready',
  '병합 불가': 'blocked',
  '병합 중': 'merging',
  '제안 만료': 'expired',
  '요약 계산 중': 'loading',
};

export function providersView(st: Scr040State): ProvidersView {
  const merge = MERGE[st] ?? null;
  return {
    absorbed: st === '흡수된 세션 안내',
    onlyOne: merge !== null,
    merge,
    confirm: st === '병합 확인',
  };
}
