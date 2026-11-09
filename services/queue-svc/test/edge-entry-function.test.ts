// 엣지 진입 함수(services/queue-svc/edge/entry-viewer-request.js, docs/features/queue-admission.md §4 HOT-020 절, ADR-0223 결정 1).
// CloudFront Functions 런타임을 Node로 흉내 낸다: import 줄을 빼고 cf·crypto·고정 Date를 넣은 뒤 handler를 부른다. 실제 CloudFront에서는 돌려 보지 못했다(Q-T56, HOT-012).
import * as nodeCrypto from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { HmacArrivalCookies } from '../src/modules/entry/adapters/arrival-cookie.js';

const FILE = fileURLToPath(new URL('../edge/entry-viewer-request.js', import.meta.url));
const SRC = readFileSync(FILE, 'utf8');

type Handler = (event: unknown) => Promise<unknown>;
type Kvs = Record<string, string>;

function load(data: Kvs, now: number, o: { random?: number; fail?: (key: string) => boolean } = {}): Handler {
  const kvs = {
    async get(key: string, opts?: { format?: string }): Promise<unknown> {
      if (o.fail?.(key) || !(key in data)) throw new Error('KeyNotFound');
      return opts?.format === 'json' ? JSON.parse(data[key]!) : data[key];
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
  const math = Object.create(Math) as Math;
  math.random = () => o.random ?? 0.5;
  const sandbox: Record<string, unknown> = { cf: { kvs: () => kvs }, crypto: nodeCrypto, Buffer, Date: FixedDate, Math: math };
  vm.runInNewContext(`${SRC.replace(/^import cf from 'cloudfront';\r?\n/m, '').replace(/^import crypto from 'crypto';\r?\n/m, '')}\n;this.handler = handler;`, sandbox);
  return sandbox.handler as Handler;
}

const NOW = 1_800_000_000_123;
const E = 'evt_1-a';
const REQ = 'EXAMPLEntjQpEXAMPLE_SG5Z-EXAMPLE==';
const SID = 'sess-1';
const KEY = 'A'.repeat(43);
const at = (sid: string) => `h.${Buffer.from(JSON.stringify({ sid })).toString('base64url')}.s`;
const KVS: Kvs = { 'mode:entry': JSON.stringify({ on: true, expireAtMs: NOW + 60_000 }), 'arr:cur': 'k1', 'arr:key:k1': KEY };

function event(o: { method?: string; uri?: string; cookies?: Record<string, { value: string }>; requestId?: string } = {}) {
  return {
    version: '1.0',
    context: { requestId: o.requestId ?? REQ, eventType: 'viewer-request' },
    viewer: { ip: '198.51.100.1' },
    request: { method: o.method ?? 'POST', uri: o.uri ?? `/v1/queues/${E}/entries`, querystring: {}, headers: {}, cookies: o.cookies ?? { '__Secure-peaket_at': { value: at(SID) } } },
  };
}
interface R {
  statusCode: number;
  headers: Record<string, { value: string }>;
  cookies?: Record<string, { value: string; attributes: string }>;
  body: { data: string };
}
const plain = <T>(v: unknown) => JSON.parse(JSON.stringify(v)) as T;
const signed = (o: { kid?: string; e?: string; t?: number; sid?: string; key?: string; rid?: string }) => {
  const head = `v1.${o.kid ?? 'k1'}.${o.e ?? E}.${o.t ?? NOW}.${Buffer.from(o.rid ?? REQ).toString('base64url')}.${o.sid ?? SID}`;
  return `${head}.${nodeCrypto.createHmac('sha256', o.key ?? KEY).update(`PEAKET-arrival-v1.${head}`).digest('base64url')}`;
};
const withCookie = (value: string) => ({ cookies: { '__Secure-peaket_at': { value: at(SID) }, '__Host-peaket_arr': { value } } });

describe('엣지 진입 함수(Q-T65)', () => {
  test('[Q-T65] 진입경로가아니면_저장소를읽지않고요청을그대로돌려준다', async () => {
    const reads: string[] = [];
    const h = load({}, NOW, { fail: (k) => (reads.push(k), true) });
    const e1 = event({ method: 'GET' });
    expect(await h(e1)).toBe(e1.request);
    const e2 = event({ uri: `/v1/queues/${E}/pre-verifications` });
    expect(await h(e2)).toBe(e2.request);
    const e3 = event({ uri: '/v1/queues/%2e%2e/entries' });
    expect(await h(e3)).toBe(e3.request);
    expect(reads).toEqual([]);
  });

  test('[Q-T65] 매진표시가켜지고_만료전이면_원본에보내지않고410이다', async () => {
    const data = { [`sale:${E}`]: JSON.stringify({ soldOut: true, version: 3, expireAtMs: NOW + 1 }) };
    const r = plain<R>(await load(data, NOW)(event()));
    expect(r.statusCode).toBe(410);
    expect(JSON.parse(r.body.data)).toMatchObject({ type: 'https://peaket.example/problems/sold-out', status: 410 });
    expect(r.headers['content-type']!.value).toBe('application/problem+json');
    expect(r.headers['cache-control']!.value).toBe('no-store');
    expect(r.headers['x-content-type-options']!.value).toBe('nosniff');
    expect(r.headers['access-control-allow-credentials']!.value).toBe('true');
  });

  test('[Q-T65] 매진표시가꺼졌거나_만료됐거나_모양이틀리면_원본으로보낸다', async () => {
    for (const v of [{ soldOut: false, version: 3, expireAtMs: NOW + 1 }, { soldOut: true, version: 3, expireAtMs: NOW }, { soldOut: 'yes', expireAtMs: NOW + 1 }]) {
      const e = event();
      expect(await load({ [`sale:${E}`]: JSON.stringify(v) }, NOW)(e)).toBe(e.request);
    }
  });

  test('[ASVS v5.0.0-16.5.2] [Q-T65] 저장소읽기가실패하면_그기능만건너뛰고원본으로보낸다', async () => {
    for (const k of [`sale:${E}`, 'mode:entry', 'arr:cur', 'arr:key:k1']) {
      const e = event();
      const r = await load({ ...KVS, [`sale:${E}`]: JSON.stringify({ soldOut: false, version: 1, expireAtMs: NOW + 1 }) }, NOW, { fail: (x) => x === k })(e);
      if (k === `sale:${E}`) expect(plain<R>(r).statusCode, '매진 표시만 못 읽으면 Degraded 동작은 그대로다').toBe(503);
      else expect(r, k).toBe(e.request);
    }
  });

  test('[Q-T65] Degraded가아니면_쿠키없이원본으로보낸다', async () => {
    for (const mode of [undefined, { on: false, expireAtMs: NOW + 1 }, { on: true, expireAtMs: NOW }]) {
      const data: Kvs = { ...KVS };
      if (mode) data['mode:entry'] = JSON.stringify(mode);
      else delete data['mode:entry'];
      const e = event();
      expect(await load(data, NOW)(e)).toBe(e.request);
    }
  });

  test('[ASVS v5.0.0-3.3.1] [Q-T16] [Q-T65] Degraded이고쿠키가없으면_queue-svc가받는쿠키와_0~15초Retry-After의503을바로낸다', async () => {
    const r = plain<R>(await load(KVS, NOW, { random: 0.99 })(event()));
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']!.value).toBe('15');
    expect(plain<R>(await load(KVS, NOW, { random: 0 })(event())).headers['retry-after']!.value).toBe('0');
    expect(JSON.parse(r.body.data)).toMatchObject({ type: 'https://peaket.example/problems/dependency-unavailable', status: 503 });
    const c = r.cookies!['__Host-peaket_arr']!;
    expect(c.attributes).toBe('Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600');
    expect(r.headers['access-control-expose-headers']!.value).toContain('Retry-After');
    // 쿠키 값에는 '='이 없어야 한다(요청 ID의 '='을 base64url로 바꾼다)
    expect(c.value).not.toContain('=');
    const claims = new HmacArrivalCookies([{ kid: 'k1', key: KEY }]).read(c.value);
    expect(claims).toEqual({ kid: 'k1', e: E, t: NOW, rid: REQ, sid: SID });
  });

  test('[Q-T65] Degraded이고쿠키가맞으면_원본으로보내고_옛kid로서명한쿠키도받는다', async () => {
    const ok = event(withCookie(signed({ t: NOW - 3_000 })));
    expect(await load(KVS, NOW)(ok)).toBe(ok.request);
    // 키를 교체한 뒤에도 그 kid로 서명한 쿠키는 그대로 받는다
    const rotated = { ...KVS, 'arr:cur': 'k2', 'arr:key:k2': 'B'.repeat(43) };
    const old = event(withCookie(signed({ t: NOW - 3_000 })));
    expect(await load(rotated, NOW)(old)).toBe(old.request);
  });

  test('[Q-T29] [Q-T65] 쿠키가틀리면_새쿠키의503을낸다(위조·다른sid·다른회차·10분지남·미래시각·모르는kid)', async () => {
    const cases: Record<string, string> = {
      위조: signed({ key: 'x'.repeat(43) }),
      '다른 sid': signed({ sid: 'other' }),
      '다른 회차': signed({ e: 'evt-other' }),
      '10분 지남': signed({ t: NOW - 600_001 }),
      미래: signed({ t: NOW + 5_001 }),
      '모르는 kid': signed({ kid: 'k9' }),
      모양: 'v1.only.three',
    };
    for (const [name, value] of Object.entries(cases)) {
      const r = plain<R>(await load(KVS, NOW)(event(withCookie(value))));
      expect(r.statusCode, name).toBe(503);
      expect(r.cookies!['__Host-peaket_arr']!.value, name).not.toBe(value);
    }
  });

  test('[Q-T65] sid를읽지못하면_서명없이원본으로보낸다(게이트웨이가401로끝낸다)', async () => {
    const samples: Record<string, { value: string }>[] = [{}, { '__Secure-peaket_at': { value: 'not-a-jwt' } }, { '__Secure-peaket_at': { value: `h.${Buffer.from('{"sub":"x"}').toString('base64url')}.s` } }];
    for (const cookies of samples) {
      const e = event({ cookies });
      expect(await load(KVS, NOW)(e)).toBe(e.request);
    }
  });

  test('[Q-T65] Authorization머리의JWT로들어온요청도_쿠키처럼평탄화한다', async () => {
    const e = event({ cookies: {} });
    (e.request.headers as Record<string, { value: string }>).authorization = { value: `Bearer ${at(SID)}` };
    const r = plain<R>(await load(KVS, NOW)(e));
    expect(r.statusCode).toBe(503);
    expect(new HmacArrivalCookies([{ kid: 'k1', key: KEY }]).read(r.cookies!['__Host-peaket_arr']!.value)?.sid).toBe(SID);
  });

  test('[Q-T65] 바깥이보낸표시머리는_POST가아니거나_경로가다르거나_경로를풀지못해도지운다', async () => {
    for (const o of [{ method: 'GET' }, { uri: `/v1/queues/${E}/pre-verifications` }, { uri: '/v1/queues/%E0%A4%A/entries' }]) {
      const e = event(o);
      (e.request.headers as Record<string, { value: string }>)['x-peaket-arrival'] = { value: 'unsigned' };
      const r = (await load(KVS, NOW)(e)) as typeof e.request;
      expect(r.headers, JSON.stringify(o)).not.toHaveProperty('x-peaket-arrival');
    }
  });

  test('[Q-T65] 경로글자를퍼센트로바꿔도_같은진입경로로본다', async () => {
    const data = { [`sale:${E}`]: JSON.stringify({ soldOut: true, version: 1, expireAtMs: NOW + 1 }) };
    const r = plain<R>(await load(data, NOW)(event({ uri: `/v1/queues/${E}/%65ntries` })));
    expect(r.statusCode).toBe(410);
    const bad = event({ uri: '/v1/queues/%E0%A4%A/entries' });
    expect(await load(data, NOW)(bad)).toBe(bad.request);
  });

  test('[Q-T65] 서명없이원본으로보내면_표시머리를달고_바깥이보낸같은머리는지운다', async () => {
    const off = event();
    (off.request.headers as Record<string, { value: string }>)['x-peaket-arrival'] = { value: 'unsigned' };
    const r0 = (await load({}, NOW)(off)) as typeof off.request;
    expect(r0.headers).not.toHaveProperty('x-peaket-arrival');
    const noSid = event({ cookies: {} });
    const r1 = (await load(KVS, NOW)(noSid)) as typeof noSid.request;
    expect((r1.headers as Record<string, { value: string }>)['x-peaket-arrival']?.value).toBe('unsigned');
    const noKey = event();
    const r2 = (await load(KVS, NOW, { fail: (k) => k === 'arr:cur' })(noKey)) as typeof noKey.request;
    expect((r2.headers as Record<string, { value: string }>)['x-peaket-arrival']?.value).toBe('unsigned');
    const signedOk = event(withCookie(signed({ t: NOW - 3_000 })));
    const r3 = (await load(KVS, NOW)(signedOk)) as typeof signedOk.request;
    expect(r3.headers).not.toHaveProperty('x-peaket-arrival');
  });

  test('[Q-T65] 함수원문은_문서에있는것만쓴다(charCodeAt·require를쓰지않고_crypto는import로읽는다)', () => {
    expect(SRC).not.toMatch(/charCodeAt|require\(/);
    expect(SRC).toMatch(/^import crypto from 'crypto';\r?$/m);
  });

  test('[ASVS v5.0.0-13.3.2] [Q-T65] 함수는저장소를읽기만하고_서명키를어디에도싣지않는다', () => {
    expect(SRC).not.toMatch(/kvs\.(put|delete|update)\s*\(/);
    expect(SRC).not.toMatch(/console\.log/);
  });

  test('[Q-T65] 함수원문은_10KB이하이고_런타임이받지않는문법을쓰지않는다', () => {
    expect(statSync(FILE).size).toBeLessThanOrEqual(10_240);
    // 런타임 2.0이 받지 않는 것: 선택 연결·널 병합·클래스·동적 평가·타이머·await의 쓰임(async 함수 안에서만, handler 하나만 async)
    expect(SRC).not.toMatch(/\?\.|\?\?|\bclass\b|\beval\b|new Function|setTimeout/);
    expect(SRC.match(/\basync\b/g)).toHaveLength(1);
    expect(SRC).toMatch(/^import cf from 'cloudfront';\r?$/m);
  });
});
