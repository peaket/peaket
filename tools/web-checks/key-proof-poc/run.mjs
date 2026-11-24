// GAT-030 키 증명 PC 측정 실행기(docs/review/plans/F-05-1.md §9, ADR-0051 결정 7).
//
//   cd tools/web-checks
//   node key-proof-poc/run.mjs [--iterations 1000] [--warmup 100] [--headed]
//
// 하는 일:
//  1. 월렛이 쓰는 qr-v1.ts·qr-matrix.ts로 QR 두 판(93바이트/140자, 203바이트/305자)을 만든다.
//  2. Chromium 390×844·deviceScaleFactor 1 화면에 화면 폭 90%(351px) CSS 그리드로 그려 카드만 캡처한다.
//  3. 열화 다섯 단계(흐림·기울임·밝기 [가정])를 캔버스에 걸고, 스캐너의 디코더(BarcodeDetector)가 있으면 그것으로,
//     없으면 zxing-wasm 대체로 1,000번씩 읽어 p50·p95·실패율을 낸다. 어느 쪽인지 결과에 적는다.
//  4. `reports/key-proof-poc.json`(git 무시)에 원자료를, 표준 출력에 Markdown 표를 낸다.
//
// Windows Chromium에는 BarcodeDetector(Shape Detection API)가 없다. 그때 결과의 decoder는 zxing-wasm이며
// 스캐너가 쓰는 디코더와 같지 않다는 한계를 결과 파일에 함께 적는다.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { cpus, arch, platform, release, totalmem, version as osVersion } from 'node:os';
import { chromium } from '@playwright/test';
import { buildPanels, EXPECT, QR_CSS_WIDTH, QR_ERROR_CORRECTION } from './fixtures.mjs';
import { judge, LEVELS, levelText, markdownTable, summarize } from './levels.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = join(HERE, '..');
const DECODER_SOURCE = join(TOOL_ROOT, '..', '..', 'apps', 'scanner', 'src', 'storage', 'decoder.ts');
const requireFromTool = createRequire(join(TOOL_ROOT, 'package.json'));

