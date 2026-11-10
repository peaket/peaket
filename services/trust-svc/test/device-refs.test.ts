// trust-svc의 기기 가명(docs/features/bot-defense.md §3.2·§4.9, B-T16·B-T24, ADR-0251). 키는 시험만을 위한 합성 값이다.
import { createHmac } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { deviceRefsFromEnv } from '../src/modules/scoring/adapters/device-refs.js';

const ROOT = Buffer.alloc(32, 3);
const VALUE_KEY = Buffer.alloc(32, 9);
const ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
const T0 = Date.UTC(2026, 10, 9);
const ref = (key: Buffer, v: number, id: string) => `k${v}.${createHmac('sha256', key).update(id, 'utf8').digest('base64url')}`;
const derived = createHmac('sha256', ROOT).update('PEAKET-inv-ref-v1|device').digest();

function kms() {
  const calls: string[] = [];
  const out: { calls: string[]; fail?: Error | undefined; endpoints: (string | undefined)[]; client: (e: string | undefined) => { mac(k: string, m: Uint8Array): Promise<Uint8Array> } } = {
    calls,
    endpoints: [],
    client: (e) => {
      out.endpoints.push(e);
      return {
        mac: async (keyId, message) => {
          calls.push(`${keyId}|${Buffer.from(message).toString('utf8')}`);
          if (out.fail) throw out.fail;
          return createHmac('sha256', ROOT).update(message).digest();
        },
      };
    },
  };
  return out;
}

describe('기기 가명 설정', () => {
  test('B-T16_운영은KMS로받은device라벨키로_§3.2의식과같은값을만든다', async () => {
    const k = kms();
    const d = deviceRefsFromEnv({ PEAKET_ENV: 'prod', PEAKET_INV_REF_DEVICE_KMS_KEY: 'kms-device', PEAKET_INV_REF_DEVICE_KEY_VERSION: '3' }, fakeClock({ now: T0 }), k.client);
    expect(d.warnings).toEqual([]);
    await d.ring.refresh();
    expect(d.refs.ref(ID)).toBe(ref(derived, 3, ID));
    expect(k.calls).toEqual(['kms-device|PEAKET-inv-ref-v1|device']);
  });

  test('B-T16_contact라벨키는trust-svc가받지않는다', async () => {
    const k = kms();
    const d = deviceRefsFromEnv({ PEAKET_ENV: 'prod', PEAKET_INV_REF_DEVICE_KMS_KEY: 'kms-device', PEAKET_INV_REF_CONTACT_KMS_KEY: 'kms-contact' }, fakeClock({ now: T0 }), k.client);
    await d.ring.refresh();
    expect(k.calls).toEqual(['kms-device|PEAKET-inv-ref-v1|device']);
  });

  test('B-T24_로컬·CI는라벨키값을바로받고KMS를부르지않는다', async () => {
    const k = kms();
    const d = deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: VALUE_KEY.toString('base64') }, fakeClock({ now: T0 }), k.client);
    await d.ring.refresh();
    expect(d.refs.ref(ID)).toBe(ref(VALUE_KEY, 1, ID));
    expect(k.endpoints).toEqual([]);
  });

  test('B-T24⑦_운영에라벨키값을주면시작하지않는다', () => {
    expect(() => deviceRefsFromEnv({ PEAKET_ENV: 'prod', PEAKET_INV_REF_DEVICE_KEY: VALUE_KEY.toString('base64') }, fakeClock({ now: T0 }), kms().client)).toThrow(/KMS_KEY/);
  });

  test('B-T24_운영에키설정이없으면경고하고칸을비우며_NO_KEY로센다_시작은막지않는다', () => {
    const d = deviceRefsFromEnv({ PEAKET_ENV: 'prod' }, fakeClock({ now: T0 }), kms().client);
    const missing: string[] = [];
    d.ring.onMissing((l, r) => missing.push(`${l}:${r}`));
    expect(d.warnings.join(' ')).toMatch(/PEAKET_INV_REF_DEVICE_KMS_KEY/);
    expect(d.refs.ref(ID)).toBeUndefined();
    expect(missing).toEqual(['device:NO_KEY']);
  });

  test('B-T24_로컬·CI에키설정이없으면세지않는다', () => {
    const d = deviceRefsFromEnv({ PEAKET_ENV: 'ci' }, fakeClock({ now: T0 }), kms().client);
    const missing: string[] = [];
    d.ring.onMissing((l, r) => missing.push(`${l}:${r}`));
    expect(d.refs.ref(ID)).toBeUndefined();
    expect(missing).toEqual([]);
  });

  test('B-T16①_고정입력의기기가명과지문은identity-svc시험과같은기대값이다', () => {
    // 같은 키·같은 입력·같은 기대값을 services/identity-svc/test/investigation.test.ts의 B-T16① 시험이 identity 쪽에서 본다(합성 키)
    const d = deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: Buffer.alloc(32, 0x42).toString('base64') }, fakeClock({ now: T0 }), kms().client);
    expect(d.refs.ref(ID)).toBe('k1.tmaIWF02-3cggEEHWYvtRa8r4f1TGjEqHEI0Q8746v8');
    const seen: string[] = [];
    d.ring.onFingerprint((label, version, fingerprint) => seen.push(`${label}:${version}:${fingerprint}`));
    expect(seen).toEqual(['device:1:k1.iD-0b']);
  });

  test('B-T24②_첫받기가실패하면칸이비고_다시받으면돌아온다', async () => {
    const k = kms();
    k.fail = new Error('down');
    const d = deviceRefsFromEnv({ PEAKET_ENV: 'prod', PEAKET_INV_REF_DEVICE_KMS_KEY: 'kms-device' }, fakeClock({ now: T0 }), k.client);
    await d.ring.refresh();
    expect(d.refs.ref(ID)).toBeUndefined();
    k.fail = undefined;
    await d.ring.refresh();
    expect(d.refs.ref(ID)).toBe(ref(derived, 1, ID));
  });
});

