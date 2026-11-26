// F-04-14 구현 리뷰 수정 시험(IR-07·IR-14). 제품 정비 루프와 S3 격리 버킷 조립을 직접 본다.
import 'reflect-metadata';
import { describe, expect, test } from 'vitest';
import * as inv from '../src/modules/investigations/index.js';

const ev = inv as unknown as Record<string, any>;

describe('F-04-14 구현 리뷰 정비·조립', () => {
  test('IR-07 정비 한 단계가 실패해도 tick은 멈추지 않고 다음 단계를 부른다', async () => {
    const calls: string[] = [];
    const evidence = {
      async buildDue() {
        calls.push('build');
        throw new Error('S3 일시 오류');
      },
      async verifyDue() {
        calls.push('verify');
      },
      async disposeDue() {
        calls.push('dispose');
      },
    };
    const posts = {
      async scanDue() {
        calls.push('scan');
      },
      async disposeDue() {
        calls.push('post-dispose');
      },
    };
    const sweep = ev.startEvidenceSweep({ evidence, posts, intervalMs: 60_000 });
    await expect(sweep.tick()).resolves.toBeUndefined();
    sweep.stop();
    expect(calls).toEqual(['build', 'verify', 'dispose', 'scan', 'post-dispose']);
  });

  test('IR-14 증거 격리 버킷 이름이 없으면 S3 캡처 저장소를 만들지 않는다', () => {
    expect(() => new ev.S3ExternalPostCaptures({ evidenceBucket: 'evidence', kmsKeyId: 'key' })).toThrow(/격리 버킷/);
  });
});
