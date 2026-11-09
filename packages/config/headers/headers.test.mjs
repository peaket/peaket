// 화면 묶음별 보안 헤더가 정본(docs/frontend.md §5.14.1 글 상자·헤더 표)과 같은지 본다(BUILD_ORDER BAS-220, [ASVS v5.0.0-3.4.3]·[ASVS v5.0.0-3.4.5]·[ASVS v5.0.0-3.4.6]·[ASVS v5.0.0-3.4.7]·[ASVS v5.0.0-3.4.8]).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLOUDFRONT_CSP_MAX, CSP, CSP_ADDITIONS, CSP_VARIANTS, PAGE_HEADERS, renderCsp, staticAppHeaders, trustedTypesReportOnly } from './security-headers.mjs';

const md = readFileSync(new URL('../../../docs/frontend.md', import.meta.url), 'utf8');
const lines = md.split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith('#### 5.14.1'));
const end = lines.findIndex((l, i) => i > start && l.startsWith('#### '));
const section = lines.slice(start, end);

/** 글 상자의 묶음마다 본문(정책 줄을 이은 것, '+' 줄과 뒤 괄호 설명은 뺀다) */
function canonPolicies() {
  const a = section.indexOf('```text');
  const b = section.indexOf('```', a + 1);
  const out = {};
  let cur = null;
  for (const line of section.slice(a + 1, b)) {
    const head = /^\[([A-G]′?) /.exec(line);
    if (head) {
      cur = head[1];
      out[cur] = { body: [], plus: [] };
      continue;
    }
    if (!cur || line.trim() === '') continue;
    if (line.startsWith('  +')) out[cur].plus.push(line.trim());
    else out[cur].body.push(line.replace(/\s{2,}\(.*\)\s*$/, '').trim());
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { body: v.body.join(' '), plus: v.plus }]));
}

/** 헤더 표: 헤더 이름 → 열 이름 → 칸 글 */
function canonHeaderTable() {
  const i = section.findIndex((l) => l.startsWith('| 헤더 |'));
  const head = section[i].split('|').slice(1, -1).map((c) => c.trim());
  const rows = {};
  for (const l of section.slice(i + 2)) {
    if (!l.startsWith('|')) break;
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    rows[cells[0].replaceAll('`', '')] = Object.fromEntries(head.map((h, j) => [h, cells[j]]));
  }
  return rows;
}

const canon = canonPolicies();
const table = canonHeaderTable();
// 정본 글 상자는 출처를 운영 이름으로 적는다. 자리 표시({n}·{h}·본인확인기관)는 그대로 둔다
const asWritten = (bundle, variants) =>
  renderCsp(bundle, { raw: true, variants })
    .replaceAll('{api}', 'https://api.peaket.example')
    .replaceAll('{queue}', 'https://queue.peaket.example')
    .replaceAll('{queueFiles}', 'https://queue-files.peaket.example')
    .replaceAll('{opsApi}', 'https://ops-api.peaket.example')
    .replaceAll('{scannerApi}', 'https://scanner-api.peaket.example')
    .replaceAll('{partnerApi}', 'https://partner-api.peaket.example')
    .replaceAll('{apiWs}', 'wss://api.peaket.example')
    .replaceAll('{img}', 'https://img.peaket.example')
    .replaceAll('{identity}', '{본인확인기관 출처(연동 계약 때 확정)}');

test('[ASVS v5.0.0-3.4.3] 묶음 A·A′·B·C·D·G의 CSP 본문이 정본 글 상자와 글자까지 같다', () => {
  assert.deepEqual(Object.keys(canon).sort(), ['A', 'A′', 'B', 'C', 'D', 'E', 'F', 'G']);
  for (const b of ['A', 'A′', 'B', 'C', 'D', 'G']) assert.equal(asWritten(b), canon[b].body, `묶음 ${b}`);
});

test('[ASVS v5.0.0-3.4.3] 묶음 E·F는 B에 정본 글 상자가 적은 출처를 더한다', () => {
  assert.match(canon.E.body, /^script-src 'nonce-\{n\}' 'strict-dynamic' https:\/\/js\.tosspayments\.com https:\/\/cdn\.portone\.io/);
  assert.match(asWritten('E'), /script-src 'nonce-\{n\}' 'strict-dynamic' https:\/\/js\.tosspayments\.com https:\/\/cdn\.portone\.io;/);
  assert.match(canon.F.body, /^connect-src에 wss:\/\/api\.peaket\.example/);
  assert.match(asWritten('F'), /connect-src 'self' \S+ \S+ \S+ wss:\/\/api\.peaket\.example;/);
  assert.deepEqual(Object.keys(CSP_ADDITIONS).sort(), ['E', 'F']);
});

test('[ASVS v5.0.0-3.4.6] 모든 묶음에 object-src·base-uri none과 frame-ancestors none이 있다', () => {
  for (const b of [...Object.keys(CSP), 'E', 'F']) {
    const p = asWritten(b);
    for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(p.includes(d), `${b}: ${d}`);
  }
});

