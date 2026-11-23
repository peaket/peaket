// 스캐너 기기 원장·등록 코드 순수/메모리 시험(BUILD_ORDER GAT-170, offline-gate §6.1).
import { fakeClock, type HotRedis } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { RedisDpopReplayStore } from '../src/modules/scanner/adapters/redis-dpop-replay-store.js';
import { RedisEnrollmentAttemptLimiter } from '../src/modules/scanner/adapters/redis-enrollment-attempt-limiter.js';
import { RedisEnrollmentCodeStore } from '../src/modules/scanner/adapters/redis-enrollment-code-store.js';
import { MemoryEnrollmentAttemptLimiter } from '../src/modules/scanner/adapters/memory-enrollment-attempt-limiter.js';
import { EnrollmentCodeRejected, EnrollmentRateLimited, ScannerDeviceNotFound, ScannerDevices, ScannerEnrollmentUnavailable } from '../src/modules/scanner/application/scanner-devices.js';
import {
  assertJkt,
  ENROLLMENT_CODE_TTL_MS,
  enrollmentCodeHash,
  newEnrollmentCode,
  normalizeEnrollmentCode,
  ScannerDeviceInputError,
} from '../src/modules/scanner/domain/scanner-device.js';

const NOW = Date.parse('2026-11-13T00:00:00Z');
const PROMOTER = '0190f3a1-7c2e-7a00-8000-000000000001';
const ADMIN = '0190f3a1-7c2e-7a00-8000-000000000002';
const DEVICE = '0190f3a1-7c2e-7a00-8000-000000000003';
const JKT = 'A'.repeat(43);

function world() {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryScannerDeviceStore();
  const codes = new MemoryEnrollmentCodeStore(clock);
  const devices = new ScannerDevices({ store, codes, clock, newId: () => DEVICE });
  return { clock, store, codes, devices };
}

