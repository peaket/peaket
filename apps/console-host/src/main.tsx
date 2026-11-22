// 관제 콘솔 진입점(docs/frontend.md §2.3). Module Federation 공유 싱글턴(react·react-dom)을 원격과 맞추려고 앱은 한 번 늦게 싣는다(webpack 비동기 경계, ADR-0360 결정 6).
// 한 앱 빌드(PEAKET_CONSOLE_BUILD=single)에서도 같은 경계를 둔다(두 빌드의 덩어리 차이를 줄인다, FE-T29).
void import('./bootstrap');
