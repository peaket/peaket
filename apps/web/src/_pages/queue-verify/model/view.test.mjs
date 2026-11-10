// SCR-009 화면 글과 고정 경로(model/view.ts)·화면 코드의 글 노드 규칙(ASVS 3.2.2·3.7.2, ADR-0259).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { APPEAL_MAX, appealLength, fixedPaths, REASON_LABELS, reasonLabel } from './view.ts';

const UI = new URL('../ui/', import.meta.url);

test('[ASVS v5.0.0-3.2.2] 추가 검증 화면 코드는 사유 범주·보낸 이의 내용을 글 노드로만 그린다(HTML 넣기·창 메시지 수신기 없음)', () => {
  const files = readdirSync(UI).filter((f) => f.endsWith('.tsx'));
  assert.ok(files.includes('QueueVerifyLive.tsx') && files.includes('parts.tsx'), files.join(','));
  for (const f of files) {
    const src = readFileSync(new URL(f, UI), 'utf8');
    for (const sink of [/dangerouslySetInnerHTML/, /\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /setHTMLUnsafe|createContextualFragment/, /addEventListener\(\s*['"`]message/]) {
      assert.doesNotMatch(src, sink, `${f}: ${sink}`);
    }
  }
  // 사유 범주 배지와 보낸 내용은 JSX 글자 자식으로 그린다
  const parts = readFileSync(new URL('parts.tsx', UI), 'utf8');
  assert.match(parts, /<span className="badge badge-outline">\{label\}<\/span>/);
  assert.match(parts, />\s*\{text\}\s*<\/p>/);
  // 표의 글은 순수 글이다(꺾쇠·앰퍼샌드 없음)
  for (const label of Object.values(REASON_LABELS)) assert.doesNotMatch(label, /[<>&]/, label);
  assert.equal(reasonLabel('RAPID_REQUESTS'), '짧은 시간 많은 요청');
  for (const bad of ['<b>x</b>', 'constructor', 'hasOwnProperty', undefined, {}, ['RAPID_REQUESTS']]) assert.equal(reasonLabel(bad), null, String(bad));
});

test('[ASVS v5.0.0-3.7.2] 이 화면이 옮겨 가는 곳은 이 앱의 고정 경로이고 회차 ID는 경로 조각으로만 들어간다', () => {
  assert.deepEqual(fixedPaths('e1'), { queue: '/queue/e1', seats: '/booking/e1/seats', event: '/events/e1', verify: '/queue/e1/verify', login: '/login?next=%2Fqueue%2Fe1%2Fverify' });
  for (const id of ['//evil.example', 'https://evil.example', '../../x', 'a?next=//evil', '\\\\evil']) {
    for (const u of Object.values(fixedPaths(id))) {
      assert.match(u, /^\/(?![/\\])/, u);
      assert.ok(new URL(u, 'https://www.peaket.example').origin === 'https://www.peaket.example', u);
    }
  }
});

test('이의 글자 수는 NFC 정규화 뒤 grapheme으로 센다(결합 문자·이은 그림 글자는 한 글자, 정한 최대 1,000자)', () => {
  assert.equal(APPEAL_MAX, 1000);
  assert.equal(appealLength('é'), 1);
  assert.equal(appealLength('\u{1F468}‍\u{1F469}‍\u{1F467}'), 1);
  assert.equal(appealLength('한글'), 2);
  assert.equal(appealLength(''), 0);
});

const MODEL = new URL('./', import.meta.url);
/** 주석을 뺀 원본(주석 속 설명 글은 읽기가 아니다) */
const code = (url) => readFileSync(url, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('[ASVS v5.0.0-3.7.2] 추가 검증 화면 원본은 주소의 바깥 값(location.search·next·returnTo·referrer·hash)을 읽지 않고, 이동에는 고정 경로 함수의 값만 넘긴다', () => {
  const ui = readdirSync(UI).filter((f) => f.endsWith('.tsx')).map((f) => [`ui/${f}`, code(new URL(f, UI))]);
  const model = readdirSync(MODEL).filter((f) => f.endsWith('.ts')).map((f) => [`model/${f}`, code(new URL(f, MODEL))]);
  assert.ok(ui.length >= 5 && model.some(([f]) => f === 'model/verify-flow.ts'), [...ui, ...model].map(([f]) => f).join(','));
  // 주소의 바깥 값을 읽는 길: 검색 문자열·해시·URLSearchParams·next/returnTo 꺼내기·이전 주소
  const reads = [/location\s*\.\s*(search|hash|href)\b/, /\bURLSearchParams\b/, /\.get\(\s*['"`](next|returnTo|redirect|continue|url)['"`]\s*\)/, /\b(searchParams|sp|query)\s*(\.|\[\s*['"`])\s*(next|returnTo|redirect)\b/, /document\s*\.\s*referrer/, /\bnew\s+URL\s*\(\s*(window\.)?location/];
  for (const [f, src] of [...ui, ...model]) for (const re of reads) assert.doesNotMatch(src, re, `${f}: ${re}`);
  // 이동하는 호출은 정해 둔 꼴뿐이다
  const moves = /\b(?:location\s*\.\s*(?:replace|assign)\s*\(|location\s*\.\s*href\s*=|window\s*\.\s*open\s*\(|router\s*\.\s*(?:push|replace)\s*\()/g;
  const allowed = {
    // 실제 화면: 흐름(model)이 넘긴 값 그대로(흐름은 fixedPaths의 값만 넘긴다)
    'ui/QueueVerifyLive.tsx': ['location.replace(u)'],
    // 퍼블리싱 미리보기의 이의 양식: previewHref(path, …)로 만든 같은 화면 주소
    'ui/AppealForm.tsx': ['router.push(submittedHref'],
  };
  for (const [f, src] of ui) {
    const found = [...src.matchAll(moves)].map((m) => src.slice(m.index, src.indexOf(')', m.index) + 1).replace(/\s+/g, ' '));
    for (const call of found) assert.ok((allowed[f] ?? []).some((a) => call.startsWith(a)), `${f}: ${call}`);
  }
  const live = ui.find(([f]) => f === 'ui/QueueVerifyLive.tsx')[1];
  assert.match(live, /navigate:\s*\(u\)\s*=>\s*window\.location\.replace\(u\),/, '화면은 흐름이 고른 고정 경로를 바꾸지 않고 넘긴다');
  const appeal = ui.find(([f]) => f === 'ui/AppealForm.tsx')?.[1] ?? '';
  const preview = ui.find(([f]) => f === 'ui/QueueVerifyPreview.tsx')[1];
  if (appeal) assert.match(preview, /submittedHref=\{previewHref\(path,/, '미리보기 이의 양식의 이동 주소는 previewHref로 만든 같은 화면 주소');
  // 흐름: 이동은 d.navigate(paths[…])뿐이고 paths는 fixedPaths(d.eventId)다
  const flow = model.find(([f]) => f === 'model/verify-flow.ts')[1];
  const navs = [...flow.matchAll(/\bd\.navigate\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(navs.length >= 2, navs.join(','));
  for (const a of navs) assert.match(a, /^paths\[[a-z]+\]$/, `d.navigate(${a})`);
  assert.match(flow, /const paths = fixedPaths\(d\.eventId\);/);
  for (const [f, src] of model) if (f !== 'model/verify-flow.ts') assert.doesNotMatch(src, /\bnavigate\s*\(/, f);
});