describe('키 회전의 이음(§4.10)', () => {
  const PREV_KEY = Buffer.alloc(32, 5);
  const UNTIL = T0 + 30 * 86_400_000;
  const bridged = (extra: Record<string, string> = {}) => ({
    PEAKET_ENV: 'ci',
    PEAKET_INV_REF_DEVICE_KEY: VALUE_KEY.toString('base64'),
    PEAKET_INV_REF_DEVICE_KEY_VERSION: '2',
    PEAKET_INV_REF_DEVICE_PREVIOUS_KEY: PREV_KEY.toString('base64'),
    PEAKET_INV_REF_DEVICE_PREVIOUS_KEY_VERSION: '1',
    PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL: new Date(UNTIL).toISOString(),
    ...extra,
  });

  test('B-T26①_이음기간에는identity-svc와같은이름의환경값으로옛판값과이음끝을준다', () => {
    const d = deviceRefsFromEnv(bridged(), fakeClock({ now: T0 }), kms().client);
    expect(d.refs.ref(ID)).toBe(ref(VALUE_KEY, 2, ID));
    expect(d.refs.prev!(ID)).toEqual({ ref: ref(PREV_KEY, 1, ID), until: UNTIL });
  });

  test('B-T26③_이음끝바로전까지만주고_이음끝이되면옛판을보지않는다', () => {
    const clock = fakeClock({ now: UNTIL - 1 });
    const d = deviceRefsFromEnv(bridged(), clock, kms().client);
    expect(d.refs.prev!(ID)?.ref).toBe(ref(PREV_KEY, 1, ID));
    clock.advance(1);
    expect(d.refs.prev!(ID)).toBeUndefined();
    // 새 판은 그대로다
    expect(d.refs.ref(ID)).toBe(ref(VALUE_KEY, 2, ID));
  });

  test('B-T26③_옛판설정이없으면옛판값이없다', () => {
    const d = deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: VALUE_KEY.toString('base64') }, fakeClock({ now: T0 }), kms().client);
    expect(d.refs.prev!(ID)).toBeUndefined();
  });

  test('[ASVS v5.0.0-16.3.4] B-T26③_옛판라벨키를받지못했으면옛판값이없고_받지못한수를센다', async () => {
    const k = kms();
    const d = deviceRefsFromEnv({ PEAKET_ENV: 'prod', PEAKET_INV_REF_DEVICE_KMS_KEY: 'kms-v2', PEAKET_INV_REF_DEVICE_KEY_VERSION: '2', PEAKET_INV_REF_DEVICE_PREVIOUS_KMS_KEY: 'kms-v1', PEAKET_INV_REF_DEVICE_PREVIOUS_KEY_VERSION: '1', PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL: new Date(UNTIL).toISOString() }, fakeClock({ now: T0 }), (e) => {
      const c = k.client(e);
      return { mac: (keyId, m) => (keyId === 'kms-v1' ? Promise.reject(new Error('down')) : c.mac(keyId, m)) };
    });
    const missing: string[] = [];
    d.ring.onMissing((l, r) => missing.push(`${l}:${r}`));
    await d.ring.refresh();
    expect(d.refs.ref(ID)).toBe(ref(derived, 2, ID));
    expect(d.refs.prev!(ID)).toBeUndefined();
    expect(missing).toEqual(['device:KMS_ERROR']);
  });

  test('B-T20⑬_판정이읽는키판은지금판과이음끝전의옛판뿐이다', () => {
    const clock = fakeClock({ now: UNTIL - 1 });
    const d = deviceRefsFromEnv(bridged(), clock, kms().client);
    expect(d.refs.versions!()).toEqual([2, 1]);
    clock.advance(1);
    expect(d.refs.versions!()).toEqual([2]);
    expect(deviceRefsFromEnv({ PEAKET_ENV: 'ci', PEAKET_INV_REF_DEVICE_KEY: VALUE_KEY.toString('base64'), PEAKET_INV_REF_DEVICE_KEY_VERSION: '3' }, fakeClock({ now: T0 }), kms().client).refs.versions!()).toEqual([3]);
    // 키 설정이 없으면 판정이 읽는 판이 없다(라벨 반영은 어떤 기기 가명도 쓰지 않는다)
    expect(deviceRefsFromEnv({ PEAKET_ENV: 'prod' }, fakeClock({ now: T0 }), kms().client).refs.versions!()).toEqual([]);
  });

  test('옛판이있는데이음끝이없으면시작하지않는다', () => {
    const env = bridged();
    delete (env as Record<string, string | undefined>).PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL;
    expect(() => deviceRefsFromEnv(env, fakeClock({ now: T0 }), kms().client)).toThrow(/BRIDGE_UNTIL/);
  });
});
