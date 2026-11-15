// 알림 신청·끄기 실패 글: 오픈 알림과 취소표 알림(ADR-0272 결정 2, ADR-0213 결정 5, docs/frontend.md §4.1 '오류 모양', BUILD_ORDER HOT-346)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertFailureText } from './failure.ts';

const problem = (status, name) => Object.assign(new Error(name ?? String(status)), { status, ...(name ? { type: `https://peaket.example/problems/${name}` } : {}) });
const LIMIT = '알림 신청 수를 넘었습니다. 관심 공연에서 쓰지 않는 알림을 꺼 주세요';

test('취소표 알림 실패 글: 422 subscription-limit은 오픈 알림과 같은 글, 410 sale-ended "판매가 끝나 알림을 신청할 수 없습니다", 그 밖은 신청·끄기 글이 다르다', () => {
  assert.equal(alertFailureText(problem(422, 'subscription-limit'), true, 'cancel'), LIMIT);
  assert.equal(alertFailureText(problem(410, 'sale-ended'), true, 'cancel'), '판매가 끝나 알림을 신청할 수 없습니다');
  // 그 밖(목록 밖 이름마다, 오픈 알림의 open-passed 포함)
  for (const e of [problem(429, 'too-many-requests'), problem(503), problem(410, 'open-passed'), problem(410, 'Sale-Ended'), new TypeError('Failed to fetch'), undefined]) {
    assert.equal(alertFailureText(e, true, 'cancel'), '취소표 알림을 신청하지 못했습니다. 잠시 뒤 다시 해 주세요', `켜기 ${e?.message}`);
    assert.equal(alertFailureText(e, false, 'cancel'), '취소표 알림을 끄지 못했습니다. 잠시 뒤 다시 해 주세요', `끄기 ${e?.message}`);
  }
});

test('오픈 알림 실패 글은 그대로다(open-passed·subscription-limit·그 밖)', () => {
  for (const kind of [undefined, 'open']) {
    const f = (e, on) => (kind ? alertFailureText(e, on, kind) : alertFailureText(e, on));
    assert.equal(f(problem(410, 'open-passed'), true), '오픈 시각이 지나 오픈 알림을 신청할 수 없습니다');
    assert.equal(f(problem(422, 'subscription-limit'), true), LIMIT);
    // 취소표 알림의 sale-ended는 오픈 알림에서는 그 밖이다
    for (const e of [problem(410, 'sale-ended'), problem(503), new TypeError('Failed to fetch')]) {
      assert.equal(f(e, true), '오픈 알림을 신청하지 못했습니다. 잠시 뒤 다시 해 주세요', `${kind} 켜기 ${e.message}`);
      assert.equal(f(e, false), '오픈 알림을 끄지 못했습니다. 잠시 뒤 다시 해 주세요', `${kind} 끄기 ${e.message}`);
    }
  }
});
