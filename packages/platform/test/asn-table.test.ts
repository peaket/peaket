// ASN 분류표(docs/features/bot-defense.md §3.1, B-T7): 읽기, 마지막 판 유지, 분류.
import { describe, expect, test } from 'vitest';
import { fakeClock, parseAsnTable, ReloadingAsnTable } from '../src/index.js';

const TABLE = JSON.stringify({ version: '2026-11-09', hosting: [16509, 14618], proxy: [9009] });
const table = (load: () => Promise<string | undefined>, onError?: (r: string) => void) => new ReloadingAsnTable({ load, clock: fakeClock({ now: 1 }), ...(onError ? { onError } : {}) });

describe('ASN 분류표', () => {
  test('B-T7_목록대로호스팅·프록시·그밖으로나눈다', async () => {
    const t = table(async () => TABLE);
    await t.refresh();
    expect(t.version()).toBe('2026-11-09');
    expect(t.classify(16509)).toBe('HOSTING');
    expect(t.classify(9009)).toBe('PROXY');
    expect(t.classify(4766)).toBe('OTHER');
  });

  test('B-T7③_ASN이없거나분류표를못읽었으면그밖이다', async () => {
    const empty = table(async () => undefined);
    await empty.refresh();
    expect(empty.classify(16509)).toBe('OTHER');
    const t = table(async () => TABLE);
    await t.refresh();
    expect(t.classify(0)).toBe('OTHER');
  });

  test('B-T7②_읽지못하면마지막판을쓰고_이유를알린다', async () => {
    const seen: string[] = [];
    let text = TABLE;
    const t = table(async () => text, (r) => void seen.push(r));
    await t.refresh();
    text = '{깨진';
    await t.refresh();
    expect(t.classify(16509)).toBe('HOSTING');
    expect(seen).toHaveLength(1);
  });

  test('형식이틀린파일은읽지않는다', () => {
    expect(() => parseAsnTable('{"version":"v","hosting":[-1],"proxy":[]}')).toThrow();
    expect(() => parseAsnTable('{"version":"","hosting":[],"proxy":[]}')).toThrow();
    expect(() => parseAsnTable('{"version":"v","hosting":[],"proxy":"x"}')).toThrow();
  });
});
