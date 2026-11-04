# 좌석맵 iOS 실기기 확인 목록(소유자 몫)

- **독자와 용도**: 소유자가 iPhone·iPad에서 `@peaket/seatmap` 시연 페이지를 열어 볼 때 쓰는 목록이다. 이 PC에는 iOS 실기기가 없어 자동 검사(`seatmap-pkg`, 리눅스 WebKit)로는 실기기 프레임 시간을 볼 수 없다(docs/PROGRESS.md 턴 규칙 '소유자 몫', BUILD_ORDER HOT-120).
- **준비**: `pnpm --filter @peaket/seatmap demo:build`로 `packages/seatmap/dist-demo`를 만들고, 같은 망의 기기에서 열 수 있게 띄운다(예: `node tools/web-checks/lib/serve.mjs --root packages/seatmap/dist-demo --port 4210`을 이 PC의 IP로 연다. 그 도구는 127.0.0.1에만 뜨므로 다른 정적 서버를 쓴다).

| 볼 것 | 기준(정본) | 적을 것 |
| --- | --- | --- |
| iOS·iPadOS 판과 기기 | NFR-019(16.4 이상) | 판, 기기 이름 |
| 첫 그림(전체 배치) | §5.2 단계 5가 100ms 이하, 합 1초 미만 | 체감, 가능하면 Safari 웹 속성의 시간선 |
| [+]로 좌석이 보일 때까지 확대하고 [+]·[−]·[전체 보기]를 여러 번 누른다(끌기·핀치는 좌석 화면 HOT-350에서 붙는다) | 프레임이 끊기지 않는다(BAS-190 리눅스 WebKit은 그리기 한 번 175ms) | 끊김 여부 |
| 좌석 누르기 | 누른 좌석이 내 좌석 색(체크)이 된다 | 맞음·틀림 |
| 홈 화면 앱으로 연 경우 | 같은 동작 | 차이 |

- **넘으면**: 단계 5가 100ms를 넘거나 고를 수 있는 배율에서 프레임이 끊기면, 구역 도형만 담은 작은 자료로 겹친 임시 캔버스에 첫 그림을 그리는 길과 작은 타일 비트맵으로 바꾼다(tools/web-checks/seatmap/RESULT.md, docs/frontend.md §5.2).
