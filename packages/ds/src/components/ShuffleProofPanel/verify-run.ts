// CMP-049 내 순번 검증의 실행 관리(ADR-0232 결정 9): 진행 표시, 취소, 입력을 바꾸면 옛 결과를 버린다. 화면 없이 시험하려고 부품에서 나눴다.

export interface VerifyRunResult {
  fileRank: string;
  recomputedRank: string;
  /** 다시 계산이 일치했는가. 위의 둘은 표시 글이라 비교하지 않는다(값이 어긋나면 글이 우연히 같을 수 있다) */
  matched: boolean;
  /** 결과 아래에 보일 안내(확인하지 않은 것 등) */
  note?: string;
  /** 순번 비교만으로 결론을 낼 수 없을 때의 결론(비상 셔플의 한계, 읽지 못한 공시, ADR-0239) */
  conclusion?: VerifyConclusion;
}

export interface VerifyConclusion {
  tone: 'warning' | 'danger';
  title: string;
}

export interface VerifyVerdict {
  tone: 'success' | 'warning' | 'danger';
  title: string;
}

/** 결과 배너의 결론. 일치가 아니면 부르는 쪽이 준 주의 결론은 쓰지 않고 실패로 낸다(안전한 쪽으로) */
export function verdictOf(r: VerifyRunResult): VerifyVerdict {
  const matched = r.matched === true;
  if (r.conclusion && (matched || r.conclusion.tone === 'danger')) return r.conclusion;
  return matched ? { tone: 'success', title: '다시 계산한 순번이 결과 파일과 같습니다' } : { tone: 'danger', title: '다시 계산한 순번이 결과 파일과 다릅니다' };
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
