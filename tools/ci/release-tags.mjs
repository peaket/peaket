// 출시 태그 규칙(docs/devops.md §2.2.5): vX.Y.Z(앞자리 0 없음). release-plan.mjs와 contract-breaking.mjs가 함께 쓴다.
export const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const semver = (s) => s.split('.').map(Number);
export const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** 태그 이름 목록에서 출시 태그만 골라 SemVer 차례로(가장 큰 것이 앞) {name, v}를 돌려준다 */
export function sortReleaseTags(names) {
  return names.filter((t) => TAG.test(t))
    .map((t) => ({ name: t, v: semver(t.slice(1)) }))
    .sort((a, b) => compare(b.v, a.v));
}
