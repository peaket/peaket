// 원격 목록(remotes.json) 항목 검사 시험(F-03-2 T4, OPS-350). 정본: docs/frontend.md §4.5 'remotes.json'(칸 다섯, name 케밥 표기·호스트가 아는 이름,
// sha 소문자 16진 7~40자, integrity sha384-+base64 64자, contractMajor 1 이상의 정수, entry는 정확히 /remotes/<name>/<sha>/remoteEntry.js,
// 틀린 항목과 같은 이름 둘은 그 원격만 실패이고 나머지는 싣는다), ADR-0361 결정 3. 단언 값은 정본에서 가져오고 코드 상수를 옮기지 않는다.
// 정책(peaket-remote)이 이 검사를 거친 정식 주소만 통과시키므로, 목록 밖 주소마다 거절을 따로 본다(F-03-1 검증 '덧14', 계획 9 '허용 목록은 목록 밖 값마다').
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRemoteList, remoteEntryPath, REMOTE_LOAD_FAIL_REASONS } from '../src/index';

/** 실제 sha384 값(48바이트 base64는 채움 없이 64자) */
const SRI = `sha384-${createHash('sha384').update('peaket remote bytes').digest('base64')}`;
const SHA = '0a1b2c3d4e5f';
const good = (over: Record<string, unknown> = {}) => ({ name: 'queue', sha: SHA, entry: `/remotes/queue/${SHA}/remoteEntry.js`, integrity: SRI, contractMajor: 1, ...over });

