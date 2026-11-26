// 어댑터: 소비자 웹 내부 엔드포인트(POST /internal/v1/home-cache)로 Next.js 'home' 캐시 태그를 무효화한다(HOT-305).
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import type { NextCacheInvalidator } from '../domain/next-cache-ports.js';

export const HOME_CACHE_TIMEOUT_MS = 3_000;

export class NoopNextCacheInvalidator implements NextCacheInvalidator {
  async revalidate(_tag: 'home'): Promise<void> {}
}

export class HttpNextCacheInvalidator implements NextCacheInvalidator {
  private cachedUrl: string | undefined;
  private cachedClient: ExternalHttpClient | undefined;

  constructor(
    private readonly readUrl: () => string | undefined = () => process.env.PEAKET_WEB_INTERNAL_URL,
    private readonly readToken: () => string | undefined = () => process.env.PEAKET_INTERNAL_TOKEN,
  ) {}

  async revalidate(_tag: 'home'): Promise<void> {
    const rawUrl = this.readUrl()?.trim();
    if (!rawUrl) return;
    const client = this.#clientFor(rawUrl);
    const token = this.readToken();
    const res = await client.request({
      method: 'POST',
      path: '/internal/v1/home-cache',
      headers: token ? { 'x-peaket-internal-token': token } : {},
      timeoutCapMs: HOME_CACHE_TIMEOUT_MS,
    });
    try {
      if (!res.ok) {
        throw new Error(`home-cache revalidate failed with HTTP ${res.status}`);
      }
    } finally {
      await res.body?.cancel().catch(() => undefined);
    }
  }

  #clientFor(baseUrl: string): ExternalHttpClient {
    if (this.cachedClient && this.cachedUrl === baseUrl) return this.cachedClient;
    const client = createExternalHttpClient({
      provider: 'web-home-cache',
      baseUrl,
      timeoutCapMs: HOME_CACHE_TIMEOUT_MS,
    });
    this.cachedUrl = baseUrl;
    this.cachedClient = client;
    return client;
  }
}
