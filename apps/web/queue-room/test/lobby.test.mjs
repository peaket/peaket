// 대기실 로비 경로(SCR-007, docs/frontend.md §3.4 lobby-join·lobby·shuffle-fetch, ADR-0208 결정 2~4)를 가짜 시계로 끝까지 돌린다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, harness, iso, openTab, reply, sha, START, stateFile } from './harness.mjs';

/** 틀의 저장소가 만드는 기기 ID(16바이트 0x01, base64url) */
const DEVICE = 'AQEBAQEBAQEBAQEBAQEBAQ';
/** 이 기기의 로비 버튼 지연(§5.9 식, lobbySpreadSec 60) */
const UNLOCK_MS = Number.parseInt(sha(`PEAKET-lobby-open-v1e1${DEVICE}`).slice(0, 8), 16) % 60_000;
const spreadOf = (token, sec) => Number.parseInt(sha(token).slice(4, 12), 16) % (sec * 1000);
const LT = 'lt-1';
const lobbyBody = (now, over = {}) => ({ lobbyToken: LT, seedHash: 'ab'.repeat(32), drandChain: 'quicknet', drandRound: 100, algorithmVersion: 'v1', lobbyOpenedAt: iso(START), shuffleResultAt: iso(over.resultAt ?? START + 10 * 60_000 + 3000), shuffleSpreadSec: 8, serverTimeMs: now, ...over.extra });
const isLobbyPost = (c) => c.m === 'POSTJSON' && c.url === `https://q/v1/queues/e1/lobby-participants`;

test('SCR-007 오픈 전 로비: 이 기기의 열리는 시각까지 기다린 뒤 사람 확인 → 참가(JSON) → 카운트다운 → 공개 시각 + 지연에 셔플 결과(404면 다시) → 순번으로 대기 → 입장 확정은 참가 토큰', async () => {
  const T0 = START + 10 * 60_000;
  const resultAt = T0 + 3000;
  let published = false;
  let serving = 0;
  const h = harness({
    schedule: { openAtMs: T0, lobbyOpensAtMs: START },
    handler: ({ m, url, body, now }) => {
      if (m === 'POSTJSON' && url.endsWith('/lobby-participants')) return reply(201, lobbyBody(now, { resultAt }));
      if (m === 'GET' && url.includes('/shuffle-results/')) return published ? reply(200, { [sha(LT)]: 1500, [sha('other')]: 1 }) : reply(404);
      if (m === 'GET' && url.includes('/segment-states/')) return reply(200, stateFile({ serving, servingRate: 10, generatedAtMs: Math.floor(now / 1000) * 1000 }));
      if (m === 'POST' && url.endsWith('/admission')) {
        assert.equal(body.lobbyToken, LT);
        assert.equal(body.queueTicket, undefined);
        return reply(200, { status: 'ADMITTED', admissionToken: 'adm', serverTimeMs: now });
      }
      return reply(500);
    },
  });
  await h.start();
  // 열리기 전: 남은 시간을 보이고 사람 확인·참가 요청을 보내지 않는다
  if (UNLOCK_MS > 0) {
    assert.deepEqual([h.last().state, h.last().phase, h.last().joinAt, h.last().openAt], ['lobby-join', 'not-yet', START + UNLOCK_MS, T0], '참가 전에도 오픈까지 카운트다운(브라우저 확인에서 찾음)');
    assert.equal(h.hcCalls, 0);
    await h.run(UNLOCK_MS - 1);
    assert.equal(h.calls.filter(isLobbyPost).length, 0, '열리는 시각 전에는 보내지 않는다');
  }
  await h.run(1);
  assert.ok(h.views.some((v) => v.state === 'lobby-join' && v.phase === 'checking' && v.openAt === T0), '사람 확인 중');
  const post = h.calls.find(isLobbyPost);
  assert.deepEqual(post.body, { humanCheckToken: 'hc-1', deviceId: DEVICE });
  // 참가 완료: 카운트다운(오픈 시각은 공개 요약의 값)과 시드 해시. 저장소에 참가 토큰과 공시 값
  assert.deepEqual([h.last().state, h.last().phase, h.last().openAt, h.last().seedHash], ['lobby', 'countdown', T0, 'ab'.repeat(32)]);
  const rec = h.store.read();
  assert.deepEqual([rec.lobby.lobbyToken, rec.lobby.shuffleResultAtMs, rec.lobby.shuffleSpreadSec, rec.lobby.drandRound], [LT, resultAt, 8, 100]);
  // 오픈 뒤 공개 전: '곧 순번이 공개됩니다'
  await h.run(T0 - h.now);
  assert.equal(h.last().phase, 'reveal');
  const due = resultAt + spreadOf(LT, 8);
  await h.run(due - h.now - 1);
  assert.equal(h.calls.filter((c) => c.url.includes('/shuffle-results/')).length, 0, '토큰 해시로 정한 지연 전에는 받지 않는다');
  await h.run(1);
  const first = h.calls.find((c) => c.url.includes('/shuffle-results/'));
  assert.equal(first.url, `https://f/v1/queues/e1/shuffle-results/${sha(LT).slice(0, 3)}.json`);
  assert.equal(first.noStore, false);
  assert.equal(h.last().phase, 'calculating', '404면 순서 계산 중');
  published = true;
  await h.run(1000); // 2초 간격 안의 무작위(0.5) 시각
  const ticket = h.store.read().ticket;
  assert.deepEqual([ticket.lobbyToken, ticket.seq, ticket.segment, ticket.queueTicket], [LT, 1500, 1, undefined]);
  assert.equal(h.store.read().lobby, undefined, '순번을 받으면 대기표 자리로 옮긴다');
  assert.ok(h.calls.some((c) => c.url.endsWith('/segment-states/1.json')));
  assert.equal(h.last().ahead, 1499);
  serving = 1500;
  await h.run(6000); // 예상 대기 150초 → 5초 간격
  assert.deepEqual(h.navs, ['/booking/e1/seats']);
});

