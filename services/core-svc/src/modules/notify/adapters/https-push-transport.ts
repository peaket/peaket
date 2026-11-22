// BAT-455 실제 웹 푸시 전송기: 보낼 때마다 주소·DNS를 다시 검사하고 https 443으로만 보낸다. 리디렉션을 따르지 않는다(notify §4.4).
// 공용 외부 HTTP 클라이언트(createExternalHttpClient)를 써서 span·정규 로그·시간 초과·리디렉션 거부를 같은 규칙으로 맞춘다(V-T31, ASVS 15.3.2).
// 남는 한계: 공용 클라이언트는 해석한 IP로 고정 연결하지 못해 DNS 재해석 창이 있다(웹훅 전송기와 같다). 발송 파드의 나가는 443 제한이 그 창을 줄인다.
import { lookup as dnsLookup } from 'node:dns/promises';
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { checkPushEndpoint, isPublicAddress } from '../domain/fan-notify.js';
import type { PushLookup, PushSendInput, PushSendResult, PushTransport } from '../domain/fan-notify-ports.js';

const TIMEOUT_MS = 10_000;

export class HttpsPushTransport implements PushTransport {
  constructor(private readonly o: { fetch?: typeof fetch; lookup?: PushLookup; client?: (origin: string) => ExternalHttpClient } = {}) {}

  async send(input: PushSendInput): Promise<PushSendResult> {
    const parts = checkPushEndpoint(input.endpoint);
    const lookup = this.o.lookup ?? (async (h: string) => dnsLookup(h, { all: true, verbatim: true }));
    const addresses = await lookup(parts.host);
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) throw new Error('푸시 서비스가 공인 주소로 풀리지 않습니다');
    const url = new URL(input.endpoint);
    const client = this.o.client?.(url.origin) ?? createExternalHttpClient({ provider: 'web-push', baseUrl: url.origin, timeoutCapMs: TIMEOUT_MS, ...(this.o.fetch ? { fetch: this.o.fetch } : {}) });
    const res = await client.request({
      method: 'POST',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: input.headers,
      body: input.body,
    });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status };
  }
}
