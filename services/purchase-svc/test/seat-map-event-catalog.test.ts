// 다시 만들기 반복의 회차 목록(SeatMapEventCatalog, BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 다시 만들기 반복).
// 판 파일이 있는 회차(files.list)마다 그 판(seatMap.config)의 판매 종료를 읽는다. 판을 읽지 못한 회차는 빼고, 폴더를 읽지 못하면 던진다.
// 대역 둘(파일 목록·판)과, 임시 폴더의 실제 판 파일을 FileSeatMapSource·LayoutSeatMap으로 읽는 조립 하나를 본다.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeClock } from '@peaket/platform';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type EventSeatConfig, FileSeatMapSource, LayoutSeatMap, SeatMapEventCatalog } from '../src/modules/inventory/index.js';

const SALE_END_MS = Date.parse('2026-12-01T09:00:00.000Z');
const config = (eventId: string, saleEndsAtMs: number): EventSeatConfig => ({ eventId, layoutVersion: '7', seatCount: 10, perAccountLimit: 2, saleEndsAtMs });

/** 대역: ids는 files.list의 답(Error면 던짐), configs는 회차의 판(undefined = 판 없음, Error = 던짐) */
function catalogOf(ids: string[] | Error, configs: Record<string, EventSeatConfig | undefined | Error>) {
  const calls = { list: 0, config: [] as string[] };
  const catalog = new SeatMapEventCatalog({
    files: {
      list: async () => {
        calls.list += 1;
        if (ids instanceof Error) throw ids;
        return [...ids];
      },
    },
    seatMap: {
      config: async (eventId: string) => {
        calls.config.push(eventId);
        const c = configs[eventId];
        if (c instanceof Error) throw c;
        return c;
      },
    },
  });
  return { catalog, calls };
}

describe('SeatMapEventCatalog.list', () => {
  test('ST26_파일 목록의 회차마다(그 차례 그대로) 판의 판매 종료로 { eventId, saleEndsAtMs }를 만든다. 다른 칸은 싣지 않는다 [S-T26]', async () => {
    const { catalog, calls } = catalogOf(['ev-b', 'ev-a'], { 'ev-a': config('ev-a', SALE_END_MS), 'ev-b': config('ev-b', SALE_END_MS + 1) });
    expect(await catalog.list()).toEqual([
      { eventId: 'ev-b', saleEndsAtMs: SALE_END_MS + 1 },
      { eventId: 'ev-a', saleEndsAtMs: SALE_END_MS },
    ]);
    expect(calls.config).toEqual(['ev-b', 'ev-a']);
  });

  test('ST26_판이 없거나 틀린 회차(config undefined)와 config가 던진 회차는 빼고 던지지 않는다. 다른 회차는 그대로다 [S-T26] [ASVS v5.0.0-16.5.2]', async () => {
    const { catalog } = catalogOf(['ev-1', 'ev-2', 'ev-3', 'ev-4'], {
      'ev-1': config('ev-1', SALE_END_MS),
      'ev-2': undefined,
      'ev-3': new Error('EIO'),
      'ev-4': config('ev-4', SALE_END_MS + 5),
    });
    expect(await catalog.list()).toEqual([
      { eventId: 'ev-1', saleEndsAtMs: SALE_END_MS },
      { eventId: 'ev-4', saleEndsAtMs: SALE_END_MS + 5 },
    ]);
  });

  test('ST26_파일 목록이 던지면(폴더를 읽지 못함) 같은 오류로 던지고 판을 읽지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const boom = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const { catalog, calls } = catalogOf(boom, {});
    await expect(catalog.list()).rejects.toBe(boom);
    expect(calls.config).toEqual([]);
  });

  test('ST26_빈 폴더면 []다', async () => {
    const { catalog } = catalogOf([], {});
    expect(await catalog.list()).toEqual([]);
  });
});

describe('SeatMapEventCatalog + FileSeatMapSource + LayoutSeatMap(임시 폴더의 실제 판 파일)', () => {
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'peaket-catalog-'));
    dir = join(root, 'maps');
    await mkdir(dir);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 판 파일 하나(구역 하나, 좌석 둘) */
  const mapFile = (saleEndsAt: string) => ({
    perAccountLimit: 2,
    saleEndsAt,
    layout: {
      layoutVersion: 3,
      canvas: { width: 100, height: 100 },
      sections: [
        {
          sectionId: 'SEC-A',
          name: '구역 A',
          shape: { type: 'polygon', points: [] },
          tierId: 'R',
          seatIndexRange: { from: 0, to: 1 },
          seats: [
            { seatId: 'A01', row: 'A', number: 1, x: 1, y: 1, index: 0 },
            { seatId: 'A02', row: 'A', number: 2, x: 2, y: 1, index: 1 },
          ],
        },
      ],
    },
  });

  test('ST26_폴더의 판 파일 회차를 이름 차례로, 판의 saleEndsAt을 판매 종료로 준다. JSON이 아니거나 모양이 틀린 판의 회차는 뺀다 [S-T26]', async () => {
    await writeFile(join(dir, 'ev-2.json'), JSON.stringify(mapFile('2026-12-02T09:00:00.000Z')), 'utf8');
    await writeFile(join(dir, 'ev-1.json'), JSON.stringify(mapFile('2026-12-01T18:00:00+09:00')), 'utf8');
    await writeFile(join(dir, 'ev-3.json'), '{ not json', 'utf8');
    await writeFile(join(dir, 'ev-4.json'), JSON.stringify({ ...mapFile('2026-12-01T09:00:00.000Z'), saleEndsAt: 'not-a-date' }), 'utf8');
    const source = new FileSeatMapSource(dir);
    const seatMap = new LayoutSeatMap({ source, clock: fakeClock(), logger: { warn: () => undefined } });
    // 시험 준비 확인: 판 파일이 맞는 모양이다(LayoutSeatMap이 읽는다)
    expect(await seatMap.config('ev-1')).toMatchObject({ saleEndsAtMs: Date.parse('2026-12-01T18:00:00+09:00') });
    expect(await seatMap.config('ev-3')).toBeUndefined();
    const catalog = new SeatMapEventCatalog({ files: source, seatMap });
    expect(await catalog.list()).toEqual([
      { eventId: 'ev-1', saleEndsAtMs: Date.parse('2026-12-01T18:00:00+09:00') },
      { eventId: 'ev-2', saleEndsAtMs: Date.parse('2026-12-02T09:00:00.000Z') },
    ]);
  });
});
