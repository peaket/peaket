// 레지스트리 조회(schemaRegistrySource)의 단위 시험(BAT-220 계획 §6 OPS-150 ⑩·ST-T16 ① 단위, ADR-0335 결정 3, docs/streaming.md §2.6 레지스트리 줄).
// 레지스트리 HTTP는 바깥 경계라 fetch 자리에 Confluent REST 응답 모양만 내는 가짜(test/schema-registry-fake.ts)를 끼운다. 같은 응답을 실제 HTTP(S)
// 서버로 내는 시험(연결 거부·자체 서명 인증서·실제 시간 한도)은 test-int/batch-worker.int.test.ts다.
// 단언 값은 정본에서 적는다: 404만 모르는 스키마, 그 밖은 다시 시도할 장애, 시간 한도 2초 [가정](streaming §2.6), 캐시 상한 1,000개 [가정]·
// 응답 상한 1MiB [가정]·운영·스테이징·데모 https만·3xx 따라가지 않음·Basic 인증(ADR-0335 결정 3). 시험의 캐시 상한은 기본값과 다르게 3으로 둔다.
import avsc from 'avsc';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MAX_SCHEMA_ID } from '../src/avro.js';
import { SchemaUnavailableError, UnknownSchemaError } from '../src/avro-reader.js';
import { PlatformConfigError } from '../src/config.js';
import { schemaRegistrySource, type SchemaRegistrySourceOptions } from '../src/schema-registry-source.js';
import { fakeRegistryFetch, registryState, type RegistryState } from './schema-registry-fake.js';

const SCHEMA = { type: 'record', name: 'Pulse', namespace: 'peaket.it', fields: [{ name: 'id', type: 'long' }] };
const OTHER = { type: 'record', name: 'Other', namespace: 'peaket.it', fields: [{ name: 'n', type: 'string' }] };
const URL_HTTPS = 'https://registry.peaket.example';
const USER = 'ops-rt-reader';
const PASSWORD = 'Pa55-w0rd!rt';
/** Basic 머리 값(RFC 7617: base64("ops-rt-reader:Pa55-w0rd!rt")) */
const BASIC = 'Basic b3BzLXJ0LXJlYWRlcjpQYTU1LXcwcmQhcnQ=';
/** 정본 시간 한도(streaming §2.6 '처음 보는 ID 조회의 시간 한도는 2초 [가정]') */
const LOOKUP_TIMEOUT_MS = 2_000;
/** 정본 응답 상한(ADR-0335 결정 3 '1MiB [가정]를 넘는 응답') */
const MAX_RESPONSE = 1024 * 1024;

const source = (state: RegistryState, o: Partial<SchemaRegistrySourceOptions> = {}, fetchOpts: Parameters<typeof fakeRegistryFetch>[1] = {}) =>
  schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: fakeRegistryFetch(state, fetchOpts), ...o });

