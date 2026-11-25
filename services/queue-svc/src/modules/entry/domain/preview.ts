// 사전 모의(F-02-5)의 읽기 포트·상수·응답 꼴. 어댑터가 응용 층을 가져오지 않게 도메인에 둔다(architecture §3.1).
export interface QueueWaitingReader {
  waiting(eventId: string): Promise<{ waiting: number; measuredAtMs: number } | undefined>;
}

export interface QueuePreviewCount {
  readonly key: string;
  readonly value: number;
  readonly source: string;
  readonly measuredAtMs: number;
}

export interface QueuePreviewUnavailable {
  readonly key: string;
  readonly reason: string;
}

export const QUEUE_PREVIEW_KEYS = ['waiting'] as const;
