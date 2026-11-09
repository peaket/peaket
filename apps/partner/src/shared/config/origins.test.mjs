// 위저드가 부르는 파트너 API 주소와 CSP connect-src가 같은 값을 쓴다(ADR-0247 결정 5, 리뷰 재현)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCsp } from '@peaket/config/headers/security-headers.mjs';

test('공개 환경값으로 API 주소를 바꾸면 CSP의 connect-src도 그 주소다', async () => {
  process.env.NEXT_PUBLIC_PARTNER_API_ORIGIN = 'http://127.0.0.1:4012';
  const { partnerCspOrigins } = await import('./origins.ts?custom');
  assert.deepEqual(partnerCspOrigins, { partnerApi: 'http://127.0.0.1:4012' });
  assert.match(renderCsp('B', { nonce: 'a'.repeat(24), variants: ['partner'], origins: partnerCspOrigins }), /connect-src 'self' http:\/\/127\.0\.0\.1:4012;/);
});
