// F-05-12 SCR-052 현장 관리 실제 API 연결(TR-01). 정본: docs/design/d5 §8.5, docs/features/offline-gate.md §7.2·§9.1,
// openapi getScannerEventDevices·GateStatus·listScannerEventFlags, docs/review/plans/F-05-12.md §4 manage-model·§6 SCR-052 앱.
//
// 기존 시험은 manageTabsFor·devicesViewOf·boothViewOf·overridesViewOf 순수 함수만 보아 화면을 목업으로 둔 구현도 통과했다.
// 여기서는 ManageController가 실제 ScannerApi 메서드를 부르는지(호출 수·인자), 403·409·오프라인에서 화면 상태만 바꾸고
// 다시 부르지 않는지, flagsViewOf가 서버 GateFlag를 행으로 옮기는지 본다. 화면이 목업을 읽는지는 소스 경계로 따로 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type Tab = 'devices' | 'flags' | 'booth' | 'mine';
interface GateStatusView {
  devices: { deviceId: string; name: string; placement?: { gateZone: string; mode: 'IN' | 'OUT' }; ready: boolean; packageSeq?: number; lastSyncAt?: string; pendingUploads: number; staffLoggedIn?: boolean }[];
  entriesByZone: Record<string, number>;
  rejectsByReason: Record<string, number>;
  openFlags: number;
  boothCount: number;
  overrideCount: number;
  entryClosedAt?: string;
}
interface GateFlagView {
  flagId: string;
  ticketId: string;
  seatLabel: string;
  gateZone: string;
  kind: string;
  awareness: string;
  status: string;
  createdAt: string;
}
interface OverridePassView {
  scanId: string;
  at: string;
  ticketId: string;
  seatLabel: string;
  reason: string;
  note?: string;
  reviewStatus: 'WAITING' | 'OK' | 'SUSPECT' | 'UNDETERMINED';
}
interface ManageSnapshot {
  tabs: Tab[];
  state: 'ready' | 'forbidden' | 'no-placement' | 'offline' | 'error';
  devices: { deviceId: string; name: string; placement: string; ready: boolean; lastSyncAt?: string; pendingUploads: number; self?: boolean }[];
  flags: { flagId: string; seatLabel: string; kindLabel: string; awarenessLabel: string; statusLabel: string; resolved: boolean }[];
  overrides: { scanId: string; at: string; seatLabel: string; reason: string; reviewLabel: string }[];
  error?: string;
}
interface BoothView {
  kind: 'authorized' | 'expired' | 'forbidden' | 'not-found' | 'offline' | 'error';
  seatLabel?: string;
  allowUntil?: string;
}
interface ManageApi {
  devices(eventId: string): Promise<GateStatusView>;
  flags(eventId: string): Promise<GateFlagView[]>;
  overridePasses(eventId: string): Promise<{ items: OverridePassView[] }>;
  boothAuthorization(boothCode: string): Promise<{ ticketId: string; seatLabel: string; allowUntil: string }>;
  resolveFlag(flagId: string, status: 'OK' | 'SUSPECT' | 'UNDETERMINED', note?: string): Promise<void>;
}
interface Controller {
  load(): Promise<ManageSnapshot>;
  authorizeBooth(code: string): Promise<BoothView>;
  resolveFlag(flagId: string, status: 'OK' | 'SUSPECT' | 'UNDETERMINED', note?: string): Promise<void>;
}
const MODULE = '../src/screens/manage-model.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as Partial<{
  ManageController: new (d: { api: ManageApi; eventId: string; role: 'gate_staff' | 'gate_lead'; deviceId: string; online?: () => boolean }) => Controller;
  flagsViewOf: (items: GateFlagView[]) => ManageSnapshot['flags'];
}>;
function model() {
  assert.equal(typeof loaded.ManageController, 'function', `${MODULE}의 ManageController가 없다`);
  return loaded as Required<typeof loaded>;
}

const EVENT = 'ev-1';
const DEVICE = 'dev-1';

function status(over: Partial<GateStatusView> = {}): GateStatusView {
  return {
    devices: [
      { deviceId: DEVICE, name: '동문-01', placement: { gateZone: '동문', mode: 'IN' }, ready: true, packageSeq: 7, lastSyncAt: '2026-11-26T03:00:00.000Z', pendingUploads: 2 },
      { deviceId: 'dev-2', name: '서문-01', ready: false, pendingUploads: 0 },
    ],
    entriesByZone: { 동문: 12 },
    rejectsByReason: { ALREADY_IN: 2 },
    openFlags: 1,
    boothCount: 1,
    overrideCount: 2,
    entryClosedAt: '2026-11-26T04:00:00.000Z',
    ...over,
  };
}

