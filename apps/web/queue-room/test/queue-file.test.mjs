// 대기 상태 파일 읽기·앞 인원·예상 대기·단조 읽기·폴링 주기(docs/frontend.md §3.4·§5.1, queue-admission §4, ADR-0207)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aheadCount, etaSeconds, MonotonicReader, nextDelayMs, parseQueueState, popcountPrefix, purchaseUnlikely, segmentOf } from '../src/live/queue-file.ts';

const bitmapWith = (bits) => {
  const b = Buffer.alloc(125);
  for (const k of bits) b[k >> 3] |= 0x80 >> (k & 7);
  return b.toString('base64');
};
const file = (over = {}) => parseQueueState({ serving: 1000, servingRate: 2, saleStatus: 'ON_SALE', removedUpToServing: 0, removedBeforeSegment: 0, removedBitmap: bitmapWith([]), generatedAtMs: 1_000_000, pollHintMs: 0, ...over });

test('꼴이 틀린 파일은 null이고, 선택 칸은 있을 때만 읽는다', () => {
  assert.equal(parseQueueState(null), null);
  assert.equal(parseQueueState({ serving: -1, servingRate: 1, saleStatus: 'ON_SALE', generatedAtMs: 1 }), null);
  assert.equal(parseQueueState({ serving: 1, servingRate: 1, saleStatus: 'WHAT', generatedAtMs: 1 }), null);
  assert.equal(parseQueueState({ serving: 1, servingRate: 1, saleStatus: 'ON_SALE', generatedAtMs: 1, removedBitmap: 'AAAA' }), null, '125바이트가 아님');
  const f = file({ banner: '점검', remainingSeats: 10, avgTicketsPerOrder: 2, seatmapLayoutPath: '/x.json', admissionPaused: true, extra: 1 });
  assert.deepEqual([f.banner, f.remainingSeats, f.avgTicketsPerOrder, f.seatmapLayoutPath, f.admissionPaused], ['점검', 10, 2, '/x.json', true]);
  assert.equal(file({ banner: '  ' }).banner, undefined);
});

test('구간·비트맵: k번째 비트(바이트 안 높은 비트부터)가 번호 s×1000+1+k', () => {
  assert.deepEqual([segmentOf(1), segmentOf(1000), segmentOf(1001), segmentOf(2500)], [0, 0, 1, 2]);
  const bm = Buffer.from(bitmapWith([0, 7, 8, 999]), 'base64');
  assert.deepEqual([popcountPrefix(bm, 0), popcountPrefix(bm, 1), popcountPrefix(bm, 7), popcountPrefix(bm, 8), popcountPrefix(bm, 9), popcountPrefix(bm, 1000), popcountPrefix(bm, 5000)], [0, 1, 1, 2, 3, 4, 4]);
});

test('앞 인원 = (내 순번 − serving − 1) − 그 사이 빠진 번호(누계·비트맵), 음수면 0', () => {
  // 내 순번 1050(구간 1), serving 1010. 구간 1의 번호 1001~1049 가운데 1021·1031이 빠짐(비트 20·30), serving까지 빠진 수 5, 구간 앞까지 5
  const f = file({ serving: 1010, removedBeforeSegment: 5, removedUpToServing: 5, removedBitmap: bitmapWith([20, 30]) });
  assert.equal(aheadCount(1050, f), 1050 - 1010 - 1 - 2);
  // serving 앞의 빠진 번호(비트 3)는 removedUpToServing에 이미 들어 있다
  const g = file({ serving: 1010, removedBeforeSegment: 5, removedUpToServing: 6, removedBitmap: bitmapWith([3, 20]) });
  assert.equal(aheadCount(1050, g), 1050 - 1010 - 1 - 1);
  assert.equal(aheadCount(900, file({ serving: 1000 })), 0);
  assert.equal(aheadCount(1001, file({ serving: 1000 })), 0, '다음 차례');
});

