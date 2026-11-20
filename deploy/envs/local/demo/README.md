# deploy/envs/local/demo — 로컬 kind 데모 오버레이(BAT-087)

BAT-086 재현 스크립트(S1~S9)가 도는 **무대**의 값 파일이다. 규범은 `docs/review/plans/BAT-087.md`와 `docs/infra.md` §3 '로컬 데모 무대'이고, 이 글은 쓰는 법과 한계를 쉽게 적은 안내다.

## 무엇으로 올리나

저장소 뿌리에서:

```bash
node tools/local/cluster.mjs demo          # 이미지 13개 빌드·적재 → 인프라 → 마이그레이션 → 차트 → 게이트웨이
node tools/local/cluster.mjs demo-seed --apply
node tools/local/cluster.mjs demo-status
node tools/local/cluster.mjs demo-down     # 데모 네임스페이스만 지운다(클러스터는 남긴다)
```

Docker·kind를 쓰므로 다른 갈래와 차례를 나눈다.

```bash
bash D:/ticketpass-locks/lock.sh take docker lane4-BAT-087
# … demo / demo-seed …
bash D:/ticketpass-locks/lock.sh drop docker lane4-BAT-087
```

`demo`의 게이트웨이 단계는 자체 서명 인증서를 만들려고 `openssl`을 부른다. Windows PowerShell에서 Git for Windows를 쓰면 `C:\Program Files\Git\usr\bin`을 PATH에 앞에 둔다(없으면 `spawnSync openssl ENOENT`로 멈춘다).

클러스터는 `lane4-demo`(kubeconfig `.cache/peaket-tools/kubeconfig-lane4-demo`)이고, 이 PC의 다른 `peaket`·`lane4-*` 클러스터는 건드리지 않는다. 처음 만들 때 게이트웨이 포트 18441~18445와 gRPC 19051·모의 기관 18920의 포트 매핑을 건다. 매핑 없이 만든 옛 클러스터면 `down` 뒤 `up`으로 다시 만든다.

## 운영과 무엇이 다른가

| 항목 | 운영 | 로컬 데모 | 왜 |
| --- | --- | --- | --- |
| 환경 이름 | `prod` | `local` | 합본 `bundle`은 `local`·`ci`에서만 시작하고, identity의 KMS·웹의 모의 OIDC 제공자도 `local` 전제다(감독 결정 2026-11-20) |
| queue·admission·purchase·payment | 서비스별 1복제 | `bundle` 한 파드 | 이미지·값·마이그레이션 넷을 아낀다. 운영 모양과 다르므로 이 무대의 수치를 성능 근거로 쓰지 않는다 |
| 이미지 | GHCR 서명 다이제스트 | `peaket/<워크로드>:demo`, `pullPolicy: Never` | 첫 출시 전에는 GHCR 게시·서명이 없다. 이미지는 이 PC에서만 만든다 |
| 게이트웨이 백엔드 | NLB·실서비스 | kind NodePort·실서비스 | 대역 `gateway-echo`를 쓰지 않는다. `bundle`이 사는 `purchase` 네임스페이스로 backendRef만 바꾼다 |
| 본인확인 | 실제 기관 | 모의 기관(파드 18920) | 기관 계약이 없다. `127.0.0.1:18920`으로 연다 |
| 로그인 | OIDC | 데모 인증 도우미 | `tools/local/demo-auth.mjs`가 팬 gRPC·관리 공개 API로 쿠키를 만든다 |
| 첫 관리자·promoter | 초대·승인 | 부트스트랩 예외 | 공개 API가 없다. **감사 기록이 남지 않는다(한계)** |
| 시드 | 운영 데이터 | `deploy/envs/demo/seed/base.yaml` | 가상 이름·`example.test` 이메일만 쓴다 |

### 데모 전용 예외(BAT-087 고침, 2026-11-20)

정본 계획 B12는 '공연·좌석을 공개·관리 API로만'이지만, 아직 없는 파트너 API 다섯(`GET /v1/partner/productions`, `GET /v1/partner/productions/{id}`, `POST /v1/partner/events/{eventId}/staff-invitations`, `GET /v1/partner/events/{eventId}/staff`, `POST /v1/partner/productions/{id}/sale-review`) 가운데 넷은 뒤 묶음(HOT-260·R-548) 몫이다. 그래서 **로컬 데모 시드만** 다음을 예외로 한다. API를 새로 만들지 않는다.

