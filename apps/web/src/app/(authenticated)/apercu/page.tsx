'use client';

import { Badge, Button, Card, Group, Loader, SimpleGrid, Table, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VOLUME_KIND_LABELS, type VolumeKind } from '@skvault/shared';
import { notifications } from '@mantine/notifications';
import api, { formatBytes } from '@/lib/api';

interface Overview { files: number; bytes: number; duplicateGroups: number; wastedBytes: number }
interface Volume {
  id: string; label: string; rootPath: string; kind: VolumeKind; host: string;
  lastScanAt: string | null; files: number; bytes: number;
}

export default function ApercuPage() {
  const qc = useQueryClient();
  const overview = useQuery<Overview>({ queryKey: ['overview'], queryFn: () => api.get('/overview').then((r) => r.data) });
  const volumes = useQuery<Volume[]>({ queryKey: ['volumes'], queryFn: () => api.get('/volumes').then((r) => r.data) });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/volumes/${id}`),
    onSuccess: () => qc.invalidateQueries(),
  });

  const rescan = useMutation({
    mutationFn: (id: string) => api.post(`/scan-jobs/rescan/${id}`),
    onSuccess: () => notifications.show({ message: 'Scan demandé — suivi dans l\'onglet Scans', color: 'teal' }),
    onError: (e) =>
      notifications.show({
        message: (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Erreur',
        color: 'red',
      }),
  });

  const confirmRemove = (v: Volume) => {
    if (window.confirm(`Retirer « ${v.label} » du catalogue ? Les fichiers du disque ne sont pas touchés.`)) remove.mutate(v.id);
  };

  const o = overview.data;
  return (
    <>
      <Title order={2} mb="md">Vue d&apos;ensemble</Title>
      {!o ? <Loader /> : (
        <SimpleGrid cols={{ base: 2, md: 4 }} mb="xl">
          <Stat label="Fichiers catalogués" value={o.files.toLocaleString('fr-FR')} />
          <Stat label="Volume total" value={formatBytes(o.bytes)} />
          <Stat label="Groupes de doublons" value={o.duplicateGroups.toLocaleString('fr-FR')} />
          <Stat label="Espace gaspillé" value={formatBytes(o.wastedBytes)} />
        </SimpleGrid>
      )}
      <Title order={3} mb="sm">Volumes</Title>
      {volumes.data?.length === 0 && (
        <Text c="dimmed">Aucun volume. Lancez un premier scan depuis l&apos;onglet Scans (l&apos;agent doit tourner : <code>pnpm agent run</code>).</Text>
      )}
      <Table.ScrollContainer minWidth={700}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr><Table.Th>Machine</Table.Th><Table.Th>Volume</Table.Th><Table.Th>Type</Table.Th><Table.Th>Fichiers</Table.Th><Table.Th>Taille</Table.Th><Table.Th>Dernier scan</Table.Th><Table.Th /></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {volumes.data?.map((v) => (
              <Table.Tr key={v.id}>
                <Table.Td>{v.host}</Table.Td>
                <Table.Td><Text fw={500}>{v.label}</Text><Text size="xs" c="dimmed">{v.rootPath}</Text></Table.Td>
                <Table.Td><Badge variant="light">{VOLUME_KIND_LABELS[v.kind] ?? v.kind}</Badge></Table.Td>
                <Table.Td>{v.files.toLocaleString('fr-FR')}</Table.Td>
                <Table.Td>{formatBytes(v.bytes)}</Table.Td>
                <Table.Td>{v.lastScanAt ? new Date(v.lastScanAt).toLocaleString('fr-FR') : '—'}</Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Button size="compact-xs" variant="light" loading={rescan.isPending && rescan.variables === v.id} onClick={() => rescan.mutate(v.id)}>Rescanner</Button>
                    <Button size="compact-xs" color="red" variant="subtle" onClick={() => confirmRemove(v)}>Retirer</Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card withBorder>
      <Text size="xs" c="dimmed" tt="uppercase">{label}</Text>
      <Group><Text fz={26} fw={700}>{value}</Text></Group>
    </Card>
  );
}