test('[ASVS v5.0.0-3.4.7] G(서버 없는 공개 위치)를 뺀 묶음은 같은 출처 /_t/csp로 보고한다', () => {
  for (const b of ['A', 'A′', 'B', 'C', 'D']) assert.ok(asWritten(b).endsWith('report-to csp'), b);
  assert.ok(!asWritten('G').includes('report-to'));
  assert.equal(staticAppHeaders('console')['Reporting-Endpoints'], 'csp="/_t/csp"');
  assert.equal(staticAppHeaders('forensics')['Reporting-Endpoints'], undefined);
});

const IDENTITY = { identity: 'https://identity-provider.example' };

test('배포 응답 헤더 정책에 고정 문자열로 드는 A′·C·D의 CSP는 CloudFront 한도(1,783자) 안이다', () => {
  for (const app of ['queue-room', 'console', 'scanner']) assert.ok(staticAppHeaders(app, { origins: IDENTITY })['Content-Security-Policy'].length <= CLOUDFRONT_CSP_MAX, app);
});

test("[ASVS v5.0.0-3.4.3] 정본 글 상자의 '+' 줄(사람 확인·본인확인·파트너·관제 Trusted Types 보고)이 변형으로 있다", () => {
  const plus = Object.values(canon).flatMap((c) => c.plus).join('\n');
  assert.match(plus, /사람 확인을 싣는 화면\(공연 상세\): script-src와 frame-src에 https:\/\/challenges\.cloudflare\.com/);
  assert.match(asWritten('A', ['humanCheck']), /script-src 'self' \{h\} https:\/\/challenges\.cloudflare\.com;.*frame-src 'none' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(plus, /본인확인을 여는 화면.*form-action에 본인확인기관 출처/);
  assert.match(asWritten('B', ['identityForm']), /form-action 'self' \{본인확인기관 출처\(연동 계약 때 확정\)\};/);
  assert.ok(plus.includes("파트너 콘솔: connect-src는 'self' https://partner-api.peaket.example"));
  assert.match(asWritten('B', ['partner']), /; connect-src 'self' https:\/\/partner-api\.peaket\.example; /);
  const tt = canon.C.plus.find((l) => l.startsWith('+ Content-Security-Policy-Report-Only:'));
  assert.ok(tt, '관제 Trusted Types 보고 줄이 없다');
  const ttCanon = tt.replace('+ Content-Security-Policy-Report-Only: ', '').replace(/\s{2,}\(.*\)\s*$/, '');
  assert.equal(trustedTypesReportOnly(['x']).replace('peaket-webpack-x', 'peaket-webpack-{원격 이름…}'), ttCanon);
  assert.equal(staticAppHeaders('console')['Content-Security-Policy-Report-Only'], trustedTypesReportOnly(['queue', 'purchase']));
  assert.deepEqual(Object.keys(CSP_VARIANTS).sort(), ['humanCheck', 'identityForm', 'partner', 'socialLogin']);
});

test("[ASVS v5.0.0-3.4.3] 로그인·재인증 화면의 form-action에 소셜 제공자 인가 출처가 든다(갈래 3 BOT-044 재현: 'self'만이면 POST /login/{p} 뒤 303이 막힌다, ADR-0215)", () => {
  const plus = canon.B.plus.join('\n');
  assert.ok(plus.includes('로그인 화면(로그인 수단 잇기 확인 포함): form-action에 세 소셜 제공자 인가 출처 https://kauth.kakao.com https://accounts.kakao.com https://nid.naver.com https://accounts.google.com'), plus);
  assert.match(plus, /재인증을 시작하는 화면.*로그인 화면과 같은 form-action/);
  assert.ok(renderCsp('B', { nonce: 'a'.repeat(22), variants: ['socialLogin'] }).includes("form-action 'self' https://kauth.kakao.com https://accounts.kakao.com https://nid.naver.com https://accounts.google.com;"));
  // 로컬·CI에서 제공자 issuer를 모의 제공자로 바꾸면 그 출처로 채운다(꼴 검사는 같다)
  const local = renderCsp('B', { nonce: 'a'.repeat(22), variants: ['socialLogin'], origins: { kakaoAuth: 'http://127.0.0.1:4030', kakaoAccounts: 'http://127.0.0.1:4030', naverAuth: 'http://127.0.0.1:4030', googleAuth: 'http://127.0.0.1:4030' } });
  assert.ok(local.includes("form-action 'self' http://127.0.0.1:4030 http://127.0.0.1:4030 http://127.0.0.1:4030 http://127.0.0.1:4030;"));
});

test('채우지 않은 자리 표시(본인확인기관 출처)와 꼴이 틀린 출처는 만들지 않는다(새 맥락 리뷰 재현)', () => {
  assert.throws(() => staticAppHeaders('queue-room'), /자리 표시/);
  assert.ok(staticAppHeaders('queue-room', { origins: IDENTITY })['Content-Security-Policy'].includes('form-action https://identity-provider.example;'));
  assert.throws(() => renderCsp('C', { origins: { opsApi: "https://x.example; script-src 'unsafe-inline'" } }), /출처/);
  assert.throws(() => renderCsp('C', { origins: { opsApi: 'http://evil.example' } }), /출처/);
  for (const v of Object.values(staticAppHeaders('console'))) assert.match(v, /^[\x20-\x7e]+$/, '헤더 값은 ASCII여야 한다');
});

test('[ASVS v5.0.0-3.4.5] [ASVS v5.0.0-3.4.8] Referrer-Policy·COOP·COEP·Permissions-Policy가 정본 헤더 표와 같다', () => {
  const first = (cell) => /`([^`]+)`/.exec(cell)?.[1];
  const col = { web: '소비자 웹', checkout: '결제 화면', partner: '파트너', console: '관제', scanner: '스캐너' };
  for (const [page, name] of Object.entries(col)) {
    assert.equal(PAGE_HEADERS[page]['Referrer-Policy'], first(table['Referrer-Policy'][name]), `${page} Referrer-Policy`);
    assert.equal(PAGE_HEADERS[page]['Cross-Origin-Opener-Policy'], first(table['Cross-Origin-Opener-Policy'][name]), `${page} COOP`);
    // COEP 칸은 정본이 '없다'로 적은 경우에만 두지 않는다
    assert.ok(table['Cross-Origin-Embedder-Policy'][name].startsWith('없다'), `${page} COEP 칸: ${table['Cross-Origin-Embedder-Policy'][name]}`);
    assert.equal(PAGE_HEADERS[page]['Cross-Origin-Embedder-Policy'], undefined, `${page} COEP`);
  }
  // Permissions-Policy의 '같다' 칸은 소비자 웹 값과 같다는 뜻이다
  for (const name of ['좌석 화면', '결제 화면', '파트너', '관제']) assert.ok(table['Permissions-Policy'][name].startsWith('같다'), `${name} Permissions-Policy 칸`);
  assert.equal(PAGE_HEADERS.seats['Cross-Origin-Opener-Policy'], first(table['Cross-Origin-Opener-Policy']['좌석 화면']));
  assert.equal(table['Referrer-Policy']['좌석 화면'], '기본');
  assert.equal(PAGE_HEADERS.seats['Referrer-Policy'], PAGE_HEADERS.web['Referrer-Policy']);
  const off = first(table['Permissions-Policy']['소비자 웹']);
  for (const page of ['web', 'seats', 'checkout', 'partner', 'console', 'forensics']) assert.equal(PAGE_HEADERS[page]['Permissions-Policy'], off, page);
  assert.ok(table['Permissions-Policy']['스캐너'].startsWith('`camera=(self)`, 나머지는 끈다'));
  assert.equal(PAGE_HEADERS.scanner['Permissions-Policy'], off.replace('camera=()', 'camera=(self)'));
  // 포렌식 리플레이 데모(묶음 G): no-referrer, COOP same-origin, COEP require-corp
  const g = section.find((l) => l.startsWith('- **포렌식 리플레이 데모(묶음 G'));
  for (const v of ['`Referrer-Policy: no-referrer`', '`Cross-Origin-Opener-Policy: same-origin`', '`Cross-Origin-Embedder-Policy: require-corp`']) assert.ok(g.includes(v), v);
  assert.equal(PAGE_HEADERS.forensics['Cross-Origin-Embedder-Policy'], 'require-corp');
});

test('nonce·해시·출처 자리 표시를 채우고, 빠지거나 꼴이 틀리면 만들지 않는다', () => {
  const nonce = 'r4nd0mN0nc3Value_x12345';
  const b = renderCsp('B', { nonce });
  assert.ok(b.includes(`'nonce-${nonce}'`) && !b.includes('{n}'));
  assert.throws(() => renderCsp('B'), /nonce/);
  assert.throws(() => renderCsp('B', { nonce: "x' 'unsafe-inline" }), /nonce/);
  assert.throws(() => renderCsp('B', { nonce: 'shortNonce123456' }), /128비트/);
  assert.equal(renderCsp('C', { hashes: [] }).includes('{h}'), false);
  assert.ok(renderCsp('A', { hashes: ["'sha256-abc='"] }).startsWith("default-src 'self'; script-src 'self' 'sha256-abc='; "));
  assert.throws(() => renderCsp('A', { hashes: ['unsafe-inline'] }), /해시/);
  const dev = staticAppHeaders('scanner', { origins: { scannerApi: 'http://127.0.0.1:4010' } })['Content-Security-Policy'];
  assert.ok(dev.includes("connect-src 'self' http://127.0.0.1:4010;"));
  assert.throws(() => renderCsp('Z'), /묶음/);
});
