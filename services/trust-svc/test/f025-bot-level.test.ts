// 명령 5(봇 판정 강도)의 trust-svc 읽는 쪽: 설정 저장소의 'PLATFORM:BOT_LEVEL:' 바뀜을 규칙 묶음의 강도로 잇는다
// (BUILD_ORDER F-02-5 OPS-300, ADR-0365 결정 13·19, docs/features/bot-defense.md §4.4 '프로필 = 강도 × 정렬'·'설정 읽기', 계획 B24·B25·8.4).
// - 정본 잇기: 계약 강도 RELAXED → 규칙 RELAXED, STANDARD → BASE, AGGRESSIVE → STRICT. 값 없음·만료·꼴 틀림(모르는 강도 포함)은 BASE이고 꼴 틀림은 경고 한 줄.
//   강도는 한 요청 안에서 한 번만 읽는다(ScoreRisk 그대로).
// - 진짜 부품: 공용 서버 패키지의 SettingsStore(받는 쪽 저장소), 규칙 묶음 RuleBook(합성 규칙 파일을 실제로 읽는다), ScoreRisk(판정).
//   합성 규칙(test/support.ts, POL-006 임의 값)의 기준값은 RELAXED 2·BASE 1·STRICT 0.5이고 가중치는 모두 1이다.
//   위험 합 0.8과 1.5 두 입력이면 세 강도의 판정 짝이 모두 다르다: RELAXED (ALLOW, ALLOW), BASE (ALLOW, CHALLENGE), STRICT (CHALLENGE, CHALLENGE).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeClock, SettingsStore, type SettingChanged } from '@peaket/platform';
import { beforeEach, describe, expect, test } from 'vitest';
import { BOT_LEVEL_SETTING_KEY, bindBotLevelSetting, intensityOfBotLevel, RuleBook } from '../src/modules/scoring/index.js';
import type { Scorer } from '../src/modules/scoring/domain/scorers.js';
import { request, SYNTHETIC_RULES_JSON, world } from './support.js';

/** 정본 메시지 키(ADR-0365 결정 13 표: 대상이 없어 끝이 비었다) */
const KEY = 'PLATFORM:BOT_LEVEL:';
const ACTOR = '3b0c8f5e-2d41-4a7e-9f10-6c2e1d4b8a77';
const SIX = ['HumanCheck', 'DeviceTrust', 'BehaviorScore', 'NetworkScore', 'AgeScore', 'ConsistencyScore'] as const;

