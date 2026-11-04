// 메모리 저장소(시험·로컬 시제품용). 트랜잭션은 한 번에 하나씩 돌고 실패하면 되돌린다(PostgreSQL 저장소와 같은 규칙).
// pid 키 전환 저장소(PidRotationStore)도 함께 구현한다(identity §5 'pid 키 전환의 첫 구현').
import type { ConflictAttempt, PidRotationRecord, PidRotationStore, VerificationRecord, VerificationStore, VerificationTx } from '../domain/ports.js';
import { type Attempt, CiAlreadyLinked, plusOneYear } from '../domain/verification.js';

/** 저장한 본인확인 기록(pid 판과 전환 기간의 옛 pid까지) */
export interface StoredVerification extends VerificationRecord {
  pidKeyVersion: number;
  pidPrev: Buffer | null;
  verifiedAt: number;
  sourceRecord: string;
}

/** 보존 전용 표의 연계정보 처리 기록(연계정보 HMAC·pid 없음) */
export interface RetainedRecord {
  sourceRecord: string;
  verifiedAt: number;
  movedAt: number;
  deleteAt: number;
}

interface State {
  attempts: Map<string, Attempt>;
  verifications: Map<string, StoredVerification>;
  conflicts: ConflictAttempt[];
}

const clone = (s: State): State => ({
  attempts: new Map([...s.attempts].map(([k, v]) => [k, { ...v }])),
  verifications: new Map([...s.verifications].map(([k, v]) => [k, { ...v }])),
  conflicts: s.conflicts.map((c) => ({ ...c })),
});

export class MemoryVerificationStore implements VerificationStore, PidRotationStore {
  #state: State = { attempts: new Map(), verifications: new Map(), conflicts: [] };
  #queue: Promise<unknown> = Promise.resolve();
  readonly #rotations: PidRotationRecord[] = [];
  readonly #retention = new Map<string, RetainedRecord>();

