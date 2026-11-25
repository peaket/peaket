// SCR-048 판매 승인 연결 화면의 배선 시험(BAT-617, LCH-080, d5 §7.9, ASVS 8.2.2·8.2.3).
// 목록·상세·승인·반려 함수, 상태 필터, 새로고침, 읽기 전용 역할, 반려 사유·오류 문구를 소스로 확인한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('./ConnectedPage.tsx');
const model = read('../model/sale-review.ts');
const routePage = read('./Page.tsx');

test('S-T41 ⑫ 화면은 실제 목록·상세·승인·반려 API를 부르고 성공 뒤 다시 읽는다', () => {
  for (const name of ['listOpsSaleReviews', 'getOpsSaleReview', 'createOpsSaleReviewApproval', 'createOpsSaleReviewRejection']) {
    assert.match(page, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(page, /import\('@peaket\/api-client\/endpoints\/ops'\)/);
  assert.match(page, /ensureConsoleApi\(/);
  assert.match(page, /await load\(/);
  assert.match(page, /useParams/);
});

test('S-T41 ⑫ 목록은 기본 승인 대기와 상태 필터를 쓰고 상세의 반려 사유를 그린다', () => {
  assert.match(page, /status:\s*\['SUBMITTED'\]/);
  assert.match(page, /setFilter/);
  assert.match(page, /rejectionReason/);
  assert.match(page, /반려 사유/);
  assert.match(page, /salePolicy/);
  assert.match(page, /accessibleSeatingCheck/);
  assert.match(page, /placeName/);
});

test('S-T41 ⑫_[ASVS v5.0.0-8.2.2] viewer·CS는 승인·반려 단추가 없고 operator·commander만 누른다', () => {
  assert.match(page, /canAct\(/);
  assert.match(model, /role === 'operator' \|\| role === 'commander'/);
  assert.match(page, /읽기 전용/);
  assert.match(model, /'viewer'/);
  assert.match(model, /'cs_agent'/);
  assert.match(model, /'cs_lead'/);
});

test('S-T41 ⑫ 승인·반려·409 뒤 목록·상세를 새로 읽고, 반려 사유를 검증한다', () => {
  assert.match(page, /problem\.reload/);
  assert.match(page, /await load\(/);
  // 성공 안내 뒤에 서버를 다시 읽는다(안내만 하고 목록·상세를 낡게 두지 않는다)
  assert.match(page, /setNotice\(\{ tone: 'ok'[\s\S]{0,400}setReason\(''\);[\s\S]{0,40}await load\(\)/);
  assert.match(page, /validateRejection\(/);
  assert.match(page, /validateApproval\(/);
  assert.match(page, /validateLinkage\(/);
  assert.match(page, /linkageBody\(/);
});

test('S-T41 ⑫ LCH-080_ 아티스트·공연장 연결과 지급대행 등록 값을 실제 API로 읽고 만든다', () => {
  for (const name of ['listOpsArtists', 'createOpsArtist', 'listOpsPlaces', 'createOpsPlace']) {
    assert.match(page, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.match(page, /artists/);
  assert.match(page, /requestedPlace/);
  assert.match(page, /payoutAccount/);
  assert.match(page, /pgRegistration/);
  assert.match(page, /지급대행/);
  assert.match(page, /새로 만들기/);
});

test('S-T41 ⑫ 실제 경로는 연결 화면, 디자인 보드는 ?state= 미리보기에만 남긴다', () => {
  assert.match(routePage, /__PREVIEW__ && sp\.get\('state'\) \? <BoardPage \/> : <ConnectedPage \/>/);
  assert.match(routePage, /function BoardPage/);
});
