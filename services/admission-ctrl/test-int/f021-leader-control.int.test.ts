// F-02-1(OPS-300) admission-ctrl 받는 쪽: 명령 1·2·3·11을 리더만 세대 확인 Lua로 대기열 Redis에 쓴다(ADR-0365 결정 5·6, ADR-0056, Q-T30).
// 두 갈래로 본다(실제 Valkey 8.1).
//   (가) 시작 함수(src/start.ts)가 제어 전용 포트(PEAKET_ADMISSION_CONTROL_GRPC_PORT)를 열고, 그 포트로 보낸 명령이 q:{event:E}:ctl·q:{admission}:ctl의
//        정본 칸(target·targetUntil, admitPaused·admitPausedUntil, paused, allPaused, autoStopped, aimdResumeAt)과 종류별 판·명령 칸을 쓰는지.
//        로컬·CI 시작은 메모리 Lease라 이 프로세스 하나가 리더다. 새 리더의 등장은 리더 세대 키(q:{event:E}:leader)를 더 큰 세대로 올려 흉내 낸다
//        (새 리더의 BUMP와 같은 쓰기, test-int/leader-store.int.test.ts Q-T30과 같은 방법).
//   (나) 리더 아닌 파드(세대 없음)와 낮은 세대의 파드: 모듈 공개 면의 ApplyLeaderControl(계획 8절)을 진짜 저장소(RedisLeaderStore, 실제 Lua)·진짜 펜싱 표시
//        (리더 루프 AdmissionLeader)와 Lease 세대 짝 가짜(Elector 포트)로 부른다. run의 답(APPLIED·NOT_LEADER·FENCED)은 구현 메모 '시험 담당에게'의 꼴이다.
// 판·꼴 검사: ASVS v5.0.0-1.4.2·15.3.5·2.1.1(F-02-1 계획 9절). 장부 밖 세부는 F021-LDR(B10·B11).
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

