// 파트너 회차 소속 확인 어댑터(BAT-420 GAT-110 P, transfer-refund §5 '요청 두 길'): core 내부 판매 설정을 읽는다.
// 404는 없음(같은 404로 닫힘), 2xx는 소속·시각, 그 밖과 시간 초과는 던짐(503 authz-unavailable로 닫힘). 시험 담당이 구현 전에 썼다.
import { randomUUID } from 'node:crypto';
import type { ExternalRequest } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { HttpCoreEventOwners } from '../src/adapters/http-core-event-owners.js';

interface Sent {
  method: string;
  path: string;
  params: ExternalRequest['params'];
  headers: ExternalRequest['headers'];
  timeoutCapMs: number | undefined;
}

const core = (answer: () => Response | Promise<Response>, sent: Sent[]) => ({
  request: async (r: ExternalRequest) => {
    sent.push({ method: r.method, path: r.path, params: r.params, headers: r.headers, timeoutCapMs: r.timeoutCapMs });
    return answer();
  },
});
const resolved = (s: Sent) => s.path.replace('{eventId}', String(s.params?.eventId ?? '{eventId}'));
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('core 판매 설정 소속 조회 [BAT-420 GAT-110 P]', () => {
  test('R-T36 ③ 소속 조회는 내부 판매 설정을 내부 토큰·5,000ms 한도로 읽고 소속·시작·끝 시각만 돌려준다', async () => {
    const sent: Sent[] = [];
    const eventId = randomUUID();
    const promoterId = randomUUID();
    const owners = new HttpCoreEventOwners(
      core(() => jsonResponse(200, { eventId, promoterId, productionId: randomUUID(), startsAtMs: 1_800_000_000_123, endsAtMs: 1_800_010_800_456, entryClosedAtMs: null, pg: 'TOSS' }), sent),
      'it-token',
    );
    expect(await owners.find(eventId)).toEqual({ promoterId, startsAtMs: 1_800_000_000_123, endsAtMs: 1_800_010_800_456 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('GET');
    expect(resolved(sent[0]!)).toBe(`/internal/v1/events/${eventId}/sale-config`);
    expect(sent[0]!.headers).toMatchObject({ 'x-peaket-internal-token': 'it-token' });
    expect(sent[0]!.timeoutCapMs).toBe(5_000);
  });

  test('R-T36 ③ 끝 시각이 없는 판매 설정은 끝 시각 칸 없이 돌려준다', async () => {
    const promoterId = randomUUID();
    const owners = new HttpCoreEventOwners(core(() => jsonResponse(200, { promoterId, startsAtMs: 1_800_000_000_000 }), []));
    const found = await owners.find(randomUUID());
    expect(found).toEqual({ promoterId, startsAtMs: 1_800_000_000_000 });
    expect(found).not.toHaveProperty('endsAtMs');
  });

  test('R-T36 ③ core 404는 없음이고 그 밖의 실패·시간 초과는 던진다', async () => {
    expect(await new HttpCoreEventOwners(core(() => jsonResponse(404, { type: 'https://peaket.example/problems/not-found' }), [])).find(randomUUID())).toBeUndefined();
    for (const status of [401, 500, 503]) {
      await expect(new HttpCoreEventOwners(core(() => jsonResponse(status, {}), [])).find(randomUUID())).rejects.toThrow();
    }
    await expect(
      new HttpCoreEventOwners(core(() => Promise.reject(new Error('timeout')), [])).find(randomUUID()),
    ).rejects.toThrow();
  });
});
