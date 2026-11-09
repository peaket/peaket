// 조사용 가명의 라벨 키 링(docs/security/secrets-and-keys.md '조사용 가명 키', docs/features/bot-defense.md §4.9, B-T24, ADR-0251).
// identity-svc와 trust-svc가 같은 코드를 쓴다(기기 가명이 같은 값이어야 한다, B-T16). 키는 시험만을 위한 합성 값이다.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Registry } from '@prometheus-io/client';
import { fakeClock, INV_REF_KEY_TTL_MS, invRef, invRefKeyInfoGauge, invRefSourcesFromEnv, InvRefKeyRing, type LabelMacClient, labelKeyMessage } from '../src/index.js';

const ROOT = Buffer.alloc(32, 7);
const T0 = Date.UTC(2026, 10, 9);
const expected = (labelKey: Buffer, version: number, value: string) => `k${version}.${createHmac('sha256', labelKey).update(value, 'utf8').digest('base64url')}`;
const labelKey = createHmac('sha256', ROOT).update('PEAKET-inv-ref-v1|device').digest();

function kms(): LabelMacClient & { calls: string[]; fail?: Error | undefined } {
  const k: LabelMacClient & { calls: string[]; fail?: Error | undefined } = {
    calls: [],
    mac: async (keyId, message) => {
      k.calls.push(`${keyId}|${Buffer.from(message).toString('utf8')}`);
      if (k.fail) throw k.fail;
      return createHmac('sha256', ROOT).update(message).digest();
    },
  };
  return k;
}

const makeRing = (client: LabelMacClient, clock = fakeClock({ now: T0 }), missing: string[] = []) => {
  const ring = new InvRefKeyRing<'device'>({ sources: [{ label: 'device', version: 2, kmsKeyId: 'kms-device' }], client, clock, onMissing: (l, r) => missing.push(`${l}:${r}`) });
  return { ring, clock, missing };
};

describe('계산식', () => {
  test('B-T24_invRef는_k판번호점과_base64urlHMAC이고_라벨키는라벨을붙인글을KMS로MAC한값이다', () => {
    expect(invRef(labelKey, 3, 'dev')).toBe(expected(labelKey, 3, 'dev'));
    expect(Buffer.from(labelKeyMessage('device')).toString('utf8')).toBe('PEAKET-inv-ref-v1|device');
  });
});

describe('B-T24 라벨 키 받기와 캐시', () => {
  test('B-T24①_값마다KMS를부르지않는다', async () => {
    const client = kms();
    const { ring } = makeRing(client);
    await ring.refresh();
    expect(ring.ref('device', 'a')).toBe(expected(labelKey, 2, 'a'));
    expect(ring.ref('device', 'b')).toBe(expected(labelKey, 2, 'b'));
    expect(client.calls).toEqual(['kms-device|PEAKET-inv-ref-v1|device']);
  });

  test('B-T24②_첫받기가실패하면칸을비우고까닭을센다_KMS를기다리지않는다', async () => {
    const client = kms();
    client.fail = Object.assign(new Error('rate'), { name: 'ThrottlingException' });
    const { ring, missing } = makeRing(client);
    await ring.refresh();
    expect(ring.ref('device', 'a')).toBeUndefined();
    expect(missing).toEqual(['device:THROTTLED']);
  });

  test('B-T24③_다시받기가실패해도받은지10분까지는옛키를쓴다', async () => {
    const client = kms();
    const { ring, clock, missing } = makeRing(client);
    await ring.refresh();
    client.fail = new Error('down');
    clock.advance(INV_REF_KEY_TTL_MS - 1);
    await ring.refresh();
    expect(ring.ref('device', 'a')).toBe(expected(labelKey, 2, 'a'));
    expect(missing).toEqual([]);
  });

  test('B-T24④⑤_10분이지나면칸을비우고_다시받으면돌아온다', async () => {
    const client = kms();
    const { ring, clock, missing } = makeRing(client);
    await ring.refresh();
    client.fail = new Error('down');
    await ring.refresh();
    clock.advance(INV_REF_KEY_TTL_MS);
    expect(ring.ref('device', 'a')).toBeUndefined();
    expect(missing).toEqual(['device:KMS_ERROR']);
    client.fail = undefined;
    await ring.refresh();
    expect(ring.ref('device', 'a')).toBe(expected(labelKey, 2, 'a'));
  });

  test('B-T24①_첫받기는정한시간까지만기다리고_그뒤에도돌아오면쓴다', async () => {
    let release: (v: Uint8Array) => void = () => {};
    const ring = new InvRefKeyRing<'device'>({ sources: [{ label: 'device', version: 1, kmsKeyId: 'k' }], client: { mac: () => new Promise((r) => (release = r)) }, clock: fakeClock({ now: T0 }) });
    const started = ring.start({ waitMs: 5, everyMs: 3_600_000 });
    await started.ready;
    expect(ring.ref('device', 'a')).toBeUndefined();
    release(labelKey);
    await new Promise((r) => setTimeout(r, 0));
    expect(ring.ref('device', 'a')).toBe(expected(labelKey, 1, 'a'));
    started.stop();
  });

  test('B-T24⑥_라벨키값은직렬화에나오지않는다', async () => {
    const { ring } = makeRing(kms());
    await ring.refresh();
    expect(JSON.stringify(ring)).toBe('"[InvRefKeyRing]"');
    expect(JSON.stringify(ring)).not.toContain(labelKey.toString('base64'));
  });

  test('B-T24_KMS응답이32바이트가아니면라벨키로받지않는다', async () => {
    const missing: string[] = [];
    const ring = new InvRefKeyRing<'device'>({ sources: [{ label: 'device', version: 1, kmsKeyId: 'k' }], client: { mac: async () => new Uint8Array(16) }, clock: fakeClock({ now: T0 }), onMissing: (l, r) => missing.push(`${l}:${r}`) });
    await ring.refresh();
    expect(ring.ref('device', 'a')).toBeUndefined();
    expect(missing).toEqual(['device:KMS_ERROR']);
  });
});

