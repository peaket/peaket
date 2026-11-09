// 관제 원격 위젯 계약 시험(docs/frontend.md §4.5, BUILD_ORDER BAS-210). 원격 무결성·대체 카드·빌드 워크플로는 OPS-350에서 더한다.
import { describe, expect, it } from 'vitest';
import { CONTRACT_MAJOR, defineWidget, isLoadable, type WidgetManifest } from '../src/index';

const base: WidgetManifest = {
  name: 'queue-monitor',
  contractMajor: 1,
  title: 'widget.queue.title' as WidgetManifest['title'],
  permissions: ['ops:read'] as WidgetManifest['permissions'],
  refresh: 'subscription',
  load: async () => ({ default: () => null }),
};

describe('위젯 정보', () => {
  it('계약 주판이 호스트와 같은 위젯만 싣는다', () => {
    expect(CONTRACT_MAJOR).toBe(1);
    expect(isLoadable(base)).toBe(true);
    expect(isLoadable({ ...base, contractMajor: 2 as 1 })).toBe(false);
  });

  it('위젯 이름·권한·갱신 방식이 틀리면 정의할 때 멈춘다', () => {
    expect(defineWidget(base)).toBe(base);
    expect(() => defineWidget({ ...base, name: 'Queue Monitor' })).toThrow(/이름/);
    expect(() => defineWidget({ ...base, permissions: [] })).toThrow(/권한/);
    expect(() => defineWidget({ ...base, refresh: { pollMs: 0 } })).toThrow(/pollMs/);
  });
});
