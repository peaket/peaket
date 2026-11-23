// F-05-4 회차 목록 저장소(PackageStore) 계약 시험 묶음(계획 docs/review/plans/F-05-4.md §4 package-store.ts·§6 '기기 일련번호 동시'·14.3.3).
// 같은 묶음을 메모리 어댑터(package-store.test.ts)에 돌린다. 실제 IndexedDB 쪽은 화면 시험(tools/web-checks/scanner-scan)이 저장값을 본다.
// 정본: docs/frontend.md §3.8 '회차 목록 저장'(peaket-scanner 판 1, 이름·연락처 칸 없음), docs/features/offline-gate.md §6.4 '쓰는 차례'(같은 deviceSeq를 두 번 쓰지 않는다).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DeviceMeta, PackageStore } from '../src/storage/package-store.ts';
import { EVENT, SESSION, stateOf, ticketOf, vectorOf } from './scanner-fixture.ts';

const T = '0190f3a1-7c2e-7a00-8b2a-6c1d5e720001';
const T2 = '0190f3a1-7c2e-7a00-8b2a-6c1d5e720002';

/** 저장한 값의 칸 이름 전부(Map 값·배열·객체를 끝까지 내려간다) */
export function fieldNames(v: unknown, out = new Set<string>()): Set<string> {
  if (v instanceof Map) for (const x of v.values()) fieldNames(x, out);
  else if (v instanceof Set || Array.isArray(v)) for (const x of v) fieldNames(x, out);
  else if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      fieldNames(x, out);
    }
  }
  return out;
}

/** 관람객 이름·연락처·이메일·전화로 읽히는 칸 이름 */
export const PERSONAL_FIELD = /name|phone|mobile|tel$|email|mail|contact|holder|buyer|이름|연락처|전화/i;

export function sampleState() {
  return stateOf({
    tickets: [ticketOf(T, { keyId: 'ldN7EyqkmYs', publicKey: 'A70f5MAk1-Q6FQ8rhRJlHN-XSrPOqLJdnGxyvW5X2KOb' }), ticketOf(T2, undefined, { gateZone: '서문', status: 'REFUNDED', statusVersion: 4 })],
    revoked: ['atN7EyqkmYs'],
    entries: [[T, { lastDirection: 'IN', lastAtMs: Date.parse('2026-11-23T09:59:00.000Z'), gateZone: '동문', source: 'LOCAL' }]],
    reentryAllowed: true,
    placement: { gateZone: '동문', mode: 'OUT', version: 7 },
    lastSeq: 57,
    versionVector: vectorOf({ seq: 57 }),
  });
}

export function packageStoreContract(name: string, make: () => Promise<PackageStore>): void {
  test(`GAT-140 ${name}: 처음에는 목록이 없고, 저장한 상태를 그대로 읽는다(Map·Set 포함)`, async () => {
    const store = await make();
    assert.equal(await store.load(), undefined);
    const s = sampleState();
    await store.save(s);
    const got = await store.load();
    assert.deepEqual(got, s);
    assert.equal(got!.eventId, EVENT);
  });

  test(`GAT-140 ${name}: 다시 저장하면 마지막 상태로 바뀐다`, async () => {
    const store = await make();
    await store.save(sampleState());
    const next = { ...sampleState(), lastSeq: 60, reentryAllowed: false };
    await store.save(next);
    assert.deepEqual(await store.load(), next);
  });

  test(`GAT-140 ${name}: 기기 일련번호는 1부터 하나씩 오르고, 20번을 동시에 불러도 1~20이 겹치지 않는다`, async () => {
    const store = await make();
    const seqs = await Promise.all(Array.from({ length: 20 }, () => store.nextDeviceSeq()));
    assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(new Set(seqs).size, 20);
    assert.equal((await store.meta()).deviceSeq, 20);
    assert.equal(await store.nextDeviceSeq(), 21);
  });

  test(`GAT-140 ${name}: meta는 deviceSeq·시계 오차·스캐너 세션 ID를 담고 setMeta는 deviceSeq를 바꾸지 않는다`, async () => {
    const store = await make();
    assert.equal((await store.meta()).deviceSeq, 0);
    assert.equal((await store.meta()).clockOffsetMs, undefined, '오차를 잰 적 없음');
    await store.nextDeviceSeq();
    await store.nextDeviceSeq();
    await store.setMeta({ clockOffsetMs: -60_000, scannerSessionId: SESSION });
    const meta: DeviceMeta = await store.meta();
    assert.deepEqual(meta, { deviceSeq: 2, clockOffsetMs: -60_000, scannerSessionId: SESSION });
    await store.setMeta({ clockOffsetMs: 400 });
    assert.deepEqual(await store.meta(), { deviceSeq: 2, clockOffsetMs: 400, scannerSessionId: SESSION });
  });

  test(`GAT-140 ${name}: clear 뒤에는 목록이 없다`, async () => {
    const store = await make();
    await store.save(sampleState());
    await store.clear();
    assert.equal(await store.load(), undefined);
  });

  test(`GAT-140 ${name}: 저장한 목록·meta의 칸 이름 전수에 이름·연락처·이메일·전화가 없고 스태프 토큰이 없다 [ASVS v5.0.0-14.3.3]`, async () => {
    const store = await make();
    await store.save(sampleState());
    await store.setMeta({ clockOffsetMs: 10, scannerSessionId: SESSION });
    const names = fieldNames([await store.load(), await store.meta()]);
    assert.ok(names.has('seatLabel') && names.has('deviceSeq'), `칸을 실제로 모았다: ${[...names].join(',')}`);
    assert.deepEqual([...names].filter((n) => PERSONAL_FIELD.test(n)), []);
    assert.deepEqual([...names].filter((n) => /token|authorization|dpop/i.test(n)), []);
  });
}
