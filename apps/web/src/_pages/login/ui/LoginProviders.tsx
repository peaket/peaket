'use client';
// SCR-004 세 제공자 버튼(d5 §5.4, ADR-0062: 가이드 색·문구, 같은 크기·같은 비중으로 쌓는다).
// - 기본: 버튼마다 로그인 시작 폼(POST /login/{provider}, identity §2). 지금 창에서 제공자로 이동한다(ADR-0119)
// - 진행 중: 폼을 보내면 누른 버튼만 스피너(aria-busy), 나머지는 비활성(d5 §5.4 '진행 중'). 폼은 그대로 둔다:
//   보내는 중에 폼이 문서에서 빠지면 브라우저가 보내기를 취소한다(HOT-321 새 맥락 리뷰 높음). 진행 중에 다시 보내지 않는다.
//   뒤로 가기로 돌아오면(페이지 보관) 풀린다
// - 제공자 장애: 로그인 경로가 error=down&provider=로 돌려보낸 그 버튼만 이유 있는 비활성과 이유 한 줄(ADR-0202 결정 4)
import { useEffect, useState } from 'react';
import { LOGIN_PROVIDERS, PROVIDER_LOGIN_LABEL, PROVIDER_NAME, type ProviderId } from '@/entities/provider';
import { LoginStartForm } from '@/features/social-login';

export function LoginProviders({ next, down }: { next: string; down: ProviderId | null }) {
  const [pressed, setPressed] = useState<ProviderId | null>(null);
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setPressed(null);
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  return (
    <div className="col" style={{ gap: 10 }} role="group" aria-label="소셜 계정으로 로그인">
      {LOGIN_PROVIDERS.map((p) => {
        const cls = `btn btn-${p} btn-lg btn-block`;
        const label = PROVIDER_LOGIN_LABEL[p];
        const mark = <i className={`prov prov-${p}`} aria-hidden="true" />;
        if (down === p) {
          const why = `${p}-down`;
          return (
            <div key={p} className="col" style={{ gap: 8 }}>
              <button className={cls} type="button" aria-disabled="true" aria-describedby={why}>
                {mark}
                {label}
              </button>
              <p className="row t-sm tx-warning" id={why} role="status" style={{ alignItems: 'flex-start', gap: 6 }}>
                <i className="ic ic-alert ic-16" aria-hidden="true" />
                <span>지금은 {PROVIDER_NAME[p]} 로그인을 쓸 수 없습니다</span>
              </p>
            </div>
          );
        }
        const busy = pressed === p;
        return (
          <LoginStartForm
            key={p}
            provider={p}
            returnTo={next}
            onSubmit={(e) => {
              // 이미 보낸 뒤의 두 번째 보내기는 막는다(Enter 연타 등)
              if (pressed) e.preventDefault();
              else setPressed(p);
            }}
          >
            <button className={cls} type="submit" aria-busy={busy || undefined} disabled={pressed !== null && !busy}>
              {busy ? <span className="spinner" aria-hidden="true" /> : mark}
              {label}
            </button>
          </LoginStartForm>
        );
      })}
    </div>
  );
}
