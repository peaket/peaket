// 방향키로 묶음 안을 옮겨 다니는 도우미(탭·세그먼트·칩 탭, d2 CMP-030 '방향키 탐색')
import type { KeyboardEvent } from 'react';

/**
 * ←→(세로 묶음이면 ↑↓)·Home·End를 눌렀을 때 옮겨 갈 위치. 해당 없는 키면 null.
 * 끝에서 넘어가면 반대쪽 끝으로 돈다. 막힌 항목(disabled)은 건너뛴다.
 */
export function rovingIndex(
  event: KeyboardEvent,
  current: number,
  count: number,
  options: { vertical?: boolean; isDisabled?: (index: number) => boolean } = {},
): number | null {
  if (count <= 0) return null;
  const prevKey = options.vertical ? 'ArrowUp' : 'ArrowLeft';
  const nextKey = options.vertical ? 'ArrowDown' : 'ArrowRight';
  const disabled = options.isDisabled ?? (() => false);
  const step = (from: number, dir: 1 | -1) => {
    let i = from;
    for (let n = 0; n < count; n += 1) {
      i = (i + dir + count) % count;
      if (!disabled(i)) return i;
    }
    return from;
  };
  switch (event.key) {
    case nextKey:
      return step(current, 1);
    case prevKey:
      return step(current, -1);
    case 'Home':
      return step(count - 1, 1);
    case 'End':
      return step(0, -1);
    default:
      return null;
  }
}