test('SCR-007 다시 열면 저장한 참가 토큰으로 로비부터 이어 간다(사람 확인·참가를 다시 하지 않는다)', async () => {
  const h = harness({
    schedule: { openAtMs: START + 60_000, lobbyOpensAtMs: START - 60_000 },
    rec: { lobby: { lobbyToken: LT, seedHash: 'cd'.repeat(32), shuffleResultAtMs: START + 63_000, shuffleSpreadSec: 0 } },
    handler: () => reply(404),
  });
  await h.start();
  assert.deepEqual([h.last().state, h.last().phase, h.last().seedHash], ['lobby', 'countdown', 'cd'.repeat(32)]);
  assert.equal(h.hcCalls, 0);
  assert.equal(h.calls.length, 0);
});

test('SCR-007 참가 응답: REQUIRED는 저장 뒤 추가 검증, 401은 갱신 뒤 같은 토큰, 403 본인확인 전은 공연 상세, 그 밖 403·428은 사람 확인 실패와 다시 시도', async () => {
  const sched = { openAtMs: START + 10 * 60_000, lobbyOpensAtMs: START - 60_000 };
  // REQUIRED
  let h = harness({ schedule: sched, handler: ({ m, now }) => (m === 'POSTJSON' ? reply(201, lobbyBody(now, { extra: { verification: 'REQUIRED', verificationReason: 'NETWORK' } })) : reply(500)) });
  await h.start();
  assert.deepEqual(h.navs, ['/queue/e1/verify']);
  assert.equal(h.store.read().lobby.lobbyToken, LT, '돌아오면 boot가 로비로 잇는다');
  // 401 → 갱신 → 같은 사람 확인 토큰으로 다시
  let n = 0;
  h = harness({ schedule: sched, handler: ({ m, now }) => (m === 'POSTJSON' ? (++n === 1 ? reply(401) : reply(201, lobbyBody(now))) : reply(500)) });
  await h.start();
  assert.equal(h.refreshes, 1);
  assert.equal(h.hcCalls, 1, '게이트웨이가 거절한 토큰은 쓰지 않았으므로 다시 쓴다');
  assert.deepEqual(h.calls.filter(isLobbyPost).map((c) => c.body.humanCheckToken), ['hc-1', 'hc-1']);
  assert.equal(h.last().state, 'lobby');
  // 401 두 번 → 로그인 만료
  h = harness({ schedule: sched, handler: ({ m }) => (m === 'POSTJSON' ? reply(401) : reply(500)) });
  await h.start();
  assert.equal(h.last().state, 'login-expired');
  // 403 본인확인 전 → 공연 상세
  h = harness({ schedule: sched, handler: ({ m }) => (m === 'POSTJSON' ? reply(403, {}, { problem: 'identity-verification-required' }) : reply(500)) });
  await h.start();
  assert.deepEqual(h.navs, ['/events/e1']);
  // 그 밖 403·428 → 사람 확인 실패, [다시 시도]는 새 토큰
  for (const [status, problem] of [[403, 'human-check-failed'], [428, 'human-check-required']]) {
    n = 0;
    h = harness({ schedule: sched, handler: ({ m, now }) => (m === 'POSTJSON' ? (++n === 1 ? reply(status, {}, { problem }) : reply(201, lobbyBody(now))) : reply(500)) });
    await h.start();
    assert.deepEqual([h.last().state, h.last().phase], ['lobby-join', 'failed'], `${status}`);
    h.ctl.retry();
    await h.run(0);
    assert.equal(h.hcCalls, 2);
    assert.equal(h.last().state, 'lobby');
  }
  // 위젯 실패(토큰 없음) → 보내지 않고 실패
  h = harness({ schedule: sched, hc: () => null, handler: () => reply(500) });
  await h.start();
  assert.deepEqual([h.last().state, h.last().phase, h.calls.length], ['lobby-join', 'failed', 0]);
});

