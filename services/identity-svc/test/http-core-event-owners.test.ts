// core-svc 내부 판매 설정 읽기 어댑터 시험(BUILD_ORDER BAT-450B, ADR-0353, identity §6.1).
// identity-svc는 core DB를 읽지 않고 읽기 전용 내부 HTTP GET /internal/v1/events/{eventId}/sale-config를 부른다.
// 404는 '없음', 401·5xx·시간 초과·모양 틀림은 던짐(부르는 쪽이 503으로 닫는다)을 값으로 본다.
import type { ExternalHttpClient, ExternalRequest } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { HttpCoreEventOwners } from '../src/modules/session/adapters/http-core-event-owners.js';

const EVENT = '0190f3a1-7c2e-7a00-8000-00000000b501';
const TENANT = '0190f3a1-7c2e-7a00-8000-00000000b502';

class Client {
  readonly calls: ExternalRequest[] = [];
  answer: (() => Promise<Response>) | Response = new Response('{}', { status: 200 });
  async request(r: ExternalRequest): Promise<Response> {
    this.calls.push(r);
    return typeof this.answer === 'function' ? this.answer() : this.answer;
  }
}

const ownersOf = (body: unknown, status = 200) => {
  const client = new Client();
  client.answer = new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return { client, owners: new HttpCoreEventOwners(client as Pick<ExternalHttpClient, 'request'>, 'it-token') };
};

describe('HttpCoreEventOwners [BAT-450B, ADR-0353]', () => {
  test('I-T86 ② 내부 토큰을 싣고 sale-config의 promoterId·startsAtMs·endsAtMs·entryOpensAtMs를 읽는다', async () => {
    const { client, owners } = ownersOf({ promoterId: TENANT, startsAtMs: 1_000, endsAtMs: 2_000, entryOpensAtMs: 1_500 });
    await expect(owners.find(EVENT)).resolves.toEqual({ promoterId: TENANT, startsAtMs: 1_000, endsAtMs: 2_000, entryOpensAtMs: 1_500 });
    expect(client.calls[0]).toMatchObject({
      method: 'GET',
      path: '/internal/v1/events/{eventId}/sale-config',
      params: { eventId: EVENT },
      headers: { 'x-peaket-internal-token': 'it-token' },
      timeoutCapMs: 5_000,
    });
  });

  test('I-T86 ② entryOpensAtMs가 없거나 null이면 비우고, 404는 없음(undefined)이다', async () => {
    const noEntry = ownersOf({ promoterId: TENANT, startsAtMs: 1_000, endsAtMs: 2_000 });
    await expect(noEntry.owners.find(EVENT)).resolves.toEqual({ promoterId: TENANT, startsAtMs: 1_000, endsAtMs: 2_000 });
    const nullEntry = ownersOf({ promoterId: TENANT, startsAtMs: 1_000, endsAtMs: 2_000, entryOpensAtMs: null });
    await expect(nullEntry.owners.find(EVENT)).resolves.toEqual({ promoterId: TENANT, startsAtMs: 1_000, endsAtMs: 2_000 });

    const missing = ownersOf({ type: 'not-found', status: 404 }, 404);
    await expect(missing.owners.find(EVENT)).resolves.toBeUndefined();
  });

  test('I-T86 ② 401·5xx·시간 초과·모양 틀림은 던진다(부르는 쪽이 503으로 닫는다)', async () => {
    for (const status of [401, 403, 500, 503]) {
      const { owners } = ownersOf({ type: 'x', status }, status);
      await expect(owners.find(EVENT)).rejects.toThrow();
    }
    const timeout = new Client();
    timeout.answer = async () => {
      throw new Error('deadline exceeded');
    };
    await expect(new HttpCoreEventOwners(timeout as Pick<ExternalHttpClient, 'request'>).find(EVENT)).rejects.toThrow(/deadline/);
    for (const body of [
      {},
      { promoterId: '', startsAtMs: 1_000, endsAtMs: 2_000 },
      { promoterId: TENANT, startsAtMs: '1000', endsAtMs: 2_000 },
      { promoterId: TENANT, startsAtMs: 1_000 },
      { promoterId: TENANT, startsAtMs: 1_000, endsAtMs: Number.NaN },
      { promoterId: TENANT, startsAtMs: 1_000, endsAtMs: 2_000, entryOpensAtMs: 'now' },
      [],
      null,
    ]) {
      const { owners } = ownersOf(body);
      await expect(owners.find(EVENT)).rejects.toThrow();
    }
  });

  test('I-T86 ② 내부 토큰이 없으면 머리를 싣지 않는다(local·ci)', async () => {
    const client = new Client();
    client.answer = new Response(JSON.stringify({ promoterId: TENANT, startsAtMs: 1_000, endsAtMs: 2_000 }), { status: 200 });
    await new HttpCoreEventOwners(client as Pick<ExternalHttpClient, 'request'>).find(EVENT);
    expect(client.calls[0]!.headers).toEqual({});
  });

  test('I-T86 ② eventId가 비었거나 UUID가 아니면 core를 부르지 않고 없음이다', async () => {
    const { client, owners } = ownersOf({ promoterId: TENANT, startsAtMs: 1_000, endsAtMs: 2_000 });
    await expect(owners.find('')).resolves.toBeUndefined();
    await expect(owners.find('not-a-uuid')).resolves.toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });
});
