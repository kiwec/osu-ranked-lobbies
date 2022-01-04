import fs from 'fs';
import Mustache from 'mustache';

import Sentry from '@sentry/node';
import Config from './config.js';

export function capture_sentry_exception(err) {
  if (Config.ENABLE_SENTRY) {
    Sentry.captureException(err);
  } else {
    console.error(err);
  }
}

export const render_with_layout = async (req, main_template, data = {}) => {
  data.title = data.title || 'o!RL';
  data.base_url = Config.website_base_url;
  data.client_id = Config.osu_v2api_client_id;
  data.darkTheme = req.theme === 'dark';
  data.user_id = req.user_id;

  const layout = await fs.promises.readFile('views/common/layout.html', 'utf-8');

  const partials = {};
  partials.main = await fs.promises.readFile(main_template, 'utf-8');
  partials.meta = data.meta || '';

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
