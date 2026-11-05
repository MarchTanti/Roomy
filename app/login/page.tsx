import { redirect } from 'next/navigation';

import { resolveUserByToken } from '@/lib/auth';
import { readAuthToken } from '@/lib/auth/cookie';

import { LoginForm } from './login-form';

/**
 * The sign-in page.
 *
 * Someone who is already signed in has no business here, so they go straight
 * to where they were going.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await resolveUserByToken(await readAuthToken());
  const params = await searchParams;
  const requested = typeof params.next === 'string' ? params.next : '/chat';
  // Only a path on this site is a valid destination.
  const next = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/chat';

  if (user) redirect(next);

  return <LoginForm next={next} />;
}
