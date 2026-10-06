'use client';

import { ActionIcon, AppShell as MantineAppShell, Burger, Group, NavLink, Title, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconApps, IconCopy, IconLayoutGrid, IconLogout, IconSearch } from '@tabler/icons-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';

const LAUNCHER_URL = process.env.NEXT_PUBLIC_LAUNCHER_URL ?? 'https://apps.home';

const NAV = [
  { label: "Vue d'ensemble", href: '/apercu', icon: IconLayoutGrid },
  { label: 'Recherche', href: '/recherche', icon: IconSearch },
  { label: 'Doublons', href: '/doublons', icon: IconCopy },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { profile, logout } = useAuth();
  const [opened, { toggle, close }] = useDisclosure();

  useEffect(() => {
    if (!localStorage.getItem('accessToken')) router.replace('/login');
  }, [router]);

  return (
    <MantineAppShell header={{ height: 56 }} navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <MantineAppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Title order={3}>SkVault</Title>
          </Group>
          <Group gap="xs">
            <Tooltip label="Menu principal">
              <ActionIcon variant="subtle" component="a" href={LAUNCHER_URL} aria-label="Menu principal"><IconApps size={20} /></ActionIcon>
            </Tooltip>
            <Tooltip label={`Déconnexion${profile.data ? ` (${profile.data.email})` : ''}`}>
              <ActionIcon variant="subtle" onClick={logout} aria-label="Déconnexion"><IconLogout size={20} /></ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </MantineAppShell.Header>
      <MantineAppShell.Navbar p="xs">
        {NAV.map((n) => (
          <NavLink key={n.href} component={Link} href={n.href} label={n.label} leftSection={<n.icon size={18} />} active={pathname.startsWith(n.href)} onClick={close} />
        ))}
      </MantineAppShell.Navbar>
      <MantineAppShell.Main>{children}</MantineAppShell.Main>
    </MantineAppShell>
  );
}
