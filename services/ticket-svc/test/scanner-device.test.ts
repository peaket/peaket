// 스캐너 기기 원장·등록 코드 순수/메모리 시험(BUILD_ORDER GAT-170, offline-gate §6.1).
import { fakeClock, type HotRedis } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryEnrollmentCodeStore } from '../src/modules/scanner/adapters/memory-enrollment-code-store.js';
import { MemoryScannerDeviceStore } from '../src/modules/scanner/adapters/memory-scanner-device-store.js';
import { RedisDpopReplayStore } from '../src/modules/scanner/adapters/redis-dpop-replay-store.js';
import { RedisEnrollmentAttemptLimiter } from '../src/modules/scanner/adapters/redis-enrollment-attempt-limiter.js';
import { RedisEnrollmentCodeStore } from '../src/modules/scanner/adapters/redis-enrollment-code-store.js';
import { EnrollmentCodeRejected, ScannerDeviceNotFound, ScannerDevices } from '../src/modules/scanner/application/scanner-devices.js';
import {
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
    expect(await codes.take('abc')).toBe('0190f3a1-7c2e-7a00-8000-000000000001');
    expect(calls).toContainEqual(['GETDEL', 'scanner:enroll:abc']);
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
