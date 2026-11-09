// 텔레메트리 설정이 없거나 틀려도 purchase-svc는 시작한다(ADR-0249 결정 4, 배포 조건). 시작 파일을 읽어 규칙을 고정한다
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const src = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');

test('텔레메트리설정이없으면_경고하고_낼기록은버린수로세며_시작을막지않는다', () => {
  expect(src).toMatch(/service\.logger\.warn\(\{ dep: 'telemetry-kafka' \}, warning\)/);
  expect(src).toMatch(/telemetryOff\(telemetryKafka\.warning\)/);
  expect(src).toMatch(/offer: \(record\) => telemetryDropped\(record, 1\)/);
  expect(src).not.toMatch(/throw[^\n]*telemetryKafka/);
});

test('실패한뒤다시연결할수있게_생산자공장을넘기고_종료때는지금생산자를시간안에끊는다', () => {
  expect(src).toMatch(/kafkaTelemetrySend\(\(\) => createKafkaProducer\(/);
  expect(src).toMatch(/telemetrySender\?\.disconnect\(TELEMETRY_CLOSE_MS\)/);
});

test('Kafka모듈을싣지못해도_경고하고텔레메트리를끈쪽으로내려간다', () => {
  const i = src.indexOf("await import('@peaket/platform/stream-worker')");
  expect(i).toBeGreaterThan(-1);
  const before = src.slice(Math.max(0, i - 120), i);
  expect(before).toMatch(/try \{/);
  expect(src).toMatch(/catch[^\n]*\{[\s\S]{0,200}telemetryOff\(/);
});

test('서비스닫기가실패해도_텔레메트리를닫는다', () => {
  expect(src).toMatch(/\.then\(\(\) => service\.close\(\)\)\s*\.finally\(closeTelemetry\)/);
});
