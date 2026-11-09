// 비공개 규칙 설정(docs/features/bot-defense.md §4.4, B-T3·POL-006): 값은 저장소 밖에서 주입하고, 코드는 설정 이름과 판 번호만 안다.
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { RuleBook } from '../src/modules/scoring/adapters/rule-book.js';
import { parseRuleSet } from '../src/modules/scoring/domain/rules.js';
import { SYNTHETIC_RULES_JSON } from './support.js';

interface Broken {
  intensities: { BASE: { ON: { threshold: number; weights: Record<string, number> } } };
}
const parse = (): Broken => JSON.parse(SYNTHETIC_RULES_JSON) as Broken;

describe('규칙 형식', () => {
  test('B-T22③_sharedAt이공유수상한20을넘는판은읽지않는다_위험이기준끝에닿을수없다', () => {
    const withSharedAt = (sharedAt: number) => {
      const raw = JSON.parse(SYNTHETIC_RULES_JSON) as { params: { device: { sharedAt: number } } };
      raw.params.device.sharedAt = sharedAt;
      return JSON.stringify(raw);
    };
    expect(() => parseRuleSet(withSharedAt(21))).toThrow(/params\.device/);
    expect(parseRuleSet(withSharedAt(20)).params.device.sharedAt).toBe(20);
  });

  test('강도 셋·정렬 셋·점수기 여섯의 가중치가 모두 있어야 한다', () => {
    const broken = parse();
    delete broken.intensities.BASE.ON.weights.HumanCheck;
    expect(() => parseRuleSet(JSON.stringify(broken))).toThrow();
  });

  test('기준값이 0 이하이거나 가중치가 음수면 읽지 않는다', () => {
    const zero = parse();
    zero.intensities.BASE.ON.threshold = 0;
    expect(() => parseRuleSet(JSON.stringify(zero))).toThrow();
    const negative = parse();
    negative.intensities.BASE.ON.weights.HumanCheck = -1;
    expect(() => parseRuleSet(JSON.stringify(negative))).toThrow();
  });

  test('B-T3_오류문구에규칙값을싣지않는다', () => {
    const broken = parse();
    broken.intensities.BASE.ON.threshold = -987654;
    let message = '';
    try {
      parseRuleSet(JSON.stringify(broken));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('987654');
  });
});

describe('낮음12 전원 ALLOW를 막는 검사', () => {
  test('낮음12_가중치가전부0이면읽지않는다', () => {
    const broken = parse();
    for (const k of Object.keys(broken.intensities.BASE.ON.weights)) broken.intensities.BASE.ON.weights[k] = 0;
    expect(() => parseRuleSet(JSON.stringify(broken))).toThrow();
  });

  test('재검토5_가중치합이부동소수점오차로만기준값보다작으면읽는다', () => {
    const near = parse();
    for (const k of Object.keys(near.intensities.BASE.ON.weights)) near.intensities.BASE.ON.weights[k] = 0;
    near.intensities.BASE.ON.weights.HumanCheck = 0.7;
    near.intensities.BASE.ON.weights.DeviceTrust = 0.1;
    near.intensities.BASE.ON.threshold = 0.8;
    expect(0.7 + 0.1).toBeLessThan(0.8);
    expect(() => parseRuleSet(JSON.stringify(near))).not.toThrow();
  });

  test('낮음12_가중치합이기준값보다작으면읽지않는다', () => {
    const broken = parse();
    for (const k of Object.keys(broken.intensities.BASE.ON.weights)) broken.intensities.BASE.ON.weights[k] = 0.1;
    broken.intensities.BASE.ON.threshold = 1;
    expect(() => parseRuleSet(JSON.stringify(broken))).toThrow();
  });
});

describe('다시 읽기', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'trust-rules-'));
  const logs = () => {
    const warnings: string[] = [];
    return { warnings, warn: (m: string) => void warnings.push(m) };
  };

  test('처음읽지못하면current는null이고_준비되지않는다', async () => {
    const book = new RuleBook(join(dir(), 'missing.json'));
    await expect(book.refresh()).resolves.toBe(false);
    expect(book.current()).toBeNull();
  });

  test('새판을읽으면바꾸고_깨진파일이면마지막판을쓴다', async () => {
    const file = join(dir(), 'rules.json');
    writeFileSync(file, SYNTHETIC_RULES_JSON);
    const log = logs();
    const book = new RuleBook(file, log);
    expect(await book.refresh()).toBe(true);
    expect(book.current()?.version).toBe(7);
    writeFileSync(file, '{ 깨진 파일');
    await expect(book.refresh()).resolves.toBe(true);
    expect(book.current()?.version).toBe(7);
    expect(log.warnings).toHaveLength(1);
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(SYNTHETIC_RULES_JSON) as object), version: 8 }));
    await book.refresh();
    expect(book.current()?.version).toBe(8);
  });

  test('강도기본은BASE이고_설정한강도를돌려준다', () => {
    const book = new RuleBook('x');
    expect(book.intensity()).toBe('BASE');
    book.setIntensity('STRICT');
    expect(book.intensity()).toBe('STRICT');
  });
});

describe('B-T3 공개 저장소 검사', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name === 'dist' || name === '.turbo' || name.startsWith('test-report')) return [];
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });

  test('B-T3_서비스폴더에규칙값을담은설정파일이없다', () => {
    const configs = walk(root).filter((f) => /\.(json|ya?ml)$/.test(f));
    expect(configs.map((f) => f.slice(root.length).replaceAll('\\', '/')).sort()).toEqual(['package.json', 'tsconfig.build.json', 'tsconfig.json']);
  });

  test('B-T3_제품코드에가중치·기준값숫자가없다', () => {
    const source = walk(join(root, 'src')).filter((f) => f.endsWith('.ts'));
    expect(source.length).toBeGreaterThan(0);
    const offending = source.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return (
        /(?<![.\w])(threshold|weights?|accountsFrom|accountsAt|entropyLow|entropyHigh|intervalStdLow|intervalStdHigh|hosting|proxy|mismatch|cookieYoungMs|cookieOldMs)\s*[:=]\s*-?\d/.test(text) ||
        /\b(HumanCheck|DeviceTrust|BehaviorScore|NetworkScore|AgeScore|ConsistencyScore)\s*:\s*-?\d/.test(text)
      );
    });
    expect(offending).toEqual([]);
  });
});
