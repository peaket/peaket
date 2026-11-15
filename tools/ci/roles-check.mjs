#!/usr/bin/env node
// 합치기 전 역할 확인(ADR-0270 결정 5, docs/architecture.md §8.6의 4 '역할 나누기', 계획 docs/review/plans/W7-L1-roles-check.md).
// 지금은 시험 담당이 둔 빈 뼈대다. 동작은 구현 담당이 쓴다. 시험은 tools/ci/roles-check.test.mjs.
//
// 공개 인터페이스(계획 §1, 내놓는 함수는 없다):
//   node tools/ci/roles-check.mjs [--base <리비전>] [--head <리비전>] [--root <저장소>]
//     --base  기본 origin/develop. 여기서 닿는 커밋은 보지 않는다
//     --head  기본 HEAD. 합칠 작업 가지의 끝
//     --root  기본 지금 폴더. git 저장소 뿌리
//   끝 코드: 0 모든 검사 통과, 1 검사 하나라도 실패(실패를 모두 찍은 뒤), 2 실행할 수 없음(인자·리비전·git 오류, 빈 범위)
//   표준 출력(한 줄에 하나):
//     실패: [<검사 이름>] <묶음 ID 또는 -> <짧은 해시 또는 -> <까닭>
//     묶음 <ID>: <코드|문서|기록만> 커밋 <k>개(plan a·test b·impl c·review d·review-fix e·verify f·record g·doc h)
//     통과: 묶음 <N>개, 커밋 <M>개
//     오류: <까닭>
//   GITHUB_ACTIONS=true이면 앞머리 대신 ::error::를 쓰고 값의 %·줄바꿈을 바꿔 쓴다.
process.stderr.write('roles-check: 아직 없음\n');
process.exit(99);
