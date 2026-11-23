// F-05-2 SCR-041 실제 화면의 배선 시험(계획 docs/review/plans/F-05-2.md §1 한다 9·§5 T12·T16).
// 시험 담당(lane2-f052-test)이 구현 전에 썼다(ADR-0372·0381). 선례: _pages/ticket-cancel/ui/live-wiring.test.mjs(BAT-421)처럼 소스 모양을 본다.
// 정본: docs/features/transfer-refund.md §11 R-T21 ③(링크의 첫 요청은 정적 셸, 조회·수락은 화면 스크립트의 같은 사이트 요청),
//       docs/security/asvs/transfer-refund.md 3.3.2, docs/design/d5-screen-blueprint.md §5.23(고지 세 문장이 버튼보다 먼저, 거절은 뒤 몫 F-05-11).
// - 첫 이동 응답(서버 그리기)이 양도 요청 값을 싣지 않으려면 서버 화면이 ticket-svc를 부르지 않고, 실제 실행부는 서버에서 그리지 않아야 한다(ssr: false).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8');
const liveFiles = () => readdirSync(here).filter((f) => /^TransferOfferLive.*\.tsx$/.test(f));
/** transfer-offer 조각의 시험이 아닌 소스 전부 */
const sliceSources = () => {
  const root = join(here, '..');
  const out = [];
  for (const dir of ['ui', 'model']) {
    for (const f of readdirSync(join(root, dir))) if (/\.(?:tsx?|mjs)$/.test(f) && !/\.test\./.test(f)) out.push(readFileSync(join(root, dir, f), 'utf8'));
  }
  return out.join('\n');
};

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

test('F-05-2 T16 ⑤ 실제 SCR-041은 d5 고지 세 문장을 싣고 거절 버튼을 그리지 않는다(거절은 뒤 몫 F-05-11)', () => {
  const src = sliceSources();
  for (const sentence of [
    '이 티켓은 결제한 사람만 취소할 수 있고, 공연이 취소되면 환불도 결제한 분에게 갑니다',
    '받으면 이 티켓은 다시 양도할 수 없고 결제한 분에게 돌려주기만 할 수 있습니다',
  ]) {
    assert.ok(src.includes(sentence), `고지 문장이 없다: ${sentence}`);
  }
  assert.ok(liveFiles().length > 0, 'TransferOfferLive*.tsx 실제 실행부가 없다');
  const runtime = liveFiles().map(read).join('\n');
  assert.ok(existsSync(join(here, 'TransferOfferPage.tsx')));
  // 셋째 문장(부정 예매 고지, ADR-0173 결정 4)은 공용 글(entities/appeal TRANSFER_OFFER_FRAUD_NOTICE)을 실제 화면도 쓴다
  const fraud = '결제한 분의 부정 예매로 확인되면 이 표가 취소될 수 있고, 환급은 결제한 분에게 갑니다';
  assert.ok(runtime.includes(fraud) || /\bTRANSFER_OFFER_FRAUD_NOTICE\b/.test(runtime), '실제 화면에 부정 예매 고지가 없다');
  assert.doesNotMatch(runtime, />\s*거절\s*</, '실제 화면에 [거절] 버튼이 있다');
  assert.doesNotMatch(runtime, /\/rejection\b/, '실제 화면이 거절 경로를 부른다');
});
