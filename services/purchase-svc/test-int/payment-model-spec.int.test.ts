// 결제 모델 기반 시험의 명세 쪽(wbs 2.7.6, docs/verification.md §2.4, V-T40, BUILD_ORDER PRF-210): 컨테이너 없이 도는 셋.
// 명령 이름 목록과 명령 모음의 열쇠, 재생 기록이 지금 명세로 만든 것인지, 기록이 결제 흐름의 동작에 모두 닿는지, 명세 옮김(payment-model/spec.ts)이
// 기록의 걸음마다 기록의 다음 상태와 같은지. 운영 코드에 다시 돌리는 재생(V-T40 ③)과 무작위 실행은 payment-model.int.test.ts다.
// 이 파일의 시험은 운영 코드에 재생하지 않으므로 V-T40 ③을 달지 않는다(장부가 ③을 단 시험 하나로 ③을 통과로 센다, 코드 리뷰 H6).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { SPEC_ACTIONS } from './payment-model/actions.js';
import { COMMANDS } from './payment-model/commands.js';
import { moveOf, readTrace, replay, scopeOf, SpecOnly } from './payment-model/itf.js';
import { enabled, initState, invariantViolations } from './payment-model/spec.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SPEC_FILE = resolve(HERE, '..', '..', '..', 'specs', 'payment.qnt');
const TRACES = join(HERE, 'payment-model', 'traces');
const specText = readFileSync(SPEC_FILE, 'utf8');
const manifest = JSON.parse(readFileSync(join(TRACES, 'manifest.json'), 'utf8')) as { specSha256: string; files: string[] };
/** 정본 모듈에서 고를 수 없는 동작(까닭): 기록에 나오지 않아도 된다 */
const NOT_IN_CANON: Partial<Record<(typeof SPEC_ACTIONS)[number], string>> = { webhook: '정본 모듈은 WEBHOOK_QUERY를 켜 웹훅 걸음이 막힌다(웹훅은 조회를 부르는 신호라 query가 덮는다, 집중 시험이 본다)' };

test('V-T40 ② 명령 모음의 열쇠가 명령 이름(SPEC_ACTIONS)과 같다(31개)', () => {
  expect(Object.keys(COMMANDS).sort()).toEqual([...SPEC_ACTIONS].sort());
  expect(SPEC_ACTIONS).toHaveLength(31);
});

test('V-T40 재생 기록이 지금 명세로 만든 것이다(아니면 node tools/spec-check/run-local.mjs traces --spec payment)', () => {
  expect(manifest.specSha256).toBe(createHash('sha256').update(readFileSync(SPEC_FILE)).digest('hex'));
  expect(manifest.files).toHaveLength(19);
  for (const f of manifest.files) expect(existsSync(join(TRACES, f)), f).toBe(true);
});

test('V-T40 정본 모듈만 재생 범위로 받고, 설계 장치를 끈 변형 모듈은 던진다', () => {
  expect(scopeOf(specText, 'payment_proposed')).toEqual({ orders: [1, 2], maxAttempts: 1, maxSwitches: 1, maxTimeouts: 1, maxRestarts: 1, maxWebhooks: 0, eventCancel: true, ticketBreak: true, issueFence: true });
  expect(scopeOf(specText, 'payment_proposed_attempts')).toMatchObject({ orders: [1], maxAttempts: 2 });
  for (const m of ['payment_no_pin', 'payment_double', 'payment_assume', 'payment_trust_webhook', 'payment_backward', 'payment_unconditional_ack']) expect(() => scopeOf(specText, m), m).toThrow(/재생하지 않는다/);
});

test.each(manifest.files)('V-T40 명세 옮김 %s: 걸음마다 spec.ts의 다음 상태가 기록의 다음 상태와 같고 불변식이 지켜진다', async (file) => {
  const { module, steps } = readTrace(join(TRACES, file));
  const sc = scopeOf(specText, module);
  expect(steps[0]!.state).toEqual(initState(sc));
  const t = new SpecOnly(sc, steps[0]!.state);
  const out = await replay(sc, t, steps);
  expect(out).toEqual({ steps: steps.length - 1, replayed: steps.length - 1, mismatch: null, known: null });
  for (const s of steps) expect(invariantViolations(sc, s.state)).toEqual([]);
});

test('V-T40 명세 옮김: 기록의 걸음마다 그 동작이 앞 상태에서 할 수 있는 동작이다', () => {
  for (const file of manifest.files) {
    const { module, steps } = readTrace(join(TRACES, file));
    const sc = scopeOf(specText, module);
    for (let i = 1; i < steps.length; i++) {
      const name = steps[i]!.action;
      if (!(SPEC_ACTIONS as readonly string[]).includes(name)) continue;
      expect(enabled(sc, steps[i - 1]!.state, { a: name as never, ...steps[i]!.picks }), `${file} 걸음 ${i} ${name}`).toBe(true);
    }
  }
});

test('V-T40 재생 기록이 정본 모듈이 고를 수 있는 동작마다, 그리고 승인 기한 갈래(T8·T11)에 1번 이상 닿는다(뺀 동작은 까닭과 함께, 코드 리뷰 H2)', () => {
  const counts = Object.fromEntries(SPEC_ACTIONS.map((a) => [a, 0])) as Record<string, number>;
  const late = { reserve: 0, command: 0 };
  for (const file of manifest.files) {
    const { module, steps } = readTrace(join(TRACES, file));
    const sc = scopeOf(specText, module);
    for (let i = 1; i < steps.length; i++) {
      const m = moveOf(sc, steps, i);
      counts[m.a]! += 1;
      // 승인 기한 갈래(판매 예약 T8 EXPIRED, 승인 명령 T11)
      if ((m.a === 'reserve' || m.a === 'command') && steps[i - 1]!.state.late[m.o!]) late[m.a] += 1;
    }
  }
  console.info(`기록의 동작별 수: ${JSON.stringify(counts)}, 기한 갈래: ${JSON.stringify(late)}`);
  expect(late.reserve).toBeGreaterThan(0);
  expect(late.command).toBeGreaterThan(0);
  const missing = SPEC_ACTIONS.filter((a) => counts[a] === 0 && NOT_IN_CANON[a] === undefined);
  expect(missing).toEqual([]);
  for (const a of Object.keys(NOT_IN_CANON)) expect(counts[a], a).toBe(0);
});