test('SCR-007 참가 409: 다른 탭이 받은 참가 토큰이 저장소에 있으면 그것으로 로비, 없으면 다른 기기. 429는 같은 토큰, 503은 새 토큰으로 다시', async () => {
  const sched = { openAtMs: START + 10 * 60_000, lobbyOpensAtMs: START - 60_000 };
  let h = harness({ schedule: sched, handler: ({ m }) => (m === 'POSTJSON' ? reply(409, {}, { problem: 'already-joined' }) : reply(500)) });
  await h.start();
  assert.deepEqual([h.last().state, h.last().via, h.last().openAt], ['other-device', 'lobby', sched.openAtMs], '로비의 다른 기기 안내에도 카운트다운');
  h = harness({
    schedule: sched,
    handler: ({ m, tab }) => {
      if (m !== 'POSTJSON') return reply(500);
      tab.store.write({ lobby: { lobbyToken: 'lt-other-tab', seedHash: 'ef'.repeat(32), shuffleResultAtMs: START + 10 * 60_000, shuffleSpreadSec: 8 } });
      return reply(409, {}, { problem: 'already-joined' });
    },
  });
  await h.start();
  assert.deepEqual([h.last().state, h.last().seedHash], ['lobby', 'ef'.repeat(32)]);
  // 429: Retry-After 하한 위(0.5 → 1.1배) 뒤 같은 토큰
  let n = 0;
  h = harness({ schedule: sched, handler: ({ m, now }) => (m === 'POSTJSON' ? (++n === 1 ? reply(429, {}, { retryAfterMs: 2000 }) : reply(201, lobbyBody(now))) : reply(500)) });
  await h.start();
  assert.equal(h.calls.filter(isLobbyPost).length, 1);
  await h.run(2199);
  assert.equal(h.calls.filter(isLobbyPost).length, 1, '하한 × 1.1 전에는 다시 보내지 않는다');
  await h.run(1);
  assert.deepEqual(h.calls.filter(isLobbyPost).map((c) => c.body.humanCheckToken), ['hc-1', 'hc-1']);
  // 축소 운영의 429(queue-request-limited): 서버가 판정을 불러 토큰을 썼을 수 있어 503처럼 새 사람 확인(BOT-050 리뷰 3)
  n = 0;
  h = harness({ schedule: sched, handler: ({ m, now }) => (m === 'POSTJSON' ? (++n === 1 ? reply(429, { type: 'https://peaket.example/problems/queue-request-limited' }, { retryAfterMs: 10_000, problem: 'queue-request-limited' }) : reply(201, lobbyBody(now))) : reply(500)) });
  await h.start();
  await h.run(11_000);
  assert.deepEqual(h.calls.filter(isLobbyPost).map((c) => c.body.humanCheckToken), ['hc-1', 'hc-2']);
  assert.equal(h.last().state, 'lobby');
  // 503: 서버가 토큰을 썼는지 모르므로 새 사람 확인
  n = 0;
  h = harness({ schedule: sched, handler: ({ m, now }) => (m === 'POSTJSON' ? (++n === 1 ? reply(503, {}, { retryAfterMs: 1000 }) : reply(201, lobbyBody(now))) : reply(500)) });
  await h.start();
  await h.run(1100);
  assert.deepEqual(h.calls.filter(isLobbyPost).map((c) => c.body.humanCheckToken), ['hc-1', 'hc-2']);
  assert.equal(h.last().state, 'lobby');
});

