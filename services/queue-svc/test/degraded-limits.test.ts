// 축소 운영의 파드 메모리 한도(docs/features/bot-defense.md §11.2, B-T6 ②). 로비 입장·사전 검증에 기기·계정마다 5회/10초, 호스팅·프록시 대역 IP마다 5회/10초.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { IssuePreverification } from '../src/modules/entry/application/issue-preverification.js';
import { EntryError } from '../src/modules/entry/application/entry-error.js';
import { MemoryDegradedLimits } from '../src/modules/entry/adapters/memory-degraded-limits.js';
import { MemoryEntryStore, MemoryEventSchedules, MemoryShuffleCommits } from '../src/modules/entry/adapters/memory-entry-store.js';
import { JoinLobby } from '../src/modules/entry/application/join-lobby.js';
import { ShuffleCommits } from '../src/modules/entry/application/shuffle-commits.js';
import { TestSeedSealer } from '@peaket/shuffle';
import { ACCOUNT, DEVICE, newEvent, openSchedule, PID, recordingRisk, tokens } from './support.js';

const clock = () => fakeClock({ now: Date.UTC(2026, 10, 3, 1, 0, 0) });
const table = { classify: (asn: number) => (asn === 16509 ? 'HOSTING' : asn === 9009 ? 'PROXY' : 'OTHER') as 'HOSTING' | 'PROXY' | 'OTHER' };

describe('MemoryDegradedLimits', () => {
  test('B-T6②_기기마다10초에5회까지_6회째는넘고_10초뒤에는다시받는다', () => {
    const c = clock();
    const limits = new MemoryDegradedLimits(c, table);
    for (let i = 0; i < 5; i++) expect(limits.allow({ deviceId: 'd1', pid: `p${i}`, client: { ip: '198.51.100.1', asn: 0, clientHints: {} } })).toBe(true);
    expect(limits.allow({ deviceId: 'd1', pid: 'p9', client: { ip: '198.51.100.1', asn: 0, clientHints: {} } })).toBe(false);
    c.advance(10_001);
    expect(limits.allow({ deviceId: 'd1', pid: 'p9', client: { ip: '198.51.100.1', asn: 0, clientHints: {} } })).toBe(true);
  });

  test('B-T6②_계정(pid)도기기와따로10초에5회다', () => {
    const limits = new MemoryDegradedLimits(clock(), table);
    for (let i = 0; i < 5; i++) expect(limits.allow({ deviceId: `d${i}`, pid: 'same', client: { ip: '', asn: 0, clientHints: {} } })).toBe(true);
    expect(limits.allow({ deviceId: 'd9', pid: 'same', client: { ip: '', asn: 0, clientHints: {} } })).toBe(false);
  });

  test('B-T6②_호스팅대역IP는IP마다한도가걸린다', () => {
    const limits = new MemoryDegradedLimits(clock(), table);
    const hosting = (i: number) => ({ deviceId: `d${i}`, pid: `p${i}`, client: { ip: '203.0.113.9', asn: 16509, clientHints: {} } });
    for (let i = 0; i < 5; i++) expect(limits.allow(hosting(i))).toBe(true);
    expect(limits.allow(hosting(9))).toBe(false);
  });

  test('B-T6②_프록시대역IP도같다', () => {
    const limits = new MemoryDegradedLimits(clock(), table);
    const proxy = (i: number) => ({ deviceId: `d${i}`, pid: `p${i}`, client: { ip: '203.0.113.9', asn: 9009, clientHints: {} } });
    for (let i = 0; i < 5; i++) limits.allow(proxy(i));
    expect(limits.allow(proxy(9))).toBe(false);
  });

  test('B-T6②_통신사대역과분류표에없는ASN은IP로막지않는다(B-T7③)', () => {
    const limits = new MemoryDegradedLimits(clock(), table);
    for (let i = 0; i < 20; i++) expect(limits.allow({ deviceId: `d${i}`, pid: `p${i}`, client: { ip: '203.0.113.9', asn: 4766, clientHints: {} } })).toBe(true);
    for (let i = 20; i < 40; i++) expect(limits.allow({ deviceId: `d${i}`, pid: `p${i}`, client: { ip: '203.0.113.9', asn: 0, clientHints: {} } })).toBe(true);
  });

  test('기기식별값이없으면계정한도만센다', () => {
    const limits = new MemoryDegradedLimits(clock(), table);
    for (let i = 0; i < 20; i++) expect(limits.allow({ deviceId: '', pid: `p${i}`, client: { ip: '', asn: 0, clientHints: {} } })).toBe(true);
  });

  test('낮음7_이미한도를넘은요청은새키를넣지않는다', () => {
    const limits = new MemoryDegradedLimits(clock(), table);
    for (let i = 0; i < 5; i++) limits.allow({ deviceId: 'd1', pid: `p${i}`, client: { ip: '', asn: 0, clientHints: {} } });
    const before = limits.size();
    expect(limits.allow({ deviceId: 'd1', pid: 'p-new', client: { ip: '', asn: 0, clientHints: {} } })).toBe(false);
    expect(limits.size()).toBe(before);
  });

  test('낮음7_ip는모양이맞을때만IP키가된다', () => {
    const limits = new MemoryDegradedLimits(clock(), table);
    for (let i = 0; i < 8; i++) expect(limits.allow({ deviceId: `d${i}`, pid: `p${i}`, client: { ip: 'not-an-ip', asn: 16509, clientHints: {} } })).toBe(true);
  });

  test('시험빈틈_20만키상한뒤에도메모리가늘지않고_새키의한도는그대로걸린다', () => {
    const c = clock();
    const limits = new MemoryDegradedLimits(c, table);
    for (let i = 0; i < 200_010; i++) limits.allow({ deviceId: `d${i}`, pid: '', client: { ip: '', asn: 0, clientHints: {} } });
    expect(limits.size()).toBeLessThanOrEqual(200_000);
    for (let i = 0; i < 5; i++) expect(limits.allow({ deviceId: 'late', pid: '', client: { ip: '', asn: 0, clientHints: {} } })).toBe(true);
    expect(limits.allow({ deviceId: 'late', pid: '', client: { ip: '', asn: 0, clientHints: {} } })).toBe(false);
  });

  test('키수가상한을넘으면오래된것부터잊어메모리가끝없이늘지않는다', () => {
    const limits = new MemoryDegradedLimits(clock(), table, { maxKeys: 4 });
    for (let i = 0; i < 10; i++) limits.allow({ deviceId: `d${i}`, pid: `p${i}`, client: { ip: '', asn: 0, clientHints: {} } });
    expect(limits.size()).toBeLessThanOrEqual(4);
  });
});

