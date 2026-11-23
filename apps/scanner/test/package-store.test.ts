// F-05-4 회차 목록 저장소 시험: 메모리 어댑터에 계약 묶음을 돌리고, 저장 자리 이름과 Node 환경의 열기 규칙을 본다
// (계획 docs/review/plans/F-05-4.md §4 package-store.ts, docs/frontend.md §3.8 '회차 목록 저장', scan-queue.ts와 같은 열기 규칙).
// 새 모듈은 동적 불러오기로 읽는다: 모듈이 없으면 각 시험이 '어댑터가 있다'는 단언에서 떨어진다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PackageStore } from '../src/storage/package-store.ts';
import { packageStoreContract } from './package-store-contract.ts';

type StoreModule = {
  SCANNER_DB_NAME: string;
  SCANNER_DB_VERSION: number;
  MemoryPackageStore: new () => PackageStore;
  IndexedDbPackageStore: { open(): Promise<PackageStore> };
  openPackageStore(): Promise<PackageStore>;
};
const MODULE = '../src/storage/package-store.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<StoreModule>;
function mod(): StoreModule {
  assert.equal(typeof loaded.MemoryPackageStore, 'function', `${MODULE}의 MemoryPackageStore가 없다`);
  assert.equal(typeof loaded.openPackageStore, 'function', `${MODULE}의 openPackageStore가 없다`);
  return loaded as StoreModule;
}

packageStoreContract('메모리 목록 저장소', async () => new (mod().MemoryPackageStore)());

test('GAT-140 회차 목록 저장 자리는 IndexedDB peaket-scanner 판 1이고 IndexedDB 어댑터가 있다', () => {
  const m = mod();
  assert.equal(m.SCANNER_DB_NAME, 'peaket-scanner');
  assert.equal(m.SCANNER_DB_VERSION, 1);
  assert.equal(typeof m.IndexedDbPackageStore?.open, 'function');
});

test('GAT-140 Node(시험)에서 openPackageStore는 메모리 저장소를 준다', async () => {
  const m = mod();
  const store = await m.openPackageStore();
  assert.ok(store instanceof m.MemoryPackageStore);
});
