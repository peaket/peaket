// MSK IAM 토큰 함수(openspec 변경 add-foundation-poc, docs/streaming.md §2.6, docs/devops.md §9.4, 기술 검토 높음-26, ST-T14 ①).
// 작업자마다 MSK 전용 역할을 고정 세션 이름 `<작업자>-<환경>`으로 맡아 OAUTHBEARER 토큰을 만든다. 역할은 기본 자격 사슬(파드 자격)로
// 맡는다. 기본 자격 사슬로 바로 토큰을 만드는 generateAuthToken은 쓰지 않는다: Pod Identity 자격이 바뀌면 세션 이름이 바뀌어
// 재인증이 끊긴다. 역할을 못 맡으면 서명 도구가 던지고, 기본 자격으로 넘어가 다른 신원으로 붙지 않는다.
import { generateAuthTokenFromRole } from 'aws-msk-iam-sasl-signer-js';

/** @confluentinc/kafka-javascript KafkaJS 호환 oauthBearerProvider가 돌려줄 값. lifetime은 만료 시각(epoch ms)이다 */
export interface OAuthBearerToken {
  value: string;
  lifetime: number;
  principal: string;
}
export type OAuthBearerProvider = () => Promise<OAuthBearerToken>;

export interface MskIamOptions {
  /** 예: ap-northeast-2 */
  region: string;
  /** 작업자 전용 MSK 역할(docs/devops.md §9.4 'MSK IAM 클라이언트') */
  roleArn: string;
  /** mskSessionName(작업자, 환경) */
  sessionName: string;
}

/** STS RoleSessionName 규칙: 2~64자, 영문·숫자·_+=,.@- */
const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;

/** 고정 세션 이름 `<작업자>-<환경>` */
export function mskSessionName(worker: string, env: string): string {
  const name = `${worker}-${env}`;
  if (!worker || !env || !SESSION_NAME.test(name)) throw new Error(`MSK 세션 이름이 STS 규칙에 맞지 않는다: ${name}`);
  return name;
}

export function mskIamTokenProvider(o: MskIamOptions): OAuthBearerProvider {
  if (!o.region || !o.roleArn) throw new Error('MSK IAM에는 리전과 작업자 전용 역할이 있어야 한다');
  if (!SESSION_NAME.test(o.sessionName)) throw new Error(`MSK 세션 이름이 STS 규칙에 맞지 않는다: ${o.sessionName}`);
  return async () => {
    const t = await generateAuthTokenFromRole({ region: o.region, awsRoleArn: o.roleArn, awsRoleSessionName: o.sessionName });
    return { value: t.token, lifetime: t.expiryTime, principal: o.sessionName };
  };
}

export interface KafkaMskIamAuth {
  mechanism: 'msk-iam';
  tokenProvider: OAuthBearerProvider;
  /** 기록용(토큰 함수가 맡는 세션 이름) */
  sessionName?: string;
  /**
   * 브로커 인증서를 서명한 CA 파일. 비우면 시스템 CA(MSK는 공개 CA라 비운다. 실행 이미지에 ca-certificates가 있어야 한다).
   * 시험 브로커처럼 사설 CA를 믿어야 할 때만 쓴다. 덧붙일 설정의 ssl.ca.*는 받지 않는다(KAFKA_AUTH_LOCKED)
   */
  caLocation?: string;
}
export type KafkaAuth = KafkaMskIamAuth;

/**
 * 환경 값으로 Kafka 인증을 고른다. `PEAKET_KAFKA_AUTH`가 없으면 평문(로컬·CI 브로커), `msk-iam`이면 `PEAKET_KAFKA_MSK_ROLE_ARN`
 * 역할을 세션 이름 `<작업자>-<PEAKET_ENV>`로 맡는다. 서비스의 작업자 이름은 서비스 이름, Outbox 릴레이는 `<서비스>-outbox-relay`다
 * (docs/streaming.md §2.6)
 */
export function kafkaAuthFromEnv(worker: string, env: Record<string, string | undefined> = process.env): KafkaAuth | undefined {
  const kind = env.PEAKET_KAFKA_AUTH;
  if (kind === undefined || kind === '') {
    // 평문은 로컬·CI 브로커에만 쓴다. 다른 환경에서 값이 빠지면 조용히 평문으로 붙지 않고 시작에서 실패한다(전송 구간 암호화 강제,
    // docs/architecture.md §8, 코드 리뷰 2026-11-01)
    if (!env.PEAKET_ENV) throw new Error('PEAKET_ENV가 없어 Kafka 인증을 고를 수 없다');
    if (env.PEAKET_ENV === 'local' || env.PEAKET_ENV === 'ci') return undefined;
    throw new Error(`PEAKET_ENV=${env.PEAKET_ENV}에서는 PEAKET_KAFKA_AUTH(msk-iam)가 있어야 한다`);
  }
  if (kind !== 'msk-iam') throw new Error(`PEAKET_KAFKA_AUTH는 msk-iam만 받는다: ${kind}`);
  const missing = ['PEAKET_KAFKA_MSK_ROLE_ARN', 'AWS_REGION', 'PEAKET_ENV'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`MSK IAM 설정이 비었다: ${missing.join(', ')}`);
  const sessionName = mskSessionName(worker, env.PEAKET_ENV!);
  return { mechanism: 'msk-iam', sessionName, tokenProvider: mskIamTokenProvider({ region: env.AWS_REGION!, roleArn: env.PEAKET_KAFKA_MSK_ROLE_ARN!, sessionName }) };
}
