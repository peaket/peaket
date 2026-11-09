// 받는 층: 구간별 대기 상태 파일 경로(openapi GET /v1/queues/{eventId}/segment-states/{segment}.json, ADR-0110, [ASVS v5.0.0-3.4.2]·[ASVS v5.0.0-14.3.2])
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { QueueState } from '@peaket/contracts/openapi/model';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryEventSchedules } from '../src/modules/entry/adapters/memory-entry-store.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { MemoryStateSnapshots } from '../src/modules/state/index.js';
import { newEvent, openSchedule, recordingRisk, tokens } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const schedules = new MemoryEventSchedules();
const snapshots = new MemoryStateSnapshots();
const NOW = Date.parse('2026-11-03T03:00:00.400Z');

beforeAll(async () => {
  svc = await createService({
    name: 'queue-svc',
    module: AppModule.register({ memory: true, schedules, snapshots, tokens, risk: recordingRisk(), state: { autoTick: false } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

async function event(seq: number, serving: number) {
  const id = newEvent();
  await schedules.set(id, openSchedule(NOW));
  snapshots.set(id, { seq, serving });
  return id;
}
const get = (eventId: string, file: string) => svc.http.inject({ method: 'GET', url: `/v1/queues/${eventId}/segment-states/${file}` });

describe('대기 상태 파일 경로', () => {
  test('입장임박구간은_Expires(생성시각+1초)와Cache-Control:public만주고_max-age·stale-while-revalidate는없다', async () => {
    const id = await event(5_000, 1);
    const r = await get(id, '0.json');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public');
    expect(r.headers.expires).toBe(new Date(Date.parse('2026-11-03T03:00:01Z')).toUTCString());
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(QueueState.parse(JSON.parse(r.payload))).toMatchObject({ serving: 1, generatedAtMs: Date.parse('2026-11-03T03:00:00Z') });
  });

  test('그밖구간은_max-age=1과stale-while-revalidate=2이고_Expires가없다', async () => {
    const id = await event(5_000, 1);
    const r = await get(id, '3.json');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=1, stale-while-revalidate=2');
    // seq가 든 구간(4)보다 뒤라도 방금 생겼을 수 있는 구간은 404가 아니다
    expect((await get(id, '7.json')).statusCode).toBe(200);
    expect(r.headers.expires).toBeUndefined();
  });

  test('[ASVS v5.0.0-3.4.2] 교차출처허용은_소비자웹하나로고정하고_자격증명허용·Vary는두지않으며_Retry-After만노출한다', async () => {
    const id = await event(10, 0);
    for (const r of [await get(id, '0.json'), await get(id, '9.json')]) {
      expect(r.headers['access-control-allow-origin']).toBe('https://www.peaket.example');
      expect(r.headers['access-control-expose-headers']).toBe('Retry-After');
      expect(r.headers['access-control-allow-credentials']).toBeUndefined();
      expect(r.headers.vary).toBeUndefined();
    }
  });

  test('[ASVS v5.0.0-14.3.2] 공개캐시파일이라_쿠키를쓰지않고_회차값만싣는다(사람·토큰값없음)', async () => {
    const id = await event(10, 0);
    const r = await get(id, '0.json');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(Object.keys(JSON.parse(r.payload)).every((k) => k in QueueState.shape)).toBe(true);
  });

  test('PRF192_없는회차·마지막구간뒤·틀린파일이름은_404queue-not-found이고_제목은오류목록과같으며_엣지가1초만들고있게한다', async () => {
    const id = await event(1_500, 0);
    for (const r of [await get(newEvent(), '0.json'), await get(id, '102.json'), await get(id, 'x.json'), await get('bad.id', '0.json')]) {
      expect(r.statusCode).toBe(404);
      expect(JSON.parse(r.payload)).toMatchObject({ status: 404, title: '이 회차의 대기열이 열리지 않았습니다', detail: '이 회차·구간의 대기 상태가 없습니다' });
      expect(JSON.parse(r.payload).type).toMatch(/queue-not-found$/);
      expect(r.headers['cache-control']).toBe('public, max-age=1');
      expect(r.headers['access-control-allow-origin']).toBe('https://www.peaket.example');
    }
  });

  test('PRF192_켤때대기열Redis가잠시안되면_503과Retry-After1초이고_제목은오류목록과같다', async () => {
    const id = await event(10, 0);
    snapshots.failNext = new QueueStoreUnavailable(new Error('down'));
    const r = await get(id, '0.json');
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload).title).toBe('의존 서비스를 잠시 쓸 수 없습니다');
    expect(r.headers['retry-after']).toBe('1');
    // 오류 응답을 CDN이 기본 시간(10초) 동안 들고 있지 않게 한다
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
