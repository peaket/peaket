// 최초 방문 쿠키를 주는 시청자 응답 함수(services/queue-svc/edge/preverify-viewer-response.js, docs/features/bot-defense.md §4.8, ADR-0223 결정 4, ADR-0249 결정 1, Q-T39).
// CloudFront Functions 런타임을 Node로 흉내 낸다. 실제 CloudFront에서는 돌려 보지 못했다(HOT-012).
import * as nodeCrypto from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { HmacFirstVisitCookies } from '../src/modules/entry/adapters/first-visit-cookie.js';

const FILE = fileURLToPath(new URL('../edge/preverify-viewer-response.js', import.meta.url));
const SRC = readFileSync(FILE, 'utf8');
const ENTRY_SRC = readFileSync(fileURLToPath(new URL('../edge/entry-viewer-request.js', import.meta.url)), 'utf8');

type Kvs = Record<string, string>;
type Handler = (event: unknown) => Promise<{ statusCode: number; cookies: Record<string, { value: string; attributes: string }> }>;

function load(data: Kvs, now: number, o: { fail?: (key: string) => boolean } = {}): Handler {
  const kvs = {
    async get(key: string): Promise<unknown> {
      if (o.fail?.(key) || !(key in data)) throw new Error('KeyNotFound');
      return data[key];
    },
    async exists(key: string): Promise<boolean> {
      if (o.fail?.(key)) throw new Error('저장소 오류');
      return key in data;
    },
  };
  class FixedDate extends Date {
    constructor(...a: []) {
      super(...(a.length > 0 ? a : ([now] as unknown as [])));
    }
    static override now() {
      return now;
    }
  }
  const sandbox: Record<string, unknown> = { cf: { kvs: () => kvs }, crypto: nodeCrypto, Buffer, Date: FixedDate };
  vm.runInNewContext(`${SRC.replace(/^import cf from 'cloudfront';\r?\n/m, '').replace(/^import crypto from 'crypto';\r?\n/m, '')}\n;this.handler = handler;`, sandbox);
  return sandbox.handler as Handler;
}

const NOW = 1_800_000_000_123;
const E = 'evt_1-a';
const REQ = 'EXAMPLEntjQpEXAMPLE_SG5Z-EXAMPLE==';
const KEY = 'F'.repeat(43);
const KVS: Kvs = { 'fv:cur': 'k1', 'fv:key:k1': KEY };
const reader = new HmacFirstVisitCookies([{ kid: 'k1', key: KEY }]);

function event(o: { method?: string; uri?: string; status?: number; cookie?: string; requestId?: string } = {}) {
  return {
    version: '1.0',
    context: { requestId: o.requestId ?? REQ, eventType: 'viewer-response' },
    viewer: { ip: '198.51.100.1' },
    request: { method: o.method ?? 'POST', uri: o.uri ?? `/v1/queues/${E}/pre-verifications`, querystring: {}, headers: {}, cookies: o.cookie ? { '__Host-peaket_fv': { value: o.cookie } } : {} },
    response: { statusCode: o.status ?? 201, statusDescription: 'Created', headers: {}, cookies: {} },
  };
}

const plain = <T>(v: unknown) => JSON.parse(JSON.stringify(v)) as T;
const signed = (o: { kid?: string; t?: number; key?: string } = {}) => {
  const head = `v1.${o.kid ?? 'k1'}.${o.t ?? NOW - 1000}.${Buffer.from(REQ).toString('base64url')}`;
  return `${head}.${nodeCrypto.createHmac('sha256', o.key ?? KEY).update(`PEAKET-firstvisit-v1.${head}`).digest('base64url')}`;
};