const flag = (over: Partial<GateFlagView> = {}): GateFlagView => ({
  flagId: 'f-1',
  ticketId: 't-1',
  seatLabel: 'R구역 12열 7번',
  gateZone: '동문',
  kind: 'DUPLICATE',
  awareness: 'CONCURRENT',
  status: 'OPEN',
  createdAt: '2026-11-26T03:01:00.000Z',
  ...over,
});
const pass = (over: Partial<OverridePassView> = {}): OverridePassView => ({ scanId: 's-1', at: '2026-11-26T03:02:00.000Z', ticketId: 't-1', seatLabel: 'R구역 12열 7번', reason: 'OVERRIDE_PHONE_DEAD', reviewStatus: 'WAITING', ...over });

function fakeApi(over: Partial<ManageApi> = {}) {
  const calls = { devices: [] as string[], flags: [] as string[], overrides: [] as string[], booth: [] as string[], resolve: [] as { flagId: string; status: string; note?: string }[] };
  const api: ManageApi = {
    async devices(eventId) {
      calls.devices.push(eventId);
      return status();
    },
    async flags(eventId) {
      calls.flags.push(eventId);
      return [flag()];
    },
    async overridePasses(eventId) {
      calls.overrides.push(eventId);
      return { items: [pass()] };
    },
    async boothAuthorization(code) {
      calls.booth.push(code);
      return { ticketId: 't-1', seatLabel: 'R구역 12열 7번', allowUntil: '2026-11-26T03:10:00.000Z' };
    },
    async resolveFlag(flagId, s, note) {
      calls.resolve.push({ flagId, status: s, ...(note !== undefined ? { note } : {}) });
    },
    ...over,
  };
  return { api, calls };
}

function controller(role: 'gate_staff' | 'gate_lead', api: ManageApi, o: { online?: () => boolean } = {}): Controller {
  return new (model().ManageController)({ api, eventId: EVENT, role, deviceId: DEVICE, ...(o.online ? { online: o.online } : {}) });
}

function scannerError(statusCode: number, type: string): Error {
  return Object.assign(new Error(type), { status: statusCode, type });
}

test('SCR-052 책임자는 기기·이상 표시·내 예외 통과를 실제 API로 한 번씩 받고 행으로 옮긴다', async () => {
  const { api, calls } = fakeApi();
  const snap = await controller('gate_lead', api).load();
  assert.deepEqual(calls.devices, [EVENT]);
  assert.deepEqual(calls.flags, [EVENT]);
  assert.deepEqual(calls.overrides, [EVENT]);
  assert.equal(snap.state, 'ready');
  assert.deepEqual(snap.tabs, ['devices', 'flags', 'booth', 'mine']);
  assert.equal(snap.devices[0]!.deviceId, DEVICE);
  assert.equal(snap.devices[0]!.self, true);
  assert.equal(snap.devices[1]!.placement, '배치 없음');
  assert.equal(snap.flags[0]!.seatLabel, 'R구역 12열 7번');
  assert.equal(snap.flags[0]!.resolved, false);
  assert.equal(snap.overrides[0]!.reviewLabel, '검토 대기');
});

test('SCR-052 일반 스태프는 기기 현황만 받고 책임자 경로(이상 표시·내 예외 통과)를 부르지 않는다', async () => {
  const { api, calls } = fakeApi();
  const snap = await controller('gate_staff', api).load();
  assert.deepEqual(calls.devices, [EVENT]);
  assert.deepEqual(calls.flags, []);
  assert.deepEqual(calls.overrides, []);
  assert.deepEqual(snap.tabs, ['devices']);
  assert.equal(snap.state, 'ready');
});

test('SCR-052 403(일반 스태프가 책임자 경로를 부른 경우)은 forbidden으로 바꾸고 다시 부르지 않는다', async () => {
  const { api, calls } = fakeApi({
    async devices() {
      calls.devices.push(EVENT);
      throw scannerError(403, 'scanner-override-forbidden');
    },
  });
  const c = controller('gate_lead', api);
  const first = await c.load();
  assert.equal(first.state, 'forbidden');
  assert.equal(first.error !== undefined, true);
  await c.load();
  assert.equal(calls.devices.length, 1, '같은 실패에서 API를 다시 부르지 않는다');
  assert.equal(calls.flags.length, 0);
});

test('SCR-052 배치가 없으면(409 no-placement) 화면 상태만 바꾸고 다시 부르지 않는다', async () => {
  const { api, calls } = fakeApi({
    async devices() {
      calls.devices.push(EVENT);
      throw scannerError(409, 'no-placement');
    },
  });
  const c = controller('gate_lead', api);
  const snap = await c.load();
  assert.equal(snap.state, 'no-placement');
  await c.load();
  assert.equal(calls.devices.length, 1);
});

test('SCR-052 오프라인이면 API를 부르지 않고 offline 상태다', async () => {
  const { api, calls } = fakeApi();
  const snap = await controller('gate_lead', api, { online: () => false }).load();
  assert.equal(snap.state, 'offline');
  assert.equal(calls.devices.length + calls.flags.length + calls.overrides.length, 0);
});