let seq = 0;
/** ops-svc가 내는 꼴(asyncapi SettingChanged의 BotLevelValue, 플랫폼 해독기를 지난 값). 판은 9에서 시작해 두 자리로 넘어간다 */
function botLevel(value: unknown, o: { expiresAt?: number | null; version?: number } = {}): SettingChanged {
  seq += 1;
  return { commandId: `cmd-${seq}`, key: 'BOT_LEVEL', scope: 'PLATFORM', value, expiresAt: o.expiresAt ?? null, actor: ACTOR, occurredAt: o.version ?? 8 + seq, eventKey: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}` };
}
const level = (l: string, reassessMode = 'SHADOW') => ({ level: l, reassessMode });

/** 경고 기록(바인딩의 log 인자 꼴) */
function warnings(): { warn(o: object, m: string): void; lines: { o: object; m: string }[] } {
  const lines: { o: object; m: string }[] = [];
  return { lines, warn: (o, m) => void lines.push({ o, m }) };
}

let rulesFile: string;
beforeEach(() => {
  rulesFile = join(mkdtempSync(join(tmpdir(), 'trust-f025-')), 'rules.json');
  writeFileSync(rulesFile, SYNTHETIC_RULES_JSON);
});

/** 실제 규칙 파일을 읽은 규칙 묶음 + 그 강도를 읽는 판정기. riskOf가 위험 합을 정한다(NetworkScore 하나에 싣는다) */
async function harness(o: { onScore?: () => void } = {}) {
  const book = new RuleBook(rulesFile);
  expect(await book.refresh()).toBe(true);
  let risk = 0;
  const scorers: Scorer[] = SIX.map((n) => ({
    name: n,
    score: () => {
      if (n === 'AgeScore') o.onScore?.();
      return { name: n, risk: n === 'NetworkScore' ? risk : 0, reason: 'NETWORK' as const };
    },
  }));
  const w = world({ scorers, rules: book.current(), intensity: () => book.intensity() });
  const verdictAt = async (sum: number) => {
    risk = sum;
    return (await w.score.run(request())).verdict;
  };
  /** 위험 합 0.8과 1.5의 판정 짝 */
  const pair = async () => [await verdictAt(0.8), await verdictAt(1.5)];
  return { book, pair };
}

const PROFILE = {
  RELAXED: ['ALLOW', 'ALLOW'],
  BASE: ['ALLOW', 'CHALLENGE'],
  STRICT: ['CHALLENGE', 'CHALLENGE'],
} as const;

describe('F025-TRUST 명령 5 강도 적용(ADR-0365 결정 19)', () => {
  test('F025-TRUST ① 공개 키 이름은 정본 메시지 키다', () => {
    expect(BOT_LEVEL_SETTING_KEY).toBe(KEY);
  });

  test('F025-TRUST ① 시험 규칙의 세 강도는 같은 입력에 서로 다른 판정 짝을 낸다(대조)', async () => {
    const h = await harness();
    const got: Record<string, unknown> = {};
    for (const i of ['RELAXED', 'BASE', 'STRICT'] as const) {
      h.book.setIntensity(i);
      got[i] = await h.pair();
    }
    expect(got).toEqual(PROFILE);
  });

  test('F025-TRUST ① intensityOfBotLevel은 계약 강도를 규칙 강도 이름으로 잇는다(STANDARD → BASE, AGGRESSIVE → STRICT)', () => {
    expect(intensityOfBotLevel(level('RELAXED'))).toBe('RELAXED');
    expect(intensityOfBotLevel(level('STANDARD'))).toBe('BASE');
    expect(intensityOfBotLevel(level('AGGRESSIVE'))).toBe('STRICT');
    // 재평가 모드는 강도에 영향이 없다
    expect(intensityOfBotLevel(level('AGGRESSIVE', 'ENFORCE'))).toBe('STRICT');
    expect(intensityOfBotLevel(level('RELAXED', 'OFF'))).toBe('RELAXED');
  });

  test('F025-TRUST ② intensityOfBotLevel은 값 없음·모르는 강도·꼴 틀림에 BASE다(던지지 않는다)', () => {
    for (const bad of [undefined, null, {}, level('EXTREME'), level('standard'), level('BASE'), level('STRICT'), { level: 2 }, 'AGGRESSIVE', ['AGGRESSIVE'], 7]) {
      expect(intensityOfBotLevel(bad), JSON.stringify(bad)).toBe('BASE');
    }
  });

  test('F025-TRUST ① BOT_LEVEL 사건을 받으면 다음 ScoreRisk부터 그 강도의 프로필로 판정하고, 바뀜마다 따라간다', async () => {
    const h = await harness();
    const settings = new SettingsStore(fakeClock({ now: Date.UTC(2026, 10, 23, 1) }));
    const log = warnings();
    bindBotLevelSetting(settings, h.book, log);
    expect(await h.pair()).toEqual(PROFILE.BASE);
    settings.apply(KEY, botLevel(level('AGGRESSIVE')));
    expect(h.book.intensity()).toBe('STRICT');
    expect(await h.pair()).toEqual(PROFILE.STRICT);
    settings.apply(KEY, botLevel(level('RELAXED')));
    expect(h.book.intensity()).toBe('RELAXED');
    expect(await h.pair()).toEqual(PROFILE.RELAXED);
    settings.apply(KEY, botLevel(level('STANDARD')));
    expect(h.book.intensity()).toBe('BASE');
    expect(await h.pair()).toEqual(PROFILE.BASE);
    expect(log.lines).toEqual([]);
  });

  test('F025-TRUST ① 묶기 전에 저장소에 있던 값을 바로 반영한다(시작 때 읽은 압축 토픽의 마지막 값)', async () => {
    const h = await harness();
    const settings = new SettingsStore(fakeClock({ now: Date.UTC(2026, 10, 23, 1) }));
    settings.apply(KEY, botLevel(level('AGGRESSIVE')));
    bindBotLevelSetting(settings, h.book);
    expect(h.book.intensity()).toBe('STRICT');
    expect(await h.pair()).toEqual(PROFILE.STRICT);
  });

  test('F025-TRUST ① 요청 도중 강도가 바뀌어도 그 요청은 시작 때의 강도로 판정하고, 다음 요청부터 새 강도다', async () => {
    let settings!: SettingsStore;
    let fired = false;
    const h = await harness({
      onScore: () => {
        if (fired) return;
        fired = true;
        settings.apply(KEY, botLevel(level('AGGRESSIVE')));
      },
    });
    settings = new SettingsStore(fakeClock({ now: Date.UTC(2026, 10, 23, 1) }));
    bindBotLevelSetting(settings, h.book);
    settings.apply(KEY, botLevel(level('STANDARD')));
    // 합 0.8: 시작 강도 BASE면 ALLOW, 도중에 바뀐 STRICT를 쓰면 CHALLENGE
    const [during] = await h.pair();
    expect(fired).toBe(true);
    expect(during).toBe('ALLOW');
    expect(h.book.intensity()).toBe('STRICT');
    expect(await h.pair()).toEqual(PROFILE.STRICT);
  });

  test('F025-TRUST ② 값이 없으면 BASE다(묶기 전 강도가 무엇이든)', async () => {
    const h = await harness();
    h.book.setIntensity('STRICT');
    bindBotLevelSetting(new SettingsStore(fakeClock()), h.book);
    expect(h.book.intensity()).toBe('BASE');
    expect(await h.pair()).toEqual(PROFILE.BASE);
  });

  test('F025-TRUST ② 만료된 값은 BASE로 돌아간다(만료 1ms 전은 그 강도)', async () => {
    const h = await harness();
    const clock = fakeClock({ now: Date.UTC(2026, 10, 23, 1) });
    const settings = new SettingsStore(clock);
    bindBotLevelSetting(settings, h.book);
    settings.apply(KEY, botLevel(level('AGGRESSIVE'), { expiresAt: clock.now() + 7_000 }));
    clock.advance(6_999);
    settings.sweep();
    expect(h.book.intensity()).toBe('STRICT');
    clock.advance(1);
    // 다시 맞춤 주기가 만료를 알린다
    settings.sweep();
    expect(h.book.intensity()).toBe('BASE');
    expect(await h.pair()).toEqual(PROFILE.BASE);
  });

  test('F025-TRUST ② 모르는 강도·꼴 틀린 값은 BASE이고 사건마다 경고 한 줄이며 던지지 않는다', async () => {
    const h = await harness();
    const settings = new SettingsStore(fakeClock({ now: Date.UTC(2026, 10, 23, 1) }));
    const log = warnings();
    bindBotLevelSetting(settings, h.book, log);
    settings.apply(KEY, botLevel(level('AGGRESSIVE')));
    expect(h.book.intensity()).toBe('STRICT');
    expect(() => settings.apply(KEY, botLevel(level('EXTREME')))).not.toThrow();
    expect(h.book.intensity()).toBe('BASE');
    expect(log.lines).toHaveLength(1);
    settings.apply(KEY, botLevel(level('AGGRESSIVE')));
    expect(() => settings.apply(KEY, botLevel('AGGRESSIVE'))).not.toThrow();
    expect(h.book.intensity()).toBe('BASE');
    expect(log.lines).toHaveLength(2);
    // 판정은 멈추지 않는다
    expect(await h.pair()).toEqual(PROFILE.BASE);
  });

  test('F025-TRUST ② 되돌리기 사건(직전 값의 새 판)을 받으면 그 강도로 돌아간다', async () => {
    const h = await harness();
    const settings = new SettingsStore(fakeClock({ now: Date.UTC(2026, 10, 23, 1) }));
    bindBotLevelSetting(settings, h.book);
    settings.apply(KEY, botLevel(level('RELAXED'), { version: 9 }));
    settings.apply(KEY, botLevel(level('AGGRESSIVE'), { version: 10 }));
    expect(h.book.intensity()).toBe('STRICT');
    // 되돌리기는 지우는 표시가 아니라 직전 값(RELAXED)의 새 사건이다(ADR-0365 결정 13)
    settings.apply(KEY, botLevel(level('RELAXED'), { version: 11 }));
    expect(h.book.intensity()).toBe('RELAXED');
    expect(await h.pair()).toEqual(PROFILE.RELAXED);
  });

  test('F025-TRUST ① 다른 키의 바뀜은 강도를 건드리지 않는다', async () => {
    const h = await harness();
    const settings = new SettingsStore(fakeClock({ now: Date.UTC(2026, 10, 23, 1) }));
    bindBotLevelSetting(settings, h.book);
    settings.apply(KEY, botLevel(level('AGGRESSIVE')));
    settings.apply('PLATFORM:LOG_LEVEL:trust-svc', { ...botLevel({ level: 'DEBUG' }), key: 'LOG_LEVEL' });
    settings.apply('ev-1:BOT_LEVEL:', botLevel(level('RELAXED')));
    expect(h.book.intensity()).toBe('STRICT');
  });

  test('F025-TRUST ② 돌려준 함수로 끊은 뒤의 바뀜은 무시한다', async () => {
    const h = await harness();
    const settings = new SettingsStore(fakeClock({ now: Date.UTC(2026, 10, 23, 1) }));
    const unbind = bindBotLevelSetting(settings, h.book);
    settings.apply(KEY, botLevel(level('AGGRESSIVE')));
    unbind();
    settings.apply(KEY, botLevel(level('RELAXED')));
    expect(h.book.intensity()).toBe('STRICT');
  });
});

// 시작 파일(src/main.ts)이 제어 설정 저장소를 규칙 묶음에 잇는지 소스 경계로 본다(시험 조립은 잇지 않아도 통과한다, BAT-195 '시작 파일 조립은 따로').
describe('F025-TRUST ③ trust-svc 시작 파일 조립(계획 13절 마지막 줄)', () => {
  const CODE = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');

  test('F025-TRUST ③ 시작 파일은 제어 설정 저장소와 규칙 묶음을 bindBotLevelSetting으로 한 번 잇고, 그것이 설정 읽기 시작 뒤·listen 앞이다', () => {
    const calls = [...CODE.matchAll(/bindBotLevelSetting\(([^;]*?)\)/g)].map((m) => m[1]!);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/controlSync\??\.sync\.settings/);
    expect(calls[0]).toMatch(/\brules\b/);
    const at = CODE.indexOf('bindBotLevelSetting(');
    expect(at).toBeGreaterThan(CODE.indexOf('const controlSync = startServiceControlSync('));
    expect(at).toBeLessThan(CODE.indexOf('await service.listen('));
    // 판정기는 같은 규칙 묶음을 읽는다(강도를 바꿔도 다른 묶음을 보면 효력이 없다)
    expect(CODE).toMatch(/new ScoreRisk\(\{\s*rules,/);
  });
});
