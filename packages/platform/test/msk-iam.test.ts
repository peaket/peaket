// MSK IAM 토큰 함수(openspec 변경 add-foundation-poc, docs/streaming.md §2.6, docs/devops.md §9.4, 기술 검토 높음-26).
// ST-T14 ①: 흉내 낸 STS로 토큰 함수를 부르고, 역할 신뢰를 거둬 역할을 맡지 못하게 한다.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { kafkaAdminConfig, kafkaConsumerConfig, kafkaProducerConfig, kafkaAuthFromEnv, mskIamTokenProvider, mskSessionName } from '../src/index.js';

/** AssumeRole만 받는 가짜 STS. trusted가 거짓이면 실제 STS처럼 403 AccessDenied를 낸다 */
const sts = { trusted: true, calls: [] as { roleArn: string | null; sessionName: string | null; authorization: string }[] };
let server: Server;
const saved: Record<string, string | undefined> = {};
const ENV = ['AWS_ENDPOINT_URL_STS', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_PROFILE', 'AWS_EC2_METADATA_DISABLED'];
const EXPIRES = new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      sts.calls.push({ roleArn: p.get('RoleArn'), sessionName: p.get('RoleSessionName'), authorization: String(req.headers.authorization ?? '') });
      if (!sts.trusted) {
        res.writeHead(403, { 'content-type': 'text/xml' });
        res.end('<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>not authorized to perform: sts:AssumeRole</Message></Error><RequestId>x</RequestId></ErrorResponse>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(
        `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>` +
          `<AccessKeyId>ASIAASSUMEDROLE00001</AccessKeyId><SecretAccessKey>assumed-secret</SecretAccessKey>` +
          `<SessionToken>assumed-session-token</SessionToken><Expiration>${EXPIRES.toISOString()}</Expiration></Credentials>` +
          `<AssumedRoleUser><AssumedRoleId>AROA:${p.get('RoleSessionName')}</AssumedRoleId><Arn>arn:aws:sts::123456789012:assumed-role/msk/${p.get('RoleSessionName')}</Arn></AssumedRoleUser>` +
          `</AssumeRoleResult><ResponseMetadata><RequestId>y</RequestId></ResponseMetadata></AssumeRoleResponse>`,
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  for (const k of ENV) saved[k] = process.env[k];
  process.env.AWS_ENDPOINT_URL_STS = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 파드 자격(Pod Identity)을 흉내 낸 기본 자격. 토큰은 이것으로 만들면 안 되고, 이것으로 역할을 맡아야 한다
  process.env.AWS_ACCESS_KEY_ID = 'AKIAPODIDENTITY00001';
  process.env.AWS_SECRET_ACCESS_KEY = 'pod-secret';
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
});
afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  sts.trusted = true;
  sts.calls.length = 0;
});

const ROLE = 'arn:aws:iam::123456789012:role/peaket-msk-purchase-svc-prod';
const decode = (token: string) => new URL(Buffer.from(token, 'base64url').toString('utf8'));

describe('ST-T14 ① MSK IAM 토큰 함수', () => {
  test('ST_T14_①_맡은역할의세션이름이늘_작업자_환경이고_토큰은맡은역할자격으로서명한다', async () => {
    const provide = mskIamTokenProvider({ region: 'ap-northeast-2', roleArn: ROLE, sessionName: mskSessionName('purchase-svc', 'prod') });
    const first = await provide();
    const second = await provide();
    expect(sts.calls.map((c) => [c.roleArn, c.sessionName])).toEqual([
      [ROLE, 'purchase-svc-prod'],
      [ROLE, 'purchase-svc-prod'],
    ]);
    // STS는 파드 자격으로 부른다(기본 자격 사슬)
    expect(sts.calls[0]!.authorization).toContain('Credential=AKIAPODIDENTITY00001/');
    for (const t of [first, second]) {
      const url = decode(t.value);
      expect(url.host).toBe('kafka.ap-northeast-2.amazonaws.com');
      expect(url.searchParams.get('Action')).toBe('kafka-cluster:Connect');
      // 맡은 역할의 자격으로 서명했다(파드 자격이 아니다)
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^ASIAASSUMEDROLE00001\//);
      expect(url.searchParams.get('X-Amz-Security-Token')).toBe('assumed-session-token');
      expect(t.principal).toBe('purchase-svc-prod');
      // 만료는 '지금부터 몇 ms'가 아니라 만료 시각(epoch ms)이다(librdkafka md_lifetime_ms)
      expect(t.lifetime).toBeGreaterThan(Date.now());
      expect(t.lifetime).toBeLessThanOrEqual(Date.now() + 900_000 + 1_000);
    }
  });

  test('ST_T14_①_역할을못맡으면_기본자격으로넘어가지않고_실패한다', async () => {
    sts.trusted = false;
    const provide = mskIamTokenProvider({ region: 'ap-northeast-2', roleArn: ROLE, sessionName: 'purchase-svc-prod' });
    await expect(provide()).rejects.toThrow(/AccessDenied|not authorized/);
    expect(sts.calls.length).toBeGreaterThanOrEqual(1);
    expect(sts.calls.every((c) => c.sessionName === 'purchase-svc-prod')).toBe(true);
  });

  test('세션 이름은 STS 규칙(2~64자, 영문·숫자·+=,.@-)과 고정 형식만 받는다', () => {
    expect(mskSessionName('purchase-svc-outbox-relay', 'staging')).toBe('purchase-svc-outbox-relay-staging');
    expect(() => mskSessionName('purchase svc', 'prod')).toThrow();
    expect(() => mskSessionName('a'.repeat(60), 'prod')).toThrow();
    expect(() => mskSessionName('purchase-svc', '')).toThrow();
  });
});

