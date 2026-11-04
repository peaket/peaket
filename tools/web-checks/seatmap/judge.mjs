// K5 PoC 판정 어림(BUILD_ORDER BAS-190, docs/frontend.md §5.2). 숫자 계산만 두어 node --test로 따로 시험한다.
// 개발자 도구 규약(CDP)의 CPU 느리게 하기(Emulation.setCPUThrottlingRate)는 페이지(메인 스레드)에만 걸리고 Worker에는 걸리지 않는다.
// 2026-11-04 잼(Playwright 1.64.1 Chromium): ① 페이지에 4배를 걸어도 Worker의 같은 계산은 1.0~1.3배였다
// ② context.newCDPSession(worker)는 'expected Page or Frame'으로 거절된다 ③ 브라우저 세션에서 Worker 대상에 붙어(Target.attachToTarget)
// Emulation.setCPUThrottlingRate를 보내면 'Operation is only supported for pages, not workers'로 거절된다(Runtime·HeapProfiler는 된다).
// 그래서 Worker 스레드에서 도는 몫은 모두 배수를 곱해 보수적으로 어림한다.

/**
 * @param {{ mainBootMs: number, workerBootMs: number, fetchMs: number, parseMs: number, decodeMs: number, gridMs: number, overviewDrawMs: number, frameWaitMs: number }} s
 *   mainBootMs: 메인(Worker 만들기·캔버스 넘기기·init 보내기, 이미 느려졌다), workerBootMs: Worker 쪽(스크립트 받기·실행, init 받기),
 *   fetchMs·parseMs·decodeMs·gridMs: Worker의 받기·JSON 풀기·형식 배열·격자 색인, overviewDrawMs·frameWaitMs: Worker의 그리기·첫 프레임 기다림
 * @param {number} k CPU 느리게 하기 배수(1이면 그대로)
 * @returns {{ stage3Ms: number, stage5Ms: number }}
 */
export function judgeK5(s, k) {
  if (typeof k !== 'number' || !(k >= 1)) throw new TypeError(`배수는 1 이상의 수여야 한다(받은 값 ${k})`);
  return {
    stage3Ms: s.mainBootMs + k * (s.workerBootMs + s.fetchMs + s.parseMs + s.decodeMs + s.gridMs),
    stage5Ms: k * (s.overviewDrawMs + s.frameWaitMs),
  };
}
