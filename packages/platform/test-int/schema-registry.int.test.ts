// 레지스트리 조회(schemaRegistrySource)를 실제 HTTP(S) 서버와 실제 fetch로 본다(BAT-220 계획 §6 OPS-150 ⑩·ST-T16 ①, ADR-0335 결정 3, docs/streaming.md §2.6).
// 단위 시험(test/schema-registry-source.test.ts)이 가짜 fetch로 본 분류가 실제 연결 거부·자체 서명 인증서·실제 시간 한도에서도 같은지 본다.
// 정본 값: 시간 한도 2초 [가정](streaming §2.6), 인증서 검증을 끄는 선택 없음·운영은 https만(ADR-0335 결정 3).
import { afterEach, expect, test } from 'vitest';
import { SchemaUnavailableError, UnknownSchemaError } from '../src/avro-reader.js';
import { schemaRegistrySource } from '../src/schema-registry-source.js';
import { registryState } from '../test/schema-registry-fake.js';
import { startRegistryServer, type RegistryServer } from './registry-server.js';

const SCHEMA = { type: 'record', name: 'Pulse', namespace: 'peaket.it', fields: [{ name: 'id', type: 'long' }] };
const LOOKUP_TIMEOUT_MS = 2_000;
const servers: RegistryServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

test('OPS-150 ⑩ 실제 http 서버(ci): 200은 스키마, 404만 UnknownSchemaError, 503은 SchemaUnavailableError, Basic 머리가 실린다', async () => {
  const state = registryState({ 7: SCHEMA });
  const srv = await startRegistryServer(state);
  servers.push(srv);
  const s = schemaRegistrySource({ url: srv.url, env: 'ci', auth: { user: 'it-user', password: 'it-Pa55' } });
  await expect(s.byId(7)).resolves.toEqual(SCHEMA);
  await expect(s.byId(8)).rejects.toBeInstanceOf(UnknownSchemaError);
  state.status = 503;
  await expect(s.byId(9)).rejects.toBeInstanceOf(SchemaUnavailableError);
  expect(state.requests).toEqual(['/schemas/ids/7', '/schemas/ids/8', '/schemas/ids/9']);
  expect(state.authorization).toEqual(Array(3).fill(`Basic ${Buffer.from('it-user:it-Pa55').toString('base64')}`));
});

test('ST-T16 ① 실제 연결 거부(닫힌 레지스트리)는 SchemaUnavailableError(ECONNREFUSED)이고, 되살리면 같은 ID를 다시 받는다', async () => {
  const state = registryState({ 7: SCHEMA });
  const srv = await startRegistryServer(state);
  servers.push(srv);
  await srv.close();
  const s = schemaRegistrySource({ url: srv.url, env: 'ci' });
  const e = await s.byId(7).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SchemaUnavailableError);
  expect(String(e)).toContain('ECONNREFUSED');
  await srv.reopen();
  await expect(s.byId(7)).resolves.toEqual(SCHEMA);
  expect(state.requests).toEqual(['/schemas/ids/7']);
});

test('OPS-150 ⑩ 자체 서명 인증서 서버는 받아들이지 않고 다시 시도할 장애다(운영 https, 서버에 요청이 닿지 않는다)', async () => {
  const state = registryState({ 7: SCHEMA });
  const srv = await startRegistryServer(state, { tls: true });
  servers.push(srv);
  const s = schemaRegistrySource({ url: srv.url, env: 'prod', auth: { user: 'it-user', password: 'it-Pa55' } });
  const e = await s.byId(7).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(SchemaUnavailableError);
  expect(String(e)).not.toContain('it-Pa55');
  expect(state.requests).toEqual([]);
});

test('ST-T16 ① 실제 시간 한도: 정본 2초보다 늦게 답하는 레지스트리는 2초 무렵 시간 초과로 끝나고, 일찍 답하면 받는다', async () => {
  const slowState = registryState({ 7: SCHEMA });
  const slow = await startRegistryServer(slowState, { delayMs: LOOKUP_TIMEOUT_MS + 3_000 });
  servers.push(slow);
  const started = performance.now();
  const e = await schemaRegistrySource({ url: slow.url, env: 'ci' })
    .byId(7)
    .catch((x: unknown) => x);
  const took = performance.now() - started;
  expect(e).toBeInstanceOf(SchemaUnavailableError);
  expect(String(e)).toContain('TimeoutError');
  // 아래쪽은 한도보다 일찍 끊지 않았는지, 위쪽은 서버의 답(5초)을 기다리지 않았는지만 넉넉히 본다(정확한 경계는 단위 시험이 가짜 시계로 본다)
  expect(took).toBeGreaterThanOrEqual(LOOKUP_TIMEOUT_MS - 50);
  expect(took).toBeLessThan(LOOKUP_TIMEOUT_MS + 2_500);

  const fast = await startRegistryServer(registryState({ 7: SCHEMA }), { delayMs: 500 });
  servers.push(fast);
  await expect(schemaRegistrySource({ url: fast.url, env: 'ci' }).byId(7)).resolves.toEqual(SCHEMA);
}, 20_000);
