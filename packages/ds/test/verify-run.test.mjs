// CMP-049 내 순번 검증의 실행 관리(ADR-0232 결정 9): 진행 표시, 취소, 입력을 바꾸면 옛 결과를 버린다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createVerifyRun } from '../src/components/ShuffleProofPanel/verify-run.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

function world(onVerify) {
  const states = [];
  const run = createVerifyRun(onVerify, (s) => states.push(s));
  return { run, states, last: () => states.at(-1) };
}

test('누르면 계산 중이 되고 끝나면 결과를 낸다', async () => {
  const d = deferred();
  let seen;
  const w = world((value, ctx) => ((seen = { value, ctx }), d.promise));
  w.run.start('abc');
  assert.equal(w.last().busy, true);
  assert.equal(seen.value, 'abc');
  d.resolve({ fileRank: '1', recomputedRank: '1' });
  await d.promise;
  await Promise.resolve();
  assert.deepEqual(w.last(), { busy: false, progress: null, result: { fileRank: '1', recomputedRank: '1' }, error: null });
});

test('진행 내용을 그대로 보인다', async () => {
  const d = deferred();
  let ctx;
  const w = world((_v, c) => ((ctx = c), d.promise));
  w.run.start('abc');
  ctx.onProgress('결과 파일 10/4,096개');
  assert.equal(w.last().progress, '결과 파일 10/4,096개');
});

test('{ error }면 오류로 보인다', async () => {
  const w = world(async () => ({ error: '없음' }));
  w.run.start('abc');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(w.last(), { busy: false, progress: null, result: null, error: '없음' });
});

test('계산 중에 다시 눌러도 겹쳐 돌지 않는다', () => {
  let n = 0;
  const w = world(() => ((n += 1), new Promise(() => {})));
  w.run.start('a');
  w.run.start('a');
  assert.equal(n, 1);
});

test('취소하면 신호가 켜지고 그 뒤에 온 결과를 버린다', async () => {
  const d = deferred();
  let ctx;
  const w = world((_v, c) => ((ctx = c), d.promise));
  w.run.start('a');
  w.run.cancel();
  assert.equal(ctx.signal.aborted, true);
  assert.deepEqual(w.last(), { busy: false, progress: null, result: null, error: null });
  d.resolve({ fileRank: '1', recomputedRank: '1' });
  await d.promise;
  await Promise.resolve();
  assert.equal(w.last().result, null);
});

test('입력을 바꿔 다시 시작하면 옛 계산의 결과와 오류를 버린다', async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first, second];
  const w = world(() => queue.shift().promise);
  w.run.start('old');
  w.run.cancel();
  w.run.start('new');
  first.reject(new Error('늦은 실패'));
  await first.promise.catch(() => {});
  await Promise.resolve();
  assert.equal(w.last().busy, true);
  assert.equal(w.last().error, null);
  second.resolve({ fileRank: '2', recomputedRank: '2' });
  await second.promise;
  await Promise.resolve();
  assert.deepEqual(w.last().result, { fileRank: '2', recomputedRank: '2' });
});

// 이 패키지에는 DOM 시험 도구가 없어 부품 연결은 원문으로 본다
const source = readFileSync(fileURLToPath(new URL('../src/components/ShuffleProofPanel/ShuffleVerifier.tsx', import.meta.url)), 'utf8');

test('부품이 사라지면 돌던 계산을 멈춘다(자동 채움이 늦게 와 key가 바뀌는 경우 포함)', () => {
  assert.match(source, /useEffect\(\(\) => \(\) => runner\?\.cancel\(\), \[runner\]\)/);
});

test('계산 중에는 [다시 계산] 버튼을 내리고 그 자리에 진행 글을 보인다(d5 §5.19)', () => {
  assert.doesNotMatch(source, /aria-disabled=\{disabledReason \|\| busy/);
  assert.match(source, /\{busy \? null : button\}/);
});

test('예상 밖 실패는 정해진 글로 보인다', async () => {
  const w = world(async () => {
    throw new Error('보이면 안 되는 내부 글');
  });
  w.run.start('a');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(w.last().error, '다시 계산하지 못했습니다');
});
