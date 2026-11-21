// 감사 공개 체크포인트의 바이트 꼴 시험(BAT-360 OPS-280, ADR-0348 결정 2·3·4, ADR-0075 결정 2·3, RFC 9162 §2.1, RFC 8785).
// 기대값은 이 시험이 정본 식으로 따로 만든다(제품 merkle.ts·checkpoint-json.ts의 함수로 기대값을 만들지 않는다):
//   잎 입력 = ASCII 'PEAKET-audit-leaf-v1'(20바이트) ‖ seq(u64 BE) ‖ 기록 해시 32바이트 ‖ 잎 솔트 32바이트, 잎 = SHA-256(0x00 ‖ 잎 입력), 노드 = SHA-256(0x01 ‖ 왼 ‖ 오),
//   나누는 자리 k = n보다 작은 가장 큰 2의 거듭제곱(RFC 9162 §2.1.1). 체크포인트 JSON은 RFC 8785(키는 UTF-16 차례, 공백 없음, 없는 칸은 뺀다).
// 서명은 SHA-256(체크포인트 JSON 바이트) 위 ECDSA P-256(DER base64)이고, KMS는 MessageType DIGEST·ECDSA_SHA_256로 그 다이제스트를 받는다(결정 4).
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  CHECKPOINT_SIGNATURE_ALG,
  KmsCheckpointSigner,
  LocalCheckpointSigner,
  buildPublicCheckpoint,
  canonicalCheckpointJson,
  checkpointHashOf,
  checkpointSignerFromEnv,
  ephemeralCheckpointSigner,
  inclusionProof,
  leafHash,
  leafInput,
  merkleTreeHash,
  verifyCheckpointSignature,
  verifyInclusion,
  type AuditChainEntry,
  type CheckpointSignClient,
} from '../src/modules/audit/index.js';

