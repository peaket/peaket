// RB-05는 진입 파드(queue-svc)와 리더(admission-ctrl) 어느 쪽이 돌아도 같아야 한다(ADR-0182 결정 6). 두 원문이 같은 글인지 본다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import * as queue from '../../queue-svc/src/modules/entry/domain/queue.js';
import * as plan from '../src/modules/leader/domain/plan.js';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const block = (src: string, name: string) => {
  const m = new RegExp(`(?:export )?const ${name} = \`[\\s\\S]*?\\n\`;\\n`).exec(src);
  if (!m) throw new Error(`${name}이 없다`);
  return m[0];
};

/** `머리`로 시작해 첫 줄머리 닫는 중괄호까지(함수 하나) */
const fn = (src: string, head: string) => {
  const i = src.indexOf(head);
  if (i < 0) throw new Error(`${head}이 없다`);
  return src.slice(i, src.indexOf('\n}\n', i) + 3);
};

test('[Q-T16] 리더의RB-05바탕값과칸떼기시간창은_queue-svc와같다(ADR-0243)', () => {
  expect(plan.RB05_SKIP_BASE).toBe(queue.RB05_SKIP_BASE);
  expect(plan.RB05_SKIP_BASE).toBe(420_000);
  expect([plan.ARRIVAL_CARVE_WINDOW_MS, plan.ARRIVAL_CARVE_WINDOW_MAX, plan.RB05_RATE_MAX_PER_SEC, plan.REPLICATION_LAG_P999_MS]).toEqual([queue.ARRIVAL_CARVE_WINDOW_MS, queue.ARRIVAL_CARVE_WINDOW_MAX, queue.RB05_RATE_MAX_PER_SEC, queue.REPLICATION_LAG_P999_MS]);
});

test('리더의RB05복제확인·복제본세기·연결표지함수는_queue-svc진입저장소와같은글이다(ADR-0186)', () => {
  const queue = read('../../queue-svc/src/modules/entry/adapters/redis-entry-store.ts');
  const leader = read('../src/modules/leader/adapters/redis-leader-store.ts');
  for (const head of ['export function onlineReplicas(', 'export function connOf(', 'export async function confirmRb05(']) expect(fn(leader, head)).toBe(fn(queue, head));
});

test('리더의RB05·복제확인·노드표지·수명늘리기Lua는_queue-svc진입Lua와같은글이다(ADR-0182 결정 6, ADR-0186)', () => {
  const queue = read('../../queue-svc/src/modules/entry/adapters/entry-lua.ts');
  const leader = read('../src/modules/leader/adapters/leader-lua.ts');
  for (const name of ['EXTEND', 'NODE_ID', 'RB05_LUA', 'RB05_MARK_LUA', 'RB05_CLEAR_LUA']) expect(block(leader, name)).toBe(block(queue, name));
});

test('[Q-T16] 리더의칸닫기시간과_진입Lua의칸닫기시간은_같은값이다', () => {
  const close = /ARRIVAL_CLOSE_AFTER_MS = ([\d_]+)/;
  expect(close.exec(read('../src/modules/leader/adapters/leader-lua.ts'))?.[1]).toBe(close.exec(read('../../queue-svc/src/modules/entry/adapters/entry-lua.ts'))?.[1]);
});