describe('F-03-2 T4 원격 목록 형식', () => {
  it('F-03-2 T4 ① 정본 꼴 항목은 그대로 받고, 정식 주소는 /remotes/<name>/<sha>/remoteEntry.js다', () => {
    expect(SRI).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(remoteEntryPath('queue', SHA)).toBe('/remotes/queue/0a1b2c3d4e5f/remoteEntry.js');
    expect(remoteEntryPath('fan-widgets', 'abcdef0')).toBe('/remotes/fan-widgets/abcdef0/remoteEntry.js');
    const sha40 = 'f'.repeat(40);
    const r = parseRemoteList([good(), good({ name: 'purchase', sha: sha40, entry: `/remotes/purchase/${sha40}/remoteEntry.js`, contractMajor: 2 })]);
    expect(r.rejected).toEqual([]);
    expect(r.entries).toEqual([
      { name: 'queue', sha: SHA, entry: '/remotes/queue/0a1b2c3d4e5f/remoteEntry.js', integrity: SRI, contractMajor: 1 },
      { name: 'purchase', sha: sha40, entry: `/remotes/purchase/${sha40}/remoteEntry.js`, integrity: SRI, contractMajor: 2 },
    ]);
  });

  it('F-03-2 T4 ② entry가 정식 주소와 조금이라도 다르면(다른 출처·쿼리·조각·점 경로·인코딩한 /·다른 이름·다른 sha) 그 항목만 거절한다', () => {
    const outside = [
      `https://evil.example/remotes/queue/${SHA}/remoteEntry.js`,
      `//evil.example/remotes/queue/${SHA}/remoteEntry.js`,
      `/remotes/queue/${SHA}/remoteEntry.js?v=1`,
      `/remotes/queue/${SHA}/remoteEntry.js#x`,
      `/remotes/queue/${SHA}/../${SHA}/remoteEntry.js`,
      `/remotes/queue/./${SHA}/remoteEntry.js`,
      `/remotes/queue%2F${SHA}/remoteEntry.js`,
      `/remotes/queue/${SHA}%2FremoteEntry.js`,
      `/remotes/purchase/${SHA}/remoteEntry.js`,
      `/remotes/queue/${SHA}0/remoteEntry.js`,
      `/remotes/queue/${SHA}/remoteEntry.mjs`,
      `/remotes/queue/${SHA}/remoteEntry.js/`,
      `remotes/queue/${SHA}/remoteEntry.js`,
      `/Remotes/queue/${SHA}/remoteEntry.js`,
      `/assets/main.js`,
    ];
    for (const entry of outside) {
      const r = parseRemoteList([good({ entry }), good({ name: 'purchase', entry: `/remotes/purchase/${SHA}/remoteEntry.js` })]);
      expect(r.entries.map((e) => e.name), entry).toEqual(['purchase']);
      expect(r.rejected.map((x) => x.name), entry).toEqual(['queue']);
    }
  });

  it('F-03-2 T4 ③ 칸 꼴이 틀린 항목(이름·sha·integrity·contractMajor·칸 수)은 그 항목만 거절하고 나머지는 받는다', () => {
    const bad: Record<string, unknown>[] = [
      { name: 'Queue', entry: `/remotes/Queue/${SHA}/remoteEntry.js` },
      { name: 'queue_x', entry: `/remotes/queue_x/${SHA}/remoteEntry.js` },
      { name: '-queue', entry: `/remotes/-queue/${SHA}/remoteEntry.js` },
      { sha: '0A1B2C3D', entry: '/remotes/queue/0A1B2C3D/remoteEntry.js' },
      { sha: 'abc123', entry: '/remotes/queue/abc123/remoteEntry.js' },
      { sha: 'a'.repeat(41), entry: `/remotes/queue/${'a'.repeat(41)}/remoteEntry.js` },
      { sha: 'g123456', entry: '/remotes/queue/g123456/remoteEntry.js' },
      { integrity: SRI.replace('sha384-', 'sha256-') },
      { integrity: `${SRI}=` },
      { integrity: SRI.slice(0, -1) },
      { integrity: `${SRI} sha384-${'A'.repeat(64)}` },
      { contractMajor: 0 },
      { contractMajor: 1.5 },
      { contractMajor: '1' },
      { extra: true },
    ];
    for (const over of bad) {
      const item = good(over);
      const r = parseRemoteList([item, good({ name: 'purchase', entry: `/remotes/purchase/${SHA}/remoteEntry.js` })]);
      expect(r.entries.map((e) => e.name), JSON.stringify(over)).toEqual(['purchase']);
      expect(r.rejected, JSON.stringify(over)).toHaveLength(1);
    }
    // 칸이 빠져도 그 항목만
    const { contractMajor: _drop, ...noMajor } = good();
    expect(parseRemoteList([noMajor]).entries).toEqual([]);
    expect(parseRemoteList([noMajor]).rejected).toHaveLength(1);
  });

  it('F-03-2 T4 ④ 같은 이름이 둘이면 그 이름 모두를 거절하고, known 밖 이름도 거절한다', () => {
    const dup = parseRemoteList([good(), good({ sha: 'b'.repeat(12), entry: `/remotes/queue/${'b'.repeat(12)}/remoteEntry.js` }), good({ name: 'purchase', entry: `/remotes/purchase/${SHA}/remoteEntry.js` })]);
    expect(dup.entries.map((e) => e.name)).toEqual(['purchase']);
    expect(dup.rejected.map((x) => x.name)).toEqual(['queue', 'queue']);
    const unknown = parseRemoteList([good({ name: 'ads', entry: `/remotes/ads/${SHA}/remoteEntry.js` }), good()], { known: ['queue', 'purchase'] });
    expect(unknown.entries.map((e) => e.name)).toEqual(['queue']);
    expect(unknown.rejected.map((x) => x.name)).toEqual(['ads']);
  });

  it('F-03-2 T4 ⑤ 목록이 배열이 아니면 받을 항목이 없다(원격 칸 모두 list 실패)', () => {
    for (const json of [null, undefined, {}, { remotes: [good()] }, 'queue', 1]) {
      const r = parseRemoteList(json);
      expect(r.entries, JSON.stringify(json)).toEqual([]);
      expect(r.rejected, JSON.stringify(json)).toHaveLength(1);
    }
    // 항목이 객체가 아니어도 그 자리만
    expect(parseRemoteList([null, 'x', [good()], good()]).entries.map((e) => e.name)).toEqual(['queue']);
  });

  it('F-03-2 T4 ⑥ remoteEntryPath는 이름·sha 꼴이 틀리면 주소를 만들지 않는다', () => {
    expect(() => remoteEntryPath('../queue', SHA)).toThrow(TypeError);
    expect(() => remoteEntryPath('queue', `${SHA}/..`)).toThrow(TypeError);
    expect(() => remoteEntryPath('queue', 'ABCDEF0')).toThrow(TypeError);
  });

  it('F-03-2 T4 ⑦ 실패 까닭 이름은 정본 §5.16 일곱이다', () => {
    expect([...REMOTE_LOAD_FAIL_REASONS].sort()).toEqual(['container', 'contract', 'integrity', 'list', 'network', 'policy', 'timeout']);
  });
});
