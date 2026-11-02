// 메모리 저장소(시험·로컬 시제품용). PostgreSQL 저장소와 같은 규칙을 지킨다: 트랜잭션은 한 번에 하나씩 돌고(직렬),
// 실패하면 그 트랜잭션의 변경을 모두 되돌린다. 세션 종료 사건은 Outbox 대신 목록에 모은다.
import { uuidv7 } from '@peaket/platform';
import type { AccountRow, CreateKeyRecord, NewSession, RefreshRow, SessionRow, SessionStore, SessionTx } from '../domain/ports.js';
import { type ActiveSession, CREATE_KEY_TTL_MS, type Provider, sessionAlive, type TerminationReason } from '../domain/session.js';

type StoredSession = NewSession & { terminatedAt: number | null; prevRefreshHash: Uint8Array | null; rotatedAt: number | null; refreshUsed: boolean };

interface State {
  accounts: Map<string, AccountRow & { email: string | null; createdAt: number }>;
  providers: Map<string, { accountId: string; linkedAt: number }>;
  devices: Map<string, { id: string; accountId: string; ref: string; boundAt: number }>;
  sessions: Map<string, StoredSession>;
  keys: Map<string, CreateKeyRecord & { createdAt: number }>;
  hashes: Map<string, { sessionId: string; refreshFamily: string; expiresAt: number }>;
  events: Array<{ sessionId: string; accountId: string; reason: TerminationReason; at: number }>;
}

const empty = (): State => ({ accounts: new Map(), providers: new Map(), devices: new Map(), sessions: new Map(), keys: new Map(), hashes: new Map(), events: [] });
const copy = <K, V extends object>(m: Map<K, V>) => new Map([...m].map(([k, v]) => [k, { ...v }]));
const clone = (s: State): State => ({
  accounts: copy(s.accounts),
  providers: copy(s.providers),
  devices: copy(s.devices),
  sessions: copy(s.sessions),
  keys: copy(s.keys),
  hashes: copy(s.hashes),
  events: [...s.events],
});
const providerKey = (p: Provider, id: string) => `${p}\u0000${id}`;
const hex = (h: Uint8Array) => Buffer.from(h).toString('hex');
const row = (x: StoredSession): SessionRow => ({
  id: x.id,
  accountId: x.accountId,
  deviceId: x.deviceId,
  absoluteExpiresAt: x.absoluteExpiresAt,
  idleExpiresAt: x.idleExpiresAt,
  terminatedAt: x.terminatedAt,
  loginVerdict: x.loginVerdict,
  refreshFamily: x.refreshFamily,
});

