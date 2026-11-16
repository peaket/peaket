// 입장 기록 대조로 나온 '취소한 뒤 들어옴'을 ops-svc CS 처리함 FLAGGED(category ENTRY_AFTER_CANCEL)로 여는 어댑터(BAT-420 GAT-090 A, 빈 뼈대).
// POST /internal/v1/cs-cases, 본문 { eventKey: `entry-after-cancel:${cancellationId}`, kind: 'FLAGGED', sourceId, category, createdAt }, 내부 토큰 머리, 5초, 실패는 삼킨다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { EntryFlagNotice } from '../domain/ports.js';

export class HttpEntryFlagNotice implements EntryFlagNotice {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(_q: Parameters<EntryFlagNotice['open']>[0]): Promise<void> {
    void this.client;
    void this.internalToken;
    throw new Error('아직 없음');
  }
}
