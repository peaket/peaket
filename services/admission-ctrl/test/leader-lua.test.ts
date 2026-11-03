// RB-05는 진입 파드(queue-svc)와 리더(admission-ctrl) 어느 쪽이 돌아도 같아야 한다(ADR-0182 결정 6). 두 원문이 같은 글인지 본다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const block = (src: string, name: string) => {
  const m = new RegExp(`(?:export )?const ${name} = \`[\\s\\S]*?\\n\`;\\n`).exec(src);
  if (!m) throw new Error(`${name}이 없다`);
  return m[0];
};

test('리더의RB05·노드표지·수명늘리기Lua는_queue-svc진입Lua와같은글이다', () => {
  const queue = read('../../queue-svc/src/modules/entry/adapters/entry-lua.ts');
  const leader = read('../src/modules/leader/adapters/leader-lua.ts');
  for (const name of ['EXTEND', 'NODE_ID', 'RB05_LUA']) expect(block(leader, name)).toBe(block(queue, name));
});
