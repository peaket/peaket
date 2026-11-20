// BAT-172 T2: 같은 출처 스크립트 SRI 판정의 순수 함수 시험(ASVS v5.0.0-3.6.1, ADR-0326).
// 잘못된 형식·빈 해시·바이트 불일치·표 키 없음·빈 결과가 통과로 새지 않는지 본다. 실행: cd tools/web-checks && pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SRI_SHA256_PATTERN,
  integrityOfBytes,
  isSriSha256,
  judgeScript,
  judgeScripts,
  manifestKeyOf,
  parseSriManifest,
  scriptTagsFromHtml,
  scriptUrlOf,
} from '../test/sri.mjs';

const ORIGIN = 'http://127.0.0.1:4101';
const EMPTY_SHA256 = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';
const CHUNK = integrityOfBytes('chunk');
const OWN = integrityOfBytes('seed');

/** 같은 출처 `/seed-color-mode.js`와 덩어리 하나가 표·바이트와 맞는 바탕 */
function context(overrides = {}) {
  const manifest = new Map([['static/chunks/a.js', CHUNK]]);
  const hashes = new Map([
    [`${ORIGIN}/seed-color-mode.js`, OWN],
    [`${ORIGIN}/_next/static/chunks/a.js`, CHUNK],
  ]);
  return { origin: ORIGIN, manifest, hashes, ...overrides };
}

