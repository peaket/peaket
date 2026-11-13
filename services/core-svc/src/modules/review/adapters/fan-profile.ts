// 시험용 팬 프로필. 시험이 계정별 닉네임을 넣는다. 운영은 identity-svc 팬 프로필 조회가 생길 때까지 '***'다.
import type { FanProfile } from '../domain/ports.js';

export class MemoryFanProfile implements FanProfile {
  readonly nicknames = new Map<string, string>();
  async nickname(accountId: string): Promise<string | undefined> {
    return this.nicknames.get(accountId);
  }
}

export class UnavailableFanProfile implements FanProfile {
  async nickname(): Promise<undefined> {
    return undefined;
  }
}
