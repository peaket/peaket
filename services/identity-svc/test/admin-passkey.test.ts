// 관리 계정 패스키와 재인증의 단위 시험(메모리 저장소·메모리 챌린지, docs/features/identity.md §6 '관리 계정 패스키의 첫 구현', BUILD_ORDER BOT-122).
// 같은 시험을 PostgreSQL·Valkey로 test-int/admin-passkey.int.test.ts가 돌린다.
import { fakeClock } from '@peaket/platform';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { MemoryPasskeyChallenges } from '../src/modules/admin/adapters/memory-passkey-challenges.js';
import { passkeyCases, relyingPartyCases } from './passkey-cases.js';

passkeyCases('메모리', async () => {
  const clock = fakeClock({ now: Date.parse('2026-11-05T09:00:00Z') });
  const store = new MemoryAdminAccountStore();
  return {
    store,
    clock,
    challenges: new MemoryPasskeyChallenges(),
    reauthRows: async (id) => store.reauthRecords(id).map((r) => ({ act: r.act, factors: [...r.factors], usedAt: r.usedAt, sessionId: r.sessionId })),
    notices: async (id) => store.notices(id),
  };
});

relyingPartyCases();
