// CMP-049 내 순번 검증의 실행 관리(ADR-0232 결정 9): 진행 표시, 취소, 입력을 바꾸면 옛 결과를 버린다. 화면 없이 시험하려고 부품에서 나눴다.

export interface VerifyRunResult {
  fileRank: string;
  recomputedRank: string;
  /** 결과 아래에 보일 안내(확인하지 않은 것 등) */
  note?: string;
}

export interface VerifyRunContext {
  signal: AbortSignal;
  onProgress: (text: string) => void;
}

export type VerifyRunOutcome = VerifyRunResult | { error: string };

export interface VerifyRunState {
  busy: boolean;
  progress: string | null;
  result: VerifyRunResult | null;
  error: string | null;
}

export const IDLE_RUN: VerifyRunState = { busy: false, progress: null, result: null, error: null };

export function createVerifyRun(onVerify: (value: string, ctx: VerifyRunContext) => Promise<VerifyRunOutcome>, set: (s: VerifyRunState) => void) {
  let current: AbortController | null = null;
  const failed = (c: AbortController) => {
    if (current !== c) return;
    current = null;
    set({ ...IDLE_RUN, error: '다시 계산하지 못했습니다' });
  };
  return {
    start(value: string): void {
      if (current) return;
      const c = new AbortController();
      current = c;
      set({ ...IDLE_RUN, busy: true });
      try {
        onVerify(value, {
          signal: c.signal,
          onProgress: (progress) => {
            if (current === c) set({ ...IDLE_RUN, busy: true, progress });
          },
        }).then(
          (r) => {
            if (current !== c) return;
            current = null;
            set('error' in r ? { ...IDLE_RUN, error: r.error } : { ...IDLE_RUN, result: r });
          },
          () => failed(c),
        );
      } catch {
        failed(c);
      }
    },
    /** 취소, 또는 입력을 바꾸면 부른다: 계산을 멈추고 결과를 지운다 */
    cancel(): void {
      current?.abort();
      current = null;
      set(IDLE_RUN);
    },
  };
}
