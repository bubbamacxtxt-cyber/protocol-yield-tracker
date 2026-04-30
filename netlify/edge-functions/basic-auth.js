export default async (request, context) => {
  const auth = request.headers.get('Authorization');
  const expected = 'Basic ' + btoa(':mezz123');

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
