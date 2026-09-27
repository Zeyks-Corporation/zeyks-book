/**
 * Vercel Serverless Function entry point for Zeyks Book.
 *
 * Only what the browser cannot do by itself lives here: send the public contact
 * email (the API key must stay server-side) and, when a Node API host is wired
 * up, hand payment routes to the Express app.
 *
 * Sign-in and every book read/write go straight from the browser to the Neon
 * Data API and Neon Auth, guarded by row-level security. The Supabase session
 * bridge and membership fallbacks that used to live here are gone: they spoke to
 * a retired backend, and the bridge let any unauthenticated caller reset another
 * person's password to a value derived from their email address.
 *
 * The contact rules — bounds, escaping, header flattening — are imported from
 * `server/resend.js` so this function and the Express server cannot drift apart.
 */

const MAX_BODY_BYTES = 64 * 1024;

async function parseBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
  }
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({});
      }
    }, 500);

    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // A public endpoint must not build an unbounded string from a request.
      if (data.length > MAX_BODY_BYTES && !done) {
        done = true;
        clearTimeout(timer);
        resolve({ __tooLarge: true });
      }
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({});
      }
    });
  });
}

function sendJson(res, status, data) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(status).json(data);
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify(data));
}

/**
 * Send one email through Resend's REST API.
 *
 * Plain fetch rather than the SDK: this file stays loadable without any
 * dependency tracing, which is what keeps cold starts from failing.
 */
async function sendViaResend(payload) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !key.trim()) {
    console.log('[resend] Simulation: no API key configured, submission logged only.');
    return { success: true, simulated: true };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || body?.error || `Resend replied ${response.status}`);
  }
  return { success: true, data: body };
}

export default async function handler(req, res) {
  try {
    let rawUrl = req.url || '/';
    let url = rawUrl;
    if (!url.startsWith('/api')) {
      url = '/api' + (url.startsWith('/') ? url : '/' + url);
    }
    const cleanPath = url.split('?')[0];

    const candidatePaths = [
      cleanPath,
      rawUrl.split('?')[0],
      req.headers?.['x-matched-path'] || '',
      req.headers?.['x-forwarded-uri'] ? req.headers['x-forwarded-uri'].split('?')[0] : '',
    ].filter(Boolean);

    // Exact or prefixed, against the path and against its `/api`-less form: a
    // rewrite can hand this handler any of those shapes.
    const matchesPath = (route) => candidatePaths.some((p) =>
      p === route || p.startsWith(route + '/')
      || p.endsWith(route) || p.endsWith(route + '/')
      || p.endsWith('/api' + route) || p.endsWith('/api' + route + '/'));

    // 0. CORS preflight
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.end();
    }

    // 1. Resend status — the contact form asks before offering itself.
    if (req.method === 'GET' && (matchesPath('/api/resend/status') || matchesPath('/resend/status'))) {
      return sendJson(res, 200, { configured: Boolean(process.env.RESEND_API_KEY) });
    }

    // 2. Contact form
    if (req.method === 'POST' && (matchesPath('/api/contact') || matchesPath('/contact'))) {
      const payload = await parseBody(req);
      if (payload.__tooLarge) {
        return sendJson(res, 413, { error: 'That message is too large.' });
      }

      const { validateContactSubmission, buildContactPayload } = await import('../server/resend.js');
      const checked = validateContactSubmission(payload);
      if (!checked.ok) {
        return sendJson(res, 400, { error: checked.error });
      }

      try {
        return sendJson(res, 200, await sendViaResend(buildContactPayload(checked.values)));
      } catch (e) {
        console.error('[contact] send failed:', e?.message ?? e);
        return sendJson(res, 502, { error: 'Failed to send message via Resend.' });
      }
    }

    // 3. Payment routes belong to the Express app, which needs a Node host.
    if (matchesPath('/api/payments') || matchesPath('/payments')) {
      req.url = url;
      try {
        const mod = await import('../server/index.js');
        return mod.default(req, res);
      } catch (importErr) {
        console.error('[Server Import Error]:', importErr);
        return sendJson(res, 503, {
          error: 'Online collection runs on the Node API server, which is not part of this deployment.',
        });
      }
    }

    return sendJson(res, 404, { error: 'API route not found.' });
  } catch (err) {
    console.error('[API Handler Error]:', err);
    return sendJson(res, 500, { error: err?.message || 'Internal server error' });
  }
}
