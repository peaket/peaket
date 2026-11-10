// 통합 시험: 기기 라벨 키 회전의 이음(docs/features/bot-defense.md §4.10, docs/security/secrets-and-keys.md '`inv-ref-key` 회전 절차' ⑤)을 실제 Valkey와 시험 라벨 키 두 판으로 본다.
// 옛 판(k1)의 키 다섯(tr:devacct·tr:devhist·tr:block·tr:devshare 그 회차·tr:blkv)을 새 판(k2)으로 남은 수명 그대로 옮기는지, 옛 판 키와 이어 달기(tr:refnext)를 Valkey에서 직접 본다.
// 시험: B-T26 ①~⑪, 라벨 반영 도중의 회전(B-T27 ⑦).
import { fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { deviceRefsFromEnv } from '../src/modules/scoring/adapters/device-refs.js';
import { keys } from '../src/modules/scoring/adapters/redis-feature-store.js';
import { DAY, dev, devicesV1, KEY_V1, KEY_V2, labelWorld, type LabelWorld, lid } from './label-world.js';
import { startTcpProxy } from './tcp-proxy.js';
import { startValkey } from './valkey.js';

const valkey = startValkey();
const T0 = Date.now();
/** 이음 끝: 지금부터 30일 */
const UNTIL = T0 + 30 * DAY;
const clock = fakeClock({ now: T0 });
const rotatedEnv = (until: number) => ({
  PEAKET_ENV: 'ci',
  PEAKET_INV_REF_DEVICE_KEY: KEY_V2.toString('base64'),
  PEAKET_INV_REF_DEVICE_KEY_VERSION: '2',
  PEAKET_INV_REF_DEVICE_PREVIOUS_KEY: KEY_V1.toString('base64'),
  PEAKET_INV_REF_DEVICE_PREVIOUS_KEY_VERSION: '1',
  PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL: new Date(until).toISOString(),
});
const rotated = deviceRefsFromEnv(rotatedEnv(UNTIL), clock).refs;
const devicesV2Only = deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: KEY_V2.toString('base64'), PEAKET_INV_REF_DEVICE_KEY_VERSION: '2' }, clock).refs;

let w: LabelWorld;
beforeAll(async () => {
  w = await labelWorld(valkey.url, { clock, devices: rotated });
});
afterAll(async () => {
  await w?.close();
  valkey.stop();
});

const seenOf = (x: LabelWorld): string[] => (x.signals as unknown as { seen: string[] }).seen;
const reset = async (x: LabelWorld) => {
  await x.cmd(['FLUSHALL']);
  x.offered.length = 0;
  x.logLines.length = 0;
  x.warnLines.length = 0;
  seenOf(x).splice(0);
  x.human.set('PASSED');
};
const oldRef = (name: string) => devicesV1.ref(dev(name))!;
const newRef = (name: string) => rotated.ref(dev(name))!;
const today = Math.floor(T0 / DAY);
const BLOCK_VALUE = JSON.stringify({ reason: 'SAMPLE_REVIEW', source: 'SAMPLE_REVIEW', caseId: 'rev-old', listedAtMs: T0 - DAY });

/** 옛 판 키를 둔다. 돌려주는 값은 키마다 둔 수명(밀리초) */
async function seedOld(x: LabelWorld, name: string, o: { block?: boolean; event?: string; failed?: number } = {}) {
  const r = oldRef(name);
  const ev = o.event ?? 'ev-1';
  const ttl = { accounts: 20 * DAY, history: 25 * DAY, block: 60 * DAY, shared: 300_000, block_version: 61 * DAY };
  await x.cmd(['ZADD', keys.devAccounts(r), String(T0 - DAY), 'pid-old-1', String(T0 - 2 * DAY), 'pid-old-2']);
  await x.cmd(['PEXPIRE', keys.devAccounts(r), String(ttl.accounts)]);
  await x.cmd(['HSET', keys.devHistory(r), `failed:${today}`, String(o.failed ?? 1), `sent:${today - 1}`, '2']);
  await x.cmd(['PEXPIRE', keys.devHistory(r), String(ttl.history)]);
  if (o.block) await x.cmd(['SET', keys.block(r), BLOCK_VALUE, 'PX', String(ttl.block)]);
  await x.cmd(['SADD', keys.devShare(r, ev), 'pid-share-1']);
  await x.cmd(['PEXPIRE', keys.devShare(r, ev), String(ttl.shared)]);
  await x.cmd(['HSET', keys.blockVersion(r), 'rev-old|pid-old-1|SAMPLE_REVIEW', '1|ADDED']);
  await x.cmd(['PEXPIRE', keys.blockVersion(r), String(ttl.block_version)]);
  return ttl;
}

