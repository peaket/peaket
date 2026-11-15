// R-622 독립 회귀 시험: M5-01 jkt 지문과 M5-09 버전 벡터 계약.
// 이 두 항목은 R-596이 시험만 보강한 항목이라 수정 전 소스에서도 통과한다.
// 대신 감사 변이(jkt 키 순서 변경, FIELDS에서 flagSeq 제거)에서 실패하는 것을 확인했다(보고서 R-622).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateJwkThumbprint } from 'jose';
import { jktOf } from '../src/api/dpop.ts';
import type { ScannerVersionVector } from '../src/api/client.ts';
import { compareVersionVectors, needsResync } from '../src/storage/version-vector.ts';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const HOUR = 60 * 60_000;

const vector = (over: Partial<ScannerVersionVector> = {}): ScannerVersionVector => ({
  eventId: 'ev-1',
  seq: 10,
  ticketSeq: 4,
  keySeq: 5,
  policySeq: 1,
  placementSeq: 2,
  flagSeq: 3,
  issuedAt: new Date(NOW).toISOString(),
  maxOfflineMs: 24 * HOUR,
  ...over,
});

test('R-622 M5-01 jkt는 RFC 7638 필수 멤버만 쓰고 여분 멤버·개인키에 흔들리지 않는다', async () => {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
    y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  };
  const expected = 'oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U';
  assert.equal(await jktOf(jwk), expected);
  assert.equal(await calculateJwkThumbprint(jwk as never, 'sha256'), expected);
  assert.equal(await jktOf({ ...jwk, kid: 'device-1', use: 'sig', alg: 'ES256', key_ops: ['verify'] }), expected);
  assert.equal(await jktOf({ ...jwk, d: 'private' }), expected);
  await assert.rejects(jktOf({ kty: 'RSA', n: 'x', e: 'AQAB' } as JsonWebKey), /EC P-256/);
  await assert.rejects(jktOf({ kty: 'EC', crv: 'P-384', x: 'x', y: 'y' }), /EC P-256/);
});

test('R-622 M5-09 버전 벡터는 여섯 칸 모두 비교하고 flagSeq만 달라도 재동기화를 가른다', () => {
  const base = vector();
  for (const field of ['seq', 'ticketSeq', 'keySeq', 'policySeq', 'placementSeq', 'flagSeq'] as const) {
    const ahead = { ...base, [field]: base[field] + 1 };
    assert.equal(compareVersionVectors(ahead, base), 'ahead', `${field} ahead`);
    assert.equal(needsResync(base, ahead, NOW, NOW), false, `${field} ahead resync`);
    const behind = { ...base, [field]: base[field] - 1 };
    assert.equal(compareVersionVectors(behind, base), 'behind', `${field} behind`);
    assert.equal(needsResync(base, behind, NOW, NOW), true, `${field} behind resync`);
  }
  const diverged = { ...base, flagSeq: base.flagSeq + 1, ticketSeq: base.ticketSeq - 1 };
  assert.equal(compareVersionVectors(diverged, base), 'diverged');
  assert.equal(needsResync(base, diverged, NOW, NOW), true);
});
