// F-04-13 ticket-svc 잠금 만료 정비. 60초 [가정]마다 Transfers.expireFraudLocks를 부른다.
export interface FraudLockSweepTarget {
  expireFraudLocks(nowMs?: number): Promise<number>;
}

export interface FraudLockSweep {
  tick(): Promise<number>;
  stop(): void;
}

export function startFraudLockSweep(o: { transfers: FraudLockSweepTarget; intervalMs: number; now?: () => number }): FraudLockSweep {
  const now = o.now ?? Date.now;
  const timer = setInterval(() => void o.transfers.expireFraudLocks(now()).catch(() => undefined), o.intervalMs);
  timer.unref?.();
  return {
    tick: () => o.transfers.expireFraudLocks(now()),
    stop: () => clearInterval(timer),
  };
}
