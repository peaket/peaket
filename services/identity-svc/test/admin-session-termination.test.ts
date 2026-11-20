// 관리 계정 세션 강제 종료(I-T61 ①~④, ASVS 7.4.5, BUILD_ORDER BOT-152, ADR-0322·0143).
// AdminSessionService.TerminateAdminSessions: request_id 멱등, 계정의 모든 세션 또는 하나, 다른 계정·없는 세션 404,
// 이미 끝난 세션은 204(already_done, ended_count 0), 세션마다 control.sessions-terminated(reason ADMIN_FORCE), 계정 상태 불변.
// 끝낸 세션의 액세스 토큰은 GetAdminAuthz(가드가 요청마다 부르는 판정)에서 401(valid false)이다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { AdminAccountInputError, AdminAccountNotFound } from '../src/modules/admin/application/manage-admin-accounts.js';
import { TerminateAdminSessions } from '../src/modules/admin/application/terminate-admin-sessions.js';
import { GetAdminAuthz } from '../src/modules/admin/application/get-admin-authz.js';
import { adminSessionHandlers } from '../src/modules/admin/inbound/admin-session.grpc.js';

const H = 60 * 60_000;
const CMD = '0190f3a1-7c2e-7a00-8000-00000000e001';
const OTHER = '0190f3a1-7c2e-7a00-8000-00000000e002';
const GONE = '0190f3a1-7c2e-7a00-8000-00000000e0ff';
let n = 0;
const sid = () => `0190f3a1-7c2e-7a00-8000-${String(700000 + ++n).padStart(12, '0')}`;

function harness() {
  const clock = fakeClock({ now: Date.parse('2026-11-20T09:00:00Z') });
  const store = new MemoryAdminAccountStore();
  store.create({ id: CMD, role: 'commander', email: 'cmd@peaket.example', status: 'ACTIVE', now: clock.now() });
  store.create({ id: OTHER, role: 'operator', email: 'other@peaket.example', status: 'ACTIVE', now: clock.now() });
  const live = (accountId: string, aud: 'ops' | 'partner' = 'ops') => {
    const id = sid();
    return store
      .createSession({ id, accountId, aud, refreshHash: Buffer.alloc(32, 1), refreshFamily: `f-${id}`, pairRef: 'p', createdAt: clock.now(), absoluteExpiresAt: clock.now() + 24 * H, idleExpiresAt: clock.now() + H }, 5)
      .then(() => id);
  };
  const guard = new GetAdminAuthz(store, store, clock);
  const terminate = new TerminateAdminSessions(store, clock);
  const rid = () => `term-${++n}`;
  return { clock, store, terminate, guard, live, rid };
}