describe('시청자 응답 함수(Q-T39 ①②④)', () => {
  test('[Q-T39] [ASVS v5.0.0-3.3.1] [ASVS v5.0.0-3.3.2] [ASVS v5.0.0-3.3.3] [ASVS v5.0.0-3.3.4] 쿠키가없는201응답에_정본의속성으로서명한쿠키를싣는다', async () => {
    const r = await load(KVS, NOW)(event());
    const c = plain<{ cookies: Record<string, { value: string; attributes: string }> }>(r).cookies['__Host-peaket_fv']!;
    expect(c.attributes).toBe('Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000');
    expect(c.value).not.toMatch(/[;,\s=]/);
    expect(reader.read(c.value)).toEqual({ kid: 'k1', issuedAtMs: NOW });
  });

  test('[Q-T39] 맞는쿠키가이미있으면_새로주지않는다', async () => {
    const r = plain<{ cookies: Record<string, unknown> }>(await load(KVS, NOW)(event({ cookie: signed() })));
    expect(r.cookies).toEqual({});
  });

  test('[Q-T39] 옛kid로서명한맞는쿠키도_다시주지않는다', async () => {
    const old = 'E'.repeat(43);
    const r = plain<{ cookies: Record<string, unknown> }>(await load({ ...KVS, 'fv:key:k0': old }, NOW)(event({ cookie: signed({ kid: 'k0', key: old }) })));
    expect(r.cookies).toEqual({});
  });

  test('[Q-T39] 모양이나MAC이틀린쿠키는_없는것으로보고새로준다', async () => {
    for (const cookie of ['garbage', 'v1.k1.1.a.b', signed({ key: 'B'.repeat(43) })]) {
      const c = plain<{ cookies: Record<string, { value: string }> }>(await load(KVS, NOW)(event({ cookie }))).cookies['__Host-peaket_fv'];
      expect(reader.read(c!.value), cookie).toEqual({ kid: 'k1', issuedAtMs: NOW });
    }
  });

  test('[Q-T39] [ASVS v5.0.0-16.5.2] 서명키를읽지못하면_쿠키없이그대로돌려준다', async () => {
    for (const fail of ['fv:cur', 'fv:key:k1']) {
      const e = event();
      expect(await load(KVS, NOW, { fail: (k) => k === fail })(e), fail).toBe(e.response);
    }
  });

  test('[Q-T39] 들고있던쿠키의키를읽지못하면(저장소오류)_새로주지않는다(사람의쿠키나이를0으로돌리지않는다)', async () => {
    const data = { ...KVS, 'fv:key:k0': 'E'.repeat(43) };
    const e = event({ cookie: signed({ kid: 'k0', key: 'E'.repeat(43) }) });
    const r = plain<{ cookies: Record<string, unknown> }>(await load(data, NOW, { fail: (k) => k === 'fv:key:k0' })(e));
    expect(r.cookies).toEqual({});
  });

  test('[Q-T39] 저장소에서지운kid의쿠키는_없는것으로보고새로줘서쿠키나이를다시얻게한다', async () => {
    const c = plain<{ cookies: Record<string, { value: string }> }>(await load(KVS, NOW)(event({ cookie: signed({ kid: 'k-gone' }) }))).cookies['__Host-peaket_fv'];
    expect(reader.read(c!.value)).toEqual({ kid: 'k1', issuedAtMs: NOW });
  });

  test('[Q-T39] 사전검증201이아니면_저장소를읽지않고그대로돌려준다', async () => {
    const reads: string[] = [];
    const h = load({}, NOW, { fail: (k) => (reads.push(k), true) });
    for (const e of [event({ method: 'GET' }), event({ method: 'OPTIONS' }), event({ status: 200 }), event({ status: 400 }), event({ status: 503 }), event({ uri: `/v1/queues/${E}/entries` }), event({ uri: '/v1/queues/%2e%2e/pre-verifications' })]) {
      expect(await h(e)).toBe(e.response);
    }
    expect(reads).toEqual([]);
  });

  test('[Q-T39] 요청ID의=는_base64url로바뀌어쿠키글자로허용된다', async () => {
    const c = plain<{ cookies: Record<string, { value: string }> }>(await load(KVS, NOW)(event())).cookies['__Host-peaket_fv']!;
    expect(c.value.split('.')[3]).toBe(Buffer.from(REQ).toString('base64url'));
    expect(c.value.includes('=')).toBe(false);
  });

  test('[Q-T39] ④공연상세응답에는_Set-Cookie를싣지않는다(경로가달라함수가손대지않고,공연페이지배포에붙이지않는다)', async () => {
    const reads: string[] = [];
    const h = load({}, NOW, { fail: (k) => (reads.push(k), true) });
    for (const e of [event({ method: 'GET', uri: `/events/${E}`, status: 200 }), event({ uri: `/events/${E}`, status: 201 })]) {
      expect(await h(e)).toBe(e.response);
      expect(e.response.cookies).toEqual({});
    }
    expect(reads).toEqual([]);
    // 인프라 코드가 아직 없어 배포 연결은 정본 문장으로 고정한다
    const infra = readFileSync(fileURLToPath(new URL('../../../docs/infra.md', import.meta.url)), 'utf8');
    expect(infra).toContain('공연 페이지 배포(`www`)에는 이 함수를 붙이지 않는다');
  });

  test('[Q-T39] [ASVS v5.0.0-13.3.2] 진입함수와_저장소키를나눠쓴다', () => {
    expect(ENTRY_SRC).not.toMatch(/fv:|firstvisit|peaket_fv/);
    expect(SRC).not.toMatch(/arr:|sale:|mode:entry|peaket_arr/);
  });

  test('[Q-T39] 함수원문은_10KB이하이고_런타임이받지않는문법을쓰지않는다', () => {
    expect(statSync(FILE).size).toBeLessThanOrEqual(10_240);
    expect(SRC).not.toMatch(/\?\.|\?\?|\bclass\b|\beval\b|new Function|setTimeout/);
    expect(SRC.match(/\basync\b/g)).toHaveLength(1);
    expect(SRC).toMatch(/^import cf from 'cloudfront';\r?$/m);
  });
});
