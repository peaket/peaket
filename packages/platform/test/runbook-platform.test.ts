// F-02-7 IR027-04·09: platform의 실제 재생 가드·정규화 기준 벡터·prod 키 검사를 직접 시험한다.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { canonicalizeRunbook, MemoryRunbookReplayGuard, parseRunbookControl, runbookGateConfigFromProcess, runbookOperatorKeysFromEnv } from '../src/index.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const key = (id: string, role: 'commander' | 'operator') => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { id, operatorId: id, role, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
};
const two = JSON.stringify([key('commander-a', 'commander'), key('commander-b', 'commander'), key('operator-c', 'operator')]);

describe('F-02-7 platform 런북', () => {
  test('IR027-09 정규화 기준 벡터·재생 가드·prod 키 검사를 직접 본다', () => {
    // RFC 8785 §3.2.3의 비ASCII 키·이스케이프·-0
    expect(
      canonicalizeRunbook({
        '\u20ac': 'Euro Sign',
        '\r': 'Carriage Return',
        '\ufb33': 'Hebrew Letter Dalet With Dagesh',
        '1': 'One',
        '\ud83d\ude00': 'Emoji: Grinning Face',
        '\u0080': 'Control',
        '\u00f6': 'Latin Small Letter O With Diaeresis',
      }),
    ).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
    expect(canonicalizeRunbook({ n: -0 })).toBe('{"n":0}');
    expect(() => canonicalizeRunbook({ n: 2 ** 53 })).toThrow();

    const bundle = { v: 1, commandId: '0193a000-0000-7000-9000-00000000b001', kind: 'CONTROL_KIND_SALE_PAUSE', scope: 'PLATFORM', version: NOW, reason: '시험', issuedAt: NOW, expiresAt: NOW + 300_000, requests: { 'purchase-svc': { paused: true } } };
    const bytes = Buffer.from(canonicalizeRunbook(bundle));
    expect(parseRunbookControl(bytes).ok).toBe(true);
    expect(parseRunbookControl(Buffer.from(JSON.stringify(bundle, null, 2)))).toEqual({ ok: false, reason: 'not-canonical' });
    expect(parseRunbookControl(Buffer.from(canonicalizeRunbook({ ...bundle, extra: 1 })))).toEqual({ ok: false, reason: 'bundle-malformed' });

    const guard = new MemoryRunbookReplayGuard();
    expect(guard.begin('a', 'd1', NOW + 300_000, NOW)).toBe('reserved');
    expect(guard.begin('a', 'd1', NOW + 300_000, NOW)).toBe('in-flight');
    guard.commit('a');
    expect(guard.begin('a', 'd1', NOW + 300_000, NOW)).toBe('replayed');
    expect(guard.begin('a', 'd2', NOW + 300_000, NOW)).toBe('conflict');
    expect(guard.begin('b', 'd1', NOW + 300_000, NOW)).toBe('reserved');
    guard.abort('b');
    expect(guard.begin('b', 'd1', NOW + 300_000, NOW)).toBe('reserved');
    expect(guard.begin('c', 'd1', NOW + 300_000, NOW + 600_000 + 1)).toBe('reserved');

    expect(() => runbookGateConfigFromProcess({ PEAKET_ENV: 'prod' }, 'purchase-svc')).toThrow();
    expect(() => runbookGateConfigFromProcess({ PEAKET_ENV: 'prod', PEAKET_RUNBOOK_COMMANDER_KEYS: JSON.stringify([key('commander-a', 'commander'), key('operator-c', 'operator')]) }, 'purchase-svc')).toThrow();
    expect(runbookGateConfigFromProcess({ PEAKET_ENV: 'prod', PEAKET_RUNBOOK_COMMANDER_KEYS: two }, 'purchase-svc').keys?.size).toBe(3);
    expect(runbookGateConfigFromProcess({ PEAKET_ENV: 'local' }, 'purchase-svc').keys).toBeUndefined();
    expect(runbookOperatorKeysFromEnv(two).get('commander-a')?.role).toBe('commander');
  });
});
