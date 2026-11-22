#!/usr/bin/env node
// 불변식 검사기 명령. 시험이 끝난 뒤 돌린다(docs/verification.md §2.5).
//   INVARIANT_CHECK_DB_URL=… INVARIANT_PURCHASE_DB_URL=… INVARIANT_PAYMENT_DB_URL=… INVARIANT_TICKET_DB_URL=… \
//     peaket-invariants --out <성능 장부 실행 폴더> [--records <시험 기록.ndjson>] [--enqueue-within-sec 60] [--issue-deadline-min 30]
// 결과: <out>/invariants.csv(건수), <out>/invariants-detail.ndjson(위반 행, Git에 두지 않음). 하나라도 FAIL이면 종료 코드 1.
// 표준 출력 끝에 요약 한 줄, 붙은 원본에 표가 없어 건너뛴 불변식은 표준 오류에 경고 한 줄(종료 코드는 바꾸지 않는다). 몸은 cli-main.ts의 runCli다.
import { runCli } from './cli-main.js';

runCli(process.argv.slice(2), process.env, { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }).then((code) => process.exit(code));
