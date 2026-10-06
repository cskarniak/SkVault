'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

interface AuthResponse {
  accessToken: string;
  user: { id: string; email: string };
}

export function useAuth() {
  const queryClient = useQueryClient();
  const router = useRouter();

  const profile = useQuery<{ id: string; email: string; name: string }>({
    queryKey: ['auth', 'me'],
    queryFn: () => api.get('/auth/me').then((r) => r.data),
    retry: false,
    enabled: typeof window !== 'undefined' && !!localStorage.getItem('accessToken'),
  });

  const status = useQuery<{ hasUsers: boolean }>({
    queryKey: ['auth', 'status'],
    queryFn: () => api.get('/auth/status').then((r) => r.data),
  });

  const onSuccess = (data: AuthResponse) => {
    localStorage.setItem('accessToken', data.accessToken);
    queryClient.invalidateQueries({ queryKey: ['auth'] });
    router.push('/apercu');
  };

  const login = useMutation({
    mutationFn: (d: { email: string; password: string }) => api.post<AuthResponse>('/auth/login', d).then((r) => r.data),
    onSuccess,
  });

  const register = useMutation({
    mutationFn: (d: { email: string; password: string; name: string }) =>
      api.post<AuthResponse>('/auth/register', d).then((r) => r.data),
    onSuccess,
  });

  const logout = () => {
    localStorage.removeItem('accessToken');
    queryClient.clear();
    router.push('/login');
  };

  return { profile, status, login, register, logout };
}
