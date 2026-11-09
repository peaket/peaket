// 시작 파일을 실제로 띄운다: 기기 라벨 키의 지문이 관리 포트 지표로 나온다(두 서비스의 키가 같은지 견주는 값, B-T16, ADR-0251). 키는 시험만을 위한 합성 값이다.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { bootMain } from './main-boot.js';
import type { ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer;
let managementPort = 0;

beforeAll(async () => {
  ({ valkey, managementPort } = await bootMain({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: Buffer.alloc(32, 0x42).toString('base64') }));
}, 120_000);

afterAll(() => {
  valkey?.stop();
});

test('B-T16①_기기라벨키의지문이정보지표로나온다_키값은나오지않는다', async () => {
  const metrics = await (await fetch(`http://127.0.0.1:${managementPort}/metrics`)).text();
  expect(metrics).toContain('inv_ref_key_info{service="trust-svc",label="device",version="1",fingerprint="k1.iD-0b"} 1');
  expect(metrics).not.toContain(Buffer.alloc(32, 0x42).toString('base64'));
});
