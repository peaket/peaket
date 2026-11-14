// DPoP proof shape and device-key thumbprint (GAT-170).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base64urlOfText, dpopProof, generateDpopKey, jktOf } from '../src/api/dpop.ts';

const decode = (part: string): Record<string, unknown> => {
  const pad = part.length % 4 === 0 ? '' : '='.repeat(4 - (part.length % 4));
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8')) as Record<string, unknown>;
};

test('기기 키 jkt는 RFC 7638 EC P-256 지문 43자다', async () => {
  const key = await generateDpopKey();
  assert.match(key.jkt, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await jktOf(key.publicJwk), key.jkt);
  assert.equal(key.publicJwk.kty, 'EC');
  assert.equal(key.publicJwk.crv, 'P-256');
  assert.equal(key.publicJwk.d, undefined);
});

test('DPoP 증명은 typ·jwk·jti·htm·htu·iat를 담고, 토큰이 있으면 ath를 담는다', async () => {
  const key = await generateDpopKey();
  const proof = await dpopProof({ key, method: 'GET', url: 'https://scanner-api.peaket.example/v1/scanner/shift?after=1', token: 'staff-token', nowMs: Date.parse('2026-11-15T00:00:00Z'), jti: 'jti-1' });
  const [h, p, s] = proof.split('.');
  assert.ok(h && p && s);
  assert.deepEqual(decode(h), { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk });
  const payload = decode(p);
  assert.equal(payload.jti, 'jti-1');
  assert.equal(payload.htm, 'GET');
  assert.equal(payload.htu, 'https://scanner-api.peaket.example/v1/scanner/shift');
  assert.equal(payload.iat, Math.floor(Date.parse('2026-11-15T00:00:00Z') / 1000));
  assert.match(String(payload.ath), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(payload.ath, base64urlOfText('staff-token'));
});
