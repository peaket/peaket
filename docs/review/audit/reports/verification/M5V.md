# 웨이브 6 변이 재검증 · M5V (R-596)

- 담당: M5 변이 담당(독립 재검증)
- 작업 위치: `D:\ticketpass-audit-mut5` (detached **7460f556**, R-596)
- 기준: M5 1단계에서 놓쳤던 변이 **9개**(M5-01..M5-09)
- 제약 준수: 메인·소유자 파일 미접촉, 소스 수정·커밋·푸시·Docker 없음, 변이 후 전부 원복
- 결과: **9개 중 8개 잡힘, 1개 놓침(M5-07)**
- 원복: 마지막 `git status --short` 출력 없음(깨끗함), HEAD `7460f556`

---

## 1. 결론

R-596이 더한 시험은 9개 중 8개를 잡았다. M5-01(jkt 자기 참조), M5-02(htu 호스트), M5-03(validFrom), M5-04(valid:false+role), M5-05(typ), M5-06(jwk d), M5-08(decide 근무 창), M5-09(flagSeq)는 변이를 넣으면 곧바로 빨개졌다.

**M5-07(등록 jkt 모양 검사)만 여전히 놓친다.** R-596이 더한 시험은 `MemoryScannerDeviceStore.byThumbprint`의 **별도 인라인 정규식**을 검증하고, M5-07 변이가 건드린 **도메인 `assertJkt`** 줄은 지나가지 않는다. 자세한 이유와 제안은 §4.

| 결과 | 개수 | 변이 |
|---|---|---|
| 잡힘 | 8 | M5-01, M5-02, M5-03, M5-04, M5-05, M5-06, M5-08, M5-09 |
| 놓침 | 1 | **M5-07** |

---

## 2. 방법

1. `git fetch origin` 뒤 `git checkout --detach 7460f556`로 맞췄다. 소스(`packages/platform/src`, `services/*/src`, `apps/scanner/src`)는 `42697cf7`과 동일함을 `git diff --stat`로 확인했다(R-596은 시험·문서·의존성만 변경).
2. 변이 전 기준선: 표적 시험 전부 초록.
   - platform `scanner-auth.test.ts` 24개
   - identity `check-scanner-session.test.ts` + `device-approval.test.ts` 18개
   - ticket `scanner-device.test.ts` 8개
   - scanner `version-vector.test.ts` 5개, `dpop.test.ts` 3개
3. M5 1단계와 **같은 변이 정의**를 한 번에 하나씩 넣고, 그 변이가 닿는 표적 시험만 돌렸다. 끝나면 `git checkout -- <file>`로 즉시 원복했다.
4. 명령:
   - `pnpm.cmd --filter @peaket/platform exec vitest run test/scanner-auth.test.ts`
   - `pnpm.cmd --filter @peaket/identity-svc exec vitest run test/<file>`
   - `pnpm.cmd --filter @peaket/ticket-svc exec vitest run test/<file>`
   - `apps/scanner`는 vitest가 없어 `node --test test/<file>`
5. 환경 메모: R-596이 `apps/scanner`에 `jose`를 새로 선언했지만 이 작업 트리의 `node_modules`에는 링크가 없어 `dpop.test.ts`가 기준선에서 import 실패했다. `pnpm.cmd install --filter @peaket/scanner --offline --frozen-lockfile`로 링크만 만들었고(추적 파일 변경 없음), 그 뒤 기준선 3개가 통과했다. CI는 설치를 하므로 문제되지 않는다.
6. 원본 결과: `C:\Users\ghwnd\AppData\Local\Temp\opencode\mut5\results-v.json`
   변이 실행기: `C:\Users\ghwnd\AppData\Local\Temp\opencode\mut5\run2.mjs` (작업 트리 밖)

---

## 3. 변이 표 (9개)