// ---- 정본 식으로 따로 만든 기대값 ----
const sha = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const DOMAIN = Buffer.from('PEAKET-audit-leaf-v1', 'ascii');
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const expectedLeafInput = (seq: number, recordHash: Buffer, salt: Buffer): Buffer => Buffer.concat([DOMAIN, u64(seq), recordHash, salt]);
const expectedLeaf = (input: Buffer): Buffer => sha(Buffer.from([0x00]), input);
const expectedNode = (l: Buffer, r: Buffer): Buffer => sha(Buffer.from([0x01]), l, r);
/** RFC 9162 §2.1.1 MTH(D[n]) — 잎 해시 목록에서 */
const mth = (leaves: readonly Buffer[]): Buffer => {
  if (leaves.length === 1) return leaves[0]!;
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return expectedNode(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
};

/** 시험 기록 n개: seq는 fromSeq부터, 기록 해시·솔트는 시험이 만든 난수 */
const records = (n: number, fromSeq = 7) =>
  Array.from({ length: n }, (_, i) => ({ seq: fromSeq + i, hash: randomBytes(32), salt: randomBytes(32) }));
const entriesOf = (rs: ReturnType<typeof records>): AuditChainEntry[] => rs.map((r) => ({ seq: r.seq, hash: r.hash.toString('hex'), leafSalt: r.salt.toString('hex') }));

describe('B1 잎·루트(ADR-0348 결정 2, RFC 9162)', () => {
  test('[ASVS v5.0.0-11.4.3] 잎 입력은 도메인 글 20바이트 ‖ seq u64 BE ‖ 기록 해시 ‖ 솔트(20 + 8 + 32 + 32 = 92바이트)이고 잎은 0x00, 노드는 0x01 접두다', () => {
    const r = records(1, 0x0102030405)[0]!;
    const got = leafInput(r.seq, r.hash.toString('hex'), r.salt.toString('hex'));
    expect(got.length).toBe(92);
    expect(got.equals(expectedLeafInput(r.seq, r.hash, r.salt))).toBe(true);
    // seq 8바이트가 big-endian인지 바이트로 본다(0x0102030405 → 00 00 00 01 02 03 04 05)
    expect(got.subarray(20, 28).toString('hex')).toBe('0000000102030405');
    expect(leafHash(got).equals(expectedLeaf(got))).toBe(true);
    // 접두를 바꾼 값과는 다르다(잎과 노드를 섞지 않는다)
    expect(leafHash(got).equals(sha(got))).toBe(false);
    expect(leafHash(got).equals(sha(Buffer.from([0x01]), got))).toBe(false);
  });

  test.each([1, 2, 3, 5, 8])('B1 기록 %i개의 머클 루트가 정본 식으로 따로 계산한 값과 같다(공개 체크포인트 루트 포함)', (n) => {
    const rs = records(n);
    const expected = mth(rs.map((r) => expectedLeaf(expectedLeafInput(r.seq, r.hash, r.salt))));
    expect(merkleTreeHash(rs.map((r) => leafInput(r.seq, r.hash, r.salt))).equals(expected)).toBe(true);
    const built = buildPublicCheckpoint(entriesOf(rs), { no: 2, fromSeq: rs[0]!.seq, toSeq: rs[n - 1]!.seq, prevCheckpointHash: 'a1'.repeat(32), createdAtMs: Date.parse('2026-11-23T15:10:00.004Z') });
    expect(built.rootHash).toBe(expected.toString('hex'));
    expect(built.leafCount).toBe(n);
    // 솔트를 뺀 잎(M5)이나 노드 접두 0x00(M6)으로는 같은 루트가 나오지 않는다
    const noSalt = mth(rs.map((r) => expectedLeaf(Buffer.concat([DOMAIN, u64(r.seq), r.hash]))));
    expect(built.rootHash).not.toBe(noSalt.toString('hex'));
    if (n > 1) {
      const wrongNode = (leaves: readonly Buffer[]): Buffer => {
        if (leaves.length === 1) return leaves[0]!;
        let k = 1;
        while (k * 2 < leaves.length) k *= 2;
        return sha(Buffer.from([0x00]), wrongNode(leaves.slice(0, k)), wrongNode(leaves.slice(k)));
      };
      expect(built.rootHash).not.toBe(wrongNode(rs.map((r) => expectedLeaf(expectedLeafInput(r.seq, r.hash, r.salt)))).toString('hex'));
    }
  });

  test.each([1, 2, 3, 5, 8])('B1 기록 %i개의 잎마다 포함 증명이 루트로 이어지고, 한 바이트 바꾼 잎·경로·다른 번호는 거절된다(RFC 9162 §2.1.3)', (n) => {
    const rs = records(n);
    const inputs = rs.map((r) => expectedLeafInput(r.seq, r.hash, r.salt));
    const root = mth(inputs.map(expectedLeaf));
    for (let m = 0; m < n; m += 1) {
      const path = inclusionProof(inputs, m);
      // 증명 길이는 RFC 9162 PATH의 깊이(n=1이면 빈 목록)
      if (n === 1) expect(path).toEqual([]);
      expect(verifyInclusion(m, n, expectedLeaf(inputs[m]!), path, root)).toBe(true);
      const badLeaf = Buffer.from(expectedLeaf(inputs[m]!));
      badLeaf[0] = badLeaf[0]! ^ 1;
      expect(verifyInclusion(m, n, badLeaf, path, root)).toBe(false);
      if (path.length > 0) {
        const badPath = path.map((p) => Buffer.from(p));
        badPath[0]![31] = badPath[0]![31]! ^ 0x80;
        expect(verifyInclusion(m, n, expectedLeaf(inputs[m]!), badPath, root)).toBe(false);
        expect(verifyInclusion((m + 1) % n, n, expectedLeaf(inputs[m]!), path, root)).toBe(false);
      }
    }
  });

  test('B1 잎 솔트나 기록 해시가 없는 구간(파기 뒤)은 공개 체크포인트를 만들지 않는다(409 audit-chain-broken)', () => {
    const rs = entriesOf(records(3));
    const noSalt = rs.map((e, i) => (i === 1 ? { seq: e.seq, hash: e.hash } : e));
    expect(() => buildPublicCheckpoint(noSalt, { no: 1, fromSeq: 7, toSeq: 9, prevCheckpointHash: '', createdAtMs: 1 })).toThrow(expect.objectContaining({ status: 409 }));
    // 구간에 빈틈(seq 8 빠짐)이 있어도 만들지 않는다
    expect(() => buildPublicCheckpoint([rs[0]!, rs[2]!], { no: 1, fromSeq: 7, toSeq: 9, prevCheckpointHash: '', createdAtMs: 1 })).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe('B2 체크포인트 JSON(ADR-0348 결정 3, ADR-0075 결정 3, RFC 8785)', () => {
  const ROOT = '0f'.repeat(32);
  const PREV = 'c3'.repeat(32);
  const DAY = '5a'.repeat(32);
  const AT = Date.parse('2026-11-23T15:10:00.040Z');

  test('[ASVS v5.0.0-11.2.1] 일 체크포인트 JSON 바이트가 RFC 8785 꼴(키 UTF-16 차례·공백 없음·밀리초 Z)과 글자까지 같고 해시는 그 SHA-256이다', () => {
    const json = canonicalCheckpointJson({ no: 3, firstSeq: 41, lastSeq: 45, leafCount: 5, merkleRoot: ROOT, prevCheckpointHash: PREV, accessLogDayAnchor: DAY, createdAtMs: AT });
    expect(json).toBe(
      `{"accessLogDayAnchor":"${DAY}","createdAt":"2026-11-23T15:10:00.040Z","firstSeq":41,"lastSeq":45,"leafCount":5,"merkleRoot":"${ROOT}","no":3,"prevCheckpointHash":"${PREV}","v":"PEAKET-checkpoint-v1"}`,
    );
    expect(checkpointHashOf(json)).toBe(sha(Buffer.from(json, 'utf8')).toString('hex'));
  });

  test('B2 첫 체크포인트의 직전 해시는 빈 글이고 해당 없는 칸(일 앵커·끝난 회차)은 빠진다, 회차 마감은 closedEvents만 싣는다', () => {
    const first = canonicalCheckpointJson({ no: 1, firstSeq: 1, lastSeq: 2, leafCount: 2, merkleRoot: ROOT, prevCheckpointHash: '', createdAtMs: AT });
    expect(first).toBe(`{"createdAt":"2026-11-23T15:10:00.040Z","firstSeq":1,"lastSeq":2,"leafCount":2,"merkleRoot":"${ROOT}","no":1,"prevCheckpointHash":"","v":"PEAKET-checkpoint-v1"}`);
    const e1 = '0193c000-0000-7000-8000-00000000000a';
    const e2 = '0193c000-0000-7000-8000-00000000000b';
    const close = canonicalCheckpointJson({ no: 4, firstSeq: 46, lastSeq: 46, leafCount: 1, merkleRoot: ROOT, prevCheckpointHash: PREV, closedEvents: [e1, e2], createdAtMs: AT });
    expect(close).toBe(`{"closedEvents":["${e1}","${e2}"],"createdAt":"2026-11-23T15:10:00.040Z","firstSeq":46,"lastSeq":46,"leafCount":1,"merkleRoot":"${ROOT}","no":4,"prevCheckpointHash":"${PREV}","v":"PEAKET-checkpoint-v1"}`);
  });

  test('B2 번호·구간·건수·해시 꼴이 틀린 체크포인트는 만들지 않는다(첫 번째에 직전 해시, 둘째부터 빈 직전 해시, 건수 ≠ 구간, 대문자 16진)', () => {
    const base = { no: 2, firstSeq: 3, lastSeq: 4, leafCount: 2, merkleRoot: ROOT, prevCheckpointHash: PREV, createdAtMs: AT };
    expect(() => canonicalCheckpointJson({ ...base, no: 1 })).toThrow();
    expect(() => canonicalCheckpointJson({ ...base, prevCheckpointHash: '' })).toThrow();
    expect(() => canonicalCheckpointJson({ ...base, leafCount: 3 })).toThrow();
    expect(() => canonicalCheckpointJson({ ...base, merkleRoot: ROOT.toUpperCase() })).toThrow();
    expect(() => canonicalCheckpointJson({ ...base, no: 0 })).toThrow();
    expect(canonicalCheckpointJson(base)).toContain('"no":2');
  });
});

describe('B4 체크포인트 서명(ADR-0348 결정 4, secrets-and-keys "감사 체크포인트 서명 키")', () => {
  const JSON_BYTES = Buffer.from('{"createdAt":"2026-11-23T15:10:00.040Z","no":9,"v":"PEAKET-checkpoint-v1"}', 'utf8');

  test('[ASVS v5.0.0-11.6.1] KMS 서명기는 SHA-256(체크포인트 JSON 바이트) 32바이트만 KMS에 보내고 받은 DER을 base64로 쓴다', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const sent: { keyId: string; digest: Buffer }[] = [];
    // KMS Sign(MessageType DIGEST, ECDSA_SHA_256)이 하는 일: 받은 다이제스트를 그대로 ECDSA로 서명한다(해시를 다시 하지 않는다)
    const client: CheckpointSignClient = {
      async signDigest(keyId, digest) {
        sent.push({ keyId, digest: Buffer.from(digest) });
        // node:crypto는 미리 만든 다이제스트를 ECDSA로 바로 서명하지 못한다: 이 시험의 메시지 다이제스트일 때만 그 메시지를 SHA-256 위로 서명한다(같은 값)
        if (!Buffer.from(digest).equals(sha(JSON_BYTES))) throw new Error('KMS 대역: 모르는 다이제스트');
        return sign('sha256', JSON_BYTES, { key: privateKey, dsaEncoding: 'der' });
      },
      async publicKey() {
        return { spki: publicKey.export({ type: 'spki', format: 'der' }), keySpec: 'ECC_NIST_P256', keyUsage: 'SIGN_VERIFY', signingAlgorithms: ['ECDSA_SHA_256'] };
      },
    };
    const signer = new KmsCheckpointSigner(client, 'arn:aws:kms:ap-northeast-2:111122223333:key/audit-cp-test');
    const der = await signer.sign(JSON_BYTES);
    expect(sent).toEqual([{ keyId: 'arn:aws:kms:ap-northeast-2:111122223333:key/audit-cp-test', digest: sha(JSON_BYTES) }]);
    // 공개키만으로 JSON 바이트에 대해 확인된다(밖의 확인자와 같은 절차)
    expect(verify('sha256', JSON_BYTES, { key: publicKey, dsaEncoding: 'der' }, der)).toBe(true);
    expect(verifyCheckpointSignature(await signer.publicKeySpki(), JSON_BYTES, der.toString('base64'))).toBe(true);
    expect(signer.alg).toBe('ECDSA_P256_SHA256');
  });

  test('[ASVS v5.0.0-11.2.3] KMS 키 꼴이 ECC_NIST_P256·SIGN_VERIFY·ECDSA_SHA_256이 아니면 공개키를 받지 않는다', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const make = (over: Partial<Awaited<ReturnType<CheckpointSignClient['publicKey']>>>): CheckpointSignClient => ({
      signDigest: async () => Buffer.alloc(0),
      publicKey: async () => ({ spki, keySpec: 'ECC_NIST_P256', keyUsage: 'SIGN_VERIFY', signingAlgorithms: ['ECDSA_SHA_256'], ...over }),
    });
    await expect(new KmsCheckpointSigner(make({ keySpec: 'ECC_SECG_P256K1' }), 'k').publicKeySpki()).rejects.toThrow();
    await expect(new KmsCheckpointSigner(make({ keySpec: 'RSA_2048' }), 'k').publicKeySpki()).rejects.toThrow();
    await expect(new KmsCheckpointSigner(make({ keyUsage: 'ENCRYPT_DECRYPT' }), 'k').publicKeySpki()).rejects.toThrow();
    await expect(new KmsCheckpointSigner(make({ signingAlgorithms: ['ECDSA_SHA_384'] }), 'k').publicKeySpki()).rejects.toThrow();
    expect((await new KmsCheckpointSigner(make({}), 'k').publicKeySpki()).equals(spki)).toBe(true);
  });

  test('[ASVS v5.0.0-11.2.3] 공개키로 확인할 때 P-256이 아닌 키(P-384·secp256k1)와 꼴이 틀린 서명은 거짓이다', async () => {
    const signer = ephemeralCheckpointSigner('cp-bytes-test');
    const sig = (await signer.sign(JSON_BYTES)).toString('base64');
    expect(verifyCheckpointSignature(await signer.publicKeySpki(), JSON_BYTES, sig)).toBe(true);
    const flipped = Buffer.from(sig, 'base64');
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1;
    expect(verifyCheckpointSignature(await signer.publicKeySpki(), JSON_BYTES, flipped.toString('base64'))).toBe(false);
    expect(verifyCheckpointSignature(await signer.publicKeySpki(), Buffer.concat([JSON_BYTES, Buffer.from(' ')]), sig)).toBe(false);
    expect(verifyCheckpointSignature(await signer.publicKeySpki(), JSON_BYTES, `${sig}\n`)).toBe(false);
    for (const curve of ['secp384r1', 'secp256k1']) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
      const other = sign('sha256', JSON_BYTES, { key: privateKey, dsaEncoding: 'der' }).toString('base64');
      expect(verifyCheckpointSignature(publicKey.export({ type: 'spki', format: 'der' }), JSON_BYTES, other)).toBe(false);
      expect(() => new LocalCheckpointSigner(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'x')).toThrow(/P-256/);
    }
    // 로컬 서명기도 같은 알고리즘이다(서명 꼴이 KMS와 같다)
    expect(createPublicKey({ key: await signer.publicKeySpki(), format: 'der', type: 'spki' }).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(signer.alg).toBe(CHECKPOINT_SIGNATURE_ALG);
  });

  test('B4 운영(local·ci 밖)에서 KMS 키 ID가 없거나 로컬 키·흉내 끝점을 주면 작업이 시작하지 않고, local·ci는 임시 키를 경고와 함께 쓴다', () => {
    for (const envName of ['production', 'staging', 'demo']) {
      expect(() => checkpointSignerFromEnv({}, { envName })).toThrow(/PEAKET_AUDIT_CHECKPOINT_KMS_KEY_ID/);
      const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      expect(() => checkpointSignerFromEnv({ PEAKET_AUDIT_CHECKPOINT_LOCAL_KEY: pem }, { envName })).toThrow(/PEAKET_AUDIT_CHECKPOINT_LOCAL_KEY/);
      expect(() => checkpointSignerFromEnv({ PEAKET_AUDIT_CHECKPOINT_KMS_KEY_ID: 'k', PEAKET_KMS_ENDPOINT: 'http://127.0.0.1:4566' }, { envName })).toThrow(/PEAKET_KMS_ENDPOINT/);
    }
    const kms = checkpointSignerFromEnv({ PEAKET_AUDIT_CHECKPOINT_KMS_KEY_ID: 'alias/audit-checkpoint' }, { envName: 'production', client: () => ({ signDigest: async () => Buffer.alloc(0), publicKey: async () => ({ spki: Buffer.alloc(0) }) }) });
    expect(kms.signer).toBeInstanceOf(KmsCheckpointSigner);
    expect(kms.signer.keyId).toBe('alias/audit-checkpoint');
    expect(kms.warning).toBeUndefined();
    for (const envName of ['local', 'ci']) {
      const r = checkpointSignerFromEnv({}, { envName });
      expect(r.signer).toBeInstanceOf(LocalCheckpointSigner);
      expect(r.warning).toMatch(/임시 P-256 키/);
    }
    // API 프로세스용 옛 Ed25519 키 이름은 더 이상 서명기를 만들지 않는다(결정 4: 없앰)
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => checkpointSignerFromEnv({ PEAKET_AUDIT_CHECKPOINT_LOCAL_KEY: ed }, { envName: 'ci' })).toThrow(/P-256/);
  });
});
