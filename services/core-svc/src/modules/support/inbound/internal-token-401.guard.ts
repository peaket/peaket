// 내부 토큰이 없거나 틀리면 401(공용 InternalTokenGuard의 403과 달리 support 내부 경로의 계약이다, F-06-4).
// 판정 규칙·시작 차단은 공용 가드를 그대로 쓴다(local·ci만 토큰 없이 통과, 그 밖은 시작 차단).
import { ExecutionContext, Injectable, Optional, Inject, UnauthorizedException } from '@nestjs/common';
import { INTERNAL_TOKEN, INTERNAL_TOKEN_REQUIRED, InternalTokenGuard } from '@peaket/platform';

@Injectable()
export class InternalToken401Guard extends InternalTokenGuard {
  constructor(
    @Inject(INTERNAL_TOKEN) expected?: string,
    @Optional() @Inject(INTERNAL_TOKEN_REQUIRED) required = false,
  ) {
    super(expected, required);
  }

  override canActivate(context: ExecutionContext): boolean {
    if (!super.canActivate(context)) throw new UnauthorizedException('내부 토큰이 올바르지 않습니다');
    return true;
  }
}
