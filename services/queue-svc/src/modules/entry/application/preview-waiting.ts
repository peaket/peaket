// 빈 뼈대(F-02-5 확인용): 심볼과 꼴만 있고 셈은 아직 없다. 다음 구현 커밋이 실제 값을 채운다.
export const QUEUE_PREVIEW_KEYS: readonly string[] = [];

export type QueueWaitingReader = any;

export class PreviewWaiting {
  constructor(_o: unknown) {}

  async run(_q: { eventId: string; keys: readonly string[] }): Promise<{ status: 'OK'; counts: readonly unknown[]; unavailable: readonly unknown[] }> {
    return { status: 'OK', counts: [], unavailable: [] };
  }
}
