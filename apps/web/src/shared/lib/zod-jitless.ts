// Zod의 eval 지원 감지(`Function("")`)가 캐시 화면의 해시 CSP에서 위반으로 보고된다. jitless면 그 감지를 건너뛴다
// (Zod v4 core/util.js의 `allowsEval`). 계약 모듈이 스키마를 만들며 처음 파싱하기 전에 이 모듈이 먼저 평가돼야 하므로
// 쓰는 쪽(sync.ts)의 첫 import로 둔다. CI 실행 45259875444·FE-T35.
import { z } from 'zod';

z.config({ jitless: true });
