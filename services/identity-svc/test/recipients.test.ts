// BAT-455 N-T24: identity-svc RecipientQueryService.BatchGetRecipients(받는 사람 묶음 조회).
import { describe, expect, test } from 'vitest';
import { GetRecipients } from '../src/modules/session/application/get-recipients.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';

const NOW = Date.parse('2026-11-05T00:00:00.000Z');

describe('N-T24 받는 사람 묶음 조회', () => {
  test('N-T24 ① 상태·본인확인·언어를 주고 이메일은 요청할 때만 준다', async () => {
    const store = new MemorySessionStore();
    const a = '01900000-0000-7000-8000-000000000001';
    const b = '01900000-0000-7000-8000-000000000002';
    const merged = '01900000-0000-7000-8000-000000000003';
    await store.transaction((tx) => tx.createAccount({ id: a, email: 'a@example.com', emailVerified: true }, NOW));
    store.markVerified(a);
    await store.transaction((tx) => tx.createAccount({ id: b, email: 'b@example.com', emailVerified: false }, NOW));
    await store.transaction((tx) => tx.createAccount({ id: merged, email: 'm@example.com', emailVerified: true }, NOW));
    await store.transaction((tx) =>
      tx.mergeAccounts({ mergeId: 'm1', primaryAccountId: a, absorbedAccountId: merged, mergedProvider: 'google', moved: {}, requestedAt: NOW - 1000, now: NOW }),
    );

    const get = new GetRecipients(store);
    const withEmail = await get.run({ accountIds: [a, b, merged, '01900000-0000-7000-8000-000000000099'], includeEmail: true });
    expect(withEmail.map((r) => r.accountId)).toEqual([a, b, merged, '01900000-0000-7000-8000-000000000099']);
    expect(withEmail[0]).toMatchObject({ status: 'ACTIVE', verified: true, locale: 'ko', email: 'a@example.com' });
    expect(withEmail[1]).toMatchObject({ status: 'ACTIVE', verified: false, locale: 'ko', email: 'b@example.com' });
    expect(withEmail[2]).toMatchObject({ status: 'MERGED', email: null });
    expect(withEmail[3]).toMatchObject({ status: 'NOT_FOUND', email: null });

    const noEmail = await get.run({ accountIds: [a], includeEmail: false });
    expect(noEmail[0]!.email).toBeUndefined();
  });

  test('N-T24 ② 500개를 넘으면 INVALID이고 빈 목록은 빈 응답이다', async () => {
    const get = new GetRecipients(new MemorySessionStore());
    expect(await get.run({ accountIds: [], includeEmail: false })).toEqual([]);
    await expect(get.run({ accountIds: Array.from({ length: 501 }, (_, i) => `id-${i}`), includeEmail: false })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