- **직접 SQL(넣기)**: 공연장(`place`) 행과 스태프 배정(`staff_assignment`) 행. 둘 다 공개 API가 없다. 스태프 배정은 '초대 수락이 끝난 `ASSIGNED`' 상태로 넣는다.
- **직접 SQL(읽기)**: 기존 공연·회차·스태프를 찾는 조회. 두 번째 적용에서 중복을 만들지 않으려면 필요하다.
- **판매 심사 제출**: BAT-616이 만든 `POST /v1/partner/productions/{productionId}/sale-review`를 쓴다. 고치기 전에는 이 경로가 없어 시드가 첫 공연에서 멈췄다.
- 공연·회차·좌석맵·기기는 여전히 공개·관리 API로만 만든다(감사 기록·Outbox 유지).
- 무대 쪽 예외: `bundle`은 `PEAKET_BUNDLE_MODE=split`(한 파드 안 gRPC 포트 충돌 회피), `ops-svc`·`realtime-gw`는 `nodeSelector: null`(차트 기본 노드 셀렉터를 지운다), web은 읽기 전용 루트 위에 `.next/static`·`serwist`·`cache`·`public`을 빈 볼륨으로 연다(시작할 때 복사하는 자리), partner는 데모 전용 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`를 빌드·실행에 같은 값으로 쓴다.
- 이 예외는 `docs/review/plans/BAT-087.md`의 '고침' 절과 `deploy/envs/demo/README.md`에도 적는다.

## 호스트와 포트

정본 호스트 이름을 그대로 쓰고 이 PC 포트만 붙인다.

| 게이트웨이 | 호스트 | 이 PC 주소 |
| --- | --- | --- |
| gw-fan | `www`·`api` | https://www.peaket.example:18441 · https://api.peaket.example:18441 |
| gw-queue | `queue`·`queue-files` | https://queue.peaket.example:18442 |
| gw-partner | `partner`·`partner-api` | https://partner.peaket.example:18443 |
| gw-ops | `ops-api`·`console` | https://ops-api.peaket.example:18444 · https://console.peaket.example:18444 |
| gw-scanner | `scanner-api`·`scanner` | https://scanner-api.peaket.example:18445 · https://scanner.peaket.example:18445 |

- **사람이 직접 볼 때**: hosts 파일에 아래를 넣고, 자체 서명 인증서 예외를 브라우저에서 한 번 받아들인다.

  ```text
  127.0.0.1 www.peaket.example api.peaket.example queue.peaket.example queue-files.peaket.example partner.peaket.example partner-api.peaket.example ops-api.peaket.example console.peaket.example scanner-api.peaket.example scanner.peaket.example
  ```

- **Playwright**: `--host-resolver-rules=MAP *.peaket.example 127.0.0.1`와 `ignoreHTTPSErrors: true`를 쓴다. 호스트 파일을 고치지 않아도 된다.
- 쿠키는 포트를 무시하지만 CORS `Origin`은 포트를 포함한다. 그래서 게이트웨이 CORS·`PEAKET_WEB_ORIGIN`·브라우저 주소가 모두 같은 `:18441`~`:18445`를 쓴다.

## 비밀

- `.cache/peaket-tools/demo-secrets/secrets.json`(0600)과 `sessions.json`(0600)에만 쓴다.
- 저장소·로그·측정 파일·화면에 싣지 않는다. `demo-auth prepare`가 없으면 새로 만든다.
- 패스키 개인키는 Playwright CDP `WebAuthn.addCredential`로만 쓰고, 데모가 끝나면 `.cache` 폴더째 지운다.

## 한계(측정·기록에도 적는다)

- **합본 재사용**: queue·admission·purchase·payment가 한 파드다. 운영의 장애 격리·확장 모양이 아니다.
- **부트스트랩 감사 없음**: 첫 관리자·promoter는 감사 기록·권한 부여 내역 없이 들어간다. 로컬 데모 전용이며 운영·클라우드 데모에는 쓰지 않는다.
- **로컬 전용 이미지**: GHCR 게시·서명·승격·익명 끌어오기가 없다. 임시 클라우드 데모는 첫 출시 뒤 승격 묶음이 처음 켠다.
- **모의 기관·데모 인증**: 실제 OIDC·본인확인·패스키 검증 경로를 그대로 재현하지 않는다. 화면 로그인(SCR-004·005)은 OPS-290·뒤 묶음 몫이다.
- **관측·추적**: 로컬 데모에는 OTel 수집기가 없다. 게이트웨이 추적은 꺼 두고, 서비스 지표는 각 파드의 관리 포트로만 본다.
- **이미지 처리**: `image-worker`가 아직 없어 core-svc의 이미지 올리기 경로만 503이다. 나머지 core 경로는 뜬다.
- **수치 금지**: 이 무대의 콜드 스타트·시드 시간은 준비 시간이지 성능 수치가 아니다.
