# ADR-0257: 공연 이미지 올리기 API와 좌석맵 가져오기 해석 작업을 만든다

- **상태**: 채택(2026-11-10, 추천 적용). BUILD_ORDER BAT-145(HOT-190·HOT-210).
- **관련**: [docs/features/seat-hold.md](../features/seat-hold.md) §10, [docs/security/asvs/catalog-review.md](../security/asvs/catalog-review.md) V5·5.4.3·15.2.5, [docs/security/asvs/seat-hold.md](../security/asvs/seat-hold.md) V1·V5·15.2.5, [docs/api/openapi.yaml](../api/openapi.yaml) `createPartnerProductionImage`·`updatePartnerProductionImage`·`deletePartnerProductionImage`·`createPartnerProductionSeatmapImport`, [docs/api/proto/peaket/image/v1/image.proto](../api/proto/peaket/image/v1/image.proto), [docs/api/proto/peaket/seatmap/v1/seatmap.proto](../api/proto/peaket/seatmap/v1/seatmap.proto), [docs/design/d5-screen-blueprint.md](../design/d5-screen-blueprint.md) §6.4, ADR-0062 결정 38, ADR-0063, ADR-0130, ADR-0148, ADR-0161, ADR-0199, ADR-0200, ADR-0245
- **관련 ID**: S-T32, S-T34, FR-022, FR-023, SCR-021, CMP-069

## 맥락

- HOT-190 줄은 '형식·크기·해상도 검사, 메타데이터 제거·다시 인코딩, 파생본'까지 적었지만, 그 줄을 쓴 뒤 2026-10-28에 이미지 디코딩·다시 인코딩을 DB 자격 증명이 없는 `image-worker`(HOT-200, wbs 2.9.6)로 떼었다(ADR-0130). core-svc는 원본을 디코딩하지 않는다(catalog-review 5.4.3·15.2.5). 그래서 HOT-190과 HOT-200의 경계를 정해야 한다.
- 원본을 받아 둘 격리 버킷(S3)과 작업 원장 연결, 모의 악성 코드 검사기(D-T35)는 HOT-200 몫이다. 이 저장소에는 아직 S3 라이브러리가 없다.
- 공연은 위저드 4단계 끝에서 한 번에 등록한다(ADR-0245). 이미지 올리기 경로는 공연 ID가 있어야 부를 수 있다.
- 좌석맵 가져오기는 core-svc가 해석하지 않고 `seatmap-worker`에 gRPC로 맡긴다(ADR-0161, seat-hold §10). SVG를 읽을 XML 라이브러리는 정하지 않았고, 새 패키지를 들이지 않는다.
- 에디터 화면(SCR-022)을 데이터에 잇는 일은 HOT-220, 휠체어석 기준·도형 밖 좌석·좌석 겹침 검사는 HOT-230이다.

## 결정

1. **HOT-190과 HOT-200의 경계**: HOT-190은 core-svc가 가진 쪽을 모두 만든다. 올리기·고치기·지우기 API, `production_image` 표와 행 보안, 형식(파일 앞부분)·크기·장수·대체 텍스트 검사, 처리 결과의 다시 검사와 파생본 게시, 공연 상세 응답의 이미지 칸, 위저드 화면이다. 디코딩과 다시 인코딩은 포트 `ImageProcessing` 뒤에 둔다.
   - HOT-190의 어댑터는 `ImageService.ProcessImage`(image.proto)를 요청 안에서 바로 부른다(데드라인 30초 [가정]). HOT-200이 작업 원장(core DB 작업 표와 작업 워커)과 `image-worker`, 격리 버킷·준비 위치의 S3 어댑터, 모의 검사기를 더하고, 이 어댑터를 '작업을 적고 결과를 기다리는' 어댑터로 바꾼다. 처리기와 유스케이스는 바꾸지 않는다.
   - 원본과 파생본을 두는 곳은 포트 `ImageObjectStore`(격리 원본 쓰기·지우기, 준비 위치 읽기, 공개 위치 쓰기·지우기)다. HOT-190은 메모리 어댑터(시험)와 로컬 폴더 어댑터(개발)만 둔다. S3 어댑터는 HOT-200이다.
   - 원본 객체 키는 서버가 만든 이미지 ID로만 만든다(`quarantine/production/{imageId}`). 사용자가 보낸 파일 이름은 버린다(5.3.2).
   - `SCAN_PENDING`(검사 결과가 아직 없음)은 이 어댑터에서 최종 결과가 아니다. 저장하지 않고 원본을 지운 뒤 503 `image-processing-unavailable`과 `Retry-After: 60` [가정]으로 답한다. 데드라인 초과·연결 실패도 같은 503이고 `Retry-After: 30` [가정]이다(fail-closed, 16.5.3). HOT-200의 작업 원장이 생기면 1분 뒤 다시 맡기는 동작(ADR-0148 결정 8)으로 바뀐다.
