// 만료 차단 정리 작업(waf-block-expirer)의 한 실행과 ops-svc 정비 바퀴의 AUTO_EXPIRED 확인(BAT-360 OPS-290, ADR-0349 결정 9·10, control-tower §5 'AWS WAF API' 행, 계획 6절 B24·B25).
// 정본 값(C-T61): ① 만료가 지난 명령 4의 대역만 빠지고 ② 만료가 지났지만 만료 전 다른 명령 4도 막는 대역 ③ 명령 기록에 없는 대역 ④ 만료 전 대역은 남는다.
// ⑤ 잠금 토큰 충돌(WAFOptimisticLockException) 때는 다시 읽어 한 번 더 바꾸고 그사이 들어온 변경을 지우지 않는다. 또 실패하면 끝 코드 1(실패 결과).
// ⑥ ops-svc가 돌아오면 빠진 대역의 명령이 AUTO_EXPIRED(행위자 SYSTEM). 만료 − 1ms에는 아니고, WAF를 읽지 못하면 그대로 둔다(결정 10).
// IP 집합 둘(IPv4·IPv6)은 제품 메모리 가짜 MemoryWafIpSets(WafIpSets 포트 구현, GetIPSet·UpdateIPSet·잠금 토큰 흉내)를 쓰고, 보기 waf_block_expiry_v는 포트를 구현한 목록 가짜다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import {
  COMMAND_STORE,
  ExpireWafBlocks,
  MaintainCommands,
  MemoryCommandStore,
  MemoryWafIpSets,
  SYSTEM_ACTOR_REF,
  wafIpSetsConfigFromEnv,
  type BlockExpiryRow,
  type BlockExpiryView,
  type CommandExecutor,
} from '../src/modules/commands/index.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-23T06:00:00.000Z');
const HOUR = 60 * 60_000;

/** 보기 waf_block_expiry_v 짝 가짜(명령 4의 대역 하나마다 한 행) */
class ListExpiryView implements BlockExpiryView {
  constructor(public list: BlockExpiryRow[]) {}
  reads = 0;
  async rows(): Promise<readonly BlockExpiryRow[]> {
    this.reads += 1;
    return this.list.map((r) => ({ ...r }));
  }
}

const row = (cidr: string, expiresAtMs: number, state = 'ACKED', commandId = randomUUID()): BlockExpiryRow => ({ commandId, cidr, expiresAtMs, state });

/** C-T61 ①~④를 한 번에 둔 IP 집합 둘과 보기 */
function fixture() {
  const expired = row('198.51.100.0/24', NOW); // ① 만료 정각(지남)
  const expiredOld = row('2001:db8:1::/48', NOW - HOUR); // ① IPv6
  const sharedOld = row('192.0.2.0/25', NOW - HOUR); // ② 만료가 지났지만
  const sharedLive = row('192.0.2.0/25', NOW + HOUR); // ② 만료 전 다른 명령이 같은 대역을 막는다
  const future = row('198.51.100.128/25', NOW + 1); // ④ 만료 + 1ms 전(아직)
  const failed = row('203.0.113.64/26', NOW - HOUR, 'FAILED'); // ACKED가 아닌 명령 4
  const view = new ListExpiryView([expired, expiredOld, sharedOld, sharedLive, future, failed]);
  // ③ 명령 기록에 없는 대역 203.0.113.7/32·2001:db8:ffff::/48
  const sets = new MemoryWafIpSets({
    4: ['198.51.100.0/24', '192.0.2.0/25', '203.0.113.7/32', '198.51.100.128/25', '203.0.113.64/26'],
    6: ['2001:db8:1::/48', '2001:db8:ffff::/48'],
  });
  return { view, sets, expired, expiredOld, sharedOld, sharedLive, future, failed };
}

