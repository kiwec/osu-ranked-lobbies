import fs from 'fs';
import Mustache from 'mustache';

import Sentry from '@sentry/node';
import Config from './config.js';

export function capture_sentry_exception(err) {
  if (Config.ENABLE_SENTRY) {
    Sentry.captureException(err);
  }
}

export const render_with_layout = async (main_template, data = {}) => {
  data.title = data.title || 'o!RL';
  data.meta = data.meta || '';

  const layout = await fs.promises.readFile('views/common/layout.html', 'utf-8');

  const partials = {};
  partials.main = await fs.promises.readFile(main_template, 'utf-8');

  return Mustache.render(layout, data, partials);
};

export const render_error = async (error, code, data = {}) => {
  data.error = error;
  data.title = data.title || `Error ${code} - o!RL`;

  let error_page = 'views/errors/default.html';
  if (fs.existsSync(`views/errors/${code}.html`)) {
    error_page = `views/errors/${code}.html`;
  }

  return render_with_layout(error_page, data);
};
