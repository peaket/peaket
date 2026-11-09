// CMP-049 내 순번 검증의 실행 관리(ADR-0232 결정 9): 진행 표시, 취소, 입력을 바꾸면 옛 결과를 버린다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createVerifyRun, verdictOf } from '../src/components/ShuffleProofPanel/verify-run.ts';

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

const OK_TITLE = '다시 계산한 순번이 결과 파일과 같습니다';
const BAD_TITLE = '다시 계산한 순번이 결과 파일과 다릅니다';

test('Q-T27 결론 표시: matched가 참일 때만 성공이고 그 밖에는 실패다', () => {
  assert.deepEqual(verdictOf({ fileRank: '1', recomputedRank: '1', matched: true }), { tone: 'success', title: OK_TITLE });
  assert.deepEqual(verdictOf({ fileRank: '1', recomputedRank: '2', matched: false }), { tone: 'danger', title: BAD_TITLE });
});

test('Q-T27 결론 표시: 표시 글이 같아도 matched가 거짓이면 실패다(글자 비교를 하지 않는다)', () => {
  assert.deepEqual(verdictOf({ fileRank: '머클 루트 불일치', recomputedRank: '머클 루트 불일치', matched: false }), { tone: 'danger', title: BAD_TITLE });
  assert.deepEqual(verdictOf({ fileRank: '—', recomputedRank: '—', matched: false }), { tone: 'danger', title: BAD_TITLE });
  assert.deepEqual(verdictOf({ fileRank: '1', recomputedRank: '1' }), { tone: 'danger', title: BAD_TITLE });
});

test('Q-T27 결론 표시: 일치해도 한계가 있으면 부르는 쪽이 준 주의 결론을 쓴다', () => {
  const conclusion = { tone: 'warning', title: '순번은 같지만 비콘 없이 뽑았습니다' };
  assert.deepEqual(verdictOf({ fileRank: '1', recomputedRank: '1', matched: true, conclusion }), conclusion);
});

test('Q-T27 결론 표시: 일치가 아닌데 주의 결론이 오면 실패로 낸다(안전한 쪽)', () => {
  assert.deepEqual(verdictOf({ fileRank: '1', recomputedRank: '2', matched: false, conclusion: { tone: 'warning', title: '주의' } }), { tone: 'danger', title: BAD_TITLE });
});

test('Q-T27 결론 표시: 확인하지 못한 구간의 실패 결론은 그대로 쓴다', () => {
  const conclusion = { tone: 'danger', title: '확인됨으로 낼 수 없습니다' };
  assert.deepEqual(verdictOf({ fileRank: '1', recomputedRank: '확인하지 않음', matched: false, conclusion }), conclusion);
});

test('Q-T27 부품은 결론을 verdictOf에서만 고르고, 글자로 비교하지 않는다', () => {
  assert.match(source, /verdictOf\(verified\)/);
  assert.doesNotMatch(source, /fileRank === /);
  assert.doesNotMatch(readFileSync(fileURLToPath(new URL('../src/components/ShuffleProofPanel/verify-run.ts', import.meta.url)), 'utf8'), /fileRank === /);
});

test('Q-T27 결과의 안내 문단은 긴 글이 칸을 넘지 않게 줄을 바꾼다', () => {
  assert.match(source, /banner-body" style=\{\{ overflowWrap: 'anywhere', minWidth: 0 \}\}/);
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
