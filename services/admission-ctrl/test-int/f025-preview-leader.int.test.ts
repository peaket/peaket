// F-02-5(OPS-300) admission-ctrl 사전 모의 센 값: 시작 함수(src/start.ts)가 띄운 리더가 실제 Valkey에서 주기를 돈 뒤, 제어 전용 포트의
// PreviewControl이 주는 명령 1 센 값이 같은 시각 대기열 Redis에서 직접 센 값과 같은지 본다(C-T6 ①, ADR-0365 결정 11·16).
// - 시험 조립이 아니라 시작 파일 조립이다(계획 docs/review/plans/F-02-5.md 13절 '받는 쪽 셋의 PreviewControl 등록을 따로 띄워 본다').
//   로컬·CI 시작은 메모리 Lease라 이 프로세스 하나가 리더다(test-int/f021-leader-control.int.test.ts와 같다).
// - 세계를 멈춘 채로 둔다: 발급 번호 0(전진 없음), 예매 단계 자리 7개(만료 1시간 뒤), 곧 입장 3개(낡지 않음), 전진 기록 없음.
//   그러면 리더 주기마다 같은 값이 나와 '같은 시각'의 직접 센 값과 견줄 수 있다.
//   직접 센 값: currentTarget = q:{event:E}:ctl의 targetNow(리더가 주기마다 쓴 목표), slotsUsed = q:{event:E}:slots의 지금 뒤 만료 멤버 수,
//   soonAdmitted = q:{event:E}:soon 멤버 수, 전진 기록(q:{event:E}:calls)이 비었으면 inFlight 0·admitRatio 1(표본이 없으면 1, leader-metrics admission_ratio 설명).
// - '아무것도 쓰지 않는다'(결정 16): 리더가 보지 않는 회차를 사전 모의로 불러도 그 회차의 키가 하나도 생기지 않는다(리더 루프가 쓰는 회차는 루프가 계속 써 견줄 수 없다).
// 사유 글은 계획 8.1 그대로(no-cycle·no-source·unknown-key).
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { start, type StartedService } from '../src/start.js';
import { freePort, status } from '../../queue-svc/test-int/control-client.js';
import { type PreviewClient, previewClient } from '../../queue-svc/test-int/preview-client.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const POD = 'admission-f025-a';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 정본 키 여덟(ADR-0365 결정 11 표) */
const CANON_KEYS = ['currentTarget', 'slotsUsed', 'soonAdmitted', 'inFlight', 'admitRatio', 'avgDwellSeconds', 'servingRateCap', 'servingRate'];
/** 리더가 이미 계산하는 값(정할 것 2): 이 다섯은 센 값으로 와야 한다 */
const COMPUTED_KEYS = ['currentTarget', 'slotsUsed', 'soonAdmitted', 'inFlight', 'admitRatio'];
const SLOTS = 7;
const SOON = 3;

let valkey: ValkeyContainer;
let redis: HotRedis;
let svc: StartedService | undefined;
let client: PreviewClient;
let resultDir: string;
let startedAt: number;
const E = randomUUID();

const k = {
  events: 'q:{admission}:events',
  cfg: (e: string) => `q:{event:${e}}:cfg`,
  ctl: (e: string) => `q:{event:${e}}:ctl`,
  slots: (e: string) => `q:{event:${e}}:slots`,
  soon: (e: string) => `q:{event:${e}}:soon`,
  calls: (e: string) => `q:{event:${e}}:calls`,
};
const cmd = (args: string[]) => redis.command(args, { key: args[1]! });

beforeAll(async () => {
  valkey = await startValkey();
  redis = await createHotRedis({ url: valkey.url });
  resultDir = await mkdtemp(join(tmpdir(), 'peaket-f025-adm-'));
  startedAt = Date.now();
  // 진행 중인 회차 하나: 오픈 1분 전에 열림, 공연 시작 하루 뒤, 묶음 끔·로비 셔플 켬(둘 다 끈 조합은 없는 회차다)
  await cmd(['HSET', k.cfg(E), 'opensAtMs', String(startedAt - MIN), 'startsAtMs', String(startedAt + DAY), 'lobbyShuffle', '1', 'openBatch', '0']);
  await cmd(['ZADD', k.events, String(startedAt + 2 * DAY), E]);
  await cmd(['ZADD', k.slots(E), ...Array.from({ length: SLOTS }, (_, i) => [String(startedAt + HOUR), `slot-${i}`]).flat()]);
  await cmd(['ZADD', k.soon(E), ...Array.from({ length: SOON }, (_, i) => [String(startedAt + HOUR), `soon-${i}`]).flat()]);
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
  client = previewClient(`127.0.0.1:${controlPort}`);
}, 180_000);

afterAll(async () => {
  client?.close();
  await svc?.close();
  await redis?.close();
  valkey?.stop();
  if (resultDir) await rm(resultDir, { recursive: true, force: true });
});

