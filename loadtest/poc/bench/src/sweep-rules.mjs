// 만료 반복의 규칙(S-T27 측정 도구, BUILD_ORDER PRF-135). 운영 services/purchase-svc/src/modules/inventory/application/expiry-sweeper.ts의
// ExpirySweeper(tick()·start()·#loop·#sweepEvent)와 같은 규칙을 입출력 없이 적은 것이다. loadtest/test/poc-seat.test.mjs가 시험한다.
// 값(상수)은 seat-contract.mjs에 있다(운영 domain/expiry.ts와 같은 값이고 시험이 견준다). 의존성이 없어 측정 컨테이너와 뿌리의 node --test가 함께 읽는다.
//
// 규칙
// - 반복 한 번은 틱의 이어짐이다(#loop). 한 틱(tick())은 회차를 문자 코드 순으로 꺼내 EXPIRY_CONCURRENCY개까지 동시에 돈다(sweepOrder·runLanes).
// - 회차 하나의 한 틱은 만료 인덱스 앞줄 EXPIRY_BATCH_SIZE석씩 최대 EXPIRY_MAX_BATCHES_PER_TICK묶음이다(batchOutcome).
// - 한 틱에서 어떤 회차든 묶음 상한(BATCH_LIMIT)에 닿으면 기다리지 않고 다음 틱을 바로 연다. 아니면 다음 1초 격자까지 기다린다(nextTickDelayMs).
//   예전 측정 도구는 상한에 닿아도 남은 1초를 쉬고 회차를 한 줄로 돌아 운영보다 만료를 덜 했다(2026-11-04 최종 검토).
// - 오류가 난 회차는 EXPIRY_BACKOFF_MS 동안 쉰다(isResting).
import { EXPIRY_BACKOFF_MS, EXPIRY_BATCH_SIZE, EXPIRY_MAX_BATCHES_PER_TICK, EXPIRY_TICK_MS } from './seat-contract.mjs';

/**
 * 묶음 하나를 돈 뒤 그 회차의 틱을 어떻게 할지(운영 #sweepEvent의 묶음 되풀이, 검사 차례까지 같다).
 * 1) 읽은 좌석이 0이면 DRAINED(만료 Lua를 부르지 않았다) 2) 푼 것·고아가 0이면 NO_PROGRESS(읽은 수가 적어도 먼저 본다)
 * 3) 읽은 수가 batchSize보다 적으면 DRAINED 4) 만료 Lua를 maxBatches번 불렀으면 BATCH_LIMIT 5) 아니면 CONTINUE(다음 묶음)
 * @param {{ dueCount: number, released?: number, orphans?: number, batches: number, batchSize?: number, maxBatches?: number }} i
 *   dueCount: 1단계에서 읽은 좌석 수. released·orphans: 만료 Lua 결과(dueCount가 0이면 쓰지 않는다). batches: 만료 Lua를 부른 수(이번 묶음 포함)
 * @returns {'CONTINUE' | 'DRAINED' | 'NO_PROGRESS' | 'BATCH_LIMIT'}
 */
export function batchOutcome({ dueCount, released = 0, orphans = 0, batches, batchSize = EXPIRY_BATCH_SIZE, maxBatches = EXPIRY_MAX_BATCHES_PER_TICK }) {
  if (!Number.isInteger(dueCount) || dueCount < 0) throw new RangeError(`dueCount는 0 이상의 정수다: ${dueCount}`);
  if (dueCount === 0) return 'DRAINED';
  if (released + orphans === 0) return 'NO_PROGRESS';
  if (dueCount < batchSize) return 'DRAINED';
  return batches >= maxBatches ? 'BATCH_LIMIT' : 'CONTINUE';
}

/**
 * 방금 끝난 틱 뒤 다음 틱을 열기까지 기다릴 시간(ms). 운영 start()·#loop와 같다.
 * - 회차 결과 가운데 BATCH_LIMIT(한 틱의 묶음 상한을 다 돌았다, 남은 만료가 더 있다)이 하나라도 있으면 0. 다음 틱을 바로 연다
 * - 아니면(DRAINED·NO_PROGRESS·그 밖) 다음 1초 격자까지. 격자는 반복을 켠 때부터 tickMs 간격이다(운영 setInterval(EXPIRY_TICK_MS)과 같다).
 *   틱이 이어져 격자를 지났으면 그 격자의 부름은 겹침이라 버려지고(운영 tick()의 overlapped) 다음 격자를 기다린다. 격자 위에서 끝났으면 tickMs 그대로다
 * @param {Iterable<string>} outcomes 방금 끝난 틱의 회차별 결과(운영 SweepOutcome 글)
 * @param {number} sinceOriginMs 반복을 켠 뒤 지난 시간(ms, 0 이상)
 * @param {number} [tickMs] 격자 간격(기본 EXPIRY_TICK_MS)
 * @returns {number} 0 이상 tickMs 이하
 */
