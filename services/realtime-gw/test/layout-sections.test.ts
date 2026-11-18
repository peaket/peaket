// 판 파일 읽는 때와 기억 단위 시험(BAT-052 리뷰 반영 RF-T10, 지적 COR-03). 바깥 경계는 LayoutSectionsFile(가짜 시계·가짜 파일 읽기)이다.
// 정본: docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '판 파일'(layout.layoutVersion과 layout.sections 개수 1~65,535만 읽음),
// §2 '운영 좌석맵 판'의 '읽는 때'(처음 붙을 때 한 번, 같은 회차 동시 요청은 한 번만 읽음, 없거나 틀리면 1초 동안 '없음'을 기억하고 1,024개까지,
// 30초 [가정]마다 다시 읽고 실패하면 이전 판을 둔다), §12 S-T42 ⑳. 단언 값은 정본에서 적고 구현 상수를 가져오지 않는다.
// 30초 박자 자체는 조립(start.ts)의 타이머라 여기서는 refresh() 한 번의 앞뒤를 본다.
import { join } from 'node:path';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { LayoutSectionsFile } from '../src/modules/stream/index.js';

const SPEC = { missingTtlMs: 1_000, missingMax: 1_024, maxSections: 65_535 } as const;
const DIR = join('seatmaps-test');
const WALL0 = Date.parse('2026-11-19T01:00:00.000Z') + 37;

const layoutText = (layoutVersion: number, sections: number): string => JSON.stringify({ layout: { layoutVersion, sections: Array.from({ length: sections }, (_, i) => ({ id: `S${i}` })) } });

interface Gate {
  release(): void;
}

/** 회차 → 파일 글(없으면 undefined, 'throw'면 읽기 실패). 읽은 횟수를 센다. hold면 release까지 끝나지 않는다 */
function files() {
  const content = new Map<string, string | undefined | 'throw'>();
  const reads = new Map<string, number>();
  const gates: Gate[] = [];
  let hold = false;
  const read = async (path: string): Promise<string | undefined> => {
    const eventId = path.slice(DIR.length + 1).replace(/\.json$/, '');
    reads.set(eventId, (reads.get(eventId) ?? 0) + 1);
    if (hold) await new Promise<void>((resolve) => gates.push({ release: resolve }));
    const v = content.get(eventId);
    if (v === 'throw') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return v;
  };
  return {
    content,
    reads,
    gates,
    read,
    setHold: (h: boolean) => (hold = h),
    readsOf: (eventId: string) => reads.get(eventId) ?? 0,
  };
}

function make() {
  const clock = fakeClock({ now: WALL0, monotonic: 12_345 });
  const f = files();
  const layout = new LayoutSectionsFile({ dir: DIR, clock, read: f.read });
  return { clock, f, layout };
}

