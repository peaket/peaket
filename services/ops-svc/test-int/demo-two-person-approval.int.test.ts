// 2인 승인 시연(데모)의 서버 몫 실제 PostgreSQL 18 통합 시험(BAT-360 OPS-290, control-tower §4 '2인 승인 시연'·§14 C-T47 ①, ADR-0095, ADR-0349 결정 11, 감독 결정 2026-11-22).
// 정본 값: 데모 환경에서 2인 명령을 요청한 뒤 요청자 본인 계정으로 승인하면 403이고, 데모 승인자 계정이 재인증하고 승인하면 명령이 전파된다.
// 감사 로그에는 두 계정이 따로 남고 데모 환경 표시(payload demo: true)가 붙는다. 서버에는 데모용 분기가 없고, 다른 환경의 기록에는 그 칸이 없다.
// 재인증은 시험용 가상 인증기(소프트웨어 패스키, WebAuthn ES256 P-256 단언)로 받는다: 시험 안의 identity 대역이 단언의 서명·챌린지·출처·RP ID·사용자 확인(UV)을
// 등록한 공개키로 확인한 뒤에만 재인증 토큰(act OPS_COMMAND, factors passkey)을 내주고, ops-svc는 제품 확인기(JwksApprovalVerifier)로 그 토큰을 본다.
// 데모 막대·데모 도우미(C-T47 ②~⑤)는 BAT-375다.
import 'reflect-metadata';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { createDatabase, createService, fakeClock, type Database } from '@peaket/platform';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { migrateOps } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { CreateCommand, DrizzleCommandStore, type CommandExecutor } from '../src/modules/commands/index.js';
import { FakeAdminIdentity, reauthKit } from '../test/admin-support.js';
import { FakeIdentity, quiet } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-26T05:00:00.000Z');
const RP_ID = 'ops.peaket.example';
const ORIGIN = `https://${RP_ID}`;
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW });
const kit = reauthKit(() => clock.now());
const executed: string[] = [];
const executor: CommandExecutor = {
  execute: async (c) => {
    executed.push(c.commandId);
    return { status: 'ACKED', ackedAtMs: clock.now() };
  },
};
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest();

/** 시험용 소프트웨어 패스키(인증기 하나 = 자격 하나). WebAuthn 단언(AuthenticationResponseJSON의 response 칸)을 만든다 */
class SoftPasskey {
  readonly #key: KeyObject;
  readonly publicKey: KeyObject;
  #count = 0;
  constructor(readonly credentialId = b64u(randomBytes(16))) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.#key = privateKey;
    this.publicKey = publicKey;
  }
  assert(challenge: string, o: { origin?: string; uv?: boolean } = {}) {
    const flags = 0x01 | (o.uv === false ? 0 : 0x04);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.#count);
    const authenticatorData = Buffer.concat([sha(Buffer.from(RP_ID)), Buffer.from([flags]), count]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha(clientDataJSON)]), { key: this.#key, dsaEncoding: 'der' });
    return { credentialId: this.credentialId, authenticatorData: b64u(authenticatorData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) };
  }
}

