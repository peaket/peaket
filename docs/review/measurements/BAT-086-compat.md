# BAT-086 운영 판 호환 검사 시연(D-T48)

- **커밋(작성 시점)**: `aaf87493`(계획) + 이 묶음 구현 변경
- **날짜**: 2026-11-21
- **명령**: `node tools/local/demo.mjs compat --work .cache/peaket-tools/demo-compat`
- **도구**: `tools/ci/contract-breaking.mjs`(oasdiff 1.34.1·AsyncAPI CLI 6.2.2 고정 이미지), Docker 엔진
- **저장소**: 임시 복제본 `git clone --shared`. 실제 저장소·원격·태그는 바꾸지 않았다.

## 결과

| 단계 | 무엇 | 끝 코드 | 결과 |
| --- | --- | --- | --- |
| same-commit | 복제본에서 모든 출시 태그를 지우고, `develop`(HEAD)과 같은 커밋을 견줌 | 0 | 통과 |
| release-tag-diff | 기준 커밋에 `v0.0.0` 태그를 붙이고 `components.schemas.Problem.properties.type`을 지운 커밋을 만든 뒤 `develop`과 견줌 | 1 | 실패(의도한 깨짐). 출력에 지운 필드 `type`이 있다 |

출력 요약(마지막 실행):

```text
통과 same-commit(exit 0)
통과 release-tag-diff(exit 1)
운영 판 호환 검사 시연 통과: 같은 커밋 통과, v0.0.0 태그와 견주면 type 삭제를 잡았다
```

- 계획 §8 G5는 태그 이름을 `v0.0.0-demo`로 적었지만, 출시 태그 규칙(`tools/ci/release-tags.mjs`의 `/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/`)이 `vX.Y.Z`만 받아 `v0.0.0-demo`는 출시 태그로 읽히지 않았다. 그래서 데모 태그만 `v0.0.0`으로 썼다(복제본 안에서만). 이 사실은 `docs/devops.md` §14와 `tools/local/README.md`에도 적었다.
- 첫 실행에서 `same-commit`이 실패한 까닭은 복제본이 저장소의 기존 출시 태그를 그대로 가져와 마지막 출시 태그와 견줬기 때문이다. 복제본에서 `v*` 태그를 지워 '출시 태그가 없는 같은 커밋'을 만든 뒤 통과했다.
- 도구가 0이 아닌 코드(도구 오류 포함)로 끝나면 통과로 세지 않는 경로는 `compat`이 exit 1 또는 2로 끝나게 했다. Docker가 없으면 exit 2다.

## 한계

- 임시 복제본의 태그를 지우는 것은 이 시연만의 일이다. 실제 저장소 태그·원격은 그대로다.
- `contract-breaking`의 Pact·Avro 호환 검사는 이 시연에 넣지 않았다(계획 §13). D-T48의 자동 시험은 기존 `tools/ci/contract-breaking.test.mjs`가 맡는다.
