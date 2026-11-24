// 온세일 일정 파일을 S3에서 읽는 어댑터(F-02-3, docs/devops.md §8.2).
// 버킷·KMS·IAM은 Terraform 몫이고, 로컬은 PEAKET_FREEZE_S3_ENDPOINT(moto)를 쓴다. 실제 연결은 구간 5(INF-020).
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ScheduleSource } from '../calendar.js';

export interface S3ScheduleSourceOptions {
  readonly bucket: string;
  readonly key: string;
  readonly region?: string;
  /** 로컬·CI의 AWS 흉내 서버(moto) 주소. 주면 경로 방식 주소를 쓴다 */
  readonly endpoint?: string;
  /** 시험에서 바꿔 끼우는 클라이언트 */
  readonly client?: Pick<S3Client, 'send'>;
}

export class S3ScheduleSource implements ScheduleSource {
  private readonly client: Pick<S3Client, 'send'>;

  constructor(private readonly o: S3ScheduleSourceOptions) {
    this.client =
      o.client ??
      new S3Client({
        region: o.region ?? process.env.AWS_REGION ?? 'ap-northeast-2',
        retryMode: 'standard',
        maxAttempts: 3,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : { ignoreConfiguredEndpointUrls: true }),
      });
  }

  async read(): Promise<{ text: string }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: this.o.key }));
    const body = res.Body as { transformToString?: () => Promise<string> } | undefined;
    if (!body?.transformToString) throw new Error('온세일 일정 파일 본문을 읽을 수 없습니다');
    return { text: await body.transformToString() };
  }
}
