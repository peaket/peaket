// 실측(PC): 대기열 Redis 장애 전환(Q-T13, ADR-0181)과 늦은 복제본의 쓰기 거절(min-replicas, ADR-0181 '전제'). BUILD_ORDER PRF-085 ③.
// 운영 코드 그대로(EnterQueue·RedisEntryStore·RB-05·플랫폼 HotRedis 클러스터 연결)를 주 노드 셋·복제 셋 클러스터에 돌린다.
// ① 회차 슬롯 주 노드에 min-replicas-to-write 1·max-lag 1초(정본)를 걸고 그 복제를 멈추면 진입이 대기열 Redis 일시 장애(503)가 되고, 풀면 돌아온다.
//    복제를 멈춘 뒤 주 노드가 쓰기를 거절하기까지의 시간(고립된 주 노드가 쓰기를 더 받는 시간, ADR-0181 '남은 위험')도 잰다.
// ② 진입을 초당 R건 넣는 동안 회차 키의 주 노드를 강제로 죽인다(docker kill). 죽이기 1.5초 전에 그 복제를 멈춰(죽인 뒤 바로 풀어 승격되게) 복제되지 못한
//    번호를 일부러 만든다(잃은 번호가 0이면 겹침을 볼 수 없다). 판정: 잃은 번호 > 0, 같은 세대 안 번호 중복 0, 건너뛴 구간 한 줄,
//    장애 전 세대의 번호(잃은 것 포함)는 그 구간 끝 이하, 새 세대 번호는 그 끝보다 크고, 죽인 뒤 장애 전 세대 번호가 새로 나오지 않는다.
// ③ 실제 인원이 같은 두 회차(발급 4만·건너뜀 없음 / 발급 40만·건너뛴 구간 36만)의 대기 상태 파일 한 번 만들기 시간을 견준다(ADR-0181 결정 4의 넘김).
// 결과는 test-sim/record.ts로 성능 장부 갈 자리에 쓴다(실행마다 새 번호). 쓰는 법: pnpm --filter @peaket/queue-svc sim failover
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { keys, RedisEntryStore } from '../src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../src/modules/entry/adapters/redis-event-schedules.js';
import { EnterQueue } from '../src/modules/entry/application/enter-queue.js';
import { EntryError } from '../src/modules/entry/application/entry-error.js';
import { QueueStoreUnavailable, RB05_SKIP_BASE } from '../src/modules/entry/domain/queue.js';
import { RedisStateSnapshots } from '../src/modules/state/adapters/redis-state-snapshots.js';
import { buildStateFiles } from '../src/modules/state/domain/state.js';
import { ACCOUNT, DEVICE, newRequest, openSchedule, preverifyToken, tokens } from '../test/support.js';
import { simCluster, type SimCluster } from './cluster.js';
import { nextRunId, saveRun, SIM_DAY } from './record.js';

const RATE = Number(process.env.SIM_RATE ?? 2_000);
const PRE_S = 10;
const POST_S = 40;
/** 죽이기 전에 복제를 멈추는 시간(그동안 낸 번호는 새 주 노드에 없다) */
const LAG_MS = 1_500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let c: SimCluster;
let redis: HotRedis;

beforeAll(async () => {
  c = await simCluster();
  redis = await createHotRedis({ clusterUrls: c.clusterUrls, nodeAddressMap: c.nodeAddressMap });
}, 120_000);

afterAll(async () => {
  await redis?.close().catch(() => {});
  c?.down();
});

const cmd = (key: string, args: string[]) => redis.command(args, { key });