/** identity-svc 관리 재인증의 대역: 등록한 패스키의 단언을 확인한 뒤에만 재인증 토큰을 낸다(WebAuthn §7.2의 확인 차례) */
class DemoReauthIssuer {
  readonly #creds = new Map<string, { accountId: string; key: KeyObject }>();
  readonly #challenges = new Map<string, string>();
  register(accountId: string, passkey: SoftPasskey): void {
    this.#creds.set(passkey.credentialId, { accountId, key: passkey.publicKey });
  }
  challenge(accountId: string): string {
    const c = b64u(randomBytes(32));
    this.#challenges.set(accountId, c);
    return c;
  }
  /** 단언이 맞으면 OPS_COMMAND 재인증 토큰, 아니면 undefined */
  finish(who: Record<string, string>, a: ReturnType<SoftPasskey['assert']>): string | undefined {
    const accountId = who['x-user-id']!;
    const cred = this.#creds.get(a.credentialId);
    const expected = this.#challenges.get(accountId);
    this.#challenges.delete(accountId);
    if (!cred || cred.accountId !== accountId || !expected) return undefined;
    const client = JSON.parse(Buffer.from(a.clientDataJSON, 'base64url').toString('utf8')) as { type: string; challenge: string; origin: string };
    if (client.type !== 'webauthn.get' || client.challenge !== expected || client.origin !== ORIGIN) return undefined;
    const auth = Buffer.from(a.authenticatorData, 'base64url');
    if (!auth.subarray(0, 32).equals(sha(Buffer.from(RP_ID))) || (auth[32]! & 0x05) !== 0x05) return undefined;
    if (!verify('sha256', Buffer.concat([auth, sha(Buffer.from(a.clientDataJSON, 'base64url'))]), { key: cred.key, dsaEncoding: 'der' }, Buffer.from(a.signature, 'base64url'))) return undefined;
    return kit.token({ accountId, sessionId: who['x-session-id']!, act: 'OPS_COMMAND', factors: ['passkey'] });
  }
}

let container: PostgresContainer;
let admin: pg.Client;
let db: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const issuer = new DemoReauthIssuer();

beforeAll(async () => {
  // 데모 환경(PEAKET_ENV demo): 감사 기록은 append 때 환경 값을 읽어 표시를 붙인다(ADR-0349 결정 11)
  vi.stubEnv('PEAKET_ENV', 'demo');
  container = await startPostgres();
  await migrateOps(container.url);
  admin = new pg.Client({ connectionString: container.url });
  await admin.connect();
  db = createDatabase({ url: container.url, applicationName: 'ops-svc-demo-approval-it' });
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ database: db, executor, background: false, nowMs: NOW, adminAccounts: { identity: new FakeAdminIdentity(), reauth: kit.verifier } }),
    // 서비스 뼈대 설정은 ci로 띄운다: demo 뼈대는 운영처럼 로그 가명 키·내부 토큰·테넌트 한도 Redis가 있어야 시작하는데(플랫폼 몫, 이 시험 밖)
    // 데모 표시는 감사 기록을 쓸 때 프로세스 환경 값 PEAKET_ENV를 읽으므로(ADR-0349 결정 11) 위의 stubEnv('demo')가 정한다
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
}, 180_000);

