// 구간 1 끝 정리(docs/lanes/lane2.md '구간 끝 정리 목록', BAS-210 지적) 재현 시험. 고치기 전에 실패하는 것을 확인했다.
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, parseRetryAfter, retryDelayMs, type Operation } from '../src/index';

describe('Retry-After 읽기', () => {
  it('FE-T4 "1.5" 같은 정수가 아닌 초는 날짜로 읽지 않고 버린다(하한 없음 → 전체 지터)', () => {
    expect(parseRetryAfter('1.5', Date.parse('2026-11-04T10:00:00Z'))).toBeUndefined();
    expect(parseRetryAfter('-3', 0)).toBeUndefined();
    expect(retryDelayMs({ retryAfterHeader: '1.5', attempt: 0, random: () => 1, nowMs: Date.parse('2026-11-04T10:00:00Z') })).toBe(500);
  });

  it('FE-T4 HTTP 날짜는 응답의 Date 머리(서버 시계)와 견준다(보정하지 않은 기기 시계와 견주지 않는다)', () => {
    const device = Date.parse('2026-11-04T10:05:00Z'); // 기기 시계가 5분 빠르다
    const server = 'Wed, 04 Nov 2026 10:00:00 GMT';
    expect(parseRetryAfter('Wed, 04 Nov 2026 10:00:05 GMT', device, server)).toBe(5000);
    expect(parseRetryAfter('Wed, 04 Nov 2026 10:00:05 GMT', device)).toBe(0);
  });

  it('FE-T4 503 Retry-After 날짜는 그 응답의 Date 머리로 기다림을 정한다', async () => {
    const r = new Response(null, { status: 503, headers: { 'retry-after': 'Wed, 04 Nov 2026 10:00:03 GMT', date: 'Wed, 04 Nov 2026 10:00:00 GMT' } });
    const e = await ApiError.from(r);
    expect(e.date).toBe('Wed, 04 Nov 2026 10:00:00 GMT');
  });
});

const baseUrls = { api: 'https://api.peaket.example', 'queue-files': 'https://queue-files.peaket.example' };

describe('응답 형식·캐시', () => {
  it('JSON이 아닌 이진 응답(좌석 스냅샷 application/octet-stream)은 ArrayBuffer로 돌려준다', async () => {
    const snap: Operation = { method: 'GET', path: '/v1/events/{eventId}/seatmap-snapshot', host: 'api', kind: 'read' };
    const bytes = new Uint8Array([1, 0, 255, 128]);
    const client = createApiClient({ baseUrls, fetch: async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }) });
    const got = await client.request<ArrayBuffer>(snap, { params: { eventId: 'e' } });
    expect(got).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(got)]).toEqual([1, 0, 255, 128]);
  });

  it('대기열 파일은 cache: no-store로 받는다(작업이 정한 캐시를 fetch에 넘긴다)', async () => {
    const file: Operation = { method: 'GET', path: '/q/{eventId}.json', host: 'queue-files', kind: 'queue-file', cache: 'no-store' };
    let init: RequestInit = {};
    const client = createApiClient({ baseUrls, fetch: async (_u, i) => ((init = i), new Response('{}', { headers: { 'content-type': 'application/json' } })) });
    await client.request(file, { params: { eventId: 'e' } });
    expect(init.cache).toBe('no-store');
  });
});

describe('클라이언트의 다시 시도(구간 1 끝 정리 리뷰 재현)', () => {
  it('FE-T4 503의 Retry-After 날짜는 그 응답의 Date 머리와 견주어 기다린다(기기 시계가 틀려도)', async () => {
    vi.useFakeTimers();
    try {
      const hold: Operation = { method: 'POST', path: '/v1/events/{eventId}/holds', host: 'api', kind: 'write', idempotent: true };
      const calls: number[] = [];
      const responses = [
        new Response(null, { status: 503, headers: { 'retry-after': 'Wed, 04 Nov 2026 10:00:03 GMT', date: 'Wed, 04 Nov 2026 10:00:00 GMT' } }),
        new Response('{}', { headers: { 'content-type': 'application/json' } }),
      ];
      // 기기 시계는 서버보다 1시간 늦다(그대로 견주면 3,603초를 기다린다)
      const client = createApiClient({ baseUrls, random: () => 0, now: () => Date.parse('2026-11-04T09:00:00Z'), fetch: async () => (calls.push(Date.now()), responses.shift()!) });
      const p = client.request(hold, { params: { eventId: 'e' }, body: {} });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
