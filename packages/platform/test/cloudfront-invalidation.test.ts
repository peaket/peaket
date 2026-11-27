// CloudFront 무효화 어댑터 시험(기능 F-09-4, HOT-450, docs/infra.md:366, RV094-07).
// 실제 AWS를 부르지 않고 주입한 fetch로 CreateInvalidation 요청의 모양만 본다.
// 태그 무효화는 `#event:{id}`처럼 `#` 접두사를 써야 경로 무효화와 구분된다.
import { describe, expect, test } from 'vitest';
import { CloudFrontInvalidation, CloudFrontInvalidationError } from '../src/cloudfront-invalidation.js';

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

function fakeFetch(status = 201, body: unknown = { Invalidation: { Id: 'I2J0EXAMPLE', Status: 'InProgress' } }) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    });
  };
  return { fetch, calls };
}

describe('CloudFront 무효화 어댑터', () => {
  test('태그 무효화는 # 접두사를 붙여 CreateInvalidation을 부른다', async () => {
    const { fetch, calls } = fakeFetch();
    const invalidation = new CloudFrontInvalidation({
      distributionId: 'E2EXAMPLE',
      credentials: CREDENTIALS,
      fetch,
      now: () => new Date('2026-11-27T00:00:00Z'),
    });
    const result = await invalidation.invalidateTags(['event:e1', 'home']);
    expect(result).toEqual({ id: 'I2J0EXAMPLE' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://cloudfront.amazonaws.com/2020-05-31/distribution/E2EXAMPLE/invalidation');
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toContain('<Path>#event:e1</Path>');
    expect(call.init.body).toContain('<Path>#home</Path>');
    expect(call.init.body).toContain('<Quantity>2</Quantity>');
    expect(call.init.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(call.init.headers.Authorization).toMatch(/SignedHeaders=/);
    expect(call.init.headers.Authorization).toMatch(/Signature=/);
    expect(call.init.headers['x-amz-date']).toBe('20261127T000000Z');
  });

  test('경로 무효화는 # 없이 경로를 보낸다', async () => {
    const { fetch, calls } = fakeFetch();
    const invalidation = new CloudFrontInvalidation({
      distributionId: 'E2EXAMPLE',
      credentials: CREDENTIALS,
      fetch,
      now: () => new Date('2026-11-27T00:00:00Z'),
    });
    await invalidation.invalidatePaths(['/v1/search*']);
    expect(calls[0]!.init.body).toContain('<Path>/v1/search*</Path>');
    expect(calls[0]!.init.body).not.toContain('<Path>#');
  });

  test('AWS가 실패를 돌려주면 INVALIDATION_FAILED로 멈춘다(닫힘 실패)', async () => {
    const { fetch } = fakeFetch(403, {});
    const invalidation = new CloudFrontInvalidation({ distributionId: 'E2EXAMPLE', credentials: CREDENTIALS, fetch });
    await expect(invalidation.invalidateTags(['event:e1'])).rejects.toMatchObject({
      code: 'INVALIDATION_FAILED',
    } satisfies Partial<CloudFrontInvalidationError>);
  });

  test('배포 ID·자격 증명이 없으면 CONFIG로 멈춘다', () => {
    for (const options of [
      { distributionId: '', credentials: CREDENTIALS, fetch: fakeFetch().fetch },
      { distributionId: 'E2EXAMPLE', credentials: { accessKeyId: '', secretAccessKey: '' }, fetch: fakeFetch().fetch },
    ]) {
      try {
        new CloudFrontInvalidation(options as never);
        expect.unreachable('CONFIG 오류가 나야 한다');
      } catch (error) {
        expect(error).toMatchObject({ code: 'CONFIG' } satisfies Partial<CloudFrontInvalidationError>);
      }
    }
  });

  test('태그 목록이 비었으면 부르지 않는다', async () => {
    const { fetch, calls } = fakeFetch();
    const invalidation = new CloudFrontInvalidation({ distributionId: 'E2EXAMPLE', credentials: CREDENTIALS, fetch });
    await expect(invalidation.invalidateTags([])).resolves.toEqual({ id: null });
    expect(calls).toHaveLength(0);
  });
});