function argNumber(name, fallback) {
  const at = process.argv.indexOf(name);
  if (at === -1) return fallback;
  const raw = process.argv[at + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 값이 올바르지 않습니다: ${raw}`);
  return value;
}

const ITERATIONS = argNumber('--iterations', 1000);
const WARMUP = argNumber('--warmup', 100);
const HEADED = process.argv.includes('--headed');

function zxingAssets() {
  const readerEntry = requireFromTool.resolve('zxing-wasm/reader');
  const wasmPath = requireFromTool.resolve('zxing-wasm/reader/zxing_reader.wasm');
  const iifePath = join(dirname(readerEntry), '..', '..', 'iife', 'reader', 'index.js');
  return {
    wasm: readFileSync(wasmPath),
    iife: readFileSync(iifePath, 'utf8'),
    wasmPath,
    iifePath,
  };
}

/** 스캐너 어댑터 원본을 타입만 지워 브라우저 고전 스크립트로 만든다(같은 코드를 쓴다) */
function scannerDecoderScript() {
  const source = readFileSync(DECODER_SOURCE, 'utf8');
  const js = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/\bexport\s+(?=(?:async\s+)?function|const|let|class|var)/g, '')
    .trimEnd();
  return `${js}\nwindow.__createBarcodeDecoder = typeof createBarcodeDecoder === 'function' ? createBarcodeDecoder : undefined;\n`;
}

const PAGE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GAT-030 키 증명 PoC</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #0f1115; overflow: hidden; }
  #stage { width: 390px; height: 844px; display: flex; align-items: center; justify-content: center; }
</style>
</head>
<body><div id="stage"></div></body>
</html>`;

function environment(browser, decoderInfo, panelInfo) {
  return {
    measuredAt: new Date().toISOString(),
    os: { platform: platform(), release: release(), version: osVersion(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', totalMemGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10 },
    node: process.version,
    playwright: JSON.parse(readFileSync(join(TOOL_ROOT, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version,
    browser: { version: browser.version(), name: 'Chromium(Playwright)' },
    decoder: decoderInfo,
    viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
    qr: {
      cssWidth: QR_CSS_WIDTH,
      cssWidthRatio: QR_CSS_WIDTH / 390,
      errorCorrection: QR_ERROR_CORRECTION,
      quietZoneModules: 4,
      panels: panelInfo,
    },
    iterations: ITERATIONS,
    warmup: WARMUP,
    degradation: LEVELS.map((l) => ({ ...l, text: levelText(l) })),
    note: '흐림·기울임·밝기 단계는 [가정]이고, 서명 바이트는 디코딩 밀도 측정용 고정 대역이다(검증하지 않는다).',
  };
}

async function main() {
  const panels = buildPanels();
  for (const [key, expect] of Object.entries(EXPECT)) {
    const panel = panels[key];
    if (panel.byteLength !== expect.bytes || panel.textLength !== expect.text || panel.matrix.size !== expect.modules || panel.qrVersion !== expect.version) {
      throw new Error(`${key} 판의 길이가 기대와 다릅니다: ${JSON.stringify({ bytes: panel.byteLength, text: panel.textLength, modules: panel.matrix.size, version: panel.qrVersion })}`);
    }
  }

  const { wasm, iife } = zxingAssets();
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-experimental-web-platform-features', '--enable-blink-features=ShapeDetection'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(0);
    await page.route('http://key-proof-poc.local/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/' || path === '/index.html') {
        await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML });
        return;
      }
      if (path === '/zxing_reader.wasm') {
        await route.fulfill({ status: 200, contentType: 'application/wasm', body: wasm });
        return;
      }
      await route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'not found' });
    });
    await page.goto('http://key-proof-poc.local/');
    await page.addScriptTag({ content: iife });
    await page.addScriptTag({ content: scannerDecoderScript() });
    await page.addScriptTag({ path: join(HERE, 'page-runtime.js') });

    const decoderInfo = await page.evaluate(() => window.__poc.init());
    const results = { 'qr-v1': {}, 'key-proof': {} };
    const panelInfo = {};

    for (const panel of Object.values(panels)) {
      const rect = await page.evaluate((data) => window.__poc.render(data), {
        cells: Array.from(panel.matrix.cells),
        size: panel.matrix.size,
        width: QR_CSS_WIDTH,
      });
      const png = await page.screenshot({ type: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      const loaded = await page.evaluate((b64) => window.__poc.load(b64), png.toString('base64'));
      panelInfo[panel.id] = {
        label: panel.label,
        bytes: panel.byteLength,
        base45: panel.textLength,
        modules: panel.matrix.size,
        qrVersion: panel.qrVersion,
        qrCssWidth: rect.width,
        captured: loaded,
      };
      for (const level of LEVELS) {
        const raw = await page.evaluate(
          (input) => window.__poc.measure(input),
          { level, expected: panel.text, warmup: WARMUP, iterations: ITERATIONS },
        );
        if (level.id === 'L1' && raw.failures > 0) {
          // 맑은 351px QR을 못 읽으면 하네스(캡처·채널·디코더) 결함으로 본다. 열화 단계의 실패는 측정값이다.
          throw new Error(`${panel.id} L1: 맑은 QR을 ${raw.failures}번 못 읽었습니다. 하네스를 확인하세요: ${JSON.stringify(raw.uniqueFirst20)}`);
        }
        results[panel.id][level.id] = { ...summarize(raw), frame: raw.frame, qr: raw.qr, buildMs: raw.buildMs, errors: raw.errors, lastError: raw.lastError };
        process.stderr.write(`${panel.id} ${level.id} p50=${results[panel.id][level.id].p50.toFixed(2)}ms p95=${results[panel.id][level.id].p95.toFixed(2)}ms fail=${(results[panel.id][level.id].failureRate * 100).toFixed(1)}%\n`);
      }
    }

    const decision = judge(results);
    const report = {
      environment: environment(browser, decoderInfo, panelInfo),
      results,
      decision,
    };
    mkdirSync(join(TOOL_ROOT, 'reports'), { recursive: true });
    const outPath = join(TOOL_ROOT, 'reports', 'key-proof-poc.json');
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(markdownTable(results));
    console.log('');
    console.log(`판정: ${decision.verdict}`);
    for (const check of decision.checks) console.log(`- ${check.id} ${check.pass ? '통과' : '실패'}: ${check.text}`);
    console.log('');
    console.log(`원자료: ${outPath}`);
    console.log(`디코더: ${decoderInfo.useDetector ? '스캐너 BarcodeDetector 어댑터' : `zxing-wasm ${decoderInfo.zxingVersion} 대체(BarcodeDetector 없음; ${decoderInfo.barcodeDetector})`}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
