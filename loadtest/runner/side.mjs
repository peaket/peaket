// 부하 실행 중 시각을 맞춰 하는 곁작업(입구 끊기·되돌리기, 앱 파드 강제 종료, 변경분 연결 시작, docs/verification.md §3.10).
// 곁작업 하나가 실패해도 처리되지 않은 거부로 프로세스가 정리 없이 죽지 않게, 오류를 모아 두었다가 k6가 끝난 뒤 돌려준다(2026-11-03 새 맥락 리뷰).
// 정리가 시작되거나 k6가 일찍 실패하면 cancel()로 아직 돌지 않은 곁작업을 막는다(정리 뒤에 입구를 끊어 0개로 남기지 않게, 2차 리뷰).

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 곁작업 모음. startMs(부하 시작 시각, 유한한 수가 아니면 RangeError) 기준으로 at(offsetS, fn)이 offsetS초 뒤에 fn을 부른다(이미 지났으면 곧바로).
 * 남은 시간은 at을 부를 때 센다. fn이 던지거나 거부해도 at은 던지지 않고 오류를 모은다. settle()은 모든 곁작업이 끝나기를 기다려 모은 오류 목록
 * (부른 차례가 아니라 끝난 차례)을 돌려준다. cancel()은 기다리는 곁작업을 곧바로 끝내고(fn을 부르지 않는다) 그 뒤에 더한 곁작업도 부르지 않는다.
 * 이미 돌기 시작한 fn은 멈추지 않는다. offsetS는 0 이상 유한한 수, fn은 함수다(아니면 RangeError).
 * @param {number} startMs
 * @param {{ now?: () => number, sleep?: (ms: number) => Promise<void> }} [o]
 * @returns {{ at: (offsetS: number, fn: () => unknown) => void, settle: () => Promise<Error[]>, cancel: () => void }}
 */
export function sideTasks(startMs, o = {}) {
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) throw new RangeError(`부하 시작 시각이 유한한 수가 아니다: ${startMs}`);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const tasks = [];
  const errors = [];
  let cancelled = false;
  let wake;
  const cancelledSignal = new Promise((r) => {
    wake = r;
  });
  return {
    at(offsetS, fn) {
      if (typeof offsetS !== 'number' || !Number.isFinite(offsetS) || offsetS < 0) throw new RangeError(`곁작업 시각은 0 이상 유한한 수(초)다: ${offsetS}`);
      if (typeof fn !== 'function') throw new RangeError('곁작업은 함수다');
      // 남은 시간은 부를 때 바로 센다(뒤로 미루면 그사이 흐른 시간만큼 늦게 돈다)
      const waitMs = Math.max(0, startMs + offsetS * 1000 - now());
      // 기다림 타이머가 취소 뒤 프로세스를 붙잡지 않게, 기본 sleep이면 취소할 수 있는 타이머로 기다린다
      let timer;
      const wait = o.sleep
        ? sleep(waitMs)
        : new Promise((r) => {
            timer = setTimeout(r, waitMs);
          });
      tasks.push(
        Promise.race([wait, cancelledSignal])
          .then(() => {
            if (timer) clearTimeout(timer);
            if (cancelled) return undefined;
            return fn();
          })
          .then(
            () => undefined,
            (e) => {
              errors.push(e instanceof Error ? e : new Error(String(e)));
            },
          ),
      );
    },
    async settle() {
      await Promise.all(tasks);
      return errors.slice();
    },
    cancel() {
      cancelled = true;
      wake();
    },
  };
}
