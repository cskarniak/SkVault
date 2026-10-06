'use client';

import { useState } from 'react';
import { Alert, Button, Container, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { useAuth } from '@/hooks/useAuth';

export default function LoginPage() {
  const { login, register, status } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  // Le premier compte est créé depuis cet écran ; ensuite l'inscription est fermée côté API.
  const isRegister = status.data ? !status.data.hasUsers : false;
  const mutation = isRegister ? register : login;
  const message = (mutation.error as { response?: { data?: { message?: string } } } | null)?.response?.data?.message;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isRegister) register.mutate({ email, password, name });
    else login.mutate({ email, password });
  };

  return (
    <Container size={420} my={80}>
      <Title ta="center" order={2}>SkVault</Title>
      <Text c="dimmed" size="sm" ta="center" mt={5}>
        {isRegister ? 'Créez le premier compte' : 'Connectez-vous à votre compte'}
      </Text>
      <Paper withBorder shadow="md" p={30} mt={30} radius="md">
        <form onSubmit={submit}>
          <Stack>
            {isRegister && <TextInput label="Nom" required value={name} onChange={(e) => setName(e.currentTarget.value)} />}
            <TextInput label="Email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
            <PasswordInput label="Mot de passe" required autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
            {mutation.error && <Alert color="red" variant="light">{message ?? 'Une erreur est survenue'}</Alert>}
            <Button type="submit" fullWidth loading={mutation.isPending}>
              {isRegister ? 'Créer le compte' : 'Se connecter'}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Container>
  );
}