const preview = (scope: string, keys: readonly string[]) => client.preview({ scope, kind: 'CONTROL_KIND_ADMISSION_TARGET', keys });

describe('C-T6 ① admission-ctrl PreviewControl 센 값 = 같은 시각 대기열 Redis (시작 파일 조립)', () => {
  test('C-T6 ① 명령 1 키의 센 값이 같은 시각 리더 주기·대기열 Redis에서 직접 센 값과 같다', async () => {
    // 메모리 Lease로 리더가 되고 그 회차의 첫 주기를 돌 때까지(no-cycle·not-leader가 아닐 때까지)
    await expect
      .poll(
        async () =>
          preview(E, ['currentTarget']).then(
            (r) => r.counts.map((c) => c.key).join(','),
            (e: { code?: number; details?: string }) => `${e.code}:${e.details}`,
          ),
        { timeout: 30_000, interval: 200 },
      )
      .toBe('currentTarget');
    const r = await preview(E, CANON_KEYS);
    const after = Date.now();
    // 직접 센 값(같은 시각: 멈춘 세계라 주기마다 같다)
    const targetNow = Number(await cmd(['HGET', k.ctl(E), 'targetNow']));
    const slotsNow = Number(await cmd(['ZCOUNT', k.slots(E), `(${after}`, '+inf']));
    const soonNow = Number(await cmd(['ZCARD', k.soon(E)]));
    const callsNow = Number(await cmd(['ZCARD', k.calls(E)]));
    expect(slotsNow, '시험 세계: 예매 단계 자리 7개').toBe(SLOTS);
    expect(soonNow, '시험 세계: 곧 입장 3개').toBe(SOON);
    expect(callsNow, '시험 세계: 전진 기록 없음').toBe(0);
    expect(Number.isSafeInteger(targetNow) && targetNow > 0, `리더가 쓴 targetNow=${targetNow}`).toBe(true);

    const byKey = Object.fromEntries(r.counts.map((c) => [c.key, c]));
    expect(Object.keys(byKey).filter((key) => COMPUTED_KEYS.includes(key)).sort()).toEqual([...COMPUTED_KEYS].sort());
    expect(byKey.currentTarget!.value).toBe(targetNow);
    expect(byKey.slotsUsed!.value).toBe(SLOTS);
    expect(byKey.soonAdmitted!.value).toBe(SOON);
    expect(byKey.inFlight!.value).toBe(0);
    expect(byKey.admitRatio!.value).toBe(1);
    // 센 시각은 그 주기의 시각 하나다(값마다 따로 재지 않는다)
    const at = new Set(r.counts.map((c) => c.measuredAtMs));
    expect(at.size).toBe(1);
    const measuredAt = [...at][0]!;
    expect(measuredAt).toBeGreaterThanOrEqual(startedAt);
    expect(measuredAt).toBeLessThanOrEqual(after);
    // 나머지 정본 키는 센 값(유한·0 이상)이거나 no-source다. 0으로 덮은 '없음'은 없다
    for (const key of CANON_KEYS.filter((x) => !COMPUTED_KEYS.includes(x))) {
      const counted = byKey[key];
      const missing = r.unavailable.find((u) => u.key === key);
      expect(counted !== undefined || missing !== undefined, `${key}가 응답에 있다`).toBe(true);
      if (missing) expect(missing.reason).toBe('no-source');
      if (counted) expect(Number.isFinite(counted.value) && counted.value >= 0).toBe(true);
    }
    expect(r.counts.length + r.unavailable.length).toBe(CANON_KEYS.length);
    expect(r.podName).toBe(POD);
  });

  test('F025-PREVIEW ⑫ 리더가 보지 않는 회차는 키마다 no-cycle이고, 사전 모의는 그 회차의 대기열 키를 하나도 만들지 않는다', async () => {
    const other = randomUUID();
    const r = await preview(other, ['currentTarget', 'slotsUsed', 'notAKey']);
    expect(r.counts).toEqual([]);
    expect([...r.unavailable].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'currentTarget', reason: 'no-cycle' },
      { key: 'notAKey', reason: 'unknown-key' },
      { key: 'slotsUsed', reason: 'no-cycle' },
    ]);
    const made = (await redis.command(['KEYS', `q:{event:${other}}*`], { key: `q:{event:${other}}` })) as unknown[];
    expect(made).toEqual([]);
  });

  test('F025-PREVIEW ⑬ 실제 포트에서도 범위·키 수·종류가 틀리면 INVALID_ARGUMENT·UNIMPLEMENTED다', async () => {
    await expect(preview(E.toUpperCase(), ['currentTarget'])).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(preview(E, [])).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(preview(E, Array.from({ length: 17 }, (_, i) => `k${i}`))).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(client.preview({ scope: E, kind: 'CONTROL_KIND_SALE_PAUSE', keys: ['waiting'] })).rejects.toMatchObject({ code: status.UNIMPLEMENTED });
  });
});
