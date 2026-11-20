// SCR-067 봇 판정 표본 검토 연결 화면의 배선 시험(BAT-197 BOT-080, FR-049, ASVS 3.2.2, d5 §7.15).
// 실제 경로가 계약의 세 호출·회차 질의·PENDING 목록·멱등 키·상태 문구를 쓰는지 소스로 확인하고,
// 카드 값을 글자 노드로만 그리며 받은 순서를 다시 정렬하지 않고 판정·표본을 브라우저 저장소에 두지 않는지 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('./ConnectedPage.tsx');
const model = read('../model/review.ts');

test('FR-049 화면은 회차를 읽고 목록·진행·판정·근거·빈 상태를 실제 API로 그린다', () => {
  for (const name of ['getOpsEventBotReview', 'listOpsEventBotReviewSamples', 'createOpsBotReviewSampleJudgement']) {
    assert.match(page, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(page, /import\('@peaket\/api-client\/endpoints\/ops'\)/);
  assert.match(page, /ensureConsoleApi\(/);
  // 회차는 ?event=, 종류는 ?reviewKind=(기본 PASSED_SAMPLE)로 받는다
  assert.match(page, /sp\.get\('event'\)/);
  assert.match(page, /sp\.get\('reviewKind'\)/);
  assert.match(page, /parseReviewKind\(sp\.get\('reviewKind'\)\)/);
  // 목록은 아직 기록하지 않은 표본만 100건까지 받는다
  assert.match(page, /status: 'PENDING'/);
  assert.match(page, /limit: 100/);
  // 진행·목록을 함께 부르고 판정 뒤 다시 읽는다
  assert.match(page, /Promise\.all\(/);
  assert.match(page, /mapReview\(progressResponse\.data, reviewKind\)/);
  assert.match(page, /mapSamples\(samplesResponse\.data\)/);
  assert.match(page, /await refresh\(\)/);
  // 상태 문구: 회차 없음·로딩·표본 없음·기한 지남·오류·권한 없음
  for (const text of ['회차를 고르세요', '표본을 불러오는 중', '검토할 표본이 없습니다', '검토 기한이 지났습니다', '다시 시도', '표본을 불러오지 못했습니다']) {
    assert.ok(page.includes(text), `${text} 문구가 없다`);
  }
  // CS 두 역할만 들어가고 나머지는 NoAccess다
  assert.match(page, /chosen !== 'cs_agent' && chosen !== 'cs_lead'/);
  assert.match(page, /<NoAccess title=\{TITLE\}/);
  // 판정 오류 400·403·409·410·422·503을 구분한다
  for (const status of [409, 410, 422, 503]) assert.match(page, new RegExp(`status === ${status}`), `${status} 처리`);
  // 실제 경로는 연결 화면을 쓰고 디자인 보드는 ?state= 미리보기에만 남긴다
  assert.match(read('./Page.tsx'), /__PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
  assert.match(read('./Page.tsx'), /function BoardPage/);
});

test('FR-049 화면은 서버가 섞은 순서를 그대로 쓰고 판정·표본을 저장소에 두지 않는다', () => {
  // 받은 순서를 그대로 쓴다: 목록을 다시 정렬하는 .sort(가 없고 첫 표본을 쓴다
  assert.equal(page.includes('.sort('), false, '화면이 목록을 다시 정렬한다');
  assert.equal(model.includes('.sort('), false, '모델이 목록을 다시 정렬한다');
  assert.match(page, /const sample = samples\[0\] \?\? null;/);
  // 판정·표본을 localStorage·sessionStorage에 두지 않는다
  for (const src of [page, model]) {
    assert.equal(/localStorage\.|sessionStorage\.|window\.localStorage|window\.sessionStorage/.test(src), false, '브라우저 저장소를 쓴다');
  }
  // 멱등 키: 새 판정마다 새 UUID, 503 재시도는 같은 표본이면 같은 키
  assert.match(page, /crypto\.randomUUID\(\)/);
  assert.match(page, /'Idempotency-Key': key/);
  assert.match(page, /idempotency\.current\?\.sampleId === sample\.sampleId/);
  assert.match(page, /idempotency\.current = \{ sampleId: sample\.sampleId, key \}/);
  // 기록한 표본은 목록에서 사라진다: 성공 뒤 서버를 다시 읽고, 새로고침도 서버 읽기다
  assert.match(page, /idempotency\.current = null;[\s\S]{0,300}await refresh\(\)/);
  // BOT 근거는 사람 기준 표본에서만 하나 이상 필수이고, 버튼이 막힌 까닭을 읽힌다
  assert.match(page, /needsEvidence\(reviewKind, verdict\)/);
  assert.match(page, /blockReason !== null/);
  assert.match(page, /id="bot-review-why"/);
  assert.match(model, /kind === 'HUMAN_BASELINE' && verdict === 'BOT'/);
});

test('[ASVS v5.0.0-3.2.2] 카드의 세션 가명·범주·타임라인은 글자 노드로만 그린다', () => {
  // React 기본 이스케이프를 쓰는 JSX 값으로만 그린다
  assert.equal(/dangerouslySetInnerHTML|innerHTML\s*=/.test(page), false, 'HTML을 직접 넣는다');
  assert.equal(/dangerouslySetInnerHTML|innerHTML\s*=/.test(model), false, '모델이 HTML을 만든다');
  for (const value of ['{sample.sessionRef}', '{sample.riskBand}', '{sample.behaviorSummaryBand}', '{stepLabel(t.step)}', '{formatKst(t.at)}', '{formatRate(progress.interim.missedBotRate)}', '{formatRateRange(progress.interim.ci95Low, progress.interim.ci95High)}']) {
    assert.ok(page.includes(value), `${value} 글자 노드가 없다`);
  }
  // 근거 종류도 정해진 문구로만 보이고 받은 값을 그대로 넣지 않는다
  assert.match(page, /EVIDENCE_KINDS\.find\(\(x\) => x\.kind === e\)\?\.label \?\? e/);
  // 원시 값·가중치를 보이지 않는다는 안내가 있다
  assert.ok(page.includes('원시 신호 값, 위험 점수, 판정 기준의 세부 가중치는 보이지 않습니다.'));
  assert.ok(page.includes('가명 참조값만 표시'));
});

test('FR-049 화면은 진행률·남은 수·기한·잠정 중간 결과를 정확한 값으로 보인다', () => {
  assert.match(page, /aria-valuemax=\{progress\.targetCount\}/);
  assert.match(page, /aria-valuenow=\{progress\.reviewedCount\}/);
  assert.match(page, /남은 표본 \{progress\.remaining\}건 · 표본 크기 \{progress\.targetCount\}건/);
  assert.match(page, /R2 마감 \{formatKst\(progress\.r2DueAt\)\}/);
  assert.match(page, /행동 신호 삭제 \{formatKst\(progress\.deadlineAt\)\}/);
  assert.match(page, /progress\.interim \?/);
  // HUMAN_BASELINE은 서버가 interim null을 주므로 잠정 줄이 그려지지 않는다(모델은 null을 그대로 둔다)
  assert.match(model, /const interim = raw\.interim/);
  assert.match(model, /: null;/);
});
