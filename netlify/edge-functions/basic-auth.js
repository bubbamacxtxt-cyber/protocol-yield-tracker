// Basic auth gate for the dashboard.
//
// Password is read from the Netlify env var BASIC_AUTH_PASSWORD.
// Set it in Netlify dashboard: Site settings → Environment variables.
// Username is empty (the auth header is `:password` base64-encoded).
//
// If the env var is missing the site fails closed (returns 503) so a
// misconfigured deploy doesn't accidentally expose the dashboard.

export default async (request, context) => {
  const password = Netlify.env.get('BASIC_AUTH_PASSWORD');

  if (!password) {
    return new Response('Auth not configured', { status: 503 });
  }

  const auth = request.headers.get('Authorization');
  const expected = 'Basic ' + btoa(':' + password);

  if (auth === expected) {
    return context.next();
  }

  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Protocol Yield Tracker"',
    },
  });
};

export const config = { path: '/*' };
