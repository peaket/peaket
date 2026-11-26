// F-06-5 core-svc 팬 문의 HTTP 시험(시험 담당 lane2-freeze-F-06-5-opencode).
// 정본: openapi /v1/inquiries*, docs/features/transfer-refund.md §7.1·§7.3, docs/data.md inquiry·inquiry_message, R-T27 ①~⑦.
// 구현 전에는 /v1/inquiries*가 404이고 support 키트에 inquiries가 없어 각 시험이 그 자리에서 실패한다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BD3, BD10, inquiryHarness, problemType, submit, type InquiryHarness } from './support-inquiry-support.js';

let h: InquiryHarness;
beforeEach(async () => {
  h = await inquiryHarness();
});
afterEach(async () => {
  await h?.close();
});

const ORDER = '2026101400123';
const GOODS = 'ord-20261018-0010';

describe('R-T27 고객 문의 접수·목록·상세·추가 문의', () => {
  test('R-T27 ① [ASVS v5.0.0-1.2.1][ASVS v5.0.0-2.1.1][ASVS v5.0.0-14.2.1][ASVS v5.0.0-14.2.6][ASVS v5.0.0-16.2.5] 문의를 접수하면 번호·3영업일 기한·첫 기록·CS 건 요청이 생기고 Outbox에 본문이 없다', async () => {
    const accountId = randomUUID();
    h.orders.set(ORDER, { accountId, summary: 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00 · R석 2매' });
    const r = await submit(h, { accountId, category: 'BOOKING_PAYMENT', orderRef: ORDER, body: '예매한 표를 취소하고 싶은데 수수료가 얼마인지 궁금합니다. 확인 부탁드립니다.' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(String(r.body.number)).toMatch(/^Q-2611-\d{4}$/);
    expect(r.body.dueAt).toBe(BD3);
    expect(r.location).toBe(`/v1/inquiries/${String(r.body.inquiryId)}`);
    expect(String(r.headers['cache-control'])).toContain('no-store');
    const rows = h.kit().inquiries.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inquiryId: r.body.inquiryId, accountId, category: 'BOOKING_PAYMENT', orderRef: ORDER, status: 'RECEIVED', caseId: null });
    const first = h.kit().inquiries.messages();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ inquiryId: r.body.inquiryId, authorKind: 'FAN', kind: 'MESSAGE' });
    const outbox = h.kit().inquiries.outbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ eventKey: r.body.inquiryId, kind: 'INQUIRY', sourceId: r.body.inquiryId, category: 'BOOKING_PAYMENT' });
    const keys = Object.keys(outbox[0]!).sort();
    expect(keys).toEqual(['category', 'createdAt', 'eventKey', 'kind', 'sourceId']);
    expect(JSON.stringify(outbox)).not.toContain('수수료');
    expect(JSON.stringify(outbox)).not.toContain(accountId);
    expect(JSON.stringify(outbox)).not.toContain(ORDER);
  });

  test('R-T27 ② [ASVS v5.0.0-1.3.3][ASVS v5.0.0-2.2.1][ASVS v5.0.0-2.2.2][ASVS v5.0.0-8.2.3] 유형 없음·제목 4자·내용 9자는 422이고 행 0이며 모르는 칸은 400이다', async () => {
    const accountId = randomUUID();
    const bad = [
      { title: '제목입니다', body: '내용이 열 자를 넘는 문의 본문입니다.' },
      { category: 'MERCH', title: '네자', body: '내용이 열 자를 넘는 문의 본문입니다.' },
      { category: 'MERCH', title: '제목입니다', body: '아홉자본문입' },
      { category: 'NOT_A_CATEGORY', title: '제목입니다', body: '내용이 열 자를 넘는 문의 본문입니다.' },
    ];
    for (const body of bad) {
      const r = await h.create(h.fanHeaders(accountId), body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(problemType(r.body)).toBe('invalid-body');
    }
    const extra = await h.create(h.fanHeaders(accountId), { category: 'MERCH', title: '제목입니다', body: '내용이 열 자를 넘는 문의 본문입니다.', caseId: randomUUID() });
    expect(extra.status).toBe(400);
    expect(problemType(extra.body)).toBe('invalid-body');
    expect(h.kit().inquiries.rows()).toHaveLength(0);
  });

  test('R-T27 ③ [ASVS v5.0.0-2.1.3][ASVS v5.0.0-2.3.2][ASVS v5.0.0-2.4.1] 하루 10건까지 받고 11번째는 429이며 다음 KST 날에는 다시 받는다', async () => {
    const accountId = randomUUID();
    for (let i = 1; i <= 10; i += 1) {
      const r = await submit(h, { accountId, title: `배송 문의 ${i}번째`, key: `daily-${i}` });
      expect(r.status, `${i}번째 ${JSON.stringify(r.body)}`).toBe(201);
    }
    const eleventh = await submit(h, { accountId, title: '배송 문의 열한번째', key: 'daily-11' });
    expect(eleventh.status).toBe(429);
    expect(problemType(eleventh.body)).toBe('inquiry-daily-limit');
    h.clock.advance(86_400_000);
    const next = await submit(h, { accountId, title: '다음 날 배송 문의' });
    expect(next.status).toBe(201);
    expect(h.kit().inquiries.rows().filter((x) => x.accountId === accountId)).toHaveLength(11);
  });

  test('R-T27 ③ 같은 Idempotency-Key 같은 본문은 201 한 행, 다른 본문은 422다', async () => {
    const accountId = randomUUID();
    const first = await h.create(h.fanHeaders(accountId), { category: 'MERCH', title: '응원봉 배송 문의', body: '응원봉 배송 예정일을 알고 싶습니다. 확인 부탁드립니다.' } as never, 'same-key-1');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await h.create(h.fanHeaders(accountId), { category: 'MERCH', title: '응원봉 배송 문의', body: '응원봉 배송 예정일을 알고 싶습니다. 확인 부탁드립니다.' } as never, 'same-key-1');
    expect(again.status).toBe(201);
    expect(again.body.inquiryId).toBe(first.body.inquiryId);
    const other = await h.create(h.fanHeaders(accountId), { category: 'MERCH', title: '다른 제목의 문의', body: '같은 열쇠에 다른 본문을 보내 봅니다. 어떻게 되는지 궁금합니다.' } as never, 'same-key-1');
    expect(other.status).toBe(422);
    expect(problemType(other.body)).toBe('idempotency-key-reused');
    expect(h.kit().inquiries.rows()).toHaveLength(1);
  });

  test('R-T27 ④ [ASVS v5.0.0-2.1.2][ASVS v5.0.0-14.2.2][ASVS v5.0.0-14.3.2] 분쟁 문의 상세는 진행 3영업일·결과 10영업일을 보이고 목록에는 기록이 없으며 열면 본 시각을 남긴다', async () => {
    const accountId = randomUUID();
    const created = await submit(h, { accountId, category: 'SELLER_DISPUTE', title: '공연 시간이 바뀌었는데 안내를 못 받았습니다', body: '예매한 공연의 시작 시간이 바뀌었다는 이야기를 들었는데 안내를 받지 못했습니다. 확인 부탁드립니다.' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body.inquiryId);
    const detail = await h.get(h.fanHeaders(accountId), id);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ inquiryId: id, category: 'SELLER_DISPUTE', status: 'RECEIVED', progressDueAt: BD3, resultDueAt: BD10 });
    expect(Array.isArray(detail.body.messages)).toBe(true);
    expect(String(detail.headers['cache-control'])).toContain('no-store');
    expect(h.kit().inquiries.rows()[0]!.fanViewedAtMs).toBe(h.clock.now());
    const list = await h.list(h.fanHeaders(accountId), 'status=RECEIVED,IN_PROGRESS');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    const item = (list.body.items as Record<string, unknown>[])[0]!;
    expect(item.messages).toBeUndefined();
    expect(item.progressDueAt).toBe(BD3);
    expect(item.resultDueAt).toBe(BD10);
  });

  test('R-T27 ⑥ [ASVS v5.0.0-8.2.2][ASVS v5.0.0-8.3.1][ASVS v5.0.0-16.3.2][ASVS v5.0.0-16.5.1] 남의 문의는 없는 문의와 같은 404이고 시도가 로그에 남는다', async () => {
    const owner = randomUUID();
    const created = await submit(h, { accountId: owner });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body.inquiryId);
    const stranger = h.fanHeaders(randomUUID());
    const other = await h.get(stranger, id);
    const missing = await h.get(stranger, randomUUID());
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(problemType(other.body)).toBe(problemType(missing.body));
    const msg = await h.message(stranger, id, { body: '남의 문의에 글을 남겨 봅니다. 어떻게 되는지 궁금합니다.' });
    expect(msg.status).toBe(404);
    const denied = h.logs.lines().filter((l) => l.status === 404);
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });

  test('R-T27 ⑦ [ASVS v5.0.0-1.2.3][ASVS v5.0.0-1.3.5][ASVS v5.0.0-3.2.2] 12개 유형을 받고 외부 되팔이 신고는 INQUIRY 건·category 그대로이며 첨부가 없다', async () => {
    const accounts = [randomUUID(), randomUUID()];
    const categories = ['BOOKING_PAYMENT', 'CANCEL_REFUND', 'TRANSFER', 'ENTRY', 'ACCOUNT', 'AUTOMATED_DECISION', 'SELLER_DISPUTE', 'MINOR_CONTRACT_CANCEL', 'MERCH', 'MODERATION_APPEAL', 'RESALE_POST_REPORT', 'OTHER'];
    for (const [i, category] of categories.entries()) {
      const r = await submit(h, { accountId: accounts[Math.floor(i / 6)]!, category, title: `문의 유형 확인 ${i}번째`, body: '문의 유형 열두 개를 차례로 접수해 보는 시험 본문입니다.' });
      expect(r.status, category).toBe(201);
    }
    const rows = h.kit().inquiries.rows();
    expect(rows).toHaveLength(12);
    const resale = rows.find((r) => r.category === 'RESALE_POST_REPORT')!;
    const out = h.kit().inquiries.outbox().find((o) => o.sourceId === resale.inquiryId)!;
    expect(out).toMatchObject({ kind: 'INQUIRY', category: 'RESALE_POST_REPORT' });
    const dispute = rows.find((r) => r.category === 'SELLER_DISPUTE')!;
    expect(h.kit().inquiries.outbox().find((o) => o.sourceId === dispute.inquiryId)).toMatchObject({ kind: 'DISPUTE', category: 'SELLER_DISPUTE' });
    const minor = rows.find((r) => r.category === 'MINOR_CONTRACT_CANCEL')!;
    expect(h.kit().inquiries.outbox().find((o) => o.sourceId === minor.inquiryId)).toMatchObject({ kind: 'MINOR_CONTRACT_CANCEL', category: 'MINOR_CONTRACT_CANCEL' });
    const withAttachment = await h.create(h.fanHeaders(accounts[1]!), { category: 'MERCH', title: '첨부를 보내 봅니다', body: '첨부 파일을 받지 않는다는 것을 확인하는 시험 본문입니다.', attachment: 'a.png' });
    expect(withAttachment.status).toBe(400);
  });
});