describe('관리 세션 강제 종료(I-T61)', () => {
  test('I-T61 ① [ASVS v5.0.0-7.4.5] 계정의 모든 세션을 끝내면 204·ended_count가 맞고 그 세션의 액세스 토큰이 가드에서 401이며 세션마다 ADMIN_FORCE 사건이 남는다', async () => {
    const t = harness();
    const sessions = [await t.live(CMD), await t.live(CMD), await t.live(CMD)];
    const keepOther = await t.live(OTHER);
    const out = await t.terminate.execute({ requestId: t.rid(), actedBy: OTHER, adminAccountId: CMD });
    expect(out).toEqual({ endedCount: 3, alreadyDone: false });
    for (const sessionId of sessions) expect(await t.guard.getAdminAuthz({ adminAccountId: CMD, sessionId })).toMatchObject({ valid: false });
    expect(await t.guard.getAdminAuthz({ adminAccountId: OTHER, sessionId: keepOther })).toMatchObject({ valid: true, role: 'operator' });
    const events = t.store.terminatedEvents().filter((e) => e.accountId === CMD);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.sessionId))).toEqual(new Set(sessions));
    for (const e of events) expect(e.reason).toBe('ADMIN_FORCE');
    // 계정 상태는 바꾸지 않는다
    expect(t.store.peek(CMD)).toMatchObject({ status: 'ACTIVE', role: 'commander' });
  });

  test('I-T61 ② [ASVS v5.0.0-7.4.5] 세션 하나만 끝내면 그 세션만 401이고 다른 세션은 살아 있다', async () => {
    const t = harness();
    const a = await t.live(CMD);
    const b = await t.live(CMD);
    const out = await t.terminate.execute({ requestId: t.rid(), actedBy: OTHER, adminAccountId: CMD, sessionId: b });
    expect(out).toEqual({ endedCount: 1, alreadyDone: false });
    expect(await t.guard.getAdminAuthz({ adminAccountId: CMD, sessionId: b })).toMatchObject({ valid: false });
    expect(await t.guard.getAdminAuthz({ adminAccountId: CMD, sessionId: a })).toMatchObject({ valid: true, role: 'commander' });
    expect(t.store.terminatedEvents().filter((e) => e.accountId === CMD)).toEqual([{ accountId: CMD, sessionId: b, reason: 'ADMIN_FORCE' }]);
  });

  test('I-T61 ③ [ASVS v5.0.0-7.4.5] 다른 계정의 세션 ID·없는 세션은 404이고, 이미 끝난 세션은 204 already_done이며, 같은 request_id는 다시 처리하지 않는다', async () => {
    const t = harness();
    const mine = await t.live(CMD);
    const theirs = await t.live(OTHER);
    await expect(t.terminate.execute({ requestId: t.rid(), actedBy: OTHER, adminAccountId: CMD, sessionId: theirs })).rejects.toBeInstanceOf(AdminAccountNotFound);
    await expect(t.terminate.execute({ requestId: t.rid(), actedBy: OTHER, adminAccountId: CMD, sessionId: GONE })).rejects.toBeInstanceOf(AdminAccountNotFound);
    await expect(t.terminate.execute({ requestId: t.rid(), actedBy: OTHER, adminAccountId: GONE })).rejects.toBeInstanceOf(AdminAccountNotFound);
    expect(await t.guard.getAdminAuthz({ adminAccountId: OTHER, sessionId: theirs })).toMatchObject({ valid: true });
    // 하나를 끝내고 같은 요청을 다시 보내면 already_done
    const requestId = t.rid();
    expect(await t.terminate.execute({ requestId, actedBy: OTHER, adminAccountId: CMD, sessionId: mine })).toEqual({ endedCount: 1, alreadyDone: false });
    expect(await t.terminate.execute({ requestId, actedBy: OTHER, adminAccountId: CMD, sessionId: mine })).toEqual({ endedCount: 0, alreadyDone: true });
    // 이미 끝난 세션에 새 request_id로 다시 보내면 204(ended_count 0)
    expect(await t.terminate.execute({ requestId: t.rid(), actedBy: OTHER, adminAccountId: CMD, sessionId: mine })).toEqual({ endedCount: 0, alreadyDone: false });
    // 같은 request_id를 다른 호출(다른 계정)에 쓰면 INVALID_ARGUMENT
    await expect(t.terminate.execute({ requestId, actedBy: OTHER, adminAccountId: OTHER })).rejects.toBeInstanceOf(AdminAccountInputError);
  });

  test('I-T61 ③ gRPC 받는 층은 정상이면 ended_count·already_done을, 없는 계정·남의 세션이면 NOT_FOUND를, 꼴 오류면 INVALID_ARGUMENT를 돌려준다', async () => {
    const t = harness();
    const s = await t.live(CMD);
    const handlers = adminSessionHandlers({ terminate: t.terminate }, () => undefined);
    const call = (request: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        (handlers.TerminateAdminSessions as unknown as (c: unknown, cb: (e: unknown, v?: Record<string, unknown>) => void) => void)(
          { request },
          (e, v) => (e ? reject(e) : resolve(v ?? {})),
        );
      });
    const status = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'OK';
      } catch (e) {
        return String((e as { code?: unknown }).code);
      }
    };
    expect(await call({ request_id: 'grpc-1', acted_by: OTHER, admin_account_id: CMD, session_id: s })).toEqual({ ended_count: 1, already_done: false });
    expect(await status(call({ request_id: 'grpc-2', acted_by: OTHER, admin_account_id: GONE }))).toBe('5');
    expect(await status(call({ request_id: 'grpc-3', acted_by: OTHER, admin_account_id: CMD, session_id: 'not-a-uuid' }))).toBe('3');
  });
});
