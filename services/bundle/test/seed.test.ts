// 측정 무대의 회차 열기 요청 검사와 회차 일정 칸(BUILD_ORDER PRF-215, docs/verification.md §3.9 'v1 경로'). 실제 저장소에 쓰는 것은 test-int/start-files.int.test.ts가 본다.
// 시험 값은 코드 상수와 다르게 고른다(묶음 구간 기본 2초 대신 1,500ms, 좌석맵 판 1 대신 10).
import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { closeEvent, parseSeedRequest, SALE_END_BEFORE_START_MS, scheduleFields, SEED_STARTUP_TIMEOUT_MS } from '../src/seed.js';

/** Redis 대역(회차 닫기 시험): 주소마다 받은 명령을 적는다. ZSCORE는 없음(null), 나머지는 1 */
const redisCalls = vi.hoisted(() => [] as { url: string; cmd: string[] }[]);
vi.mock('@peaket/platform', () => ({
  createHotRedis: async (o: { url: string }) => ({
    command: async (cmd: string[]) => (redisCalls.push({ url: o.url, cmd }), cmd[0] === 'ZSCORE' ? null : 1),
    close: async () => undefined,
  }),
}));

const OK = { eventId: '0193a4b2-7c1a-7d3e-9f40-6b2a8c1d5e70', opensAtMs: 1_762_700_000_000, startsAtMs: 1_762_700_000_000 + 25 * 3600_000, seatCount: 2_000, batchWindowMs: 1_500, layoutVersion: 10 };

describe('parseSeedRequest', () => {
  test('PRF215_맞는 요청은 그대로 돌려준다', () => {
    expect(parseSeedRequest(OK)).toEqual(OK);
  });

  test('PRF215_판매 종료(공연 시작 − 24시간)는 오픈보다 뒤여야 한다(경계: 정확히 24시간은 거절, 24시간 + 1ms는 받는다)', () => {
    expect(SALE_END_BEFORE_START_MS).toBe(86_400_000);
    expect(() => parseSeedRequest({ ...OK, startsAtMs: OK.opensAtMs + 86_400_000 })).toThrow(/24시간보다 뒤/);
    expect(parseSeedRequest({ ...OK, startsAtMs: OK.opensAtMs + 86_400_001 }).startsAtMs).toBe(OK.opensAtMs + 86_400_001);
  });

  test.each([
    [{ eventId: '0193A4B2-7C1A-7D3E-9F40-6B2A8C1D5E70' }, /UUIDv7/],
    [{ eventId: '0193a4b2-7c1a-4d3e-9f40-6b2a8c1d5e70' }, /UUIDv7/],
    [{ seatCount: 0 }, /seatCount는 1~1000000/],
    [{ seatCount: 1_000_001 }, /seatCount/],
    [{ seatCount: 2.5 }, /seatCount/],
    [{ batchWindowMs: 0 }, /batchWindowMs는 1~60000/],
    [{ batchWindowMs: 60_001 }, /batchWindowMs/],
    [{ layoutVersion: 0 }, /layoutVersion/],
    [{ layoutVersion: 4_294_967_296 }, /layoutVersion/],
    [{ opensAtMs: '1762700000000' }, /opensAtMs/],
    [{ extra: 1 }, /모르는 칸: extra/],
  ])('PRF215_틀린 요청 %j는 RangeError다', (patch, message) => {
    expect(() => parseSeedRequest({ ...OK, ...patch })).toThrow(message);
  });

  test('PRF215_경계 값 batchWindowMs 1·60000, seatCount 1, layoutVersion 2^32 − 1은 받는다', () => {
    expect(parseSeedRequest({ ...OK, batchWindowMs: 1 }).batchWindowMs).toBe(1);
    expect(parseSeedRequest({ ...OK, batchWindowMs: 60_000 }).batchWindowMs).toBe(60_000);
    expect(parseSeedRequest({ ...OK, seatCount: 1 }).seatCount).toBe(1);
    expect(parseSeedRequest({ ...OK, layoutVersion: 4_294_967_295 }).layoutVersion).toBe(4_294_967_295);
    expect(() => parseSeedRequest(null)).toThrow(/JSON 객체/);
    expect(() => parseSeedRequest([OK])).toThrow(/JSON 객체/);
  });
});

