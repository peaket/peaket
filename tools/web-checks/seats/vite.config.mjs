// 5만 석 좌석 화면 시험 페이지 빌드(S-T21·S-T31 ⑥, BAT-182). vite를 import하지 않고 설정 객체만 낸다
// (vite는 @peaket/seatmap의 개발 의존성이라 그 패키지 cwd에서 실행한다. 새 의존을 더하지 않는다).
import { fileURLToPath } from 'node:url';

export default {
  root: fileURLToPath(new URL('./page/', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist/', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: { format: 'es' },
};
