// 모의 기관(scripts/mock-idv.mjs)과 시험 어댑터가 서로 맞는지 본다(docs/features/identity.md §5 '모의 기관과 기관 창 흐름', BUILD_ORDER BOT-010, I-T45).
// 모의 기관을 실제 포트로 띄우고, 브라우저가 하는 대로 기관 창 양식 → 기관 화면의 버튼 → 돌아올 주소로 가는 값을 받아 시험 어댑터에 넘긴다.
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startMockIdv } from '../scripts/mock-idv.mjs';
import { ProviderUnavailable } from '../src/modules/verification/domain/verification.js';
import { AGENCY_SECRET, testAgency } from './support.js';

const RETURN_URL = 'http://localhost:3000/verify/return';
const ID = '0190f3a1-7c2e-7a00-8000-00000000a001';
let agency: Awaited<ReturnType<typeof startMockIdv>>;

beforeAll(async () => {
  agency = await startMockIdv({ port: 0, returnUrl: RETURN_URL, secret: AGENCY_SECRET, env: { PEAKET_ENV: 'ci' } });
});
afterAll(async () => {
  await agency?.close();
});

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const post = (path: string, body: Record<string, string>) =>
  fetch(new URL(path, agency.url), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body), redirect: 'manual' });

/** 스스로 제출되는 양식에서 주소와 숨은 칸을 읽는다 */
function autoForm(html: string): { action: string; method: string; fields: Record<string, string> } {
  const tag = /<form\b[^>]*>/i.exec(html)?.[0];
  if (!tag) throw new Error('양식이 없다');
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)?.[1] ?? '';
  const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]!] = unesc(m[2]!);
  return { action: unesc(attr('action')), method: attr('method'), fields };
}

describe('모의 기관', () => {
  test('I-T45_기관창양식을받으면_결과고르기화면을그리고_건ID는숨은칸으로만싣는다', async () => {
    const r = await post('/verify', { verificationId: ID });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await r.text();
    expect(html).toContain('모의 본인확인기관');
    expect(html).toContain('action="/verify/complete"');
    expect(html).toContain(`<input type="hidden" name="verificationId" value="${ID}">`);
    for (const label of ['본인확인 완료', '취소', '실패', '기관 장애', 'POST 본문', '쿼리']) expect(html).toContain(label);
  });

  test('I-T45_건ID모양이아니면_400이고값을화면에넣지않는다', async () => {
    const bad = '"><script>alert(1)</script>';
    const r = await post('/verify', { verificationId: bad });
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain('<script>alert(1)');
    expect((await post('/verify/complete', { verificationId: bad, action: 'complete', person: 'x', returnStyle: 'post' })).status).toBe(400);
  });

  test('I-T45_POST본문복귀_완료를누르면돌아올주소로스스로제출되는양식이고_시험어댑터가VERIFIED로받는다', async () => {
    const r = await post('/verify/complete', { verificationId: ID, action: 'complete', person: 'kim', birth: '2001-02-03', returnStyle: 'post' });
    expect(r.status).toBe(200);
    const f = autoForm(await r.text());
    expect(f).toMatchObject({ action: RETURN_URL, method: 'post' });
    expect(Object.keys(f.fields).sort()).toEqual(['mac', 'result', 'verificationId']);
    expect(f.fields.verificationId).toBe(ID);
    const clock = fakeClock({ now: Date.now() });
    expect(await testAgency(clock).confirm(ID, f.fields)).toMatchObject({ outcome: 'VERIFIED' });
    // 다른 건에는 쓸 수 없다
    expect(await testAgency(clock).confirm('0190f3a1-7c2e-7a00-8000-00000000a002', { ...f.fields, verificationId: '0190f3a1-7c2e-7a00-8000-00000000a002' })).toEqual({ outcome: 'FAILED' });
  });

  test('I-T45_쿼리복귀_303으로돌아올주소에결과칸셋을붙이고_시험어댑터가받는다', async () => {
    const r = await post('/verify/complete', { verificationId: ID, action: 'complete', person: 'lee', birth: '1999-12-31', returnStyle: 'query' });
    expect(r.status).toBe(303);
    const loc = new URL(r.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(RETURN_URL);
    const fields = Object.fromEntries(loc.searchParams);
    expect(Object.keys(fields).sort()).toEqual(['mac', 'result', 'verificationId']);
    expect(await testAgency(fakeClock({ now: Date.now() })).confirm(ID, fields)).toMatchObject({ outcome: 'VERIFIED' });
  });

  test('I-T45_취소·실패·기관장애는_시험어댑터가CANCELLED·FAILED·기관장애로받는다', async () => {
    const provider = testAgency(fakeClock({ now: Date.now() }));
    const fieldsOf = async (action: string) => autoForm(await (await post('/verify/complete', { verificationId: ID, action, person: '', returnStyle: 'post' })).text()).fields;
    expect(await provider.confirm(ID, await fieldsOf('cancel'))).toEqual({ outcome: 'CANCELLED' });
    expect(await provider.confirm(ID, await fieldsOf('fail'))).toEqual({ outcome: 'FAILED' });
    await expect(provider.confirm(ID, await fieldsOf('down'))).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  test('I-T45_모르는버튼·돌려주는방식·긴이름표·틀린생년월일은_400이다', async () => {
    const base = { verificationId: ID, action: 'complete', person: 'kim', birth: '2001-02-03', returnStyle: 'post' };
    for (const o of [{ action: 'hack' }, { returnStyle: 'fragment' }, { person: 'x'.repeat(65) }, { birth: '2001/02/03' }]) {
      expect((await post('/verify/complete', { ...base, ...o })).status).toBe(400);
    }
    expect((await post('/verify/complete', { ...base, birth: '' })).status).toBe(200);
  });

  test('I-T45_모의기관은local·ci에서만돌고_127.0.0.1에만묶는다', async () => {
    expect(new URL(agency.url).hostname).toBe('127.0.0.1');
    for (const env of [{ PEAKET_ENV: 'prod' }, { PEAKET_ENV: 'demo' }, {}]) {
      await expect(startMockIdv({ port: 0, returnUrl: RETURN_URL, secret: AGENCY_SECRET, env })).rejects.toThrow(/local·ci/);
    }
    await expect(startMockIdv({ port: 0, returnUrl: 'javascript:alert(1)', secret: AGENCY_SECRET, env: { PEAKET_ENV: 'ci' } })).rejects.toThrow();
  });
});

test('I-T45_모의기관은_Host가루프백이름이아니면421이다(DNS리바인딩, 새맥락리뷰L7)', async () => {
  const { request } = await import('node:http');
  const port = new URL(agency.url).port;
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const q = request({ host: '127.0.0.1', port, method: 'POST', path: '/verify', headers: { host: `evil.example:${port}`, 'content-type': 'application/x-www-form-urlencoded' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    q.on('error', reject);
    q.end(new URLSearchParams({ verificationId: ID }).toString());
  });
  expect(status).toBe(421);
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const ok = await new Promise<number | undefined>((resolve, reject) => {
      const q = request({ host: '127.0.0.1', port, method: 'POST', path: '/verify', headers: { host, 'content-type': 'application/x-www-form-urlencoded' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      q.on('error', reject);
      q.end(new URLSearchParams({ verificationId: ID }).toString());
    });
    expect(ok).toBe(200);
  }
});
