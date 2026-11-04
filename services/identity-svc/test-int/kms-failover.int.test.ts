// 관리 계정 KMS 호출의 복제 키 넘기기 통합 시험(AWS 흉내 서버 moto 5.2.5, docs/features/identity.md §6 '관리 계정 KMS 호출의 복제 키 넘기기의 첫 구현', BUILD_ORDER BOT-131, ADR-0102).
// 서울 끝점은 닫힌 포트(응답 없음)로 두고, 도쿄는 moto의 다중 리전 복제 키다. 페퍼는 서울에서 만든 MAC을 도쿄 복제 키로 확인한다(같은 키 재료).
// moto 5.2.5는 다중 리전 대칭 키의 Decrypt를 거절한다(같은 리전도. AWS는 복제 키로 연다): TOTP는 보통 대칭 키로, 서울이 응답하지 않을 때 봉인·열기가 넘김 클라이언트로 되는지만 본다.
// 다중 리전 키 검사와 복제 키 ARN 만들기는 단위 시험(test/kms-failover.test.ts)이 본다.
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { CreateKeyCommand, KMSClient, ReplicateKeyCommand } from '@aws-sdk/client-kms';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { adminPepperFromEnv, kmsPepperClient } from '../src/modules/admin/adapters/kms-pepper.js';
import { KmsTotpSeedCipher } from '../src/modules/admin/adapters/kms-totp-seed-cipher.js';
import { Pbkdf2AdminPasswords } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';

const MOTO_IMAGE = 'motoserver/moto:5.2.5';
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const creds = { accessKeyId: 'test', secretAccessKey: 'test' };
/** 응답하지 않는 서울(닫힌 포트) */
const DEAD = 'http://127.0.0.1:1';
let moto: string;
let endpoint: string;
let hmacArn: string;
let symArn: string;
/** 연결은 받고 답하지 않는 서울(재검토 2026-11-05: SDK가 요청 시간 한도에 끊지 않으면 넘기기 전에 멈춘다) */
let silent: Server;
let silentEndpoint: string;