export class MemorySessionStore implements SessionStore {
  #state = empty();
  #queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const work = clone(this.#state);
      const out = await fn(this.#tx(work));
      this.#state = work;
      return out;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  /** 시험이 저장된 세션을 들여다본다 */
  peekSession(id: string): StoredSession | undefined {
    return this.#state.sessions.get(id);
  }

  /** 끝나지 않은 그 계정의 세션 수 */
  activeCount(accountId: string): number {
    return [...this.#state.sessions.values()].filter((s) => s.accountId === accountId && s.terminatedAt === null).length;
  }

  deviceCount(accountId: string): number {
    return [...this.#state.devices.values()].filter((d) => d.accountId === accountId).length;
  }

  /** 그 계정의 세션 종료 사건(적힌 순서): [세션 ID, 사유] */
  terminations(accountId: string): Array<[string, string]> {
    return this.#state.events.filter((e) => e.accountId === accountId).map((e) => [e.sessionId, e.reason]);
  }

  #tx(s: State): SessionTx {
    return {
      lockCreateKey: async (key, now) => {
        const rec = s.keys.get(key);
        if (!rec) return null;
        if (now - rec.createdAt >= CREATE_KEY_TTL_MS) {
          s.keys.delete(key);
          return null;
        }
        return { provider: rec.provider, providerUserId: rec.providerUserId, sessionId: rec.sessionId, newAccount: rec.newAccount };
      },
      saveCreateKey: async (key, rec, now) => {
        s.keys.set(key, { ...rec, createdAt: now });
      },
      // 메모리 저장소의 트랜잭션은 한 번에 하나씩 돌아 따로 잠글 것이 없다
      lockProvider: async () => {},
      lockAccount: async () => {},
      findAccountByProvider: async (provider, providerUserId) => {
        const link = s.providers.get(providerKey(provider, providerUserId));
        const a = link && s.accounts.get(link.accountId);
        return a ? { id: a.id, status: a.status } : null;
      },
      createAccount: async ({ id, email }, now) => {
        s.accounts.set(id, { id, status: 'ACTIVE', email, createdAt: now });
      },
      linkProvider: async (accountId, provider, providerUserId, now) => {
        const k = providerKey(provider, providerUserId);
        if (s.providers.has(k)) throw new Error('account_provider (provider, provider_user_id) 중복');
        s.providers.set(k, { accountId, linkedAt: now });
      },
      isProviderLinked: async (accountId, provider, providerUserId) => s.providers.get(providerKey(provider, providerUserId))?.accountId === accountId,
      bindDevice: async (accountId, ref, now) => {
        const found = [...s.devices.values()].find((d) => d.accountId === accountId && d.ref === ref);
        if (found) return found.id;
        const id = uuidv7({ now: () => now, monotonicMs: () => 0 });
        s.devices.set(id, { id, accountId, ref, boundAt: now });
        return id;
      },
      activeSessions: async (accountId, now) =>
        [...s.sessions.values()]
          .filter((x) => x.accountId === accountId && sessionAlive(x, now))
          .map((x): ActiveSession => ({ sessionId: x.id, deviceId: x.deviceId, idleExpiresAt: x.idleExpiresAt })),
      terminateSessions: async (ids, reason, now) => {
        for (const id of ids) {
          const x = s.sessions.get(id);
          if (x && x.terminatedAt === null) {
            x.terminatedAt = now;
            s.events.push({ sessionId: x.id, accountId: x.accountId, reason, at: now });
          }
        }
      },
      insertSession: async (r) => {
        s.sessions.set(r.id, { ...r, terminatedAt: null, prevRefreshHash: null, rotatedAt: null, refreshUsed: false });
      },
      getSessionForUpdate: async (id) => {
        const x = s.sessions.get(id.toLowerCase());
        return x ? row(x) : null;
      },
      setRefreshHash: async (sessionId, hash) => {
        const x = s.sessions.get(sessionId);
        if (x) x.refreshHash = hash;
      },
      rotateRefresh: async (sessionId, hash, now, idleExpiresAt) => {
        const x = s.sessions.get(sessionId);
        if (!x) return;
        x.prevRefreshHash = x.refreshHash;
        x.refreshHash = hash;
        x.rotatedAt = now;
        x.refreshUsed = false;
        x.idleExpiresAt = idleExpiresAt;
      },
      recordRefreshHash: async (r) => {
        s.hashes.set(hex(r.hash), { sessionId: r.sessionId, refreshFamily: r.refreshFamily, expiresAt: r.expiresAt });
      },
      findByRefreshHash: async (hash): Promise<RefreshRow | null> => {
        const h = hex(hash);
        for (const x of s.sessions.values()) {
          if (hex(x.refreshHash) === h) return { ...row(x), match: 'current', rotatedAt: x.rotatedAt, refreshUsed: x.refreshUsed };
          if (x.prevRefreshHash && hex(x.prevRefreshHash) === h) return { ...row(x), match: 'previous', rotatedAt: x.rotatedAt, refreshUsed: x.refreshUsed };
        }
        const past = s.hashes.get(h);
        const x = past && s.sessions.get(past.sessionId);
        return x ? { ...row(x), match: 'history', rotatedAt: x.rotatedAt, refreshUsed: x.refreshUsed } : null;
      },
      familySessions: async (refreshFamily) => [...s.sessions.values()].filter((x) => x.refreshFamily === refreshFamily && x.terminatedAt === null).map((x) => x.id),
    };
  }
}
