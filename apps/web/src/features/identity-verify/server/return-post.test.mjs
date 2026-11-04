// 본인확인 복귀 화면의 서버 처리기(docs/features/identity.md §5 '복귀 화면의 서버 처리기', BUILD_ORDER BOT-010, I-T45).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAgencyFields, encodeAgencyFields, readAgencyPost, RETURN_HEADER, verifyReturnProxy } from './return-post.ts';

const ID = '0190f3a1-7c2e-7a00-8000-00000000c001';
const FIELDS = { verificationId: ID, result: 'eyJ2IjoxfQ', mac: 'm'.repeat(43) };
const post = (body, type = 'application/x-www-form-urlencoded', extra = {}) =>
  new Request('http://localhost:3000/verify/return', { method: 'POST', headers: { 'content-type': type, ...extra }, body });

test('I-T45 POST 본문 복귀: 양식 본문을 칸으로 읽고, 내부 머리 값으로 봉했다가 그대로 연다', async () => {
  const f = await readAgencyPost(post(new URLSearchParams(FIELDS).toString()));
  assert.deepEqual(f, FIELDS);
  assert.deepEqual(decodeAgencyFields(encodeAgencyFields(f)), FIELDS);
  assert.deepEqual(await readAgencyPost(post(new URLSearchParams(FIELDS).toString(), 'application/x-www-form-urlencoded; charset=UTF-8')), FIELDS);
});

test('I-T45 POST 본문 복귀: 형식·크기·칸 수·칸 이름·값 길이·같은 이름 두 번이 틀리면 받지 않는다', async () => {
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, 'v']));
  for (const r of [
    post(JSON.stringify(FIELDS), 'application/json'),
    post(new URLSearchParams(FIELDS).toString(), 'multipart/form-data; boundary=x'),
    post(`verificationId=${ID}&big=${'x'.repeat(16 * 1024)}`),
    post(new URLSearchParams(many).toString()),
    post(`verificationId=${ID}&bad%20name=1`),
    post(`verificationId=${ID}&${'n'.repeat(65)}=1`),
    post(`verificationId=${ID}&v=${'x'.repeat(4097)}`),
    post(`verificationId=${ID}&verificationId=${ID}`),
    post(''),
  ])
    assert.equal(await readAgencyPost(r), null);
  assert.ok(await readAgencyPost(post(`verificationId=${ID}&v=${'x'.repeat(4096)}`)));
});

test('I-T45 내부 머리 값은 모양을 다시 보고, 틀리면 열지 않는다', () => {
  for (const v of [null, '', '!!!', Buffer.from('[1,2]').toString('base64url'), Buffer.from('{"a":1}').toString('base64url'), Buffer.from('{"a b":"1"}').toString('base64url')])
    assert.equal(decodeAgencyFields(v), null);
  assert.deepEqual(decodeAgencyFields(Buffer.from('{"verificationId":"x"}').toString('base64url')), { verificationId: 'x' });
});

test('I-T45 ASVS v5.0.0-14.2.1 가로채기: POST는 값을 화면 서버 쪽 머리로만 넘기고 주소는 그대로이며, 바깥에서 온 같은 머리는 지운다', async () => {
  const forged = encodeAgencyFields({ verificationId: ID, result: 'forged', mac: 'x' });
  const ok = await verifyReturnProxy(post(new URLSearchParams(FIELDS).toString(), undefined, { [RETURN_HEADER]: forged, 'next-action': 'abc' }));
  assert.equal(ok.kind, 'next');
  assert.deepEqual(decodeAgencyFields(ok.requestHeaders.get(RETURN_HEADER)), FIELDS);
  assert.equal(ok.requestHeaders.get('next-action'), null);
  const get = await verifyReturnProxy(new Request('http://localhost:3000/verify/return?verificationId=1', { headers: { [RETURN_HEADER]: forged } }));
  assert.equal(get.kind, 'next');
  assert.equal(get.requestHeaders.get(RETURN_HEADER), null);
  for (const r of [ok, get]) assert.deepEqual(r.responseHeaders, { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'unsafe-none' });
  const bad = await verifyReturnProxy(post('verificationId=1&verificationId=2'));
  assert.equal(bad.kind, 'reject');
  assert.equal(bad.status, 400);
  const put = await verifyReturnProxy(new Request('http://localhost:3000/verify/return', { method: 'PUT', body: 'x' }));
  assert.equal(put.kind, 'reject');
  assert.equal(put.status, 405);
});

test('I-T45 복귀 화면은 COOP unsafe-none이라 기관 화면에서 넘어와도 부르는 화면과 창 관계가 끊기지 않는다(새 맥락 리뷰 M1)', async () => {
  const d = await verifyReturnProxy(new Request('http://localhost:3000/verify/return'));
  assert.equal(d.responseHeaders['cross-origin-opener-policy'], 'unsafe-none');
});
