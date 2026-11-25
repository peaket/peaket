// 사전 모의 응답의 공통 꼴(F-02-5, ADR-0365 결정 16). 각 받는 쪽이 이 꼴로 답한다.
export interface PreviewCount {
  readonly key: string;
  readonly value: number;
  readonly source: string;
  readonly measuredAtMs: number;
}

export interface PreviewUnavailable {
  readonly key: string;
  readonly reason: string;
}
