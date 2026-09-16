import { handleWeatherRequest } from './weather.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/weather') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
      }
      return handleWeatherRequest(request, ctx.waitUntil.bind(ctx));
    }

    return env.ASSETS.fetch(request);
  },
};
