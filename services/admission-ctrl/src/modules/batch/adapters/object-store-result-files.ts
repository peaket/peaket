// 결과 파일을 객체 저장소에 쓴다(BUILD_ORDER HOT-050, ADR-0232 결정 1, ADR-0058 결정 5). 실제 저장(S3 PUT)은 ResultObjectStore 포트이고 어댑터는 HOT-012다.
// 키는 CloudFront S3 원본의 원본 경로 + 요청 경로와 같다: queue/fallback/v1/queues/{회차 ID}/{shuffle-results|batch-results}/{앞 세 자리}.json. 회차 ID가 접두사라 회차마다 S3 파티션이 갈린다.
import type { ResultFiles, ResultObjectStore, ShuffleGroup } from '../domain/ports.js';

/** 파일 캐시 60초 [가정, Phase 2 부하 시험에서 확정](docs/api/guidelines.md) */
export const RESULT_CACHE_CONTROL = 'public, max-age=60';
const CONTENT_TYPE = 'application/json; charset=utf-8';
/** 동시 쓰기 64개 [가정]. 접두사마다 초당 PUT 3,500건 안이다(4,096개를 5초 안에) */
export const MAX_CONCURRENT_PUTS = 64;

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX = /^[0-9a-f]{3}$/;

export const resultObjectKey = (eventId: string, group: ShuffleGroup, prefix: string): string => `queue/fallback/v1/queues/${eventId}/${group === 'lobby' ? 'shuffle-results' : 'batch-results'}/${prefix}.json`;

export class ObjectStoreResultFiles implements ResultFiles {
  constructor(private readonly objects: ResultObjectStore) {}

  async write(eventId: string, group: ShuffleGroup, files: ReadonlyMap<string, Record<string, number>>): Promise<void> {
    if (!EVENT_ID.test(eventId)) throw new Error(`회차 ID 모양이 틀렸다: ${eventId}`);
    for (const prefix of files.keys()) if (!PREFIX.test(prefix)) throw new Error(`결과 파일 앞자리 모양이 틀렸다: ${prefix}`);
    const entries = [...files.entries()];
    let next = 0;
    let failed = false;
    let cause: unknown;
    const worker = async (): Promise<void> => {
      // 하나가 실패하면 새 PUT을 시작하지 않는다. 진행 중인 PUT이 끝난 뒤에 던져야 다음 재시도와 겹치지 않는다
      while (!failed && next < entries.length) {
        const [prefix, body] = entries[next++]!;
        try {
          await this.objects.put({ key: resultObjectKey(eventId, group, prefix), body: JSON.stringify(body), contentType: CONTENT_TYPE, cacheControl: RESULT_CACHE_CONTROL });
        } catch (err) {
          if (!failed) cause = err;
          failed = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PUTS, entries.length) }, worker));
    if (failed) throw cause;
  }
}
