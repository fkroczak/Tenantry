// Lokaler HTTPS-Testserver, der sich als Microsoft-Hosts ausgibt (nur für e2e).
import { createServer } from 'node:https';

export function startServer({ key, cert, port }) {
  const server = createServer({ key, cert }, (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const host = url.hostname;
    const cookie = req.headers.cookie ?? '';
    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><title>${host}</title><body>${body}</body>`);
    };

    if (url.pathname === '/login') {
      // Simulierter Login: setzt HttpOnly-Session (Host-only), Domain-Cookie und JS-Cookie.
      const user = url.searchParams.get('user') ?? 'anon';
      res.setHeader('set-cookie', [
        `ESTSAUTH=${user}; Path=/; Secure; HttpOnly; SameSite=None`,
        `buid=${user}-buid; Domain=microsoftonline.com; Path=/; Secure; SameSite=None; Max-Age=3600`,
        `jsvisible=${user}-js; Path=/; Secure; SameSite=None`,
      ]);
      return html(`logged in as ${user}`);
    }
    if (url.pathname === '/redirect') {
      // Set-Cookie auf einem 302 (typisch für Login-Flows)
      const user = url.searchParams.get('user') ?? 'anon';
      res.writeHead(302, {
        location: 'https://outlook.office.com/owa',
        'set-cookie': `OpenIdConnect.token=${user}-oidc; Domain=office.com; Path=/; Secure; HttpOnly; SameSite=None`,
      });
      return res.end();
    }
    if (url.pathname === '/api/whoami') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ host, cookie }));
    }
    // Standard: zeigt den empfangenen Cookie-Header an.
    return html(`<pre id="cookie">${cookie.replace(/</g, '&lt;')}</pre>`);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}
