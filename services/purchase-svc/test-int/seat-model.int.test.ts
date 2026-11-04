// 좌석 홀드·판매 확정 모델 기반 시험(wbs 2.5.5, docs/verification.md §2.4, V-T40). BUILD_ORDER PRF-150 ①은 명세와 시험을 잇는 두 확인만 둔다:
// 명령 이름 목록(seat-model/actions.ts의 SPEC_ACTIONS)이 명세 specs/seat.qnt의 `step`이 고르는 동작 이름과 같은지, 재생 기록(seat-model/traces)이
// 지금 명세로 만든 것인지. 실제 Valkey·PostgreSQL 위의 하네스(SeatSystem), `Record<SpecAction, …>` 명령, 무작위 실행·경합·기록 재생은 PRF-151이 더한다
// (그때 이름 대조는 명령 모음의 열쇠와 SPEC_ACTIONS를 견주는 것으로 바꾼다. queue-model.int.test.ts와 같은 꼴).
// CI 형식 검사(tools/spec-check/spec-check.mjs의 stepActions·checkMbt)도 같은 두 가지를 본다. 이 시험은 purchase-svc 쪽에서 먼저 알게 한다
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { SPEC_ACTIONS } from './seat-model/actions.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SPEC_FILE = resolve(HERE, '..', '..', '..', 'specs', 'seat.qnt');
const TRACES = join(HERE, 'seat-model', 'traces');

/** 명세 `action step` 본문에 나오는, 선언된 action 이름(이름순). spec-check.mjs의 stepActions와 같은 규칙이다 */
function stepActions(text: string): string[] {
  const src = text.replace(/\/\/.*$/gm, '');
  const at = src.search(/^\s*action\s+step\s*=/m);
  if (at < 0) throw new Error('action step이 없다');
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i >= 0 && i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('action step의 중괄호가 닫히지 않는다');
  const body = src.slice(open, end + 1);
  const declared = new Set([...src.matchAll(/^\s*action\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((x) => x[1]!).filter((n) => n !== 'step' && n !== 'init'));
  return [...new Set([...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((x) => x[1]!).filter((n) => declared.has(n)))].sort();
}

test('V-T40 명령 이름(SPEC_ACTIONS)이 명세 step의 동작 이름과 같다(14개, 이름순)', () => {
  expect([...SPEC_ACTIONS]).toEqual(stepActions(readFileSync(SPEC_FILE, 'utf8')));
  expect(SPEC_ACTIONS).toHaveLength(14);
});

test('V-T40 재생 기록이 지금 명세로 만든 것이다(아니면 node tools/spec-check/run-local.mjs traces --spec seat)', () => {
  const manifest = JSON.parse(readFileSync(join(TRACES, 'manifest.json'), 'utf8')) as { specSha256: string; files: string[] };
  expect(manifest.specSha256).toBe(createHash('sha256').update(readFileSync(SPEC_FILE)).digest('hex'));
  expect(manifest.files.length).toBeGreaterThan(0);
  // 목록에 적힌 기록 파일이 모두 있다(리뷰: 해시만 보고 파일이 사라진 것을 놓치지 않게)
  for (const f of manifest.files) expect(existsSync(join(TRACES, f)), f).toBe(true);
});
