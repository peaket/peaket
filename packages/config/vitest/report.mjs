// 시험 보고서 켜기(BUILD_ORDER BOT-162, tools/ci/asvs-report.mjs). CI가 PEAKET_TEST_REPORT에 파일 이름을 주면
// vitest가 화면 출력과 함께 그 이름의 JSON 보고서를 패키지 폴더에 남긴다. 없으면 아무것도 바꾸지 않는다(로컬 실행).
export function testReport() {
  const out = process.env.PEAKET_TEST_REPORT;
  if (!out) return {};
  return { reporters: ['default', 'json'], outputFile: { json: out } };
}
