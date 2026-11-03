// 경로 파일은 다시 내보내기만 한다(구현은 src/_app). 파트너 콘솔은 요청마다 셸을 그린다(docs/frontend.md §2.5 '파트너 콘솔 전 경로').
// 셸이 ?state=·?theme=·?role=을 읽으므로 이 묶음은 정적 미리 만들기를 하지 않는다.
export { default } from '@/_app/layouts/ConsoleLayout';
export const dynamic = 'force-dynamic';
