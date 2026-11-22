// F-02-2(OPS-310) admission-ctrl 받는 쪽: 명령 6 대체 결제사 전환(CONTROL_KIND_PG_SWITCH)을 리더만 세대 확인 Lua로 대기열 Redis에 쓴다(실제 Valkey 8.1).
// 정본: ADR-0366 결정 4(바라는 상태 {"switched", "pgKey": 글|null, "pgTps": 정수|null}, 켤 때 둘 다 있음·끌 때 둘 다 null. 회차 범위는 q:{event:E}:ctl,
// 전체 범위는 q:{admission}:ctl의 pgKey·pgTps, 판·명령 칸 pgRev·pgCmd는 지울 때도 남김, 쓰기는 ADR-0365 결정 5의 리더 세대 확인 Lua 하나),
// ADR-0365 결정 1·5(판이 칸의 판보다 클 때만, 같거나 작으면 지금 판을 답함), 계획 6절 B10, 13절(다른 칸 target·paused·suspended·allPaused 그대로).
// 두 갈래(F-02-1의 f021-leader-control과 같은 방법):
//   (가) 시작 함수(src/start.ts)가 연 제어 포트로 보낸다(로컬·CI 시작은 메모리 Lease라 이 프로세스 하나가 리더다).
//   (나) 낮은 세대의 파드: 모듈 공개 면의 ApplyLeaderControl을 진짜 저장소(RedisLeaderStore, 실제 Lua)·진짜 펜싱 표시(AdmissionLeader)와 Lease 세대 짝 가짜로 부른다.
// 시험 값의 상한·판은 코드 상수와 다르게 고른다(판은 9 → 10 두 자리).
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createHotRedis, fakeClock, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RedisLeaderStore } from '../src/modules/leader/adapters/redis-leader-store.js';
import { AdmissionLeader, ApplyLeaderControl, type ApplyLeaderControlInput, type Elector } from '../src/modules/leader/index.js';
import { start, type StartedService } from '../src/start.js';
import { type ApplyRequest, type ControlClient, controlClient, freePort, status, until } from '../../queue-svc/test-int/control-client.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const POD = 'admission-f022-a';
const KIND = 'CONTROL_KIND_PG_SWITCH';
let valkey: ValkeyContainer;
let redis: HotRedis;
let svc: StartedService | undefined;
let control: ControlClient;
let resultDir: string;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  resultDir = await mkdtemp(join(tmpdir(), 'peaket-f022-adm-'));
  const controlPort = await freePort();
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_POD: POD,
      HOSTNAME: POD,
      PEAKET_QUEUE_REDIS_URL: valkey.url,
      PEAKET_BATCH_RESULT_DIR: resultDir,
      PEAKET_TEST_BATCH_RANDOMNESS: Buffer.alloc(32, 5).toString('base64'),
      PEAKET_ADMISSION_CONTROL_GRPC_PORT: String(controlPort),
      PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(await freePort()),
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'fatal',
    },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  control = controlClient(`127.0.0.1:${controlPort}`);
  const probe = randomUUID();
  let v = 1;
  await until(
    async () =>
      control.apply({ commandId: randomUUID(), scope: probe, kind: 'CONTROL_KIND_ADMISSION_PAUSE', version: v++, desiredStateJson: '{"paused":false,"expiresAtMs":null}' }).then(
        () => 'leader',
        (e: { code?: number; details?: string }) => `${e.code}:${e.details}`,
      ),
    (s) => s === 'leader',
    'admission-ctrl 리더 되기(제어 포트)',
    { timeoutMs: 30_000 },
  );
}, 180_000);

afterAll(async () => {
  control?.close();
  await svc?.close();
  await redis?.close();
  valkey?.stop();
  if (resultDir) await rm(resultDir, { recursive: true, force: true });
});