test('SCR-007 boot 일정: 로비 개방 전이면 공연 상세, 선착순 오픈 전에 사전 검증 토큰이 있으면 진입(서버 409로 공연 상세), 일정을 못 받으면 다시 받는다', async () => {
  let h = harness({ schedule: { openAtMs: START + 20 * 60_000, lobbyOpensAtMs: START + 10 * 60_000 }, handler: () => reply(500) });
  await h.start();
  assert.deepEqual(h.navs, ['/events/e1'], '로비 개방 전');
  h = harness({ schedule: { openAtMs: START + 60_000, lobbyOpensAtMs: null }, rec: { preverifyToken: 'pv' }, handler: ({ m }) => (m === 'POST' ? reply(409, {}, { problem: 'queue-not-open' }) : reply(500)) });
  await h.start();
  assert.equal(h.calls[0].url, 'https://q/v1/queues/e1/entries');
  assert.deepEqual(h.navs, ['/events/e1']);
  h = harness({ schedule: { openAtMs: START + 60_000, lobbyOpensAtMs: null }, handler: () => reply(500) });
  await h.start();
  assert.deepEqual(h.navs, ['/events/e1'], '선착순 오픈 전, 토큰 없음');
  // 일정 실패 → 기다렸다가 다시(사전 검증 토큰이 없을 때)
  let tries = 0;
  h = harness({ schedule: () => (++tries < 3 ? null : { openAtMs: START + 10 * 60_000, lobbyOpensAtMs: START - 120_000 }), handler: ({ m, now }) => (m === 'POSTJSON' ? reply(201, lobbyBody(now)) : reply(500)) });
  await h.start();
  assert.equal(tries, 1);
  await h.run(10_000);
  assert.equal(tries, 3);
  assert.equal(h.last().state, 'lobby');
  // 일정 실패 + 사전 검증 토큰 → 일정 없이 진입
  h = harness({ schedule: null, rec: { preverifyToken: 'pv' }, handler: ({ m }) => (m === 'POST' ? reply(409, {}, { problem: 'queue-not-open' }) : reply(500)) });
  await h.start();
  assert.equal(h.calls[0].url, 'https://q/v1/queues/e1/entries');
  // 오픈 전이고 로비가 열렸으면 사전 검증 토큰이 있어도 로비 참가
  h = harness({ schedule: { openAtMs: START + 60_000, lobbyOpensAtMs: START - 120_000 }, rec: { preverifyToken: 'pv' }, handler: ({ m, now }) => (m === 'POSTJSON' ? reply(201, lobbyBody(now)) : reply(500)) });
  await h.start();
  assert.equal(h.last().state, 'lobby');
});

test('SCR-007 셔플 결과: 60초 넘게 없으면 순서 발표 지연(계속 받는다), 200인데 내 해시가 두 번 연달아 없으면 다른 기기에서 취소', async () => {
  const lobby = { lobbyToken: LT, seedHash: 'ab'.repeat(32), shuffleResultAtMs: START - 1000, shuffleSpreadSec: 0 };
  let mode = '404';
  const h = harness({ schedule: { openAtMs: START - 5000, lobbyOpensAtMs: START - 600_000 }, rec: { lobby }, handler: ({ m, url }) => (m === 'GET' && url.includes('/shuffle-results/') ? (mode === '404' ? reply(404) : reply(200, { [sha('someone')]: 3 })) : reply(500)) });
  await h.start();
  assert.equal(h.last().phase, 'calculating');
  await h.run(61_000);
  assert.equal(h.last().phase, 'delayed');
  const before = h.calls.length;
  await h.run(20_000);
  assert.ok(h.calls.length > before, '발표 지연 중에도 계속 받는다(최대 20초 간격)');
  mode = 'missing';
  await h.run(20_000);
  await h.run(20_000);
  assert.deepEqual([h.last().state, h.last().via], ['cancelled-elsewhere', 'lobby']);
  assert.equal(h.store.read(), null);
});

