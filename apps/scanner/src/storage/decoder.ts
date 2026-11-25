// QR 디코더 포트와 BarcodeDetector 어댑터(docs/frontend.md §3.8·§5.5, docs/features/offline-gate.md §6.4, BUILD_ORDER GAT-150).
// 브라우저 표준 BarcodeDetector가 있으면 그것을 쓰고, 없으면 undefined를 돌려준다(그 환경은 zxing-wasm 대체가 필요하다).
// 실제 카메라 프레임을 넣는 Worker 연결은 화면 단계에서 붙인다. 이 파일은 디코더 경계와 판정을 시험할 수 있게 한다.

export interface BarcodeDecoder {
  /** QR 하나를 읽어 원문을 준다. 못 읽으면 undefined */
  decode(source: ImageBitmapSource): Promise<string | undefined>;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<ReadonlyArray<{ readonly rawValue?: string }>>;
}

type BarcodeDetectorConstructor = new (options: { formats: readonly string[] }) => BarcodeDetectorLike;

/** BarcodeDetector가 있으면 QR 전용 디코더를 만든다. 없으면 undefined */
export function createBarcodeDecoder(scope: { BarcodeDetector?: BarcodeDetectorConstructor } = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }): BarcodeDecoder | undefined {
  const Detector = scope.BarcodeDetector;
  if (typeof Detector !== 'function') return undefined;
  let detector: BarcodeDetectorLike;
  try {
    detector = new Detector({ formats: ['qr_code'] });
  } catch {
    // QR 형식을 지원하지 않는 브라우저는 생성자가 던진다. zxing-wasm 대체 경로로 넘긴다.
    return undefined;
  }
  return {
    async decode(source) {
      const found = await detector.detect(source);
      const value = found.find((r) => typeof r.rawValue === 'string' && r.rawValue.length > 0)?.rawValue;
      return value;
    },
  };
}

type ZxingReadResult = { text?: string; isValid?: boolean };

/** 프레임을 ImageData로 바꾼다(Worker의 OffscreenCanvas). 바꿀 수 없으면 undefined */
async function imageDataOf(source: unknown): Promise<ImageData | undefined> {
  if (typeof ImageData !== 'undefined' && source instanceof ImageData) return source;
  const s = source as { width?: number; height?: number; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number };
  const width = s.videoWidth ?? s.naturalWidth ?? s.width;
  const height = s.videoHeight ?? s.naturalHeight ?? s.height;
  if (!width || !height || typeof OffscreenCanvas === 'undefined') return undefined;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(source as CanvasImageSource, 0, 0);
    return ctx.getImageData(0, 0, width, height);
  } catch {
    return undefined;
  }
}

/** BarcodeDetector가 없는 Worker의 zxing-wasm 대체. wasm을 읽지 못하면 undefined(카메라 고장) */
export async function createZxingDecoder(): Promise<BarcodeDecoder | undefined> {
  try {
    const [{ readBarcodes, prepareZXingModule }, wasm] = await Promise.all([
      import('zxing-wasm/reader') as Promise<{
        readBarcodes(input: ImageData, options?: Record<string, unknown>): Promise<ZxingReadResult[]>;
        prepareZXingModule(o: { overrides: { locateFile(path: string, prefix: string): string } }): void;
      }>,
      import('zxing-wasm/reader/zxing_reader.wasm?url') as Promise<{ default: string }>,
    ]);
    // 오프라인 스캐너이므로 CDN이 아니라 빌드가 함께 낸 wasm 파일을 읽는다.
    prepareZXingModule({
      overrides: {
        locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasm.default : prefix + path),
      },
    });
    return {
      async decode(source) {
        const image = await imageDataOf(source);
        if (!image) return undefined;
        const results = await readBarcodes(image, { formats: ['QRCode'], tryHarder: true });
        return results.find((r) => r.isValid !== false && typeof r.text === 'string' && r.text.length > 0)?.text;
      },
    };
  } catch {
    return undefined;
  }
}

/** 앞의 디코더가 있으면 그것을, 없으면 뒤의 대체를 쓴다. 둘 다 없거나 대체가 실패하면 undefined */
export async function createDecoderChain(o: {
  barcode?: () => BarcodeDecoder | undefined;
  zxing?: () => Promise<BarcodeDecoder | undefined>;
}): Promise<BarcodeDecoder | undefined> {
  const native = o.barcode?.();
  if (native) return native;
  if (!o.zxing) return undefined;
  try {
    return await o.zxing();
  } catch {
    return undefined;
  }
}