test('PRF215_회차 일정 사본은 로비 없음·오픈 직후 묶음이고 결제사 묶음 칸(pgKey·pgTps)을 두지 않는다', () => {
  const f = scheduleFields(OK);
  const map = Object.fromEntries(f.flatMap((v, i) => (i % 2 === 0 ? [[v, f[i + 1]]] : [])));
  expect(map).toEqual({ opensAtMs: '1762700000000', startsAtMs: String(OK.startsAtMs), lobbyShuffle: '0', openBatch: '1', batchWindowMs: '1500', layoutVersion: '10', rev: '1' });
});

test('PRF215_코드리뷰H1_결제사묶음이름은_실행마다_받은pgKey이고_pgTps와_함께만받는다(같은 무대의 다른 실행 회차와 입장 속도를 나누지 않게)', () => {
  const f = scheduleFields(parseSeedRequest({ ...OK, pgTps: 37, pgKey: 'lt-mwah7w0a30bd' }));
  expect(f.slice(-4)).toEqual(['pgKey', 'lt-mwah7w0a30bd', 'pgTps', '37']);
  expect(scheduleFields(parseSeedRequest({ ...OK, pgTps: 37, pgKey: 'lt-other1' })).slice(-3)[0]).toBe('lt-other1');
  expect(parseSeedRequest({ ...OK, pgTps: 1, pgKey: 'lt-a' }).pgTps).toBe(1);
  expect(parseSeedRequest({ ...OK, pgTps: 100_000, pgKey: 'lt-a' }).pgTps).toBe(100_000);
  for (const bad of [0, 100_001, 2.5, '28']) expect(() => parseSeedRequest({ ...OK, pgTps: bad, pgKey: 'lt-a' })).toThrow(/pgTps/);
  expect(() => parseSeedRequest({ ...OK, pgTps: 30 })).toThrow(/pgKey/);
  expect(() => parseSeedRequest({ ...OK, pgKey: 'lt-a' })).toThrow(/pgKey/);
  for (const bad of ['', 'a'.repeat(33), 'lt stage', 'lt:x']) expect(() => parseSeedRequest({ ...OK, pgTps: 3, pgKey: bad })).toThrow(/pgKey/);
  expect(parseSeedRequest(OK)).not.toHaveProperty('pgTps');
});

test('PRF215_코드리뷰M4_시드·진행중회차·회차닫기의_Redis연결은_실행도구의_v0관리스크립트와같은_30초까지기다린다', async () => {
  expect(SEED_STARTUP_TIMEOUT_MS).toBe(30_000);
  const src = await readFile(new URL('../src/seed.ts', import.meta.url), 'utf8');
  const calls = src.match(/createHotRedis\(\{[^)]*\}\)/g) ?? [];
  expect(calls.length).toBeGreaterThanOrEqual(4);
  for (const c of calls) expect(c).toContain('startupTimeoutMs: SEED_STARTUP_TIMEOUT_MS');
});

test('PRF215_변이검토_코드리뷰H1_회차닫기는_대기열일정사본을지우고_입장제어목록과_좌석판매목록(s:ctl:events)에서_그회차를뺀다', async () => {
  redisCalls.length = 0;
  // 시험 값: 기본 포트(6379)와 다른 주소, 합본과 같은 환경 파일 둘
  const files: Record<string, string> = {
    'queue-svc.env': 'PEAKET_QUEUE_REDIS_URL=redis://queue-test:6390\n',
    'purchase-svc.env': 'PEAKET_SEAT_REDIS_URL=redis://seat-test:6391\nPEAKET_DATABASE_URL=postgres://purchase-test\n',
  };
  const read = async (p: string) => files[p.replace(/\\/g, '/').split('/').pop()!]!;
  const id = OK.eventId;
  expect(await closeEvent(id, { envDir: '/x/envs', read, settleMs: 0 })).toEqual({ queue: 1, seat: 1 });
  const on = (url: string) => redisCalls.filter((c) => c.url === url).map((c) => c.cmd.join(' '));
  expect(on('redis://queue-test:6390')).toEqual([`DEL q:{event:${id}}:cfg`, `ZREM q:{admission}:events ${id}`, `ZSCORE q:{admission}:events ${id}`]);
  expect(on('redis://seat-test:6391')).toEqual([`SREM s:ctl:events ${id}`]);
  await expect(closeEvent('0193a4b2-7c1a-4d3e-9f40-6b2a8c1d5e70', { envDir: '/x/envs', read, settleMs: 0 })).rejects.toThrow(/UUIDv7/);
});
