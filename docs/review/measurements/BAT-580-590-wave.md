# BAT-580·BAT-590 웨이브 끝 비싼 검사

- **무엇**: 웨이브 4 두 배치(BAT-580 LCH-190, BAT-590 LCH-180·LCH-185)의 `heavy gate go` 결과다.
- **가지**: `wave/lane2-BAT-580-590`. `origin/develop` `1dbc4753`(R-525 BAT-090 포함) 위로 rebase했고, 커밋은 R-527·R-529 둘이다(새 R 번호 없음).
- **정본**: docs/BUILD_ORDER.md BAT-580·BAT-590, docs/frontend.md §5.12, docs/review/plans/BAT-580.md·BAT-590.md, docs/review/legal/BAT-590-legal-review.md.
- **DB 변경**: 없음. test-int는 필수 아님. Docker·측정은 쓰지 않았다(갈래 1 BAT-090이 이미 합쳐짐).

## 1. 게이트 요약

| 게이트 | 결과 |
| --- | --- |
| rebase | 성공. `origin/develop` `1dbc4753` 위 R-527·R-529, 충돌 없음 |
| 브라우저 확인 | 통과. 로케일 로그인 3·공연 상세 3·정책 문서 5. 자세한 것은 docs/review/browser-check/BAT-580-590.md |
| 변이 | 22개 넣어 22개 잡음(첫 회 M16 1개 놓침 → 시험 보강 뒤 잡음) |
| 4관점 리뷰 | 높음 0·중간 5(모두 고침)·낮음 3(남김) |
| apps/web 단위 | 813개 통과 |
| typecheck | 통과 |
| Next build | 통과(로케일 로그인·공연 상세 경로 생성 확인) |
| i18n-check | 통과(키 1, machine en·ja·zh, native ko) |
| tools/ci 시험 | 5개 통과(i18n-check 3, policy-check 2) |
| 뿌리 lint | 통과 |
| doc-check | 오류 0, 경고 4(기존 openapi 3·mermaid 건너뜀 1) |
| ledger `--batch BAT-580 --require` | 통과(2항목: 자동 1·사람 1, 빈칸 0) |
| ledger `--batch BAT-590 --require` | 통과(1항목: 사람 1, 빈칸 0) |
| ledger `--check` | 통과(재생성 뒤) |
| trace-check | 4 ID 통과(FE-T18 8·v5.0.0-1.3.10 1·LCH-180 7·LCH-185 7, 시험 27개) |
| records `--check` | 통과(과거 R-374·R-473 경고만) |

- `ledger --check`는 BAT-090/R-525가 합쳐진 뒤 낡은 집계(`verification-tools.md`)를 잡았다. `node tools/ci/ledger.mjs`로 다시 쓰고 통과했다.
- trace-check는 `src/_pages/seats/model/seat-list.test.mjs`의 FE-T18 시험을 포함해 다시 만들었다.

## 2. 변이 22개

변이를 잠시 넣고 해당 시험을 돌린 뒤 `git checkout`으로 되돌렸다(커밋에 남기지 않는다).

| 변이 | 시험 | 결과 |
| --- | --- | --- |
| isLocale이 항상 참 | catalog.test | 잡음 |
| localePath가 접두를 뺌 | catalog.test | 잡음 |
| hreflang ja가 /en을 가리킴 | catalog.test | 잡음 |
| translate가 모르는 자리를 지움 | catalog.test | 잡음 |
| 한국어 알림 제외 삭제 | catalog.test | 잡음 |
| en review를 unknown으로 | i18n-check | 잡음 |
| en review를 native로 | catalog.test | 잡음 |
| 키 목록 검사 끔 | i18n-check.test | 잡음 |
| review 값 검사 끔 | i18n-check.test | 잡음 |
| 빈 문구 검사 약화 | i18n-check.test | 잡음 |
| `{자리}` 검사 끔 | i18n-check.test | 잡음 |
| 로그인 알림 삭제 | integration.test | 잡음 |
| 상세 알림 데이터 삭제 | integration.test | 잡음 |
| 예매 바 알림 삭제 | integration.test | 잡음 |
| 로그인 ko 가드 삭제 | integration.test | 잡음 |
| 상세 ko 가드 삭제 | integration.test | **첫 회 놓침** → `notFound()`까지 보는 시험으로 보강 뒤 잡음 |
| 상세 canonical에서 로케일 삭제 | integration.test | 잡음 |
| 정책 링크를 `#`으로 | policy-page.test | 잡음 |
| 정책 링크를 없는 문서로 | model.test | 잡음 |
| 처리방침 절 id 변경 | model.test | 잡음 |
| 약관 절 id 변경 | model.test | 잡음 |
| 알림 `lang` 삭제 | integration.test | 잡음 |

## 3. 4관점 리뷰

- **보안(높음 0·중간 0·낮음 1)**: 로케일 경로는 `isLocale`로 닫고 ko 접두를 404로 막는다. 알림 `lang`은 검증된 로케일 유니온에서만 온다. `translate`는 사용자 값을 함수 치환으로만 넣어 형식 문자열 주입이 없다(ASVS 1.3.10). 낮음: 공연 상세의 기존 CSP `frame-src 'none'` 경고는 이번 범위 밖이다.
- **정합(높음 0·중간 2·낮음 2)**: 중간 ① 번역 알림에 `lang`이 없어 낭독기가 영어·일본어·중국어 문구를 한국어로 읽었다. 알림에만 `lang`을 달아 고쳤다(WCAG 3.1.2). 중간 ② BAT-090/R-525가 합쳐진 뒤 장부 집계가 낡아 `ledger --check`가 실패했다. ledger를 다시 쓰고 고쳤다. 낮음: 화면 뼈대가 한국어인 동안 문서 `lang`은 `ko`로 둔다(전체 i18n 단계). `hreflang`은 상대 주소라 문서 기준으로 풀린다.
- **시험(높음 0·중간 3·낮음 0)**: 중간 ① i18n-check의 빈 문구·`{자리}` 분기가 시험에 없었다. ② review 정책(ko native, en·ja·zh machine)을 고정하는 시험이 없었다. ③ 로케일 ko 가드·로케일 canonical·정책 링크 렌더를 보는 시험이 없었다. 모두 시험을 더해 변이로 확인했다.
- **운영(높음 0·중간 0·낮음 0)**: 새 환경 변수·DB·서비스가 없다. 로케일 로그인은 기존 요청 화면(B) CSP, 로케일 공연 상세는 기존 ISR(A) CSP 변형을 그대로 쓴다. 빌드에서 두 로케일 경로가 생성됐다.

## 4. 남은 문제

1. 전체 화면 문구의 i18next 연결과 로케일별 문서 `lang`은 다국어 단계 몫이다. 지금은 번역문에만 `lang`을 단다.
2. en·ja·zh는 원어민 검토 전이라 `review: machine`을 유지한다.
3. NVDA·VoiceOver·TalkBack 사람 확인은 소유자 몫이다(docs/review/manual-a11y/LCH-190.md).
4. BAT-590의 내부 관리계획 §8 사람 칸·대표자 승인, 사업자 정보, 변호사 검토 제출은 소유자 몫이다.
5. 공연 상세의 기존 CSP `frame-src 'none'` 경고와 로컬 가짜 API 이미지 차단은 이번 웨이브가 만든 것이 아니며, 보안 헤더 정리 단계에서 본다.
6. S-T19 재측정은 이 웨이브 범위가 아니다(갈래 1 BAT-090 뒤 별도).
