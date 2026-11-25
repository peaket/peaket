// 빈 뼈대(F-02-5 확인용): 심볼과 꼴만 있고 셈은 아직 없다. 다음 구현 커밋이 실제 값을 채운다.
export const PREVIEW_WINDOW_MS = 60_000;
export const PAYING_COUNT_MAX = 10_000;
export const PREVIEW_DIVISOR = 1;
export const PURCHASE_PREVIEW_KEYS: readonly string[] = [];

export type PurchaseSessionCounter = any;
export type SaleRecordCounter = any;

export class PreviewCounts {
  constructor(_deps: unknown) {}

  async run(_q: { eventId: string; keys: readonly string[] }): Promise<{ status: 'OK'; counts: readonly unknown[]; unavailable: readonly unknown[] }> {
    return { status: 'OK', counts: [], unavailable: [] };
  }
}