/** 거부 이유를 받아 낸다(거부하지 않으면 실패) */
async function failure(p: Promise<unknown>): Promise<Error> {
  const r = await p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  expect(r.ok, '거부해야 한다').toBe(false);
  expect((r as { e: unknown }).e).toBeInstanceOf(Error);
  return (r as { e: Error }).e;
}
/** 오류와 원인 사슬의 글 전부 */
const errorText = (e: unknown): string => {
  const parts: string[] = [];
  for (let c: unknown = e, i = 0; c && i < 10; c = (c as { cause?: unknown }).cause, i += 1) parts.push(String(c), String((c as Error).stack ?? ''), JSON.stringify(c, Object.getOwnPropertyNames(c)));
  return parts.join('\n');
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OPS-150 ⑩ 주소(TLS)', () => {
  test('OPS-150 ⑩ 운영·스테이징·데모에서 http 주소는 시작하지 않는다(셋 각각), local·ci는 받는다', () => {
    for (const env of ['prod', 'staging', 'demo']) {
      expect(() => schemaRegistrySource({ url: 'http://registry.peaket.example', env, fetch: fakeRegistryFetch(registryState()) }), env).toThrow(PlatformConfigError);
      expect(() => schemaRegistrySource({ url: URL_HTTPS, env, fetch: fakeRegistryFetch(registryState()) }), env).not.toThrow();
    }
    for (const env of ['local', 'ci']) expect(() => schemaRegistrySource({ url: 'http://127.0.0.1:8081', env, fetch: fakeRegistryFetch(registryState()) }), env).not.toThrow();
    // 모르는 환경 값·빈 값은 운영처럼 본다
    for (const env of ['', 'production', 'qa']) expect(() => schemaRegistrySource({ url: 'http://registry.peaket.example', env }), env || '(빈 값)').toThrow(PlatformConfigError);
    // http·https 밖의 주소, 주소가 아닌 글
    expect(() => schemaRegistrySource({ url: 'ftp://registry.peaket.example', env: 'ci' })).toThrow(PlatformConfigError);
    expect(() => schemaRegistrySource({ url: 'registry:8081', env: 'ci' })).toThrow(PlatformConfigError);
  });

  test('OPS-150 ⑩ 주소에 사용자 정보·쿼리·조각을 넣으면 시작하지 않고, 오류 글에 그 값을 싣지 않는다', () => {
    for (const url of [`https://${USER}:${PASSWORD}@registry.peaket.example`, 'https://registry.peaket.example/?token=abc', 'https://registry.peaket.example/#x']) {
      let err: unknown;
      try {
        schemaRegistrySource({ url, env: 'prod' });
      } catch (e) {
        err = e;
      }
      expect(err, url).toBeInstanceOf(PlatformConfigError);
      expect(errorText(err)).not.toContain(PASSWORD);
      expect(errorText(err)).not.toContain('token=abc');
    }
  });

  test('OPS-150 ⑩ 다른 주소로 보내는 응답(3xx)은 따라가지 않고 다시 시도할 장애다. fetch에 redirect: manual을 준다', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const state = registryState({ 7: SCHEMA });
      const inits: (RequestInit | undefined)[] = [];
      const inner = fakeRegistryFetch(state, { reply: () => new Response(null, { status, headers: { location: 'https://evil.example/schemas/ids/7' } }) });
      const s = schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: (i, init) => (inits.push(init), inner(i, init)) });
      const e = await failure(s.byId(7));
      expect(e, String(status)).toBeInstanceOf(SchemaUnavailableError);
      expect(state.requests).toEqual(['/schemas/ids/7']);
      expect(inits[0]?.redirect).toBe('manual');
    }
  });
});

describe('OPS-150 ⑩ 인증', () => {
  test('OPS-150 ⑩ 요청마다 Basic 머리가 정확한 값이고, 자격을 주지 않으면 머리가 없다', async () => {
    const state = registryState({ 7: SCHEMA, 8: OTHER });
    const s = source(state, { auth: { user: USER, password: PASSWORD } });
    await s.byId(7);
    await s.byId(8);
    expect(state.authorization).toEqual([BASIC, BASIC]);
    const plain = registryState({ 7: SCHEMA });
    await source(plain).byId(7);
    expect(plain.authorization).toEqual([null]);
  });

  test('OPS-150 ⑩ 자격 모양이 틀리면 시작하지 않는다(사용자 이름의 :, 빈 값). 오류 글에 비밀번호가 없다', () => {
    for (const auth of [{ user: 'a:b', password: PASSWORD }, { user: '', password: PASSWORD }, { user: USER, password: '' }]) {
      let err: unknown;
      try {
        schemaRegistrySource({ url: URL_HTTPS, env: 'prod', auth });
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(auth.user)).toBeInstanceOf(PlatformConfigError);
      expect(errorText(err)).not.toContain(PASSWORD);
    }
  });

  test('OPS-150 ⑩ 어느 실패에서도 오류 글·원인 사슬에 비밀번호와 Basic 값이 없다', async () => {
    const leaky: typeof fetch = async (_i, init) => {
      // 머리를 오류 글에 싣는 하위 라이브러리를 흉내 낸다
      throw new TypeError(`fetch failed: ${new Headers(init?.headers).get('authorization')}`, { cause: Object.assign(new Error(`connect ECONNRESET ${BASIC}`), { code: 'ECONNRESET' }) });
    };
    const cases: { name: string; fetch: typeof fetch }[] = [
      { name: '404', fetch: fakeRegistryFetch(registryState()) },
      { name: '401', fetch: fakeRegistryFetch({ ...registryState(), status: 401 }) },
      { name: '503', fetch: fakeRegistryFetch({ ...registryState(), status: 503 }) },
      { name: '연결 거부', fetch: fakeRegistryFetch(registryState(), { down: () => true }) },
      { name: '머리를 싣는 연결 오류', fetch: leaky },
      { name: 'JSON 아님', fetch: async () => new Response('<html>', { status: 200 }) },
    ];
    for (const c of cases) {
      const s = schemaRegistrySource({ url: URL_HTTPS, env: 'prod', auth: { user: USER, password: PASSWORD }, fetch: c.fetch });
      const e = await failure(s.byId(7));
      const text = errorText(e);
      expect(text, c.name).not.toContain(PASSWORD);
      expect(text, c.name).not.toContain(BASIC.slice('Basic '.length));
      expect(text, c.name).not.toContain('registry.peaket.example');
    }
  });
});