beforeAll(async () => {
  silent = createServer(() => {});
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  silentEndpoint = `http://127.0.0.1:${(silent.address() as { port: number }).port}`;
  moto = docker(['run', '-d', '--rm', '-p', '127.0.0.1::5000', MOTO_IMAGE]);
  const mapped = docker(['port', moto, '5000/tcp']).split('\n')[0]!;
  endpoint = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  const seoul = new KMSClient({ endpoint, region: 'ap-northeast-2', credentials: creds });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      hmacArn = (await seoul.send(new CreateKeyCommand({ KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC', MultiRegion: true }))).KeyMetadata!.Arn!;
      break;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  symArn = (await seoul.send(new CreateKeyCommand({}))).KeyMetadata!.Arn!;
  // moto는 ReplicateKey에 키 ARN을 받지 못해 키 ID로 부른다
  for (const arn of [hmacArn]) await seoul.send(new ReplicateKeyCommand({ KeyId: arn.slice(arn.lastIndexOf('key/') + 4), ReplicaRegion: 'ap-northeast-1' }));
}, 120_000);

afterAll(() => {
  silent?.closeAllConnections();
  silent?.close();
  if (moto) docker(['rm', '-f', moto]);
});

/** main.ts와 같은 꼴: 서울 클라이언트는 설정 끝점(여기선 응답 없음), 넘길 리전 클라이언트는 넘김 끝점 */
const made: string[] = [];
const pepperClient = (seoulEndpoint: string) => (ep: string | undefined, region: string) => {
  made.push(`${region} ${ep === endpoint ? 'moto' : ep}`);
  return kmsPepperClient({ region, endpoint: region === 'ap-northeast-2' ? seoulEndpoint : ep!, credentials: creds });
};

test('moto에서_서울이응답하지않으면페퍼GenerateMac·VerifyMac이도쿄복제키로넘어가고_서울에서만든MAC을도쿄에서확인한다(ADR-0102)', async () => {
  const env = { PEAKET_ENV: 'ci', PEAKET_ADMIN_PEPPER_KMS_KEYS: JSON.stringify({ 1: hmacArn }), PEAKET_KMS_ENDPOINT: endpoint, PEAKET_KMS_FAILOVER_REGION: 'ap-northeast-1', PEAKET_KMS_FAILOVER_ENDPOINT: endpoint };
  const failovers: string[] = [];
  // 서울이 살아 있을 때 비밀번호를 정한다
  const live = new Pbkdf2AdminPasswords(adminPepperFromEnv(env, pepperClient(endpoint), (use) => failovers.push(use))!, { iterations: 1_000 });
  const phc = await live.hash('0190f3a1-7c2e-7a00-8000-000000000e01', '봄비내리는월요일아침의커피한잔');
  // 서울이 답하면 맞지 않는 MAC(틀린 비밀번호)도 넘기지 않는다
  expect(await live.verify('0190f3a1-7c2e-7a00-8000-000000000e01', '봄비내리는월요일아침의커피한잔!', phc)).toBe(false);
  expect(failovers).toEqual([]);
  // 설정의 두 끝점·리전으로 클라이언트를 만든다(서울: PEAKET_KMS_ENDPOINT·AWS_REGION, 넘길 리전: PEAKET_KMS_FAILOVER_ENDPOINT·PEAKET_KMS_FAILOVER_REGION)
  expect(made).toEqual(['ap-northeast-2 moto', 'ap-northeast-1 moto']);
  // 서울이 멈췄다: 같은 PHC를 도쿄 복제 키로 확인한다
  const down = new Pbkdf2AdminPasswords(adminPepperFromEnv(env, pepperClient(DEAD), (use) => failovers.push(use))!, { iterations: 1_000 });
  expect(await down.verify('0190f3a1-7c2e-7a00-8000-000000000e01', '봄비내리는월요일아침의커피한잔', phc)).toBe(true);
  expect(await down.verify('0190f3a1-7c2e-7a00-8000-000000000e01', '봄비내리는월요일아침의커피한잔!', phc)).toBe(false);
  expect(await down.hash('0190f3a1-7c2e-7a00-8000-000000000e01', '봄비내리는월요일아침의커피한잔')).toMatch(/^\$pbkdf2-sha256\$/);
  expect(failovers.length).toBeGreaterThanOrEqual(3);
  expect(new Set(failovers)).toEqual(new Set(['pepper']));
}, 60_000);

test('moto에서_서울이응답하지않으면TOTP시드봉인·열기가넘김클라이언트로넘어간다', async () => {
  const failovers: string[] = [];
  const dead = new KMSClient({ region: 'ap-northeast-2', endpoint: DEAD, credentials: creds, maxAttempts: 1 });
  const replica = new KMSClient({ region: 'ap-northeast-2', endpoint, credentials: creds });
  const cipher = new KmsTotpSeedCipher(dead, symArn, { client: replica, keyId: symArn, onFailover: () => failovers.push('totp') });
  const sealed = await cipher.encrypt('0190f3a1-7c2e-7a00-8000-000000000e02', Buffer.alloc(20, 9));
  expect(await cipher.decrypt('0190f3a1-7c2e-7a00-8000-000000000e02', sealed)).toEqual(Buffer.alloc(20, 9));
  expect(failovers).toEqual(['totp', 'totp']);
  // 다른 계정의 컨텍스트로 열면 거절이고 넘기지 않는다(moto는 컨텍스트가 틀리면 AccessDenied를 준다. AWS는 InvalidCiphertextException → TotpSeedUnreadable)
  const direct = new KmsTotpSeedCipher(replica, symArn, { client: dead, keyId: symArn, onFailover: () => failovers.push('totp') });
  await expect(direct.decrypt('0190f3a1-7c2e-7a00-8000-000000000e03', sealed)).rejects.toThrow();
  expect(failovers).toEqual(['totp', 'totp']);
}, 60_000);

test('moto에서_서울이연결을받고답하지않아도요청시간한도(2초,두번)뒤에도쿄로넘긴다', async () => {
  const env = { PEAKET_ENV: 'ci', PEAKET_ADMIN_PEPPER_KMS_KEYS: JSON.stringify({ 1: hmacArn }), PEAKET_KMS_ENDPOINT: endpoint, PEAKET_KMS_FAILOVER_REGION: 'ap-northeast-1', PEAKET_KMS_FAILOVER_ENDPOINT: endpoint };
  const failovers: string[] = [];
  const live = new Pbkdf2AdminPasswords(adminPepperFromEnv(env, pepperClient(endpoint))!, { iterations: 1_000 });
  const phc = await live.hash('0190f3a1-7c2e-7a00-8000-000000000e04', '봄비내리는월요일아침의커피한잔');
  const hung = new Pbkdf2AdminPasswords(adminPepperFromEnv(env, pepperClient(silentEndpoint), (use, error) => failovers.push(`${use} ${error}`))!, { iterations: 1_000 });
  const started = Date.now();
  expect(await hung.verify('0190f3a1-7c2e-7a00-8000-000000000e04', '봄비내리는월요일아침의커피한잔', phc)).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(failovers).toEqual(['pepper TimeoutError']);
}, 20_000);