2. **받는 검사의 차례**(먼저 걸린 것으로 답한다): 그 테넌트의 공연인가(아니면 없는 공연과 같은 404 `not-found`. 회차 더하기(ADR-0198)와 d5 §6.4 '권한 없음 404'를 따르고, 계약의 '다른 파트너 공연 403' 설명을 404로 고친다) → `X-Requested-With` 머리(없으면 400, 3.5.1) → 본문 10MB [가정](넘으면 413 `image-too-large`, 서버의 본문 상한은 10MB + 봉투 64KB [가정]) → multipart 칸(`file` 하나, `kind`, `order` 0~9. 모르는 칸·칸 구조 오류는 400, `alt`가 0자이거나 300자를 넘으면 계약대로 422 `image-spec-invalid` reason `ALT_INVALID`) → 파일 앞부분(JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF????WEBP`)과 파일 칸의 `Content-Type`·확장자가 같은 형식인가(아니면 415 `image-type-unsupported`) → 상세 이미지 장수(이미 10장이면 409 `image-limit-exceeded`) → 처리(디코딩은 image-worker) → 결과 다시 검사.
   - multipart는 Node 내장 `Request.formData()`(undici)로 읽는다. 새 패키지를 들이지 않는다. 본문 상한을 먼저 걸어 큰 본문은 읽기 전에 끊는다.
   - 올리기 경로의 남은 시간(요청 데드라인)은 본문을 받는 시간까지 넣어 90초 [가정]다(플랫폼 기본 15초를 이 경로만 늘린다). 처리를 맡기기 직전에 남은 시간을 보고, 처리 데드라인은 30초와 (남은 시간 − 2초) 가운데 작은 값이다. 그 값이 10초 [가정]보다 작으면 맡기지 않고 504 `deadline-exceeded`다(guidelines §5). core-svc의 요청 전체 시한(본문 받기 포함)은 100초 [가정]다(천천히 보내는 연결이 버퍼를 오래 쥐지 않게). 본문 상한을 넘는 요청은 읽기 전에 끊으므로 인증보다 먼저 413이 나간다.
   - 파트너 multipart 받기(공연 이미지 올리기와 좌석맵 가져오기)는 파드마다 동시 4개 [가정]의 칸막이(벌크헤드)를 함께 쓴다. 자리는 본문을 읽기 전(그 경로의 요청 첫 단계)에 잡고 응답이 끝나거나 연결이 끊기면 놓는다. 차면 본문을 읽지 않고 429 `server-busy`와 `Retry-After: 10` [가정]이다(서비스 스스로의 과부하는 429, guidelines §5. 원본 10MB를 쥔 요청이 힙을 채우지 않게, docs/verification.md §4.1). 받은 본문은 한 벌만 쥔다(사본을 만들지 않는다).
   - 결과 다시 검사(5.4.3 '돌아온 결과를 그대로 믿지 않는다'): 준비 위치의 파생본 하나는 5MiB [가정] 이하이고 파일 앞부분이 형식과 맞아야 한다(WebP `RIFF????WEBP`, AVIF `ftyp` 상자의 상표 `avif`·`avis`). 크기를 먼저 보고 넘으면 읽지 않는다. 어긋나면 게시하지 않고 503으로 답하며 보안 사건으로 남긴다. 상태가 `ACCEPTED`이면 폭·높이가 1 이상, 긴 변 20,000px·4,000만 화소 이하이고(아니면 422 `image-spec-invalid`, reason `PIXEL_LIMIT`), 포스터는 가로 800·세로 1,000px 이상이며 세로가 가로보다 길고(아니면 reason `POSTER_SPEC`), 상세 이미지는 가로 800px 이상이다(아니면 `DETAIL_SPEC`). 파생본 키는 정확히 `staging/production/{imageId}/{폭}.{avif|webp}`(폭 320·640·960·1280 [가정])의 여덟 개여야 한다. 키가 모자라거나 남거나 접두사 밖이면 게시하지 않고 503으로 답하며 보안 사건으로 남긴다(작업 결과가 바뀐 것으로 본다).
   - `REJECTED`의 이유는 `UNSUPPORTED_TYPE` → 415, `TOO_LARGE` → 422 `PIXEL_LIMIT`, `TOO_SMALL` → 422 `POSTER_SPEC`·`DETAIL_SPEC`(종류대로), `MALWARE` → 422 `MALWARE`로 옮긴다. 이미지를 읽지 못한 경우는 image-worker가 `UNSUPPORTED_TYPE`으로 답한다.
   - 어떤 거절이든 원본을 지우고 행을 남기지 않는다(5.1.1 '저장하지 않는다'). 격리 원본·준비 위치·공개 위치 지우기가 실패하면 `production_image_leftover` 기록으로 남긴다(정리는 HOT-200의 작업 원장). 커밋 뒤 정리와 무효화는 응답을 기다리게 하지 않는다(뒤에서 하고 결과를 기록한다).
   - 남의 공연이거나 이 공연에 없는 이미지 ID로 고치기·지우기를 부르면 404이고 보안 사건으로 남긴다(16.3.2).
   - 올리기에는 멱등 키가 없다. 응답을 받지 못한 상세 이미지를 다시 올리면 두 장이 될 수 있다. 작업 원장이 생기는 HOT-200에서 계약에 `Idempotency-Key`를 더할지 정한다(구간 끝 정리 목록).
3. **저장과 게시**: 받은 이미지는 `production_image` 행 하나다(docs/data.md). 상태 칸을 두지 않는다. 처리가 끝나 받은 것만 행이 된다(동기 응답이라 '처리 중' 행이 없다).
   - 파생본은 준비 위치에서 공개 위치 `production/{imageId}/{폭}.{avif|webp}`로 옮겨 게시한다. 기준 주소는 `{이미지 출처}/production/{imageId}`이고 이미지 출처는 `PEAKET_IMAGE_BASE_URL`(운영 `https://img.peaket.example`, CSP `img-src`의 `{img}`와 같다)이다. 계약 `ProductionImage.derivatives`는 `"{폭}.{형식}"` → 파생본 주소의 표다.
   - 폭이 원본보다 넓은 칸은 원본 폭 그대로 만든다(늘리지 않는다). 이름은 칸의 폭이다(화면의 `srcset`이 빈 칸을 부르지 않게). 만드는 쪽은 HOT-200이다.
   - 포스터를 다시 올리면 한 트랜잭션에서 옛 포스터 행을 지우고 새 행을 넣는다. 옛 파생본은 커밋 뒤 지운다. 지우기에 실패해도 응답은 성공이고 남은 객체는 기록으로 남긴다(공개 객체라 개인정보가 없다. 정리 일은 HOT-200의 작업 원장이 맡는다).
   - 장수 검사와 포스터 바꾸기는 공연 행을 `FOR NO KEY UPDATE`로 잡은 트랜잭션 안에서 한다(동시에 올린 두 장이 10장을 넘기지 못하게, data.md §5. 등록 경로와 같은 잠금이라 찜·회차 넣기의 외래키 잠금은 막지 않는다).
   - 고치기(PATCH)는 대체 텍스트와 순서만 받고 `If-Match`로 행의 `version`을 대조한다(412·428). 응답의 `ETag`가 그 판이다. 순서를 바꾸면 같은 공연의 다른 상세 이미지 순서를 한 칸씩 밀어 0부터 빈틈 없이 다시 매긴다.
   - 지우기(DELETE)는 포스터면 409 `poster-not-deletable`이다. 상세 이미지를 지우면 남은 순서를 다시 매기고, 커밋 뒤 파생본을 지우고 공연 태그 `production:{productionId}`를 무효화한다(무효화는 포트, 실제 CDN 어댑터는 배포 단계).
   - 공연 상세 응답(`GET /v1/events/{eventId}`)의 `posterUrl`·`posterAlt`·`detailImages`(순서대로)는 이 표에서 채운다. 이미지를 바꾸면 공연 태그를 무효화한다.
4. **위저드 화면(SCR-021 1단계, CMP-069)**: 공연 ID가 등록 뒤에 생기므로, 1단계에서 고른 파일은 탭의 메모리에만 들고 있다가 [공연 등록]이 성공한 바로 뒤에 포스터부터 한 장씩 올린다. 브라우저 임시저장(ADR-0245)에는 파일을 넣지 않고 대체 텍스트와 순서만 넣는다. 다시 열었을 때 파일이 없으면 "이미지는 다시 골라 주세요"를 알린다.
   - 화면 검사(형식·10MB·해상도·장수·대체 텍스트)는 안내용이고 문구는 d5 §6.4의 것이다. 해상도는 브라우저가 디코딩해 읽는다. 서버의 거절은 그 이미지 줄의 오류로 돌아온다.
   - 포스터는 판매 승인 요청에 필요하다(d5 §6.4의 '필수'). 초안 등록은 포스터 없이도 되고, 1단계 칸은 '판매 승인 요청에 필요'로 알린다.
   - 등록 뒤 올리기에 실패한 이미지는 완료 화면에 줄마다 오류와 [다시 올리기]로 남긴다. 포스터를 올리지 못하면 판매 승인 요청에 포스터가 필요하다고 알린다. 등록은 되돌리지 않는다.
   - 화면이 게이트웨이를 거쳐 실제 core-svc까지 가는 시험은 게이트웨이(HOT-400)·파트너 로그인 경로(BOT-132) 뒤에 한다. 이 묶음에서는 계약 모양 가짜 API로 화면 흐름을 보고, 서버 쪽은 실제 PostgreSQL과 실제 gRPC 서버까지 잇는 통합 시험으로 본다.
5. **`seatmap-worker`**: core-svc 패키지 안의 다른 진입점(`dist/seatmap-worker/main.js`)이다. gRPC `SeatmapImportService`만 연다.
   - 시작할 때 자격 증명으로 보이는 환경 값이 하나라도 있으면 뜨지 않는다(15.2.5, S-T34 ①의 코드 몫). 이름에 `DATABASE_URL`·`REDIS`·`KAFKA`·`SECRET`·`PASSWORD`·`PEPPER`·`HMAC`·`TOKEN`이 들었거나 `_KEY`·`_KEYS`로 끝나거나 `AWS_`·`PG`(PostgreSQL 접속 값)로 시작하면 자격 증명으로 본다(대소문자 무시). 저장소가 실제로 쓰는 이름(`PEAKET_SEAT_REDIS_URL`, `PEAKET_OUTBOX_DATABASE_URL`, `PEAKET_PG_TOSS_SECRET_KEY` 등)이 모두 걸리는지 시험으로 본다.
   - 받기 상한 12MiB·보내기 상한 8MiB [가정]를 이 서버와 core-svc의 이 채널에만 건다.
   - 해석 하나를 작업 스레드(`worker_threads`) 하나에서 한다. 5초 [가정]가 지나면 스레드를 끝내고 `REJECTED`(`CPU_LIMIT`)로 답한다. 스레드에 힙 상한(384MiB [가정], 컨테이너 512MiB [가정] 안)을 걸어, 넘어 스레드가 죽으면 `RESOURCE_EXHAUSTED`로 답하고 core-svc는 503이다. 프로세스는 살아 다음 요청을 받는다.
   - 파드마다 동시 해석 1이다. 기다리는 요청은 4개 [가정]까지 줄을 세우고 넘으면 `RESOURCE_EXHAUSTED`다. 차례가 왔을 때 부른 쪽이 이미 끊었거나(취소) 데드라인이 지났으면 해석하지 않고 넘긴다.
   - 해석 스레드는 요청마다 새로 띄운다(뚫린 해석이 다음 요청의 결과를 바꾸지 못하게). 스레드가 실리기를 기다리는 시간은 10초 [가정]다. 시간·힙 상한은 환경 값 `PEAKET_SEATMAP_PARSE_TIMEOUT_MS`·`PEAKET_SEATMAP_HEAP_MB`로 바꿀 수 있고 기본은 5초·384MiB다.
   - 응답이 커지지 않게 무시 목록은 100개·이름당 64자, 행 오류는 1,000개 [가정]까지만 싣는다. 해석한 배치 JSON이 8MiB [가정]에서 봉투 64KB를 뺀 크기를 넘으면 보내지 않고 `REJECTED`(`LAYOUT_TOO_LARGE`)로 답한다(core-svc 422. 보내기 상한에 걸려 늘 503이 되지 않게).
   - 모든 글자 칸(구역 ID·이름·층, 좌석 ID·열·번호·등급·게이트, 무대 이름)에서 제어 문자와 양방향 제어 문자를 지우고 길이를 묶는다: 구역·좌석 ID 64자 [가정], 이름·층 30자, 열·번호 8자, 등급·게이트 30자 [가정]. 무대 도형은 500개 [가정]까지다.
   - 숫자는 겹치지 않는 꼴(`^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`)로 읽고 칸 하나는 64자 [가정]까지다. 경로 `d`는 64KB [가정]까지다. 되돌기가 커지는 정규식(겹치는 반복)을 쓰지 않는다(5.2.1·15.1.3).
6. **SVG 읽기**: XML 라이브러리를 쓰지 않고 좌석맵에 필요한 만큼만 읽는 제한된 읽개를 둔다. DTD를 지원하는 코드가 없어 외부 엔터티·엔터티 확장이 생기지 않는다.
   - `<!DOCTYPE`·`<!ENTITY`가 있으면 해석하지 않고 `REJECTED`(`DOCTYPE_PRESENT`)다. 루트 요소가 `svg`가 아니면 `FORMAT_MISMATCH`다. 미리 정한 다섯 엔터티(`&lt;` 등)와 숫자 문자 참조만 푼다.
   - 구역은 `polygon`(`points`)·`rect`(`x`·`y`·`width`·`height`)·`path`(`d`의 `M`·`L`·`H`·`V`·`Z`와 소문자 상대 명령만. 곡선 명령과 갈래가 둘 이상인 경로(`M`이 두 번)는 행 오류 `PATH_UNSUPPORTED`. 구역 도형은 닫힌 다각형 하나다)에 `data-section`(구역 이름, 없으면 `id`)이 있는 요소다. 좌석은 `circle`(`cx`·`cy`)에 `data-section`·`data-row`·`data-number`가 있는 요소이고 `data-tier`·`data-wheelchair`(`true`)·`data-gate`를 더 읽는다. 무대는 `data-kind="stage"`인 `polygon`·`rect`·`path`다(`circle`은 늘 좌석이다). 들어가는 묶음 요소는 `g`뿐이고 안쪽 `svg`는 들어가지 않고 무시 목록에 넣는다(좌표계가 바뀌므로). 좌표는 꼭짓점을 계산한 뒤 소수점을 반올림한 정수다(`rect`는 네 꼭짓점을 구한 뒤 반올림).
   - 그 밖의 요소·속성(`script`·`foreignObject`·`image`·`use`·`style` 요소와 속성·`href`·`xlink:href`·`on*`·처리 명령 `<?xml-stylesheet?>`)은 따라가지 않고 이름만 `ignored`에 모은다(같은 이름은 한 번).
7. **CSV 읽기**: 첫 줄은 머리 `section,row,number,x,y,tier,wheelchair,gate,shape`(순서대로, 다르면 `FORMAT_MISMATCH`)다. 좌석 한 줄이 한 행이고, 구역의 첫 행만 `shape`에 꼭짓점 `x y;x y;…`를 적는다. 따옴표 칸(RFC 4180)을 읽는다. 구역 이름 30자·열·번호 8자 [가정]이고, 제어 문자와 양방향 제어 문자는 지운 뒤 센다(seat-hold §10). 문자는 UTF-8로 한 번 디코딩하고(BOM 하나는 버린다, 잘못된 바이트는 `FORMAT_MISMATCH`), 구역 이름·열·번호는 제어 문자를 지운 뒤 NFC로 한 번 정규화한다(지우기 전에 정규화하면 사이에 낀 제어 문자 때문에 합쳐지지 않은 글자가 남는다, seat-hold ASVS 1.1.1). 머리는 칸 단위로 견주고, 닫는 따옴표 뒤에 쉼표·줄바꿈이 아닌 글자가 오면 `CSV_QUOTE`다.
8. **core-svc의 가져오기 처리**: 소속 확인 → `X-Requested-With`(공연 이미지와 같이 multipart 쓰기 요청의 사전 요청을 만들게 필수로 한다. 계약에 머리를 더한다) → 본문 10MB [가정](넘으면 413 `seatmap-import-too-large`, 작업을 부르지 않는다) → 압축 파일(gzip `1F 8B`, zip `50 4B 03 04`)이면 413 같은 이름 → 작업 호출(데드라인 10초 [가정]) → 답이 없거나 `UNAVAILABLE`·`RESOURCE_EXHAUSTED`·`DEADLINE_EXCEEDED`면 503 `seatmap-worker-unavailable`과 `Retry-After: 10` [가정] → `REJECTED`면 422 `seatmap-import-rejected`(detail에 첫 오류 코드) → `PARSED`면 배치를 다시 본다.
   - 다시 보기(seat-hold §10 '받은 결과를 다시 본다'): 작업 응답의 JSON에서 `__proto__`·`constructor`·`prototype` 키를 거절하고, 위 글자 칸 규칙(제어 문자 없음·길이), 라벨 위치(x·y 하나만 있어도)·`seatIndexRange`·`index`의 범위, 좌석 번호 1 이상을 다시 본다. `SeatMapLayout` 스키마, 좌석 5만·구역 500·도형 하나의 꼭짓점 1,000 [가정], 캔버스 한 변 1~100,000(SeatMapColumns와 같다)과 좌표 절댓값 1천만 [가정] 이하, 모든 좌표가 캔버스 안, 같은 구역(구역 ID)·열·번호 겹침 없음. 구역 이름은 JSON에서는 같아도 된다(층이 다른 같은 이름 구역). CSV·SVG는 구역을 이름으로 잇기 때문에 이름이 곧 구역이다. 개수 상한은 스키마 검사보다 먼저 보고 넘으면 422 `seatmap-import-rejected`(S-T34 ⑥), 그 밖은 `ok: false`와 행 오류다. 작업의 행 오류와 다시 보기 오류를 합쳐 1,000개까지 싣는다. 좌석 ID가 없으면 `{구역 순번}-{열}-{번호}`로 만든다.
   - 휠체어석 W1~W3, 좌석 겹침, 도형 밖 좌석은 HOT-230이 저장 검사와 함께 같은 검사기로 더한다. 이 묶음의 결과 경고는 `SVG_IGNORED`뿐이다.
   - 가져오기가 만드는 구역 ID가 purchase-svc 판 해석의 키 조각 꼴(`^[A-Za-z0-9_-]{1,64}$`)이 아니면 `s{구역 순번}`으로 바꾼다. 좌석 ID 자리표시 `{구역 순번}-{열}-{번호}`는 에디터 안에서만 쓰는 값이고, 저장(ADR-0260 결정 2) 때 서버가 소문자 UUID로 바꾼다 (추천 적용, 2026-11-10, 리뷰).
   - 가져오기 결과를 기록에 남긴다(형식, 크기, 좌석·구역 수, 결과 코드. 구역 이름 같은 파트너 글자는 넣지 않는다, 16.1.1·16.4.1). DOCTYPE이 든 파일과 남의 공연 가져오기는 보안 사건으로 남긴다(16.3.2·16.3.3).
   - 원본 파일은 어디에도 저장하지 않는다(5.3.1). 응답은 프레임워크의 JSON 직렬화기로만 만든다(1.2.3).

## 결과

- core-svc는 원본을 디코딩하지 않는 원칙을 지키면서, 이미지 올리기와 좌석맵 가져오기를 실제 PostgreSQL·실제 gRPC 서버까지 시험할 수 있다. image-worker가 생기기 전에는 개발 서버에서 이미지가 처리되지 않는다(개발용 gRPC 대역을 띄우면 된다).
- HOT-200은 어댑터 둘(작업 원장 처리, S3 저장)과 image-worker를 더하면 된다. 처리 결과 다시 검사와 게시는 이미 core-svc에 있다.
- SVG 읽개는 좌석맵에 쓰는 도형만 읽으므로, 디자인 도구가 낸 SVG의 곡선 경로·변형(`transform`)은 행 오류나 무시 목록으로 나온다. 파트너는 JSON·CSV로 대신 올릴 수 있다.

## 되돌릴 조건

- 파트너가 쓰는 디자인 도구의 SVG가 곡선·`transform` 때문에 자주 거절되면, 곡선을 선분으로 나누는 읽기를 더하거나 검토한 XML 라이브러리를 고른다(그때 ASVS 15.1.1 조치 기한 대상에 넣는다).
- 동기 처리의 30초 기다림이 게이트웨이 시간 초과와 맞지 않으면, 올리기를 '받음(202)·결과 조회'로 바꾸는 계약 변경을 따로 정한다.
