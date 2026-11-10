// PublicFileStore 어댑터 둘(ADR-0260 결정 6): 메모리(시험)와 로컬 폴더(개발, PEAKET_PUBLIC_FILE_DIR). S3 어댑터는 HOT-200(이미지의 S3 어댑터와 같은 단계)이다.
// 키는 공개 위치 `v1/events/{회차 UUID}/seatmap-layouts/{1 이상 정수}.json`과 준비 위치 `staging/` + 같은 꼴만 받는다(그 밖은 던진다, seat-hold ASVS 5.3.2).
// 준비 위치는 승인 이력이 있는 공연의 재승인 대기 판이라 공개 서빙 밖에 둔다(추천 적용 2026-11-10 리뷰 H3). 로컬 폴더는 뿌리 밖으로 나가지 못한다.
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { PublicFileStore } from '../domain/seatmap-ports.js';

const KEY = /^(staging\/)?v1\/events\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/seatmap-layouts\/[1-9]\d{0,8}\.json$/;

function checked(key: string): string {
  if (!KEY.test(key)) throw new Error('정한 꼴이 아닌 공개 파일 키');
  return key;
}

/** 시험용: 키 → 바이트와 메타데이터 */
export class MemoryPublicFileStore implements PublicFileStore {
  readonly files = new Map<string, { bytes: Uint8Array; contentType: string; cacheControl: string }>();

  async put(key: string, bytes: Uint8Array, meta: { contentType: string; cacheControl: string }): Promise<void> {
    this.files.set(checked(key), { bytes, ...meta });
  }
  async delete(key: string): Promise<void> {
    this.files.delete(checked(key));
  }
}

/**
 * 개발용: 한 폴더 아래 public/(공개 위치, 개발 서버가 정적 파일로 내준다)과 staging/(준비 위치, 내주지 않는다)에 키 그대로 둔다.
 * 메타데이터는 파일에 남기지 않는다(정적 서버가 .json으로 정한다). 같은 폴더의 임시 이름에 쓴 뒤 이름을 바꿔, 읽는 쪽이 쓰다 만 파일을 보지 않게 한다
 */
export class LocalFolderPublicFileStore implements PublicFileStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    const k = checked(key);
    const p = resolve(k.startsWith('staging/') ? join(this.#root, k) : join(this.#root, 'public', k));
    if (!p.startsWith(this.#root + sep)) throw new Error('뿌리 밖 경로');
    return p;
  }

  async put(key: string, bytes: Uint8Array, _meta?: { contentType: string; cacheControl: string }): Promise<void> {
    const p = this.#path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, p);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}
