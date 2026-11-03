// 결과 파일을 로컬 폴더에 쓴다(local·ci·demo. 운영은 S3 회차별 접두사와 대기열 파일 배포, BUILD_ORDER HOT-050, ADR-0058 결정 5).
// 경로: {폴더}/{회차 ID}/batch-results/{토큰 해시 앞 세 자리}.json. 받는 쪽이 중간 상태를 읽지 않게 임시 파일에 쓰고 옮긴다.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResultFiles } from '../domain/ports.js';

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PREFIX = /^[0-9a-f]{3}$/;

export class LocalResultFiles implements ResultFiles {
  constructor(private readonly dir: string) {}

  async write(eventId: string, _batchNo: number, files: ReadonlyMap<string, Record<string, number>>): Promise<void> {
    if (!EVENT_ID.test(eventId)) throw new Error(`회차 ID 모양이 틀렸다: ${eventId}`);
    const dir = join(this.dir, eventId, 'batch-results');
    mkdirSync(dir, { recursive: true });
    for (const [prefix, body] of files) {
      if (!PREFIX.test(prefix)) throw new Error(`결과 파일 앞자리 모양이 틀렸다: ${prefix}`);
      const file = join(dir, `${prefix}.json`);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(body));
      renameSync(tmp, file);
    }
  }
}
