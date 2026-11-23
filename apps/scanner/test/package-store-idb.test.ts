// F-05-4 회차 목록 저장소 계약을 IndexedDB 어댑터에도 돌린다(시험 리뷰 RV-04: 짝 가짜와 같은 계약 시험을 진짜에도, 계획 §3 package-store.ts).
// Node에는 IndexedDB가 없어 fake-indexeddb(apps/web의 개발 의존성, 의존 선언 밖 상대 경로 가져오기)를 전역에 올린다.
// 브라우저의 실제 IndexedDB 값은 tools/web-checks/scanner-scan이 본다(새로고침 뒤 deviceSeq 2 등).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PackageStore } from '../src/storage/package-store.ts';
import { packageStoreContract } from './package-store-contract.ts';

const FAKE = '../../web/node_modules/fake-indexeddb/auto/index.mjs';
const fakeLoaded = await import(FAKE).then(
  () => true,
  () => false,
);
type StoreModule = { SCANNER_DB_NAME: string; IndexedDbPackageStore: { open(): Promise<PackageStore & { close?(): void }> } };
const MODULE = '../src/storage/package-store.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<StoreModule>;
function mod(): StoreModule {
  assert.equal(fakeLoaded, true, `${FAKE}를 불러오지 못했다(뿌리에서 pnpm install)`);
  assert.equal(typeof loaded.IndexedDbPackageStore?.open, 'function', `${MODULE}의 IndexedDbPackageStore가 없다`);
  return loaded as StoreModule;
}

let last: (PackageStore & { close?(): void }) | undefined;
async function freshStore(): Promise<PackageStore> {
  const m = mod();
  last?.close?.();
  await new Promise<void>((res, rej) => {
    const r = indexedDB.deleteDatabase(m.SCANNER_DB_NAME);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('peaket-scanner를 지우지 못했다(열린 연결이 닫히지 않았다)'));
  });
  last = await m.IndexedDbPackageStore.open();
  return last;
}

packageStoreContract('IndexedDB 목록 저장소(fake-indexeddb)', freshStore);

test('GAT-140 IndexedDB 목록 저장소: 닫았다 다시 열어도 저장한 목록과 기기 일련번호가 이어진다(같은 번호를 두 번 주지 않는다)', async () => {
  const first = await freshStore();
  await first.nextDeviceSeq();
  await first.nextDeviceSeq();
  await first.nextDeviceSeq();
  await first.setMeta({ clockOffsetMs: -60_000 });
  (first as PackageStore & { close?(): void }).close?.();
  last = await mod().IndexedDbPackageStore.open();
  assert.equal(await last.nextDeviceSeq(), 4);
  assert.deepEqual(await last.meta(), { deviceSeq: 4, clockOffsetMs: -60_000 });
});
