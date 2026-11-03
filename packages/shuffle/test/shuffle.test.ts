// 셔플 재현 규격(ADR-0050 결정 7, docs/features/queue-admission.md §3 '묶음의 첫 구현'). 기준값은 reference/shuffle.py(독립 구현)가 만든 test/vectors.json이다
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ALGORITHM, combinedKey, commitment, merkleRoot, shuffle, shuffleWith, sortHashes, wordStream } from '../src/index.js';

const v = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')) as {
  event: string;
  seed: string;
  beacon: string;
  tokens: string[];
  commitment: string;
  merkleRoot: string;
  roots: Record<string, string>;
  key: string;
  shuffled: string[];
  small: number[];
  firstWords: number[];
  rejection: { items: number[]; words: number[]; out: number[] };
};
const hex = (s: string) => Buffer.from(s, 'hex');

describe('재현 규격(참조 구현과 같은 값)', () => {
  test('알고리즘판은v1이다', () => {
    expect(ALGORITHM).toBe('v1');
  });

  test('[ASVS v5.0.0-11.4.1] 커밋은_SHA-256(PEAKET-shuffle-v1‖회차ID‖시드)다', () => {
    expect(commitment(v.event, hex(v.seed)).toString('hex')).toBe(v.commitment);
  });

  test('[ASVS v5.0.0-11.4.3] 머클루트는_RFC6962(잎0x00·노드0x01, 2의거듭제곱으로나눔)이고_잎수마다참조구현과같다', () => {
    const leaves = v.tokens.map(hex);
    expect(merkleRoot(leaves).toString('hex')).toBe(v.merkleRoot);
    for (const [n, root] of Object.entries(v.roots)) expect(merkleRoot(leaves.slice(0, Number(n))).toString('hex'), `잎 ${n}개`).toBe(root);
  });

  test('결합키와_섞은순서가_참조구현과같다', () => {
    const key = combinedKey(hex(v.seed), hex(v.beacon), hex(v.merkleRoot), v.event);
    expect(key.toString('hex')).toBe(v.key);
    expect(shuffle(v.tokens, key)).toEqual(v.shuffled);
    expect(shuffle([0, 1, 2, 3, 4], key)).toEqual(v.small);
  });

  test('단어흐름은_블록번호0부터세고_블록마다큰끝32비트여덟개다', () => {
    const g = wordStream(hex(v.key));
    expect(Array.from({ length: 10 }, () => g.next().value)).toEqual(v.firstWords);
  });

  test('거부표본추출_한도이상의단어는버리고다음단어를쓴다', () => {
    const words = [...v.rejection.words];
    expect(shuffleWith(v.rejection.items, () => words.shift()!)).toEqual(v.rejection.out);
    // 첫 단어를 버려서 세 단어를 모두 썼다(버리지 않으면 하나가 남고 순서도 다르다)
    expect(words).toEqual([]);
  });
});

describe('성질', () => {
  const key = createHash('sha256').update('k').digest();

  test('섞은결과는_같은원소의순열이고_입력을바꾸지않는다', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const before = [...items];
    const out = shuffle(items, key);
    expect(items).toEqual(before);
    expect([...out].sort((a, b) => a - b)).toEqual(before);
    expect(out).not.toEqual(before);
  });

  test('같은키면같은결과_다른키면다른결과다', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    expect(shuffle(items, key)).toEqual(shuffle(items, key));
    expect(shuffle(items, createHash('sha256').update('k2').digest())).not.toEqual(shuffle(items, key));
    expect(shuffle([], key)).toEqual([]);
    expect(shuffle(['a'], key)).toEqual(['a']);
  });

  test('셔플전배열은_토큰해시오름차순이다', () => {
    expect(sortHashes(['ff', '0a', 'b1'])).toEqual(['0a', 'b1', 'ff']);
  });

  // 순열인지만 본다(시간 기준은 아래 Q-T6). CI 실행기는 다른 작업과 CPU를 나눠 이 PC에서 1초 안인 것이 8초를 넘기도 해 기본 5초 대신 넉넉히 준다
  test('10만건도_같은원소의순열이다', () => {
    const leaves = Array.from({ length: 100_000 }, (_, i) => createHash('sha256').update(String(i)).digest());
    const out = shuffle(leaves, combinedKey(key, key, merkleRoot(leaves), 'evt-100k'));
    expect(out).toHaveLength(100_000);
    expect(new Set(out).size).toBe(100_000);
  }, 120_000);

  // 시간 기준(Q-T6, 비콘 뒤 5초 안 게시)은 PoC 0.5.3(BUILD_ORDER BAS-100)에서 조용한 기계로 정한다. 공용 시험 게이트에서는
  // 다른 작업과 CPU를 나눠 시간이 크게 흔들려(CI 실행기에서 71초, 이 PC 혼자서 5초대) 켤 때만 잰다: PEAKET_BENCH=1 pnpm --filter @peaket/shuffle test
  test.runIf(process.env.PEAKET_BENCH === '1')('Q-T6_100만건셔플과머클루트(연산만, 게시는따로잰다)를_재서남긴다', () => {
    const leaves = Array.from({ length: 1_000_000 }, (_, i) => createHash('sha256').update(String(i)).digest());
    const started = performance.now();
    const root = merkleRoot(leaves);
    const out = shuffle(leaves, combinedKey(key, key, root, 'evt-1m'));
    const ms = performance.now() - started;
    expect(out).toHaveLength(1_000_000);
    console.log(`셔플 100만 건 + 머클 루트: ${Math.round(ms)}ms`);
  }, 600_000);
});
