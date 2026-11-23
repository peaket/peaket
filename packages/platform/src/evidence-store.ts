// 진단 증거 저장소(ADR-0070 결정 1, docs/infra.md §10 RB-31, BUILD_ORDER BAS-080). 파드가 진단 보고서·힙 스냅샷을 S3 증거 버킷에 올린다.
// - 파일은 본문으로만 보낸다. 객체 이름은 부르는 쪽이 정한다(<서비스>/<파드>/<요청 시각>/<파일>, 계정·주문 식별자 없음, ASVS v5.0.0-14.2.1)
// - AWS SDK 재시도는 표준 모드·최대 3번 시도로 못박는다(docs/architecture.md §5 S3 행). 앱에서 겹쳐 다시 시도하지 않는다
// - 로컬은 AWS 흉내 서버(moto)의 S3에 올린다(PEAKET_DIAG_S3_ENDPOINT, 경로 꼴 주소). 버킷·KMS 키·수명 주기는 Terraform 몫이다
// - 주소를 코드로 주지 않으면 SDK가 읽는 주소 바꾸기 값(AWS_ENDPOINT_URL_S3·AWS_ENDPOINT_URL, 공유 설정 파일의 endpoint_url)을 따르지 않는다
//   (ignoreConfiguredEndpointUrls, 보안 다시 보기 SR-02). 증거는 그 지역의 S3로만 간다
// - 모든 객체에 보존 태그를 싣는다(머리 x-amz-tagging). 태그 값과 보존 일수의 정본은 docs/observability.md §9 '진단 증거' 행이고,
//   수명 주기 규칙 원천(infra/modules/evidence-bucket/lifecycle.json)이 그 태그로 지운다(F-01-1, 시험 D-T52). 연장(hold)은 commander가 태그를 바꾼다
// - 바이트 올리기(putBytes)는 디스크에 쓰지 않고 메모리의 바이트를 바로 올린다(증거 수집기, ASVS v5.0.0-14.2.2)
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** 증거 저장소 포트. 시험은 바꿔 끼운다 */
export interface EvidenceStore {
  /** 파일 하나를 key 이름으로 올린다. 실패하면 던진다 */
  put(key: string, file: string): Promise<void>;
}

/** 바이트 올리기 포트(증거 수집기). 기존 EvidenceStore 가짜가 깨지지 않게 따로 둔다 */
export interface EvidenceBytesStore {
  /** 메모리의 바이트를 key 이름으로 올린다. 실패하면 던진다 */
  putBytes(key: string, body: Uint8Array, contentType: string): Promise<void>;
}

/** 보존 태그(docs/observability.md §9 '진단 증거' 행). 올릴 때는 standard, 연장은 hold */
export const EVIDENCE_RETENTION_TAG = Object.freeze({ key: 'peaket-retention', standard: 'standard', hold: 'hold' } as const);

/** 올릴 때 싣는 태그 문자열(URL 질의 꼴) */
const STANDARD_TAGGING = `${EVIDENCE_RETENTION_TAG.key}=${EVIDENCE_RETENTION_TAG.standard}`;

/** S3 재시도 설정(architecture §5 S3 행) */
export const EVIDENCE_S3_RETRY = Object.freeze({ retryMode: 'standard', maxAttempts: 3 } as const);

export interface S3EvidenceStoreOptions {
  bucket: string;
  /** 기본 AWS_REGION, 없으면 ap-northeast-2 */
  region?: string;
  /** 흉내 서버 주소(local의 moto). 주면 경로 꼴 주소로 붙는다 */
  endpoint?: string;
  /** 시험이 바꿔 끼우는 클라이언트 */
  client?: Pick<S3Client, 'send'>;
}

export function s3EvidenceStore(o: S3EvidenceStoreOptions): EvidenceStore & EvidenceBytesStore {
  if (!o.bucket) throw new Error('증거 버킷 이름이 없다');
  const client =
    o.client ??
    new S3Client({
      region: o.region ?? process.env.AWS_REGION ?? 'ap-northeast-2',
      ...EVIDENCE_S3_RETRY,
      // 요청 체크섬은 요구될 때만 붙인다(흐름 본문에 붙는 덧붙임 체크섬을 흉내 서버가 받지 못하는 판이 있다)
      requestChecksumCalculation: 'WHEN_REQUIRED',
      ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : { ignoreConfiguredEndpointUrls: true }),
    });
  return {
    async put(key, file) {
      const { size } = await stat(file);
      await client.send(new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: createReadStream(file), ContentLength: size, Tagging: STANDARD_TAGGING }));
    },
    async putBytes(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: o.bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: contentType, Tagging: STANDARD_TAGGING }),
      );
    },
  };
}
