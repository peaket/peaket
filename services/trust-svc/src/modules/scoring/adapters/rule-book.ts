// 비공개 규칙 설정을 파일에서 읽는다(docs/features/bot-defense.md §4.4). 파일은 비밀 관리(External Secrets)가 넣는다. 읽지 못하면 마지막으로 읽은 판을 쓴다.
// 명령 5(강도)는 setIntensity로 바꾼다. 제어 토픽 control.settings 연결은 뒤 단계다.
import { readFile } from 'node:fs/promises';
import type { RuleSource } from '../domain/ports.js';
import { parseRuleSet, type RuleSet } from '../domain/rules.js';
import type { Intensity } from '../domain/types.js';

export class RuleBook implements RuleSource {
  #current: RuleSet | null = null;
  #intensity: Intensity = 'BASE';

  constructor(
    private readonly file: string,
    private readonly log: { warn(message: string): void } = { warn: () => undefined },
  ) {}

  current(): RuleSet | null {
    return this.#current;
  }

  intensity(): Intensity {
    return this.#intensity;
  }

  setIntensity(next: Intensity): void {
    this.#intensity = next;
  }

  /** 다시 읽는다. 읽지 못하면 마지막 판을 그대로 둔다. 쓸 수 있는 판이 있으면 true */
  async refresh(): Promise<boolean> {
    try {
      this.#current = parseRuleSet(await readFile(this.file, 'utf8'));
    } catch (e) {
      // 문구에는 파일 내용이 없다(parseRuleSet이 칸 이름만 싣는다)
      if (this.#current) this.log.warn(`비공개 규칙 설정을 다시 읽지 못해 마지막 판을 쓴다: ${e instanceof Error ? e.message : '알 수 없는 오류'}`);
      else this.log.warn(`비공개 규칙 설정을 읽지 못했다: ${e instanceof Error ? e.message : '알 수 없는 오류'}`);
    }
    return this.#current !== null;
  }
}
