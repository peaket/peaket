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