const POD = 'admission-f021-a';
const MIN = 60_000;
let valkey: ValkeyContainer;
let redis: HotRedis;
let svc: StartedService | undefined;
let control: ControlClient;
let resultDir: string;

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  resultDir = await mkdtemp(join(tmpdir(), 'peaket-f021-adm-'));
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
  // 메모리 Lease로 리더가 될 때까지(포트가 열리고 not-leader가 아닌 답이 올 때까지) 기다린다. 시험마다 쓰지 않는 회차를 쓴다
  const probe = randomUUID();
  let v = 1;
  await until(
      async () =>
        control.apply({ commandId: randomUUID(), scope: probe, kind: 'CONTROL_KIND_ADMISSION_PAUSE', version: v++, desiredStateJson: '{"paused":false,"expiresAtMs":null}' }).then(
          () => 'leader',
          (e: { code?: number; details?: string }) => `${e.code}:${e.details}`,
        ),
    (v) => v === 'leader',
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
const leaderKey = (e: string) => `q:{event:${e}}:leader`;
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
const req = (o: Partial<ApplyRequest> & Pick<ApplyRequest, 'scope' | 'kind' | 'desiredStateJson'>): ApplyRequest => ({ commandId: randomUUID(), version: 1_000, ...o });

describe('F021-LDR admission-ctrl 리더 칸 (B10·B11, 시작 파일 조립)', () => {
  test('F021-LDR ① 명령 1은 target·targetUntil·targetRev·targetCmd를 쓰고, 되돌리기는 target을 지우고 aimdResumeAt을 쓴다', async () => {
    const e = randomUUID();
    const until = Date.now() + 15 * MIN;
    const cmd = randomUUID();
    const ack = await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_TARGET', version: 5_000, commandId: cmd, desiredStateJson: JSON.stringify({ target: 3_200, untilMs: until }) }));
    expect(ack).toMatchObject({ appliedVersion: 5_000, podName: POD });
    expect(await hash(ctl(e))).toMatchObject({ target: '3200', targetUntil: String(until), targetRev: '5000', targetCmd: cmd });
    const resumeAt = Date.now() + 2 * MIN;
    const revertCmd = randomUUID();
    expect((await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_TARGET', version: 5_001, commandId: revertCmd, desiredStateJson: JSON.stringify({ target: null, resumeAtMs: resumeAt }) }))).appliedVersion).toBe(5_001);
    const after = await hash(ctl(e));
    expect(after.target, '되돌리기는 target 칸을 지운다(ADR-0365 결정 2·6)').toBeUndefined();
    expect(after).toMatchObject({ aimdResumeAt: String(resumeAt), targetRev: '5001', targetCmd: revertCmd });
  });

  test('F021-LDR ② 명령 2는 admitPaused·admitPausedUntil·admitRev·admitCmd를 쓰고 명령 1 칸은 그대로다', async () => {
    const e = randomUUID();
    const until = Date.now() + 15 * MIN;
    await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_TARGET', version: 6_000, desiredStateJson: JSON.stringify({ target: 2_000, untilMs: until }) }));
    const expires = Date.now() + 10 * MIN;
    const cmd = randomUUID();
    expect((await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_PAUSE', version: 6_100, commandId: cmd, desiredStateJson: JSON.stringify({ paused: true, expiresAtMs: expires }) }))).appliedVersion).toBe(6_100);
    expect(await hash(ctl(e))).toMatchObject({ admitPaused: '1', admitPausedUntil: String(expires), admitRev: '6100', admitCmd: cmd, target: '2000', targetRev: '6000' });
    // 리더 루프가 읽는 값: 입장 일시정지와 목표 고정이 함께 보인다
    expect(await new RedisLeaderStore(redis).control(e, Date.now())).toMatchObject({ paused: true, target: 2_000 });
  });

  test('F021-LDR ③ 명령 3 회차 범위는 paused·pausedRev·pausedCmd, 전체 범위는 q:{admission}:ctl의 allPaused·allPausedRev·allPausedCmd다. 판매 중지 칸(suspended)은 건드리지 않는다', async () => {
    const e = randomUUID();
    const cmd = randomUUID();
    expect((await control.apply(req({ scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', version: 7_000, commandId: cmd, desiredStateJson: '{"paused":true}' }))).appliedVersion).toBe(7_000);
    const row = await hash(ctl(e));
    expect(row).toMatchObject({ paused: '1', pausedRev: '7000', pausedCmd: cmd });
    expect(row.suspended).toBeUndefined();
    const allCmd = randomUUID();
    expect((await control.apply(req({ scope: 'PLATFORM', kind: 'CONTROL_KIND_SALE_PAUSE', version: 7_100, commandId: allCmd, desiredStateJson: '{"paused":true}' }))).appliedVersion).toBe(7_100);
    expect(await hash(platformCtl)).toMatchObject({ allPaused: '1', allPausedRev: '7100', allPausedCmd: allCmd });
    expect((await control.apply(req({ scope: 'PLATFORM', kind: 'CONTROL_KIND_SALE_PAUSE', version: 7_101, desiredStateJson: '{"paused":false}' }))).appliedVersion).toBe(7_101);
    expect(await hash(platformCtl)).toMatchObject({ allPaused: '0', allPausedRev: '7101' });
  });

  test('F021-LDR ④ 명령 11은 q:{admission}:ctl의 autoStopped·autoStoppedRev·autoStoppedCmd를 쓰고 리더 루프의 platformControl이 그것을 읽는다', async () => {
    const cmd = randomUUID();
    expect((await control.apply(req({ scope: 'PLATFORM', kind: 'CONTROL_KIND_AUTOMATION_STOP', version: 8_000, commandId: cmd, desiredStateJson: '{"stopped":true}' }))).appliedVersion).toBe(8_000);
    expect(await hash(platformCtl)).toMatchObject({ autoStopped: '1', autoStoppedRev: '8000', autoStoppedCmd: cmd });
    expect(await new RedisLeaderStore(redis).platformControl()).toMatchObject({ autoStopped: true });
    expect((await control.apply(req({ scope: 'PLATFORM', kind: 'CONTROL_KIND_AUTOMATION_STOP', version: 8_001, desiredStateJson: '{"stopped":false}' }))).appliedVersion).toBe(8_001);
    expect(await new RedisLeaderStore(redis).platformControl()).toMatchObject({ autoStopped: false });
  });
});

describe('ASVS v5.0.0-1.4.2·15.3.5 admission-ctrl 판 번호 검사', () => {
  test('ASVS v5.0.0-1.4.2 ② 판 0·음수·2^53·2^53+1은 INVALID_ARGUMENT이고 아무것도 쓰지 않는다', async () => {
    const e = randomUUID();
    for (const version of [0, -1, '9007199254740992', '9007199254740993']) {
      await expect(control.apply(req({ scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', version, desiredStateJson: '{"paused":true}' })), `판 ${version}`).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    }
    expect(await exists(ctl(e))).toBe(0);
  });

  test('ASVS v5.0.0-15.3.5 ② Lua가 판을 수로 엄격 비교한다: 9 다음 10이 이기고, 늦은 9와 같은 판 10은 아무것도 바꾸지 않고 지금 판 10을 답한다', async () => {
    const e = randomUUID();
    await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_PAUSE', version: 9, desiredStateJson: '{"paused":true,"expiresAtMs":null}' }));
    const ten = randomUUID();
    expect((await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_PAUSE', version: 10, commandId: ten, desiredStateJson: '{"paused":false,"expiresAtMs":null}' }))).appliedVersion).toBe(10);
    expect((await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_PAUSE', version: 9, desiredStateJson: '{"paused":true,"expiresAtMs":null}' }))).appliedVersion).toBe(10);
    expect((await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_PAUSE', version: 10, desiredStateJson: '{"paused":true,"expiresAtMs":null}' }))).appliedVersion).toBe(10);
    expect(await hash(ctl(e))).toMatchObject({ admitPaused: '0', admitRev: '10', admitCmd: ten });
  });

  test('ASVS v5.0.0-15.3.5 ③ 종류마다 판 칸이 따로라 명령 1의 큰 판이 명령 2의 작은 판을 막지 않는다', async () => {
    const e = randomUUID();
    await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_TARGET', version: 900_000, desiredStateJson: JSON.stringify({ target: 4_000, untilMs: Date.now() + 15 * MIN }) }));
    expect((await control.apply(req({ scope: e, kind: 'CONTROL_KIND_ADMISSION_PAUSE', version: 11, desiredStateJson: '{"paused":true,"expiresAtMs":null}' }))).appliedVersion).toBe(11);
    expect(await hash(ctl(e))).toMatchObject({ targetRev: '900000', admitRev: '11', admitPaused: '1' });
  });
});

describe('ASVS v5.0.0-2.1.1 admission-ctrl 바라는 상태 꼴 검사', () => {
  test.each([
    ['명령 1 모르는 칸', 'CONTROL_KIND_ADMISSION_TARGET', 'EVT', '{"target":3000,"untilMs":1,"extra":true}'],
    ['명령 1 목표가 글', 'CONTROL_KIND_ADMISSION_TARGET', 'EVT', '{"target":"3000","untilMs":1}'],
    ['명령 1 목표가 소수', 'CONTROL_KIND_ADMISSION_TARGET', 'EVT', '{"target":3000.5,"untilMs":1}'],
    ['명령 2 paused가 글', 'CONTROL_KIND_ADMISSION_PAUSE', 'EVT', '{"paused":"true","expiresAtMs":null}'],
    ['명령 2 모르는 칸', 'CONTROL_KIND_ADMISSION_PAUSE', 'EVT', '{"paused":true,"expiresAtMs":null,"x":1}'],
    ['명령 3 빈 글', 'CONTROL_KIND_SALE_PAUSE', 'EVT', ''],
    ['명령 3 배열', 'CONTROL_KIND_SALE_PAUSE', 'EVT', '[true]'],
    ['명령 11 stopped가 수', 'CONTROL_KIND_AUTOMATION_STOP', 'PLATFORM', '{"stopped":1}'],
    ['명령 11 회차 범위', 'CONTROL_KIND_AUTOMATION_STOP', 'EVT', '{"stopped":true}'],
    ['명령 2 전체 범위', 'CONTROL_KIND_ADMISSION_PAUSE', 'PLATFORM', '{"paused":true,"expiresAtMs":null}'],
  ])('ASVS v5.0.0-2.1.1 ⑥ %s는 INVALID_ARGUMENT이고 쓰기 0', async (_name, kind, scopeOf, json) => {
    const e = randomUUID();
    const scope = scopeOf === 'EVT' ? e : 'PLATFORM';
    const before = await hash(platformCtl);
    await expect(control.apply(req({ scope, kind, version: 9_999_999, desiredStateJson: json }))).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await exists(ctl(e))).toBe(0);
    expect(await hash(platformCtl)).toEqual(before);
  });

  test.each(['CONTROL_KIND_LOBBY_BANNER', 'CONTROL_KIND_UNSPECIFIED', 'CONTROL_KIND_SALE_SUSPENSION'])('ASVS v5.0.0-2.1.1 ⑦ admission-ctrl이 받지 않는 종류 %s는 UNIMPLEMENTED이고 쓰기 0', async (kind) => {
    const e = randomUUID();
    await expect(control.apply(req({ scope: e, kind, desiredStateJson: '{"banner":"x"}' }))).rejects.toMatchObject({ code: status.UNIMPLEMENTED });
    expect(await exists(ctl(e))).toBe(0);
  });
});

// (나) 리더 아닌 파드·낮은 세대: 진짜 Lua와 Lease 세대 짝 가짜
describe('Q-T30 리더 아닌 파드와 옛 리더의 제어 쓰기 (ApplyLeaderControl, 실제 Lua)', () => {
  const electorAt = (gen: number | undefined) => {
    const box = { gen };
    return { box, elector: { generation: () => box.gen } satisfies Elector };
  };
  const applyWith = (gen: number | undefined) => {
    const e = electorAt(gen);
    const store = new RedisLeaderStore(redis);
    // 펜싱 표시는 리더 루프 그 자체다(FENCED를 본 세대로는 루프도 제어도 쓰지 않는다)
    const fence = new AdmissionLeader(store, { run: async () => ({ status: 'PUBLISHED' }) }, e.elector, fakeClock({ now: Date.now() }));
    return { ...e, leader: fence, apply: new ApplyLeaderControl(store, e.elector, fence) };
  };
  /** ApplyLeaderControl.run이 받는 요청(proto ApplyControlRequest의 칸, 판은 수) */
  const leaderReq = (scope: string, kind: ApplyLeaderControlInput['kind'], version: number, desiredStateJson: string): ApplyLeaderControlInput => ({ commandId: randomUUID(), scope, kind, version, desiredStateJson });
  const pauseReq = (scope: string, version: number, paused: boolean) => leaderReq(scope, 'CONTROL_KIND_ADMISSION_PAUSE', version, JSON.stringify({ paused, expiresAtMs: null }));

  test('Q-T30 ① 리더가 아닌 파드(세대 없음)는 UNAVAILABLE not-leader이고 아무것도 쓰지 않는다', async () => {
    const e = randomUUID();
    const w = applyWith(undefined);
    expect(await w.apply.run(pauseReq(e, 100, true))).toEqual({ status: 'NOT_LEADER' });
    expect(await exists(ctl(e))).toBe(0);
    expect(await exists(leaderKey(e))).toBe(0);
  });

  test('Q-T30 ② 새 리더가 세대를 올리면 옛 리더의 제어 쓰기는 UNAVAILABLE fenced이고 칸·판이 그대로다. 그 파드는 그 세대로 다른 회차에도 쓰지 않는다(대기 파드)', async () => {
    const e = randomUUID();
    const old = applyWith(3);
    expect(await old.apply.run(pauseReq(e, 100, true))).toMatchObject({ status: 'APPLIED', appliedVersion: 100 });
    expect(Number(await redis.command(['GET', leaderKey(e)], { key: leaderKey(e) }))).toBe(3);
    // 새 리더(세대 4)가 같은 회차에 판 200으로 쓴다
    const fresh = applyWith(4);
    expect(await fresh.apply.run(pauseReq(e, 200, true))).toMatchObject({ status: 'APPLIED', appliedVersion: 200 });
    // 옛 리더(세대 3)가 더 큰 판으로 풀려 한다 → FENCED
    expect(await old.apply.run(pauseReq(e, 300, false))).toEqual({ status: 'FENCED' });
    expect(await hash(ctl(e))).toMatchObject({ admitPaused: '1', admitRev: '200' });
    expect(Number(await redis.command(['GET', leaderKey(e)], { key: leaderKey(e) }))).toBe(4);
    // 대기 파드로 돌아갔다: 같은 세대로는 세대 키가 없는 다른 회차에도 쓰지 않는다(리더 루프의 'FENCED를 받으면 그 세대로는 더 쓰지 않는다'와 같다)
    const other = randomUUID();
    expect((await old.apply.run(pauseReq(other, 50, true))).status).not.toBe('APPLIED');
    expect(await exists(ctl(other))).toBe(0);
  });

  test('Q-T30 ③ 리더 교체 뒤에도 입장 일시정지와 목표 고정이 남는다: 새 리더 루프가 읽는 리더 상태에 둘 다 보인다', async () => {
    const e = randomUUID();
    const old = applyWith(7);
    await old.apply.run(leaderReq(e, 'CONTROL_KIND_ADMISSION_TARGET', 400, JSON.stringify({ target: 1_500, untilMs: Date.now() + 15 * MIN })));
    await old.apply.run(pauseReq(e, 401, true));
    // 새 리더가 서며 세대부터 올린다(BUMP)
    expect(await new RedisLeaderStore(redis).bump(e, 8, Date.now() + 86_400_000)).toBe('OK');
    expect(await old.apply.run(pauseReq(e, 402, false))).toEqual({ status: 'FENCED' });
    expect(await new RedisLeaderStore(redis).control(e, Date.now())).toMatchObject({ paused: true, target: 1_500 });
  });

  test('Q-T30 ④ 시작 파일의 리더도 같다: 세대 키를 더 큰 세대로 올리면 제어 포트의 답이 UNAVAILABLE fenced이고 칸이 그대로다', async () => {
    const e = randomUUID();
    expect((await control.apply(pauseReq(e, 500, true))).appliedVersion).toBe(500);
    const gen = Number(await redis.command(['GET', leaderKey(e)], { key: leaderKey(e) }));
    expect(gen, '리더 쓰기가 세대 키에 세대를 남기지 않았다(세대 확인 Lua를 지나지 않았다)').toBeGreaterThanOrEqual(1);
    await redis.command(['SET', leaderKey(e), String(gen + 1)], { key: leaderKey(e) });
    await expect(control.apply(pauseReq(e, 600, false))).rejects.toMatchObject({ code: status.UNAVAILABLE, details: expect.stringContaining('fenced') });
    expect(await hash(ctl(e))).toMatchObject({ admitPaused: '1', admitRev: '500' });
  });

  // 이 둘은 전체 범위 세대 키를 높은 세대로 올리므로 시작 파일 리더(낮은 세대)를 쓰는 ④ 뒤에 둔다.
  // RV-02(리뷰 반영 재현, F-02-1 계획 15절): 새 리더가 서면(리더 루프가 그 세대로 한 바퀴 돈다) 옛 세대의 제어 쓰기는 회차 범위만이 아니라
  // 전체 범위(q:{admission}:leader, 명령 3 전체·명령 11)와 진행 중이 아닌(오픈 전) 회차 키에서도 FENCED다(Q-T30 '옛 리더의 쓰기는 모두 FENCED', ADR-0365 결정 5, ADR-0056)
  test('RV-02 ① 새 리더가 선 뒤 옛 리더의 전체 범위 명령 11·명령 3 쓰기는 FENCED이고 q:{admission}:ctl이 그대로다', async () => {
    const old = applyWith(50);
    expect(await old.apply.run(leaderReq('PLATFORM', 'CONTROL_KIND_AUTOMATION_STOP', 1_000_000, '{"stopped":true}'))).toMatchObject({ status: 'APPLIED' });
    const before = await hash(platformCtl);
    const fresh = applyWith(51);
    await fresh.leader.tick();
    expect(await old.apply.run(leaderReq('PLATFORM', 'CONTROL_KIND_AUTOMATION_STOP', 1_000_001, '{"stopped":false}'))).toEqual({ status: 'FENCED' });
    expect(await old.apply.run(leaderReq('PLATFORM', 'CONTROL_KIND_SALE_PAUSE', 1_000_002, '{"paused":true}'))).toEqual({ status: 'FENCED' });
    expect(await hash(platformCtl)).toEqual(before);
  });

  test('RV-02 ② 새 리더가 선 뒤 옛 리더의 오픈 전(진행 중 목록에 없는) 회차 제어 쓰기도 FENCED이고 아무것도 쓰지 않는다', async () => {
    const fresh = applyWith(61);
    await fresh.leader.tick();
    const old = applyWith(60);
    const e = randomUUID();
    expect(await old.apply.run(pauseReq(e, 100, true))).toEqual({ status: 'FENCED' });
    expect(await exists(ctl(e))).toBe(0);
  });
});
