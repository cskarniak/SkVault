'use client';

import { Group, NumberInput, Pagination, Select, Table, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import api, { formatBytes } from '@/lib/api';

interface SearchResult {
  total: number; page: number; pageSize: number;
  items: { id: number; relPath: string; size: number; mtime: string; hashed: boolean; volume: string; host: string }[];
}

export default function RecherchePage() {
  const [q, setQ] = useState('');
  const [ext, setExt] = useState('');
  const [volumeId, setVolumeId] = useState<string | null>(null);
  const [minMb, setMinMb] = useState<number | string>('');
  const [page, setPage] = useState(1);
  const [dq] = useDebouncedValue(q, 300);
  const [dext] = useDebouncedValue(ext, 300);

  const volumes = useQuery<{ id: string; label: string; host: string }[]>({ queryKey: ['volumes'], queryFn: () => api.get('/volumes').then((r) => r.data) });
  const params = { q: dq || undefined, ext: dext || undefined, volumeId: volumeId ?? undefined, minSize: minMb ? Number(minMb) * 1024 * 1024 : undefined, page };
  const results = useQuery<SearchResult>({ queryKey: ['files', params], queryFn: () => api.get('/files', { params }).then((r) => r.data), placeholderData: (p) => p });

  const reset = (fn: () => void) => { fn(); setPage(1); };
  return (
    <>
      <Title order={2} mb="md">Recherche</Title>
      <Group mb="md" align="flex-end">
        <TextInput label="Nom ou chemin" placeholder="vacances 2019" value={q} onChange={(e) => reset(() => setQ(e.currentTarget.value))} style={{ flex: 1, minWidth: 200 }} />
        <TextInput label="Extension" placeholder="jpg" w={100} value={ext} onChange={(e) => reset(() => setExt(e.currentTarget.value))} />
        <Select label="Volume" clearable placeholder="Tous" data={volumes.data?.map((v) => ({ value: v.id, label: `${v.host} · ${v.label}` })) ?? []} value={volumeId} onChange={(v) => reset(() => setVolumeId(v))} />
        <NumberInput label="Taille min (Mo)" min={0} w={140} value={minMb} onChange={(v) => reset(() => setMinMb(v))} />
      </Group>
      <Text size="sm" c="dimmed" mb="xs">{results.data ? `${results.data.total.toLocaleString('fr-FR')} résultat(s)` : 'Chargement…'}</Text>
      <Table.ScrollContainer minWidth={700}>
        <Table striped>
          <Table.Thead><Table.Tr><Table.Th>Chemin</Table.Th><Table.Th>Volume</Table.Th><Table.Th>Taille</Table.Th><Table.Th>Modifié</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {results.data?.items.map((f) => (
              <Table.Tr key={f.id}>
                <Table.Td style={{ wordBreak: 'break-all' }}>{f.relPath}</Table.Td>
                <Table.Td>{f.host} · {f.volume}</Table.Td>
                <Table.Td>{formatBytes(f.size)}</Table.Td>
                <Table.Td>{new Date(f.mtime).toLocaleDateString('fr-FR')}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {results.data && results.data.total > results.data.pageSize && (
        <Pagination mt="md" value={page} onChange={setPage} total={Math.ceil(results.data.total / results.data.pageSize)} />
      )}
    </>
  );
}