describe('ST-T16 ① 실패 분류와 캐시하지 않음', () => {
  test('ST-T16 ① 404만 모르는 스키마(UnknownSchemaError)이고, 500·502·503·401·403·400·409·429는 각각 다시 시도할 장애다', async () => {
    const e404 = await failure(source(registryState()).byId(7));
    expect(e404).toBeInstanceOf(UnknownSchemaError);
    expect(e404).not.toBeInstanceOf(SchemaUnavailableError);
    for (const status of [500, 502, 503, 401, 403, 400, 409, 429]) {
      const e = await failure(source({ ...registryState({ 7: SCHEMA }), status }).byId(7));
      expect(e, String(status)).toBeInstanceOf(SchemaUnavailableError);
      expect(e.message, String(status)).toContain(String(status));
    }
  });

  test('ST-T16 ① 연결 거부(ECONNREFUSED)는 다시 시도할 장애이고 원인 종류만 남긴다', async () => {
    const e = await failure(source(registryState({ 7: SCHEMA }), {}, { down: () => true }).byId(7));
    expect(e).toBeInstanceOf(SchemaUnavailableError);
    expect(e.message).toContain('ECONNREFUSED');
    expect(e.message).not.toContain('127.0.0.1:8081');
  });

  test('ST-T16 ① 실패한 조회는 캐시하지 않는다: 503·연결 거부·404 뒤 다음 조회는 다시 원천에 가서 받는다', async () => {
    const state = registryState({ 7: SCHEMA });
    let down = true;
    const s = schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: fakeRegistryFetch(state, { down: () => down }) });
    expect(await failure(s.byId(7))).toBeInstanceOf(SchemaUnavailableError);
    down = false;
    state.status = 503;
    expect(await failure(s.byId(7))).toBeInstanceOf(SchemaUnavailableError);
    state.status = undefined;
    await expect(s.byId(7)).resolves.toEqual(SCHEMA);
    // 연결 거부는 원천에 닿지 않아 요청 기록이 없다: 503 하나와 성공 하나
    expect(state.requests).toEqual(['/schemas/ids/7', '/schemas/ids/7']);

    // 404도 캐시하지 않는다(나중에 등록된 ID를 읽는다)
    const late = registryState();
    const s2 = source(late);
    expect(await failure(s2.byId(9))).toBeInstanceOf(UnknownSchemaError);
    late.schemas.set(9, OTHER);
    await expect(s2.byId(9)).resolves.toEqual(OTHER);
    expect(late.requests).toEqual(['/schemas/ids/9', '/schemas/ids/9']);
  });

  test('ST-T16 ① 성공한 ID는 원천이 닫혀도 캐시에서 읽힌다', async () => {
    const state = registryState({ 7: SCHEMA });
    let down = false;
    const s = schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: fakeRegistryFetch(state, { down: () => down }) });
    await expect(s.byId(7)).resolves.toEqual(SCHEMA);
    down = true;
    await expect(s.byId(7)).resolves.toEqual(SCHEMA);
    expect(await failure(s.byId(8))).toBeInstanceOf(SchemaUnavailableError);
    expect(state.requests).toEqual(['/schemas/ids/7']);
  });

  test('ST-T16 ① 조회 한도: 정본 2초 직전(1,999ms)에 온 답은 받고, 2초에 닿으면 시간 초과로 다시 시도할 장애다(가짜 시계)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // 시간 한도 신호(AbortSignal.timeout)를 가짜 시계의 setTimeout으로 만든다. 끊는 이유는 실제와 같은 TimeoutError다(시간 경계, 허용 목록 '시간·대기')
    const limits: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      limits.push(ms);
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
      return c.signal;
    });
    const fast = schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: fakeRegistryFetch(registryState({ 7: SCHEMA }), { delayMs: LOOKUP_TIMEOUT_MS - 1 }) });
    const ok = fast.byId(7);
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS - 1);
    await expect(ok).resolves.toEqual(SCHEMA);

    const state = registryState({ 7: SCHEMA });
    const slow = schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: fakeRegistryFetch(state, { delayMs: 60_000 }) });
    const out: { v: 'pending' | 'resolved' | Error } = { v: 'pending' };
    const p = slow.byId(7).then(
      () => void (out.v = 'resolved'),
      (e: Error) => void (out.v = e),
    );
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS - 1);
    expect(out.v).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(out.v).toBeInstanceOf(SchemaUnavailableError);
    expect(String(out.v)).toContain('TimeoutError');
    expect(limits).toEqual([LOOKUP_TIMEOUT_MS, LOOKUP_TIMEOUT_MS]);
    expect(state.requests).toEqual([]);

    // 한도를 옵션으로 줄 수 있다(기본값과 다른 값)
    limits.length = 0;
    const custom = schemaRegistrySource({ url: URL_HTTPS, env: 'prod', timeoutMs: 750, fetch: fakeRegistryFetch(registryState({ 7: SCHEMA })) });
    await custom.byId(7);
    expect(limits).toEqual([750]);
  });
});

