// 명령 12 온세일 윈도우의 판매 시작 읽기(ADR-0349 결정 2, BAT-360 B14). core-svc 내부 판매 설정 GET /internal/v1/events/{eventId}/sale-config(서비스 사이 토큰)의
// opensAtMs(판매 시작 T, 끝난 회차 목록 onsale-closed와 같은 칸)를 읽는다. 404(판매 승인 전)는 undefined, 그 밖의 상태·모양이 틀린 답·5초 [가정] 초과는 던진다
// (받는 쪽이 503 onsale-window-unavailable로 바꾸고 명령·감사 기록을 남기지 않는다).
import type { ExternalHttpClient } from '@peaket/platform';
import type { OnsaleStartSource } from '../domain/ports.js';

/** core 내부 호출 한도(5초, ADR-0349 결정 2) */
const TIMEOUT_MS = 5_000;

export class HttpCoreSaleStart implements OnsaleStartSource {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async saleStartMs(eventId: string): Promise<number | undefined> {
    const res = await this.client.request({
      method: 'GET',
      path: '/internal/v1/events/{eventId}/sale-config',
      params: { eventId },
      headers: this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {},
      timeoutCapMs: TIMEOUT_MS,
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`core-svc sale config ${res.status}`);
    const body = (await res.json()) as { opensAtMs?: unknown };
    if (typeof body.opensAtMs !== 'number' || !Number.isFinite(body.opensAtMs)) throw new Error('core-svc sale config 모양이 다르다(opensAtMs)');
    return body.opensAtMs;
  }
}