| ID | 영역 | 변이 위치 | 바꾼 내용 | 표적 시험 | 결과 | 증거(실패 지점) |
|---|---|---|---|---|---|---|
| M5-01 | scanner DPoP | `apps/scanner/src/api/dpop.ts:23` | RFC 7638 지문 키 순서 `crv,kty,x,y`→`kty,crv,x,y` | `apps/scanner/test/dpop.test.ts` | **잡힘** | 새 고정 벡터 시험: 실제 `1sHb…MCQ` ≠ 기대 `oKIy…D-U` |
| M5-02 | platform DPoP | `packages/platform/src/scanner-auth.ts:186` | htu를 경로만 비교(호스트 무시) | `packages/platform/test/scanner-auth.test.ts` | **잡힘** | 새 시험 `scanner-auth.test.ts:253` — `evil.example` 증명이 401이어야 하는데 통과 |
| M5-03 | identity 세션 | `services/identity-svc/src/modules/session/application/check-scanner-session.ts:25` | `validFrom > now` 검사 제거 | `services/identity-svc/test/check-scanner-session.test.ts` | **잡힘** | 새 시험 `check-scanner-session.test.ts:65` — 미래 validFrom 세션이 유효로 답함 |
| M5-04 | platform guard | `packages/platform/src/auth.ts:540` | `session.valid` 무시(role만 보게) | `packages/platform/test/scanner-auth.test.ts` | **잡힘** | 새 시험 `scanner-auth.test.ts:275` — `valid:false`+role이 200 |
| M5-05 | platform DPoP | `scanner-auth.ts:165,173` | `typ=dpop+jwt` 검사를 수동·jwtVerify 양쪽에서 제거 | `packages/platform/test/scanner-auth.test.ts` | **잡힘** | 새 시험 `scanner-auth.test.ts:265` — `typ:'jwt'` 증명이 통과 |
| M5-06 | platform DPoP | `scanner-auth.ts:129` | 헤더 jwk의 개인키 `d` 허용 | `packages/platform/test/scanner-auth.test.ts` | **잡힘** | 새 시험 `scanner-auth.test.ts:267` — `d:'private'` jwk가 401이 아님 |
| M5-07 | ticket 등록 | `services/ticket-svc/src/modules/scanner/domain/scanner-device.ts:113` | `assertJkt`의 43자 base64url 검사 제거 | `services/ticket-svc/test/scanner-device.test.ts` | **놓침** | 8개 전부 통과. 새 시험은 어댑터의 별도 정규식을 봄(§4) |
| M5-08 | identity 승인 | `services/identity-svc/src/modules/session/application/device-approvals.ts:118` | `decide`의 `inWindow` 검사 제거 | `services/identity-svc/test/device-approval.test.ts` | **잡힘** | 새 시험 `device-approval.test.ts:135` — 근무 창 밖 승인이 통과 |
| M5-09 | scanner 벡터 | `apps/scanner/src/storage/version-vector.ts:17` | 비교 대상에서 `flagSeq` 제외 | `apps/scanner/test/version-vector.test.ts` | **잡힘** | 새 시험 `version-vector.test.ts:55` — 기대 `diverged`, 실제 `behind` |

> 표의 위치는 원복된 현재 파일의 줄 번호다. 새 시험 줄 번호는 R-596 기준이다.

### 새 시험이 실제로 잡은 것을 확인한 방법

- M5-01: 새 시험이 RFC 7515 A.3.1 고정 EC 키의 기대 지문(`oKIy…D-U`)과 jose `calculateJwkThumbprint`를 함께 단언한다. 키 순서를 바꾸면 두 단언이 모두 깨진다.
- M5-02: 새 시험이 `https://evil.example/...`(같은 경로·다른 호스트) 증명을 401로 단언한다. 경로만 비교하는 변이는 이 단언에서 깨진다. 같은 호스트의 질의 문자열은 통과하는지도 함께 본다.
- M5-03: 새 시험이 `validFrom = NOW + 1`은 무효, `validFrom = NOW`(경계)는 유효를 단언한다. 시작 경계가 시험에 고정됐다.
- M5-04: 새 시험이 `{valid:false, role:'gate_staff', eventId:'ev-1'}`을 401로 단언한다. 가드의 `valid` 조건을 지우면 통과해 버려 깨진다.
- M5-05/M5-06: `proofOf` 헬퍼가 `typ`·`jwk`를 주입할 수 있게 바뀌었고, 잘못된 typ와 `d` 포함 jwk를 각각 401로 단언한다.
- M5-08: 새 시험이 `validUntil = NOW - 1` 상태에서 `decide(APPROVE)`가 `OUTSIDE_STAFF_HOURS`인지 단언한다. 조회(lookup)만 보던 공백이 메워졌다.
- M5-09: 새 시험이 `flagSeq`만 다른 두 벡터가 `diverged`이고 `needsResync`가 `true`인지 단언한다.