describe('M5-07 jkt 모양 검사', () => {
  test('assertJkt는 43자 base64url만 받고 short·42자·+·= 값은 JKT 오류다', () => {
    expect(assertJkt('A'.repeat(43))).toBe('A'.repeat(43));
    for (const bad of ['short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, `${'A'.repeat(42)}=`, '', undefined, 43]) {
      try {
        assertJkt(bad);
        throw new Error(`통과하면 안 되는 jkt: ${String(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ScannerDeviceInputError);
        expect((e as ScannerDeviceInputError).code).toBe('JKT');
      }
    }
  });

  test('기기 저장소의 byThumbprint도 같은 assertJkt를 쓴다', async () => {
    const store = new MemoryScannerDeviceStore();
    await expect(store.byThumbprint('short')).rejects.toMatchObject({ code: 'JKT' });
  });
});

describe('스캐너 등록 코드 [GAT-170]', () => {
  test('RFC 8628 문자 집합 12자를 4-4-4로 만들고, 대소문자·하이픈·공백을 무시해 정규화한다', () => {
    const code = newEnrollmentCode(() => 0);
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(normalizeEnrollmentCode(code.toLowerCase().replace(/-/g, ' '))).toBe(code);
    expect(normalizeEnrollmentCode('ABCD-EFGH-IJKL')).toBeUndefined();
    expect(normalizeEnrollmentCode('')).toBeUndefined();
    expect(enrollmentCodeHash(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(enrollmentCodeHash(code)).not.toContain(code.replace(/-/g, ''));
  });
});

describe('Redis 저장소 어댑터 [GAT-170]', () => {
  test('DPoP jti는 SET NX PX로 처음만 true이고, 등록 코드는 GETDEL로 한 번만 꺼낸다', async () => {
    const calls: string[][] = [];
    const redis = {
      command: async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'SET') return calls.filter((c) => c[0] === 'SET' && c[1] === args[1]).length === 1 ? 'OK' : null;
        if (args[0] === 'GETDEL') return '0190f3a1-7c2e-7a00-8000-000000000001';
        if (args[0] === 'PTTL') return 600_000;
        return null;
      },
    } as unknown as HotRedis;
    const replay = new RedisDpopReplayStore(redis);
    expect(await replay.claim('jti-1', 600_000)).toBe(true);
    expect(await replay.claim('jti-1', 600_000)).toBe(false);
    expect(calls[0]).toEqual(['SET', 'scanner:dpop:jti-1', '1', 'NX', 'PX', '600000']);

    const codes = new RedisEnrollmentCodeStore(redis);
    await codes.put({ codeHash: 'abc', deviceId: 'dev-1', ttlMs: 600_000 });
    expect(calls).toContainEqual(['SET', 'scanner:enroll:abc', 'dev-1', 'PX', '600000']);
    expect(calls).toContainEqual(['SET', 'scanner:enroll-device:dev-1', 'abc', 'PX', '600000']);
    // O-T42 ⑤: take는 기기 ID와 함께 남은 수명으로 만든 만료 시각을 준다(계획 F-05-5 §5). 만료 시각 값은 실제 Valkey 통합 시험이 본다
    expect(await codes.take('abc')).toMatchObject({ deviceId: '0190f3a1-7c2e-7a00-8000-000000000001' });
    expect(calls).toContainEqual(['GETDEL', 'scanner:enroll:abc']);
    expect(calls).toContainEqual(['PTTL', 'scanner:enroll:abc']);
  });

  test('등록 실패 제한은 IP 카운터 TTL을 쓰고 10회 뒤 막으며, 전체 101회에 경보를 낸다', async () => {
    const counts = new Map<string, number>();
    const ttls = new Map<string, number>();
    const redis = {
      command: async (args: string[]) => {
        if (args[0] === 'GET') return counts.has(args[1]!) ? String(counts.get(args[1])) : null;
        if (args[0] === 'INCR') {
          const n = (counts.get(args[1]!) ?? 0) + 1;
          counts.set(args[1]!, n);
          return n;
        }
        if (args[0] === 'PEXPIRE') {
          ttls.set(args[1]!, Number(args[2]));
          return 1;
        }
        return null;
      },
    } as unknown as HotRedis;
    const limiter = new RedisEnrollmentAttemptLimiter(redis);
    for (let i = 0; i < 10; i++) {
      expect(await limiter.allowed('10.0.0.1')).toBe(true);
      await limiter.failed('10.0.0.1');
    }
    expect(ttls.get('scanner:enroll:fail:10.0.0.1')).toBe(600_000);
    expect(await limiter.allowed('10.0.0.1')).toBe(false);

    let alert = false;
    for (let i = 0; i < 100; i++) {
      const r = await limiter.failed(`10.1.0.${i}`);
      if (r.globalAlert) alert = true;
    }
    expect(alert).toBe(true);
  });
});

describe('R-609 C1-13 등록 전체 실패 SEV3', () => {
  test('전체 실패 경계를 넘으면 ops-svc ops_alert(SEV3)로 보낸다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryScannerDeviceStore();
    const codes = new MemoryEnrollmentCodeStore(clock);
    const alerts: import('../src/modules/scanner/domain/ports.js').ScannerOpsAlert[] = [];
    const devices = new ScannerDevices({
      store,
      codes,
      clock,
      limiter: { allowed: async () => true, failed: async () => ({ globalAlert: true, globalFailures: 101 }) },
      opsAlert: { open: async (alert) => void alerts.push(alert) },
    });
    await expect(devices.enroll({ code: 'WRONG-CODE', jkt: JKT })).rejects.toBeInstanceOf(EnrollmentCodeRejected);
    expect(alerts).toEqual([
      expect.objectContaining({
        eventKey: 'scanner-enrollment',
        kind: 'ENROLLMENT_GLOBAL_FAILURES',
        severity: 'SEV3',
        source: 'ticket-svc',
        detail: { failures: 101 },
        atMs: NOW,
      }),
    ]);
  });
});

describe('ScannerDevices [GAT-170]', () => {
  test('등록은 ACTIVE 기기와 1회용 코드를 만들고, 등록 코드로 jkt를 묶으면 기기 키 지문으로 찾힌다', async () => {
    const w = world();
    const r = await w.devices.register({ name: '동문-03', promoterId: PROMOTER, enrolledBy: ADMIN });
    expect(r.device).toMatchObject({ deviceId: DEVICE, name: '동문-03', promoterId: PROMOTER, status: 'ACTIVE', credentialType: 'DEVICE_KEY' });
    expect(r.enrollmentCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(Date.parse(r.enrollmentCodeExpiresAt) - NOW).toBe(ENROLLMENT_CODE_TTL_MS);

    expect(await w.devices.enroll({ code: r.enrollmentCode.toLowerCase().replace(/-/g, ' '), jkt: JKT })).toEqual({ deviceId: DEVICE });
    expect(await w.store.byThumbprint(JKT)).toMatchObject({ deviceId: DEVICE, status: 'ACTIVE', promoterId: PROMOTER });
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).rejects.toBeInstanceOf(EnrollmentCodeRejected);
  });

  test('이미 다른 기기에 묶인 지문은 새 등록 코드를 소모해도 KEY_IN_USE로 거절한다', async () => {
    const w = world();
    const ids = ['0190f3a1-7c2e-7a00-8000-000000000021', '0190f3a1-7c2e-7a00-8000-000000000022'];
    let n = 0;
    const d = new ScannerDevices({ store: w.store, codes: w.codes, clock: w.clock, newId: () => ids[n++]! });
    const first = await d.register({ name: '동문-06', promoterId: PROMOTER, enrolledBy: ADMIN });
    const second = await d.register({ name: '동문-07', promoterId: PROMOTER, enrolledBy: ADMIN });
    await expect(d.enroll({ code: first.enrollmentCode, jkt: JKT })).resolves.toEqual({ deviceId: ids[0] });
    await expect(d.enroll({ code: second.enrollmentCode, jkt: JKT })).rejects.toMatchObject({ reason: 'KEY_IN_USE' });
  });

  test('등록 코드는 10분이 지나면 만료되고, 폐기한 기기에는 새 지문을 묶지 않는다', async () => {
    const w = world();
    const r = await w.devices.register({ name: '동문-04', promoterId: PROMOTER, enrolledBy: ADMIN });
    w.clock.advance(ENROLLMENT_CODE_TTL_MS + 1);
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).rejects.toMatchObject({ reason: 'USED' });

    const r2 = await w.devices.register({ name: '동문-05', promoterId: PROMOTER, enrolledBy: ADMIN });
    await w.devices.revoke({ deviceId: r2.device.deviceId, reason: '분실' });
    await expect(w.devices.enroll({ code: r2.enrollmentCode, jkt: JKT })).rejects.toMatchObject({ reason: 'DEVICE' });
  });

  test('등록 jkt가 43자 base64url이 아니면 ScannerDeviceInputError(JKT)다', async () => {
    const w = world();
    await expect(w.store.byThumbprint('short')).rejects.toMatchObject({ name: 'ScannerDeviceInputError', code: 'JKT' });
    await expect(w.store.byThumbprint('!'.repeat(43))).rejects.toMatchObject({ name: 'ScannerDeviceInputError', code: 'JKT' });
    await expect(w.store.byThumbprint('A'.repeat(44))).rejects.toMatchObject({ name: 'ScannerDeviceInputError', code: 'JKT' });
  });

  test('목록은 UUID 커서로 나뉘고, 없는 기기 폐기는 404, 입력 오류는 ScannerDeviceInputError다', async () => {
    const w = world();
    const ids = ['0190f3a1-7c2e-7a00-8000-000000000011', '0190f3a1-7c2e-7a00-8000-000000000012'];
    let n = 0;
    const d = new ScannerDevices({ store: w.store, codes: w.codes, clock: w.clock, newId: () => ids[n++]! });
    await d.register({ name: 'A', promoterId: PROMOTER, enrolledBy: ADMIN });
    await d.register({ name: 'B', promoterId: PROMOTER, enrolledBy: ADMIN });
    const first = await d.list({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(ids[0]);
    const second = await d.list({ cursor: first.nextCursor, limit: 1 });
    expect(second.items.map((x) => x.name)).toEqual(['B']);
    await expect(d.revoke({ deviceId: '0190f3a1-7c2e-7a00-8000-000000000099', reason: 'x' })).rejects.toBeInstanceOf(ScannerDeviceNotFound);
    await expect(d.register({ name: '', promoterId: PROMOTER, enrolledBy: ADMIN })).rejects.toBeInstanceOf(ScannerDeviceInputError);
    await expect(d.list({ limit: 101 })).rejects.toBeInstanceOf(ScannerDeviceInputError);
  });

});

/**
 * 기기 키 묶기 저장이 정한 횟수만큼 일시 오류(DB 끊김)로 던지는 원장. 진짜 메모리 원장(MemoryScannerDeviceStore)을 그대로 쓰고
 * bindCredential만 앞쪽 몇 번 실패시킨다(포트 ScannerDeviceStore를 그대로 구현한 짝 가짜).
 */
class FlakyBindStore extends MemoryScannerDeviceStore {
  failNext = 0;
  bindCalls = 0;
  override async bindCredential(i: Parameters<MemoryScannerDeviceStore['bindCredential']>[0]): ReturnType<MemoryScannerDeviceStore['bindCredential']> {
    this.bindCalls += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('connection terminated unexpectedly(시험 장애 주입)');
    }
    return super.bindCredential(i);
  }
}

const MIN = 60_000;

function flakyWorld() {
  const clock = fakeClock({ now: NOW });
  const store = new FlakyBindStore();
  const codes = new MemoryEnrollmentCodeStore(clock);
  const limiter = new MemoryEnrollmentAttemptLimiter(() => clock.now());
  const devices = new ScannerDevices({ store, codes, clock, limiter, newId: () => DEVICE });
  return { clock, store, codes, limiter, devices };
}

describe('O-T42 ⑤ 기기 키 묶기 저장이 일시 오류면 등록 코드를 되살린다(offline-gate §6.1 GAT-170 마감 규칙, 감사 C1-19)', () => {
  test('O-T42 ⑤ 첫 요청은 ScannerEnrollmentUnavailable이고, 같은 코드로 다시 등록하면 성공한다', async () => {
    const w = flakyWorld();
    const r = await w.devices.register({ name: '동문-11', promoterId: PROMOTER, enrolledBy: ADMIN });
    w.store.failNext = 1;
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT, ip: '10.7.0.1' })).rejects.toBeInstanceOf(ScannerEnrollmentUnavailable);
    expect(await w.store.byThumbprint(JKT)).toBeNull();
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT, ip: '10.7.0.1' })).resolves.toEqual({ deviceId: DEVICE });
    expect(w.store.bindCalls).toBe(2);
    expect(await w.store.byThumbprint(JKT)).toMatchObject({ deviceId: DEVICE, status: 'ACTIVE' });
    // 되살린 코드도 한 번만 쓴다
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: 'B'.repeat(43), ip: '10.7.0.1' })).rejects.toMatchObject({ reason: 'USED' });
  });

  test('O-T42 ⑤ 일시 오류는 IP 실패로 세지 않는다: 그 뒤 틀린 코드 10번까지는 410이고 11번째에서야 429다', async () => {
    const w = flakyWorld();
    const r = await w.devices.register({ name: '동문-12', promoterId: PROMOTER, enrolledBy: ADMIN });
    w.store.failNext = 1;
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT, ip: '10.7.0.2' })).rejects.toBeInstanceOf(ScannerEnrollmentUnavailable);
    for (let i = 0; i < 10; i++) {
      await expect(w.devices.enroll({ code: 'BCDF-GHJK-LMNP', jkt: JKT, ip: '10.7.0.2' }), `실패 ${i + 1}번째`).rejects.toMatchObject({ reason: 'USED' });
    }
    await expect(w.devices.enroll({ code: 'BCDF-GHJK-LMNP', jkt: JKT, ip: '10.7.0.2' })).rejects.toBeInstanceOf(EnrollmentRateLimited);
  });

  test('O-T42 ⑤ 발급 t0, 실패 t0+9분이면 t0+9분59.999초 재시도는 성공한다(만료 시각 처음 그대로)', async () => {
    const w = flakyWorld();
    const r = await w.devices.register({ name: '동문-13', promoterId: PROMOTER, enrolledBy: ADMIN });
    w.clock.advance(9 * MIN);
    w.store.failNext = 1;
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).rejects.toBeInstanceOf(ScannerEnrollmentUnavailable);
    w.clock.advance(59_999);
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).resolves.toEqual({ deviceId: DEVICE });
  });

  test('O-T42 ⑤ 발급 t0, 실패 t0+9분이면 t0+10분 재시도는 410(USED)이다(되살려도 만료가 늘지 않는다)', async () => {
    const w = flakyWorld();
    const r = await w.devices.register({ name: '동문-14', promoterId: PROMOTER, enrolledBy: ADMIN });
    w.clock.advance(9 * MIN);
    w.store.failNext = 1;
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).rejects.toBeInstanceOf(ScannerEnrollmentUnavailable);
    w.clock.advance(MIN);
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).rejects.toMatchObject({ reason: 'USED' });
    expect(await w.store.byThumbprint(JKT)).toBeNull();
  });

  test('O-T42 ⑤ 꺼낸 뒤 실패 전에 운영자가 새 코드를 발급했으면 옛 코드는 되살리지 않고(410) 새 코드만 쓴다', async () => {
    const w = flakyWorld();
    const r = await w.devices.register({ name: '동문-15', promoterId: PROMOTER, enrolledBy: ADMIN });
    let reissued: string | undefined;
    // 코드를 꺼낸 직후, 묶기 저장이 실패하기 전에 SCR-053에서 새 코드가 나온다(되살릴 때 그 기기의 지금 코드가 다르다)
    w.store.failNext = 1;
    const bind = w.store.bindCredential.bind(w.store);
    w.store.bindCredential = async (i) => {
      reissued ??= (await w.devices.issueCode({ deviceId: DEVICE })).enrollmentCode;
      return bind(i);
    };
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).rejects.toBeInstanceOf(ScannerEnrollmentUnavailable);
    w.store.bindCredential = bind;
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).rejects.toMatchObject({ reason: 'USED' });
    await expect(w.devices.enroll({ code: reissued!, jkt: JKT })).resolves.toEqual({ deviceId: DEVICE });
  });

  test('O-T42 ⑤ 실패가 끝난 뒤 새 코드를 발급하면 되살린 옛 코드는 지워진다(새 코드만 쓴다)', async () => {
    const w = flakyWorld();
    const r = await w.devices.register({ name: '동문-16', promoterId: PROMOTER, enrolledBy: ADMIN });
    w.store.failNext = 1;
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).rejects.toBeInstanceOf(ScannerEnrollmentUnavailable);
    const fresh = await w.devices.issueCode({ deviceId: DEVICE });
    await expect(w.devices.enroll({ code: r.enrollmentCode, jkt: JKT })).rejects.toMatchObject({ reason: 'USED' });
    await expect(w.devices.enroll({ code: fresh.enrollmentCode, jkt: JKT })).resolves.toEqual({ deviceId: DEVICE });
  });

  test('O-T42 ⑤ 다른 기기에 묶인 키(409)와 폐기 기기(410)는 지금처럼 코드를 소모하고 실패로 센다', async () => {
    const w = flakyWorld();
    const ids = ['0190f3a1-7c2e-7a00-8000-000000000031', '0190f3a1-7c2e-7a00-8000-000000000032', '0190f3a1-7c2e-7a00-8000-000000000033'];
    let n = 0;
    const d = new ScannerDevices({ store: w.store, codes: w.codes, clock: w.clock, limiter: w.limiter, newId: () => ids[n++]! });
    const first = await d.register({ name: '동문-17', promoterId: PROMOTER, enrolledBy: ADMIN });
    const second = await d.register({ name: '동문-18', promoterId: PROMOTER, enrolledBy: ADMIN });
    const third = await d.register({ name: '동문-19', promoterId: PROMOTER, enrolledBy: ADMIN });
    await d.enroll({ code: first.enrollmentCode, jkt: JKT, ip: '10.7.0.3' });
    await expect(d.enroll({ code: second.enrollmentCode, jkt: JKT, ip: '10.7.0.3' })).rejects.toMatchObject({ reason: 'KEY_IN_USE' });
    await expect(d.enroll({ code: second.enrollmentCode, jkt: 'C'.repeat(43), ip: '10.7.0.3' })).rejects.toMatchObject({ reason: 'USED' });
    await d.revoke({ deviceId: ids[2]!, reason: '분실' });
    await expect(d.enroll({ code: third.enrollmentCode, jkt: 'D'.repeat(43), ip: '10.7.0.3' })).rejects.toMatchObject({ reason: 'DEVICE' });
    await expect(d.enroll({ code: third.enrollmentCode, jkt: 'D'.repeat(43), ip: '10.7.0.3' })).rejects.toMatchObject({ reason: 'USED' });
    // 실패 네 번이 세어졌다: 여섯 번 더 틀리면(실패 10번) 다음 요청이 429다
    for (let i = 0; i < 6; i++) await expect(d.enroll({ code: 'BCDF-GHJK-LMNP', jkt: JKT, ip: '10.7.0.3' })).rejects.toMatchObject({ reason: 'USED' });
    await expect(d.enroll({ code: 'BCDF-GHJK-LMNP', jkt: JKT, ip: '10.7.0.3' })).rejects.toBeInstanceOf(EnrollmentRateLimited);
  });
});

describe('O-T42 ⑤ 등록 코드 저장소 take·restore 계약(메모리, 계획 F-05-5 §5)', () => {
  test('O-T42 ⑤ take는 기기 ID와 처음 만료 시각(발급 + 10분)을 주고 한 번만 꺼낸다', async () => {
    const clock = fakeClock({ now: NOW });
    const codes = new MemoryEnrollmentCodeStore(clock);
    await codes.put({ codeHash: 'h-1', deviceId: DEVICE, ttlMs: 600_000 });
    clock.advance(3 * MIN);
    expect(await codes.take('h-1')).toEqual({ deviceId: DEVICE, expiresAtMs: NOW + 600_000 });
    expect(await codes.take('h-1')).toBeUndefined();
  });

  test('O-T42 ⑤ restore는 만료 시각 1ms 전까지만 되살리고, 만료 시각이 되면 false다', async () => {
    const clock = fakeClock({ now: NOW });
    const codes = new MemoryEnrollmentCodeStore(clock);
    await codes.put({ codeHash: 'h-2', deviceId: DEVICE, ttlMs: 600_000 });
    const got = (await codes.take('h-2'))!;
    clock.advance(600_000 - 1);
    expect(await codes.restore({ codeHash: 'h-2', deviceId: DEVICE, expiresAtMs: got.expiresAtMs })).toBe(true);
    expect(await codes.take('h-2')).toEqual({ deviceId: DEVICE, expiresAtMs: NOW + 600_000 });

    const late = new MemoryEnrollmentCodeStore(clock);
    await late.put({ codeHash: 'h-3', deviceId: DEVICE, ttlMs: 10 });
    const g3 = (await late.take('h-3'))!;
    clock.advance(10);
    expect(await late.restore({ codeHash: 'h-3', deviceId: DEVICE, expiresAtMs: g3.expiresAtMs })).toBe(false);
    expect(await late.take('h-3')).toBeUndefined();
  });

  test('O-T42 ⑤ 그 기기의 지금 코드가 다른 코드면 restore는 false이고 옛 코드는 꺼내지지 않는다', async () => {
    const clock = fakeClock({ now: NOW });
    const codes = new MemoryEnrollmentCodeStore(clock);
    await codes.put({ codeHash: 'old', deviceId: DEVICE, ttlMs: 600_000 });
    const got = (await codes.take('old'))!;
    await codes.put({ codeHash: 'new', deviceId: DEVICE, ttlMs: 600_000 });
    expect(await codes.restore({ codeHash: 'old', deviceId: DEVICE, expiresAtMs: got.expiresAtMs })).toBe(false);
    expect(await codes.take('old')).toBeUndefined();
    expect(await codes.take('new')).toEqual({ deviceId: DEVICE, expiresAtMs: NOW + 600_000 });
  });
});
