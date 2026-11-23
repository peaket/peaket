// F-05-2 SCR-041 실제 화면의 배선 시험(계획 docs/review/plans/F-05-2.md §1 한다 9·§5 T12·T16).
// 시험 담당(lane2-f052-test)이 구현 전에 썼다(ADR-0372·0381). 선례: _pages/ticket-cancel/ui/live-wiring.test.mjs(BAT-421)처럼 소스 모양을 본다.
// 정본: docs/features/transfer-refund.md §11 R-T21 ③(링크의 첫 요청은 정적 셸, 조회·수락은 화면 스크립트의 같은 사이트 요청),
//       docs/security/asvs/transfer-refund.md 3.3.2, docs/design/d5-screen-blueprint.md §5.23(고지 세 문장이 버튼보다 먼저, 거절은 뒤 몫 F-05-11).
// - 첫 이동 응답(서버 그리기)이 양도 요청 값을 싣지 않으려면 서버 화면이 ticket-svc를 부르지 않고, 실제 실행부는 서버에서 그리지 않아야 한다(ssr: false).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');
const liveFiles = () => readdirSync(here).filter((f) => /^TransferOfferLive.*\.tsx$/.test(f));
test('F-05-2 T12 R-T21 ③ [ASVS v5.0.0-3.3.2] transfer-refund:v5.0.0-3.3.2 실제 SCR-041은 서버에서 그리지 않는 실행부이고 서버 화면은 ticket-svc를 부르지 않는다', () => {
  const lives = liveFiles();
  assert.ok(lives.length > 0, 'TransferOfferLive*.tsx 실제 실행부가 없다');
  const loaders = lives.map(read).filter((s) => /dynamic\(\s*\(\)\s*=>\s*import\(/.test(s) && /ssr:\s*false/.test(s));
  assert.equal(loaders.length, 1, '실행부를 ssr: false 동적 가져오기로 싣는 로더가 하나 있어야 한다');
  const page = read('TransferOfferPage.tsx');
  // 서버 화면은 UUID 요청이면 로더만 그린다(요청 값을 서버에서 읽지 않는다)
  assert.match(page, /TransferOfferLive\w*/);
  assert.doesNotMatch(page, /\bfetch\s*\(/);
  assert.doesNotMatch(page, /from ['"]@peaket\/api-client/);
  assert.doesNotMatch(page, /from ['"]\.\.\/model\/offer-flow/);
  // 실행부는 offer-flow의 읽기·수락을 쓴다(화면이 손 fetch를 따로 만들지 않는다)
  const runtime = lives.map(read).join('\n');
  assert.match(runtime, /\bloadOffer\b/);
  assert.match(runtime, /\bacceptOffer\b/);
  assert.doesNotMatch(runtime, /\bfetch\s*\(\s*['"`]/);
});

/** apps/web/src의 시험이 아닌 소스(목업 서버 화면 TransferOfferPage.tsx는 뺀다: 실제 실행부의 고지를 목업에서 찾지 않는다, RV-02) */
const srcRoot = join(here, '..', '..', '..');
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    // 실행부 파일 자체도 뺀다(자기 export function 이름이 '싣는 이름'이 되어 버튼보다 앞에 잡히지 않게)
    else if (/\.(?:tsx?|mjs)$/.test(e.name) && !/\.test\./.test(e.name) && p !== join(here, 'TransferOfferPage.tsx') && !(dir === here && /^TransferOfferLive/.test(e.name))) yield p;
  }
}
/**
 * 그 문장을 '싣는 이름'들: 문장 글자 그대로, 그 문장을 값으로 가진 export const, 그런 이름이나 문장을 그리는 export function(부품).
 * 실제 실행부가 고지를 공용 글·부품으로 가져와도 찾도록 고정점까지 넓힌다
 */
function carriersOf(sentence) {
  const files = [...walk(srcRoot)].map((f) => readFileSync(f, 'utf8'));
  const names = new Set();
  for (let round = 0; round < 4; round++) {
    for (const text of files) {
      const carries = text.includes(sentence) || [...names].some((n) => new RegExp(`\\b${n}\\b`).test(text));
      for (const m of text.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*(['"`])([^'"`]*)\2/g)) if (m[3].includes(sentence)) names.add(m[1]);
      if (carries) for (const m of text.matchAll(/export\s+function\s+([A-Z]\w*)/g)) names.add(m[1]);
    }
  }
  return names;
}
/** 가져오기 문장 뒤(본문)에서 첫 자리 */
const bodyIndexOf = (text, re) => {
  const lastImport = [...text.matchAll(/^import[^\n]*\n/gm)].pop();
  const from = lastImport ? lastImport.index + lastImport[0].length : 0;
  const m = re.exec(text.slice(from));
  return m ? from + m.index : -1;
};
const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('F-05-2 T16 ⑤ 실제 SCR-041 실행부는 d5 고지 세 문장을 [받기] 버튼보다 앞에 그리고 거절 버튼을 그리지 않는다(RV-02, 거절은 뒤 몫 F-05-11)', () => {
  const lives = liveFiles();
  assert.ok(lives.length > 0, 'TransferOfferLive*.tsx 실제 실행부가 없다');
  // [받기] 버튼이 있는 실행부 파일(라벨 글자 '받기' 하나, '양도 받기' 제목과 가른다)
  const BUTTON = /[>'"`{]\s*받기\s*[<'"`}]/;
  const withButton = lives.filter((f) => bodyIndexOf(read(f), BUTTON) >= 0);
  assert.equal(withButton.length, 1, '[받기] 버튼을 그리는 실행부 파일이 하나여야 한다');
  const text = read(withButton[0]);
  const button = bodyIndexOf(text, BUTTON);
  for (const sentence of [
    '이 티켓은 결제한 사람만 취소할 수 있고, 공연이 취소되면 환불도 결제한 분에게 갑니다',
    '받으면 이 티켓은 다시 양도할 수 없고 결제한 분에게 돌려주기만 할 수 있습니다',
    '결제한 분의 부정 예매로 확인되면 이 표가 취소될 수 있고, 환급은 결제한 분에게 갑니다',
  ]) {
    const markers = [escape(sentence), ...[...carriersOf(sentence)].map((n) => `\\b${n}\\b`)];
    const at = bodyIndexOf(text, new RegExp(markers.join('|')));
    assert.ok(at >= 0, `실행부가 고지를 그리지 않는다: ${sentence}`);
    assert.ok(at < button, `고지가 [받기]보다 뒤에 있다: ${sentence}`);
  }
  const runtime = lives.map(read).join('\n');
  assert.doesNotMatch(runtime, />\s*거절\s*</, '실제 화면에 [거절] 버튼이 있다');
  assert.doesNotMatch(runtime, /\/rejection\b/, '실제 화면이 거절 경로를 부른다');
});
