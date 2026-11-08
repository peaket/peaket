// 결과 파일을 객체 저장소 포트에 쓰는 어댑터(BUILD_ORDER HOT-050, ADR-0232 결정 1·12, ADR-0058 결정 5): 키는 요청 경로와 같고, 머리는 파일 캐시 규칙을 따른다
import { describe, expect, test } from 'vitest';
import { MemoryResultObjects } from '../src/modules/batch/adapters/memory-batch-store.js';
import { MAX_CONCURRENT_PUTS, ObjectStoreResultFiles, RESULT_CACHE_CONTROL } from '../src/modules/batch/adapters/object-store-result-files.js';

const file = (n: number): Record<string, number> => ({ ['a'.repeat(64)]: n });
const three = (i: number) => i.toString(16).padStart(3, '0');

describe('객체 저장소 결과 파일', () => {
  test('[ASVS v5.0.0-3.2.1] FR-038 로비·묶음 파일을 요청 경로와 같은 키에 JSON 머리와 공개 캐시로 쓴다', async () => {
    const objects = new MemoryResultObjects();
    const files = new ObjectStoreResultFiles(objects);
    await files.write('e1', 'lobby', new Map([['abc', file(7)]]));
    await files.write('e1', 1, new Map([['abc', file(9)]]));
    const lobby = objects.get('queue/fallback/v1/queues/e1/shuffle-results/abc.json');
    expect(lobby).toMatchObject({ contentType: 'application/json; charset=utf-8', cacheControl: RESULT_CACHE_CONTROL });
    expect(JSON.parse(lobby!.body)).toEqual(file(7));
    expect(JSON.parse(objects.get('queue/fallback/v1/queues/e1/batch-results/abc.json')!.body)).toEqual(file(9));
    expect(RESULT_CACHE_CONTROL).toBe('public, max-age=60');
  });

  test('FR-038 동시 쓰기는 상한을 넘지 않고 파일을 모두 쓴다', async () => {
    const objects = new MemoryResultObjects({ delayMs: 1 });
    const files = new ObjectStoreResultFiles(objects);
    const many = new Map(Array.from({ length: 300 }, (_, i) => [three(i), file(i + 1)] as const));
    await files.write('e1', 'lobby', many);
    expect(objects.size()).toBe(300);
    expect(objects.maxInFlight()).toBeLessThanOrEqual(MAX_CONCURRENT_PUTS);
    expect(MAX_CONCURRENT_PUTS).toBe(64);
  });

  test('[ASVS v5.0.0-16.5.2] 파일 하나를 쓰지 못하면 던져 게시 표시를 쓰지 않게 한다', async () => {
    const objects = new MemoryResultObjects({ failKey: 'queue/fallback/v1/queues/e1/shuffle-results/abc.json' });
    await expect(new ObjectStoreResultFiles(objects).write('e1', 'lobby', new Map([['abc', file(1)]]))).rejects.toThrow();
  });

  test('[ASVS v5.0.0-16.5.2] PUT 하나가 실패하면 새 PUT을 시작하지 않고, 진행 중인 PUT이 끝난 뒤 던져 재시도와 겹치지 않는다', async () => {
    const started: string[] = [];
    let inFlight = 0;
    const files = new ObjectStoreResultFiles({
      put: async (i) => {
        started.push(i.key);
        inFlight += 1;
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        if (i.key.endsWith('/000.json')) throw new Error('S3 503');
      },
    });
    const many = new Map(Array.from({ length: 300 }, (_, i) => [three(i), file(i + 1)] as const));
    await expect(files.write('e1', 'lobby', many)).rejects.toThrow('S3 503');
    expect(inFlight).toBe(0);
    expect(started.length).toBeLessThanOrEqual(MAX_CONCURRENT_PUTS);
  });

  test('회차 ID·앞자리 모양이 틀리면 키를 만들지 않는다', async () => {
    const objects = new MemoryResultObjects();
    const files = new ObjectStoreResultFiles(objects);
    await expect(files.write('../x', 'lobby', new Map([['abc', file(1)]]))).rejects.toThrow();
    await expect(files.write('e1', 'lobby', new Map([['ABCD', file(1)]]))).rejects.toThrow();
    expect(objects.size()).toBe(0);
  });
});
