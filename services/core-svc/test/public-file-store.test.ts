// 공개 파일 저장소 어댑터(메모리·로컬 폴더, ADR-0260 결정 6, seat-hold ASVS 5.3.2)
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { LocalFolderPublicFileStore, MemoryPublicFileStore } from '../src/modules/catalog/index.js';

const E = '0190a8c2-7b3e-7d4a-9c61-0f3e8b7a6d25';
const META = { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' };
const BAD = [
  `v1/events/${E}/seatmap-layouts/0.json`,
  `v1/events/${E}/seatmap-layouts/01.json`,
  `v1/events/${E}/seatmap-layouts/1.json.tmp`,
  `v1/events/${E}/../${E}/seatmap-layouts/1.json`,
  `v1/events/${E.toUpperCase()}/seatmap-layouts/1.json`,
  `../v1/events/${E}/seatmap-layouts/1.json`,
  `/v1/events/${E}/seatmap-layouts/1.json`,
  `v1\\events\\${E}\\seatmap-layouts\\1.json`,
  `v1/events/x/seatmap-layouts/1.json`,
  `production/${E}/320.avif`,
  `staging/../v1/events/${E}/seatmap-layouts/1.json`,
  `public/v1/events/${E}/seatmap-layouts/1.json`,
  `staging/staging/v1/events/${E}/seatmap-layouts/1.json`,
];

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'peaket-pub-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('공개 파일 키(ADR-0260 결정 6)', () => {
  test('로컬 폴더 어댑터는 정한 꼴의 키만 쓰고 지우며 뿌리 밖·다른 꼴은 던진다 [ASVS v5.0.0-5.3.2]', async () => {
    const s = new LocalFolderPublicFileStore(root);
    await s.put(`v1/events/${E}/seatmap-layouts/10.json`, new TextEncoder().encode('{"a":1}'), META);
    expect(await readFile(join(root, 'public', 'v1', 'events', E, 'seatmap-layouts', '10.json'), 'utf8')).toBe('{"a":1}');
    // 임시 파일이 남지 않는다
    expect(await readdir(join(root, 'public', 'v1', 'events', E, 'seatmap-layouts'))).toEqual(['10.json']);
    for (const k of BAD) {
      await expect(s.put(k, new Uint8Array([1]), META), k).rejects.toThrow();
      await expect(s.delete(k), k).rejects.toThrow();
    }
    await s.delete(`v1/events/${E}/seatmap-layouts/10.json`);
    await s.delete(`v1/events/${E}/seatmap-layouts/10.json`);
    expect(await readdir(join(root, 'public', 'v1', 'events', E, 'seatmap-layouts'))).toEqual([]);
  });

  test('S-T38 ⑥ 준비 위치(staging/) 키는 공개 폴더 밖(뿌리/staging)에 둔다', async () => {
    const s = new LocalFolderPublicFileStore(root);
    await s.put(`staging/v1/events/${E}/seatmap-layouts/2.json`, new TextEncoder().encode('{"b":2}'), META);
    expect(await readFile(join(root, 'staging', 'v1', 'events', E, 'seatmap-layouts', '2.json'), 'utf8')).toBe('{"b":2}');
    await expect(readFile(join(root, 'public', 'staging', 'v1', 'events', E, 'seatmap-layouts', '2.json'))).rejects.toThrow();
    await s.delete(`staging/v1/events/${E}/seatmap-layouts/2.json`);
    expect(await readdir(join(root, 'staging', 'v1', 'events', E, 'seatmap-layouts'))).toEqual([]);
  });

  test('메모리 어댑터도 같은 키 규칙이고 메타데이터를 둔다', async () => {
    const s = new MemoryPublicFileStore();
    await s.put(`v1/events/${E}/seatmap-layouts/1.json`, new Uint8Array([1]), META);
    await s.put(`staging/v1/events/${E}/seatmap-layouts/1.json`, new Uint8Array([1]), META);
    expect(s.files.get(`v1/events/${E}/seatmap-layouts/1.json`)).toMatchObject(META);
    for (const k of BAD) await expect(s.put(k, new Uint8Array([1]), META), k).rejects.toThrow();
  });
});
