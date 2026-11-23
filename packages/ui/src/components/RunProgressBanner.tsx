import type { RunProgressEvent } from '@ntc/core';

export function RunProgressBanner({ event }: { readonly event: RunProgressEvent | null }) {
  const isFailure = event?.status === 'FAILED';
  const cls = !event
    ? ''
    : isFailure
      ? 'alert alert-danger'
      : event.step === 'COMPLETED'
        ? 'alert alert-ok'
        : 'alert alert-warn';

  return (
    <div className={cls || undefined} role={isFailure ? 'alert' : 'status'} aria-live={isFailure ? 'assertive' : 'polite'}>
      {event ? (
        <>
          <strong>
            [{event.dfe} / {event.step}]
          </strong>{' '}
          {event.message}
          {event.attempt !== undefined && event.maxAttempts !== undefined
            ? ` (tentativa ${event.attempt}/${event.maxAttempts})`
            : ''}
        </>
      ) : null}
    </div>
  );
}