describe('C-T61 만료 차단 정리 작업(ADR-0349 결정 9, B24)', () => {
  test('C-T61 ①~④ 만료가 지난 대역만 빠진다: 다른 명령이 막는 대역·기록 없는 대역·만료 전 대역·ACKED 아닌 명령의 대역은 남는다', async () => {
    const f = fixture();
    const logs: Record<string, unknown>[] = [];
    const run = await new ExpireWafBlocks({ view: f.view, ipSets: f.sets, log: (_l, fields) => logs.push(fields) }).run(NOW);
    expect(run.failed).toBe(false);
    expect(f.sets.sets[4].addresses).toEqual(['192.0.2.0/25', '203.0.113.7/32', '198.51.100.128/25', '203.0.113.64/26']);
    expect(f.sets.sets[6].addresses).toEqual(['2001:db8:ffff::/48']);
    expect(run.families).toEqual([
      { family: 4, removed: ['198.51.100.0/24'], commandIds: [f.expired.commandId], retried: 0 },
      { family: 6, removed: ['2001:db8:1::/48'], commandIds: [f.expiredOld.commandId], retried: 0 },
    ]);
    // 뺀 대역과 명령 ID는 JSON 한 줄(kind waf-block-expired)
    const expiredLines = logs.filter((l) => l.kind === 'waf-block-expired');
    expect(expiredLines).toEqual([
      { kind: 'waf-block-expired', family: 'IPV4', cidrs: ['198.51.100.0/24'], commandIds: [f.expired.commandId] },
      { kind: 'waf-block-expired', family: 'IPV6', cidrs: ['2001:db8:1::/48'], commandIds: [f.expiredOld.commandId] },
    ]);
  });

  test('C-T61 ①~④ 만료 − 1ms에는 빼지 않고 정각에 뺀다, 뺄 것이 없으면 IP 집합을 바꾸지 않는다', async () => {
    const f = fixture();
    const early = await new ExpireWafBlocks({ view: new ListExpiryView([row('198.51.100.0/24', NOW)]), ipSets: f.sets }).run(NOW - 1);
    expect(early.families.map((x) => x.removed)).toEqual([[], []]);
    expect(f.sets.replaced).toEqual([]);
    const onTime = await new ExpireWafBlocks({ view: new ListExpiryView([row('198.51.100.0/24', NOW)]), ipSets: f.sets }).run(NOW);
    expect(onTime.families[0]!.removed).toEqual(['198.51.100.0/24']);
  });

  test('C-T61 ⑤ 잠금 토큰 충돌 뒤 다시 읽어 한 번 더 바꾸고, 그사이 더한 대역은 남긴다', async () => {
    const f = fixture();
    // 작업이 읽은 뒤 쓰기 전에 다른 쪽(ops-svc의 명령 4 걸기)이 대역을 더한다
    f.sets.beforeReplace = (family) => {
      if (family === 4) f.sets.put(4, [...f.sets.sets[4].addresses, '198.51.100.77/32']);
    };
    const run = await new ExpireWafBlocks({ view: f.view, ipSets: f.sets }).run(NOW);
    expect(run.failed).toBe(false);
    expect(run.families[0]).toMatchObject({ family: 4, removed: ['198.51.100.0/24'], retried: 1 });
    expect(f.sets.sets[4].addresses).toEqual(['192.0.2.0/25', '203.0.113.7/32', '198.51.100.128/25', '203.0.113.64/26', '198.51.100.77/32']);
    // 보기와 집합을 다시 읽었다(첫 실행 둘 + 다시 하나)
    expect(f.view.reads).toBe(3);
  });

  test('C-T61 ⑤ 두 번 충돌하면 그 집합은 실패(끝 코드 1)이고 IP 집합은 그대로다, WAF를 읽지 못해도 실패다', async () => {
    const f = fixture();
    f.sets.alwaysConflict = true;
    const before4 = [...f.sets.sets[4].addresses];
    const run = await new ExpireWafBlocks({ view: f.view, ipSets: f.sets }).run(NOW);
    expect(run.failed).toBe(true);
    expect(run.families[0]).toMatchObject({ family: 4, removed: [], retried: 1, error: 'lock-conflict' });
    expect(f.sets.sets[4].addresses).toEqual(before4);
    const g = fixture();
    g.sets.failReads = true;
    const down = await new ExpireWafBlocks({ view: g.view, ipSets: g.sets }).run(NOW);
    expect(down.failed).toBe(true);
    expect(down.families.every((x) => x.error !== undefined && x.removed.length === 0)).toBe(true);
    expect(g.sets.replaced).toEqual([]);
  });

  test('B360-WAF ① 작업 설정: IP 집합 둘이 없으면 설정 없음(작업은 끝 코드 2), 하나만이거나 꼴이 틀리면 던지고, 흉내 끝점은 local·ci만', () => {
    expect(wafIpSetsConfigFromEnv({}, { envName: 'production' })).toBeUndefined();
    expect(() => wafIpSetsConfigFromEnv({ PEAKET_WAF_IPSET_V4: 'ops-block-v4|a1b2' }, { envName: 'production' })).toThrow(/PEAKET_WAF_IPSET_V6/);
    expect(() => wafIpSetsConfigFromEnv({ PEAKET_WAF_IPSET_V4: 'ops-block-v4', PEAKET_WAF_IPSET_V6: 'ops-block-v6|c3d4' }, { envName: 'production' })).toThrow(/PEAKET_WAF_IPSET_V4/);
    expect(() =>
      wafIpSetsConfigFromEnv({ PEAKET_WAF_IPSET_V4: 'v4|a', PEAKET_WAF_IPSET_V6: 'v6|b', PEAKET_WAF_ENDPOINT: 'http://127.0.0.1:5000' }, { envName: 'production' }),
    ).toThrow(/PEAKET_WAF_ENDPOINT/);
    expect(wafIpSetsConfigFromEnv({ PEAKET_WAF_IPSET_V4: 'v4|a', PEAKET_WAF_IPSET_V6: 'v6|b', PEAKET_WAF_SCOPE: 'CLOUDFRONT' }, { envName: 'production' })).toEqual({
      v4: { name: 'v4', id: 'a' },
      v6: { name: 'v6', id: 'b' },
      scope: 'CLOUDFRONT',
      region: 'us-east-1',
    });
  });
});

