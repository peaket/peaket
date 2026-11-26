// 홈 캐시 무효화(HOT-305, ADR-0199 결정 3, docs/features/search.md §2.4).
// 내부 경로의 토큰 가드·204·no-store·home 태그·apps/web 재검증 호출, 한쪽 실패에도 다른 쪽을 부르는지 본다.
// 기준 트리에서는 내부 경로가 404이고 판매 승인 태그에 home이 없어 실패한다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, MemoryCdnInvalidation } from '../src/modules/catalog/index.js';
import type { CdnInvalidation } from '../src/modules/catalog/domain/media-ports.js';
import { FakeIdentity, NOW_MS, quiet, testMedia } from './support.js';

const TOKEN = 'home-cache-test-token';
const originalToken = process.env.PEAKET_INTERNAL_TOKEN;
const originalWeb = process.env.PEAKET_WEB_INTERNAL_URL;
let web: Server | undefined;
let hits: { method: string | undefined; url: string | undefined; token: string | undefined }[] = [];
let webStatus = 204;

beforeEach(() => {
  hits = [];
  webStatus = 204;
});

afterEach(async () => {
  await new Promise<void>((resolve) => (web ? web.close(() => resolve()) : resolve()));
  web = undefined;
  if (originalToken === undefined) delete process.env.PEAKET_INTERNAL_TOKEN;
  else process.env.PEAKET_INTERNAL_TOKEN = originalToken;
  if (originalWeb === undefined) delete process.env.PEAKET_WEB_INTERNAL_URL;
  else process.env.PEAKET_WEB_INTERNAL_URL = originalWeb;
});

async function startWeb(): Promise<number> {
  web = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, token: req.headers['x-peaket-internal-token'] as string | undefined });
    res.statusCode = webStatus;
    res.end();
  });
  await new Promise<void>((resolve) => web!.listen(0, '127.0.0.1', () => resolve()));
  const address = web.address();
  if (address === null || typeof address === 'string') throw new Error('웹 대역 주소를 읽지 못했다');
  return address.port;
}

async function boot(cdn: CdnInvalidation = new MemoryCdnInvalidation()): Promise<{ svc: Awaited<ReturnType<typeof createService>>; cdn: CdnInvalidation }> {
  const repo = new MemoryCatalogRepository();
  const svc = await createService({
    name: 'core-svc-home-cache',
    module: AppModule.register({ memory: true, catalog: repo, media: testMedia({ cdn }) }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
  return { svc, cdn };
}

const revalidate = (svc: Awaited<ReturnType<typeof createService>>, token?: string) =>
  svc.http.inject({ method: 'POST', url: '/internal/v1/home-cache/revalidate', headers: token === undefined ? {} : { 'x-peaket-internal-token': token } });

describe('홈 캐시 무효화(HOT-305)', () => {
  // 서비스 부팅과 대역 HTTP를 함께 재는 시험이라 이 PC에서 기본 5초를 넘는다(IR-01 시험 고침과 함께 20초로 둔다).
  test('HOT-305 내부 경로는 토큰이 맞을 때만 204·no-store이고 home 태그와 웹 재검증을 부른다 [ASVS v5.0.0-8.1.1]', { timeout: 20_000 }, async () => {
    process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
    const port = await startWeb();
    process.env.PEAKET_WEB_INTERNAL_URL = `http://127.0.0.1:${port}`;
    const cdn = new MemoryCdnInvalidation();
    const { svc } = await boot(cdn);
    try {
      const missing = await revalidate(svc);
      expect(missing.statusCode).toBe(401);
      expect(missing.headers['cache-control']).toBe('no-store');
      expect(missing.headers['x-peaket-cache-tag']).toBeUndefined();
      expect(cdn.calls).toHaveLength(0);
      expect(hits).toHaveLength(0);

      const wrong = await revalidate(svc, 'wrong-token');
      expect(wrong.statusCode).toBe(401);
      expect(wrong.headers['cache-control']).toBe('no-store');
      expect(wrong.headers['x-peaket-cache-tag']).toBeUndefined();
      expect(cdn.calls).toHaveLength(0);
      expect(hits).toHaveLength(0);

      const ok = await revalidate(svc, TOKEN);
      expect(ok.statusCode).toBe(204);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(ok.headers['x-peaket-cache-tag']).toBeUndefined();
      expect(cdn.calls).toEqual([['home']]);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ method: 'POST', url: '/internal/v1/home-cache', token: TOKEN });

      const again = await revalidate(svc, TOKEN);
      expect(again.statusCode).toBe(204);
      expect(cdn.calls).toEqual([['home'], ['home']]);
      expect(hits).toHaveLength(2);
    } finally {
      await svc.close();
    }
  });

  test('HOT-305 CDN이 실패해도 웹 재검증을 부르고 내부 경로는 204를 유지한다 [ASVS v5.0.0-16.5.2]', async () => {
    process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
    const port = await startWeb();
    process.env.PEAKET_WEB_INTERNAL_URL = `http://127.0.0.1:${port}`;
    const cdn: CdnInvalidation = {
      invalidate: async () => {
        throw new Error('cdn down');
      },
      invalidatePaths: async () => ({ requestId: 'test' }),
    };
    const { svc } = await boot(cdn);
    try {
      const r = await revalidate(svc, TOKEN);
      expect(r.statusCode).toBe(204);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ url: '/internal/v1/home-cache', token: TOKEN });
    } finally {
      await svc.close();
    }
  });

  test('HOT-305 웹 재검증이 실패해도 CDN 무효화를 부르고 내부 경로는 204를 유지한다 [ASVS v5.0.0-16.5.2]', async () => {
    process.env.PEAKET_INTERNAL_TOKEN = TOKEN;
    webStatus = 500;
    const port = await startWeb();
    process.env.PEAKET_WEB_INTERNAL_URL = `http://127.0.0.1:${port}`;
    const cdn = new MemoryCdnInvalidation();
    const { svc } = await boot(cdn);
    try {
      const r = await revalidate(svc, TOKEN);
      expect(r.statusCode).toBe(204);
      expect(cdn.calls).toEqual([['home']]);
      expect(hits).toHaveLength(1);
    } finally {
      await svc.close();
    }
  });
});