export function nextTickDelayMs(outcomes, sinceOriginMs, tickMs = EXPIRY_TICK_MS) {
  if (!(tickMs > 0)) throw new RangeError(`tickMs는 0보다 커야 한다: ${tickMs}`);
  if (!(sinceOriginMs >= 0)) throw new RangeError(`sinceOriginMs는 0 이상이어야 한다: ${sinceOriginMs}`);
  for (const o of outcomes) if (o === 'BATCH_LIMIT') return 0;
  return tickMs - (sinceOriginMs % tickMs);
}

/** 회차 ID 문자 코드 순(Array.prototype.sort 기본과 같다)으로 겹침 없이(운영 tick()의 ids) */
export const sweepOrder = (ids) => [...new Set(ids)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

/**
 * ids를 차례로 꺼내 concurrency개까지 동시에 worker로 돈다(운영 tick()의 lane: 공유 차례표에서 하나씩 꺼내는 칸을 min(concurrency, ids.length)개 둔다).
 * 한 worker가 던지면 그 칸이 멈추고 첫 오류로 거절된다(운영 #sweepEvent는 던지지 않으니 worker도 던지지 않게 쓴다).
 * @template T
 * @param {readonly string[]} ids 도는 차례(sweepOrder로 정렬해 넘긴다)
 * @param {number} concurrency 동시에 도는 수의 상한(1 이상의 정수)
 * @param {(id: string) => Promise<T>} worker
 * @returns {Promise<T[]>} ids 차례 그대로의 결과
 */
export async function runLanes(ids, concurrency, worker) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency는 1 이상의 정수다: ${concurrency}`);
  const results = new Array(ids.length);
  let next = 0;
  const lane = async () => {
    while (next < ids.length) {
      const k = next++;
      results[k] = await worker(ids[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, lane));
  return results;
}

/** 직전 틱에서 오류(UNAVAILABLE·ERROR)가 난 회차를 지금 쉬어야 하는가(운영 #sweepEvent: 오류 시각이 있고 지금 < 그 시각 + EXPIRY_BACKOFF_MS) */
export const isResting = (failedAtMs, nowMs, backoffMs = EXPIRY_BACKOFF_MS) => failedAtMs !== undefined && nowMs < failedAtMs + backoffMs;

/**
 * 만료 반복(운영 start()의 setInterval + #loop). running()이 참인 동안 tick을 부르고, 돌려받은 회차별 결과로 다음 틱까지 기다린다(nextTickDelayMs).
 * 상한 때문에 바로 이어 연 틱은 tick(true), 그 밖은 tick(false)다. 멈춤(running()이 거짓)은 틱이 끝난 뒤 본다(돌던 틱은 마친다, 운영 L4와 같다).
 * @param {{ tick: (immediate: boolean) => Promise<readonly string[]>, elapsedMs: () => number, sleep: (ms: number) => Promise<void>, running: () => boolean, tickMs?: number }} io
 *   tick: 한 틱을 돌고 회차별 결과를 돌려준다. elapsedMs: 반복을 켠 뒤 지난 시간. sleep: ms만큼 기다린다
 * @returns {Promise<{ ticks: number, capTicks: number, immediateTicks: number }>}
 *   ticks: 돈 틱 수, capTicks: 어떤 회차든 BATCH_LIMIT에 닿은 틱 수, immediateTicks: 앞 틱의 상한 때문에 기다림 없이 이어 돈 틱 수
 */
export async function runSweepLoop({ tick, elapsedMs, sleep, running, tickMs = EXPIRY_TICK_MS }) {
  const stats = { ticks: 0, capTicks: 0, immediateTicks: 0 };
  let immediate = false;
  while (running()) {
    const outcomes = await tick(immediate);
    stats.ticks += 1;
    if (immediate) stats.immediateTicks += 1;
    if (outcomes.includes('BATCH_LIMIT')) stats.capTicks += 1;
    const wait = nextTickDelayMs(outcomes, elapsedMs(), tickMs);
    if (!running()) break;
    immediate = wait === 0;
    if (!immediate) await sleep(wait);
  }
  return stats;
}