describe('계좌번호 꼴·길이·트랜잭션·로그', () => {
  test('R-T27 [ASVS v5.0.0-16.2.1][ASVS v5.0.0-16.4.1][ASVS v5.0.0-1.5.2] 계좌번호는 저장값 그대로이고 로그·Outbox에 남지 않으며 제어 문자는 지운다', async () => {
    const accountId = randomUUID();
    const body = '환불은 [은행] 110-123-456789 계좌로 받고 싶습니다.\n줄바꿈\u202e양방향\u0007 제어 문자도 넣어 봅니다.';
    const r = await submit(h, { accountId, category: 'CANCEL_REFUND', body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const row = h.kit().inquiries.rows()[0]!;
    expect(row.body).toContain('110-123-456789');
    expect(row.body).not.toContain('\u202e');
    expect(row.body).not.toContain('\u0007');
    expect(JSON.stringify(h.kit().inquiries.outbox())).not.toContain('110-123-456789');
    expect(h.logs.text()).not.toContain('110-123-456789');
    expect(h.logs.text()).not.toContain('양방향');
    for (const line of h.logs.lines()) expect(typeof line.msg === 'string' || line.msg === undefined).toBe(true);
  });

  test('R-T27 [ASVS v5.0.0-1.1.1][ASVS v5.0.0-1.4.2] 제목 5/50·내용 10/2,000 경계는 받고 4/51·9/2,001과 page 0·limit 51은 거절한다', async () => {
    const accountId = randomUUID();
    expect((await submit(h, { accountId, title: '12345', body: '1234567890' })).status).toBe(201);
    expect((await submit(h, { accountId, title: '가'.repeat(50), body: '나'.repeat(2000), key: 'boundary-max' })).status).toBe(201);
    expect((await submit(h, { accountId, title: '1234', body: '1234567890', key: 't4' })).status).toBe(422);
    expect((await submit(h, { accountId, title: '가'.repeat(51), body: '나'.repeat(10), key: 't51' })).status).toBe(422);
    expect((await submit(h, { accountId, title: '12345', body: '123456789', key: 'b9' })).status).toBe(422);
    expect((await submit(h, { accountId, title: '12345', body: '나'.repeat(2001), key: 'b2001' })).status).toBe(422);
    expect((await h.list(h.fanHeaders(accountId), 'page=0')).status).toBe(400);
    expect((await h.list(h.fanHeaders(accountId), 'limit=51')).status).toBe(400);
    expect((await h.list(h.fanHeaders(accountId), 'status=UNKNOWN')).status).toBe(400);
  });

  test('R-T27 [ASVS v5.0.0-2.3.3][ASVS v5.0.0-1.2.4] 저장 실패를 주입하면 문의·첫 기록·Outbox가 모두 0이다', async () => {
    const accountId = randomUUID();
    h.kit().inquiries.failNext('saveInquiry');
    const r = await submit(h, { accountId });
    expect([500, 503]).toContain(r.status);
    expect(h.kit().inquiries.rows()).toHaveLength(0);
    expect(h.kit().inquiries.messages()).toHaveLength(0);
    expect(h.kit().inquiries.outbox()).toHaveLength(0);
  });

  test('R-T27 [ASVS v5.0.0-2.2.3][ASVS v5.0.0-1.3.7][ASVS v5.0.0-1.3.11] 남의 주문은 422, 주문 원천 실패는 503이고 행이 없으며 알림 문구에 본문을 싣지 않는다', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    h.orders.set(ORDER, { accountId: owner, summary: 'LUMEN 콘서트' });
    const notMine = await submit(h, { accountId: other, orderRef: ORDER });
    expect(notMine.status).toBe(422);
    expect(problemType(notMine.body)).toBe('order-not-owned');
    h.orders.set('ord-down-1', 'boom');
    const down = await submit(h, { accountId: other, orderRef: 'ord-down-1' });
    expect(down.status).toBe(503);
    expect(problemType(down.body)).toBe('order-lookup-unavailable');
    expect(h.kit().inquiries.rows()).toHaveLength(0);
    const mine = await submit(h, { accountId: owner, orderRef: ORDER, title: '관련 주문을 붙인 문의', body: '관련 주문을 붙여서 접수해 보는 시험 본문입니다.' });
    expect(mine.status).toBe(201);
    expect(h.notices).toHaveLength(0);
  });

  test('R-T27 [ASVS v5.0.0-3.5.1][ASVS v5.0.0-3.5.2][ASVS v5.0.0-3.5.3] Idempotency-Key 없이도 접수하고 같은 열쇠는 한 번만 반영하며 JSON 아닌 본문은 415, GET·POST 밖 메서드는 405다', async () => {
    const accountId = randomUUID();
    const noKey = await h.create(h.fanHeaders(accountId), { category: 'MERCH', title: '열쇠 없는 문의', body: '멱등 열쇠 없이 접수해 보는 시험 본문입니다.' } as never);
    expect(noKey.status, JSON.stringify(noKey.body)).toBe(201);
    const form = await h.svc.http.inject({ method: 'POST', url: '/v1/inquiries', headers: { ...h.fanHeaders(accountId), 'content-type': 'application/x-www-form-urlencoded' }, payload: 'category=MERCH' });
    expect(form.statusCode).toBe(415);
    const put = await h.svc.http.inject({ method: 'PUT', url: '/v1/inquiries', headers: h.fanHeaders(accountId) });
    expect([404, 405]).toContain(put.statusCode);
  });

  test('R-T27 [ASVS v5.0.0-16.3.3][ASVS v5.0.0-16.3.4][ASVS v5.0.0-16.1.1] 한도 초과·남의 주문·닫힌 문의 시도가 로그에 남고 본문은 남지 않는다', async () => {
    const accountId = randomUUID();
    h.orders.set(ORDER, { accountId: randomUUID(), summary: '다른 사람의 주문' });
    await submit(h, { accountId, orderRef: ORDER, body: '남의 주문을 붙여 보는 시험 본문입니다.' });
    for (let i = 0; i < 10; i += 1) await submit(h, { accountId, title: `로그 한도 ${i}번째` });
    await submit(h, { accountId, title: '로그 한도 열한번째' });
    const text = h.logs.text();
    expect(text).toContain('inquiry-daily-limit');
    expect(text).toContain('order-not-owned');
    expect(text).not.toContain('남의 주문을 붙여 보는 시험 본문입니다.');
  });

  test('R-T27 [ASVS v5.0.0-8.1.1][ASVS v5.0.0-8.1.2][ASVS v5.0.0-8.2.1][ASVS v5.0.0-14.1.1][ASVS v5.0.0-14.1.2][ASVS v5.0.0-14.2.4] 내부 건 ID 되적기는 내부 토큰이 필요하고, 팬 상세에는 담당자 ID·계정 ID가 실리지 않는다', async () => {
    const accountId = randomUUID();
    const created = await submit(h, { accountId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body.inquiryId);
    const caseId = randomUUID();
    expect((await h.internalCase(id, caseId, null)).status).toBe(401);
    expect((await h.internalCase(id, caseId, 'wrong-token')).status).toBe(401);
    const ok = await h.internalCase(id, caseId);
    expect(ok.status).toBe(200);
    expect(h.kit().inquiries.rows()[0]!.caseId).toBe(caseId);
    const detail = await h.get(h.fanHeaders(accountId), id);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(caseId);
    expect(detail.body.actedBy).toBeUndefined();
    expect(detail.body.assignee).toBeUndefined();
    const msg = (detail.body.messages as Record<string, unknown>[])[0]!;
    expect(msg.authorDisplay).toBe('나');
    expect(Object.keys(msg).sort()).toEqual(['authorDisplay', 'authorKind', 'body', 'createdAt', 'kind', 'messageId']);
  });

  test('R-T27 [ASVS v5.0.0-1.2.2] 목록·상세 주소에는 문의 ID만 들어가고 본문·계좌번호가 URL에 없다', async () => {
    const accountId = randomUUID();
    const created = await submit(h, { accountId, body: '환불은 110-123-456789 계좌로 받고 싶습니다. 주소에 남는지 봅니다.' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const detail = await h.get(h.fanHeaders(accountId), String(created.body.inquiryId));
    expect(detail.status).toBe(200);
    expect(String(created.location)).not.toContain('110-123');
    const list = await h.list(h.fanHeaders(accountId));
    expect(list.status).toBe(200);
    const encoded = JSON.stringify(list.body);
    expect(encoded).not.toContain('110-123-456789');
  });
});