describe('Kafka 공용 설정 함수의 MSK IAM(SASL_SSL·OAUTHBEARER)', () => {
  const base = { brokers: ['b-1.msk:9098'], clientId: 'purchase-svc-prod-pod-1' };
  const tokenProvider = async () => ({ value: 't', lifetime: Date.now() + 60_000, principal: 'purchase-svc-prod' });

  test('ST_T14_생산자와소비자는_MSK_IAM이면_TLS와_OAUTHBEARER_토큰함수를싣는다', () => {
    const p = kafkaProducerConfig({ ...base, kind: 'default', auth: { mechanism: 'msk-iam', tokenProvider } });
    const c = kafkaConsumerConfig({ ...base, groupId: 'g', auth: { mechanism: 'msk-iam', tokenProvider } });
    for (const x of [p, c]) {
      expect(x.kafkaJS).toEqual({ brokers: base.brokers, clientId: base.clientId, ssl: true, sasl: { mechanism: 'oauthbearer', oauthBearerProvider: tokenProvider } });
      expect(x).not.toHaveProperty('security.protocol');
    }
  });

  test('관리 연결도 MSK IAM이면 TLS와 OAUTHBEARER를 싣는다(코드 리뷰 2026-11-01)', () => {
    expect(kafkaAdminConfig({ ...base, auth: { mechanism: 'msk-iam', tokenProvider } }).kafkaJS).toEqual({ brokers: base.brokers, clientId: base.clientId, ssl: true, sasl: { mechanism: 'oauthbearer', oauthBearerProvider: tokenProvider } });
    expect(kafkaAdminConfig(base).kafkaJS).toEqual({ brokers: base.brokers, clientId: base.clientId });
  });

  test('사설 CA는 인증 묶음의 caLocation으로만 받는다(시험 브로커)', () => {
    const c = kafkaConsumerConfig({ ...base, groupId: 'g', auth: { mechanism: 'msk-iam', tokenProvider, caLocation: '/certs/ca.crt' } });
    expect(c['ssl.ca.location']).toBe('/certs/ca.crt');
    expect(kafkaConsumerConfig({ ...base, groupId: 'g', auth: { mechanism: 'msk-iam', tokenProvider } })).not.toHaveProperty('ssl.ca.location');
  });

  test('인증을 고르면 덧붙일 설정으로 보안 방식·SASL 설정을 바꿀 수 없다(겉의 값이 호환 묶음을 이긴다)', () => {
    // TLS 인증서 검증을 끄거나 믿을 CA를 바꾸는 이름도 막는다: 토큰은 가진 사람이 그대로 쓸 수 있다(코드 리뷰 2026-11-01)
    for (const k of ['security.protocol', 'sasl.mechanism', 'sasl.mechanisms', 'enable.sasl.oauthbearer.unsecure.jwt', 'sasl.oauthbearer.config', 'enable.ssl.certificate.verification', 'ssl.endpoint.identification.algorithm', 'ssl.ca.location', 'ssl.ca.pem', 'ssl.ca.certificate.stores']) {
      expect(() => kafkaProducerConfig({ ...base, kind: 'default', auth: { mechanism: 'msk-iam', tokenProvider }, extra: { [k]: 'x' } })).toThrow(k);
    }
  });

  test('ST_T14_환경값으로_인증을고른다_없으면평문_있으면작업자전용역할과고정세션이름', () => {
    expect(kafkaAuthFromEnv('purchase-svc', { PEAKET_ENV: 'local' })).toBeUndefined();
    const auth = kafkaAuthFromEnv('purchase-svc-outbox-relay', { PEAKET_ENV: 'prod', PEAKET_KAFKA_AUTH: 'msk-iam', PEAKET_KAFKA_MSK_ROLE_ARN: ROLE, AWS_REGION: 'ap-northeast-2' });
    expect(auth?.mechanism).toBe('msk-iam');
    expect(auth?.sessionName).toBe('purchase-svc-outbox-relay-prod');
    expect(() => kafkaAuthFromEnv('purchase-svc', { PEAKET_ENV: 'prod', PEAKET_KAFKA_AUTH: 'msk-iam' })).toThrow(/PEAKET_KAFKA_MSK_ROLE_ARN/);
    expect(() => kafkaAuthFromEnv('purchase-svc', { PEAKET_ENV: 'prod', PEAKET_KAFKA_AUTH: 'plain' })).toThrow(/PEAKET_KAFKA_AUTH/);
  });

  test('ST_T14_local·ci가 아닌 환경에서 인증 값이 빠지면_평문으로 붙지 않고 시작에서 실패한다(코드 리뷰 2026-11-01, 전송 구간 암호화 강제)', () => {
    for (const env of ['demo', 'staging', 'prod']) expect(() => kafkaAuthFromEnv('purchase-svc', { PEAKET_ENV: env })).toThrow(/PEAKET_KAFKA_AUTH/);
    expect(() => kafkaAuthFromEnv('purchase-svc', {})).toThrow(/PEAKET_ENV/);
    expect(kafkaAuthFromEnv('purchase-svc', { PEAKET_ENV: 'ci' })).toBeUndefined();
  });
});
