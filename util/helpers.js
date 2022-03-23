import fs from 'fs';
import Mustache from 'mustache';

import Sentry from '@sentry/node';
import Config from './config.js';


const base = fs.readFileSync('public/index.html', 'utf-8');


export function capture_sentry_exception(err) {
  if (Config.ENABLE_SENTRY) {
    Sentry.captureException(err);
    Sentry.configureScope((scope) => scope.clear());
  } else {
    console.error(err);
  }
}

export const render_error = async (req, error, code, data = {}) => {
  data.error = error;
  data.title = data.title || `Error ${code} - o!RL`;
  data.base_url = Config.website_base_url;
  data.client_id = Config.osu_v2api_client_id;
  return await Mustache.render(base, data);
};
