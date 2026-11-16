// 파트너 회차 소속 확인(BAT-420 GAT-110 P, 빈 뼈대). core-svc 내부 판매 설정(GET /internal/v1/events/{eventId}/sale-config)을 읽는다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { EventOwnerLookup } from '../modules/event-cancellations/domain/ports.js';

export class HttpCoreEventOwners implements EventOwnerLookup {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async find(_eventId: string): Promise<{ promoterId: string; startsAtMs: number; endsAtMs?: number } | undefined> {
    void this.client;
    void this.internalToken;
    throw new Error('아직 없음');
  }
}
