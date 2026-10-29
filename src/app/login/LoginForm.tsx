import { liekanProduct } from '@/lib/liekan/contracts/product';
import {
  Column,
  Form,
  FormButtons,
  FormField,
  FormSubmitButton,
  PasswordField,
  TextField,
} from '@umami/react-zen';
import { useRouter } from 'next/navigation';
import { useMessages, useUpdateQuery } from '@/components/hooks';
import { BrandIcon } from '@/components/liekan/Icons';
import { setClientAuthToken } from '@/lib/client';
import { consumeReturnUrl } from '@/lib/return-url';
import { setUser } from '@/store/app';

export function LoginForm() {
  const { t, labels, getErrorMessage } = useMessages();
  const router = useRouter();
  const { mutateAsync, error } = useUpdateQuery('/auth/login');

  const handleSubmit = async (data: any) => {
    await mutateAsync(data, {
      onSuccess: async (response: any) => {
        if (response.requiresTwoFactor) {
          sessionStorage.setItem('umami.partial-token', response.partialToken);
          router.push('/login/two-factor');
          return;
        }
        setClientAuthToken(response.token);
        setUser(response.user);
        router.push(consumeReturnUrl() ?? '/');
      },
    });
  };

  return (
    <Column justifyContent="center" alignItems="center" gap="5" style={{ width: '100%', padding: '0 16px' }}>
      <Column alignItems="center" gap="4">
        <BrandIcon
          size={28}
          style={{
            width: 52,
            height: 52,
            borderRadius: 14,
            background: '#7C3AED',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        />
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.24em',
              color: '#7C3AED',
            }}
          >
            {liekanProduct.caption}
          </div>
          <div
            style={{
              fontSize: 27,
              fontWeight: 650,
              letterSpacing: '-0.01em',
              color: '#111116',
              marginTop: 6,
              lineHeight: 1.15,
            }}
          >
            {liekanProduct.name}
          </div>
        </div>
      </Column>

      <div
        style={{
          width: '100%',
          maxWidth: 368,
          background: '#FFFFFF',
          border: '1px solid #E8E8ED',
          borderRadius: 16,
          padding: '26px 26px 22px',
          boxShadow: '0 1px 2px rgba(17, 17, 22, 0.04), 0 12px 32px rgba(17, 17, 22, 0.06)',
        }}
      >
        <Form
          onSubmit={handleSubmit}
          error={getErrorMessage(error)}
          defaultValues={{ username: '', password: '' }}
          style={{ width: '100%' }}
        >
          <FormField
            label={t(labels.username)}
            data-test="input-username"
            name="username"
            rules={{ required: t(labels.required) }}
          >
            <TextField autoComplete="username" />
          </FormField>

          <FormField
            label={t(labels.password)}
            data-test="input-password"
            name="password"
            rules={{ required: t(labels.required) }}
          >
            <PasswordField autoComplete="current-password" />
          </FormField>
          <FormButtons>
            <FormSubmitButton
              data-test="button-submit"
              variant="primary"
              style={{
                flex: 1,
                height: 40,
                fontWeight: 600,
                background: '#7C3AED',
                borderColor: '#7C3AED',
                color: '#FFFFFF',
              }}
              isDisabled={false}
            >
              {t(labels.login)}
            </FormSubmitButton>
          </FormButtons>
        </Form>
      </div>

      <div style={{ fontSize: 12, color: '#9A9AA3' }}>v{liekanProduct.displayVersion}</div>
    </Column>
  );
}
