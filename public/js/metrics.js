// Reporting what happened, anonymously. See shared/metrics.js for what is
// counted; the server drops anything else.
//
// Fire and forget: a counter is never worth a retry, an error, or a delay in
// anything the person is doing.

import { isNativeApp, platformName } from './platform.js';

export function report(event, props = {}) {
  const body = JSON.stringify({ event, props });
  try {
    // keepalive lets "listen-ended" leave a page that is closing.
    fetch('/api/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* no fetch, no counter */ }
}

export const withPlatform = (props = {}) => ({ ...props, platform: platformName, shell: isNativeApp ? 'app' : 'web' });
