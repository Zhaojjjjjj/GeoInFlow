'use client';
import { Column, Loading } from '@umami/react-zen';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useLoginQuery } from '@/components/hooks';
import { LoginForm } from './LoginForm';
import { PropsWithChildren } from 'react';

export function LoginPageWrapper({ children }: PropsWithChildren) {
  const { user, isLoading } = useLoginQuery();
  const router = useRouter();

  useEffect(() => {
    if (user) {
      router.replace('/');
    }
  }, [user, router]);

  if (isLoading || user) {
    return <Loading placement="absolute" />;
  }

  return (
    <Column
      alignItems="center"
      justifyContent="center"
      height="100vh"
      style={{ background: '#FFFFFF', padding: '32px 0' }}
    >
      {children}
    </Column>
  );
}

export function LoginPage() {
  return (
    <LoginPageWrapper>
      <LoginForm />
    </LoginPageWrapper>
  );
}
