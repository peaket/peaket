// ops-svc CS 처리함 POST /internal/v1/cs-cases 어댑터(offline-gate §7.3 '미보고 스캐너 건', asyncapi CaseRequested).
// 2xx이고 본문 accepted === true일 때만 연 것으로 본다(transfer-refund §3.1 ⑥와 같은 규칙). 그 밖은 false라 부르는 쪽이 다음 판단에 다시 보낸다.
// 건에는 기기·회차 ID만 있고 스태프·관객 정보는 없다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { ScannerCaseSink } from '../domain/ports.js';

export class HttpOpsCaseSink implements ScannerCaseSink {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(c: Parameters<ScannerCaseSink['open']>[0]): Promise<boolean> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/cs-cases',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify(c),
    });
    if (!res.ok) return false;
    try {
      const body = (await res.json()) as { accepted?: unknown };
      return body.accepted === true;
    } catch {
      return false;
    }
  }
}
