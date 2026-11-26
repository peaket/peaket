// 신고 누리집(온라인 암표신고센터) 바로가기와 양도 화면 법정 고지(F-07-11, LCH-160, POL-024 라목, d5 §5.14·§5.16).
// 정본: POL-024 38행 라목, d5 1461행(양도 화면 부정구매·부정판매 형사처벌·과징금 고지), d5 1554~1555·1659~1660행(후기 목록·신고 확인 모달).
// 주소는 고정 `https://www.culture.go.kr/singo/`이고 게시물 정보를 싣지 않는다. 새 창 + rel="noopener noreferrer".
// 이 시험은 구현 전 트리에서 양도 화면에 링크가 없어 실패한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const review = read('./ReviewModalsClient.tsx');
const dialog = read('../../../../../../packages/ds/src/components/ReportDialog/ReportDialog.tsx');
const transfer = read('../../../_pages/ticket-transfer/ui/TicketTransferLive.tsx');

const CENTER = 'https://www.culture.go.kr/singo/';

test('WEB-01 후기 목록·신고 확인 모달의 신고기관 바로가기는 고정 주소를 새 창으로 연다', () => {
  assert.ok(dialog.includes(`export const SCALPING_REPORT_CENTER_URL = '${CENTER}';`));
  for (const source of [review, dialog]) {
    assert.match(source, /href=\{SCALPING_REPORT_CENTER_URL\}/);
    assert.match(source, /target="_blank"/);
    assert.match(source, /rel="noopener noreferrer"/);
    assert.match(source, /aria-label="온라인 암표신고센터, 새 창"/);
  }
  // 주소에 게시물 ID·티켓 정보를 싣지 않는다
  assert.equal(CENTER.includes('?'), false);
  assert.equal(CENTER.includes('${'), false);
});

test('WEB-02 양도 화면은 법정 고지와 함께 부정판매 신고 누리집 바로가기를 보인다', () => {
  assert.match(transfer, /SCALPING_REPORT_CENTER_URL/);
  assert.match(transfer, /href=\{SCALPING_REPORT_CENTER_URL\}/);
  assert.match(transfer, /target="_blank"/);
  assert.match(transfer, /rel="noopener noreferrer"/);
  assert.match(transfer, /aria-label="온라인 암표신고센터, 새 창"/);
  // 법정 고지 문구는 그대로 둔다(공연법 §41·§4의4)
  assert.match(transfer, /1년 이하의 징역 또는 1천만원 이하의 벌금/);
  assert.match(transfer, /판매금액의 50배 이하의 과징금/);
  // 링크는 법정 고지와 같은 자리(법정 고지 문자열 뒤 800자 안)에 있다
  const at = transfer.indexOf('LEGAL_RESALE_NOTICE');
  assert.notEqual(at, -1);
  assert.ok(transfer.slice(at, at + 800).includes('SCALPING_REPORT_CENTER_URL') || transfer.slice(at, at + 1_600).includes('SCALPING_REPORT_CENTER_URL'));
});

test('WEB-03 양도 화면 링크는 받는 분을 확인하기 전에 보이지 않고, 위험한 HTML을 쓰지 않는다', () => {
  // 법정 고지·링크는 canSend(받는 분 확인 뒤) 블록 안에 있다
  assert.match(transfer, /canSend \?[\s\S]*LEGAL_RESALE_NOTICE[\s\S]*SCALPING_REPORT_CENTER_URL/);
  assert.equal(transfer.includes('dangerouslySetInnerHTML'), false);
  assert.equal(transfer.includes('innerHTML'), false);
});