test('SCR-007 다른 기기 참가 뒤 이 기기에서 다시 참가: 오픈 전이면 로비 참가를 취소하고 다시 참가, 오픈 뒤면 대기를 취소하고 진입', async () => {
  let joined = false;
  let h = harness({
    schedule: { openAtMs: START + 10 * 60_000, lobbyOpensAtMs: START - 60_000 },
    handler: ({ m, url, now }) => {
      if (m === 'DELETE' && url.endsWith('/lobby-participants/me')) {
        joined = true;
        return reply(204);
      }
      if (m === 'POSTJSON') return joined ? reply(201, lobbyBody(now)) : reply(409, {}, { problem: 'already-joined' });
      return reply(500);
    },
  });
  await h.start();
  assert.equal(h.last().state, 'other-device');
  h.ctl.rejoin();
  await h.run(0);
  assert.deepEqual(h.calls.map((c) => `${c.m} ${c.url.replace('https://q/v1/queues/e1/', '')}`), ['POSTJSON lobby-participants', 'DELETE lobby-participants/me', 'POSTJSON lobby-participants']);
  assert.equal(h.hcCalls, 2, '다시 참가에는 새 사람 확인 토큰');
  assert.equal(h.last().state, 'lobby');
  // 오픈 뒤(로비 취소가 409) → 대기 취소 뒤 진입
  h = harness({
    schedule: { openAtMs: START - 1000, lobbyOpensAtMs: START - 600_000 },
    rec: { preverifyToken: 'pv' },
    handler: ({ m, url, now }) => {
      if (m === 'POST' && url.endsWith('/entries')) return h.calls.filter((c) => c.m === 'POST').length === 1 ? reply(409, {}, { problem: 'already-waiting' }) : reply(201, { queueTicket: 'qt', seq: 5, segment: 0, serverTimeMs: now });
      if (m === 'DELETE') return reply(204);
      if (m === 'GET') return reply(200, stateFile({ serving: 1, generatedAtMs: 0 }));
      return reply(500);
    },
  });
  await h.start();
  assert.equal(h.last().state, 'other-device');
  h.ctl.rejoin();
  await h.run(0);
  assert.ok(h.calls.some((c) => c.m === 'DELETE' && c.url.endsWith('/entries/me')));
  assert.equal(h.store.read().ticket.queueTicket, 'qt');
});

test('SCR-007 오프라인: 카운트다운은 그대로 두고 오프라인 표시와 마지막 동기화 시각을 낸다', async () => {
  let on = true;
  const h = harness({
    schedule: { openAtMs: START + 10 * 60_000, lobbyOpensAtMs: START - 60_000 },
    online: () => on,
    handler: ({ m, now }) => (m === 'POSTJSON' ? reply(201, lobbyBody(now)) : reply(500)),
  });
  await h.start();
  assert.equal(h.last().offline, false);
  on = false;
  await h.wake();
  assert.deepEqual([h.last().state, h.last().phase, h.last().offline, h.last().lastSyncAt], ['lobby', 'countdown', true, START]);
  on = true;
  await h.wake();
  assert.equal(h.last().offline, false);
});

// ── 새 맥락 리뷰(2026-11-05)에서 찾은 것의 재현 ──
test('SCR-007 저장한 참가 토큰으로 다시 연 탭이 일정을 못 받으면 다시 받아 카운트다운을 잇는다', async () => {
  let tries = 0;
  const h = harness({
    schedule: () => (++tries < 3 ? null : { openAtMs: START + 120_000, lobbyOpensAtMs: START - 60_000 }),
    rec: { lobby: { lobbyToken: LT, seedHash: 'cd'.repeat(32), shuffleResultAtMs: START + 123_000, shuffleSpreadSec: 0 } },
    handler: () => reply(404),
  });
  await h.start();
  assert.equal(h.last().phase, 'countdown', '공개 시각 전에는 순번 공개 대기로 보이지 않는다');
  await h.run(10_000);
  assert.equal(tries, 3);
  assert.equal(h.last().openAt, START + 120_000);
});

test('SCR-007 로비 공연에서 로비 개방 전이면 사전 검증 토큰이 있어도 진입하지 않고 공연 상세로 간다', async () => {
  const h = harness({ schedule: { openAtMs: START + 20 * 60_000, lobbyOpensAtMs: START + 10 * 60_000 }, rec: { preverifyToken: 'pv' }, handler: () => reply(500) });
  await h.start();
  assert.deepEqual([h.navs, h.calls.length], [['/events/e1'], 0]);
});

test('SCR-007 다른 탭의 로비 끝 상태 방송은 로비 문구(via)로 그린다', async () => {
  const w = createWorld();
  const lobby = { lobbyToken: LT, seedHash: 'ab'.repeat(32), shuffleResultAtMs: START - 1000, shuffleSpreadSec: 0 };
  w.local.setItem('peaket.queue.e1', JSON.stringify({ lobby, savedAt: START }));
  const sched = { openAtMs: START - 5000, lobbyOpensAtMs: START - 600_000 };
  const a = openTab(w, { multi: true, schedule: sched, handler: ({ m, url }) => (m === 'GET' && url.includes('/shuffle-results/') ? reply(200, { [sha('x')]: 1 }) : reply(500)) });
  const b = openTab(w, { multi: true, hidden: true, schedule: sched, handler: () => new Promise(() => undefined) });
  await b.start();
  await a.start();
  await w.run(5000);
  assert.deepEqual([a.last().state, a.last().via], ['cancelled-elsewhere', 'lobby']);
  assert.deepEqual([b.last().state, b.last().via], ['cancelled-elsewhere', 'lobby']);
});
