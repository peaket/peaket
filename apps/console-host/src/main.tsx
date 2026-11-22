// 관제 콘솔 진입점(docs/frontend.md §2.3). Module Federation 공유 싱글턴(react·react-dom)을 원격과 맞추려고 앱은 한 번 늦게 싣는다(webpack 비동기 경계, ADR-0360 결정 6).
// 한 앱 빌드(PEAKET_CONSOLE_BUILD=single)에서도 같은 경계를 둔다(두 빌드의 덩어리 차이를 줄인다, FE-T29).
// 전역 CSS(층 순서 선언이 맨 앞)는 경계 밖 진입 덩어리에서 가져온다: 첫 HTML이 그 CSS를 싣고, 부품 CSS(늦은 덩어리)보다 먼저 층 순서를 정한다(d2 §1, FE-T36).
// CSS는 공유 모듈이 아니라 비동기 경계 앞에 두어도 협상과 상관없다.
import './app/styles.css';

void import('./bootstrap');