describe('B-T24 설정 읽기', () => {
  const VALUE = Buffer.alloc(32, 9).toString('base64');
  test('B-T24⑦_값라벨키는local·ci·demo에서만받는다', () => {
    for (const PEAKET_ENV of ['local', 'ci', 'demo']) expect(invRefSourcesFromEnv({ PEAKET_ENV, PEAKET_INV_REF_DEVICE_KEY: VALUE }, ['device']).sources).toHaveLength(1);
    for (const PEAKET_ENV of ['staging', 'prod']) expect(() => invRefSourcesFromEnv({ PEAKET_ENV, PEAKET_INV_REF_DEVICE_KEY: VALUE }, ['device'])).toThrow(/KMS_KEY/);
    // 환경이 없으면 운영으로 본다
    expect(() => invRefSourcesFromEnv({ PEAKET_INV_REF_DEVICE_KEY: VALUE }, ['device'])).toThrow(/KMS_KEY/);
  });

  test('B-T24⑦_KMS흉내주소는local·ci에서만받는다', () => {
    expect(invRefSourcesFromEnv({ PEAKET_ENV: 'ci', PEAKET_KMS_ENDPOINT: 'http://x', PEAKET_INV_REF_DEVICE_KMS_KEY: 'k' }, ['device']).endpoint).toBe('http://x');
    expect(() => invRefSourcesFromEnv({ PEAKET_ENV: 'prod', PEAKET_KMS_ENDPOINT: 'http://x', PEAKET_INV_REF_DEVICE_KMS_KEY: 'k' }, ['device'])).toThrow(/PEAKET_KMS_ENDPOINT/);
  });

  const unconfigured = (PEAKET_ENV: string) => {
    const r = invRefSourcesFromEnv({ PEAKET_ENV }, ['device']);
    const missing: string[] = [];
    const ring = new InvRefKeyRing<'device'>({ sources: r.sources, clock: fakeClock({ now: T0 }), countUnconfigured: r.countUnconfigured, onMissing: (l, x) => missing.push(`${l}:${x}`) });
    return { r, ring, missing };
  };

  test('B-T24_운영·스테이징에설정이없는라벨은경고하고_칸이비며_NO_KEY로센다', () => {
    for (const env of ['prod', 'staging']) {
      const { r, ring, missing } = unconfigured(env);
      expect(r.sources).toEqual([]);
      expect(r.warnings.join(' ')).toMatch(/PEAKET_INV_REF_DEVICE_KMS_KEY/);
      expect(ring.ref('device', 'a')).toBeUndefined();
      expect(missing).toEqual(['device:NO_KEY']);
    }
  });

  test('B-T24_local·ci·demo에설정이없는라벨은세지않는다', () => {
    for (const env of ['local', 'ci', 'demo']) {
      const { ring, missing } = unconfigured(env);
      expect(ring.ref('device', 'a')).toBeUndefined();
      expect(missing).toEqual([]);
    }
  });

  test('B-T24_별칭과_32바이트가아닌값과_라벨끼리같은KMS키는시작하지않는다', () => {
    const clock = fakeClock({ now: T0 });
    expect(() => new InvRefKeyRing<'device'>({ sources: [{ label: 'device', version: 1, kmsKeyId: 'alias/x' }], client: kms(), clock })).toThrow(/별칭/);
    expect(() => new InvRefKeyRing<'device'>({ sources: [{ label: 'device', version: 1, key: Buffer.alloc(16) }], clock })).toThrow(/32바이트/);
    expect(() => new InvRefKeyRing<'device' | 'contact'>({ sources: [{ label: 'device', version: 1, kmsKeyId: 'same' }, { label: 'contact', version: 1, kmsKeyId: 'arn:aws:kms:r:1:key/same' }], client: kms(), clock })).toThrow(/다른 KMS 키/);
  });
});

