// 판정 Worker 진입점: 카메라 프레임 디코딩과 judgeScan을 화면 스레드 밖에서 한다(frontend §5.5, offline-gate §6.4).
// Node 시험은 createScanWorkerHandler를 직접 부르고, 브라우저에서는 self의 message 사건이 같은 처리기를 쓴다.
import { judgeScan, type JudgeOutcome } from '../judge/judge.ts';
import { verifyQrSignature } from '../judge/qr-v1.ts';
import type { PackageState } from '../storage/package-state.ts';
import { createBarcodeDecoder, createDecoderChain, createZxingDecoder, type BarcodeDecoder } from '../storage/decoder.ts';
import { parseScanWorkerRequest, type ScanWorkerResponse } from './qr-protocol.ts';

export interface ScanWorkerHandlerDeps {
  decode(bitmap: unknown): Promise<string | undefined>;
  judge(i: { raw: string; nowMs: number; clockOffsetMs: number }): Promise<unknown>;
  post(message: ScanWorkerResponse): void;
}

export function createScanWorkerHandler(deps: ScanWorkerHandlerDeps): {
  onMessage(event: { data: unknown }): Promise<void>;
} {
  let state: PackageState | undefined;
  return {
    async onMessage(event) {
      const request = parseScanWorkerRequest(event.data);
      if (!request) return;
      if (request.type === 'prepare') {
        state = request.state as PackageState;
        return;
      }
      if (request.type === 'decode') {
        try {
          const raw = await deps.decode(request.bitmap);
          if (raw === undefined) deps.post({ type: 'decode-failed', id: request.id, reason: 'NO_DECODER' });
          else deps.post({ type: 'decoded', id: request.id, raw });
        } catch {
          deps.post({ type: 'decode-failed', id: request.id, reason: 'DECODE_ERROR' });
        }
        return;
      }
      try {
        if (!state) throw new Error('목록이 준비되지 않았다');
        const outcome = await deps.judge({ raw: request.raw, nowMs: request.nowMs, clockOffsetMs: request.clockOffsetMs });
        deps.post({ type: 'judged', id: request.id, outcome });
      } catch {
        deps.post({ type: 'worker-error', id: request.id });
      }
    },
  };
}

let decoderPromise: Promise<BarcodeDecoder | undefined> | undefined;
function decoder(): Promise<BarcodeDecoder | undefined> {
  decoderPromise ??= createDecoderChain({
    barcode: () => createBarcodeDecoder(globalThis as unknown as { BarcodeDetector?: new (o: { formats: readonly string[] }) => { detect(s: ImageBitmapSource): Promise<ReadonlyArray<{ rawValue?: string }>> } }),
    zxing: createZxingDecoder,
  });
  return decoderPromise;
}

type WorkerSelf = {
  addEventListener(type: 'message', fn: (event: { data: unknown }) => void): void;
  postMessage(message: ScanWorkerResponse): void;
};

const workerSelf = typeof self !== 'undefined' ? (self as unknown as WorkerSelf) : undefined;
if (workerSelf && typeof workerSelf.addEventListener === 'function') {
  let state: PackageState | undefined;
  const handler = createScanWorkerHandler({
    decode: async (bitmap) => {
      const d = await decoder();
      return d?.decode(bitmap as ImageBitmapSource);
    },
    judge: async (i) => {
      if (!state) throw new Error('목록이 준비되지 않았다');
      return judgeScan({ raw: i.raw, state, nowMs: i.nowMs, clockOffsetMs: i.clockOffsetMs, verify: verifyQrSignature });
    },
    post: (m) => workerSelf.postMessage(m),
  });
  // prepare도 state를 이 작업자 사본에 남겨야 judge가 쓸 수 있다
  const original = handler.onMessage;
  workerSelf.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; state?: unknown };
    if (data && data.type === 'prepare') state = data.state as PackageState;
    void original(event);
  });
}

export type { JudgeOutcome };