test('SCR-052 부스 허용은 실제 boothAuthorization을 부르고 410·403을 화면 이름으로 가른다', async () => {
  const { api, calls } = fakeApi();
  const c = controller('gate_lead', api);
  assert.deepEqual(await c.authorizeBooth('K7QD2M9X'), { kind: 'authorized', seatLabel: 'R구역 12열 7번', allowUntil: '2026-11-26T03:10:00.000Z' });
  assert.deepEqual(calls.booth, ['K7QD2M9X']);

  const expired = fakeApi({
    async boothAuthorization() {
      throw scannerError(410, 'booth-code-expired');
    },
  });
  assert.deepEqual(await controller('gate_lead', expired.api).authorizeBooth('EXPIRED1'), { kind: 'expired' });

  const forbidden = fakeApi({
    async boothAuthorization() {
      throw scannerError(403, 'scanner-override-forbidden');
    },
  });
  assert.deepEqual(await controller('gate_lead', forbidden.api).authorizeBooth('K7QD2M9X'), { kind: 'forbidden' });
});

test('SCR-052 이상 표시 처리는 실제 resolveFlag를 부르고 note를 그대로 넘긴다', async () => {
  const { api, calls } = fakeApi();
  await controller('gate_lead', api).resolveFlag('f-1', 'OK', '좌석 확인');
  assert.deepEqual(calls.resolve, [{ flagId: 'f-1', status: 'OK', note: '좌석 확인' }]);
});

test('SCR-052 flagsViewOf는 GateFlag의 좌석·종류·인지·처리 상태를 화면 글자로 옮긴다', () => {
  const rows = model().flagsViewOf([
    flag({ flagId: 'f-1', kind: 'DUPLICATE', awareness: 'CONCURRENT', status: 'OPEN' }),
    flag({ flagId: 'f-2', kind: 'NO_EXIT', awareness: 'KNOWN', status: 'OK', seatLabel: 'S구역 1열 1번' }),
    flag({ flagId: 'f-3', kind: 'AFTER_CLOSE', awareness: 'KNOWN', status: 'SUSPECT' }),
  ]);
  assert.deepEqual(rows[0], { flagId: 'f-1', seatLabel: 'R구역 12열 7번', kindLabel: '중복 입장(동시)', awarenessLabel: '몰랐음', statusLabel: '처리 전', resolved: false });
  assert.deepEqual(rows[1], { flagId: 'f-2', seatLabel: 'S구역 1열 1번', kindLabel: '퇴장 기록 없음', awarenessLabel: '알고도 통과', statusLabel: '정상', resolved: true });
  assert.equal(rows[2]!.statusLabel, '부적정');
});

// ---- 화면이 목업이 아니라 실제 API 조립을 쓰는지(소스 경계). .tsx는 node --test가 그리지 못한다 ----
const screen = readFileSync(new URL('../src/screens/ManageScreen.tsx', import.meta.url), 'utf8');
const shell = readFileSync(new URL('../src/shared/shell.tsx', import.meta.url), 'utf8');
const banner = readFileSync(new URL('../src/screens/ManageScreen.tsx', import.meta.url), 'utf8');

test('SCR-052 화면은 fixtures/scanner 목업을 읽지 않고 manage-model의 실제 API 조립을 쓴다', () => {
  assert.ok(!/from\s+["']\.\.\/fixtures\/scanner["']/.test(screen), 'ManageScreen이 fixtures/scanner(목업)를 아직 읽는다');
  assert.ok(/from\s+["']\.\/manage-model(\.ts)?["']/.test(screen), 'ManageScreen이 manage-model을 읽어야 한다');
  assert.ok(/ManageController|manageController|new\s+ManageController/.test(screen), 'ManageScreen이 실제 API를 부르는 ManageController를 써야 한다');
  // 셸의 [현장 관리] 메뉴도 일반 스태프에게 숨긴다(d5 §8.5 '일반 스태프 | 메뉴가 없고, API는 403')
  assert.ok(/manageTabsFor|gate_lead|isGateLead/.test(shell), 'shell이 일반 스태프에게 현장 관리 메뉴를 숨겨야 한다');
  // 오프라인 안내는 d5 §8.5 상태 문구를 그대로 쓴다
  assert.ok(/오프라인: 배치 변경·부스 허용은 연결된 뒤에 됩니다/.test(banner), '오프라인 안내 문구가 없다');
  // 확인 스캔은 이 화면에서 스캔 화면의 VERIFY 모드를 열 수 없으므로 사유와 함께 비활성으로 그린다(IR-08, d5 §8.5 ③)
  const confirm = screen.slice(screen.indexOf('function ConfirmScanButton'), screen.indexOf('const GUIDE'));
  assert.ok(/disabled/.test(confirm), '확인 스캔하기 버튼이 죽어 있으면 안 된다(사유 있는 비활성)');
  assert.ok(/스캔 화면/.test(confirm), '확인 스캔을 할 수 없는 사유를 보여야 한다');
  assert.ok(/aria-describedby/.test(confirm), '비활성 사유를 접근 이름으로 이어야 한다');
});
