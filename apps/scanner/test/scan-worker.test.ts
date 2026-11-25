// F-05-10 판정 Worker 경계 시험(계획 docs/review/plans/F-05-10.md §3·§5).
// 정본: docs/frontend.md §5.5(카메라 프레임을 Worker로 옮겨 디코딩, 판정 지연 예산), docs/features/offline-gate.md §6.4
// (판정 중 예외는 통과가 아니라 '다시 찍어 주세요'), ASVS offline-gate v5.0.0-3.5.5(자기 작업자의 정해진 모양 메시지만).
// 고정 대기를 쓰지 않는다. Worker 시간 초과는 주입한 타이머로 진행한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';

type Req =
  | { type: 'prepare'; state: unknown }
  | { type: 'decode'; id: number; bitmap: unknown }
  | { type: 'judge'; id: number; raw: string; nowMs: number; clockOffsetMs: number };
type Res =
  | { type: 'decoded'; id: number; raw?: string }
  | { type: 'decode-failed'; id: number; reason: 'NO_DECODER' | 'DECODE_ERROR' }
  | { type: 'judged'; id: number; outcome: unknown }
  | { type: 'worker-error'; id: number };

type ProtocolModule = {
  parseScanWorkerRequest(data: unknown): Req | undefined;
  parseScanWorkerResponse(data: unknown): Res | undefined;
};
type ClientModule = {
  ScanWorkerClient: new (o: {
    worker: FakeWorker;
    timeoutMs?: number;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(h: unknown): void;
  }) => {
    prepare(state: unknown): void;
    decode(bitmap: unknown): Promise<string | undefined>;
    judge(i: { raw: string; nowMs: number; clockOffsetMs: number }): Promise<unknown>;
    dispose(): void;
  };
};
type DecoderModule = {
  createDecoderChain(o: {
    barcode?: () => { decode(source: unknown): Promise<string | undefined> } | undefined;
    zxing?: () => Promise<{ decode(source: unknown): Promise<string | undefined> } | undefined>;
  }): Promise<{ decode(source: unknown): Promise<string | undefined> } | undefined>;
};

const PROTOCOL = '../src/workers/qr-protocol.ts';
const CLIENT = '../src/workers/scan-worker-client.ts';
const DECODER = '../src/storage/decoder.ts';
const protocolLoaded = (await import(PROTOCOL).catch(() => ({}))) as Partial<ProtocolModule>;
const clientLoaded = (await import(CLIENT).catch(() => ({}))) as Partial<ClientModule>;
const decoderLoaded = (await import(DECODER).catch(() => ({}))) as Partial<DecoderModule>;
function protocol(): ProtocolModule {
  for (const name of ['parseScanWorkerRequest', 'parseScanWorkerResponse'] as const) {
    assert.equal(typeof protocolLoaded[name], 'function', `${PROTOCOL}의 ${name}가 없다`);
  }
  return protocolLoaded as ProtocolModule;
}
function clientModule(): ClientModule {
  assert.equal(typeof clientLoaded.ScanWorkerClient, 'function', `${CLIENT}의 ScanWorkerClient가 없다`);
  return clientLoaded as ClientModule;
}
function decoderModule(): DecoderModule {
  assert.equal(typeof decoderLoaded.createDecoderChain, 'function', `${DECODER}의 createDecoderChain이 없다`);
  return decoderLoaded as DecoderModule;
}

class FakeWorker {
  readonly messages: unknown[] = [];
  readonly listeners = new Map<string, ((e: unknown) => void)[]>();
  terminated = false;
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  terminate(): void {
    this.terminated = true;
  }
  last(type: Req['type']): Extract<Req, { type: typeof type }> {
    const found = [...this.messages].reverse().find((m) => (m as { type?: string }).type === type);
    assert.ok(found, `${type} 메시지를 보내지 않았다`);
    return found as Extract<Req, { type: typeof type }>;
  }
  emit(data: unknown): void {
    for (const fn of this.listeners.get('message') ?? []) fn({ data });
  }
  emitError(error: unknown): void {
    for (const fn of this.listeners.get('error') ?? []) fn(error);
  }
}