test('BAT-172 SRI 형식: sha256- + base64 44글자만 받고 md5·접두 없음·빈 값·빈 해시는 거른다', () => {
  assert.match(EMPTY_SHA256, SRI_SHA256_PATTERN);
  assert.equal(isSriSha256(EMPTY_SHA256), true);
  for (const bad of ['', 'sha256-', 'md5-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=', 'sha256', '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=', 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU', null, undefined]) {
    assert.equal(isSriSha256(bad), false, String(bad));
  }
});

test('BAT-172 받은 바이트 해시: 빈 바이트의 SHA-256을 sha256-… 꼴로 낸다', () => {
  assert.equal(integrityOfBytes(''), EMPTY_SHA256);
  assert.equal(integrityOfBytes(Buffer.from('')), EMPTY_SHA256);
  assert.notEqual(integrityOfBytes('a'), integrityOfBytes('b'));
});

test('BAT-172 주소 정규화: 상대·절대·?dpl=을 출처+경로로 풀고 쿼리를 버린다', () => {
  assert.deepEqual(scriptUrlOf('/seed-color-mode.js', `${ORIGIN}/events/e1`), { origin: ORIGIN, pathname: '/seed-color-mode.js', key: `${ORIGIN}/seed-color-mode.js` });
  assert.deepEqual(scriptUrlOf(`${ORIGIN}/_next/static/chunks/a.js?dpl=abc`, ORIGIN), { origin: ORIGIN, pathname: '/_next/static/chunks/a.js', key: `${ORIGIN}/_next/static/chunks/a.js` });
  assert.equal(scriptUrlOf('https://cdn.example/x.js', ORIGIN).origin, 'https://cdn.example');
});

test('BAT-172 SRI 표 키: /_next/static/…은 앞 /_next/를 뺀 static/…, /_next/ 밖은 null', () => {
  assert.equal(manifestKeyOf('/_next/static/chunks/a.js?dpl=abc', ORIGIN), 'static/chunks/a.js');
  assert.equal(manifestKeyOf(`${ORIGIN}/_next/static/chunks/a.js`, ORIGIN), 'static/chunks/a.js');
  assert.equal(manifestKeyOf('/_next/image?url=x', ORIGIN), 'image');
  assert.equal(manifestKeyOf('/seed-color-mode.js', ORIGIN), null);
  assert.equal(manifestKeyOf('https://cdn.example/_next/static/a.js', ORIGIN), 'static/a.js');
});

test('BAT-172 HTML 파싱: src 있는 실행 스크립트의 src·integrity만 모으고 인라인·데이터 블록은 뺀다', () => {
  const html = [
    '<script src="/seed-color-mode.js" integrity="sha256-abc" nonce="n"></script>',
    "<script nonce='n' src='/_next/static/chunks/a.js?dpl=x'></script>",
    '<script src=/_next/static/chunks/b.js integrity=sha256-def></script>',
    '<script>self.__next_f.push(1)</script>',
    '<script type="application/ld+json">{"a":1}</script>',
    '<script src="/x.js?a=1&amp;b=2" integrity="sha256-ghi"></script>',
  ].join('');
  assert.deepEqual(scriptTagsFromHtml(html), [
    { src: '/seed-color-mode.js', integrity: 'sha256-abc' },
    { src: '/_next/static/chunks/a.js?dpl=x', integrity: '' },
    { src: '/_next/static/chunks/b.js', integrity: 'sha256-def' },
    { src: '/x.js?a=1&b=2', integrity: 'sha256-ghi' },
  ]);
});

test('BAT-172 SRI 표: 키→값을 읽고 빈 표·틀린 값·배열·앞 / 키는 던진다', () => {
  assert.deepEqual([...parseSriManifest({ 'static/chunks/a.js': CHUNK })], [['static/chunks/a.js', CHUNK]]);
  assert.throws(() => parseSriManifest({}), /0개/);
  assert.throws(() => parseSriManifest({ 'static/a.js': 'md5-x' }), /sha256/);
  assert.throws(() => parseSriManifest({ 'static/a.js': '' }), /sha256/);
  assert.throws(() => parseSriManifest([]), /객체/);
  assert.throws(() => parseSriManifest(null), /객체/);
  assert.throws(() => parseSriManifest({ '/_next/static/a.js': CHUNK }), /앞 \//);
});

test('BAT-172 우리 것(/_next/ 밖): integrity 형식과 받은 바이트가 같아야 하고 없거나 틀리면 실패한다', () => {
  const tag = { src: '/seed-color-mode.js', integrity: OWN };
  assert.deepEqual(judgeScript(tag, context()), { kind: 'own', key: null, problems: [] });
  assert.match(judgeScript({ src: '/seed-color-mode.js', integrity: '' }, context()).problems.join('\n'), /integrity가 없다/);
  assert.match(judgeScript({ src: '/seed-color-mode.js', integrity: 'md5-abc' }, context()).problems.join('\n'), /sha256-… 꼴/);
  const wrong = integrityOfBytes('tampered');
  assert.match(judgeScript({ src: '/seed-color-mode.js', integrity: wrong }, context()).problems.join('\n'), /받은 바이트 .*와 다르다/);
  assert.match(judgeScript(tag, context({ hashes: new Map() })).problems.join('\n'), /받은 바이트 SHA-256이 없다/);
  // 경계: 같은 해시는 통과, 1바이트만 달라도 실패
  assert.equal(judgeScript({ src: '/seed-color-mode.js', integrity: integrityOfBytes('seed') }, context()).problems.length, 0);
  assert.equal(judgeScript({ src: '/seed-color-mode.js', integrity: integrityOfBytes('seef') }, context()).problems.length > 0, true);
});

test('BAT-172 프레임워크 덩어리: 표 키·태그 값·받은 바이트가 모두 표와 같아야 한다', () => {
  const tag = { src: '/_next/static/chunks/a.js', integrity: CHUNK };
  assert.deepEqual(judgeScript(tag, context()), { kind: 'framework', key: 'static/chunks/a.js', problems: [] });
  assert.match(judgeScript({ src: '/_next/static/chunks/a.js' }, context({ manifest: new Map() })).problems.join('\n'), /SRI 표에 키가 없다/);
  const wrong = integrityOfBytes('tampered');
  assert.match(judgeScript({ src: '/_next/static/chunks/a.js', integrity: wrong }, context()).problems.join('\n'), /태그 integrity .*SRI 표 .*와 다르다/);
  assert.match(judgeScript({ src: '/_next/static/chunks/a.js', integrity: 'md5-x' }, context()).problems.join('\n'), /sha256-… 꼴/);
  assert.match(
    judgeScript({ src: '/_next/static/chunks/a.js' }, context({ hashes: new Map([[`${ORIGIN}/_next/static/chunks/a.js`, wrong]]) })).problems.join('\n'),
    /받은 바이트 .*SRI 표 .*와 다르다/,
  );
  assert.match(judgeScript({ src: '/_next/other/a.js' }, context()).problems.join('\n'), /_next\/static\/이 아니다/);
});

test('BAT-172 바이트 대조 생략(60초 한계): 표 키와 태그 값은 보고 바이트만 건너뛴다', () => {
  const tag = { src: '/_next/static/chunks/a.js' };
  assert.deepEqual(judgeScript(tag, context({ compareBytes: false, hashes: new Map() })), { kind: 'framework', key: 'static/chunks/a.js', problems: [] });
  assert.match(judgeScript(tag, context({ compareBytes: false, manifest: new Map() })).problems.join('\n'), /SRI 표에 키가 없다/);
  // 우리 것(/_next/ 밖)은 한계와 상관없이 바이트를 대조한다
  assert.match(judgeScript({ src: '/seed-color-mode.js', integrity: OWN }, context({ compareBytes: false, hashes: new Map() })).problems.join('\n'), /받은 바이트 SHA-256이 없다/);
});

test('BAT-172 가르기: 다른 출처는 foreign으로 뺀다(허용 출처는 정본 표가 본다)', () => {
  const tag = { src: 'https://challenges.cloudflare.com/turnstile/v0/api.js', integrity: '' };
  assert.deepEqual(judgeScript(tag, context()), { kind: 'foreign', key: null, problems: [] });
  const judged = judgeScripts([tag], context());
  assert.deepEqual(judged.foreign, [tag]);
  assert.match(judged.problems.join('\n'), /빈 결과/);
});

test('BAT-172 빈 결과: 같은 출처 태그 0개·SRI 표 키 0개·덩어리 키 0개는 실패다', () => {
  assert.match(judgeScripts([], context()).problems.join('\n'), /우리 문서가 싣는.*0개/);
  assert.match(judgeScripts([], context()).problems.join('\n'), /\/_next\/static\/ script\[src\]가 0개/);
  assert.match(judgeScripts([], context({ manifest: new Map() })).problems.join('\n'), /SRI 표 키가 0개/);
  const oursOnly = judgeScripts([{ src: '/seed-color-mode.js', integrity: OWN }], context());
  assert.match(oursOnly.problems.join('\n'), /\/_next\/static\/ script\[src\]가 0개/);
  const frameworkOnly = judgeScripts([{ src: '/_next/static/chunks/a.js', integrity: CHUNK }], context());
  assert.match(frameworkOnly.problems.join('\n'), /우리 문서가 싣는.*0개/);
});

test('BAT-172 통과: 우리 것 하나와 덩어리 하나가 형식·표·바이트와 맞으면 문제 0', () => {
  const judged = judgeScripts(
    [
      { src: '/seed-color-mode.js', integrity: OWN },
      { src: '/_next/static/chunks/a.js', integrity: CHUNK },
      { src: 'https://js.tosspayments.com/v2/standard', integrity: '' },
    ],
    context(),
  );
  assert.deepEqual(judged.problems, []);
  assert.equal(judged.own.length, 1);
  assert.equal(judged.framework.length, 1);
  assert.equal(judged.foreign.length, 1);
  assert.deepEqual([...judged.keys], ['static/chunks/a.js']);
});
