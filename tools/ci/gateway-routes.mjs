#!/usr/bin/env node
// openapi → API 호스트 HTTPRoute 생성기(BUILD_ORDER HOT-410, docs/infra.md §4.1 '경로별 메서드·한도·게이트웨이 오류', D-T42,
// docs/security/asvs/delivery.md 3.5.3). 묶음 BAT-060 계획 §5 '공개 인터페이스'의 뼈대다. 동작은 구현 담당이 쓴다.
// 쓰는 법: node tools/ci/gateway-routes.mjs --write | --check [--root <폴더>]
//   --write  생성 파일 deploy/gateways/<게이트웨이>.routes.yaml을 쓴다
//   --check  쓰지 않고 견준다. 다르면 바뀐 파일 이름과 첫 차이 줄을 보이고 1로 끝난다
//   --root   저장소 뿌리(기본은 이 파일의 두 단계 위). 시험이 임시 폴더를 가리킬 때 쓴다
// 입력: <root>/docs/api/openapi.yaml, 라우트 원천 <root>/deploy/gateways/routes/<게이트웨이>.yaml
// 끝 코드: 0 같음·씀, 1 --check에서 다름, 2 멈춤(docs/infra.md §4.1 '생성기가 멈추는 경우', 까닭을 한 줄씩)·인자 오류
import { runIfMain } from './entry.mjs';

/**
 * openapi와 라우트 원천으로 생성 파일들을 만든다.
 * @param {{ openapi: Record<string, any>, sources: Record<string, Array<Record<string, any>>> }} input
 *   openapi: 해석한 openapi 객체. sources: 게이트웨이 이름(gw-fan 등) → 그 원천 파일의 HTTPRoute 객체 목록
 * @returns {{ files: Map<string, string>, problems: string[] }} files: 저장소 뿌리 기준 상대 경로(deploy/gateways/<게이트웨이>.routes.yaml) → 글,
 *   problems: 멈추는 까닭(한 줄씩, 비면 멈추지 않음)
 */
export function generateRoutes(input) {
  void input;
  throw new Error('generateRoutes: 아직 없음(BAT-060 구현 몫)');
}

await runIfMain(import.meta.url, () => {
  console.error('gateway-routes: 아직 없음(BAT-060 구현 몫)');
  return 2;
});
