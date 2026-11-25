// F-04-13 1분 [가정] 조치 정비. expireDue → notifyDeadlines → closeDueCases를 한 바퀴에 부른다.
export interface FraudSweepActions {
  expireDue(nowMs: number): Promise<number>;
  notifyDeadlines(nowMs: number): Promise<number>;
  closeDueCases(nowMs: number): Promise<number>;
}

export interface FraudSweep {
  tick(): Promise<void>;
  stop(): void;
}

export function startFraudActionSweep(o: { actions: FraudSweepActions; intervalMs: number; now?: () => number }): FraudSweep {
  const timer = setInterval(() => {
    void o.actions.expireDue((o.now ?? Date.now)()).then(() => o.actions.notifyDeadlines((o.now ?? Date.now)())).then(() => o.actions.closeDueCases((o.now ?? Date.now)())).catch(() => undefined);
  }, o.intervalMs);
  timer.unref?.();
  return {
    async tick() {
      const now = (o.now ?? Date.now)();
      await o.actions.expireDue(now);
      await o.actions.notifyDeadlines(now);
      await o.actions.closeDueCases(now);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