describe('C-T61 ⑥ ops-svc 정비 바퀴의 AUTO_EXPIRED(ADR-0349 결정 10, B25)', () => {
  const opened: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const s of opened.splice(0)) await s.close();
  });

  async function harness(sets: MemoryWafIpSets) {
    const clock = fakeClock({ now: NOW });
    const identity = new FakeIdentity();
    const executor: CommandExecutor = { execute: async () => ({ status: 'ACKED', ackedAtMs: clock.now() }) };
    const svc = await createService({
      name: 'ops-svc',
      module: AppModule.register({ memory: true, executor, auditChain: new MemoryAuditChain(), commandExtras: { blockIpSets: sets } }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet(),
      adminAuthz: identity,
    });
    opened.push(svc);
    const store: unknown = svc.app.get(COMMAND_STORE);
    if (!(store instanceof MemoryCommandStore)) throw new Error('메모리 조립의 명령 저장소가 아니다');
    const op = identity.ops('operator');
    const block = async (cidrs: string[], expiresAtMs: number) => {
      const r = await svc.http.inject({
        method: 'POST',
        url: '/v1/ops/commands',
        headers: { ...op, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
        payload: JSON.stringify({ type: 'BLOCK_ASN_IP', reason: '대역 차단', params: { cidrs, expiresAt: new Date(expiresAtMs).toISOString() } }),
      });
      expect(r.statusCode, r.payload).toBe(201);
      const body = JSON.parse(r.payload) as { commandId: string; state: string };
      expect(body.state).toBe('ACKED');
      return body.commandId;
    };
    const stateOf = async (id: string) => (await store.find(id))!.state;
    return { clock, store, block, stateOf, maintain: svc.app.get(MaintainCommands) };
  }

  test('C-T61 ⑥ 대역이 IP 집합에서 빠진 만료 명령은 AUTO_EXPIRED(행위자 SYSTEM)이고 만료 − 1ms에는 아니다', async () => {
    const sets = new MemoryWafIpSets({ 4: ['198.51.100.0/24'], 6: ['2001:db8:2::/48'] });
    const h = await harness(sets);
    const id = await h.block(['198.51.100.0/24', '2001:db8:2::/48'], NOW + HOUR);
    // 정리 작업이 먼저 뺐어도(집합에 없음) 만료 − 1ms에는 적지 않는다
    sets.put(4, []);
    sets.put(6, []);
    h.clock.advance(HOUR - 1);
    await h.maintain.runOnce(h.clock.now());
    expect(await h.stateOf(id)).toBe('ACKED');
    h.clock.advance(1);
    const round = await h.maintain.runOnce(h.clock.now());
    expect(round.blocksExpired).toBe(1);
    expect(await h.stateOf(id)).toBe('AUTO_EXPIRED');
    const last = h.store.eventsOf(id).at(-1)!;
    expect(last).toMatchObject({ type: 'AUTO_EXPIRED', actorRef: SYSTEM_ACTOR_REF, actorRole: 'system' });
  });

  test('C-T61 ⑥ 대역이 아직 IP 집합에 있으면 그대로 두고, 만료 전 다른 명령 4가 같은 대역을 막으면 AUTO_EXPIRED다', async () => {
    const sets = new MemoryWafIpSets({ 4: ['192.0.2.0/25', '203.0.113.0/26'] });
    const h = await harness(sets);
    const stillBlocked = await h.block(['192.0.2.0/25'], NOW + HOUR);
    const superseded = await h.block(['203.0.113.0/26'], NOW + HOUR);
    h.clock.advance(30 * 60_000);
    const cover = await h.block(['203.0.113.0/26'], NOW + 3 * HOUR);
    h.clock.advance(30 * 60_000);
    await h.maintain.runOnce(h.clock.now());
    expect(await h.stateOf(stillBlocked)).toBe('ACKED');
    expect(await h.stateOf(superseded)).toBe('AUTO_EXPIRED');
    expect(await h.stateOf(cover)).toBe('ACKED');
  });

  test('C-T61 ⑥ WAF IP 집합을 읽지 못하면 만료가 지났어도 그대로 두고 다음 바퀴에 다시 본다', async () => {
    const sets = new MemoryWafIpSets({ 4: [] });
    const h = await harness(sets);
    const id = await h.block(['198.51.100.0/24'], NOW + HOUR);
    sets.failReads = true;
    h.clock.advance(HOUR);
    await h.maintain.runOnce(h.clock.now());
    expect(await h.stateOf(id)).toBe('ACKED');
    sets.failReads = false;
    await h.maintain.runOnce(h.clock.now() + 1);
    expect(await h.stateOf(id)).toBe('AUTO_EXPIRED');
  });
});
