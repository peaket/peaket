// 키 판 설정 확인(docs/features/identity.md §5 '키 판·만 14세…'·'pid 키 전환의 첫 구현', docs/security/secrets-and-keys.md 연계정보·pid 행).
// 연계정보: 기록이 쓰는 판을 설정이 모두 갖지 않으면 그 판의 기록을 조회하지 못해, 같은 사람이 계정을 하나 더 만들 수 있다(새 맥락 리뷰 중간 3).
// pid: 닫지 않은 전환의 판이나 기록이 쓰는 pid 판이 설정 판보다 크면, 옛 설정 파드가 처음 본인확인한 계정에 옛 판 pid를 남겨 전환 뒤 1인 1순번이 깨진다
// (BOT-025 새 맥락 리뷰 다시 보기 중간). 그래서 그런 설정으로는 시작하지 않는다.
import type { IdentityHashers, PidRotationStore, VerificationStore } from '../domain/ports.js';

export async function assertKeyVersions(store: VerificationStore & Pick<PidRotationStore, 'openPidRotation' | 'pidKeyVersionsInUse'>, hashers: IdentityHashers): Promise<void> {
  const configured = new Set(hashers.versions());
  const missing = (await store.ciKeyVersionsInUse()).filter((v) => !configured.has(v));
  if (missing.length > 0) {
    throw new Error(`연계정보 기록이 쓰는 키 판 ${missing.join('·')}이(가) 설정에 없다. 그 판의 키를 조회용으로 두기 전에는 시작하지 않는다(판 ${missing.join('·')})`);
  }
  const pid = hashers.pidVersion();
  const open = await store.openPidRotation();
  const newer = [...new Set([...(await store.pidKeyVersionsInUse()), ...(open ? [open.toVersion] : [])])].filter((v) => v > pid).sort((a, b) => a - b);
  if (newer.length > 0) throw new Error(`설정 pid 판 ${pid}보다 큰 pid 판 ${newer.join('·')}을(를) 기록이나 닫지 않은 전환이 쓴다. 새 pid 키·판으로 바꾸기 전에는 시작하지 않는다`);
}
