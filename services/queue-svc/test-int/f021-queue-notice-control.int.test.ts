// F-02-1(OPS-300) queue-svc 받는 쪽: 명령 3 판매 일시정지(CONTROL_KIND_SALE_PAUSE)·명령 7 대기실 공지(CONTROL_KIND_LOBBY_BANNER)를
// 시작 함수(src/start.ts)의 제어 전용 포트(PEAKET_QUEUE_CONTROL_GRPC_PORT)로 실제로 보내 대기 상태 파일 사본 q:{event:E}:notice(전체는 q:{event:PLATFORM}:notice)의
// 칸을 본다. 시험 조립이 아니라 시작 파일 조립이다(F-02-1 계획 13절). 실제 Valkey.
// 정본: ADR-0365 결정 1(판은 0 이하·안전 정수 밖이면 INVALID_ARGUMENT), 결정 2(종류별 바라는 상태 꼴, 모르는 칸·틀린 꼴은 INVALID_ARGUMENT·쓰기 0,
// 받지 않는 종류는 UNIMPLEMENTED, 배너 1~500자·제어 문자 없음), 결정 6(notice의 paused·pausedRev·pausedCmd, banner·bannerRev·bannerCmd,
// version·commandId는 마지막 적용, 배너 null이면 칸을 지움, 판매 중지 suspRev와 서로 막지 않음), ADR-0103 결정 1(판이 지금보다 클 때만 쓴다).
// 시험 이름: B17은 F021-Q, 판 검사는 ASVS v5.0.0-1.4.2·15.3.5, 꼴 검사는 ASVS v5.0.0-2.1.1(F-02-1 계획 9절).
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { start, type StartedService } from '../src/start.js';
import { type ControlClient, controlClient, freePort, status } from './control-client.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const POD = 'queue-f021-a';
let valkey: ValkeyContainer;
let redis: HotRedis;
let svc: StartedService | undefined;
let control: ControlClient;

