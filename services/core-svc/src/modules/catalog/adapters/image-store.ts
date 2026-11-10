// ImageObjectStore 어댑터 둘(ADR-0257 결정 1): 메모리(시험)와 로컬 폴더(개발). S3 어댑터(격리 버킷·준비 위치·공개 버킷)는 HOT-200이다.
// 키는 서버가 만든 이미지 ID로만 만든 정해진 꼴만 받는다(그 밖은 던진다, catalog-review 5.3.2). 로컬 폴더는 뿌리 밖으로 나가지 못한다.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { ImageObjectStore } from '../domain/media-ports.js';

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NAME = '(?:320|640|960|1280)\\.(?:avif|webp)';
const QUARANTINE = new RegExp(`^quarantine/production/${ID}$`);
const STAGING = new RegExp(`^staging/production/${ID}/${NAME}$`);
const PUBLIC = new RegExp(`^production/${ID}/${NAME}$`);

function checked(re: RegExp, key: string): string {
  if (!re.test(key)) throw new Error('정한 꼴이 아닌 객체 키');
  return key;
}

/** 시험용: 세 위치를 지도로 둔다(시험이 들여다본다) */
export class MemoryImageObjectStore implements ImageObjectStore {
  readonly quarantine = new Map<string, Uint8Array>();
  readonly staging = new Map<string, Uint8Array>();
  readonly published = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async putQuarantine(key: string, bytes: Uint8Array): Promise<void> {
    this.quarantine.set(checked(QUARANTINE, key), bytes);
  }
  async deleteQuarantine(key: string): Promise<void> {
    this.quarantine.delete(checked(QUARANTINE, key));
  }
  async readStaging(key: string): Promise<Uint8Array | undefined> {
    return this.staging.get(checked(STAGING, key));
  }
  async stagingSize(key: string): Promise<number | undefined> {
    return this.staging.get(checked(STAGING, key))?.length;
  }
  async deleteStaging(key: string): Promise<void> {
    this.staging.delete(checked(STAGING, key));
  }
  async putPublic(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.published.set(checked(PUBLIC, key), { bytes, contentType });
  }
  async deletePublic(key: string): Promise<void> {
    this.published.delete(checked(PUBLIC, key));
  }
}

/**
 * 개발용: 한 폴더 아래 quarantine/·staging/·public/에 둔다(개발용 image-worker 대역이 같은 폴더의 quarantine을 읽고 staging에 쓴다).
 * 공개 위치는 public/production/{imageId}/{폭}.{형식}이다. 개발 서버의 이미지 출처가 이 public 폴더를 내주면 화면에서 보인다
 */
export class LocalFolderImageStore implements ImageObjectStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  #path(...parts: string[]): string {
    const p = resolve(join(this.#root, ...parts));
    if (!p.startsWith(this.#root + sep)) throw new Error('뿌리 밖 경로');
    return p;
  }

  async #write(p: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }

  async putQuarantine(key: string, bytes: Uint8Array): Promise<void> {
    await this.#write(this.#path(checked(QUARANTINE, key)), bytes);
  }
  async deleteQuarantine(key: string): Promise<void> {
    await rm(this.#path(checked(QUARANTINE, key)), { force: true });
  }
  async readStaging(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(checked(STAGING, key))));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  async stagingSize(key: string): Promise<number | undefined> {
    try {
      return (await stat(this.#path(checked(STAGING, key)))).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  async deleteStaging(key: string): Promise<void> {
    await rm(this.#path(checked(STAGING, key)), { force: true });
  }
  async putPublic(key: string, bytes: Uint8Array): Promise<void> {
    await this.#write(this.#path('public', checked(PUBLIC, key)), bytes);
  }
  async deletePublic(key: string): Promise<void> {
    await rm(this.#path('public', checked(PUBLIC, key)), { force: true });
  }
}
