// 명령 9(비핵심 기능 끄기)의 core-svc 읽는 쪽(F-02-5 OPS-300, ADR-0365 결정 17).
// 'PLATFORM:FEATURE_FLAG:reviews'가 {enabled: false}일 때만 팬 후기 경로를 503 review-feature-off로 막는다.
// 값이 없거나 true면 그대로이고, 바뀜은 설정 저장소의 바뀜 알림으로 다음 요청부터 바로 반영한다(별도 캐시 없음).
import { type CanActivate, Inject, Injectable, Optional } from '@nestjs/common';
import { ProblemError, type SettingsStore } from '@peaket/platform';

export const REVIEW_FEATURE_FLAG_KEY = 'PLATFORM:FEATURE_FLAG:reviews';
/** 리뷰 모듈에 설정 저장소를 넘기는 토큰(없으면 늘 켜짐) */
export const REVIEW_SETTINGS = Symbol('core.ReviewSettings');

/** 끈 값({enabled: false})일 때만 거짓. 저장소가 없거나 값이 없거나 true면 참 */
export function reviewsEnabled(settings?: Pick<SettingsStore, 'get'>): boolean {
  const entry = settings?.get(REVIEW_FEATURE_FLAG_KEY);
  if (!entry) return true;
  const v = entry.value;
  return !(typeof v === 'object' && v !== null && !Array.isArray(v) && (v as { enabled?: unknown }).enabled === false);
}

/** 팬 v1 후기 경로에만 거는 가드. 관제(v1/ops)·내부(internal) 경로에는 걸지 않는다 */
@Injectable()
export class ReviewFeatureGuard implements CanActivate {
  constructor(@Optional() @Inject(REVIEW_SETTINGS) private readonly settings?: Pick<SettingsStore, 'get'>) {}

  canActivate(): boolean {
    if (reviewsEnabled(this.settings)) return true;
    throw new ProblemError({ type: 'review-feature-off', status: 503, title: '후기 기능이 꺼져 있습니다(명령 9)', retryAfterSeconds: 60 });
  }
}