const ctl = (e: string) => `q:{event:${e}}:ctl`;
const platformCtl = 'q:{admission}:ctl';
async function hash(key: string): Promise<Record<string, string>> {
  const raw = (await redis.command(['HGETALL', key], { key })) as unknown;
  if (Array.isArray(raw)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) o[String(raw[i])] = String(raw[i + 1]);
    return o;
  }
  return Object.fromEntries(Object.entries((raw ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}
const exists = async (key: string) => Number(await redis.command(['EXISTS', key], { key }));
const on = (pgKey: string, pgTps: number) => JSON.stringify({ switched: true, pgKey, pgTps });
const off = JSON.stringify({ switched: false, pgKey: null, pgTps: null });
const req = (o: Partial<ApplyRequest> & Pick<ApplyRequest, 'scope' | 'desiredStateJson'>): ApplyRequest => ({ commandId: randomUUID(), version: 1_000, kind: KIND, ...o });

describe('F022-ADM admission-ctrl PG_SWITCH 칸 (B10, ADR-0366 결정 4)', () => {
  test('F022-ADM ⑤ 회차 범위 켜기는 q:{event:E}:ctl에 pgKey·pgTps·pgRev·pgCmd를 쓰고, 이 파드 이름과 그 판을 답한다', async () => {
    const e = randomUUID();
    const cmd = randomUUID();
    const ack = await control.apply(req({ scope: e, version: 9, commandId: cmd, desiredStateJson: on('PORTONE', 37) }));
    expect(ack).toMatchObject({ appliedVersion: 9, podName: POD });
    const row = await hash(ctl(e));
    expect({ pgKey: row.pgKey, pgTps: row.pgTps, pgRev: row.pgRev, pgCmd: row.pgCmd }).toEqual({ pgKey: 'PORTONE', pgTps: '37', pgRev: '9', pgCmd: cmd });
    // 리더 루프가 읽는 값에도 그 결제사가 보인다
    expect(await new RedisLeaderStore(redis).control(e, Date.now())).toMatchObject({ pgKey: 'PORTONE', pgTps: 37 });
  });

  test('F022-ADM ⑥ 판은 수로 엄격 비교한다: 9 다음 10이 이기고, 늦은 9와 같은 판 10은 칸을 바꾸지 않고 지금 판 10을 답한다', async () => {
    const e = randomUUID();
    await control.apply(req({ scope: e, version: 9, desiredStateJson: on('PORTONE', 37) }));
    const ten = randomUUID();
    expect((await control.apply(req({ scope: e, version: 10, commandId: ten, desiredStateJson: on('TOSS', 21) }))).appliedVersion).toBe(10);
    expect((await control.apply(req({ scope: e, version: 9, desiredStateJson: on('PORTONE', 99) }))).appliedVersion).toBe(10);
    expect((await control.apply(req({ scope: e, version: 10, desiredStateJson: off }))).appliedVersion).toBe(10);
    const row = await hash(ctl(e));
    expect({ pgKey: row.pgKey, pgTps: row.pgTps, pgRev: row.pgRev, pgCmd: row.pgCmd }).toEqual({ pgKey: 'TOSS', pgTps: '21', pgRev: '10', pgCmd: ten });
  });

  test('F022-ADM ⑦ 끄기는 pgKey·pgTps 두 칸만 지우고 pgRev·pgCmd는 새 판·명령으로 남기며, 다른 종류의 칸(target·paused·suspended)은 그대로다', async () => {
    const e = randomUUID();
    const until15 = Date.now() + 15 * 60_000;
    await control.apply({ commandId: randomUUID(), scope: e, kind: 'CONTROL_KIND_ADMISSION_TARGET', version: 4_000, desiredStateJson: JSON.stringify({ target: 2_300, untilMs: until15 }) });
    await control.apply({ commandId: randomUUID(), scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', version: 4_100, desiredStateJson: '{"paused":true}' });
    await redis.command(['HSET', ctl(e), 'suspended', '1'], { key: ctl(e) });
    await control.apply(req({ scope: e, version: 9, desiredStateJson: on('PORTONE', 37) }));
    const before = await hash(ctl(e));
    const offCmd = randomUUID();
    expect((await control.apply(req({ scope: e, version: 10, commandId: offCmd, desiredStateJson: off }))).appliedVersion).toBe(10);
    const after = await hash(ctl(e));
    expect(after.pgKey, '끄면 pgKey를 지운다').toBeUndefined();
    expect(after.pgTps, '끄면 pgTps를 지운다').toBeUndefined();
    expect({ pgRev: after.pgRev, pgCmd: after.pgCmd }).toEqual({ pgRev: '10', pgCmd: offCmd });
    const untouched = (h: Record<string, string>) => ({ target: h.target, targetUntil: h.targetUntil, targetRev: h.targetRev, paused: h.paused, pausedRev: h.pausedRev, suspended: h.suspended });
    expect(untouched(after)).toEqual(untouched(before));
    expect(untouched(after)).toEqual({ target: '2300', targetUntil: String(until15), targetRev: '4000', paused: '1', pausedRev: '4100', suspended: '1' });
    expect(await new RedisLeaderStore(redis).control(e, Date.now())).not.toHaveProperty('pgKey');
  });

  test('F022-ADM ⑧ 전체 범위는 q:{admission}:ctl의 pgKey·pgTps·pgRev·pgCmd이고 회차 키를 만들지 않으며 allPaused·autoStopped 칸은 그대로다', async () => {
    const stop = randomUUID();
    await control.apply({ commandId: stop, scope: 'PLATFORM', kind: 'CONTROL_KIND_AUTOMATION_STOP', version: 2_000_000_000_000, desiredStateJson: '{"stopped":true}' });
    const before = await hash(platformCtl);
    const cmd = randomUUID();
    const version = 2_000_000_000_001;
    expect((await control.apply(req({ scope: 'PLATFORM', version, commandId: cmd, desiredStateJson: on('PG_FALLBACK', 12) }))).appliedVersion).toBe(version);
    const row = await hash(platformCtl);
    expect({ pgKey: row.pgKey, pgTps: row.pgTps, pgRev: row.pgRev, pgCmd: row.pgCmd }).toEqual({ pgKey: 'PG_FALLBACK', pgTps: '12', pgRev: String(version), pgCmd: cmd });
    expect({ autoStopped: row.autoStopped, autoStoppedRev: row.autoStoppedRev, allPaused: row.allPaused }).toEqual({ autoStopped: before.autoStopped, autoStoppedRev: before.autoStoppedRev, allPaused: before.allPaused });
    // [가정] 리더 루프가 읽는 전체 범위 값에 같은 이름으로 실린다(f022-pg-cap.test.ts 머리 주석)
    expect(await new RedisLeaderStore(redis).platformControl()).toMatchObject({ pgKey: 'PG_FALLBACK', pgTps: 12 });
    const offCmd = randomUUID();
    await control.apply(req({ scope: 'PLATFORM', version: version + 1, commandId: offCmd, desiredStateJson: off }));
    const cleared = await hash(platformCtl);
    expect([cleared.pgKey, cleared.pgTps]).toEqual([undefined, undefined]);
    expect({ pgRev: cleared.pgRev, pgCmd: cleared.pgCmd, autoStopped: cleared.autoStopped }).toEqual({ pgRev: String(version + 1), pgCmd: offCmd, autoStopped: before.autoStopped });
  });

  test.each([
    ['모르는 칸', 'EVT', '{"switched":true,"pgKey":"TOSS","pgTps":30,"ratio":50}'],
    ['switched 없음', 'EVT', '{"pgKey":"TOSS","pgTps":30}'],
    ['switched가 글', 'EVT', '{"switched":"true","pgKey":"TOSS","pgTps":30}'],
    ['켜는데 pgKey 없음', 'EVT', '{"switched":true,"pgKey":null,"pgTps":30}'],
    ['켜는데 pgTps 없음', 'EVT', '{"switched":true,"pgKey":"TOSS","pgTps":null}'],
    ['pgTps 소수', 'EVT', '{"switched":true,"pgKey":"TOSS","pgTps":30.5}'],
    ['pgTps 0', 'EVT', '{"switched":true,"pgKey":"TOSS","pgTps":0}'],
    ['pgKey 해시 태그 깨기', 'EVT', '{"switched":true,"pgKey":"TO}SS","pgTps":30}'],
    ['끄는데 pgKey 있음', 'EVT', '{"switched":false,"pgKey":"TOSS","pgTps":null}'],
    ['빈 글', 'EVT', ''],
    ['회차가 대문자 UUID', 'UPPER', '{"switched":true,"pgKey":"TOSS","pgTps":30}'],
  ])('F022-ADM ⑨ %s는 INVALID_ARGUMENT이고 쓰기 0', async (_name, scopeOf, json) => {
    const e = randomUUID();
    const scope = scopeOf === 'UPPER' ? e.toUpperCase() : e;
    const platformBefore = await hash(platformCtl);
    await expect(control.apply(req({ scope, version: 77, desiredStateJson: json }))).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await exists(ctl(e))).toBe(0);
    expect(await exists(ctl(e.toUpperCase()))).toBe(0);
    expect(await hash(platformCtl)).toEqual(platformBefore);
  });
});

describe('F022-ADM 옛 리더의 PG_SWITCH 쓰기 (B10, 9절 장애 주입 셋째)', () => {
  const applyWith = (gen: number | undefined) => {
    const box = { gen };
    const elector = { generation: () => box.gen } satisfies Elector;
    const store = new RedisLeaderStore(redis);
    const fence = new AdmissionLeader(store, { run: async () => ({ status: 'PUBLISHED' }) }, elector, fakeClock({ now: Date.now() }));
    return { fence, apply: new ApplyLeaderControl(store, elector, fence) };
  };
  const pgReq = (scope: string, version: number, json: string): ApplyLeaderControlInput => ({ commandId: randomUUID(), scope, kind: KIND as ApplyLeaderControlInput['kind'], version, desiredStateJson: json });

  test('F022-ADM ⑩ 새 리더가 선 뒤 옛 리더의 회차·전체 범위 PG_SWITCH 쓰기는 실제로 FENCED이고 칸이 그대로다(FENCED 건수 2)', async () => {
    const e = randomUUID();
    const old = applyWith(70);
    expect(await old.apply.run(pgReq(e, 100, on('PORTONE', 37)))).toMatchObject({ status: 'APPLIED', appliedVersion: 100 });
    const fresh = applyWith(71);
    await fresh.fence.tick();
    expect(await fresh.apply.run(pgReq(e, 200, on('TOSS', 21)))).toMatchObject({ status: 'APPLIED', appliedVersion: 200 });
    const eventBefore = await hash(ctl(e));
    const platformBefore = await hash(platformCtl);
    const results = [await old.apply.run(pgReq(e, 300, off)), await old.apply.run(pgReq('PLATFORM', 9_000_000_000_000, on('PORTONE', 5)))];
    expect(results.filter((r) => r.status === 'FENCED')).toHaveLength(2);
    expect(await hash(ctl(e))).toEqual(eventBefore);
    expect(eventBefore).toMatchObject({ pgKey: 'TOSS', pgTps: '21', pgRev: '200' });
    expect(await hash(platformCtl)).toEqual(platformBefore);
  });

  test('F022-ADM ⑪ 리더가 아닌 파드(세대 없음)의 PG_SWITCH는 NOT_LEADER이고 아무것도 쓰지 않는다', async () => {
    const e = randomUUID();
    expect(await applyWith(undefined).apply.run(pgReq(e, 100, on('PORTONE', 37)))).toEqual({ status: 'NOT_LEADER' });
    expect(await exists(ctl(e))).toBe(0);
  });
});
