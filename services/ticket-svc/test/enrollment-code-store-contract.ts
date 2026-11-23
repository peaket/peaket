// 등록 코드 저장소(EnrollmentCodeStore 포트)의 take·restore 계약 시험 묶음(O-T42 ⑤, offline-gate §6.1 'GAT-170 마감 규칙', 계획 F-05-5 §3·§10의 5).
// 같은 묶음을 메모리 어댑터(단위, test/scanner-device.test.ts)와 실제 Valkey 어댑터(통합, test-int/scanner-f055.int.test.ts)에 돌린다(짝 가짜의 행동 짝).
// 단언은 바깥에서 보이는 값만 본다(명령 이름·호출 차례를 보지 않는다, 시험 리뷰 1 TR-09). 시험 파일이 아니라 두 시험 파일이 부르는 모듈이다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { EnrollmentCodeStore } from '../src/modules/scanner/domain/ports.js';

/** 등록 코드 수명 10분 [가정](offline-gate §6.1 '등록') */
const TTL_MS = 600_000;

export interface EnrollmentCodeStoreWorld {
  store: EnrollmentCodeStore;
  /** 그 저장소가 쓰는 시계의 지금(메모리는 가짜 시계, Valkey는 실제 시계) */
  now(): number;
  /** 가짜 시계만. 있으면 만료 경계(1ms 전·만료 때)를 정확히 본다 */
  advance?(ms: number): void;
}

const ids = () => ({ deviceId: randomUUID(), oldHash: `h-${randomUUID()}`, newHash: `h-${randomUUID()}` });

