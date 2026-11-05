// 메모리 저장소(시험·로컬 시제품용). PostgreSQL 저장소와 같은 규칙을 지킨다: 트랜잭션은 한 번에 하나씩 돌고(직렬),
// 실패하면 그 트랜잭션의 변경을 모두 되돌린다. 세션 종료 사건은 Outbox 대신 목록에 모은다.
import { randomUUID } from 'node:crypto';
import { type OutboxMessage, uuidv7 } from '@peaket/platform';
import type { AccountRow, ContactKind, CreateKeyRecord, InvestigationRefsRow, NewSession, RefreshRow, SessionRow, SessionStore, SessionTx } from '../domain/ports.js';
import { nextRefPrev } from '../domain/inv-ref.js';
import { type ActiveSession, CREATE_KEY_TTL_MS, normalizeEmail, type Provider, sessionAlive, type TerminationReason } from '../domain/session.js';
import { accountWithdrawnMessage } from './account-withdrawn-message.js';
import { loginMethodChangedMessage } from './login-method-message.js';
import { accountMergedMessage } from './account-merged-message.js';

type StoredAccount = AccountRow & { email: string | null; emailVerified: boolean; mergedInto?: string; createdAt: number; closureReason?: string; closureStartedAt?: number; deletedAt?: number };

type StoredSession = NewSession & { terminatedAt: number | null; prevRefreshHash: Uint8Array | null; rotatedAt: number | null; refreshUsed: boolean };

interface State {
  accounts: Map<string, StoredAccount>;
  providers: Map<string, { accountId: string; linkedAt: number; lastLoginAt: number | null }>;
  devices: Map<string, { id: string; accountId: string; ref: string; prevRef?: string | null; boundAt: number }>;
  sessions: Map<string, StoredSession>;
  keys: Map<string, CreateKeyRecord & { createdAt: number }>;
  hashes: Map<string, { sessionId: string; refreshFamily: string; expiresAt: number }>;
  events: Array<{ sessionId: string; accountId: string; reason: TerminationReason; at: number }>;
  reauthUses: Map<string, { accountId: string; usedAt: number; expiresAt: number }>;
  /** 트랜잭션이 Outbox에 적었을 사건(탈퇴 BOT-037, 로그인 수단 연결·해제 BOT-041). 시험이 읽는다 */
  outbox: OutboxMessage[];
  holds: Map<string, { accountId: string; kind: string; state: 'OPEN' | 'CLOSED'; sourceVersion: number; updatedAt: number }>;
  merges: Map<string, { primaryAccountId: string; mergedAccountId: string; mergedProvider: string; moved: Record<string, number>; requestedAt: number; confirmedAt: number }>;
  /** 조사용 연락처 가명(account_contact_ref, BOT-045). 키는 계정 ID|종류 */
  contacts: Map<string, { accountId: string; kind: ContactKind; ref: string; refPrev?: string | null; updatedAt: number }>;
}