  transaction<T>(fn: (tx: VerificationTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const s = clone(this.#state);
      const out = await fn({
        insertAttempt: async (a) => {
          s.attempts.set(a.id, { ...a });
        },
        attemptForUpdate: async (id) => {
          const a = s.attempts.get(id);
          return a ? { ...a } : null;
        },
        completeAttempt: async (id, status, now) => {
          const a = s.attempts.get(id);
          if (a) Object.assign(a, { status, completedAt: now });
        },
        verificationOf: async (accountId) => {
          const v = s.verifications.get(accountId);
          return v ? { ciHmac: v.ciHmac, ciHmacKeyVersion: v.ciHmacKeyVersion, pid: v.pid } : null;
        },
        accountByCiHmac: async (hs, except) => {
          const hits = [...s.verifications].filter(([, v]) => hs.some((h) => v.ciHmac.equals(h))).map(([id]) => id);
          return hits.find((id) => id !== except) ?? hits[0] ?? null;
        },
        saveVerification: async (v) => {
          if ([...s.verifications].some(([id, x]) => id !== v.accountId && x.ciHmac.equals(v.ciHmac))) throw new CiAlreadyLinked();
          s.verifications.set(v.accountId, { ciHmac: v.ciHmac, ciHmacKeyVersion: v.ciHmacKeyVersion, pid: v.pid, pidKeyVersion: v.pidKeyVersion, pidPrev: null, verifiedAt: v.verifiedAt, sourceRecord: v.sourceRecord });
        },
        updateCiHmac: async (accountId, ciHmac, ciHmacKeyVersion) => {
          const v = s.verifications.get(accountId);
          if (v) Object.assign(v, { ciHmac, ciHmacKeyVersion });
        },
        insertConflictAttempt: async (c) => {
          s.conflicts.push({ ...c });
        },
        // 메모리 저장소는 계정 표를 보지 못한다(시험은 유스케이스의 앞선 확인으로 본다)
        lockAccountForShare: async () => null,
      });
      this.#state = s;
      return out;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  async attempt(id: string): Promise<Attempt | null> {
    const a = this.#state.attempts.get(id);
    return a ? { ...a } : null;
  }

  async isVerified(accountId: string): Promise<boolean> {
    return this.#state.verifications.has(accountId);
  }

  async claimsOf(accountId: string): Promise<{ pid: string; pidPrev?: string } | null> {
    const v = this.#state.verifications.get(accountId);
    if (!v) return null;
    return { pid: v.pid.toString('base64url'), ...(v.pidPrev ? { pidPrev: v.pidPrev.toString('base64url') } : {}) };
  }

  async recentlyReverified(accountId: string, sessionId: string, since: number): Promise<boolean> {
    return [...this.#state.attempts.values()].some(
      (a) => a.accountId === accountId && a.sessionId === sessionId && a.purpose === 'REVERIFY' && a.status === 'VERIFIED' && a.completedAt !== null && a.completedAt >= since,
    );
  }

  async purgeConflictAttempts(before: number): Promise<number> {
    const n = this.#state.conflicts.length;
    this.#state.conflicts = this.#state.conflicts.filter((c) => c.attemptedAt >= before);
    return n - this.#state.conflicts.length;
  }

  async ciKeyVersionsInUse(): Promise<number[]> {
    return [...new Set([...this.#state.verifications.values()].map((v) => v.ciHmacKeyVersion))].sort((a, b) => a - b);
  }

  // pid 키 전환
  async pidKeyVersionsInUse(): Promise<number[]> {
    return [...new Set([...this.#state.verifications.values()].map((v) => v.pidKeyVersion))].sort((a, b) => a - b);
  }

  async openPidRotation(): Promise<PidRotationRecord | null> {
    const r = this.#rotations.find((x) => x.finishedAt === null);
    return r ? { ...r } : null;
  }

  async beginPidRotation(r: { toVersion: number; startedAt: number; transitionEndsAt: number }): Promise<void> {
    if (this.#rotations.some((x) => x.finishedAt === null || x.toVersion === r.toVersion)) throw new Error('닫지 않은 전환이나 같은 판의 전환이 있다');
    this.#rotations.push({ ...r, movedAt: null, finishedAt: null });
  }

  async pidRowsToMove(version: number, after: string, limit: number): Promise<{ accountId: string; ciHmac: Buffer }[]> {
    return [...this.#state.verifications]
      .filter(([id, v]) => id > after && v.pidKeyVersion < version && v.pidPrev === null)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, limit)
      .map(([accountId, v]) => ({ accountId, ciHmac: v.ciHmac }));
  }

  /** 트랜잭션과 같은 줄에 세워 바꾼다(도는 트랜잭션이 끝나며 상태를 덮어쓰지 않게) */
  #serial<T>(fn: () => T): Promise<T> {
    const run = async () => fn();
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  movePid(accountId: string, pid: Buffer, version: number): Promise<boolean> {
    return this.#serial(() => {
      const v = this.#state.verifications.get(accountId);
      if (!v || v.pidKeyVersion >= version || v.pidPrev !== null) return false;
      Object.assign(v, { pidPrev: v.pid, pid, pidKeyVersion: version });
      return true;
    });
  }

  async pidRowsBelow(version: number): Promise<number> {
    return [...this.#state.verifications.values()].filter((v) => v.pidKeyVersion < version).length;
  }

  async markPidMoved(version: number, at: number): Promise<void> {
    const r = this.#rotations.find((x) => x.toVersion === version && x.finishedAt === null);
    if (r) r.movedAt = at;
  }

  clearPidPrev(limit: number): Promise<number> {
    return this.#serial(() => {
      const rows = [...this.#state.verifications.values()].filter((v) => v.pidPrev !== null).slice(0, limit);
      for (const v of rows) v.pidPrev = null;
      return rows.length;
    });
  }

  async finishPidRotation(version: number, at: number): Promise<void> {
    const r = this.#rotations.find((x) => x.toVersion === version && x.finishedAt === null);
    if (r) r.finishedAt = at;
  }

  eraseAccount(accountId: string, now: number): Promise<boolean> {
    return this.#serial(() => {
      const s = this.#state;
      let erased = false;
      const v = s.verifications.get(accountId);
      if (v) {
        if (plusOneYear(v.verifiedAt) > now && !this.#retention.has(accountId)) {
          this.#retention.set(accountId, { sourceRecord: v.sourceRecord, verifiedAt: v.verifiedAt, movedAt: now, deleteAt: plusOneYear(v.verifiedAt) });
        }
        s.verifications.delete(accountId);
        erased = true;
      }
      for (const [id, a] of s.attempts) {
        if (a.accountId === accountId && a.status !== 'UNDER_14') {
          s.attempts.delete(id);
          erased = true;
        }
      }
      return erased;
    });
  }

  async purgeVerificationRecords(now: number): Promise<number> {
    let n = 0;
    for (const [k, r] of this.#retention) {
      if (r.deleteAt <= now) {
        this.#retention.delete(k);
        n++;
      }
    }
    return n;
  }

  /** 시험이 보는 값: 보존 전용 표의 처리 기록 */
  retentionOf(accountId: string): RetainedRecord | null {
    const r = this.#retention.get(accountId);
    return r ? { ...r } : null;
  }

  /** 시험이 보는 값: 그 계정의 본인확인 건 */
  attemptsOf(accountId: string): Attempt[] {
    return [...this.#state.attempts.values()].filter((a) => a.accountId === accountId).map((a) => ({ ...a }));
  }

  /** 시험이 보는 값: 그 계정이 시도한 다른 계정 시도 기록 */
  async conflictAttempts(accountId: string): Promise<ConflictAttempt[]> {
    return this.#state.conflicts.filter((c) => c.attemptedAccountId === accountId).map((c) => ({ ...c }));
  }

  /** 시험이 보는 값: 그 계정의 본인확인 기록 */
  async recordOf(accountId: string): Promise<StoredVerification | null> {
    const v = this.#state.verifications.get(accountId);
    return v ? { ...v } : null;
  }
}
