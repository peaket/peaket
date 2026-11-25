// 자동 조절 복귀 확인(C-T31 ③, F-03-7).
// 정본: docs/features/control-tower.md §6의 6 — 입력 없음이 풀린 뒤 운영자가 명시적으로 확인해야 자동 조정으로 돌아간다.
// 서버 확인 경로가 아직 없어(계획 '하지 않는다') 화면은 대화상자를 띄우되 확인 전송을 막는다. 확인 전 증액 없음은 서버 판정이다.

export const AUTO_RESUME_UNAVAILABLE = '자동 조절 복귀 확인 경로가 아직 서버에 없습니다';

export function autoResumePrompt(prevKind: string, nextKind: string): 'none' | 'open' {
  if (prevKind !== 'no-input') return 'none';
  return nextKind === 'ok' || nextKind === 'paused' ? 'open' : 'none';
}

export function autoResumeView(state: 'none' | 'open'): { kind: 'none' | 'open'; confirmable: boolean; why?: string } {
  if (state === 'none') return { kind: 'none', confirmable: false };
  return { kind: 'open', confirmable: false, why: AUTO_RESUME_UNAVAILABLE };
}
