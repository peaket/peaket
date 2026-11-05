// purchase-svc 릴레이 프로세스 조립의 설정 값(BUILD_ORDER PRF-164, docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' DB 역할).
// 다시 만들기 반복이 쓰는 서비스 역할 DB 풀 모양만 본다(연결을 맺지 않는다). 조립 전체는 test-int/relay-app.int.test.ts가 실제 의존성으로 본다.
import { describe, expect, test } from 'vitest';
import { relayServiceDatabaseOptions } from '../src/relay-app.js';

describe('다시 만들기 반복의 서비스 역할 DB 풀(리뷰 고침 H1)', () => {
  test('ST26_리뷰 고침 H1_서비스 역할 DB는 일반 풀 모양(연결을 기다린다, profile general)이고 연결은 셋 이상(다시 만들기가 세 읽기를 함께 보낸다)이다. 주소는 받은 그대로, 이름은 purchase-svc-rebuild [ASVS v5.0.0-16.5.2]', () => {
    const url = 'postgres://purchase_svc@pgbouncer:6432/purchase';
    const o = relayServiceDatabaseOptions(url);
    expect(o.url).toBe(url);
    // 핫패스 모양(풀 대기 100ms)·연결 2개면 큰 회차에서 세 읽기 가운데 하나가 늘 풀 대기 초과로 실패한다(2026-11-05 코드 리뷰)
    expect(o.profile).toBe('general');
    expect(o.max).toBeGreaterThanOrEqual(3);
    // 정본 '연결 4개 [가정]'
    expect(o.max).toBe(4);
    expect(o.applicationName).toBe('purchase-svc-rebuild');
  });
});
