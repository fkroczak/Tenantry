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
    // --- SharePoint-Anmeldung (vereinfacht): Seite -> Login -> form_post -> 302 mit FedAuth ---
    if (host.endsWith('.sharepoint.com') && url.pathname === '/_forms/default.aspx' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        const user = f.get('id_token') ?? 'anon';
        const target = new URL(f.get('state') || '/', url.origin);
        target.searchParams.set('from', 'forms');
        res.writeHead(302, {
          location: target.href,
          'set-cookie': [
            // Wie SharePoint (Stand 11/2026): nach jedem Cookie wird die
            // partitionierte Variante gleichen Namens gelöscht.
            `FedAuth=${user}-fedauth; Path=/; Secure; HttpOnly; SameSite=None`,
            'FedAuth=; expires=Thu, 01-Jan-1970 08:00:00 GMT; path=/; SameSite=None; Partitioned; secure; HttpOnly',
            `rtFa=${user}-rtfa; Domain=sharepoint.com; Path=/; Secure; HttpOnly; SameSite=None`,
            'rtFa=; domain=sharepoint.com; expires=Thu, 01-Jan-1970 08:00:00 GMT; path=/; SameSite=None; Partitioned; secure; HttpOnly',
          ],
        });
        res.end();
      });
      return;
    }
    if (host.endsWith('.sharepoint.com') && url.pathname.startsWith('/_layouts/')) {
      const fed = /(?:^|; )FedAuth=([^;]*)/.exec(cookie)?.[1];
      if (fed) return html(`<p id="sp">SP-OK ${fed}</p><pre id="cookie">${cookie.replace(/</g, '&lt;')}</pre>`);
      if (url.searchParams.get('from') === 'forms') {
        // Wie SharePoint: direkt nach dem form_post fehlt FedAuth -> Fehlerseite.
        return html('<p id="sp">SP-FEHLER Das hat leider nicht geklappt</p>');
      }
      const auth = new URL('https://login.microsoftonline.com/sp-authorize');
      auth.searchParams.set('redirect_uri', `${url.origin}/_forms/default.aspx`);
      auth.searchParams.set('state', url.pathname);
      res.writeHead(302, { location: auth.href });
      return res.end();
    }
    if (url.pathname === '/sp-authorize') {
      // response_mode=form_post: automatisch abgesendetes Formular zurück zu SharePoint
      const user = /(?:^|; )ESTSAUTH=([^;]*)/.exec(cookie)?.[1] ?? 'anon';
      const esc = (v) => String(v).replace(/[&"<]/g, (c) => `&#${c.charCodeAt(0)};`);
      return html(
        `<form method="post" action="${esc(url.searchParams.get('redirect_uri'))}">` +
          `<input type="hidden" name="id_token" value="${esc(user)}">` +
          `<input type="hidden" name="state" value="${esc(url.searchParams.get('state'))}">` +
          `</form><script>document.forms[0].submit()</script>`,
      );
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
