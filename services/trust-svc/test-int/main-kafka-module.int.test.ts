// Kafka 네이티브 모듈을 싣지 못해도 trust-svc는 시작하고 텔레메트리만 꺼진다(응용 프로그램 제어에 막힌 PC·이미지, ADR-0249 결정 4).
// 제어 설정 토픽 소비도 같은 모듈을 싣는다: ci에 브로커 주소가 없으면 경고 한 줄을 남기고 끈다(ADR-0334 결정 2, BAT-215 리뷰 RV215-6).
// 서비스 로거의 표준 출력(Pino 동기 쓰기, fd 1)을 받아 그 경고 줄을 본다(main-label 시험과 같은 꼴)
import fs from 'node:fs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { bootMain } from './main-boot.js';
import type { ValkeyContainer } from './valkey.js';

vi.mock('@peaket/platform/stream-worker', () => {
  throw new Error('네이티브 모듈을 불러오지 못했다');
});

let valkey: ValkeyContainer;
let managementPort = 0;

/** 서비스 로거가 표준 출력에 쓴 줄 */
const stdoutLines: string[] = [];
const realWriteSync = fs.writeSync;

beforeAll(async () => {
  (fs as { writeSync: unknown }).writeSync = (fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 1) {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      stdoutLines.push(...text.split(/\r?\n/).filter(Boolean));
      return Buffer.byteLength(text);
    }
    return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
  };
  ({ valkey, managementPort } = await bootMain({ PEAKET_ENV: 'ci', PEAKET_TELEMETRY_KAFKA_BROKERS: '127.0.0.1:1', PEAKET_LOG_LEVEL: 'warn' }));
}, 120_000);

afterAll(() => {
  (fs as { writeSync: unknown }).writeSync = realWriteSync;
  valkey?.stop();
});

test('Kafka모듈을싣지못해도_시작하고_준비상태가된다', async () => {
  const r = await fetch(`http://127.0.0.1:${managementPort}/ready`);
  expect(r.status).toBe(200);
});

test('C-T75 ② RV215-6 ⑤ Kafka모듈을싣지못하면_ci에브로커주소가없을때_제어설정토픽소비를끈다는경고한줄을남기고뜬다', () => {
  const lines = stdoutLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.dep === 'kafka' && l.kind === 'control-sync');
  expect(lines).toHaveLength(1);
  expect(lines[0]?.msg).toBe('Kafka 클라이언트를 싣지 못해 제어 설정 토픽 소비를 켜지 않았다: 로그 레벨·로그 표본 설정을 이 서비스가 받지 않는다(local·ci, 브로커 없음)');
});
