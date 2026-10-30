#!/usr/bin/env node
// 공용 CI 요약(필수 검사 ci-summary, docs/devops.md §3.1 3번, openspec 변경 add-ci-foundation).
// 앞선 잡이 하나라도 실패하거나 취소되면 실패한다. 건너뛴 잡은 실패가 아니다.
// 그래서 문서만 바꾼 PR도 필수 검사가 '대기'로 남지 않는다(D-T47 ①).
// 쓰는 법: NEEDS='${{ toJSON(needs) }}' node tools/ci/ci-summary.mjs
let needs;
try {
  needs = JSON.parse(process.env.NEEDS ?? '');
} catch {
  needs = null;
}
// 잡 결과를 읽지 못하면 통과로 두지 않는다
if (!needs || typeof needs !== 'object' || Object.keys(needs).length === 0) {
  console.log('실패: 앞선 잡의 결과(NEEDS)를 읽지 못했다');
  process.exit(1);
}
const bad = [];
for (const [job, { result }] of Object.entries(needs)) {
  console.log(`${job}: ${result}`);
  if (result !== 'success' && result !== 'skipped') bad.push(job);
}
if (bad.length) {
  console.log(`실패: 성공하지 못한 잡: ${bad.join(', ')}`);
  process.exit(1);
}
console.log('통과');
