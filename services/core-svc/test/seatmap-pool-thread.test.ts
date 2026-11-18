// 좌석맵 해석 작업 풀의 시간 상한을 진짜 작업 스레드로 본다(BAT-174, docs/features/seat-hold.md S-T34 ④, docs/verification.md §4.1 좌석맵 가져오기 해석 줄 'CPU 5초 [가정]').
// 공개 클래스 ParsePool만 부르고, 스레드는 시험용(test/fixtures/pool-cpu-thread.mjs)이다. 상한은 옵션으로 100ms로 줄인다(5초를 실제로 기다리지 않는다).
// 판정은 스레드가 쓴 CPU 시간이 정하므로, 러너가 바빠 벽시계가 늘어도 답이 바뀌지 않는다. 시험 시간 한도는 느린 러너를 위한 넉넉한 값일 뿐 판정이 아니다.
// 상한 경계(직전·같은 값)와 벽시계 바깥 막이는 가짜 스레드·가짜 시계로 seatmap-pool-cpu.test.ts가 본다.
import { describe, expect, test } from 'vitest';
import { ParsePool } from '../src/seatmap-worker/pool.js';

const threadUrl = new URL('./fixtures/pool-cpu-thread.mjs', import.meta.url);
const enc = (s: string) => new TextEncoder().encode(s);
/** 시험용 상한: 정본 5초를 줄인 값. 시험용 스레드가 잠드는 시간(1,000ms)보다 짧다 */
const LIMIT_MS = 100;

describe('좌석맵 해석 작업 풀: 진짜 스레드의 CPU 시간', () => {
  test('BAT-174 S-T34 ④ 작업 스레드가 CPU를 쓰지 않고 기다린 시간은 시간 상한에 들지 않는다', async () => {
    const pool = new ParsePool({ threadUrl, timeoutMs: LIMIT_MS });
    const t0 = performance.now();
    const o = await pool.run(enc('sleep:1000'), 'SVG');
    expect(o).toEqual({ kind: 'result', reply: { kind: 'result', status: 'REJECTED', errors: [], ignored: [] } });
    // 잠든 동안 벽시계는 상한의 열 배가 지났다(벽시계로 재면 잘린다)
    expect(performance.now() - t0).toBeGreaterThan(LIMIT_MS * 5);
  }, 30_000);

  test('BAT-174 S-T34 ④ CPU를 상한보다 오래 쓰는 해석은 여전히 cpu-limit이고 스레드를 끝내 같은 풀이 다음 요청을 받는다', async () => {
    const pool = new ParsePool({ threadUrl, timeoutMs: LIMIT_MS });
    const t0 = performance.now();
    expect(await pool.run(enc('busy'), 'SVG')).toEqual({ kind: 'cpu-limit' });
    // CPU 시간은 벽시계보다 길 수 없으니 잘린 때는 적어도 상한만큼 지난 뒤다(일찍 자르지 않는다)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(LIMIT_MS - 1);
    // 끝나지 않는 바쁜 고리를 끝냈으니 줄이 풀려 다음 해석이 돈다
    expect(await pool.run(enc('quick'), 'SVG')).toMatchObject({ kind: 'result' });
  }, 30_000);
});
