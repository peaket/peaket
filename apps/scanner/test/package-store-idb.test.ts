// F-05-4 회차 목록 저장소 계약을 IndexedDB 어댑터에도 돌린다(시험 리뷰 RV-04: 짝 가짜와 같은 계약 시험을 진짜에도, 계획 §3 package-store.ts).
// Node에는 IndexedDB가 없어 fake-indexeddb(@peaket/scanner 개발 의존성, 판 고정 6.2.8)를 쓴다. 시험마다 새 IDBFactory를 전역에 올려
// 서로 다른 시험의 DB가 섞이지 않게 한다(어댑터에 close()를 요구하지 않는다, 반영 확인 RV-19).
// 브라우저의 실제 IndexedDB 값은 tools/web-checks/scanner-scan이 본다(새로고침 뒤 deviceSeq 2 등).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import type { PackageStore } from '../src/storage/package-store.ts';
import { packageStoreContract } from './package-store-contract.ts';

type StoreModule = { IndexedDbPackageStore: { open(): Promise<PackageStore> } };
const MODULE = '../src/storage/package-store.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<StoreModule>;
function mod(): StoreModule {
  assert.equal(typeof loaded.IndexedDbPackageStore?.open, 'function', `${MODULE}의 IndexedDbPackageStore가 없다`);
  return loaded as StoreModule;
}

/** 빈 IndexedDB(새 IDBFactory) 위에 어댑터를 연다 */
async function freshStore(): Promise<PackageStore> {
  const m = mod();
  globalThis.indexedDB = new IDBFactory();
  return m.IndexedDbPackageStore.open();
}

packageStoreContract('IndexedDB 목록 저장소(fake-indexeddb)', freshStore);

test('GAT-140 IndexedDB 목록 저장소: 같은 DB를 다시 열어도 저장한 meta와 기기 일련번호가 이어진다(같은 번호를 두 번 주지 않는다)', async () => {
  const first = await freshStore();
  await first.nextDeviceSeq();
  await first.nextDeviceSeq();
  await first.nextDeviceSeq();
  await first.setMeta({ clockOffsetMs: -60_000 });
  // 같은 IDBFactory(같은 저장 공간)에서 다시 연다
  const again = await mod().IndexedDbPackageStore.open();
  assert.equal(await again.nextDeviceSeq(), 4);
  assert.deepEqual(await again.meta(), { deviceSeq: 4, clockOffsetMs: -60_000 });
});
