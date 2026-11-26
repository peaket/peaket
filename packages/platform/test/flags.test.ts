// 릴리스 플래그 파일 모드 계약 시험(docs/devops.md §5.4, ADR-0386 결정 5, F-09-2 계획 §5).
// 네트워크를 부르지 않고, 정의가 깨지거나 공급자가 실패하면 꺼짐으로 동작한다.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReleaseFlags, parseFlagDefinitions } from '../src/flags.js';

const dirs: string[] = [];
async function config(body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'peaket-flags-'));
  dirs.push(dir);
  const path = join(dir, 'peaket.json');
  await writeFile(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return path;
}

const valid = {
  $schema: 'https://flagd.dev/schema/v0/flags.json',
  flags: {
    'checkout.new': {
      state: 'ENABLED',
      variants: { on: true, off: false },
      defaultVariant: 'off',
      metadata: { owner: 'lane1', expiresAt: '2026-12-31' },
      targeting: { if: [{ '===': [{ var: 'account' }, 'test-account'] }, 'on', 'off'] },
    },
  },
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('릴리스 플래그', () => {
  it('BAS-060 정의에 없는 플래그와 꺼진 플래그는 거짓이다', async () => {
    const flags = await createReleaseFlags({ configPath: await config(valid) });
    expect(flags.getBoolean('checkout.new', false)).toBe(false);
    expect(flags.getBoolean('없는.플래그', false)).toBe(false);
    await flags.close();
  });

  it('BAS-060 대상 계정·기본 변형이 맞으면 켜진다', async () => {
    const flags = await createReleaseFlags({ configPath: await config(valid) });
    expect(flags.getBoolean('checkout.new', false, { account: 'test-account' })).toBe(true);
    expect(flags.getBoolean('checkout.new', false, { account: 'other' })).toBe(false);
    await flags.close();
  });

  it('BAS-060 정의 파일이 깨지면 모두 꺼짐으로 동작하고 던지지 않는다', async () => {
    const flags = await createReleaseFlags({ configPath: await config('{ not json') });
    expect(flags.getBoolean('checkout.new', false)).toBe(false);
    expect(flags.getBoolean('checkout.new', true)).toBe(false);
    await flags.close();
  });

  it('BAS-060 공급자 평가가 실패하면 기본값(꺼짐)으로 동작한다', async () => {
    const provider = {
      evaluate: vi.fn(() => {
        throw new Error('provider down');
      }),
    };
    const flags = await createReleaseFlags({ configPath: await config(valid), provider });
    expect(flags.getBoolean('checkout.new', false)).toBe(false);
    await flags.close();
  });

  it('BAS-060 평가는 네트워크를 부르지 않는다', async () => {
    const fetch = vi.fn(() => {
      throw new Error('network must not be called');
    }) as unknown as typeof globalThis.fetch;
    const flags = await createReleaseFlags({ configPath: await config(valid), fetch });
    expect(flags.getBoolean('checkout.new', false)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await flags.close();
  });

  it('BAS-060 정의는 소유자·만료일·기본 꺼짐이 없으면 거절한다', () => {
    expect(() => parseFlagDefinitions({ flags: { a: { state: 'ENABLED', variants: { on: true, off: false }, defaultVariant: 'off' } } })).toThrow(
      /FLAG_METADATA_REQUIRED/,
    );
    expect(() =>
      parseFlagDefinitions({
        flags: {
          a: {
            state: 'ENABLED',
            variants: { on: true, off: false },
            defaultVariant: 'on',
            metadata: { owner: 'lane1', expiresAt: '2026-12-31' },
          },
        },
      }),
    ).toThrow(/FLAG_DEFAULT_NOT_OFF/);
  });
});
