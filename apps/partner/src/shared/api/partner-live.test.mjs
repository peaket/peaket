// J-T26 내려받기 파일은 CSV(text)와 XLSX·PDF(blob) 모두 Blob으로 만든다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asBlob, newIdempotencyKey } from './partner-live.ts';

const src = readFileSync(new URL('./partner-live.ts', import.meta.url), 'utf8');

test('J-T26 CSV text 응답을 파일 Blob으로 바꾼다', async () => {
  const blob = asBlob('예매번호,이름\n1,김*민', new Headers({ 'content-type': 'text/csv; charset=utf-8' }));
  assert.equal(blob.type, 'text/csv; charset=utf-8');
  assert.equal(await blob.text(), '예매번호,이름\n1,김*민');
});

test('J-T26 Blob 응답은 그대로 쓴다', async () => {
  const source = new Blob(['x'], { type: 'application/pdf' });
  assert.equal(asBlob(source, new Headers()), source);
});

test('I-T53 멱등 키는 UUIDv4 꼴이다', () => {
  assert.match(newIdempotencyKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('FR-024 송장 등록은 목록의 version을 If-Match로 보낸다', () => {
  assert.match(src, /putPartnerMerchOrderItemShipment[\s\S]*ifMatch: `"\$\{version\}"`/);
});

test('POL-016 반품 도착 확인·거절은 멱등 키를 보낸다', () => {
  assert.match(src, /createPartnerMerchOrderItemArrivalConfirmation,[\s\S]{0,80}?idempotencyKey: newIdempotencyKey\(\)/);
  assert.match(src, /createPartnerMerchOrderItemArrivalRejection,[\s\S]{0,100}?idempotencyKey: newIdempotencyKey\(\)/);
});

test('J-T26 배송·예매자 명단 내려받기는 X-Reauth-Token과 60초 제한을 쓴다', () => {
  assert.match(src, /createPartnerMerchDeliveryExport[\s\S]*'X-Reauth-Token': token[\s\S]*timeoutMs: 60_000/);
  assert.match(src, /createPartnerEventAttendeeExport[\s\S]*'X-Reauth-Token': token[\s\S]*timeoutMs: 60_000/);
});
