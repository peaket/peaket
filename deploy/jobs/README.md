# research-export-purge

F-04-19 연구 내보내기 거절·경보 메타데이터(`research_export_denial`)를 **90일 보존**한 뒤 지우는 일일 CronJob이다.
소유자 결정(2026-11-27): `ops_app`에는 `research_export_denial` DELETE를 주지 않고, 전용 `ops_research_purger`만 함수를 실행한다.

## 적용
- 파일: `deploy/jobs/research-export-purge.yaml` (CronJob `research-export-purge`, 매일 04:15 UTC), `deploy/jobs/ops-research-purge-secrets.yaml`(ExternalSecret).
- 이 디렉터리는 Helm 릴리스가 아니라 정적 매니페스트다. `deploy/projects/applicationsets.yaml`의 `peaket-jobs` Application이 `path: deploy/jobs`·`directory.recurse: true`로 이 디렉터리를 적용한다.
- `concurrencyPolicy: Forbid`, `backoffLimit: 2`, `activeDeadlineSeconds: 300`, `successfulJobsHistoryLimit: 3`.

## Secret·로그인 역할
- `ops-research-purge-secrets` ExternalSecret이 `peaket-secrets` ClusterSecretStore의 `peaket/research-purge/database-url`을 읽어 `ops-research-purge-secrets` Secret을 만든다. Pod는 그 Secret의 `PEAKET_RESEARCH_PURGE_DATABASE_URL` 키만 받는다. DSN을 env·Git에 직접 넣지 않는다.
- DSN의 로그인 역할은 `ops_research_purge_login`이다. 0041이 `GRANT ops_research_purger TO ops_research_purge_login`과 스키마 USAGE를 주며, 로그인 역할에는 표 권한을 주지 않는다. Job은 `SET ROLE ops_research_purger` 뒤 `SELECT public.research_export_denial_purge();`를 실행한다.
- `ops_app`은 이 Job에 쓰지 않는다. 0041이 PUBLIC·`ops_app`의 함수 EXECUTE와 `research_export_denial` DELETE를 회수한다.

## 이미지 다이제스트
- 동결 로컬은 `postgres:18-alpine` 태그를 쓴다.
- 승격할 때는 `docker buildx imagetools inspect postgres:18-alpine --format '{{json .Manifest.Digest}}'`로 다이제스트를 확인하고, 매니페스트의 `image`를 `postgres@sha256:<digest>`로 바꾼 승격 PR을 만든다. `gitops-check`는 staging·prod 값의 태그를 거부하므로 태그를 남기지 않는다.
- 확인한 다이제스트와 승격 커밋을 `docs/review/measurements/` 또는 승격 PR 본문에 남긴다.

## 함수 소유자 확인(0041과 함께)
`SECURITY DEFINER` 함수는 소유자의 권한으로 `research_export_denial`을 지운다. 소유자에게 DELETE가 없으면 Job은 `permission denied`로 실패한다.

```sql
-- 함수 소유자
SELECT pg_get_userbyid(p.proowner) AS owner
FROM pg_proc p
WHERE p.oid = 'public.research_export_denial_purge()'::regprocedure;

-- 소유자가 research_export_denial DELETE를 갖는지
SELECT has_table_privilege(
  (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.research_export_denial_purge()'::regprocedure),
  'public.research_export_denial',
  'DELETE'
);
```

0041은 함수를 만든 직후 같은 확인을 `DO` 블록으로 한 번 한다. 마이그레이션 역할이 DELETE를 잃었거나 함수 소유자를 바꿔야 하면, 출시 전에 전용 owner 역할(예: `ops_research_purge_owner`)을 만들고 다음을 적용한다.

```sql
-- 전용 owner 역할이 research_export_denial DELETE를 갖는다는 전제
ALTER FUNCTION public.research_export_denial_purge() OWNER TO ops_research_purge_owner;
```

이 owner 역할은 로그인하지 않고(`NOLOGIN`), 함수 소유권만 갖는다. `ops_research_purger`는 여전히 함수 EXECUTE만 갖는다.

## 확인
- 성공: Job 로그에 `research_export_denial_purge`가 돌려준 삭제 행 수가 한 줄로 남는다.
- 실패: `permission denied`면 함수 소유자 DELETE·`SET ROLE` 멤버십을, `function ... does not exist`면 0041 적용 여부를 본다.
