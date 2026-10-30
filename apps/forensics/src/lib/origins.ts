// 다른 앱 주소(브리프 공통 규칙 '이동 링크'). 개발 서버에서만 관제 개발 서버(포트 3002)로 잇는다.
// 운영 빌드는 공개 환경값 VITE_CONSOLE_ORIGIN을 쓰고, 값이 없으면 정본 호스트 이름이다(docs/frontend.md §2.1).
// import.meta.env.DEV는 빌드 때 글자로 바뀌어, 운영 묶음에는 개발 주소가 남지 않는다.
const env: string | undefined = import.meta.env.VITE_CONSOLE_ORIGIN;

export const CONSOLE_ORIGIN: string = env || (import.meta.env.DEV ? 'http://localhost:3002' : 'https://console.peaket.example');