function harness() {
  const worker = new FakeWorker();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  const api = new (clientModule().ScanWorkerClient)({
    worker,
    timeoutMs: 1_000,
    setTimer: (fn, ms) => {
      const h = ++seq;
      timers.set(h, { fn, ms });
      return h;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
  });
  const fireTimer = (): void => {
    const first = [...timers.entries()][0];
    assert.ok(first, '걸린 타이머가 없다');
    timers.delete(first[0]);
    first[1].fn();
  };
  return { worker, api, timers, fireTimer };
}

test('GAT-140 판정 Worker는 디코딩과 판정을 화면 스레드 밖에서 하고 응답이 없거나 죽으면 다시 찍어 주세요로 닫는다', async () => {
  const h = harness();
  h.api.prepare({ eventId: 'e-1', lastSeq: 10 });
  assert.deepEqual(h.worker.last('prepare'), { type: 'prepare', state: { eventId: 'e-1', lastSeq: 10 } });

  const decoded = h.api.decode({ width: 10 });
  const decodeReq = h.worker.last('decode');
  assert.equal(decodeReq.bitmap instanceof Object, true);
  h.worker.emit({ type: 'decoded', id: decodeReq.id, raw: 'QR-RAW' });
  assert.equal(await decoded, 'QR-RAW');

  const judged = h.api.judge({ raw: 'QR-RAW', nowMs: 1_000, clockOffsetMs: -500 });
  const judgeReq = h.worker.last('judge');
  assert.deepEqual(judgeReq, { type: 'judge', id: judgeReq.id, raw: 'QR-RAW', nowMs: 1_000, clockOffsetMs: -500 });
  const outcome = { result: 'PASS', direction: 'IN', ticketId: 't-1', keyId: 'k-1', qrTimestampMs: 1_000, seatLabel: 'R구역 12열 8번' };
  h.worker.emit({ type: 'judged', id: judgeReq.id, outcome });
  assert.deepEqual(await judged, outcome);
  assert.equal(h.timers.size, 0, '성공하면 시간 초과 타이머를 지운다');

  // 응답이 없으면 RETRY다(통과 아님)
  const timedOut = h.api.judge({ raw: 'QR-RAW', nowMs: 1_000, clockOffsetMs: 0 });
  h.fireTimer();
  assert.deepEqual(await timedOut, { result: 'RETRY' });

  // Worker가 죽으면 걸려 있던 판정도 RETRY다
  const killed = h.api.judge({ raw: 'QR-RAW', nowMs: 1_000, clockOffsetMs: 0 });
  h.worker.emitError(new Error('worker crashed'));
  assert.deepEqual(await killed, { result: 'RETRY' });

  // 모르는 모양의 응답은 버리고 시간 초과로 닫는다
  const malformed = h.api.judge({ raw: 'QR-RAW', nowMs: 1_000, clockOffsetMs: 0 });
  const badReq = h.worker.last('judge');
  h.worker.emit({ type: 'judged', id: badReq.id, outcome: { result: 'PASS' }, extra: '모르는 칸' });
  h.fireTimer();
  assert.deepEqual(await malformed, { result: 'RETRY' });

  h.api.dispose();
  assert.equal(h.worker.terminated, true);
});

test('[ASVS v5.0.0-3.5.5] QR 디코딩 Worker가 보낸 모르는 모양의 메시지는 버린다', () => {
  const p = protocol();
  assert.deepEqual(p.parseScanWorkerRequest({ type: 'prepare', state: { eventId: 'e' } }), {
    type: 'prepare',
    state: { eventId: 'e' },
  });
  assert.deepEqual(p.parseScanWorkerRequest({ type: 'decode', id: 1, bitmap: {} }), { type: 'decode', id: 1, bitmap: {} });
  assert.deepEqual(p.parseScanWorkerRequest({ type: 'judge', id: 2, raw: 'x', nowMs: 1, clockOffsetMs: 0 }), {
    type: 'judge',
    id: 2,
    raw: 'x',
    nowMs: 1,
    clockOffsetMs: 0,
  });
  assert.equal(p.parseScanWorkerRequest({ type: 'decode', id: 1 }), undefined, '프레임이 없다');
  assert.equal(p.parseScanWorkerRequest({ type: 'decode', id: '1', bitmap: {} }), undefined, 'id가 수가 아니다');
  assert.equal(p.parseScanWorkerRequest({ type: 'judge', id: 1, raw: 'x', nowMs: 1 }), undefined, '오차가 없다');
  assert.equal(p.parseScanWorkerRequest({ type: 'eval', code: 'x' }), undefined, '모르는 종류');
  assert.equal(p.parseScanWorkerRequest('decode'), undefined);

  assert.deepEqual(p.parseScanWorkerResponse({ type: 'decoded', id: 1, raw: 'x' }), { type: 'decoded', id: 1, raw: 'x' });
  assert.deepEqual(p.parseScanWorkerResponse({ type: 'decoded', id: 1 }), { type: 'decoded', id: 1 });
  assert.deepEqual(p.parseScanWorkerResponse({ type: 'decode-failed', id: 1, reason: 'NO_DECODER' }), {
    type: 'decode-failed',
    id: 1,
    reason: 'NO_DECODER',
  });
  assert.deepEqual(p.parseScanWorkerResponse({ type: 'worker-error', id: 1 }), { type: 'worker-error', id: 1 });
  assert.equal(p.parseScanWorkerResponse({ type: 'decode-failed', id: 1, reason: 'OTHER' }), undefined);
  assert.equal(p.parseScanWorkerResponse({ type: 'decoded', raw: 'x' }), undefined, 'id가 없다');
  assert.equal(p.parseScanWorkerResponse({ type: 'run', code: 'x' }), undefined, '모르는 종류');
  assert.equal(p.parseScanWorkerResponse(null), undefined);
});

test('GAT-140 BarcodeDetector가 없는 Worker는 zxing-wasm 대체를 쓰고, 둘 다 없으면 카메라 고장으로 닫는다', async () => {
  const d = decoderModule();
  const calls: string[] = [];
  const zxing = { decode: async () => 'ZXING' };
  const barcode = { decode: async () => 'BARCODE' };

  const fallback = await d.createDecoderChain({
    barcode: () => {
      calls.push('barcode');
      return undefined;
    },
    zxing: async () => {
      calls.push('zxing');
      return zxing;
    },
  });
  assert.equal(fallback, zxing);
  assert.deepEqual(calls, ['barcode', 'zxing']);

  calls.length = 0;
  const native = await d.createDecoderChain({
    barcode: () => {
      calls.push('barcode');
      return barcode;
    },
    zxing: async () => {
      calls.push('zxing');
      return zxing;
    },
  });
  assert.equal(native, barcode);
  assert.deepEqual(calls, ['barcode'], 'BarcodeDetector가 있으면 zxing은 부르지 않는다');

  const none = await d.createDecoderChain({ barcode: () => undefined, zxing: async () => undefined });
  assert.equal(none, undefined);

  const broken = await d.createDecoderChain({
    barcode: () => undefined,
    zxing: async () => {
      throw new Error('wasm을 읽지 못했다');
    },
  });
  assert.equal(broken, undefined, '대체 로더가 실패하면 카메라 고장으로 닫는다');
});
