// 퍼블리싱 상태 고르기(add-screen-publishing design.md 결정 7). 데이터 연결 단계에서 걷어 낸다.
// 상태 이름은 디자인 캔버스 보드의 state 열거값(한국어) 그대로다. 예: /dashboard?state=제어 입력 없음
import { useSearchParams } from 'react-router';
import { resolvePreviewState } from '@peaket/ds/Preview';

/** ?state=를 읽는다. 모르는 값이면 기본 상태 */
export function usePreviewState<S extends string>(states: readonly S[], fallback: S): S {
  const [params] = useSearchParams();
  return resolvePreviewState(params, states, fallback);
}

/** 상태 고르기 패널이 남길 다른 검색 값(theme·role·designation·event·tab) */
export function usePreviewKeep(): Record<string, string | undefined> {
  const [params] = useSearchParams();
  const keep: Record<string, string | undefined> = {};
  for (const k of ['theme', 'role', 'designation', 'event', 'tab']) {
    const v = params.get(k);
    if (v) keep[k] = v;
  }
  return keep;
}
