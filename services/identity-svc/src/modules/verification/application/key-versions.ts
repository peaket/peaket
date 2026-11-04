// 연계정보 키 판 설정 확인(docs/features/identity.md §5 '키 판·만 14세…', docs/security/secrets-and-keys.md 연계정보 행, 새 맥락 리뷰 중간 3).
// 기록이 쓰는 판을 설정이 모두 갖지 않으면 그 판의 기록을 조회하지 못해, 같은 사람이 계정을 하나 더 만들 수 있다. 그래서 그런 설정으로는 시작하지 않는다.
import type { IdentityHashers, VerificationStore } from '../domain/ports.js';

export async function assertKeyVersions(store: VerificationStore, hashers: IdentityHashers): Promise<void> {
  const configured = new Set(hashers.versions());
  const missing = (await store.ciKeyVersionsInUse()).filter((v) => !configured.has(v));
  if (missing.length > 0) {
    throw new Error(`연계정보 기록이 쓰는 키 판 ${missing.join('·')}이(가) 설정에 없다. 그 판의 키를 조회용으로 두기 전에는 시작하지 않는다(판 ${missing.join('·')})`);
  }
}
