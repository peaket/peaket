// K5 PoC 판정 어림 시험(BUILD_ORDER BAS-190, seatmap/RESULT.md '재는 법과 한계'). 인수 시험 ID K5는 브라우저 측정(seatmap.spec.mjs)에만 단다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeK5 } from './judge.mjs';

const S = { mainBootMs: 10, workerBootMs: 5, fetchMs: 2, parseMs: 3, decodeMs: 4, gridMs: 1, overviewDrawMs: 6, frameWaitMs: 4 };

test('도구 CPU 느리게 하기가 걸리지 않는 Worker 몫(Worker 쪽 시작, 받기·풀기·색인, 그리기, 첫 프레임 기다림)만 배수를 곱한다', () => {
  // 단계 3 = 메인 몫(Worker 만들기·캔버스 넘기기, 이미 느려졌다) + 배수 × Worker 몫(Worker 쪽 시작 + 받기·풀기·형식 배열·색인)
  // 단계 5 = 배수 × (그리기 + 첫 프레임 기다림). 둘 다 Worker 스레드에서 돈다
  assert.deepEqual(judgeK5(S, 4), { stage3Ms: 10 + 4 * (5 + 2 + 3 + 4 + 1), stage5Ms: 4 * (6 + 4) });
  assert.deepEqual(judgeK5(S, 1), { stage3Ms: 25, stage5Ms: 10 });
});

test('도구 배수는 1 이상의 수여야 한다', () => {
  for (const bad of [0, -1, Number.NaN, '4']) assert.throws(() => judgeK5(S, bad), /배수/, String(bad));
});
