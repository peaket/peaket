// QR 디코더 경계 시험(BUILD_ORDER GAT-150). BarcodeDetector가 있는 브라우저와 없는 환경을 가른다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBarcodeDecoder } from '../src/storage/decoder.ts';

const source = {} as ImageBitmapSource;

test('GAT-150 BarcodeDetector가 있으면 QR 원문을 돌려주고, 못 읽으면 undefined다', async () => {
  let formats: readonly string[] = [];
  const decoder = createBarcodeDecoder({
    BarcodeDetector: class {
      constructor(options: { formats: readonly string[] }) {
        formats = options.formats;
      }
      async detect() {
        return [{ rawValue: 'PEAKET-QR-v1:test' }];
      }
    },
  });
  assert.ok(decoder);
  assert.deepEqual(formats, ['qr_code']);
  assert.equal(await decoder.decode(source), 'PEAKET-QR-v1:test');

  const empty = createBarcodeDecoder({
    BarcodeDetector: class {
      async detect() {
        return [];
      }
    },
  });
  assert.equal(await empty?.decode(source), undefined);

  const blank = createBarcodeDecoder({
    BarcodeDetector: class {
      async detect() {
        return [{ rawValue: '' }];
      }
    },
  });
  assert.equal(await blank?.decode(source), undefined);
});

test('GAT-150 BarcodeDetector가 없는 환경은 디코더를 만들지 않는다', () => {
  assert.equal(createBarcodeDecoder({}), undefined);
});

test('GAT-150 BarcodeDetector가 QR 형식을 지원하지 않으면 디코더를 만들지 않는다', () => {
  assert.equal(
    createBarcodeDecoder({
      BarcodeDetector: class {
        constructor() {
          throw new Error('unsupported format');
        }
        async detect() {
          return [];
        }
      },
    }),
    undefined,
  );
});
