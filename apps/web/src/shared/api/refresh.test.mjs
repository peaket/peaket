// 팬 요청 401 → 갱신 한 번 → 다시 한 번(docs/frontend.md §4.1 '401', ADR-0199 결정 3, BUILD_ORDER HOT-300)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isRefreshUnavailableError, isUnauthorizedError, problemName, refreshUnavailableError, retryOnceAfterRefresh } from './refresh.ts';

const unauthorized = Object.assign(new Error('401'), { status: 401 });
const is401 = (e) => e?.status === 401;

test('401이면 갱신 뒤 한 번 더 보내 성공한다', async () => {
  let calls = 0;
  let refreshed = 0;
  const r = await retryOnceAfterRefresh(
    async () => {
      calls += 1;
      if (calls === 1) throw unauthorized;
      return 'ok';
    },
    is401,
    async () => {
      refreshed += 1;
      return 'ok';
    },
  );
  assert.equal(r, 'ok');
  assert.deepEqual([calls, refreshed], [2, 1]);
});

test('갱신이 401로 거절되면 다시 보내지 않고 401을 던진다(비로그인)', async () => {
  let calls = 0;
  await assert.rejects(
    retryOnceAfterRefresh(
      async () => {
        calls += 1;
        throw unauthorized;
      },
      is401,
      async () => 'rejected',
    ),
    (e) => e === unauthorized,
  );
  assert.equal(calls, 1);
});

test('갱신이 일시 장애(연결 끊김·5xx)면 다시 보내지 않고 401이 아닌 오류를 던진다: 화면이 비로그인으로 바꾸지 않고 잠시 뒤 다시를 보인다(docs/frontend.md §4.1, 새 맥락 재검토)', async () => {
  let calls = 0;
  await assert.rejects(
    retryOnceAfterRefresh(
      async () => {
        calls += 1;
        throw unauthorized;
      },
      is401,
      async () => 'unavailable',
    ),
    (e) => e !== unauthorized && !isUnauthorizedError(e) && e.status === 503 && problemName(e) === 'refresh-unavailable',
  );
  assert.equal(calls, 1);
});

test('다시 보내도 401이면 그 401을 던지고 더 갱신하지 않는다. 401이 아닌 실패는 갱신하지 않는다', async () => {
  let refreshed = 0;
  await assert.rejects(
    retryOnceAfterRefresh(
      async () => {
        throw unauthorized;
      },
      is401,
      async () => {
        refreshed += 1;
        return 'ok';
      },
    ),
  );
  assert.equal(refreshed, 1);
  const boom = new Error('500');
  await assert.rejects(
    retryOnceAfterRefresh(
      async () => {
        throw boom;
      },
      is401,
      async () => {
        refreshed += 1;
        return 'ok';
      },
    ),
    (e) => e === boom,
  );
  assert.equal(refreshed, 1);
});

test('갱신 일시 장애 오류를 가려내고, 홈·공연 상세의 개인 값 첫 조회는 그때 예전처럼 비로그인 모양으로 둔다(다시 불러오기 상태가 없다, 새 맥락 마지막 검토)', () => {
  assert.equal(isRefreshUnavailableError(refreshUnavailableError()), true);
  assert.equal(isRefreshUnavailableError(unauthorized), false);
  assert.equal(isRefreshUnavailableError(new Error('500')), false);
  const detail = readFileSync(new URL('../../_pages/event-detail/ui/DetailPersonal.tsx', import.meta.url), 'utf8');
  assert.match(detail, /const guest = \(e: unknown\) => \{\s*\n\s*if \(live && \(isUnauthorized\(e\) \|\| isRefreshUnavailableError\(e\)\)\) setStatus\('guest'\);/);
  const home = readFileSync(new URL('../../_pages/home/ui/HomePersonal.tsx', import.meta.url), 'utf8');
  assert.match(home, /if \(live\) setStatus\(isUnauthorized\(e\) \|\| isRefreshUnavailableError\(e\) \? 'guest' : 'ready'\);/);
  assert.match(home, /if \(live && \(isUnauthorized\(e\) \|\| isRefreshUnavailableError\(e\)\)\) setStatus\('guest'\);/);
});
