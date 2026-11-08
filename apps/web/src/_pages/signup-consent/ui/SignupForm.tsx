'use client';
// SCR-005 가입 마무리 폼(d5 §5.5, ADR-0203, BUILD_ORDER HOT-323). 한 열 폼(최대 560): ① 만 14세 확인 → ② 필수 동의 → ③ 선택 동의(휴대폰 번호)
// → ④ 닉네임 → ⑤ 본인확인 권유 → [가입 완료]. 휴대폰·태블릿은 [가입 완료]가 화면 아래 고정 띠, 데스크톱(lg)은 폼 맨 끝.
// - 동의는 모두 꺼진 채 시작한다(미리 켜 두지 않는다, d1 §3). 선택 동의는 필수 동의와 같은 묶음으로 켜지지 않는다.
// - 닉네임은 입력이 멈춘 뒤 300ms에 확인하고 앞 요청을 취소한다(POST /v1/identity/nickname-checks). 확정은 가입 마무리의 409다.
// - [가입 완료]·( 나중에 하기 ›): 가입 마무리(POST /v1/identity/signup-completions) 뒤 돌아갈 주소로 간다.
// - [지금 본인확인]: 검사가 통과하면 누른 동작 안에서 기관 창을 먼저 열고, 가입을 마친 뒤 그 창으로 본인확인을 시작한다. 결과를 다 보이면 돌아갈 주소로.
// - ( 만 14세 미만입니다 ›): 가입 취소(POST /v1/identity/signup-cancellations, 세션을 끝낸다) 뒤 CMP-046 안내.
// - 비로그인이면 로그인 화면으로, 이미 가입을 마쳤으면 돌아갈 주소로 간다. api-client는 늦게 가져온다.
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ConsentCheckbox } from '@peaket/ds/ConsentCheckbox';
import { FormErrorSummary } from '@peaket/ds/FormErrorSummary';
import { PermissionDenied } from '@peaket/ds/PermissionDenied';
import { WebShellModal, webModalButtonClass } from '@peaket/ds/WebShell';
import { PhoneField } from '@peaket/ds/PhoneField';
import { TextField } from '@peaket/ds/TextField';
import { refreshFanSession, useFanSession } from '@/entities/me';
import { VerifyFlowProvider, VerifyTrigger, VerifyWaitingStatus } from '@/features/identity-verify';
import { isUnauthorizedError, problemName } from '@/shared/api/refresh';
import { loginHrefAfterRefresh } from '@/shared/lib/token-refresh';
import { ERRORS, nicknameProblem, toSignupInput, validateSignup, type NickCheck, type SignupForm as Form } from '../model/signup';

const NICK_DEBOUNCE_MS = 300;
/** 본인확인 완료 토스트를 보이는 시간 [가정] */
const DONE_TOAST_MS = 1_500;
const FAILED = '가입을 마치지 못했습니다. 잠시 뒤 다시 시도해 주세요';

async function loadApi() {
  const [identity, api] = await Promise.all([import('@peaket/api-client/endpoints/identity'), import('@/shared/api')]);
  api.ensureBrowserApi();
  return { ...identity, withFanRefresh: api.withFanRefresh };
}

function Chevron() {
  return <i className="ic ic-chevron-right" aria-hidden="true" />;
}

const EMPTY: Form = { age: false, terms: false, privacy: false, marketing: false, phoneConsent: false, phone: '', nickname: '', nick: 'idle' };