const empty = (): State => ({ accounts: new Map(), providers: new Map(), devices: new Map(), sessions: new Map(), keys: new Map(), hashes: new Map(), events: [], reauthUses: new Map(), outbox: [], holds: new Map(), merges: new Map(), contacts: new Map() });
const copy = <K, V extends object>(m: Map<K, V>) => new Map([...m].map(([k, v]) => [k, { ...v }]));
const clone = (s: State): State => ({
  accounts: copy(s.accounts),
  providers: copy(s.providers),
  devices: copy(s.devices),
  sessions: copy(s.sessions),
  keys: copy(s.keys),
  hashes: copy(s.hashes),
  events: [...s.events],
  reauthUses: copy(s.reauthUses),
  outbox: [...s.outbox],
  holds: copy(s.holds),
  merges: copy(s.merges),
  contacts: copy(s.contacts),
});
const KIND_ORDER: readonly ContactKind[] = ['PHONE', 'EMAIL'];
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

  /** 시험용: 그 계정의 기기 가명(묶은 순) */
  devicesOf(accountId: string): string[] {
    return [...this.#state.devices.values()]
      .filter((d) => d.accountId === accountId)
      .sort((a, b) => a.boundAt - b.boundAt)
      .map((d) => d.ref);
  }

  /** 시험용: 그 계정 기기 행의 옛 판 대응(묶은 순, 있는 것만) */
  devicePrevsOf(accountId: string): string[] {
    return [...this.#state.devices.values()]
      .filter((d) => d.accountId === accountId && d.prevRef)
      .sort((a, b) => a.boundAt - b.boundAt)
      .map((d) => d.prevRef!);
  }

  /** 시험용: 그 계정의 연락처 행(옛 판 값 포함) */
  contactRowsOf(accountId: string): { kind: ContactKind; ref: string; refPrev: string | null }[] {
    return [...this.#state.contacts.values()]
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
      .map((c) => ({ kind: c.kind, ref: c.ref, refPrev: c.refPrev ?? null }));
  }

  async contactRefsToRotate(after: string, writePrefix: string, limit: number): Promise<{ accountId: string; email: string; ref: string }[]> {
    return this.#serial(() =>
      [...this.#state.contacts.values()]
        .filter((c) => c.kind === 'EMAIL' && !c.ref.startsWith(writePrefix) && c.accountId > after)
        .map((c) => ({ c, a: this.#state.accounts.get(c.accountId) }))
        .filter((x) => x.a?.status === 'ACTIVE' && x.a.email)
        .sort((x, y) => (x.c.accountId < y.c.accountId ? -1 : 1))
        .slice(0, limit)
        .map((x) => ({ accountId: x.c.accountId, email: x.a!.email!, ref: x.c.ref })),
    );
  }

  async closeInvRefBridge(label: 'device' | 'contact', prevPrefix: string, _chunk?: number): Promise<{ cleared: number; removed: number }> {
    return this.#serial(() => {
      let cleared = 0;
      let removed = 0;
      if (label === 'device') {
        for (const [k, d] of this.#state.devices) {
          if (d.prevRef) {
            cleared++;
            this.#state.devices.set(k, { ...d, prevRef: null });
          } else if (d.ref.startsWith(prevPrefix)) {
            removed++;
            this.#state.devices.delete(k);
          }
        }
      } else {
        for (const [k, c] of this.#state.contacts) {
          if (c.refPrev) {
            cleared++;
            this.#state.contacts.set(k, { ...c, refPrev: null });
          }
        }
      }
      return { cleared, removed };
    });
  }

  /** 시험용: 그 계정의 연락처 가명(PHONE, EMAIL 순) */
  contactRefsOf(accountId: string): { kind: ContactKind; ref: string }[] {
    return [...this.#state.contacts.values()]
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
      .map((c) => ({ kind: c.kind, ref: c.ref }));
  }

  async investigationRefsOf(accountIds: readonly string[], _since?: number): Promise<InvestigationRefsRow[]> {
    return this.#serial(() =>
      accountIds.flatMap((id) => {
        const a = this.#state.accounts.get(id);
        if (!a) return [];
        // 같은 본인확인 시도 기록은 본인확인 컨텍스트의 표라 메모리 저장소는 보지 못한다(빈 목록)
        // 키 회전의 이음 동안 남은 옛 판 값도 함께 싣는다(BOT-046)
        const contactRefs = this.contactRowsOf(id).flatMap((c) => [{ kind: c.kind, ref: c.ref }, ...(c.refPrev ? [{ kind: c.kind, ref: c.refPrev }] : [])]);
        return [{ accountId: id, contactRefs, deviceRefs: [...this.devicesOf(id), ...this.devicePrevsOf(id)], identityConflicts: [] }];
      }),
    );
  }

  async accountsMissingEmailRef(after: string, limit: number): Promise<{ accountId: string; email: string }[]> {
    return this.#serial(() =>
      [...this.#state.accounts.values()]
        .filter((a) => a.status === 'ACTIVE' && a.email && a.id > after && !this.#state.contacts.has(`${a.id}|EMAIL`))
        .sort((x, y) => (x.id < y.id ? -1 : 1))
        .slice(0, limit)
        .map((a) => ({ accountId: a.id, email: a.email! })),
    );
  }

  /** 시험용: 계정 수 */
  accountCount(): number {
    return this.#state.accounts.size;
  }

  /** 시험용: 로그인 수단 없이 그 이메일의 ACTIVE 계정을 만든다(같은 이메일 계정이 여럿인 경우) */
  forceCreate(email: string, emailVerified: boolean): string {
    const id = uuidv7({ now: () => Date.now(), monotonicMs: () => 0 });
    this.#state.accounts.set(id, { id, status: 'ACTIVE', email, emailVerified, createdAt: 0 });
    return id;
  }

  /** 시험용: 계정 상태를 바꾼다 */
  setStatus(id: string, status: AccountRow['status']): void {
    const a = this.#state.accounts.get(id);
    if (a) a.status = status;
  }

  /** 시험이 보는 계정 행 */
  accountOf(id: string): StoredAccount | undefined {
    const a = this.#state.accounts.get(id);
    return a ? { ...a } : undefined;
  }

  providerCount(accountId: string): number {
    return [...this.#state.providers.values()].filter((p) => p.accountId === accountId).length;
  }

  /** 그 계정 세션들의 리프레시 토큰 해시 줄 수 */
  refreshHashCount(accountId: string): number {
    return [...this.#state.hashes.values()].filter((h) => this.#state.sessions.get(h.sessionId)?.accountId === accountId).length;
  }

  async purgeExpiredRefreshHashes(now: number): Promise<number> {
    return this.#serial(() => {
      let n = 0;
      for (const [k, h] of this.#state.hashes) {
        const x = this.#state.sessions.get(h.sessionId);
        if (h.expiresAt <= now || !x || !sessionAlive(x, now)) {
          this.#state.hashes.delete(k);
          n++;
        }
      }
      return n;
    });
  }

  async refreshOwner(hash: Uint8Array): Promise<string | null> {
    return this.#serial(() => {
      const h = hex(hash);
      for (const x of this.#state.sessions.values()) if (hex(x.refreshHash) === h || (x.prevRefreshHash && hex(x.prevRefreshHash) === h)) return x.accountId;
      return null;
    });
  }

  async sessionOf(id: string): Promise<SessionRow | null> {
    return this.#serial(() => {
      const x = this.#state.sessions.get(id.toLowerCase());
      return x ? row(x) : null;
    });
  }

  async purgeReauthUses(now: number): Promise<number> {
    return this.#serial(() => {
      let n = 0;
      for (const [k, u] of this.#state.reauthUses) {
        if (u.expiresAt <= now) {
          this.#state.reauthUses.delete(k);
          n++;
        }
      }
      return n;
    });
  }

  /** 트랜잭션과 같은 줄에 세워 바꾼다 */
  #serial<T>(fn: () => T): Promise<T> {
    const run = async () => fn();
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  /** 적힌 탈퇴 사건(BOT-037, 시험용) */
  withdrawnMessages(): OutboxMessage[] {
    return this.#state.outbox.filter((m) => m.topic === 'identity.accounts-withdrawn');
  }

  /** 남긴 병합 이력(시험용) */
  mergesOf(primaryAccountId: string): { mergedAccountId: string; mergedProvider: string; moved: Record<string, number> }[] {
    return [...this.#state.merges.values()].filter((m) => m.primaryAccountId === primaryAccountId).map((m) => ({ mergedAccountId: m.mergedAccountId, mergedProvider: m.mergedProvider, moved: m.moved }));
  }

  /** 적힌 모든 사건(시험용) */
  outboxMessages(): OutboxMessage[] {
    return [...this.#state.outbox];
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
      createAccount: async ({ id, email, emailVerified }, now) => {
        s.accounts.set(id, { id, status: 'ACTIVE', email, emailVerified: emailVerified === true, createdAt: now });
      },
      findLinkTargets: async (email) =>
        [...s.accounts.values()]
          .filter((a) => a.status === 'ACTIVE' && a.emailVerified && a.email !== null && normalizeEmail(a.email) === email)
          .sort((x, y) => (x.id < y.id ? -1 : 1))
          .slice(0, 2)
          .map((a) => ({
            accountId: a.id,
            providers: [...s.providers]
              .filter(([, v]) => v.accountId === a.id)
              .sort(([ka, a1], [kb, b1]) => a1.linkedAt - b1.linkedAt || (ka < kb ? -1 : 1))
              .map(([k]) => k.split('\u0000')[0] as Provider),
          })),
      linkProvider: async (accountId, provider, providerUserId, now) => {
        const k = providerKey(provider, providerUserId);
        if (s.providers.has(k)) throw new Error('account_provider (provider, provider_user_id) 중복');
        s.providers.set(k, { accountId, linkedAt: now, lastLoginAt: null });
      },
      isProviderLinked: async (accountId, provider, providerUserId) => s.providers.get(providerKey(provider, providerUserId))?.accountId === accountId,
      providersOf: async (accountId) =>
        [...s.providers]
          .filter(([, v]) => v.accountId === accountId)
          .map(([k, v]) => ({ provider: k.split('\u0000')[0] as Provider, linkedAt: v.linkedAt, lastLoginAt: v.lastLoginAt }))
          .sort((a, b) => a.linkedAt - b.linkedAt),
      touchProviderLogin: async (provider, providerUserId, now) => {
        const v = s.providers.get(providerKey(provider, providerUserId));
        if (v) v.lastLoginAt = now;
      },
      unlinkProvider: async (accountId, provider) => {
        let n = 0;
        for (const [k, v] of s.providers)
          if (v.accountId === accountId && k.split('\u0000')[0] === provider) {
            s.providers.delete(k);
            n++;
          }
        return n;
      },
      openHoldsOf: async (accountId) => [...s.holds.values()].filter((h) => h.accountId === accountId && h.state === 'OPEN').length,
      setAccountHold: async (i) => {
        const h = s.holds.get(i.sourceRef);
        if (h && (h.accountId !== i.accountId || h.kind !== i.kind)) return 'CONFLICT';
        if (h && i.sourceVersion <= h.sourceVersion) return 'STALE';
        s.holds.set(i.sourceRef, { accountId: i.accountId, kind: i.kind, state: i.state, sourceVersion: i.sourceVersion, updatedAt: i.now });
        return 'APPLIED';
      },
      purgeClosedHolds: async (before) => {
        let n = 0;
        for (const [k, h] of s.holds)
          if (h.state === 'CLOSED' && h.updatedAt < before) {
            s.holds.delete(k);
            n++;
          }
        return n;
      },
      mergeAccounts: async (i) => {
        for (const [k, v] of s.providers) if (v.accountId === i.absorbedAccountId) s.providers.set(k, { ...v, accountId: i.primaryAccountId });
        const a = s.accounts.get(i.absorbedAccountId);
        if (a) s.accounts.set(i.absorbedAccountId, { ...a, status: 'MERGED', mergedInto: i.primaryAccountId, email: null, emailVerified: false });
        for (const [k, x] of s.accounts) if (x.mergedInto === i.absorbedAccountId) s.accounts.set(k, { ...x, mergedInto: i.primaryAccountId });
        // 흡수 계정의 프로필은 파기한다: 연락처 가명 행도 지운다(BOT-045)
        for (const [k, c] of s.contacts) if (c.accountId === i.absorbedAccountId) s.contacts.delete(k);
        s.merges.set(i.mergeId, { primaryAccountId: i.primaryAccountId, mergedAccountId: i.absorbedAccountId, mergedProvider: i.mergedProvider, moved: i.moved, requestedAt: i.requestedAt, confirmedAt: i.now });
      },
      recordAccountMerged: async (i) => {
        s.outbox.push(accountMergedMessage(i));
      },
      recordLoginMethodChanged: async (i) => {
        s.outbox.push(loginMethodChangedMessage({ eventKey: randomUUID(), ...i }));
      },
      bindDevice: async (accountId, ref, now, prevRef) => {
        const found = [...s.devices.values()].find((d) => d.accountId === accountId && d.ref === ref);
        if (found) return found.id;
        // 키 회전의 이음: 옛 판 값의 행이 있으면 새 판 값으로 바꾼다(새 기기로 세지 않는다, BOT-046)
        const old = prevRef ? [...s.devices.values()].find((d) => d.accountId === accountId && d.ref === prevRef) : undefined;
        if (old) {
          s.devices.set(old.id, { ...old, ref, prevRef });
          return old.id;
        }
        const id = uuidv7({ now: () => now, monotonicMs: () => 0 });
        s.devices.set(id, { id, accountId, ref, prevRef: prevRef ?? null, boundAt: now });
        return id;
      },
      activeSessions: async (accountId, now) =>
        [...s.sessions.values()]
          .filter((x) => x.accountId === accountId && sessionAlive(x, now))
          .map((x): ActiveSession => ({ sessionId: x.id, deviceId: x.deviceId, idleExpiresAt: x.idleExpiresAt })),
      unterminatedSessions: async (accountId) => [...s.sessions.values()].filter((x) => x.accountId === accountId && x.terminatedAt === null).map((x) => x.id),
      closureReasonOf: async (accountId) => {
        const a = s.accounts.get(accountId);
        return a && a.status === 'WITHDRAWAL_PENDING' && a.closureReason === 'UNDER_14' ? 'UNDER_14' : null;
      },
      markClosure: async (accountId, reason, now) => {
        const a = s.accounts.get(accountId);
        if (a && a.status === 'ACTIVE') Object.assign(a, { status: 'WITHDRAWAL_PENDING', closureReason: reason, closureStartedAt: now });
      },
      accountStatusOf: async (accountId) => s.accounts.get(accountId)?.status ?? null,
      eraseAccount: async (accountId, now) => {
        const a = s.accounts.get(accountId);
        if (!a) return;
        s.accounts.set(accountId, { id: a.id, status: 'DELETED', email: null, emailVerified: false, createdAt: a.createdAt, deletedAt: now });
        for (const [k, p] of s.providers) if (p.accountId === accountId) s.providers.delete(k);
        for (const [k, d] of s.devices) if (d.accountId === accountId) s.devices.delete(k);
        for (const [k, c] of s.keys) if (s.sessions.get(c.sessionId)?.accountId === accountId) s.keys.delete(k);
        // 대표 계정이 탈퇴하면 그 계정의 병합 이력도 지운다(data-classification '계정 연결 및 병합 감사 원장', 새 맥락 리뷰 중간 6)
        const chain = new Set([accountId, ...[...s.accounts.values()].filter((x) => x.mergedInto === accountId).map((x) => x.id)]);
        for (const [k, m] of s.merges) if (chain.has(m.primaryAccountId)) s.merges.delete(k);
        for (const [k, c] of s.contacts) if (c.accountId === accountId) s.contacts.delete(k);
      },
      closuresStartedBefore: async (before, limit) =>
        [...s.accounts.values()]
          .filter((a) => a.status === 'WITHDRAWAL_PENDING' && a.closureReason === 'UNDER_14' && a.closureStartedAt !== undefined && a.closureStartedAt <= before)
          .slice(0, limit)
          .map((a) => a.id),
      deletedSince: async (since, after, limit) =>
        [...s.accounts.values()]
          .filter((a) => a.status === 'DELETED' && a.deletedAt !== undefined && a.deletedAt > since && a.id > after)
          .map((a) => a.id)
          .sort()
          .slice(0, limit),
      // 메모리 세션 저장소는 보관 표를 보지 못한다(시험은 유스케이스의 앞선 확인으로 본다)
      activeHoldOf: async () => null,
      setContactRef: async (i) => {
        const k = `${i.accountId}|${i.kind}`;
        const cur = s.contacts.get(k);
        s.contacts.set(k, { accountId: i.accountId, kind: i.kind, ref: i.ref, refPrev: nextRefPrev(cur && { ref: cur.ref, refPrev: cur.refPrev ?? null }, i.ref, i.refPrev), updatedAt: i.now });
      },
      verifiedOf: async () => null,
      useReauth: async (r) => {
        if (s.reauthUses.has(r.jti)) return false;
        s.reauthUses.set(r.jti, { accountId: r.accountId, usedAt: r.usedAt, expiresAt: r.expiresAt });
        return true;
      },
      terminateSessions: async (ids, reason, now) => {
        for (const id of ids) {
          const x = s.sessions.get(id);
          if (x && x.terminatedAt === null) {
            x.terminatedAt = now;
            s.events.push({ sessionId: x.id, accountId: x.accountId, reason, at: now });
          }
          // 끝난 세션의 리프레시 토큰 해시는 같은 트랜잭션에서 지운다(R-255)
          for (const [k, h] of s.hashes) if (h.sessionId === id) s.hashes.delete(k);
        }
      },
      recordWithdrawn: async (i) => {
        s.outbox.push(accountWithdrawnMessage({ eventKey: randomUUID(), ...i }));
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
