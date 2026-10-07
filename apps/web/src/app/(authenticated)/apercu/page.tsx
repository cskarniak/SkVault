'use client';

import { Badge, Button, Card, Group, Loader, Modal, SimpleGrid, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SCAN_MODE_LABELS, VOLUME_KIND_LABELS, type ScanMode, type VolumeKind } from '@skvault/shared';
import { notifications } from '@mantine/notifications';
import api, { formatBytes } from '@/lib/api';

interface Overview { projects: number; files: number; bytes: number; duplicateGroups: number; wastedBytes: number }
interface Volume {
  id: string; label: string; rootPath: string; kind: VolumeKind; host: string;
  lastScanAt: string | null; files: number; bytes: number; projects: number;
  scanMode: ScanMode; note: string | null; physicalLocation: string | null;
}

export default function ApercuPage() {
  const qc = useQueryClient();
  const overview = useQuery<Overview>({ queryKey: ['overview'], queryFn: () => api.get('/overview').then((r) => r.data) });
  const volumes = useQuery<Volume[]>({ queryKey: ['volumes'], queryFn: () => api.get('/volumes').then((r) => r.data) });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/volumes/${id}`),
    onSuccess: () => qc.invalidateQueries(),
  });

  // Note libre et emplacement physique d'un disque (« tiroir du bureau »…)
  const [editing, setEditing] = useState<Volume | null>(null);
  const [note, setNote] = useState('');
  const [location, setLocation] = useState('');
  const openEdit = (v: Volume) => { setEditing(v); setNote(v.note ?? ''); setLocation(v.physicalLocation ?? ''); };
  const save = useMutation({
    mutationFn: () => api.patch(`/volumes/${editing!.id}`, { note, physicalLocation: location }),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['volumes'] }); },
    onError: () => notifications.show({ message: 'Enregistrement impossible', color: 'red' }),
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
          {o.projects > 0 && <Stat label="Projets archivés" value={o.projects.toLocaleString('fr-FR')} />}
        </SimpleGrid>
      )}
      <Title order={3} mb="sm">Volumes</Title>
      {volumes.data?.length === 0 && (
        <Text c="dimmed">Aucun volume. Lancez un premier scan depuis l&apos;onglet Scans (l&apos;agent doit tourner : <code>pnpm agent run</code>).</Text>
      )}
      <Table.ScrollContainer minWidth={700}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr><Table.Th>Machine</Table.Th><Table.Th>Volume</Table.Th><Table.Th>Type</Table.Th><Table.Th>Contenu</Table.Th><Table.Th>Taille</Table.Th><Table.Th>Dernier scan</Table.Th><Table.Th /></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {volumes.data?.map((v) => (
              <Table.Tr key={v.id}>
                <Table.Td>{v.host}</Table.Td>
                <Table.Td>
                  <Text fw={500}>{v.label}</Text><Text size="xs" c="dimmed">{v.rootPath}</Text>
                  {v.physicalLocation && <Text size="xs" c="teal">📍 {v.physicalLocation}</Text>}
                  {v.note && <Text size="xs" c="dimmed" fs="italic" lineClamp={2}>{v.note}</Text>}
                </Table.Td>
                <Table.Td>
                  <Badge variant="light">{VOLUME_KIND_LABELS[v.kind] ?? v.kind}</Badge>
                  <Badge variant="outline" color={v.scanMode === 'fcp_archive' ? 'grape' : 'blue'} mt={4} display="block" w="fit-content">{SCAN_MODE_LABELS[v.scanMode] ?? v.scanMode}</Badge>
                </Table.Td>
                <Table.Td>{v.scanMode === 'fcp_archive' ? `${v.projects} projet(s)` : `${v.files.toLocaleString('fr-FR')} fichiers${v.projects ? ` · ${v.projects} photothèque(s)` : ''}`}</Table.Td>
                <Table.Td>{v.scanMode === 'fcp_archive' ? '—' : formatBytes(v.bytes)}</Table.Td>
                <Table.Td>{v.lastScanAt ? new Date(v.lastScanAt).toLocaleString('fr-FR') : '—'}</Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Button size="compact-xs" variant="light" loading={rescan.isPending && rescan.variables === v.id} onClick={() => rescan.mutate(v.id)}>Rescanner</Button>
                    <Button size="compact-xs" variant="subtle" onClick={() => openEdit(v)}>Note</Button>
                    <Button size="compact-xs" color="red" variant="subtle" onClick={() => confirmRemove(v)}>Retirer</Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>

      <Modal opened={!!editing} onClose={() => setEditing(null)} title={`Disque — ${editing?.label ?? ''}`}>
        <Stack>
          <TextInput label="Emplacement physique" description="Où se trouve ce disque quand il est débranché" placeholder="tiroir du bureau, chez les parents…"
            value={location} onChange={(e) => setLocation(e.currentTarget.value)} maxLength={200} />
          <Textarea label="Note" autosize minRows={3} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={2000} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setEditing(null)}>Annuler</Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>Enregistrer</Button>
          </Group>
        </Stack>
      </Modal>
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