test('예상 대기는 속도 0·일시정지·일시 매진·입장 일시정지면 숨기고, 구매 어려움은 두 값이 있을 때만', () => {
  assert.equal(etaSeconds(100, file()), 50);
  for (const over of [{ servingRate: 0 }, { saleStatus: 'PAUSED' }, { saleStatus: 'ALL_HELD' }, { admissionPaused: true }]) assert.equal(etaSeconds(100, file(over)), null, JSON.stringify(over));
  assert.equal(purchaseUnlikely(10, file()), false);
  assert.equal(purchaseUnlikely(10, file({ remainingSeats: 19, avgTicketsPerOrder: 2 })), true);
  assert.equal(purchaseUnlikely(10, file({ remainingSeats: 20, avgTicketsPerOrder: 2 })), false);
});

test('단조 읽기: 같거나 이른 생성 시각은 버리고, 새롭지만 serving이 작으면 상태만 받다가 10초 넘으면 새 값', () => {
  const r = new MonotonicReader();
  assert.equal(r.accept(file({ serving: 100, generatedAtMs: 1000 }), 0).serving, 100);
  assert.equal(r.accept(file({ serving: 200, generatedAtMs: 1000 }), 1), null, '같은 초(다른 파드)');
  assert.equal(r.accept(file({ serving: 200, generatedAtMs: 999 }), 2), null);
  const low = r.accept(file({ serving: 90, generatedAtMs: 2000, saleStatus: 'PAUSED', banner: '공지' }), 3);
  assert.deepEqual([low.serving, low.saleStatus, low.banner], [100, 'PAUSED', '공지']);
  assert.equal(r.accept(file({ serving: 95, generatedAtMs: 3000 }), 5000).serving, 100);
  assert.equal(r.accept(file({ serving: 95, generatedAtMs: 4000 }), 10_004).serving, 95, '10초 넘게 이어지면 받는다');
  assert.equal(r.accept(file({ serving: 120, generatedAtMs: 5000 }), 10_005).serving, 120);
});

test('FE-T4 폴링 주기: 거리별 0.5·5·20초, 실패 늘림(상한 60초), 숨긴 탭 5초, 하한이면 위로만 0~20%, 속도 0이면 가까운 구간만 0.5초', () => {
  const mid = () => 0.5;
  const at = (ahead, rate, extra = {}) => ({ ahead, servingRate: rate, mySegment: 1, servingSegment: 1, pollHintMs: 0, ...extra });
  assert.equal(nextDelayMs(at(100, 2), 0, false, null, mid), 500);
  assert.equal(nextDelayMs(at(400, 2), 0, false, null, mid), 5000);
  assert.equal(nextDelayMs(at(1000, 2), 0, false, null, mid), 20_000);
  assert.equal(nextDelayMs(at(100, 2), 3, false, null, mid), 4000);
  assert.equal(nextDelayMs(at(1000, 2), 5, false, null, mid), 60_000);
  assert.equal(nextDelayMs(at(100, 2), 0, true, null, mid), 5000);
  assert.equal(nextDelayMs(at(100, 2, { pollHintMs: 1000 }), 0, false, null, () => 0), 1000, '하한 아래로 가지 않는다');
  assert.equal(nextDelayMs(at(100, 2, { pollHintMs: 1000 }), 0, false, null, () => 0.999), 1000 * (1 + 0.999 * 0.2));
  assert.equal(nextDelayMs(at(100, 2), 1, false, 3000, () => 0), 3000, '503 Retry-After');
  assert.equal(nextDelayMs(at(100, 2), 0, false, null, () => 0), 400, '하한이 없으면 −20%');
  assert.equal(nextDelayMs(at(100, 0, { mySegment: 2, servingSegment: 1 }), 0, false, null, mid), 500, '속도 0, 다음 구간');
  assert.equal(nextDelayMs(at(100, 0, { mySegment: 3, servingSegment: 1 }), 0, false, null, mid), 20_000, '속도 0, 먼 구간');
});