const zmembers = async (x: LabelWorld, k: string) => ((await x.cmd(['ZRANGE', k, '0', '-1', 'WITHSCORES'])) as unknown[]).flat().map(String);
const smembers = async (x: LabelWorld, k: string) => ((await x.cmd(['SMEMBERS', k])) as unknown[]).map(String).sort();
const near = (actual: number, expected: number, slackMs = 1_000) => {
  expect(actual).toBeGreaterThan(expected - slackMs);
  expect(actual).toBeLessThanOrEqual(expected + slackMs);
};
const oldKeys = (name: string, ev = 'ev-1') => {
  const r = oldRef(name);
  return [keys.devAccounts(r), keys.devHistory(r), keys.block(r), keys.devShare(r, ev), keys.blockVersion(r)];
};
const existing = async (x: LabelWorld, ks: string[]) => {
  const out: string[] = [];
  for (const k of ks) if (Number(await x.cmd(['EXISTS', k])) === 1) out.push(k);
  return out;
};

describe('B-T26 기기 라벨 키 회전의 이음', () => {
  beforeEach(() => reset(w));

  test('B-T26①_이음기간의사전검증은옛판키를남은수명(±1초)그대로새판키로옮기고옛판키를지운다_이어달기는이음끝까지있다', async () => {
    const ttl = await seedOld(w, 'm1');
    const before = { accounts: await zmembers(w, keys.devAccounts(oldRef('m1'))), history: await w.hash(keys.devHistory(oldRef('m1'))), blkv: await w.hash(keys.blockVersion(oldRef('m1'))) };
    // pid가 없는 판정은 응답 뒤 쓰기가 없어 옮긴 수명을 그대로 볼 수 있다
    expect(await w.scoreRisk({ pid: '', device_id: dev('m1') })).toMatchObject({ verdict: 'VERDICT_ALLOW', degraded: false });
    const n = newRef('m1');
    expect(n).toMatch(/^k2\./);
    expect(await existing(w, oldKeys('m1'))).toEqual([]);
    expect(await zmembers(w, keys.devAccounts(n))).toEqual(before.accounts);
    expect(await w.hash(keys.devHistory(n))).toEqual(before.history);
    expect(await smembers(w, keys.devShare(n, 'ev-1'))).toEqual(['pid-share-1']);
    expect(await w.hash(keys.blockVersion(n))).toEqual(before.blkv);
    near(await w.pttl(keys.devAccounts(n)), ttl.accounts);
    near(await w.pttl(keys.devHistory(n)), ttl.history);
    near(await w.pttl(keys.devShare(n, 'ev-1')), ttl.shared);
    near(await w.pttl(keys.blockVersion(n)), ttl.block_version);
    // 차단 키는 옛 판에 없었으므로 새 판에도 없다
    expect(await w.cmd(['EXISTS', keys.block(n)])).toBe(0);
    // 옛 판 값 → 새 판 값의 이어 달기가 이음 끝까지 있다
    expect(await w.cmd(['GET', keys.refNext(oldRef('m1'))])).toBe(n);
    near(await w.pttl(keys.refNext(oldRef('m1'))), UNTIL - T0, 2_000);
    expect(seenOf(w).filter((s) => s.startsWith('migrate:')).sort()).toEqual(['migrate:accounts:moved', 'migrate:block_version:moved', 'migrate:history:moved', 'migrate:shared:moved']);
  });

  test('B-T26①_옮긴차단키는값과수명이그대로이고_그판정은CHALLENGE(DEVICE_HISTORY)다', async () => {
    const ttl = await seedOld(w, 'm2', { block: true });
    const r = await w.scoreRisk({ pid: 'pid-m2', device_id: dev('m2') });
    expect(r).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY', degraded: false });
    const n = newRef('m2');
    expect(await w.cmd(['GET', keys.block(n)])).toBe(BLOCK_VALUE);
    near(await w.pttl(keys.block(n)), ttl.block);
    expect(await existing(w, oldKeys('m2'))).toEqual([]);
    expect(seenOf(w)).toContain('hard:BLOCK_LIST');
    // 판정 근거 키는 새 판 기기 가명을 적는다
    expect(JSON.parse(String(await w.cmd(['GET', keys.evidence('pid-m2', 'ev-1')])))).toMatchObject({ deviceRef: n, hardSignal: 'BLOCK_LIST' });
  });

  test('B-T26②⑧_새판키가이미있으면옛판키로덮지않는다_차단키만옛판키를지우고이어달기를두며_다른키는옛판키를둔다', async () => {
    await seedOld(w, 'm3', { block: true });
    const n = newRef('m3');
    const NEW_BLOCK = JSON.stringify({ reason: 'FRAUD_CONFIRMED', source: 'FRAUD_CONFIRMED', caseId: 'cs-new', listedAtMs: T0 });
    await w.cmd(['ZADD', keys.devAccounts(n), String(T0), 'pid-new-only']);
    await w.cmd(['PEXPIRE', keys.devAccounts(n), String(10 * DAY)]);
    await w.cmd(['HSET', keys.devHistory(n), `passed:${today}`, '4']);
    await w.cmd(['PEXPIRE', keys.devHistory(n), String(10 * DAY)]);
    await w.cmd(['SET', keys.block(n), NEW_BLOCK, 'PX', String(10 * DAY)]);
    await w.cmd(['SADD', keys.devShare(n, 'ev-1'), 'pid-new-share']);
    await w.cmd(['PEXPIRE', keys.devShare(n, 'ev-1'), '600000']);
    await w.cmd(['HSET', keys.blockVersion(n), 'cs-new|pid-x|FRAUD_CONFIRMED', '1|ADDED']);
    await w.cmd(['PEXPIRE', keys.blockVersion(n), String(10 * DAY)]);
    await w.scoreRisk({ pid: '', device_id: dev('m3') });
    expect(await zmembers(w, keys.devAccounts(n))).toEqual(['pid-new-only', String(T0)]);
    expect(await w.hash(keys.devHistory(n))).toEqual({ [`passed:${today}`]: '4', [`sent:${today}`]: '1' });
    expect(await w.cmd(['GET', keys.block(n)])).toBe(NEW_BLOCK);
    expect(await smembers(w, keys.devShare(n, 'ev-1'))).toEqual(['pid-new-share']);
    expect(await w.hash(keys.blockVersion(n))).toEqual({ 'cs-new|pid-x|FRAUD_CONFIRMED': '1|ADDED' });
    // 차단 키는 새 판으로 이미 막고 있어 잃는 것이 없다: 옛 판 차단 키를 지우고 이어 달기를 둔다. 다른 키는 건너뛰고 옛 판 키를 둔다
    expect(await existing(w, oldKeys('m3'))).toEqual(oldKeys('m3').filter((k) => !k.startsWith('tr:block:')));
    expect(await w.cmd(['GET', keys.refNext(oldRef('m3'))])).toBe(n);
    expect(seenOf(w).filter((s) => s.startsWith('migrate:')).sort()).toEqual(['migrate:accounts:skipped', 'migrate:block:skipped', 'migrate:block_version:skipped', 'migrate:history:skipped', 'migrate:shared:skipped']);
  });

  test('B-T26③_이음끝바로전에는옮기고_이음끝이되면옛판키를보지않는다', async () => {
    const at = (now: number) => {
      const c = fakeClock({ now });
      return { clock: c, devices: deviceRefsFromEnv(rotatedEnv(T0 + 60_000), c).refs };
    };
    // 이음 끝 1ms 전: 옮긴다
    const before = at(T0 + 60_000 - 1);
    const x = await labelWorld(valkey.url, before);
    try {
      await reset(x);
      await seedOld(x, 'm4');
      await x.scoreRisk({ pid: '', device_id: dev('m4') });
      expect(await existing(x, oldKeys('m4'))).toEqual([]);
      const n = before.devices.ref(dev('m4'))!;
      expect(await existing(x, [keys.devAccounts(n), keys.devHistory(n), keys.devShare(n, 'ev-1'), keys.blockVersion(n)])).toHaveLength(4);
      // 이어 달기의 수명은 이음 끝까지(여기서는 1ms)라 곧 사라진다. 옮겼다는 것은 지표로 본다
      expect(seenOf(x).filter((s) => s.endsWith(':moved'))).toHaveLength(4);
    } finally {
      await x.close();
    }
    // 이음 끝: 옛 판을 보지 않는다
    const after = at(T0 + 60_000);
    const y = await labelWorld(valkey.url, after);
    try {
      await reset(y);
      await seedOld(y, 'm5');
      await y.scoreRisk({ pid: '', device_id: dev('m5') });
      expect(await existing(y, oldKeys('m5'))).toEqual(oldKeys('m5').filter((k) => !k.startsWith('tr:block:')));
      const n = after.devices.ref(dev('m5'))!;
      expect(await existing(y, [keys.devAccounts(n), keys.devHistory(n), keys.blockVersion(n)])).toEqual([]);
      expect(await y.cmd(['EXISTS', keys.refNext(oldRef('m5'))])).toBe(0);
      expect(seenOf(y).filter((s) => s.startsWith('migrate:'))).toEqual([]);
    } finally {
      await y.close();
    }
  });

  test('B-T26③_옛판이없는라벨키링은옛판키를보지않는다', async () => {
    const x = await labelWorld(valkey.url, { clock, devices: devicesV2Only });
    try {
      await reset(x);
      await seedOld(x, 'm6', { block: true });
      // 옛 판 차단 키가 있어도 새 판만 보므로 차단 목록 신호가 없다
      expect(await x.scoreRisk({ pid: '', device_id: dev('m6') })).toMatchObject({ verdict: 'VERDICT_ALLOW' });
      expect(await existing(x, oldKeys('m6'))).toEqual(oldKeys('m6'));
      expect(await x.cmd(['EXISTS', keys.refNext(oldRef('m6'))])).toBe(0);
    } finally {
      await x.close();
    }
  });

  test('[ASVS v5.0.0-16.3.4] B-T26④_옮기기가실패하면그피처는값없음이고degraded가참이며_판정은이어지고_옛판키는남는다', async () => {
    // 기기 이력을 새 판으로 되살리는 명령만 실패시킨다(실제 Valkey, 나머지 명령은 그대로)
    const failRestore = (r: HotRedis): HotRedis => ({
      ...r,
      command: async (args, o) => {
        if (args[0] === 'RESTORE' && String(args[1]).startsWith('tr:devhist:')) throw new Error('주입한 장애');
        return r.command(args, o);
      },
    });
    const x = await labelWorld(valkey.url, { clock, devices: rotated, wrap: failRestore });
    try {
      await reset(x);
      // 옛 판 이력에는 실패 5번이 있다(옮겼다면 DeviceTrust가 위험 1로 CHALLENGE다)
      await seedOld(x, 'm7', { failed: 5 });
      const r = await x.scoreRisk({ pid: '', device_id: dev('m7') });
      expect(r).toMatchObject({ verdict: 'VERDICT_ALLOW', degraded: true });
      const n = newRef('m7');
      expect(await x.cmd(['EXISTS', keys.devHistory(oldRef('m7'))])).toBe(1);
      expect(await x.cmd(['EXISTS', keys.devHistory(n)])).toBe(0);
      expect(await x.cmd(['EXISTS', keys.devAccounts(oldRef('m7'))])).toBe(0);
      expect(await x.cmd(['EXISTS', keys.devAccounts(n)])).toBe(1);
      expect(seenOf(x)).toEqual(expect.arrayContaining(['migrate:history:failed', 'migrate:accounts:moved', 'feature:history']));
      expect(seenOf(x)).not.toContain('migrate:history:moved');
      // 다른 피처는 옮겨졌으므로 이어 달기가 있다
      expect(await x.cmd(['GET', keys.refNext(oldRef('m7'))])).toBe(n);
      expect(x.verdictLog.at(-1)).toMatchObject({ degraded: true, verdict: 'ALLOW' });
    } finally {
      await x.close();
    }
  });

  test('[ASVS v5.0.0-16.3.4] B-T26④_옛판키를읽는일이모두실패해도판정은이어지고_기기피처는값없음이다', async () => {
    const failDump = (r: HotRedis): HotRedis => ({
      ...r,
      evalScript: async (s, k, a, o) => {
        if (k[0]?.includes(`{${oldRef('m8')}}`)) throw new Error('주입한 장애');
        return r.evalScript(s, k, a, o);
      },
    });
    const x = await labelWorld(valkey.url, { clock, devices: rotated, wrap: failDump });
    try {
      await reset(x);
      await seedOld(x, 'm8', { block: true });
      const r = await x.scoreRisk({ pid: 'pid-m8', device_id: dev('m8') });
      // 옛 판 차단 키를 옮기지 못했으므로 차단 목록 신호 없이 다른 신호로 판정한다
      expect(r).toMatchObject({ verdict: 'VERDICT_ALLOW', degraded: true });
      expect(seenOf(x).filter((s) => s.endsWith(':failed')).sort()).toEqual(['migrate:accounts:failed', 'migrate:block:failed', 'migrate:block_version:failed', 'migrate:history:failed', 'migrate:shared:failed']);
      expect(seenOf(x)).toEqual(expect.arrayContaining(['feature:accounts', 'feature:history', 'feature:block', 'feature:shared']));
      expect(seenOf(x)).toContain('missing:DeviceTrust:dependency');
      expect(await existing(x, oldKeys('m8'))).toEqual(oldKeys('m8'));
    } finally {
      await x.close();
    }
  });

  test('B-T26⑤_옛판기기가명의판정근거로온이의인정이이어달기를따라새판차단키를지운다', async () => {
    // 회전 전(k1만): 차단 목록에 오르고 그 기기로 받은 판정의 근거는 옛 판 기기 가명이다
    const v1 = await labelWorld(valkey.url, { clock });
    try {
      await reset(v1);
      v1.human.set('FAILED');
      const k = (await v1.scoreRisk({ pid: 'pid-e', device_id: dev('e'), event_id: 'ev-0' })).eventKey;
      v1.human.set('PASSED');
      expect(await v1.applyLabel({ source_ref: 'rev-e', pid: 'pid-e', event_id: 'ev-0', verdict_event_key: k })).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_ADDED' });
      await v1.scoreRisk({ pid: 'pid-e', device_id: dev('e'), event_id: 'ev-1' });
      expect(JSON.parse(String(await v1.cmd(['GET', keys.evidence('pid-e', 'ev-1')])))).toMatchObject({ deviceRef: oldRef('e'), hardSignal: 'BLOCK_LIST' });
    } finally {
      await v1.close();
    }
    // 회전 뒤(이음 기간): 다음 판정이 옮긴다
    expect(await w.scoreRisk({ pid: 'pid-e', device_id: dev('e'), event_id: 'ev-2' })).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY' });
    expect(await w.cmd(['EXISTS', keys.block(oldRef('e'))])).toBe(0);
    expect(await w.cmd(['EXISTS', keys.block(newRef('e'))])).toBe(1);
    expect(await w.cmd(['GET', keys.refNext(oldRef('e'))])).toBe(newRef('e'));
    near(await w.pttl(keys.refNext(oldRef('e'))), UNTIL - T0, 2_000);
    // 옛 판 값만 아는 판정 근거(ev-1)로 이의가 인정되면 새 판 차단 키를 지운다
    expect(await w.applyLabel({ source_ref: 'appeal-e', pid: 'pid-e', event_id: 'ev-1', source: 'LABEL_SOURCE_APPEAL_ACCEPTED', label: 'LABEL_HUMAN', review_batch: undefined, applied_verdict: undefined })).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_REMOVED' });
    expect(await w.cmd(['EXISTS', keys.block(newRef('e'))])).toBe(0);
    expect(await w.hash(keys.blockVersion(newRef('e')))).toEqual({ [lid('rev-e', 'pid-e', 'SAMPLE_REVIEW')]: '1|ADDED', [lid('appeal-e', 'pid-e', 'APPEAL_ACCEPTED')]: '1|REMOVED' });
    expect(w.logLines.at(-1)).toMatchObject({ change: 'REMOVED', caseId: 'appeal-e', source: 'APPEAL_ACCEPTED' });
  });

  test('B-T26⑤_이어달기의수명은이음끝까지다(이음끝이7일뒤면7일)', async () => {
    const until7 = T0 + 7 * DAY;
    const x = await labelWorld(valkey.url, { clock, devices: deviceRefsFromEnv(rotatedEnv(until7), clock).refs });
    try {
      await reset(x);
      await seedOld(x, 'm44', { block: true });
      await x.scoreRisk({ pid: '', device_id: dev('m44') });
      expect(await x.cmd(['GET', keys.refNext(oldRef('m44'))])).toBe(newRef('m44'));
      near(await x.pttl(keys.refNext(oldRef('m44'))), until7 - T0);
    } finally {
      await x.close();
    }
  });

  test('B-T26⑥_로그인·추가검증제출은옮기지않는다', async () => {
    await seedOld(w, 'm9', { block: true });
    await w.scoreRisk({ context: 'SCORE_CONTEXT_LOGIN', event_id: '', pid: '', device_id: dev('m9'), human_check_token: '', lobby_shuffle: undefined, journey_id: '' });
    await w.scoreRisk({ context: 'SCORE_CONTEXT_VERIFICATION', pid: 'pid-m9', device_id: dev('m9'), lobby_shuffle: undefined, journey_id: '' });
    expect(await existing(w, oldKeys('m9'))).toEqual(oldKeys('m9'));
    expect(await w.cmd(['EXISTS', keys.refNext(oldRef('m9'))])).toBe(0);
    expect(await w.cmd(['EXISTS', keys.block(newRef('m9'))])).toBe(0);
    expect(seenOf(w).filter((s) => s.startsWith('migrate:'))).toEqual([]);
    // 같은 기기의 다음 사전 검증이 옮긴다. 추가 검증 제출이 새 판 기기 이력을 먼저 만들었으므로 그 키만 건너뛴다(덮지 않는다)
    await w.scoreRisk({ pid: '', device_id: dev('m9') });
    expect(await existing(w, oldKeys('m9'))).toEqual([keys.devHistory(oldRef('m9'))]);
    expect(await w.cmd(['GET', keys.block(newRef('m9'))])).toBe(BLOCK_VALUE);
  });

  /** 회전 전(k1만)의 세계에서: 사람 확인 실패 판정(ev-0) → 표본 검토 BOT으로 목록에 올림 → 그 기기로 받은 판정(ev-1)의 근거는 옛 판 기기 가명·차단 목록 */
  async function listedBeforeRotation(pid: string, name: string) {
    const v1 = await labelWorld(valkey.url, { clock });
    try {
      v1.human.set('FAILED');
      const k = (await v1.scoreRisk({ pid, device_id: dev(name), event_id: 'ev-0' })).eventKey;
      v1.human.set('PASSED');
      expect(await v1.applyLabel({ source_ref: `rev-${name}`, pid, event_id: 'ev-0', verdict_event_key: k })).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_ADDED' });
      expect(await v1.scoreRisk({ pid, device_id: dev(name), event_id: 'ev-1' })).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY' });
      expect(JSON.parse(String(await v1.cmd(['GET', keys.evidence(pid, 'ev-1')])))).toMatchObject({ deviceRef: oldRef(name), hardSignal: 'BLOCK_LIST' });
    } finally {
      await v1.close();
    }
  }
  const appealOf = (x: LabelWorld, sourceRef: string, pid: string, event: string) => x.applyLabel({ source_ref: sourceRef, pid, event_id: event, source: 'LABEL_SOURCE_APPEAL_ACCEPTED', label: 'LABEL_HUMAN', review_batch: undefined, applied_verdict: undefined });
  const waitReady = async (r: HotRedis) => {
    for (let i = 0; ; i++) {
      try {
        await r.command(['PING'], { deadlineMs: 500 });
        return;
      } catch (e) {
        if (i > 50) throw e;
        await new Promise((res) => setTimeout(res, 100));
      }
    }
  };

  test('B-T26⑦_옮기는사이라벨반영이옛판차단키를지우면되살린새판키를되돌리고_그사람은다시걸리지않는다', async () => {
    await listedBeforeRotation('pid-g', 'g');
    // 새 판 차단 키를 되살리기(RESTORE) 직전에 멈춘다: 옛 판 키는 이미 읽었다
    let release!: () => void;
    let reached!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const at = new Promise<void>((r) => (reached = r));
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      command: async (args, o) => {
        if (args[0] === 'RESTORE' && args[1] === keys.block(newRef('g'))) {
          reached();
          await hold;
        }
        return r.command(args, o);
      },
    });
    const x = await labelWorld(valkey.url, { clock, devices: rotated, wrap });
    try {
      const judging = x.scoreRisk({ pid: 'pid-g', device_id: dev('g'), event_id: 'ev-2' });
      await at;
      // 그 사이 옛 판 판정 근거로 이의가 인정된다(이어 달기는 아직 없어 옛 판 차단 키를 지운다)
      expect(await appealOf(x, 'ap-g', 'pid-g', 'ev-1')).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_REMOVED' });
      release();
      expect(await judging).toMatchObject({ verdict: 'VERDICT_ALLOW', degraded: true });
      expect(await x.cmd(['EXISTS', keys.block(newRef('g'))])).toBe(0);
      expect(await x.cmd(['EXISTS', keys.block(oldRef('g'))])).toBe(0);
      expect(seenOf(x)).toContain('migrate:block:failed');
      // 차단 키를 옮기지 못했으므로 이어 달기를 두지 않는다
      expect(await x.cmd(['EXISTS', keys.refNext(oldRef('g'))])).toBe(0);
      // 다음 판정도 다시 걸리지 않는다
      expect(await x.scoreRisk({ pid: 'pid-g', device_id: dev('g'), event_id: 'ev-3' })).toMatchObject({ verdict: 'VERDICT_ALLOW' });
    } finally {
      release();
      await x.close();
    }
  });

  test('B-T26⑧_새판차단키가이미있으면옛판차단키를지우고이어달기를둔다_새판근거이의인정뒤다음판정이옛판키로다시걸리지않는다', async () => {
    // 옛 판 차단 키(표본 검토 S1)와 새 판 기기 가명으로 온 부정 예매 조치(F1)
    await w.cmd(['SET', keys.block(oldRef('h')), JSON.stringify({ reason: 'SAMPLE_REVIEW', source: 'SAMPLE_REVIEW', caseId: 's1', listedAtMs: T0 }), 'PX', String(60 * DAY)]);
    expect(await w.applyLabel({ source_ref: 'f1', pid: 'pid-h', source: 'LABEL_SOURCE_FRAUD_ACTIONED', device_ref: newRef('h'), review_batch: undefined, applied_verdict: undefined })).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_ADDED' });
    expect(await w.scoreRisk({ pid: 'pid-h', device_id: dev('h') })).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY' });
    expect(await w.cmd(['EXISTS', keys.block(oldRef('h'))])).toBe(0);
    expect(await w.cmd(['GET', keys.refNext(oldRef('h'))])).toBe(newRef('h'));
    expect(seenOf(w)).toContain('migrate:block:skipped');
    expect(JSON.parse(String(await w.cmd(['GET', keys.evidence('pid-h', 'ev-1')])))).toMatchObject({ deviceRef: newRef('h'), hardSignal: 'BLOCK_LIST' });
    // 새 판 근거의 이의 인정(그 사건)으로 지운다
    expect(await w.applyLabel({ source_ref: 'f1', pid: 'pid-h', source_version: 2, source: 'LABEL_SOURCE_FRAUD_APPEAL_ACCEPTED', label: 'LABEL_HUMAN', review_batch: undefined, applied_verdict: undefined })).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_REMOVED' });
    // 다음 판정이 옛 판 키로 다시 걸리지 않는다
    expect(await w.scoreRisk({ pid: 'pid-h', device_id: dev('h'), event_id: 'ev-2' })).toMatchObject({ verdict: 'VERDICT_ALLOW' });
    expect(await w.keysLike('tr:block:*')).toEqual([]);
  });

  test('[ASVS v5.0.0-16.3.4] B-T26⑨_옮기기가실패한피처는그판정의응답뒤쓰기를하지않아_장애가풀린다음판정에서옮겨진다', async () => {
    const failOnce = new Set([keys.devAccounts(newRef('m10')), keys.devHistory(newRef('m10'))]);
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      command: async (args, o) => {
        if (args[0] === 'RESTORE' && failOnce.delete(String(args[1]))) throw new Error('주입한 장애');
        return r.command(args, o);
      },
    });
    const x = await labelWorld(valkey.url, { clock, devices: rotated, wrap });
    try {
      await reset(x);
      await seedOld(x, 'm10');
      // 허니팟 표시로 CHALLENGE가 되게 해 두 응답 뒤 쓰기(기기 집합 넣기, 기기 이력 보냄 수)를 모두 부른다
      await x.cmd(['SET', keys.honeypot('pid-m10'), 'x', 'PX', '600000']);
      expect(await x.scoreRisk({ pid: 'pid-m10', device_id: dev('m10') })).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_INTERACTION', degraded: true });
      expect(failOnce.size).toBe(0);
      const n = newRef('m10');
      expect(await x.cmd(['EXISTS', keys.devAccounts(n)])).toBe(0);
      expect(await x.cmd(['EXISTS', keys.devHistory(n)])).toBe(0);
      expect(await existing(x, [keys.devAccounts(oldRef('m10')), keys.devHistory(oldRef('m10'))])).toHaveLength(2);
      // 판정 근거 키는 새 판 기기 가명으로 남는다
      expect(JSON.parse(String(await x.cmd(['GET', keys.evidence('pid-m10', 'ev-1')])))).toMatchObject({ deviceRef: n });
      // 장애가 풀린 다음 판정에서 옮긴다
      await x.cmd(['DEL', keys.honeypot('pid-m10')]);
      seenOf(x).splice(0);
      await x.scoreRisk({ pid: 'pid-m10', device_id: dev('m10'), event_id: 'ev-2' });
      expect(seenOf(x)).toEqual(expect.arrayContaining(['migrate:accounts:moved', 'migrate:history:moved']));
      expect((await zmembers(x, keys.devAccounts(n))).filter((_, i) => i % 2 === 0).sort()).toEqual(['pid-m10', 'pid-old-1', 'pid-old-2']);
      expect((await x.hash(keys.devHistory(n)))[`failed:${today}`]).toBe('1');
      expect(await existing(x, [keys.devAccounts(oldRef('m10')), keys.devHistory(oldRef('m10'))])).toEqual([]);
    } finally {
      await x.close();
    }
  });

  test('B-T26⑪_같은기기의판정둘이겹쳐도새판키는하나이고옛판키는지워진다', async () => {
    // 두 판정 모두 옛 판 키를 읽은 뒤 기기 집합의 RESTORE 두 개가 함께 닿게 한다
    let arrived = 0;
    let both!: () => void;
    const together = new Promise<void>((r) => (both = r));
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      command: async (args, o) => {
        if (args[0] === 'RESTORE' && args[1] === keys.devAccounts(newRef('m11'))) {
          arrived += 1;
          if (arrived === 2) both();
          await together;
        }
        return r.command(args, o);
      },
    });
    const x = await labelWorld(valkey.url, { clock, devices: rotated, wrap });
    try {
      await reset(x);
      await seedOld(x, 'm11', { block: true });
      const before = await zmembers(x, keys.devAccounts(oldRef('m11')));
      const [a, b] = await Promise.all([x.scoreRisk({ pid: '', device_id: dev('m11') }), x.scoreRisk({ pid: '', device_id: dev('m11') })]);
      expect(arrived).toBe(2);
      for (const r of [a, b]) expect(r).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY', degraded: false });
      const n = newRef('m11');
      expect(await zmembers(x, keys.devAccounts(n))).toEqual(before);
      expect(await x.cmd(['GET', keys.block(n)])).toBe(BLOCK_VALUE);
      expect(await existing(x, oldKeys('m11'))).toEqual([]);
      expect(seenOf(x).filter((s) => s.startsWith('migrate:accounts:')).sort()).toEqual(['migrate:accounts:moved', 'migrate:accounts:skipped']);
      expect(seenOf(x).filter((s) => s.endsWith(':failed'))).toEqual([]);
      expect(await x.cmd(['GET', keys.refNext(oldRef('m11'))])).toBe(n);
    } finally {
      await x.close();
    }
  });

  test('[ASVS v5.0.0-16.3.4] B-T26④_새판키를되살린뒤(커밋뒤)옛판키를지우기전에끊으면그피처는값없음이고_다음판정은새판키를읽는다', async () => {
    const proxy = await startTcpProxy(valkey.url);
    let armed = false;
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      command: async (args, o) => {
        const out = await r.command(args, o);
        if (armed && args[0] === 'RESTORE' && String(args[1]).startsWith('tr:devacct:')) {
          armed = false;
          proxy.cut();
          await new Promise((res) => setTimeout(res, 50));
        }
        return out;
      },
    });
    const x = await labelWorld(valkey.url, { clock, devices: rotated, serviceUrl: proxy.url, wrap });
    try {
      await reset(x);
      const o = oldRef('c4');
      await x.cmd(['ZADD', keys.devAccounts(o), String(T0 - DAY), 'pid-old-1']);
      await x.cmd(['PEXPIRE', keys.devAccounts(o), String(20 * DAY)]);
      armed = true;
      expect(await x.scoreRisk({ pid: 'pid-c4', device_id: dev('c4') })).toMatchObject({ degraded: true });
      // 끊긴 사례가 실제로 있었다: 새 판 키는 되살아났고(커밋 뒤), 옛 판 키 지우기와 이어 달기는 Valkey에 닿지 않았다
      expect(proxy.cuts).toBe(1);
      const n = newRef('c4');
      expect(await zmembers(x, keys.devAccounts(n))).toEqual(['pid-old-1', String(T0 - DAY)]);
      expect(await x.cmd(['EXISTS', keys.devAccounts(o)])).toBe(1);
      expect(await x.cmd(['EXISTS', keys.refNext(o)])).toBe(0);
      expect(seenOf(x)).toContain('migrate:accounts:failed');
      proxy.restore();
      await waitReady(x.serviceRedis);
      seenOf(x).splice(0);
      // 다음 판정: 새 판 키가 있어 건너뛰고(남는 한계: 옛 판 키는 수명까지 남는다) 새 판 키로 판정한다
      expect(await x.scoreRisk({ pid: 'pid-c4', device_id: dev('c4'), event_id: 'ev-2' })).toMatchObject({ degraded: false });
      expect(seenOf(x)).toContain('migrate:accounts:skipped');
      expect((await zmembers(x, keys.devAccounts(n))).filter((_, i) => i % 2 === 0).sort()).toEqual(['pid-c4', 'pid-old-1']);
    } finally {
      await x.close();
      await proxy.close();
    }
  });

  test('B-T27⑦_라벨반영도중키회전이그기기를새판으로옮기면_차단키Lua가바꾸지않고옮겨짐을돌려주어새판값으로다시한다', async () => {
    await listedBeforeRotation('pid-mv', 'mv');
    // 이의 인정의 차단 키 Lua(키 셋, 옛 판 기기)를 멈춘 사이 회전 판정이 그 기기를 옮긴다
    let release!: () => void;
    let reached!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const at = new Promise<void>((r) => (reached = r));
    let armed = true;
    const wrap = (r: HotRedis): HotRedis => ({
      ...r,
      evalScript: async (s, k, a, o) => {
        if (armed && k.length === 3 && k[0] === keys.block(oldRef('mv'))) {
          armed = false;
          reached();
          await hold;
        }
        return r.evalScript(s, k, a, o);
      },
    });
    const x = await labelWorld(valkey.url, { clock, devices: rotated, wrap });
    try {
      const labeling = appealOf(x, 'ap-mv', 'pid-mv', 'ev-1');
      await at;
      expect(await w.scoreRisk({ pid: 'pid-mv', device_id: dev('mv'), event_id: 'ev-2' })).toMatchObject({ verdict: 'VERDICT_CHALLENGE', reason: 'REASON_CATEGORY_DEVICE_HISTORY' });
      expect(await x.cmd(['GET', keys.refNext(oldRef('mv'))])).toBe(newRef('mv'));
      expect(await x.cmd(['EXISTS', keys.block(newRef('mv'))])).toBe(1);
      release();
      expect(await labeling).toEqual({ changed: true, block_list: 'BLOCK_LIST_CHANGE_REMOVED' });
      expect(await x.keysLike('tr:block:*')).toEqual([]);
      expect(await x.hash(keys.blockVersion(newRef('mv')))).toMatchObject({ [lid('ap-mv', 'pid-mv', 'APPEAL_ACCEPTED')]: '1|REMOVED' });
    } finally {
      release();
      await x.close();
    }
  });
});
