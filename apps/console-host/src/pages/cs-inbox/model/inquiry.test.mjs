// F-06-5 SCR-045 문의 스레드·답변 화면 값 해석 시험(시험 담당 lane2-freeze-F-06-5-opencode).
// 정본: openapi CsCaseDetail·CaseReply·InquiryMessage, d5 §7.6 '문의', docs/features/transfer-refund.md §7.3. 구현 전에는 model/inquiry.ts가 없다.
// 서버가 담당자 ID를 싣지 않고 계좌번호를 가려 준다. 이 해석은 그 값을 그대로 두고 모르는 칸을 버린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function mod() {
  try {
    return await import('./inquiry.ts');
  } catch (err) {
    throw new Error(`SCR-045 model/inquiry.ts가 없다(계획 §3): ${err instanceof Error ? err.message : String(err)}`);
  }
}

const INQUIRY = {
  inquiryId: 'inq-1', number: 'Q-2611-0042', category: 'MERCH', title: '응원봉 배송 예정일이 궁금합니다', status: 'RECEIVED',
  dueAt: '2026-11-26T14:30:00.000Z',
  messages: [
    { messageId: 'm-1', authorKind: 'FAN', authorDisplay: '나', kind: 'MESSAGE', body: '환불은 (계좌번호 지움) 계좌로 받고 싶습니다.', createdAt: '2026-11-20T14:31:00.000Z' },
    { messageId: 'm-2', authorKind: 'AGENT', authorDisplay: '피켓 고객센터', kind: 'ANSWER', body: '확인했습니다.', createdAt: '2026-11-20T15:00:00.000Z' },
  ],
  actedBy: 'admin-1', assignee: 'admin-2', agentName: '김담당',
};

test('건 상세의 문의 스레드는 담당자 표시·종류·시각만 남기고 담당자 ID·이름을 버린다 [ASVS v5.0.0-1.2.1][ASVS v5.0.0-1.3.5][ASVS v5.0.0-3.2.2]', async () => {
  const m = await mod();
  const v = m.inquiryThreadOf({ inquiry: INQUIRY });
  assert.equal(v.inquiryId, 'inq-1');
  assert.equal(v.number, 'Q-2611-0042');
  assert.equal(v.messages.length, 2);
  assert.equal(v.messages[1].authorDisplay, '피켓 고객센터');
  assert.equal(v.messages[1].kind, 'ANSWER');
  assert.equal(v.actedBy, undefined);
  assert.equal(v.assignee, undefined);
  assert.deepEqual(Object.keys(v.messages[1]).sort(), ['authorDisplay', 'authorKind', 'body', 'createdAt', 'kind', 'messageId']);
  assert.equal(m.inquiryThreadOf({}), null);
});

test('문의 기록의 계좌번호 가림은 서버가 한 그대로 두고 다시 바꾸지 않는다', async () => {
  const m = await mod();
  const v = m.inquiryThreadOf({ inquiry: INQUIRY });
  assert.ok(v.messages[0].body.includes('(계좌번호 지움)'));
  assert.ok(!v.messages[0].body.includes('110-123-456789'));
  assert.equal(m.inquiryThreadOf({ inquiry: { ...INQUIRY, messages: [{ messageId: '', authorKind: 'FAN', kind: 'MESSAGE', body: 'x', createdAt: 't' }] } }).messages.length, 0);
});

test('답변·진행 경과 본문은 NFC 뒤 1~2,000자이고 종류는 ANSWER·PROGRESS만 받는다', async () => {
  const m = await mod();
  assert.equal(m.replyBodyValid({ kind: 'ANSWER', body: '확인했습니다.' }), true);
  assert.equal(m.replyBodyValid({ kind: 'PROGRESS', body: '확인 중입니다.' }), true);
  assert.equal(m.replyBodyValid({ kind: 'ANSWER', body: '' }), false);
  assert.equal(m.replyBodyValid({ kind: 'ANSWER', body: '   ' }), false);
  assert.equal(m.replyBodyValid({ kind: 'ANSWER', body: '가'.repeat(2000) }), true);
  assert.equal(m.replyBodyValid({ kind: 'ANSWER', body: '가'.repeat(2001) }), false);
  assert.equal(m.replyBodyValid({ kind: 'NOTE', body: '모르는 종류입니다.' }), false);
});

test('답변 오류는 403·404·409 종류·422·503을 화면 글과 다시 보낼지로 가른다', async () => {
  const m = await mod();
  assert.deepEqual(m.replyErrorOf({ status: 403, type: 'case-update-not-allowed' }), { kind: 'forbidden', retry: false, text: '답변을 보낼 수 있는 역할이 아닙니다' });
  assert.deepEqual(m.replyErrorOf({ status: 409, type: 'case-not-inquiry' }), { kind: 'not-inquiry', retry: false, text: '문의가 이어진 건이 아닙니다' });
  assert.deepEqual(m.replyErrorOf({ status: 409, type: 'case-already-resolved' }), { kind: 'resolved', retry: false, text: '이미 해결한 건입니다' });
  assert.deepEqual(m.replyErrorOf({ status: 409, type: 'inquiry-closed' }), { kind: 'closed', retry: false, text: '닫힌 문의입니다. 새 문의로 안내해 주세요' });
  assert.equal(m.replyErrorOf({ status: 503, type: 'support-unavailable' }).retry, true);
  assert.equal(m.replyErrorOf({ status: 422, type: 'invalid-body' }).kind, 'invalid');
  assert.equal(m.replyErrorOf({ status: 404 }).kind, 'not-found');
});

test('문의 상세 주소는 문의 ID만 encode하고 본문·계좌번호를 넣지 않는다', async () => {
  const m = await mod();
  assert.equal(m.inquiryHref('inq-1'), '/help/inquiries/inq-1');
  assert.equal(m.inquiryHref('a/b?c'), '/help/inquiries/a%2Fb%3Fc');
});
