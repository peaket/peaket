// 오류 type → 문구 키 표 시험(docs/frontend.md §5.12, BUILD_ORDER BAS-041)
import { expect, test } from 'vitest';
import { ApiError, copyKeyOf, PROBLEM_COPY_KEYS, PROBLEM_TYPES } from '../src';

const problem = (status: number, type: string, headers: string | null = null) => new ApiError(status, { type: `https://peaket.example/problems/${type}`, status }, headers);

test('목록의 모든 이름에 문구 키가 있고, §5.12 표의 키는 그대로 쓴다', () => {
  expect(Object.keys(PROBLEM_COPY_KEYS).sort()).toEqual(Object.keys(PROBLEM_TYPES).sort());
  expect(PROBLEM_COPY_KEYS['seat-already-held']).toBe('seat.hold.conflict');
  expect(PROBLEM_COPY_KEYS['sale-paused']).toBe('sale.paused');
  expect(PROBLEM_COPY_KEYS['sold-out']).toBe('queue.soldOut');
  // 표에 없는 이름은 problem.<이름>이다(번역 파일이 같은 키를 가져야 한다, FE-T19)
  expect(PROBLEM_COPY_KEYS['order-expired']).toBe('problem.order-expired');
});

test('copyKeyOf: 같은 이름이 작업마다 다른 키(예매 제한), 이름 없는 429·503 + Retry-After는 common.retryAfter, 그 밖은 상태 코드 키', () => {
  expect(copyKeyOf(problem(403, 'booking-restricted'), 'createQueueAdmission')).toBe('queue.admission.restricted');
  expect(copyKeyOf(problem(403, 'booking-restricted'), 'createOrder')).toBe('order.create.restricted');
  expect(copyKeyOf(new ApiError(503, { type: 'about:blank', status: 503 }, '2'))).toBe('common.retryAfter');
  expect(copyKeyOf(new ApiError(404, { type: 'about:blank', status: 404 }, null))).toBe('common.http.404');
  // 목록에 없는 이름(다른 판의 서버)은 상태 코드 키로 내린다
  expect(copyKeyOf(problem(409, 'brand-new-problem'))).toBe('common.http.409');
});