export function SignupForm({ next }: { next: string }) {
  const session = useFanSession();
  const [f, setF] = useState<Form>(EMPTY);
  // 위쪽 요약은 다음 제출까지 그대로 둔다(칸을 고칠 때마다 요약이 바뀌면 첫 오류 칸으로 초점을 다시 옮긴다, HOT-323 새 맥락 리뷰 중간 1).
  // 고친 칸은 cleared에 넣어 그 칸 아래 오류만 걷는다
  const [errors, setErrors] = useState<{ fieldId: string; message: string }[]>([]);
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);
  // 보내는 중의 두 번째 보내기·[지금 본인확인]을 막는다(상태보다 먼저 바뀌는 지금 값)
  const busyRef = useRef(false);
  const [confirmUnder14, setConfirmUnder14] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [under14, setUnder14] = useState(false);
  const formRef = useRef(f);
  formRef.current = f;
  /** 칸을 고치면 그 칸의 지난 제출 오류를 걷는다(지금 값의 상태, 예: 닉네임 확인 결과가 보이게) */
  const FIELD_OF: Partial<Record<keyof Form, string>> = { age: 'c-age', terms: 'c-terms', privacy: 'c-privacy', phoneConsent: 'f-phone', phone: 'f-phone', nickname: 'f-nick' };
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    const id = FIELD_OF[k];
    if (id) setCleared((c) => (c.has(id) ? c : new Set(c).add(id)));
  };

  // 이 화면에서 가입을 마쳤다: 그 뒤의 '이미 가입함' 이동은 하지 않는다([지금 본인확인]은 결과를 다 보인 뒤 돌아갈 주소로 간다)
  const completedHere = useRef(false);
  // 비로그인은 로그인 화면으로, 처음 열 때 이미 가입을 마쳤으면 돌아갈 주소로(가입 취소 뒤에는 그대로 안내를 둔다)
  useEffect(() => {
    if (under14 || completedHere.current) return;
    if (session.status === 'guest') location.replace(loginHrefAfterRefresh(`${location.pathname}${location.search}`));
    else if (session.status === 'member' && session.me.signupCompleted) location.replace(next);
  }, [session, next, under14]);

  // ④ 닉네임 확인: 꼴이 맞을 때만, 멈춘 뒤 300ms, 앞 요청 취소
  useEffect(() => {
    const nickname = f.nickname;
    const setNick = (nick: NickCheck) => setF((x) => (x.nick === nick ? x : { ...x, nick }));
    // 입력하는 동안은 상태를 비우고, 멈춘 뒤 300ms에 꼴 문제를 보이거나 서버에 묻는다(키마다 '확인 중'·오류가 깜빡이지 않게)
    setNick('idle');
    if (nickname.trim() === '') return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const local = nicknameProblem(nickname);
      if (local === 'length' || local === 'chars') {
        setNick(local);
        return;
      }
      setNick('checking');
      void loadApi()
        .then(({ withFanRefresh, createIdentityNicknameCheck }) => withFanRefresh(() => createIdentityNicknameCheck({ nickname }, { signal: ctrl.signal })))
        .then((r) => {
          if (ctrl.signal.aborted) return;
          setNick(r.data.available ? 'ok' : r.data.reason === 'invalid' ? 'invalid' : 'taken');
        })
        .catch(() => {
          // 확인을 못 해도 막지 않는다(확정은 가입 마무리가 한다)
          if (!ctrl.signal.aborted) setNick('error');
        });
    }, NICK_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [f.nickname]);

  /** 입력 검사. 오류면 위쪽 요약을 다시 그려 첫 칸으로 초점을 옮긴다 */
  const check = useCallback((): boolean => {
    if (busyRef.current) return false;
    const e = validateSignup(formRef.current);
    setErrors(e);
    setCleared(new Set());
    if (e.length > 0) setTries((n) => n + 1);
    return e.length === 0;
  }, []);

  /** 가입 마무리. 이미 마쳤으면 성공으로 본다(다시 시도한 [지금 본인확인]) */
  const complete = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setFailed(null);
    setBusy(true);
    try {
      const { withFanRefresh, createIdentitySignupCompletion } = await loadApi();
      await withFanRefresh(() => createIdentitySignupCompletion(toSignupInput(formRef.current)));
      completedHere.current = true;
      void refreshFanSession();
      return true;
    } catch (e) {
      const name = problemName(e);
      if (name === 'signup-already-completed') {
        completedHere.current = true;
        return true;
      }
      // 만 14세 미만으로 정리 중인 계정: 로그인 화면이 아니라 이 화면의 안내를 보인다(d5 §5.5 '만 14세 미만', ADR-0235 결정 6)
      if (name === 'under-14') {
        setUnder14(true);
        return false;
      }
      if (isUnauthorizedError(e)) {
        location.assign(loginHrefAfterRefresh(`${location.pathname}${location.search}`));
        return false;
      }
      if (name === 'nickname-taken' || name === 'nickname-invalid') {
        const nick: NickCheck = name === 'nickname-taken' ? 'taken' : 'invalid';
        setF((x) => ({ ...x, nick }));
        setErrors([{ fieldId: 'f-nick', message: nick === 'taken' ? ERRORS.nickTaken : ERRORS.nickChars }]);
        setCleared(new Set());
        setTries((n) => n + 1);
        return false;
      }
      setFailed(FAILED);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busyRef.current || !check()) return;
    void complete().then((ok) => {
      if (ok) location.assign(next);
    });
  };

  /** 확인 대화상자의 [가입 취소] 뒤. 401이면 세션이 이미 끝났다(앞 요청이 처리된 뒤 응답만 끊긴 경우 등): 안내를 보인다. 409면 이미 가입을 마쳤다 */
  const cancelUnder14 = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setConfirmUnder14(false);
    setFailed(null);
    setBusy(true);
    try {
      const { withFanRefresh, createIdentitySignupCancellation } = await loadApi();
      await withFanRefresh(() => createIdentitySignupCancellation({ reason: 'UNDER_14' }));
      setUnder14(true);
      void refreshFanSession();
    } catch (e) {
      if (isUnauthorizedError(e)) setUnder14(true);
      else if (problemName(e) === 'signup-already-completed') location.replace(next);
      else setFailed('처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (under14) {
    return (
      <PermissionDenied
        variant="inline"
        icon="ban"
        tone="danger"
        headingLevel={1}
        title="만 14세 미만은 가입할 수 없습니다"
        description="피켓은 법정대리인 동의 절차를 두지 않아 만 14세 미만은 가입할 수 없습니다. 계정을 만들지 않았고 소셜 로그인으로 받은 정보도 지웠습니다."
        style={{ padding: '88px 24px 40px' }}
        actions={
          <Link className="link-more" href="/">
            홈으로
            <Chevron />
          </Link>
        }
      />
    );
  }

  const nickBadge =
    f.nick === 'checking' ? (
      <span className="row" style={{ gap: 6 }}>
        <span className="spinner" aria-hidden="true" />
        <span className="badge">확인 중</span>
      </span>
    ) : f.nick === 'taken' ? (
      <span className="badge badge-danger">이미 사용 중</span>
    ) : f.nick === 'ok' ? (
      <span className="badge badge-success">사용 가능</span>
    ) : null;
  const err = (id: string) => (cleared.has(id) ? undefined : errors.find((e) => e.fieldId === id)?.message);
  const nickLive = f.nick === 'length' ? ERRORS.nickLength : f.nick === 'chars' || f.nick === 'invalid' ? ERRORS.nickChars : f.nick === 'taken' ? ERRORS.nickTaken : undefined;

  return (
    <VerifyFlowProvider
      next={next}
      canStart={check}
      beforeStart={complete}
      // 완료면 토스트를 잠시 보인 뒤(토스트는 화면을 옮기면 사라진다), 아니면 대화상자를 닫은 뒤 돌아갈 주소로
      onSettled={(o) => (o === 'success' ? void window.setTimeout(() => location.assign(next), DONE_TOAST_MS) : location.assign(next))}
    >
      <div className="px-4 pt-7 pb-10 md:px-6 md:pt-10 md:pb-12 lg:px-8 lg:pt-14 lg:pb-[72px]">
        <form className="col mx-auto w-full max-w-[560px] gap-7 md:gap-8" aria-labelledby="h-signup" id="signup-form" noValidate onSubmit={submit}>
          <h1 className="t-xl lg:text-[32px] lg:leading-[42px]" id="h-signup">
            피켓 가입을 마무리합니다
          </h1>

          {errors.length > 0 ? <FormErrorSummary key={tries} focusFirst errors={errors} /> : null}
          {failed ? (
            <div className="banner banner-danger" role="alert">
              <i className="ic ic-alert" aria-hidden="true" />
              <div className="banner-body">{failed}</div>
            </div>
          ) : null}

          {/* ① 만 14세 확인. 미만이면 가입을 취소하고 안내(CMP-046)로 바꾼다 */}
          <div className="col" style={{ gap: 6 }}>
            <ConsentCheckbox
              id="c-age"
              label="만 14세 이상입니다"
              checked={f.age}
              onCheckedChange={(v) => set('age', v)}
              error={err('c-age')}
              hint="만 14세 미만은 가입할 수 없습니다. 예매 전 휴대폰 본인확인 때 생년월일로 한 번 더 확인합니다"
            />
            <button className="link-more" type="button" aria-haspopup="dialog" onClick={() => setConfirmUnder14(true)} disabled={busy} style={{ marginLeft: 32, alignSelf: 'flex-start' }}>
              만 14세 미만입니다
              <Chevron />
            </button>
          </div>

          {/* ② 필수 동의 */}
          <fieldset className="col" style={{ gap: 12 }}>
            <legend className="eyebrow" style={{ marginBottom: 12 }}>
              필수 동의
            </legend>
            <ConsentCheckbox
              id="c-terms"
              label="이용약관 동의"
              checked={f.terms}
              onCheckedChange={(v) => set('terms', v)}
              error={err('c-terms')}
              detailHref="/policy/terms"
              detailLabel="이용약관 보기"
            />
            <ConsentCheckbox
              id="c-privacy"
              label="개인정보 수집·이용 동의"
              checked={f.privacy}
              onCheckedChange={(v) => set('privacy', v)}
              error={err('c-privacy')}
              detailHref="/policy/privacy"
              detailLabel="개인정보 수집·이용 동의 내용 보기"
            />
            <div className="col" style={{ gap: 8, paddingLeft: 32 }}>
              <Link className="link-more" href="/policy/privacy">
                개인정보 처리방침
                <Chevron />
              </Link>
              <p className="t-sm muted">
                예매 때 파트너에게 제공하는 항목을 미리 알립니다{' '}
                <Link className="link-more" href="/policy/privacy" aria-label="예매 때 파트너에게 제공하는 항목 보기">
                  보기
                  <Chevron />
                </Link>
              </p>
            </div>
          </fieldset>

          {/* ③ 선택 동의: 휴대폰 번호 수집에 동의해야 칸이 켜진다 */}
          <fieldset className="col" style={{ gap: 12 }}>
            <legend className="eyebrow" style={{ marginBottom: 12 }}>
              선택 동의
            </legend>
            <ConsentCheckbox id="c-mkt" requirement="optional" label="마케팅 알림 받기" checked={f.marketing} onCheckedChange={(v) => set('marketing', v)} />
            <ConsentCheckbox id="c-phone" requirement="optional" label="휴대폰 번호 수집" aria-controls="f-phone" checked={f.phoneConsent} onCheckedChange={(v) => set('phoneConsent', v)} />
            <PhoneField
              id="f-phone"
              label="휴대폰 번호"
              optional
              disabled={!f.phoneConsent}
              value={f.phone}
              onChange={(e) => set('phone', e.target.value)}
              error={err('f-phone')}
              hint="휴대폰 번호 수집에 동의하면 입력할 수 있습니다"
              fieldClassName="pl-8"
            />
          </fieldset>

          {/* ④ 닉네임: 멈춘 뒤 300ms에 중복 확인 */}
          <TextField
            id="f-nick"
            label="닉네임"
            requiredMark
            autoComplete="nickname"
            maxLength={40}
            value={f.nickname}
            onChange={(e) => set('nickname', e.target.value)}
            hint="2~12자, 이모지는 쓸 수 없습니다"
            error={err('f-nick') ?? nickLive}
            aria-describedby="f-nick-s"
            trailing={
              <span id="f-nick-s" role="status">
                {nickBadge}
              </span>
            }
          />

          {/* ⑤ 본인확인 권유(CMP-017 info). [지금 본인확인]은 가입을 마친 뒤 이 화면 위에 기관 창을 연다(SCR-006) */}
          <div className="banner banner-info">
            <i className="ic ic-shield" aria-hidden="true" />
            <div className="banner-body col" style={{ gap: 12 }}>
              <p>
                <strong>입장권을 사려면 휴대폰 본인확인이 필요합니다.</strong> 지금 해 두면 오픈 때 바로 들어갑니다
              </p>
              <div className="row wrap" style={{ gap: '8px 16px' }}>
                <VerifyTrigger className="btn btn-secondary">지금 본인확인</VerifyTrigger>
                <button className="link-more" type="submit" form="signup-form" disabled={busy}>
                  나중에 하기
                  <Chevron />
                </button>
              </div>
              <VerifyWaitingStatus />
            </div>
          </div>

          <button className="btn btn-primary btn-lg btn-block hidden lg:flex" type="submit" disabled={busy} aria-busy={busy || undefined}>
            가입 완료
          </button>
        </form>
      </div>
      {/* 만 14세 미만 확인(되돌릴 수 없다: 계정 정리를 시작하고 로그인이 끝난다, 문구 [가정]) */}
      <WebShellModal
        open={confirmUnder14}
        onClose={() => setConfirmUnder14(false)}
        title="만 14세 미만이면 가입할 수 없습니다"
        describedBy="u14-desc"
        actions={
          <>
            <button className={webModalButtonClass('danger')} type="button" onClick={() => void cancelUnder14()}>
              가입 취소
            </button>
            <button className={webModalButtonClass('ghost')} type="button" onClick={() => setConfirmUnder14(false)}>
              돌아가기
            </button>
          </>
        }
      >
        <p id="u14-desc">가입을 취소하면 소셜 로그인으로 받은 정보를 지우고 로그아웃합니다. 되돌릴 수 없습니다.</p>
      </WebShellModal>
      <div className="bottom-bar sticky bottom-0 z-10 md:px-6 md:pt-3 md:pb-5 lg:hidden">
        <button className="btn btn-primary btn-lg btn-block md:mx-auto md:max-w-[560px]" type="submit" form="signup-form" disabled={busy} aria-busy={busy || undefined}>
          가입 완료
        </button>
      </div>
    </VerifyFlowProvider>
  );
}
