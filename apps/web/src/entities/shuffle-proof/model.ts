// 셔플 검증 정보 목업(SCR-019, d5 §5.19, docs/features/queue-admission.md §3). 해시·라운드·주소는 캔버스 보드 SCR-019의 값 그대로다(합성 값).
// 시각은 KST. 실제로는 셔플 검증 정보 API와 같은 브라우저의 참가 토큰 해시(IndexedDB)에서 읽는다(frontend §2.5).

export interface ShuffleProof {
  /** 회차 id(공연 상세 주소의 id) */
  eventId: string;
  /** 로비 없는 선착순(FIFO) 공연이면 ①~③(공개 기록) 없이 동시 도착 묶음만 있다 */
  fifo: boolean;
  /** ① 로비 개방 */
  lobby: { at: string; seedHash: string; chain: string; round: string; algorithm: string };
  /** ② 오픈 정각(T=0) */
  open: { at: string; merkleRoot: string };
  /** ③ 결과 생성(drand 값·서명) ④ 결과 파일 */
  result: { roundLabel: string; beacon: string; signature: string; /** 결과 파일 주소의 앞부분. 뒤에 '{앞 세 자리}.json'을 붙인다 */ fileBase: string; publishedAt: string };
  /** ⑤ 원본 시드(오픈 60분 뒤 공개) */
  seed: { at: string; value: string };
  /** ⑧ 동시 도착 묶음 */
  batch: { window: string; committedAt: string; seedHash: string; merkleRoot: string; round: string; beacon: string; signature: string; fileBase: string; seed: string };
  /** ⑥⑨ 같은 브라우저에 있던 토큰 해시(자동 채움)와 검증 결과 예시(d5 §5.19 예시 3,215) */
  myToken: string;
  myRank: string;
}

const LUMEN: ShuffleProof = {
  eventId: 'evt-lumen-1025',
  fifo: false,
  lobby: {
    at: '10/14(수) 19:50',
    seedHash: '3f9a28d6d7a5cefdbd2aa9e324dd25c45335d581f46e6b7ba9665d97e5f1c21e',
    chain: 'quicknet',
    round: '33,057,413 · 20:00:03',
    algorithm: 'v1',
  },
  open: { at: '10/14(수) 20:00', merkleRoot: '9be0cc5083e40d28749b6611d3bff860cb9464502f294aca7462bcb9ca0477a1' },
  result: {
    roundLabel: 'drand 33,057,413',
    beacon: '4f5b0780fb27325ff06c52117e2d68813aa70be60c57217a70cde559e9eb4f03',
    signature: '8e40163b59a611b863d6d6fe22bd945c05338290404640663fb5bd21bb99ddfe66d21448a5208b745b9346725a61cd8b',
    fileBase: 'https://queue-files.peaket.example/v1/queues/01a0c17a-1a80-7d32-85dd-07b17af42144/shuffle-results/',
    publishedAt: '10/14(수) 20:00:07',
  },
  seed: { at: '10/14(수) 21:00', value: '781c11b485031d358d687bafcdcd7844c5a850df145d6c4ec378630ebfe47c10' },
  batch: {
    window: '10/14(수) 20:00:00~20:00:02',
    committedAt: '10/14(수) 19:50',
    seedHash: '0c3df65966a7f3671d2ae9a9de5bf04407ba113e26bf1eca8b6a3a6a09d01d8b',
    merkleRoot: '46f2bbf1029abfc74fa132dc3d7b08f1ea6141748744e03684665815c8980268',
    round: '33,057,414 · 20:00:06',
    beacon: '7d2c0e5a11f4f19b6a3c44d1be2f7a90c3d85e6172ab94f0d1c6e38b5f2a7c14',
    signature: '91a3f7c2d4e85b6079ce1ad24f83b65c7e10d92a4bf6c387d15e20a9b4c76f38e2d1a05bc9674e13f8a2',
    fileBase: 'https://queue-files.peaket.example/v1/queues/01a0c17a-1a80-7d32-85dd-07b17af42144/batch-results/',
    seed: '380facd2806f22c81713b00e3b2c2a5ca25d18e91a01ab61d0ccb61460cc27bf',
  },
  myToken: '61e2d59bf11b9e03b4fe55db2ee62b621171dedb9871aac0b486b7f1ab15ee34',
  myRank: '3,215',
};

/** 오픈 시각 '10/14(수) 20:00'(셔플 전 안내) */
export const OPEN_TEXT = '10/14(수) 20:00';

/** 재현 규격·알고리즘 설명(ADR-0050 결정 7, queue-admission §3). 공개 문서 주소는 [가정] — 배포 단계에서 정한다 */
export const SHUFFLE_SPEC_URL = 'https://docs.peaket.example/queue/shuffle-spec';

/** 회차의 셔플 검증 정보. 퍼블리싱에서는 모든 회차가 LUMEN 10/25 값을 빌려 쓰고, 정렬 방식만 공연 것을 따른다 */
export function getShuffleProof(eventId: string, fifo: boolean): ShuffleProof {
  return { ...LUMEN, eventId, fifo };
}