describe('B-T16 키 지문(두 서비스의 라벨 키가 같은지 견준다)', () => {
  const FIXED = Buffer.alloc(32, 0x42);
  const FIXED_FP = 'k1.iD-0b';

  test('B-T16_지문은고정문구의invRef앞8자이고_키값을담지않는다', () => {
    const ring = new InvRefKeyRing<'device'>({ sources: [{ label: 'device', version: 1, key: FIXED }], clock: fakeClock({ now: T0 }) });
    const seen: [string, number, string][] = [];
    ring.onFingerprint((l, v, f) => seen.push([l, v, f]));
    expect(seen).toEqual([['device', 1, FIXED_FP]]);
    expect(seen[0]![2]).toHaveLength(8);
    expect(seen[0]![2]).not.toContain(FIXED.toString('base64').slice(0, 6));
  });

  test('B-T16_KMS키는받은뒤에지문을내고_같은키를다시받으면또내지않는다', async () => {
    const client = kms();
    const { ring } = makeRing(client);
    const seen: string[] = [];
    ring.onFingerprint((l, v, f) => seen.push(`${l}:${v}:${f}`));
    expect(seen).toEqual([]);
    await ring.refresh();
    await ring.refresh();
    expect(seen).toEqual([`device:2:${invRef(labelKey, 2, 'PEAKET-inv-ref-fingerprint-v1').slice(0, 8)}`]);
  });

  test('B-T16_정보지표는서비스·라벨·판·지문을이름표로값1이다', async () => {
    const registry = new Registry();
    const info = invRefKeyInfoGauge(registry, 'trust-svc');
    info('device', 1, FIXED_FP);
    expect(await registry.metrics()).toContain(`inv_ref_key_info{service="trust-svc",label="device",version="1",fingerprint="${FIXED_FP}"} 1`);
  });
});

describe('B-T24 실패한 라벨만 짧은 간격으로 다시 받기', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function twoLabels() {
    const calls: string[] = [];
    const failing = new Set<string>();
    const client: LabelMacClient = {
      mac: async (keyId, message) => {
        calls.push(keyId);
        if (failing.has(keyId)) throw new Error('down');
        return createHmac('sha256', ROOT).update(message).digest();
      },
    };
    const clock = fakeClock({ now: T0 });
    const ring = new InvRefKeyRing<'device' | 'contact'>({ sources: [{ label: 'device', version: 1, kmsKeyId: 'd' }, { label: 'contact', version: 1, kmsKeyId: 'c' }], client, clock });
    return { ring, calls, failing };
  }
  const HOUR = 3_600_000;

  test('B-T24②_실패한라벨만15·30·60초에다시받고_성공하면멈춘다', async () => {
    const t = twoLabels();
    t.failing.add('c');
    const s = t.ring.start({ everyMs: HOUR, random: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls.sort()).toEqual(['c', 'd']);
    t.calls.length = 0;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(t.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls).toEqual(['c']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.calls).toEqual(['c', 'c']);
    t.failing.delete('c');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toEqual(['c', 'c', 'c']);
    expect(t.ring.ref('contact', 'x')).toBeDefined();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(t.calls).toEqual(['c', 'c', 'c']);
    s.stop();
  });

  test('B-T24②_세번다실패하면정기받기로돌아가고_정기받기가또실패하면다시15초부터다', async () => {
    const t = twoLabels();
    t.failing.add('c');
    const s = t.ring.start({ everyMs: 300_000, random: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    t.calls.length = 0;
    await vi.advanceTimersByTimeAsync(105_000);
    expect(t.calls).toEqual(['c', 'c', 'c']);
    await vi.advanceTimersByTimeAsync(194_999);
    expect(t.calls).toEqual(['c', 'c', 'c']);
    t.calls.length = 0;
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls.sort()).toEqual(['c', 'd']);
    t.calls.length = 0;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.calls).toEqual(['c']);
    s.stop();
  });

  test('B-T24②_다시받기간격에는흔들림이붙는다', async () => {
    const t = twoLabels();
    t.failing.add('c');
    const s = t.ring.start({ everyMs: HOUR, random: () => 1 });
    await vi.advanceTimersByTimeAsync(0);
    t.calls.length = 0;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.calls).toEqual(['c']);
    s.stop();
  });

  test('B-T24②_멈추면다시받지않는다', async () => {
    const t = twoLabels();
    t.failing.add('c');
    const s = t.ring.start({ everyMs: HOUR, random: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    t.calls.length = 0;
    s.stop();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(t.calls).toEqual([]);
  });
});
