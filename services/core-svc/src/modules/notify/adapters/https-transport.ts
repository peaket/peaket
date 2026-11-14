// 실제 웹훅 발송기: HTTPS 443만, 연결마다 해석한 IP가 공인인지 확인하고, 공용 외부 HTTP 클라이언트로 보낸다.
// 리디렉션을 따르지 않고(공용 클라이언트), 응답은 64KiB까지만 읽고 전체 10초 [가정]에 끊는다(docs/features/notify.md §9).
// 남는 한계: fetch는 해석한 IP로 고정 연결하지 못해 DNS 재해석 창이 있다. 발송 파드의 나가는 443 제한(V-T34)이 그 창을 줄인다.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createExternalHttpClient } from '@peaket/platform';
import type { WebhookTransport } from '../domain/ports.js';

const RESPONSE_CAP_BYTES = 64 * 1024;
const TOTAL_TIMEOUT_MS = 10_000;

export class WebhookTransportError extends Error {}

function isPublicIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return false;
    if (v.startsWith('fc') || v.startsWith('fd')) return false;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return false;
    if (v.startsWith('::ffff:')) return isPublicIp(v.slice(7));
    return true;
  }
  return false;
}

function checkUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new WebhookTransportError('https만 보낼 수 있습니다');
  if (url.port !== '' && url.port !== '443') throw new WebhookTransportError('443 포트만 보낼 수 있습니다');
  if (url.username || url.password) throw new WebhookTransportError('주소에 사용자 정보가 있습니다');
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) throw new WebhookTransportError('IP 주소를 그대로 쓴 주소입니다');
  return url;
}

export class HttpsWebhookTransport implements WebhookTransport {
  async send(input: { url: string; headers: Record<string, string>; body: string }): Promise<{ status: number }> {
    const url = checkUrl(input.url);
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) throw new WebhookTransportError('주소를 해석하지 못했습니다');
    if (!addresses.every((a) => isPublicIp(a.address))) throw new WebhookTransportError('사설·루프백 주소로는 보낼 수 없습니다');
    const query = Object.fromEntries(url.searchParams.entries());
    const client = createExternalHttpClient({ provider: 'partner-webhook', baseUrl: url.origin, timeoutCapMs: TOTAL_TIMEOUT_MS });
    const res = await client.request({ method: 'POST', path: url.pathname, query, headers: input.headers, body: input.body });
    const text = await res.text();
    if (Buffer.byteLength(text) > RESPONSE_CAP_BYTES) throw new WebhookTransportError('응답이 64KiB를 넘었습니다');
    return { status: res.status };
  }
}
