// 비공개 규칙 다시 읽기와 준비 상태(docs/features/bot-defense.md §4.4): 읽어야 준비 상태가 된다. 처음에 못 읽었으면 5초 [가정]마다, 읽은 뒤에는 5분 [가정]마다 다시 읽는다.
// 실패하면 마지막 판을 쓰고 준비 상태는 그대로다. 시작 파일 main.ts가 쓴다.
export const RULES_RETRY_MS = 5_000;
export const RULES_REFRESH_MS = 300_000;

export function startRuleRefresh(o: {
  rules: { refresh(): Promise<boolean> };
  readiness: { register(task: string): void; complete(task: string): void };
  task: string;
  setTimer?: (fn: () => void, ms: number) => unknown;
}): { first: Promise<void>; stop(): void } {
  o.readiness.register(o.task);
  let timer: unknown;
  let stopped = false;
  let loaded = false;
  const setTimer =
    o.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return t;
    });
  const tick = async () => {
    const ok = await o.rules.refresh();
    if (stopped) return;
    if (ok && !loaded) o.readiness.complete(o.task);
    loaded ||= ok;
    timer = setTimer(() => void tick(), loaded ? RULES_REFRESH_MS : RULES_RETRY_MS);
  };
  return {
    first: tick(),
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer as NodeJS.Timeout);
    },
  };
}
