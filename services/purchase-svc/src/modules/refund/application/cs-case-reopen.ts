// CS 건 다시 열기의 한 틱 시간 예산·잇따른 무응답 멈춤(BAT-420 다시 보기 2 N1, transfer-refund §3.1 ⑥, guidelines §8.1 'ops-svc CS 처리함 내부 HTTP').
// 빈 뼈대(시험 담당, 구현 전에 씀): 상수와 꼴만 있고 동작은 구현 담당이 채운다.

/** 한 틱의 다시 열기 시간 예산 5초 [가정] */
export const CS_CASE_REOPEN_BUDGET_MS = 5_000;
/** 시간 초과·연결 실패가 이만큼 잇따르면 그 틱의 다시 열기를 멈춘다(2번 [가정]) */
export const CS_CASE_REOPEN_MAX_UNREACHABLE = 2;

export class CsCaseReopenBudget {
  constructor(_o: { nowMs(): number; budgetMs?: number; maxUnreachable?: number }) {}

  /** 부르기 전에 본다. 남은 예산이 있고 잇따른 무응답 멈춤이 아니면 참 */
  canCall(): boolean {
    throw new Error('아직 없음');
  }

  /** 부른 결과: 'opened' 2xx, 'rejected' CsCaseRejected(2xx 밖 답), 'unreachable' 그 밖에 던진 것(시간 초과·연결 실패) */
  record(_outcome: 'opened' | 'rejected' | 'unreachable'): void {
    throw new Error('아직 없음');
  }

  /** 멈춘 까닭(예산 넘김·잇따른 무응답). 멈추지 않았으면 undefined */
  get cut(): 'budget' | 'unreachable' | undefined {
    throw new Error('아직 없음');
  }
}
