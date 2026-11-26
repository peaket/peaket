// F-06-4 구현 리뷰 IR-06: core 소명 결과 409(다른 결과가 먼저 적힘)를 성공으로 삼키지 않는지.
import { describe, expect, test } from 'vitest';
import { HttpAppealSource } from '../src/modules/restrictions/adapters/http-appeal-source.js';

const client = (status: number) => ({
  request: async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) }) as Response,
});

describe('IR-06 HttpAppealSource.result', () => {
  test('409는 던져 결정이 건을 닫지 않게 한다', async () => {
    const source = new HttpAppealSource({ url: 'http://core.internal:8080', token: 't', client: client(409) });
    await expect(source.result('0194f064-0000-7000-8000-000000000801', { status: 'DECIDED', result: 'LIFTED' })).rejects.toMatchObject({ status: 409 });
  });

  test('200은 그대로 끝난다', async () => {
    const source = new HttpAppealSource({ url: 'http://core.internal:8080', token: 't', client: client(200) });
    await expect(source.result('0194f064-0000-7000-8000-000000000802', { status: 'DECIDED', result: 'LIFTED' })).resolves.toBeUndefined();
  });
});