describe('사전 검증 축소 운영', () => {
  async function setup(verdict: Parameters<typeof recordingRisk>[0], limits = new MemoryDegradedLimits(clock(), table)) {
    const c = clock();
    const schedules = new MemoryEventSchedules();
    const eventId = newEvent();
    await schedules.set(eventId, openSchedule(c.now(), { lobbyShuffle: false }));
    const issue = new IssuePreverification(schedules, tokens, recordingRisk(verdict), c, limits);
    const run = (client = { ip: '203.0.113.9', asn: 0, clientHints: {} }) => issue.run({ accountId: ACCOUNT, pid: PID, eventId, body: { deviceId: DEVICE, humanCheckToken: 't' }, client });
    return { issue, run };
  }

  test('B-T6③_판정을받지못하면토큰에hd를넣고_vr은없다', async () => {
    const { run } = await setup({ kind: 'UNAVAILABLE' });
    const c = tokens.readPreverify((await run()).preverifyToken)!;
    expect(c.hd).toBe(true);
    expect(c.vr).toBeUndefined();
  });

  test('B-T6③_degraded인ALLOW도토큰에hd를넣지만_파드메모리한도는걸지않는다', async () => {
    const { run } = await setup({ kind: 'HELD' });
    for (let i = 0; i < 8; i++) expect(tokens.readPreverify((await run()).preverifyToken)!.hd).toBe(true);
  });

  test('[ASVS v5.0.0-2.4.1] B-T6②_판정을받지못할때한도를넘으면DEGRADED_LIMITED다', async () => {
    const { run } = await setup({ kind: 'UNAVAILABLE' });
    for (let i = 0; i < 5; i++) await run();
    await expect(run()).rejects.toMatchObject({ code: 'DEGRADED_LIMITED', retryAfterSeconds: 10 });
    await expect(run()).rejects.toBeInstanceOf(EntryError);
  });

  test('B-T6②_판정을받은동안에는한도를세지않는다', async () => {
    const { run } = await setup({ kind: 'OK' });
    for (let i = 0; i < 8; i++) expect(tokens.readPreverify((await run()).preverifyToken)!.hd).toBeUndefined();
  });

  test('VERIFY는vr이고hd가없다', async () => {
    const { run } = await setup({ kind: 'VERIFY', reason: 'NETWORK' });
    const c = tokens.readPreverify((await run()).preverifyToken)!;
    expect(c.vr).toBe('NETWORK');
    expect(c.hd).toBeUndefined();
  });
});

describe('로비 참가 축소 운영(HOT-040이 넘긴 것)', () => {
  async function lobby(verdict: Parameters<typeof recordingRisk>[0]) {
    const c = clock();
    const schedules = new MemoryEventSchedules();
    const store = new MemoryEntryStore(c);
    const eventId = newEvent();
    await schedules.set(eventId, { opensAtMs: c.now() + 5 * 60_000, startsAtMs: c.now() + 3 * 24 * 3_600_000, lobbyShuffle: true, openBatch: true, lobbyMinutes: 10 });
    const commits = new ShuffleCommits(new MemoryShuffleCommits(), new TestSeedSealer(Buffer.alloc(32, 5)), schedules, c);
    const app = new JoinLobby(store, schedules, tokens, recordingRisk(verdict), commits, c, undefined, new MemoryDegradedLimits(c, table));
    const join = (pid: string, deviceId = DEVICE) => app.run({ eventId, accountId: ACCOUNT, pid, body: { humanCheckToken: 'tok', deviceId }, client: { ip: '198.51.100.1', asn: 0, clientHints: {} } });
    return { store, eventId, join };
  }

  test('[ASVS v5.0.0-2.4.1] HOT-040_판정을받지못한로비참가토큰에는hd가있고_vr은없다', async () => {
    const { join } = await lobby({ kind: 'UNAVAILABLE' });
    const r = await join(PID);
    const c = tokens.readLobby(r.lobbyToken)!;
    expect(c.hd).toBe(true);
    expect(c.vr).toBeUndefined();
  });

  test('HOT-040_degraded인ALLOW도로비참가토큰에hd를넣는다', async () => {
    const { join } = await lobby({ kind: 'HELD' });
    expect(tokens.readLobby((await join(PID)).lobbyToken)!.hd).toBe(true);
  });

  test('B-T6②_판정을받지못할때기기한도를넘으면DEGRADED_LIMITED이고_선점을풀어같은사람이다시올수있다', async () => {
    const { join, store, eventId } = await lobby({ kind: 'UNAVAILABLE' });
    for (let i = 0; i < 5; i++) await join(`pid-limit-${i}`);
    await expect(join('pid-limit-9')).rejects.toMatchObject({ code: 'DEGRADED_LIMITED', retryAfterSeconds: 10 });
    expect(store.dupForTest('pid-limit-9', eventId).value).toBeNull();
  });
});
