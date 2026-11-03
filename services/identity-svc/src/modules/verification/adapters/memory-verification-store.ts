// 메모리 저장소(시험·로컬 시제품용). 트랜잭션은 한 번에 하나씩 돌고 실패하면 되돌린다(PostgreSQL 저장소와 같은 규칙).
import type { VerificationStore, VerificationTx } from '../domain/ports.js';
import type { Attempt } from '../domain/verification.js';

interface Record {
  ciHmac: Buffer;
  pid: Buffer;
}

interface State {
  attempts: Map<string, Attempt>;
  verifications: Map<string, Record>;
}

const clone = (s: State): State => ({ attempts: new Map([...s.attempts].map(([k, v]) => [k, { ...v }])), verifications: new Map(s.verifications) });

export class MemoryVerificationStore implements VerificationStore {
  #state: State = { attempts: new Map(), verifications: new Map() };
  #queue: Promise<unknown> = Promise.resolve();

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
        verificationOf: async (accountId) => s.verifications.get(accountId) ?? null,
        accountByCiHmac: async (h) => [...s.verifications].find(([, v]) => v.ciHmac.equals(h))?.[0] ?? null,
        saveVerification: async (v) => {
          s.verifications.set(v.accountId, { ciHmac: v.ciHmac, pid: v.pid });
        },
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

  async claimsOf(accountId: string): Promise<{ pid: string } | null> {
    const v = this.#state.verifications.get(accountId);
    return v ? { pid: v.pid.toString('base64url') } : null;
  }
}
