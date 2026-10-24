// GitHub Pages stays the web host. Only this API origin points to your Windows server.
// Keep HTTPS in production. A localhost origin is useful only for local development.
export const backendConfig = Object.freeze({
  apiBaseUrl: 'https://api.study.junhyuk.site',
});
