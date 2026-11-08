// 셔플 검증 정보의 읽기(ADR-0232 결정 8): 공시 기록과 게시 표시를 칸 원문 그대로 읽는다. 결과 파일 폴더 읽기(local·ci·demo)도 여기 둔다.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { QUEUE_REDIS } from '../../entry/index.js';
import type { ProofFields } from '../domain/proof.js';
import type { ResultFileKind, ResultFileReader, ShuffleProofSource } from '../domain/ports.js';

const shuffleKey = (e: string) => `q:{event:${e}}:shuffle`;
const doneKey = (e: string) => `q:{event:${e}}:batch_done`;

// 두 칸 묶음을 같은 Lua로 읽어(같은 슬롯) 서로 다른 때의 값이 섞이지 않게 한다
const READ_PROOF = redisScript(`
return {redis.call('HGETALL', KEYS[1]), redis.call('HGETALL', KEYS[2])}
`);

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
function fieldsOf(raw: unknown): Record<string, string> {
  const a = (raw ?? []) as unknown[];
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i += 2) out[str(a[i])] = str(a[i + 1]);
  return out;
}

@Injectable()
export class RedisShuffleProofSource implements ShuffleProofSource {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async read(eventId: string): Promise<ProofFields> {
    const [shuffle, done] = (await this.redis.evalScript(READ_PROOF, [shuffleKey(eventId), doneKey(eventId)], [])) as [unknown, unknown];
    return { shuffle: fieldsOf(shuffle), done: fieldsOf(done) };
  }
}

export class MemoryShuffleProofSource implements ShuffleProofSource {
  readonly #m = new Map<string, ProofFields>();

  set(eventId: string, f: ProofFields): void {
    this.#m.set(eventId, f);
  }

  async read(eventId: string): Promise<ProofFields> {
    return this.#m.get(eventId) ?? { shuffle: {}, done: {} };
  }
}

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE = /^[0-9a-f]{3}$/;

/** local·ci·demo의 결과 파일 폴더(admission-ctrl LocalResultFiles와 같은 PEAKET_BATCH_RESULT_DIR). 운영은 대기열 파일 배포가 S3에서 직접 낸다(ADR-0232 결정 4) */
export class LocalResultFileReader implements ResultFileReader {
  constructor(private readonly dir: string) {}

  async read(eventId: string, kind: ResultFileKind, prefix: string): Promise<string | null> {
    if (!EVENT_ID.test(eventId) || !FILE.test(prefix)) return null;
    try {
      return await readFile(join(this.dir, eventId, kind, `${prefix}.json`), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

export const noResultFiles: ResultFileReader = { read: async () => null };
