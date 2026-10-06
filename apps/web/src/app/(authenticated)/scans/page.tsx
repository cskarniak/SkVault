'use client';

import {
  Alert, Badge, Button, Card, Group, Loader, Select, SimpleGrid, Stack, Table, Text, TextInput, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerPlay, IconX } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VOLUME_KINDS, VOLUME_KIND_LABELS, type ScanJobStatus, type VolumeKind } from '@skvault/shared';
import { useMemo, useState } from 'react';
import api from '@/lib/api';

interface Host { id: string; name: string; os: string | null; online: boolean; lastSeenAt: string | null; volumes: number }
interface Job {
  id: string; host: { name: string }; rootPath: string; label: string; status: ScanJobStatus;
  phase: 'listing' | 'hashing' | null; filesSeen: number; cancelRequested: boolean; message: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

const STATUS: Record<ScanJobStatus, { label: string; color: string }> = {
  queued: { label: 'En attente', color: 'yellow' },
  running: { label: 'En cours', color: 'blue' },
  done: { label: 'Terminé', color: 'teal' },
  failed: { label: 'Échec', color: 'red' },
  cancelled: { label: 'Annulé', color: 'gray' },
};

const errorMessage = (e: unknown) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Une erreur est survenue';

function duration(j: Job): string {
  if (!j.startedAt) return '—';
  const s = Math.round(((j.finishedAt ? new Date(j.finishedAt) : new Date()).getTime() - new Date(j.startedAt).getTime()) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export default function ScansPage() {
  const qc = useQueryClient();
  const hosts = useQuery<Host[]>({ queryKey: ['hosts'], queryFn: () => api.get('/hosts').then((r) => r.data), refetchInterval: 5000 });
  const jobs = useQuery<Job[]>({ queryKey: ['scan-jobs'], queryFn: () => api.get('/scan-jobs').then((r) => r.data), refetchInterval: 3000 });
  const volumes = useQuery<{ host: string; rootPath: string; label: string }[]>({
    queryKey: ['volumes'], queryFn: () => api.get('/volumes').then((r) => r.data),
  });

  const [hostId, setHostId] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<string>('other');

  const host = hosts.data?.find((h) => h.id === hostId);
  const knownPaths = useMemo(
    () => (volumes.data ?? []).filter((v) => v.host === host?.name).map((v) => v.rootPath),
    [volumes.data, host],
  );

  const launch = useMutation({
    mutationFn: () => api.post('/scan-jobs', { hostId, rootPath: rootPath.trim(), label: label.trim() || rootPath.trim().split('/').filter(Boolean).pop(), kind }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scan-jobs'] });
      notifications.show({ message: host?.online ? 'Scan lancé' : 'Scan en attente : il démarrera au retour de l\'agent', color: host?.online ? 'teal' : 'yellow' });
    },
    onError: (e) => notifications.show({ message: errorMessage(e), color: 'red' }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/scan-jobs/${id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scan-jobs'] }),
    onError: (e) => notifications.show({ message: errorMessage(e), color: 'red' }),
  });

  return (
    <Stack gap="lg">
      <Title order={2}>Scans</Title>

      <div>
        <Title order={4} mb="xs">Machines</Title>
        {hosts.data?.length === 0 && (
          <Alert color="blue" variant="light">
            Aucune machine connue. Sur chaque machine à scanner, lancez l&apos;agent : <code>pnpm agent run</code>
          </Alert>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {hosts.data?.map((h) => (
            <Card key={h.id} withBorder>
              <Group justify="space-between">
                <Text fw={600}>{h.name}</Text>
                <Badge color={h.online ? 'teal' : 'gray'} variant="dot">{h.online ? 'agent en ligne' : 'hors ligne'}</Badge>
              </Group>
              <Text size="xs" c="dimmed">{h.os ?? '—'} · {h.volumes} volume(s){!h.online && h.lastSeenAt ? ` · vu le ${new Date(h.lastSeenAt).toLocaleString('fr-FR')}` : ''}</Text>
            </Card>
          ))}
        </SimpleGrid>
      </div>

      <Card withBorder>
        <Title order={4} mb="sm">Nouveau scan</Title>
        <form onSubmit={(e) => { e.preventDefault(); launch.mutate(); }}>
          <Group align="flex-end" wrap="wrap">
            <Select label="Machine" required placeholder="Choisir" w={220}
              data={hosts.data?.map((h) => ({ value: h.id, label: `${h.name}${h.online ? '' : ' (hors ligne)'}` })) ?? []}
              value={hostId} onChange={setHostId} />
            <TextInput label="Dossier sur cette machine" required placeholder="/Volumes/MonDisque" style={{ flex: 1, minWidth: 240 }}
              list="known-paths" value={rootPath} onChange={(e) => setRootPath(e.currentTarget.value)} />
            <datalist id="known-paths">{knownPaths.map((p) => <option key={p} value={p} />)}</datalist>
            <TextInput label="Nom affiché" placeholder="(dernier dossier)" w={180} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
            <Select label="Type" w={160} allowDeselect={false} value={kind} onChange={(v) => setKind(v ?? 'other')}
              data={VOLUME_KINDS.map((k) => ({ value: k, label: VOLUME_KIND_LABELS[k as VolumeKind] }))} />
            <Button type="submit" leftSection={<IconPlayerPlay size={16} />} loading={launch.isPending} disabled={!hostId}>Lancer</Button>
          </Group>
        </form>
        {host && !host.online && <Text size="sm" c="yellow" mt="xs">Cet agent est hors ligne : le scan sera exécuté dès qu&apos;il se reconnectera.</Text>}
        <Text size="xs" c="dimmed" mt="xs">L&apos;agent ne scanne que sous ses dossiers autorisés (par défaut : dossier personnel, /Volumes, /mnt, /media). Lecture seule.</Text>
      </Card>

      <div>
        <Title order={4} mb="xs">Historique</Title>
        {jobs.isLoading && <Loader />}
        <Table.ScrollContainer minWidth={760}>
          <Table striped>
            <Table.Thead><Table.Tr><Table.Th>Volume</Table.Th><Table.Th>Machine</Table.Th><Table.Th>État</Table.Th><Table.Th>Fichiers</Table.Th><Table.Th>Durée</Table.Th><Table.Th>Lancé</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {jobs.data?.map((j) => (
                <Table.Tr key={j.id}>
                  <Table.Td><Text fw={500}>{j.label}</Text><Text size="xs" c="dimmed">{j.rootPath}</Text></Table.Td>
                  <Table.Td>{j.host.name}</Table.Td>
                  <Table.Td>
                    <Badge color={STATUS[j.status].color}>{j.cancelRequested && j.status === 'running' ? 'Annulation…' : STATUS[j.status].label}</Badge>
                    {j.status === 'running' && j.phase && <Text size="xs" c="dimmed">{j.phase === 'listing' ? 'Inventaire' : 'Calcul des empreintes'}</Text>}
                    {j.message && j.status !== 'running' && <Text size="xs" c={j.status === 'failed' ? 'red' : 'dimmed'}>{j.message}</Text>}
                  </Table.Td>
                  <Table.Td>{j.filesSeen ? j.filesSeen.toLocaleString('fr-FR') : '—'}</Table.Td>
                  <Table.Td>{duration(j)}</Table.Td>
                  <Table.Td>{new Date(j.createdAt).toLocaleString('fr-FR')}</Table.Td>
                  <Table.Td>
                    {(j.status === 'queued' || (j.status === 'running' && !j.cancelRequested)) && (
                      <Button size="compact-xs" color="red" variant="subtle" leftSection={<IconX size={12} />} onClick={() => cancel.mutate(j.id)}>Annuler</Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {jobs.data?.length === 0 && <Text c="dimmed">Aucun scan lancé pour l&apos;instant.</Text>}
      </div>
    </Stack>
  );
}
