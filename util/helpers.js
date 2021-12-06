import Sentry from '@sentry/node';
import Config from './config.js';

export function capture_sentry_exception(err) {
  if (Config.ENABLE_SENTRY) {
      Sentry.captureException(err);
  }
}