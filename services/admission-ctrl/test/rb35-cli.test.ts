// RB-35 CLI `peaket-runbook draft → sign → run`(ADR-0062 결정 26, ADR-0239 결정 6·8, Q-T27의 CLI 몫).
import { sign as ecSign } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { drandRoundAfter, drandRoundTimeMs } from '@peaket/shuffle';
import { beforeEach, describe, expect, test } from 'vitest';
import type { KMSClient } from '@aws-sdk/client-kms';
import { bundleBytes, kmsRunbookSigner, MemoryRb35Store, RECOMMIT_MIN_LEAD_MS, runRunbookCli, type RunbookDeps, type SignedBundle } from '../src/modules/rb35/index.js';
import { keysOf, NOW, operator } from './rb35-support.js';

const E = 'evt-cli';
const a = operator('commander-a');
const b = operator('commander-b');
const c = operator('operator-c', 'operator');
const STOP = `${NOW - 1_000}:beacon`;
const COMMIT = 'a'.repeat(64);
const OPENS = NOW - 60_000;

function setup() {
  const clock = fakeClock({ now: NOW });
  const store = new MemoryRb35Store(clock);
  store.setForTest(E, 'lobby', { stop: STOP, commit: COMMIT, round: 8_000_000, published: false });
  store.setSchedule(E, { startsAtMs: NOW + 5 * 86_400_000, opensAtMs: OPENS });
  const files = new Map<string, string>();
  const out: string[] = [];
  const signers: string[] = [];
  const deps: RunbookDeps = {
    store,
    clock,
    keys: keysOf(a, b, c),
    readFile: (p) => {
      const s = files.get(p);
      if (s === undefined) throw new Error('없는 파일');
      return s;
    },
    writeFile: (p, s) => void files.set(p, s),
    print: (l) => out.push(l),
    kmsSign: async (keyId, msg) => {
      signers.push(keyId);
      const op = keyId === 'key-a' ? a : keyId === 'key-b' ? b : c;
      return ecSign('sha256', msg, { key: op.privateKey, dsaEncoding: 'der' });
    },
    newCommandId: () => '01957f5a-0000-7000-8000-00000000abcd',
    waitResultMs: 0,
  };
  return { clock, store, files, out, signers, deps };
}

const read = (files: Map<string, string>, p: string) => JSON.parse(files.get(p)!) as SignedBundle;

let w: ReturnType<typeof setup>;
beforeEach(() => {
  w = setup();
});

