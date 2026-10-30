# 제안: 저장소 뼈대와 GitHub 설정 코드(wbs 0.1.1의 로컬 부분)

## Why

구현을 시작하려면 모노레포 `peaket`의 폴더 자리, 폴더마다 주인 팀(CODEOWNERS), git flow 가지 규칙을 강제하는 GitHub 설정이 먼저 있어야 한다. 그런데 GitHub 조직이 아직 없어 설정을 GitHub에 적용할 수는 없다. 그래서 조직 없이 만들 수 있는 것을 지금 만들고, 적용은 조직이 생긴 뒤로 미룬다. 이 변경은 OpenSpec 사이클의 첫 시험이기도 하다(ADR-0167 결정 7).

## What Changes

- **폴더 뼈대**: `apps/`, `services/`, `packages/`, `data/`, `infra/`에 짧은 안내 파일을 두어 자리를 만든다. 무엇을 담고 어느 팀이 주인인지는 정본(architecture §10)을 가리킨다.
- **뿌리 CODEOWNERS**: `.github/CODEOWNERS`에 폴더마다 가상 팀 아홉 가운데 주인을 적는다(architecture §10 표).
- **GitHub 설정 Terraform 스택** `infra/stacks/global/github`(devops §2.3):
  - 저장소 4개와 공개 범위, 기본 가지(`develop`, `peaket-gitops`만 `main`)
  - 규칙 세트(devops §2.2.6): `main`, `develop`, `release/*`·`hotfix/*`, 태그 `v*`
  - 가상 팀 아홉과 저장소 권한, 환경 넷(`demo`, `staging`, `prod`, `release`)과 배포 가지 제한
  - Actions 허용 목록과 SHA 고정 요구, 워크플로 토큰 기본 권한 읽기 전용, OIDC 주체 키(`repo`, `context`, `job_workflow_ref`)
  - 이번에는 `fmt`·`validate`까지만 한다. `plan`·`apply`는 조직과 상태 버킷이 생긴 뒤다.
- **`workspace:` 표기 검사 스크립트**: `@peaket/*` 의존성을 `workspace:` 밖의 판으로 적은 `package.json`을 찾아 실패시킨다(devops §4.4, ADR-0165). CI 연결은 wbs 0.1.2다.
- 바뀌는 동작(사용자·시스템이 보는 행동)은 없다. 그래서 명세를 쓰지 않는다(`skip_specs: true`).

## Capabilities

### New Capabilities

- 없음. 저장소·도구 기반 작업이라 시스템 행동 명세가 생기지 않는다.

### Modified Capabilities

- 없음.

## Impact

- **정본**: docs/devops.md §2.1(저장소 4개), §2.2.1·§2.2.5·§2.2.6(가지 종류, 저장소별 적용, 규칙 세트·강제 장치), §2.3(GitHub 설정의 코드화), §4.4(`workspace:` 표기), §4.5(Actions SHA 고정, 토큰 권한, OIDC), §5.1(환경), §9.1(인프라 폴더·상태·버전 고정), §10.1(GitHub 권한), docs/architecture.md §10(폴더와 가상 팀), §8.6(사이클)
- **결정**: ADR-0054(배포 파이프라인), ADR-0074(git flow), ADR-0165(모노레포 4개 저장소), ADR-0167(스펙 주도 개발 사이클)
- **ASVS**: docs/security/asvs/delivery.md v5.0.0-13.2.2(OIDC 신뢰 조건), v5.0.0-16.3.3(규칙 세트 우회 기록은 적용 뒤의 일)
- **WBS**: 0.1.1(이 변경은 그 로컬 부분). 남는 0.1.1의 일(조직 만들기, 원격 저장소 만들기와 밀어 넣기, 설정 적용, 릴리스 봇 GitHub 앱, 다른 저장소 셋의 첫 내용)은 조직이 생긴 뒤 별도 변경으로 한다.
- **기능 보안 표와 운영 확인 표**: 기능이 아닌 저장소·도구 작업이라 새 ASVS 추적 표(architecture §8.2)와 운영 확인 표(§8.4)를 쓰지 않는다. 관련 항목은 기존 docs/security/asvs/delivery.md에 있다.
- **코드**: 새 파일만 더한다. 지금 있는 문서·도구는 바꾸지 않는다. 화면이 없어 브라우저 확인은 '해당 없음'이다.
- **외부**: Terraform GitHub 제공자(integrations/github)를 판 고정으로 받는다(검증용 `init`).
