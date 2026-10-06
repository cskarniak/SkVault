'use client';

import { Accordion, Badge, Group, Loader, NumberInput, Pagination, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import api, { formatBytes } from '@/lib/api';

interface DupGroup {
  hash: string; size: number; copies: number; wastedBytes: number;
  files: { relPath: string; volume: string; host: string }[];
}

export default function DoublonsPage() {
  const [minMb, setMinMb] = useState<number | string>(1);
  const [page, setPage] = useState(1);
  const minSize = Number(minMb || 0) * 1024 * 1024;
  const { data, isLoading } = useQuery<{ groups: DupGroup[]; pageSize: number }>({
    queryKey: ['duplicates', minSize, page],
    queryFn: () => api.get('/duplicates', { params: { minSize, page } }).then((r) => r.data),
    placeholderData: (p) => p,
  });

  return (
    <>
      <Title order={2} mb="xs">Doublons</Title>
      <Text c="dimmed" size="sm" mb="md">Fichiers strictement identiques (même taille et même SHA-256), classés par espace récupérable. Rien n&apos;est supprimé depuis cette page.</Text>
      <NumberInput label="Taille min (Mo)" min={0} w={160} mb="md" value={minMb} onChange={(v) => { setMinMb(v); setPage(1); }} />
      {isLoading && <Loader />}
      {data?.groups.length === 0 && <Text c="dimmed">Aucun doublon trouvé.</Text>}
      <Accordion variant="separated">
        {data?.groups.map((g) => (
          <Accordion.Item key={g.hash} value={g.hash}>
            <Accordion.Control>
              <Group justify="space-between" pr="md">
                <Text fw={500} style={{ wordBreak: 'break-all' }}>{g.files[0]?.relPath.split('/').pop()}</Text>
                <Group gap="xs"><Badge>{g.copies} copies</Badge><Badge color="orange">{formatBytes(g.wastedBytes)} récupérables</Badge></Group>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              {g.files.map((f, i) => (
                <Text key={i} size="sm" style={{ wordBreak: 'break-all' }}><b>{f.host} · {f.volume}</b> — {f.relPath}</Text>
              ))}
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
      <Pagination mt="md" value={page} onChange={setPage} total={page + (data && data.groups.length === data.pageSize ? 1 : 0)} />
    </>
  );
}
