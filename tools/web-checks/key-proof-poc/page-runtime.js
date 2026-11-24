// GAT-030 키 증명 PoC의 브라우저 쪽 하네스. `page.addScriptTag`로 주입한다.
// - 월렛 화면과 같은 CSS 그리드(모듈 칸 div)로 351px QR을 그린다.
// - 러너가 그 카드만 스크린샷해 base64로 넘기면, 열화 단계마다 캔버스에 흐림·기울임·밝기를 걸어 디코딩한다.
// - 디코더는 두 길이다. ① 스캐너의 `createBarcodeDecoder`(BarcodeDetector) ② 없으면 zxing-wasm 대체.
//   useDetector가 참이면 ①, 거짓이면 ②다. 어느 길인지는 러너가 결과 JSON에 적는다.
(() => {
  const FRAME_SIZE = 512; // 카드 351px가 20° 기울어도 잘리지 않는 여백(351 × (cos20+sin20) ≈ 450)
  let baseImage = null;
  let detector = null;
  let useDetector = false;
  let zxing = null;
  let detectorError = null;

  function makeCell(on) {
    const cell = document.createElement('i');
    cell.style.display = 'block';
    cell.style.background = on ? '#000' : '#fff';
    return cell;
  }

  function twoFrames() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  async function readOnce(source, imageData) {
    if (useDetector) return await detector.decode(source);
    const results = await zxing.readBarcodes(imageData, { formats: ['QRCode'] });
    return results.find((r) => typeof r.text === 'string' && r.text.length > 0)?.text;
  }

  window.__poc = {
    async init() {
      // 스캐너의 실제 어댑터를 먼저 시도한다(decoder.ts를 타입만 지워 주입한 함수).
      if (typeof window.__createBarcodeDecoder === 'function') {
        try {
          detector = window.__createBarcodeDecoder(globalThis);
        } catch (error) {
          detectorError = String(error);
        }
      }
      useDetector = Boolean(detector);
      if (!useDetector) {
        if (!globalThis.ZXingWASM) throw new Error('ZXingWASM 대체를 싣지 못했습니다');
        zxing = globalThis.ZXingWASM;
        await zxing.prepareZXingModule({
          overrides: { locateFile: (file) => `${location.origin}/${file}` },
        });
      }
      return {
        useDetector,
        barcodeDetector: typeof globalThis.BarcodeDetector,
        detectorError,
        zxingVersion: zxing?.ZXING_WASM_VERSION ?? null,
        zxingSha256: zxing?.ZXING_WASM_SHA256 ?? null,
        devicePixelRatio: globalThis.devicePixelRatio,
      };
    },

    render({ cells, size, width }) {
      const stage = document.getElementById('stage');
      stage.replaceChildren();
      const card = document.createElement('div');
      card.id = 'card';
      card.className = 'poc-qr';
      const gridSize = size + 8; // QR 규격의 조용한 여백 4모듈씩
      card.style.width = `${width}px`;
      card.style.height = `${width}px`;
      card.style.background = '#fff';
      card.style.display = 'grid';
      card.style.gridTemplateColumns = `repeat(${gridSize}, minmax(0, 1fr))`;
      card.style.gridTemplateRows = `repeat(${gridSize}, minmax(0, 1fr))`;
      card.style.gap = '0';
      card.style.padding = '0';
      card.style.boxSizing = 'border-box';
      for (let r = 0; r < gridSize; r++) {
        for (let c = 0; c < gridSize; c++) {
          const inQr = r >= 4 && r < size + 4 && c >= 4 && c < size + 4;
          const on = inQr ? cells[(r - 4) * size + (c - 4)] === true : false;
          card.append(makeCell(on));
        }
      }
      stage.append(card);
      return twoFrames().then(() => {
        const rect = card.getBoundingClientRect();
        return { width: rect.width, height: rect.height, x: rect.x, y: rect.y };
      });
    },

    async load(pngBase64) {
      const response = await fetch(`data:image/png;base64,${pngBase64}`);
      baseImage = await createImageBitmap(await response.blob());
      return { width: baseImage.width, height: baseImage.height };
    },

    async measure({ level, expected, warmup, iterations }) {
      if (!baseImage) throw new Error('먼저 load()로 QR 카드를 실어야 합니다');
      const frame = document.createElement('canvas');
      frame.width = FRAME_SIZE;
      frame.height = FRAME_SIZE;
      const ctx = frame.getContext('2d', { willReadFrequently: true });
      const frameStart = performance.now();
      ctx.fillStyle = '#0f1115';
      ctx.fillRect(0, 0, FRAME_SIZE, FRAME_SIZE);
      ctx.save();
      ctx.translate(FRAME_SIZE / 2, FRAME_SIZE / 2);
      ctx.rotate((level.rotateDeg * Math.PI) / 180);
      ctx.filter = `blur(${level.blurPx}px) brightness(${level.brightness})`;
      ctx.drawImage(baseImage, -baseImage.width / 2, -baseImage.height / 2, baseImage.width, baseImage.height);
      ctx.restore();
      const buildMs = performance.now() - frameStart;
      const imageData = ctx.getImageData(0, 0, FRAME_SIZE, FRAME_SIZE);
      const source = useDetector ? frame : imageData;

      for (let i = 0; i < warmup; i++) {
        try {
          await readOnce(source, imageData);
        } catch {
          // 워밍업 실패는 세지 않는다(첫 호출의 초기화 비용만 빼려는 목적)
        }
      }

      const times = new Array(iterations);
      let failures = 0;
      let errors = 0;
      let lastError = null;
      const firstValues = new Set();
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        let value;
        try {
          value = await readOnce(source, imageData);
        } catch (error) {
          errors++;
          lastError = String(error);
          value = undefined;
        }
        times[i] = performance.now() - t0;
        if (value !== expected) failures++;
        if (i < 20) firstValues.add(value === expected ? 'ok' : String(value));
      }
      return {
        times,
        failures,
        errors,
        lastError,
        uniqueFirst20: [...firstValues],
        frame: { width: FRAME_SIZE, height: FRAME_SIZE },
        qr: { width: baseImage.width, height: baseImage.height },
        buildMs,
      };
    },
  };
})();
