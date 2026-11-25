// F-03-6(FE-T29) 격리 시험 준비. 두 운영 빌드를 만들고 미리보기 포트가 비었는지 본다.
// 빌드는 한 번만 하고 reports/console-baseline/builds/에 둔다(다시 만들려면 --force로 measure.mjs를 먼저 돌리거나 폴더를 지운다).
import { assertPortsFree, buildBoth } from './stage.mjs';

export default async function globalSetup() {
  await assertPortsFree();
  const built = buildBoth();
  for (const [build, r] of Object.entries(built)) {
    if (r.built) console.log(`[console-baseline] ${build} 빌드 ${r.ms}ms`);
    else console.log(`[console-baseline] ${build} 빌드 재사용: ${r.dir}`);
  }
}