describe('OPS-150 ⑩ 캐시', () => {
  test('OPS-150 ⑩ 같은 ID 두 번째 조회는 요청 0, 같은 ID 동시 조회는 요청 1', async () => {
    const state = registryState({ 7: SCHEMA });
    const s = source(state);
    await expect(s.byId(7)).resolves.toEqual(SCHEMA);
    await expect(s.byId(7)).resolves.toEqual(SCHEMA);
    expect(state.requests).toEqual(['/schemas/ids/7']);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const together = registryState({ 8: OTHER });
    const s2 = source(together, {}, { delayMs: 100 });
    const all = Promise.all([s2.byId(8), s2.byId(8), s2.byId(8)]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await all).toEqual([OTHER, OTHER, OTHER]);
    expect(together.requests).toEqual(['/schemas/ids/8']);
  });

  test('OPS-150 ⑩ 같은 ID 동시 조회가 실패하면 함께 실패하고, 그 뒤 조회는 새 요청을 낸다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const state: RegistryState = { ...registryState({ 8: OTHER }), status: 503 };
    const s = source(state, {}, { delayMs: 100 });
    const both = Promise.allSettled([s.byId(8), s.byId(8)]);
    await vi.advanceTimersByTimeAsync(100);
    const r = await both;
    expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected']);
    expect(state.requests).toEqual(['/schemas/ids/8']);
    state.status = undefined;
    const again = s.byId(8);
    await vi.advanceTimersByTimeAsync(100);
    await expect(again).resolves.toEqual(OTHER);
    expect(state.requests).toEqual(['/schemas/ids/8', '/schemas/ids/8']);
  });

  test('OPS-150 ⑩ 상한 + 1번째 ID에서 가장 오래 쓰지 않은 것이 빠진다(시험 상한 3)', async () => {
    const schemas = Object.fromEntries([1, 2, 3, 4].map((id) => [id, { ...SCHEMA, name: `P${id}` }]));
    const state = registryState(schemas);
    const s = source(state, { cacheSize: 3 });
    for (const id of [1, 2, 3]) await s.byId(id);
    await s.byId(1); // 1을 다시 써서 2가 가장 오래 쓰지 않은 것이 된다
    expect(state.requests).toHaveLength(3);
    await s.byId(4); // 상한 + 1번째: 2가 빠진다
    for (const id of [1, 3, 4]) await expect(s.byId(id)).resolves.toEqual(schemas[id]);
    expect(state.requests).toEqual(['/schemas/ids/1', '/schemas/ids/2', '/schemas/ids/3', '/schemas/ids/4']);
    await s.byId(2);
    expect(state.requests).toEqual(['/schemas/ids/1', '/schemas/ids/2', '/schemas/ids/3', '/schemas/ids/4', '/schemas/ids/2']);
  });
});

describe('OPS-150 ⑩ ID와 경로', () => {
  test('OPS-150 ⑩ ID 범위 밖(0·MAX_SCHEMA_ID + 1·소수)은 요청하지 않고, 경계 1·MAX_SCHEMA_ID는 그 ID 경로로 조회한다', async () => {
    const state = registryState({ 1: SCHEMA, [MAX_SCHEMA_ID]: OTHER });
    const s = source(state);
    for (const bad of [0, MAX_SCHEMA_ID + 1, 1.5, -1]) await expect(s.byId(bad), String(bad)).rejects.toThrow(RangeError);
    expect(state.requests).toEqual([]);
    await expect(s.byId(1)).resolves.toEqual(SCHEMA);
    await expect(s.byId(MAX_SCHEMA_ID)).resolves.toEqual(OTHER);
    expect(state.requests).toEqual(['/schemas/ids/1', '/schemas/ids/2147483647']);
  });

  test('OPS-150 ⑩ ID 7과 8은 각자의 경로로 각자의 스키마를 받는다. 주소의 경로 앞부분을 지킨다', async () => {
    const state = registryState({ 7: SCHEMA, 8: OTHER });
    const s = schemaRegistrySource({ url: `${URL_HTTPS}/sr/`, env: 'prod', fetch: fakeRegistryFetch(state) });
    await expect(s.byId(8)).resolves.toEqual(OTHER);
    await expect(s.byId(7)).resolves.toEqual(SCHEMA);
    expect(state.requests).toEqual(['/sr/schemas/ids/8', '/sr/schemas/ids/7']);
  });
});