describe('peaket-runbook', () => {
  test('Q-T27 draft는 지금 상태에 묶인 서명 전 묶음을 쓴다(유효 5분)', async () => {
    expect(await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', E, '--param', 'group=lobby', '--reason', '중계 전부 무응답', '--out', 'f.json'], w.deps)).toBe(0);
    const s = read(w.files, 'f.json');
    expect(s.signatures).toEqual([]);
    expect(s.bundle).toMatchObject({ v: 1, commandId: '01957f5a-0000-7000-8000-00000000abcd', command: 'rb35.emergency-shuffle', target: { eventId: E, group: 'lobby' }, issuedAt: NOW, expiresAt: NOW + 300_000, params: { reason: '중계 전부 무응답', stop: STOP, commit: COMMIT, round: 8_000_000 } });
  });

  test('Q-T27 --command-id를 주면 그 값을 쓴다(전파 실패 뒤 같은 ID로 다시)', async () => {
    const id = '01957f5a-0000-7000-8000-00000000beef';
    expect(await runRunbookCli(['draft', 'rb35.wait', '--event', E, '--param', 'group=lobby', '--param', 'extendSec=120', '--reason', '더 기다린다', '--command-id', id, '--out', 'f.json'], w.deps)).toBe(0);
    expect(read(w.files, 'f.json').bundle).toMatchObject({ commandId: id, params: { extendSec: 120 } });
  });

  test('Q-T27 draft: 공시 기록이 없으면 만들지 않는다', async () => {
    expect(await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', 'evt-none', '--param', 'group=lobby', '--reason', 'x', '--out', 'f.json'], w.deps)).toBe(2);
    expect(w.files.has('f.json')).toBe(false);
  });

  test.each([
    ['알 수 없는 명령', ['draft', 'rb35.nope', '--event', E, '--param', 'group=lobby', '--reason', 'x', '--out', 'f']],
    ['구간 없음', ['draft', 'rb35.wait', '--event', E, '--reason', 'x', '--out', 'f']],
    ['구간 모양 틀림', ['draft', 'rb35.wait', '--event', E, '--param', 'group=2', '--param', 'extendSec=120', '--reason', 'x', '--out', 'f']],
    ['사유 없음', ['draft', 'rb35.wait', '--event', E, '--param', 'group=lobby', '--param', 'extendSec=120', '--out', 'f']],
    ['회차 ID 모양 틀림', ['draft', 'rb35.wait', '--event', 'a/b', '--param', 'group=lobby', '--param', 'extendSec=120', '--reason', 'x', '--out', 'f']],
    ['extendSec 없음', ['draft', 'rb35.wait', '--event', E, '--param', 'group=lobby', '--reason', 'x', '--out', 'f']],
  ])('Q-T27 draft: %s면 만들지 않는다', async (_n, args) => {
    expect(await runRunbookCli(args, w.deps)).toBe(2);
  });

  test('Q-T27 recommit draft는 공시 뒤 만료 + 30초 이후의 첫 라운드를 고른다', async () => {
    const opens = NOW + 3_600_000;
    w.store.setForTest(E, 'lobby', { stop: null, commit: COMMIT, round: 8_000_000, published: false });
    w.store.setSchedule(E, { startsAtMs: NOW + 5 * 86_400_000, opensAtMs: opens });
    expect(await runRunbookCli(['draft', 'rb35.recommit', '--event', E, '--param', 'group=lobby', '--reason', '오픈 변경', '--out', 'f'], w.deps)).toBe(0);
    const r = read(w.files, 'f').bundle.params.newRound!;
    expect(r).toBe(Math.max(drandRoundAfter(opens), drandRoundAfter(NOW + 300_000, RECOMMIT_MIN_LEAD_MS)));
    expect(drandRoundTimeMs(r)).toBeGreaterThanOrEqual(NOW + 300_000 + RECOMMIT_MIN_LEAD_MS);
  });

  test('[ASVS v5.0.0-11.6.1] Q-T27 sign은 KMS로 정규화한 바이트에 서명하고 파일에 더한다', async () => {
    await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', E, '--param', 'group=lobby', '--reason', 'x', '--out', 'f'], w.deps);
    expect(await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-a', '--key', 'key-a'], w.deps)).toBe(0);
    expect(await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-b', '--key', 'key-b'], w.deps)).toBe(0);
    const s = read(w.files, 'f');
    expect(s.signatures.map((x) => x.signer)).toEqual(['commander-a', 'commander-b']);
    expect(w.signers).toEqual(['key-a', 'key-b']);
    expect(bundleBytes(s.bundle).length).toBeGreaterThan(0);
  });

  test('Q-T27 sign은 서명 전에 명령·구간·사유·라운드를 보여 준다', async () => {
    await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', E, '--param', 'group=lobby', '--reason', '중계 전부 무응답', '--out', 'f'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-a', '--key', 'key-a'], w.deps);
    const shown = w.out.join('\n');
    for (const part of ['rb35.emergency-shuffle', E, 'lobby', '중계 전부 무응답', '8000000', STOP]) expect(shown).toContain(part);
  });

  test('[ASVS v5.0.0-11.6.1] Q-T27 실제 KMS 서명 어댑터는 SignCommand를 RAW·ECDSA_SHA_256으로 만든다', async () => {
    const seen: { name: string; input: Record<string, unknown> }[] = [];
    const client = { send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => (seen.push({ name: c.constructor.name, input: c.input }), { Signature: Buffer.from('sig') }) } as unknown as KMSClient;
    const sig = await kmsRunbookSigner(client)('key-a', Buffer.from('payload'));
    expect(sig).toEqual(Buffer.from('sig'));
    expect(seen).toEqual([{ name: 'SignCommand', input: { KeyId: 'key-a', Message: Buffer.from('payload'), MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' } }]);
    const empty = { send: async () => ({}) } as unknown as KMSClient;
    await expect(kmsRunbookSigner(empty)('key-a', Buffer.from('payload'))).rejects.toThrow();
  });

  test('Q-T27 같은 서명자가 다시 서명하면 앞 서명을 바꾼다', async () => {
    await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', E, '--param', 'group=lobby', '--reason', 'x', '--out', 'f'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-a', '--key', 'key-a'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-a', '--key', 'key-a'], w.deps);
    expect(read(w.files, 'f').signatures).toHaveLength(1);
  });

  test('Q-T27 run은 서명 하나면 넣지 않는다', async () => {
    await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', E, '--param', 'group=lobby', '--reason', 'x', '--out', 'f'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-a', '--key', 'key-a'], w.deps);
    expect(await runRunbookCli(['run', '--in', 'f'], w.deps)).toBe(3);
    expect(w.store.pendingOf(E, 'lobby')).toBeUndefined();
    expect(w.out.join('\n')).toContain('two_commanders');
  });

  test('Q-T27 run: commander가 아닌 서명이 섞이면 넣지 않는다', async () => {
    await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', E, '--param', 'group=lobby', '--reason', 'x', '--out', 'f'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-a', '--key', 'key-a'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'operator-c', '--key', 'key-c'], w.deps);
    expect(await runRunbookCli(['run', '--in', 'f'], w.deps)).toBe(3);
    expect(w.out.join('\n')).toContain('not_commander');
  });

  test('Q-T27 run은 전달만 하고 결과를 기다려 알린다', async () => {
    await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', E, '--param', 'group=lobby', '--reason', 'x', '--out', 'f'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-a', '--key', 'key-a'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-b', '--key', 'key-b'], w.deps);
    // 받는 쪽(리더)이 답하기 전이면 상태를 알 수 없다
    expect(await runRunbookCli(['run', '--in', 'f'], w.deps)).toBe(4);
    expect(w.store.pendingOf(E, 'lobby')).toBeDefined();
    // 받는 쪽이 적용한 뒤 다시 부르면 그 결과를 돌려주고 다시 넣지 않는다
    w.store.markResultForTest(E, '01957f5a-0000-7000-8000-00000000abcd', 'applied');
    expect(await runRunbookCli(['run', '--in', 'f'], w.deps)).toBe(0);
    expect(w.out.join('\n')).toContain('applied');
  });

  test('Q-T27 받는 쪽이 거절하면 실패로 끝낸다', async () => {
    await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', E, '--param', 'group=lobby', '--reason', 'x', '--out', 'f'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-a', '--key', 'key-a'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-b', '--key', 'key-b'], w.deps);
    w.store.markResultForTest(E, '01957f5a-0000-7000-8000-00000000abcd', 'rejected:stale_state');
    expect(await runRunbookCli(['run', '--in', 'f'], w.deps)).toBe(5);
    expect(w.out.join('\n')).toContain('stale_state');
  });

  test('Q-T27 run: 서명이 만료된 묶음은 넣지 않는다', async () => {
    await runRunbookCli(['draft', 'rb35.emergency-shuffle', '--event', E, '--param', 'group=lobby', '--reason', 'x', '--out', 'f'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-a', '--key', 'key-a'], w.deps);
    await runRunbookCli(['sign', '--in', 'f', '--signer', 'commander-b', '--key', 'key-b'], w.deps);
    w.clock.advance(300_001);
    expect(await runRunbookCli(['run', '--in', 'f'], w.deps)).toBe(3);
  });

  test('모르는 하위 명령은 사용법 안내로 끝낸다', async () => {
    expect(await runRunbookCli(['nope'], w.deps)).toBe(2);
  });
});