/** fakeClock: 가짜 시계를 쓰는 어댑터만 만료 1ms 경계 시험을 더 정의한다(실제 시계 어댑터는 1ms를 잴 수 없다) */
export function enrollmentCodeStoreContract(name: string, make: () => Promise<EnrollmentCodeStoreWorld> | EnrollmentCodeStoreWorld, o: { fakeClock: boolean }): void {
  describe(`O-T42 ⑤ 등록 코드 저장소 take·restore 계약(${name})`, () => {
    test(`O-T42 ⑤ take는 기기 ID와 처음 발급 + 10분을 넘지 않는 만료 시각을 주고 한 번만 꺼낸다(${name})`, async () => {
      const w = await make();
      const { deviceId, oldHash } = ids();
      await w.store.put({ codeHash: oldHash, deviceId, ttlMs: TTL_MS });
      const issuedBy = w.now();
      const got = await w.store.take(oldHash);
      expect(got?.deviceId).toBe(deviceId);
      expect(got!.expiresAtMs).toBeLessThanOrEqual(issuedBy + TTL_MS);
      expect(got!.expiresAtMs).toBeGreaterThan(w.now());
      expect(await w.store.take(oldHash)).toBeUndefined();
    });

    test(`O-T42 ⑤ 만료 전 restore는 true이고 다시 꺼낸 만료 시각은 처음 값을 넘지 않는다(${name})`, async () => {
      const w = await make();
      const { deviceId, oldHash } = ids();
      await w.store.put({ codeHash: oldHash, deviceId, ttlMs: TTL_MS });
      const first = (await w.store.take(oldHash))!;
      expect(await w.store.restore({ codeHash: oldHash, deviceId, expiresAtMs: first.expiresAtMs })).toBe(true);
      const again = await w.store.take(oldHash);
      expect(again?.deviceId).toBe(deviceId);
      expect(again!.expiresAtMs).toBeLessThanOrEqual(first.expiresAtMs);
      expect(again!.expiresAtMs).toBeGreaterThan(w.now());
    });

    test(`O-T42 ⑤ 만료 시각이 지났으면 restore는 false이고 코드는 꺼내지지 않는다(${name})`, async () => {
      const w = await make();
      const { deviceId, oldHash } = ids();
      await w.store.put({ codeHash: oldHash, deviceId, ttlMs: TTL_MS });
      await w.store.take(oldHash);
      expect(await w.store.restore({ codeHash: oldHash, deviceId, expiresAtMs: w.now() - 1 })).toBe(false);
      expect(await w.store.take(oldHash)).toBeUndefined();
    });

    test(`O-T42 ⑤ 꺼낸 뒤 그 기기의 새 코드가 나왔으면 restore는 false이고 옛 코드는 꺼내지지 않으며 새 코드는 그대로다(${name})`, async () => {
      const w = await make();
      const { deviceId, oldHash, newHash } = ids();
      await w.store.put({ codeHash: oldHash, deviceId, ttlMs: TTL_MS });
      const first = (await w.store.take(oldHash))!;
      await w.store.put({ codeHash: newHash, deviceId, ttlMs: TTL_MS });
      expect(await w.store.restore({ codeHash: oldHash, deviceId, expiresAtMs: first.expiresAtMs })).toBe(false);
      expect(await w.store.take(oldHash)).toBeUndefined();
      expect((await w.store.take(newHash))?.deviceId).toBe(deviceId);
    });

    test(`O-T42 ⑤ 되살림과 새 코드 발급이 겨루면 어느 차례든 옛 코드는 꺼내지지 않고 새 코드만 남는다(${name})`, async () => {
      const w = await make();
      for (let round = 0; round < 20; round++) {
        const { deviceId, oldHash, newHash } = ids();
        await w.store.put({ codeHash: oldHash, deviceId, ttlMs: TTL_MS });
        const first = (await w.store.take(oldHash))!;
        const order = round % 2 === 0;
        await Promise.all(
          order
            ? [w.store.restore({ codeHash: oldHash, deviceId, expiresAtMs: first.expiresAtMs }), w.store.put({ codeHash: newHash, deviceId, ttlMs: TTL_MS })]
            : [w.store.put({ codeHash: newHash, deviceId, ttlMs: TTL_MS }), w.store.restore({ codeHash: oldHash, deviceId, expiresAtMs: first.expiresAtMs })],
        );
        expect(await w.store.take(oldHash), `회차 ${round}`).toBeUndefined();
        expect((await w.store.take(newHash))?.deviceId, `회차 ${round}`).toBe(deviceId);
      }
    });

    test(`O-T42 ⑤ 다른 기기의 지금 코드는 restore에 상관없다(${name})`, async () => {
      const w = await make();
      const a = ids();
      const b = ids();
      await w.store.put({ codeHash: a.oldHash, deviceId: a.deviceId, ttlMs: TTL_MS });
      const first = (await w.store.take(a.oldHash))!;
      await w.store.put({ codeHash: b.oldHash, deviceId: b.deviceId, ttlMs: TTL_MS });
      expect(await w.store.restore({ codeHash: a.oldHash, deviceId: a.deviceId, expiresAtMs: first.expiresAtMs })).toBe(true);
      expect((await w.store.take(a.oldHash))?.deviceId).toBe(a.deviceId);
      expect((await w.store.take(b.oldHash))?.deviceId).toBe(b.deviceId);
    });

    if (!o.fakeClock) return;
    test(`O-T42 ⑤ 가짜 시계: 만료 1ms 전 restore는 true, 만료 시각이 되면 false다(${name})`, async () => {
      const w = await make();
      expect(typeof w.advance).toBe('function');
      const { deviceId, oldHash } = ids();
      await w.store.put({ codeHash: oldHash, deviceId, ttlMs: TTL_MS });
      const first = (await w.store.take(oldHash))!;
      w.advance!(first.expiresAtMs - w.now() - 1);
      expect(await w.store.restore({ codeHash: oldHash, deviceId, expiresAtMs: first.expiresAtMs })).toBe(true);
      await w.store.take(oldHash);
      w.advance!(1);
      expect(await w.store.restore({ codeHash: oldHash, deviceId, expiresAtMs: first.expiresAtMs })).toBe(false);
      expect(await w.store.take(oldHash)).toBeUndefined();
    });
  });
}