describe('S-T42 ⑳ 판 파일 읽는 때와 기억', () => {
  test('S-T42 ⑳ 없는 회차는 1초 동안 없음을 기억한다: 999ms에는 다시 읽지 않고 1,000ms에 다시 읽는다. 그 사이 파일이 생기면 1,000ms부터 판을 준다', async () => {
    const { clock, f, layout } = make();
    expect(await layout.get('ev-x')).toBeUndefined();
    expect(f.readsOf('ev-x')).toBe(1);
    f.content.set('ev-x', layoutText(3, 7));
    clock.advance(SPEC.missingTtlMs - 1);
    expect(await layout.get('ev-x')).toBeUndefined();
    expect(f.readsOf('ev-x')).toBe(1);
    clock.advance(1);
    expect(await layout.get('ev-x')).toEqual({ layoutVersion: 3, sectionCount: 7 });
    expect(f.readsOf('ev-x')).toBe(2);
    expect(layout.count('ev-x')).toBe(7);
  });

  test('S-T42 ⑳ 틀린 판(JSON 아님·구역 0개·65,536개)과 읽기 실패도 없음으로 1초 기억하고, 구역 1개·65,535개 판은 받는다', async () => {
    const { clock, f, layout } = make();
    f.content.set('ev-json', '{not json');
    f.content.set('ev-zero', layoutText(1, 0));
    f.content.set('ev-big', layoutText(1, SPEC.maxSections + 1));
    f.content.set('ev-err', 'throw');
    f.content.set('ev-one', layoutText(1, 1));
    f.content.set('ev-max', layoutText(1, SPEC.maxSections));
    for (const id of ['ev-json', 'ev-zero', 'ev-big', 'ev-err']) {
      expect(await layout.get(id), id).toBeUndefined();
      expect(layout.count(id), id).toBeUndefined();
    }
    expect((await layout.get('ev-one'))?.sectionCount).toBe(1);
    expect((await layout.get('ev-max'))?.sectionCount).toBe(SPEC.maxSections);
    clock.advance(SPEC.missingTtlMs - 1);
    for (const id of ['ev-json', 'ev-zero', 'ev-big', 'ev-err']) {
      await layout.get(id);
      expect(f.readsOf(id), id).toBe(1);
    }
  });

  test('S-T42 ⑳ 없음 기억은 1,024개까지다: 1,025번째 회차를 물으면 가장 오래된 첫 회차를 잊어(바로 다시 읽음) 둘째는 아직 기억한다', async () => {
    const { f, layout } = make();
    const ids = Array.from({ length: SPEC.missingMax + 1 }, (_, i) => `ev-m${i}`);
    for (const id of ids.slice(0, SPEC.missingMax)) await layout.get(id);
    // 1,024개까지는 모두 기억한다: 첫 회차를 1초 안에 다시 물어도 읽지 않는다
    await layout.get(ids[0]!);
    expect(f.readsOf(ids[0]!)).toBe(1);
    // 1,025번째를 물으면 가장 오래 기억한 것(첫 회차는 방금 다시 물었으나 기억이 새로 생기지 않았으므로 여전히 가장 오래다)을 잊는다
    await layout.get(ids[SPEC.missingMax]!);
    await layout.get(ids[0]!);
    expect(f.readsOf(ids[0]!)).toBe(2);
    await layout.get(ids[2]!);
    expect(f.readsOf(ids[2]!)).toBe(1);
  });

  test('S-T42 ⑳ 같은 회차로 동시에 붙으면 파일을 한 번만 읽고 모두 같은 판을 받는다', async () => {
    const { f, layout } = make();
    f.content.set('ev-c', layoutText(5, 12));
    f.setHold(true);
    const all = Promise.all(Array.from({ length: 20 }, () => layout.get('ev-c')));
    await new Promise((r) => setImmediate(r));
    f.setHold(false);
    for (const g of f.gates.splice(0)) g.release();
    const got = await all;
    expect(f.readsOf('ev-c')).toBe(1);
    expect(got.every((x) => x?.sectionCount === 12 && x.layoutVersion === 5)).toBe(true);
    // 읽은 판은 다시 읽지 않는다(30초 다시 읽기 전까지)
    await layout.get('ev-c');
    expect(f.readsOf('ev-c')).toBe(1);
  });

  test('S-T42 ⑳ 다시 읽기(30초 박자의 한 번) 앞에는 옛 판, 뒤에는 판 번호가 오른 새 판이다', async () => {
    const { f, layout } = make();
    f.content.set('ev-r', layoutText(3, 5));
    await layout.get('ev-r');
    f.content.set('ev-r', layoutText(4, 6));
    expect(layout.count('ev-r')).toBe(5);
    expect((await layout.get('ev-r'))?.sectionCount).toBe(5);
    await layout.refresh();
    expect(layout.count('ev-r')).toBe(6);
    expect(await layout.get('ev-r')).toEqual({ layoutVersion: 4, sectionCount: 6 });
  });

  test('S-T42 ⑳ 다시 읽기가 실패하면(파일 없음·틀림·구역 0개·65,536개·읽기 실패) 이전 판을 그대로 두고, refresh는 던지지 않는다', async () => {
    const { f, layout } = make();
    f.content.set('ev-k', layoutText(3, 9));
    await layout.get('ev-k');
    for (const bad of [undefined, '{not json', layoutText(9, 0), layoutText(9, SPEC.maxSections + 1), 'throw'] as const) {
      f.content.set('ev-k', bad);
      await expect(layout.refresh()).resolves.toBeUndefined();
      expect(layout.count('ev-k'), String(bad).slice(0, 20)).toBe(9);
      expect(await layout.get('ev-k')).toEqual({ layoutVersion: 3, sectionCount: 9 });
    }
  });
});