async function open(tag: string) {
  const eventId = `sim-${tag}-${Date.now().toString(36)}`;
  const s = openSchedule(Date.now());
  const k = keys.cfg(eventId);
  await cmd(k, ['HSET', k, 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', '0', 'openBatch', '1', 'rev', '1', 'batchWindowMs', '1']);
  const enter = new EnterQueue(new RedisEntryStore(redis), new RedisEventSchedules(redis, systemClock), tokens, systemClock, { pendingTtlMs: 10_000 });
  let n = 0;
  const go = () => {
    n += 1;
    return enter.run({ accountId: ACCOUNT, pid: `pid-${tag}-${n}`, eventId, body: { preverifyToken: preverifyToken(systemClock, eventId), deviceId: DEVICE, entryRequestId: newRequest() } });
  };
  return { eventId, go };
}

test('[실측] 늦은 복제본이면 회차 슬롯 쓰기가 NOREPLICAS로 거절되어 진입이 대기열 Redis 일시 장애(503)가 되고, 복제본이 돌아오면 다시 받는다(ADR-0181 전제)', async () => {
  const startedAt = new Date().toISOString();
  const { eventId, go } = await open('minrep');
  expect((await go()).kind).toBe('TICKET');
  const { master, replica } = c.ownerOf(keys.seq(eventId));
  expect(replica).not.toBeNull();
  c.cli(master, 'CONFIG', 'SET', 'min-replicas-to-write', '1');
  c.cli(master, 'CONFIG', 'SET', 'min-replicas-max-lag', '1');
  const steps: Record<string, unknown> = { master, replica };
  try {
    // 복제를 멈춘 뒤(멈춤 명령이 돌아온 때부터) 같은 슬롯에 10ms마다 써서, 주 노드가 처음 거절하기까지의 시간을 잰다
    const probeKey = `${keys.seq(eventId)}:lag`;
    let accepted = 0;
    let rejectedAt: number | null = null;
    const cmdAt = Date.now();
    c.pause(replica!);
    const pausedAt = Date.now();
    while (Date.now() - pausedAt < 6_000) {
      try {
        await cmd(probeKey, ['SET', probeKey, String(accepted)]);
        accepted += 1;
      } catch (e) {
        if (/NOREPLICAS/.test(String((e as Error)?.message ?? ''))) {
          rejectedAt = Date.now();
          break;
        }
      }
      await sleep(10);
    }
    steps.pauseCommandMs = pausedAt - cmdAt;
    steps.acceptWindowMs = rejectedAt === null ? null : rejectedAt - pausedAt;
    steps.acceptedAfterPause = accepted;
    await sleep(Math.max(0, 4_500 - (Date.now() - pausedAt)));
    steps.direct = c.cli(master, 'SET', `${keys.seq(eventId)}:probe`, '1');
    const blocked = await go().then(
      (r) => ({ ok: r.kind }),
      (e: unknown) => ({ error: e instanceof QueueStoreUnavailable ? 'QueueStoreUnavailable' : String((e as Error)?.name), cause: String(((e as Error)?.cause as Error)?.message ?? '').slice(0, 80) }),
    );
    steps.whilePaused = blocked;
    c.unpause(replica!);
    await sleep(3_000);
    const after = await go();
    steps.afterResume = after.kind;
    const pass = String(steps.direct).startsWith('NOREPLICAS') && (blocked as { error?: string }).error === 'QueueStoreUnavailable' && after.kind === 'TICKET' && steps.acceptWindowMs !== null;
    const id = nextRunId(`${SIM_DAY}-qt13-minreplicas-notls`);
    saveRun(id, { test: 'min-replicas', steps, pass, bench: { requests: 3, error_rate: 0, dropped: 0, p99_ms: null, pass } }, {
      kpi: 'NFR-015',
      scenario: 'services/queue-svc/test-sim/failover.sim.test.ts',
      scenarioArgs: 'min-replicas-to-write 1, min-replicas-max-lag 1(정본), 복제 멈춤 4.5초, 멈춘 뒤 10ms마다 같은 슬롯 쓰기',
      redisTls: false,
      notes: `늦은 복제본이면 주 노드가 쓰기를 거절하는지(ADR-0181 전제): 회차 슬롯 주 노드에 min-replicas-to-write 1·max-lag 1초를 걸고 그 복제를 docker pause로 4.5초 멈춤. 멈춤 명령이 돌아온 뒤 거절까지 ${steps.acceptWindowMs}ms(멈춤 명령 자체 ${steps.pauseCommandMs}ms, 그동안 받은 쓰기 ${accepted}건. 이 시간은 대부분 설정값(max-lag 1초 + 복제 확인 주기 1초)이 정한다). 판정 ${pass ? '통과' : '실패'}(직접 SET ${String(steps.direct).slice(0, 40)}, 진입 ${JSON.stringify(blocked)}, 푼 뒤 ${after.kind}). 운영 코드(EnterQueue·RedisEntryStore·HotRedis 클러스터), 주 노드 셋·복제 셋 Valkey 8.1, TLS 끔(기능 확인이라)`,
    }, startedAt);
    expect(pass).toBe(true);
  } finally {
    c.unpause(replica!);
    c.cli(master, 'CONFIG', 'SET', 'min-replicas-to-write', '0');
  }
}, 60_000);

test('[실측] Q-T13 진입 중 회차 키의 주 노드를 강제로 죽여(복제되지 못한 번호를 남기고) 같은 세대 안 번호 중복이 0이고 건너뛴 구간이 한 줄이다', async () => {
  const startedAt = new Date().toISOString();
  const { eventId, go } = await open('qt13');
  const { master: owner, replica } = c.ownerOf(keys.seq(eventId));
  expect(replica).not.toBeNull();
  const tickets: Array<{ seq: number; gen: number; at: number }> = [];
  const errors: Record<string, number> = {};
  let sent = 0;
  let inflight = 0;
  let skippedTicks = 0;
  const t0 = Date.now();
  let killAt: number | null = null;
  let pauseAt: number | null = null;
  const one = async () => {
    inflight += 1;
    sent += 1;
    try {
      const r = await go();
      if (r.kind === 'TICKET') tickets.push({ seq: r.seq, gen: r.generation, at: Date.now() - t0 });
      else errors[`kind:${r.kind}`] = (errors[`kind:${r.kind}`] ?? 0) + 1;
    } catch (e) {
      const k = e instanceof EntryError ? `EntryError:${e.code}` : e instanceof QueueStoreUnavailable ? 'QueueStoreUnavailable' : `${(e as Error)?.name}:${String((e as Error)?.message).slice(0, 60)}`;
      errors[k] = (errors[k] ?? 0) + 1;
    } finally {
      inflight -= 1;
    }
  };
  // 10ms마다 R/100건(정해진 도착률). 장애 동안 쌓이지 않게 진행 중이 많으면 그 칸은 보내지 않고 센다
  const per = Math.max(1, Math.round(RATE / 100));
  await new Promise<void>((done) => {
    let tick = 0;
    const loop = () => {
      const el = Date.now() - t0;
      if (el >= (PRE_S + POST_S) * 1000) return done();
      if (pauseAt === null && el >= PRE_S * 1000 - LAG_MS) {
        pauseAt = el;
        void c.dockerAsync('pause', replica!);
      }
      if (killAt === null && el >= PRE_S * 1000) {
        killAt = el;
        // 죽인 다음에 복제를 푼다(먼저 풀면 죽기 전에 따라잡는다)
        void c.dockerAsync('kill', owner).then(() => c.dockerAsync('unpause', replica!));
      }
      while (tick * 10 <= el) {
        tick += 1;
        if (inflight > 2_000) skippedTicks += 1;
        else for (let i = 0; i < per; i += 1) void one();
      }
      setTimeout(loop, 2);
    };
    loop();
  });
  for (let i = 0; i < 100 && inflight > 0; i += 1) await sleep(100);

  const skipped = ((await cmd(keys.skipped(eventId), ['LRANGE', keys.skipped(eventId), '0', '-1'])) as unknown[]).map(String);
  const byGen = new Map<number, number[]>();
  for (const t of tickets) byGen.set(t.gen, [...(byGen.get(t.gen) ?? []), t.seq]);
  const gens = [...byGen.entries()].sort((x, y) => x[0] - y[0]).map(([gen, xs]) => {
    const s = [...xs].sort((x, y) => x - y);
    let dup = 0;
    for (let i = 1; i < s.length; i += 1) if (s[i] === s[i - 1]) dup += 1;
    return { gen, count: s.length, duplicates: dup, min: s[0]!, max: s[s.length - 1]! };
  });
  const [start, end, lineGen] = (skipped[0] ?? '').split(':').map(Number) as [number, number, number];
  const oldGen = gens.filter((g) => g.gen <= lineGen);
  const newGen = gens.filter((g) => g.gen > lineGen);
  const firstNew = tickets.filter((t) => t.gen > lineGen).reduce((m, t) => Math.min(m, t.at), Number.POSITIVE_INFINITY);
  // 죽인 뒤 200ms 넘어서 받은 장애 전 세대 대기표(새 주 노드가 RB-05 전에 옛 세대 번호를 낸 것)
  const oldGenAfterKill = tickets.filter((t) => t.gen <= lineGen && killAt !== null && t.at > killAt + 200).length;
  // 복제되지 못하고 잃은 번호 = 장애 전 세대에서 받은 가장 큰 번호 − (새 주 노드 카운터 = 구간 시작 − 1)
  const lost = oldGen.length ? Math.max(0, Math.max(...oldGen.map((g) => g.max)) - start + 1) : 0;
  const checks = {
    exercised: lost > 0,
    sameGenDuplicates: gens.reduce((x, g) => x + g.duplicates, 0),
    skippedLines: skipped.length,
    oldGenWithinSkipEnd: oldGen.every((g) => g.max <= end),
    newGenAboveSkipEnd: newGen.length > 0 && newGen.every((g) => g.min > end),
    oldGenAfterKill,
  };
  const pass = checks.exercised && checks.sameGenDuplicates === 0 && checks.skippedLines === 1 && checks.oldGenWithinSkipEnd && checks.newGenAboveSkipEnd && oldGenAfterKill === 0;
  const recoveryMs = killAt !== null && Number.isFinite(firstNew) ? firstNew - killAt : null;
  // 장애 동안의 503(대기열 일시 장애·RB-05 전)은 정본이 정한 응답이라 오류율에 넣지 않는다
  const unexpected = Object.entries(errors).filter(([k]) => k !== 'QueueStoreUnavailable' && k !== 'EntryError:QUEUE_RECOVERING').reduce((x, [, n]) => x + n, 0);
  const out = {
    test: 'Q-T13-failover',
    offered_rate: RATE,
    pre_s: PRE_S,
    post_s: POST_S,
    lag_ms: LAG_MS,
    skip_base: RB05_SKIP_BASE,
    key_owner: owner,
    replica,
    sent,
    tickets: tickets.length,
    skipped_ticks: skippedTicks,
    errors,
    pause_at_ms: pauseAt,
    kill_at_ms: killAt,
    recovery_ms: recoveryMs,
    gens,
    skipped,
    lost_numbers: lost,
    checks,
    pass,
    bench: { requests: sent, error_rate: sent ? unexpected / sent : 0, dropped: skippedTicks, p99_ms: null, pass },
  };
  const id = nextRunId(`${SIM_DAY}-qt13-failover-notls`);
  saveRun(id, out, {
    kpi: 'NFR-015',
    rps: RATE,
    duration: PRE_S + POST_S,
    scenario: 'services/queue-svc/test-sim/failover.sim.test.ts',
    scenarioArgs: `진입 ${RATE}/s, ${PRE_S}초 뒤 회차 키 주 노드 docker kill(그 ${LAG_MS / 1000}초 전부터 복제를 멈췄다가 죽인 뒤 풂), 그 뒤 ${POST_S}초`,
    redisTls: false,
    notes: `Q-T13 판정 ${pass ? '통과' : '실패'}: 잃은 번호 ${lost}(복제를 멈춰 일부러 만듦), 같은 세대 안 번호 중복 ${checks.sameGenDuplicates}, 건너뛴 구간 ${skipped.join(' ') || '없음'}, 죽인 뒤 장애 전 세대 대기표 ${oldGenAfterKill}, 회복 ${recoveryMs === null ? '없음' : `${Math.round(recoveryMs / 100) / 10}초`}(죽인 때 → 새 세대 첫 대기표), 장애 동안 503 ${(errors.QueueStoreUnavailable ?? 0) + (errors['EntryError:QUEUE_RECOVERING'] ?? 0)}건(오류율에 넣지 않음), 그 밖 오류 ${unexpected}. 운영 코드(EnterQueue·RedisEntryStore·RB-05·HotRedis 클러스터, node-redis 6.3.0 기본 토폴로지 다시 읽기), 주 노드 셋·복제 셋 Valkey 8.1(cluster-node-timeout 5초), TLS 끔(기능 확인이라), 발생기는 이 PC의 측정 프로세스 하나`,
  }, startedAt);
  console.log(JSON.stringify({ pass, checks, skipped, lost, recoveryMs, errors }));
  expect(checks.sameGenDuplicates).toBe(0);
  expect(pass).toBe(true);
}, 180_000);

test('[실측] 실제 인원이 같은 두 회차의 대기 상태 파일 만들기 시간: 건너뛴 구간 36만 번호가 있으면 얼마나 느나(ADR-0181 결정 4)', async () => {
  const startedAt = new Date().toISOString();
  const snapshots = new RedisStateSnapshots(redis);
  const measure = async (tag: string, seq: number, skipped: string | null) => {
    const eventId = `sim-file-${tag}-${Date.now().toString(36)}`;
    const s = openSchedule(Date.now());
    const k = keys.cfg(eventId);
    await cmd(k, ['HSET', k, 'opensAtMs', String(s.opensAtMs), 'startsAtMs', String(s.startsAtMs), 'lobbyShuffle', '1', 'openBatch', '1', 'rev', '1']);
    await cmd(keys.seq(eventId), ['SET', keys.seq(eventId), String(seq)]);
    await cmd(keys.serving(eventId), ['SET', keys.serving(eventId), '1000']);
    if (skipped) await cmd(keys.skipped(eventId), ['RPUSH', keys.skipped(eventId), skipped]);
    const times: number[] = [];
    // 예열 10번은 버리고 30번을 잰다
    for (let i = 0; i < 40; i += 1) {
      const t = process.hrtime.bigint();
      const files = buildStateFiles(await snapshots.read(eventId), s, Date.now());
      if (i >= 10) times.push(Number(process.hrtime.bigint() - t) / 1e6);
      expect(files.length).toBeGreaterThan(0);
    }
    times.sort((x, y) => x - y);
    return { p50_ms: Math.round(times[14]! * 100) / 100, p95_ms: Math.round(times[28]! * 100) / 100, max_ms: Math.round(times[29]! * 100) / 100 };
  };
  // 실제 진입 4만 명: 장애 전환이 없으면 발급 4만, 있으면 그 사이 36만을 건너뛰어 발급 40만
  const without = await measure('plain', 40_000, null);
  const withSkip = await measure('skip', 400_000, '20001:380000:1');
  const out = { test: 'state-file-with-skipped', real: 40_000, without: { seq: 40_000, ...without }, withSkip: { seq: 400_000, skipped: '20001:380000:1', ...withSkip }, bench: { requests: 60, error_rate: 0, dropped: 0, p99_ms: withSkip.max_ms } };
  const id = nextRunId(`${SIM_DAY}-state-file-skipped`);
  saveRun(id, out, {
    kpi: 'NFR-002',
    scenario: 'services/queue-svc/test-sim/failover.sim.test.ts',
    scenarioArgs: '실제 진입 4만: 발급 4만·건너뜀 없음 / 발급 40만·건너뛴 구간 20001~380000(36만), serving 1,000, 예열 10번 뒤 30번',
    notes: `대기 상태 파일 한 번 만들기(Redis 읽기 + buildStateFiles, 운영 코드) 시간: 건너뜀 없음(발급 4만) p50 ${without.p50_ms}ms·p95 ${without.p95_ms}ms, 건너뛴 36만(발급 40만) p50 ${withSkip.p50_ms}ms·p95 ${withSkip.p95_ms}ms(ADR-0181 결정 4: 건너뛴 만큼 매초 일이 는다). 주 노드 셋·복제 셋 Valkey 8.1, 이 PC의 측정 프로세스 하나`,
  }, startedAt);
  console.log(JSON.stringify(out));
}, 120_000);