const admissionKey = { ...(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'it-f021-q' };

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  const controlPort = await freePort();
  svc = await start({
    env: {
      PEAKET_ENV: 'ci',
      PEAKET_POD: POD,
      PEAKET_QUEUE_REDIS_URL: valkey.url,
      PEAKET_QUEUE_TOKEN_KEY: `k1:${Buffer.alloc(32, 3).toString('base64')}`,
      PEAKET_ADMISSION_TOKEN_KEY: JSON.stringify(admissionKey),
      PEAKET_ADMISSION_TOKEN_ISSUER: 'https://queue.peaket.example',
      PEAKET_GRPC_PORT: String(await freePort()),
      PEAKET_GRPC_HOST: '127.0.0.1',
      PEAKET_QUEUE_CONTROL_GRPC_PORT: String(controlPort),
      PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
      PORT: String(await freePort()),
      PEAKET_MANAGEMENT_PORT: String(await freePort()),
      PEAKET_LOG_PSEUDONYM_KEY: Buffer.alloc(32, 7).toString('base64'),
      PEAKET_LOG_LEVEL: 'fatal',
    },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  control = controlClient(`127.0.0.1:${controlPort}`);
}, 120_000);

afterAll(async () => {
  control?.close();
  await svc?.close();
  await redis?.close();
  valkey?.stop();
});

const notice = (scope: string) => `q:{event:${scope}}:notice`;
/** Hash 한 키의 모든 칸(node-redis는 객체, RESP2 배열이면 짝으로 푼다) */
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

const pause = (scope: string, version: number | string, paused: boolean, commandId = randomUUID()) =>
  control.apply({ commandId, scope, kind: 'CONTROL_KIND_SALE_PAUSE', version, desiredStateJson: JSON.stringify({ paused }) });
const banner = (scope: string, version: number | string, text: string | null, commandId = randomUUID()) =>
  control.apply({ commandId, scope, kind: 'CONTROL_KIND_LOBBY_BANNER', version, desiredStateJson: JSON.stringify({ banner: text }) });

describe('F021-Q queue-svc 대기 상태 파일 사본 (B17)', () => {
  test('F021-Q ① 명령 3 회차 범위는 notice에 paused·pausedRev·pausedCmd와 마지막 적용 version·commandId를 쓰고, ack는 그 판과 이 파드 이름이다', async () => {
    const e = randomUUID();
    const cmd = randomUUID();
    const ack = await pause(e, 1_700_000_000_123, true, cmd);
    expect(ack).toMatchObject({ appliedVersion: 1_700_000_000_123, podName: POD });
    expect(await hash(notice(e))).toMatchObject({ paused: '1', pausedRev: '1700000000123', pausedCmd: cmd, version: '1700000000123', commandId: cmd });
  });

  test('F021-Q ② 명령 7은 banner·bannerRev·bannerCmd를 쓰고 명령 3 칸은 그대로다. 배너 null은 banner 칸을 지운다', async () => {
    const e = randomUUID();
    const pauseCmd = randomUUID();
    await pause(e, 2_000, true, pauseCmd);
    const bannerCmd = randomUUID();
    const ack = await banner(e, 2_001, '잠시 입장을 멈췄습니다. 자리는 그대로 지켜집니다.', bannerCmd);
    expect(ack.appliedVersion).toBe(2_001);
    expect(await hash(notice(e))).toMatchObject({
      paused: '1',
      pausedRev: '2000',
      pausedCmd: pauseCmd,
      banner: '잠시 입장을 멈췄습니다. 자리는 그대로 지켜집니다.',
      bannerRev: '2001',
      bannerCmd,
      version: '2001',
      commandId: bannerCmd,
    });
    const clearCmd = randomUUID();
    expect((await banner(e, 2_002, null, clearCmd)).appliedVersion).toBe(2_002);
    const after = await hash(notice(e));
    expect(after.banner, '배너 null이면 칸을 지운다(ADR-0365 결정 2·6)').toBeUndefined();
    expect(after).toMatchObject({ bannerRev: '2002', bannerCmd: clearCmd, paused: '1', pausedRev: '2000' });
  });

  test('F021-Q ③ 전체 범위 명령 3·7은 q:{event:PLATFORM}:notice에 쓴다', async () => {
    const pauseCmd = randomUUID();
    expect((await pause('PLATFORM', 3_000, true, pauseCmd)).appliedVersion).toBe(3_000);
    const bannerCmd = randomUUID();
    expect((await banner('PLATFORM', 3_001, '전체 판매를 잠시 멈췄습니다.', bannerCmd)).appliedVersion).toBe(3_001);
    expect(await hash(notice('PLATFORM'))).toMatchObject({ paused: '1', pausedRev: '3000', pausedCmd: pauseCmd, banner: '전체 판매를 잠시 멈췄습니다.', bannerRev: '3001', bannerCmd });
    // 풀기
    expect((await pause('PLATFORM', 3_002, false)).appliedVersion).toBe(3_002);
    expect(await hash(notice('PLATFORM'))).toMatchObject({ paused: '0', pausedRev: '3002' });
  });

  test('F021-Q ④ 판매 중지(suspRev)와 판매 일시정지(pausedRev)는 서로 막지 않는다: 판매 중지 판보다 작은 명령 3 판도 적용되고 판매 중지 칸은 그대로다', async () => {
    const e = randomUUID();
    const suspCmd = randomUUID();
    await control.apply({ commandId: suspCmd, scope: e, kind: 'CONTROL_KIND_SALE_SUSPENSION', version: 9_000, desiredStateJson: '{"suspended":true}' });
    expect((await pause(e, 4_000, true)).appliedVersion).toBe(4_000);
    expect(await hash(notice(e))).toMatchObject({ suspended: '1', suspRev: '9000', suspCmd, paused: '1', pausedRev: '4000' });
  });
});

describe('ASVS v5.0.0-1.4.2·15.3.5 queue-svc 판 번호 검사', () => {
  test('ASVS v5.0.0-1.4.2 ① 판 0·음수·2^53·2^53+1은 INVALID_ARGUMENT이고 아무것도 쓰지 않는다. 2^53−1은 받는다', async () => {
    const e = randomUUID();
    for (const version of [0, -1, '9007199254740992', '9007199254740993']) {
      await expect(pause(e, version, true), `판 ${version}`).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    }
    expect(await exists(notice(e))).toBe(0);
    const max = randomUUID();
    expect((await pause(max, '9007199254740991', true)).appliedVersion).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('ASVS v5.0.0-15.3.5 ① 판은 수로 엄격 비교한다: 9 다음 10이 이기고, 다시 온 9와 같은 판 10의 다른 값은 아무것도 바꾸지 않고 지금 판 10을 답한다', async () => {
    const e = randomUUID();
    await banner(e, 9, '아홉');
    const ten = randomUUID();
    expect((await banner(e, 10, '열', ten)).appliedVersion).toBe(10);
    expect((await banner(e, 9, '늦은 아홉')).appliedVersion).toBe(10);
    expect((await banner(e, 10, '같은 판 다른 값')).appliedVersion).toBe(10);
    expect(await hash(notice(e))).toMatchObject({ banner: '열', bannerRev: '10', bannerCmd: ten });
  });
});

describe('ASVS v5.0.0-2.1.1 queue-svc 바라는 상태 꼴 검사', () => {
  test.each([
    ['모르는 칸', '{"paused":true,"extra":1}'],
    ['틀린 형', '{"paused":"true"}'],
    ['칸 없음', '{}'],
    ['빈 글', ''],
    ['JSON 아님', 'paused=true'],
    ['null', 'null'],
    ['배열', '[true]'],
  ])('ASVS v5.0.0-2.1.1 ① 명령 3 %s는 INVALID_ARGUMENT이고 쓰기 0', async (_name, json) => {
    const e = randomUUID();
    await expect(control.apply({ commandId: randomUUID(), scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', version: 100, desiredStateJson: json })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await exists(notice(e))).toBe(0);
  });

  test.each([
    ['빈 배너', JSON.stringify({ banner: '' })],
    ['501자', JSON.stringify({ banner: '가'.repeat(501) })],
    ['제어 문자', JSON.stringify({ banner: '점검\u0007안내' })],
    ['틀린 형', JSON.stringify({ banner: 5 })],
    ['모르는 칸', JSON.stringify({ banner: '안내', paused: true })],
  ])('ASVS v5.0.0-2.1.1 ② 명령 7 %s는 INVALID_ARGUMENT이고 쓰기 0', async (_name, json) => {
    const e = randomUUID();
    await expect(control.apply({ commandId: randomUUID(), scope: e, kind: 'CONTROL_KIND_LOBBY_BANNER', version: 100, desiredStateJson: json })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await exists(notice(e))).toBe(0);
  });

  test('ASVS v5.0.0-2.1.1 ③ 배너 500자는 받는다(1~500자 [가정] 경계)', async () => {
    const e = randomUUID();
    const text = '나'.repeat(500);
    expect((await banner(e, 100, text)).appliedVersion).toBe(100);
    expect((await hash(notice(e))).banner).toBe(text);
  });

  test('ASVS v5.0.0-2.1.1 ④ 범위가 빈 글이거나 회차 ID 모양이 아니면, 명령 ID가 UUID가 아니면 INVALID_ARGUMENT', async () => {
    for (const scope of ['', 'not a scope!']) {
      await expect(pause(scope, 100, true), `범위 '${scope}'`).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    }
    const e = randomUUID();
    await expect(control.apply({ commandId: 'cmd-1', scope: e, kind: 'CONTROL_KIND_SALE_PAUSE', version: 100, desiredStateJson: '{"paused":true}' })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(await exists(notice(e))).toBe(0);
  });

  test.each(['CONTROL_KIND_ADMISSION_TARGET', 'CONTROL_KIND_ADMISSION_PAUSE', 'CONTROL_KIND_AUTOMATION_STOP', 'CONTROL_KIND_UNSPECIFIED'])(
    'ASVS v5.0.0-2.1.1 ⑤ queue-svc가 받지 않는 종류 %s는 UNIMPLEMENTED이고 쓰기 0',
    async (kind) => {
      const e = randomUUID();
      await expect(control.apply({ commandId: randomUUID(), scope: e, kind, version: 100, desiredStateJson: '{"paused":true}' })).rejects.toMatchObject({ code: status.UNIMPLEMENTED });
      expect(await exists(notice(e))).toBe(0);
    },
  );
});