describe('OPS-150 ⑩ 응답 모양과 크기', () => {
  const reply = (body: string, headers: Record<string, string> = {}) => fakeRegistryFetch(registryState({ 7: SCHEMA }), { reply: () => new Response(body, { status: 200, headers }) });

  test('OPS-150 ⑩ Avro 스키마로 읽히지 않는 응답은 다시 시도할 장애다(JSON 아님·schema 글 없음·Avro 아님·다른 종류·참조 있음)', async () => {
    const bodies = {
      'JSON 아님': 'not json',
      'schema 글 없음': JSON.stringify({ id: 7 }),
      'schema가 숫자': JSON.stringify({ schema: 7 }),
      'schema가 JSON 아님': JSON.stringify({ schema: '{nope' }),
      'Avro가 아님': JSON.stringify({ schema: JSON.stringify({ type: 'nope' }) }),
      'PROTOBUF': JSON.stringify({ schema: JSON.stringify(SCHEMA), schemaType: 'PROTOBUF' }),
      '참조 있음': JSON.stringify({ schema: JSON.stringify(SCHEMA), references: [{ name: 'peaket.it.Other', subject: 'other', version: 1 }] }),
    };
    for (const [name, body] of Object.entries(bodies)) {
      const e = await failure(schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: reply(body) }).byId(7));
      expect(e, name).toBeInstanceOf(SchemaUnavailableError);
    }
    // schemaType AVRO와 빈 참조는 받는다
    const okBody = JSON.stringify({ schema: JSON.stringify(SCHEMA), schemaType: 'AVRO', references: [] });
    await expect(schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: reply(okBody) }).byId(7)).resolves.toEqual(SCHEMA);
  });

  test('OPS-150 ⑩ 응답 상한 1MiB: 꼭 1MiB는 받고 1MiB + 1바이트는 다시 시도할 장애다(길이 머리 있음·없음 둘 다)', async () => {
    const sized = (n: number) => {
      const base = JSON.stringify({ schema: JSON.stringify(SCHEMA), pad: '' });
      const body = base.replace('"pad":""', `"pad":"${'x'.repeat(n - base.length)}"`);
      expect(Buffer.byteLength(body)).toBe(n);
      return body;
    };
    const exact = sized(MAX_RESPONSE);
    const over = sized(MAX_RESPONSE + 1);
    // 길이 머리 없이 흘려 보내는 응답(조각 64KiB)
    const streamed = (body: string): typeof fetch => async () => {
      const bytes = Buffer.from(body);
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += 65_536) chunks.push(bytes.subarray(i, i + 65_536));
      return new Response(new ReadableStream({ pull: (c) => (chunks.length ? c.enqueue(chunks.shift()!) : c.close()) }), { status: 200 });
    };
    await expect(schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: streamed(exact) }).byId(7)).resolves.toEqual(SCHEMA);
    expect(await failure(schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: streamed(over) }).byId(7))).toBeInstanceOf(SchemaUnavailableError);
    await expect(schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: reply(exact, { 'content-length': String(MAX_RESPONSE) }) }).byId(7)).resolves.toEqual(SCHEMA);
    expect(await failure(schemaRegistrySource({ url: URL_HTTPS, env: 'prod', fetch: reply(over, { 'content-length': String(MAX_RESPONSE + 1) }) }).byId(7))).toBeInstanceOf(SchemaUnavailableError);
  });

  test('OPS-150 ⑩ 받은 스키마는 avsc로 읽히는 .avsc JSON 그대로다', async () => {
    const got = await source(registryState({ 7: SCHEMA })).byId(7);
    expect(got).toEqual(SCHEMA);
    expect(avsc.Type.forSchema(got as avsc.Schema).name).toBe('peaket.it.Pulse');
  });
});
