const SUPABASE_URL = process.env.SUPABASE_URL
  || process.env.VITE_SUPABASE_URL
  || 'https://rlymuofhrreqwqhmmhqw.supabase.co';

const SUPABASE_KEY = process.env.SUPABASE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJseW11b2ZocnJlcXdxaG1taHF3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTc4NjM1MiwiZXhwIjoyMTA1MzYyMzUyfQ.udIsm-sMMU80P_iOpFcgRl7wPGvxu-utbPQdHKc9hxM';

const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || process.env.VITE_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJseW11b2ZocnJlcXdxaG1taHF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3ODYzNTIsImV4cCI6MjEwNTM2MjM1Mn0.PNyXm5YW3U-RSxFDYG-CU7e40r3hoNqv3BcEalfdXw8';

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  try {
    let url = req.url || '/';
    if (!url.startsWith('/api')) {
      url = '/api' + (url.startsWith('/') ? url : '/' + url);
    }
    const cleanPath = url.split('?')[0];

    // 1. Supabase Session Bridge
    if (req.method === 'POST' && cleanPath === '/api/auth/supabase-session') {
      const payload = await parseBody(req);
      const email = payload.email;
      const name = payload.name;
      if (!email || typeof email !== 'string') {
        return sendJson(res, 400, { error: 'Valid email is required.' });
      }
      const cleanEmail = email.trim().toLowerCase();

      const genRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'magiclink',
          email: cleanEmail,
        }),
      });

      const linkData = await genRes.json();
      if (!genRes.ok) {
        return sendJson(res, 500, {
          error: linkData.msg || linkData.error_description || linkData.message || 'Could not generate session link.',
        });
      }

      const userId = linkData.id || linkData.user?.id;

      // Update user with deterministic bridge password and confirmed status
      const deterministicPassword = `zb_auth_bridge_${cleanEmail}_v1!`;
      if (userId) {
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
          method: 'PUT',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            password: deterministicPassword,
            email_confirm: true,
          }),
        }).catch(() => {});
      }

      // Upsert profile row
      if (userId) {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            id: userId,
            email: cleanEmail,
            full_name: name || linkData.user_metadata?.full_name || cleanEmail.split('@')[0],
          }),
        }).catch(() => {});
      }

      // Exchange token_hash immediately into access_token and refresh_token
      let session = null;
      const tokenHash = linkData.hashed_token || linkData.properties?.hashed_token;
      const verType = linkData.verification_type || linkData.properties?.verification_type || 'magiclink';
      const emailOtp = linkData.email_otp || linkData.properties?.email_otp;

      if (tokenHash) {
        try {
          const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
            method: 'POST',
            headers: {
              apikey: SUPABASE_ANON_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              token_hash: tokenHash,
              type: verType,
            }),
          });
          if (verifyRes.ok) {
            session = await verifyRes.json();
          }
        } catch {
          // fallback to returning otp details
        }
      }

      return sendJson(res, 200, {
        access_token: session?.access_token || null,
        refresh_token: session?.refresh_token || null,
        email: cleanEmail,
        email_otp: emailOtp,
        token_hash: tokenHash,
        verification_type: verType,
        user_id: userId,
      });
    }

    // 2. Business Memberships Fallback
    if (req.method === 'POST' && cleanPath === '/api/business/my-memberships') {
      const payload = await parseBody(req);
      const email = payload.email;
      if (!email || typeof email !== 'string') {
        return sendJson(res, 400, { error: 'Email is required.' });
      }
      const cleanEmail = email.trim().toLowerCase();

      const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(cleanEmail)}&select=id`,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
        },
      );
      const profiles = await profileRes.json();
      const profile = Array.isArray(profiles) ? profiles[0] : null;

      if (!profile?.id) {
        return sendJson(res, 200, { memberships: [] });
      }

      const memRes = await fetch(
        `${SUPABASE_URL}/rest/v1/business_memberships?user_id=eq.${encodeURIComponent(profile.id)}&select=business_id,user_id,role,created_at`,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
        },
      );
      const memberships = await memRes.json();

      return sendJson(res, 200, {
        memberships: (Array.isArray(memberships) ? memberships : []).map((m) => ({
          businessId: m.business_id,
          userId: m.user_id,
          role: m.role || 'OWNER',
          createdAt: m.created_at || '',
        })),
      });
    }

    // 3. Business Get Fallback
    if (req.method === 'POST' && cleanPath === '/api/business/get') {
      const payload = await parseBody(req);
      const targetId = payload.businessId;
      if (!targetId || typeof targetId !== 'string') {
        return sendJson(res, 400, { error: 'Business ID is required.' });
      }

      const bizRes = await fetch(
        `${SUPABASE_URL}/rest/v1/businesses?id=eq.${encodeURIComponent(targetId)}&select=*`,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
          },
        },
      );
      const businesses = await bizRes.json();
      const business = Array.isArray(businesses) ? businesses[0] : null;

      if (!business) {
        return sendJson(res, 404, { error: 'Business not found.' });
      }
      return sendJson(res, 200, { business });
    }

    // 4. Resend status
    if (req.method === 'GET' && cleanPath === '/api/resend/status') {
      return sendJson(res, 200, { configured: Boolean(process.env.RESEND_API_KEY) });
    }

    // 5. Delegate remaining routes to Express server
    req.url = url;
    try {
      const serverPath = '../server/index.js';
      const mod = await import(/* @vite-ignore */ serverPath);
      const app = mod.default;
      return app(req, res);
    } catch (importErr) {
      console.error('[Server Import Error]:', importErr);
      return sendJson(res, 503, { error: 'Payment services are temporarily unavailable.' });
    }
  } catch (err) {
    console.error('[API Handler Error]:', err);
    return sendJson(res, 500, { error: err?.message || 'Internal server error' });
  }
}