afterAll(async () => {
  await svc?.close().catch(() => undefined);
  await db?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  container?.stop();
  vi.unstubAllEnvs();
});

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc.http.inject({ method: 'POST', url, headers: { ...headers, ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
/** 그 계정의 패스키로 재인증하고 토큰을 붙인 머리 */
const reauthed = (who: Record<string, string>, passkey: SoftPasskey, o: { origin?: string; uv?: boolean } = {}): Record<string, string> => {
  const token = issuer.finish(who, passkey.assert(issuer.challenge(who['x-user-id']!), o));
  return token ? { ...who, 'x-reauth-token': token } : who;
};
const records = async (commandId: string) =>
  (await admin.query<{ record_type: string; record_json: { payload: Record<string, unknown> } }>('select record_type, record_json from audit_chain where record_id = $1 order by seq', [commandId])).rows;

describe('C-T47 ① 2인 승인 시연(데모 환경, 서버 몫)', () => {
  test('C-T47 ① 데모 환경에서 요청자 본인 승인은 403이고, 소프트웨어 패스키로 재인증한 데모 승인자의 승인만 명령을 전파하며 감사 기록 둘은 계정이 다르고 demo 표시가 붙는다', async () => {
    const requester = identity.ops('commander');
    const demoApprover = identity.ops('commander');
    const requesterKey = new SoftPasskey();
    const approverKey = new SoftPasskey();
    issuer.register(requester['x-user-id']!, requesterKey);
    issuer.register(demoApprover['x-user-id']!, approverKey);
    // 2인 명령: 명령 4의 ASN 차단(ADR-0339 결정 1)
    const created = await post('/v1/ops/commands', reauthed(requester, requesterKey), { type: 'BLOCK_ASN_IP', reason: '데모 시연 ASN 차단', params: { asns: [64511], expiresAt: new Date(NOW + 60 * 60_000).toISOString() } });
    expect(created.statusCode, created.payload).toBe(201);
    const { commandId, state } = JSON.parse(created.payload) as { commandId: string; state: string };
    expect(state).toBe('PENDING_APPROVAL');
    // 요청자 본인: 재인증까지 해도 403(서버에 데모 분기가 없다)
    const self = await post(`/v1/ops/commands/${commandId}/approvals`, reauthed(requester, requesterKey), {});
    expect(self.statusCode).toBe(403);
    // 데모 승인자: 재인증이 없거나, 다른 출처·사용자 확인 없는 단언(토큰을 받지 못함)이면 403
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, demoApprover, {})).statusCode).toBe(403);
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, reauthed(demoApprover, approverKey, { origin: 'https://evil.example' }), {})).statusCode).toBe(403);
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, reauthed(demoApprover, approverKey, { uv: false }), {})).statusCode).toBe(403);
    // 남의 패스키 단언은 토큰을 받지 못한다
    expect((await post(`/v1/ops/commands/${commandId}/approvals`, reauthed(demoApprover, requesterKey), {})).statusCode).toBe(403);
    expect(executed).not.toContain(commandId);
    const approved = await post(`/v1/ops/commands/${commandId}/approvals`, reauthed(demoApprover, approverKey), {});
    expect(approved.statusCode, approved.payload).toBe(200);
    expect(JSON.parse(approved.payload)).toMatchObject({ state: 'ACKED' });
    expect(executed.filter((id) => id === commandId)).toHaveLength(1);
    // 감사 로그: 요청 기록과 승인 기록이 따로 남고 행위자 참조가 다르며, 둘 다 demo: true
    const rows = await records(commandId);
    const createdRec = rows.find((r) => r.record_type === 'COMMAND_CREATED')!;
    const approvedRec = rows.find((r) => r.record_type === 'COMMAND_APPROVED')!;
    expect(createdRec.record_json.payload).toMatchObject({ demo: true, requestedBy: expect.any(String) });
    expect(approvedRec.record_json.payload).toMatchObject({ demo: true, approverRef: expect.any(String) });
    expect(approvedRec.record_json.payload.approverRef).not.toBe(createdRec.record_json.payload.requestedBy);
    expect(rows.every((r) => r.record_json.payload.demo === true)).toBe(true);
    // 감사 체인 검증은 표시가 붙은 기록으로도 통과한다(표시도 해시에 든다)
    const cp = await post('/v1/ops/audit-checkpoints', identity.ops('commander'), { reason: '데모 시연 확인' });
    expect(cp.statusCode).toBe(201);
    const v = await svc.http.inject({ method: 'GET', url: `/v1/ops/audit-anchors/${(JSON.parse(cp.payload) as { checkpointId: string }).checkpointId}/verification` });
    expect(JSON.parse(v.payload)).toMatchObject({ valid: true, rootValid: true });
  });

  test('C-T47 ① 데모 밖 환경(ci)의 감사 기록에는 demo 칸이 없다(표시는 데모 환경에만)', async () => {
    vi.stubEnv('PEAKET_ENV', 'ci');
    try {
      const c = await new CreateCommand(new DrizzleCommandStore(db)).execute({ type: 'LOG_LEVEL', reason: '데모 밖 기록', params: { service: 'queue-svc', level: 'DEBUG' }, requestedBy: randomUUID(), requestedRole: 'operator', nowMs: clock.now() });
      const rows = await records(c.commandId);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.record_json.payload).not.toHaveProperty('demo');
    } finally {
      vi.stubEnv('PEAKET_ENV', 'demo');
    }
  });
});