---

## 4. 아직 놓치는 변이: M5-07 (등록 jkt 모양 검사)

### [낮음] M5-07: R-596 시험이 도메인 `assertJkt`가 아니라 어댑터의 별도 정규식을 검증한다
- 영역/배치: ticket 스캐너 기기 등록, GAT-170
- 위치: 변이 줄 `services/ticket-svc/src/modules/scanner/domain/scanner-device.ts:113` (`assertJkt`), 새 시험 `services/ticket-svc/test/scanner-device.test.ts:138-142`
- 증거:
  - 새 시험은 `w.store.byThumbprint('short')` 등만 부른다.
  - `MemoryScannerDeviceStore.byThumbprint`는 **자체 인라인 정규식** `/^[A-Za-z0-9_-]{43}$/`를 쓴다(`memory-scanner-device-store.ts:55`). 도메인 `assertJkt`를 부르지 않는다.
  - 그래서 `assertJkt`의 `JKT_PATTERN.test(v)`를 지워도 새 시험 8개가 모두 통과했다.
  - 표적 파일 하나가 아니라 ticket의 스캐너 관련 시험 6개 파일 35개(`scanner-device`, `scanner-http`, `scanner-device-grpc`, `scanner-shift`, `scanner-device-lookup`, `scanner-device-keys`)로 넓혀도 전부 통과했다.
  - `assertJkt`는 `ScannerDevices.enroll`에서만 쓰인다(`scanner-devices.ts:187`). 현재 시험 중 `enroll`에 잘못된 jkt를 넣는 경우가 없다.
- 왜 문제인가: 지금 공개 HTTP 등록 경로는 DPoP 증명에서 **서버가 계산한 jkt**(항상 43자 base64url)를 넘기므로 실제 악용 가능성은 낮다. 그러나 `assertJkt`는 응용 경계의 입력 계약이고, 나중에 gRPC·내부 호출·운영 도구가 `enroll`을 직접 부르면 잘못된 지문이 원장에 저장될 수 있다. R-596의 시험은 "검증이 한 곳 더 있다"는 사실만 확인할 뿐, 변이된 그 한 곳을 지키지 않는다.
- 재현/확인:
  1. `scanner-device.ts:113`을 `if (typeof v !== 'string') throw ...`로 바꾼다.
  2. `pnpm.cmd --filter @peaket/ticket-svc exec vitest run test/scanner-device.test.ts` → **8 passed**.
  3. 위 6개 파일 35개로 넓혀도 **35 passed**.
- 제안 수정(택 1, 최소):
  1. **도메인 시험 추가**: `expect(() => assertJkt('short')).toThrow(ScannerDeviceInputError)` 또는 유효한 등록 코드 + `jkt:'short'`로 `devices.enroll(...)`이 `ScannerDeviceInputError('JKT')`인 시험. 이때 코드가 소모되지 않는지(`codes.take` 전에 거절)도 함께 단언하면 좋다.
  2. **검증 단일화**: `MemoryScannerDeviceStore.byThumbprint`의 인라인 정규식을 `assertJkt(jkt)` 호출로 바꾼다. 그러면 R-596의 새 시험이 곧바로 도메인 함수를 덮는다. Drizzle 어댑터의 조회 경로도 같은 함수를 쓰는지 함께 확인한다.
- 확신도: 높음 (변이 생존·호출 경로를 코드와 실행으로 확인)

---

## 5. 원복 확인

```
cd D:\ticketpass-audit-mut5
git rev-parse --short HEAD   → 7460f556
git status --short           → (출력 없음)
```

- 변이 9개 모두 `git checkout -- <file>`로 원복했다.
- `node_modules` 링크(`jose`)는 추적 대상이 아니며, `git status`에 잡히지 않는다.
- Docker 명령은 실행하지 않았다. 메인 작업 트리와 소유자 파일은 건드리지 않았다.

---

## 6. 다음

- R-596의 시험 보강은 9개 중 8개를 닫았다. 남은 1개(M5-07)는 **시험을 한 줄 더하거나 검증을 단일화**하면 닫힌다.
- 2단계(test-int, Docker 허용 뒤) 제안 목록은 M5 보고서 §6에 그대로 유효하다. 이번 재검증에서는 Docker를 쓰지 않았으므로 실행하지 않았다.
