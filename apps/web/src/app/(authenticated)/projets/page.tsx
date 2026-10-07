'use client';

import {
  Alert, Badge, Card, Drawer, Group, Loader, Pagination, Select, SimpleGrid, Stack, Table, Text, TextInput, Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconXboxX } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import {
  FCP_CATEGORIES, FCP_CATEGORY_INFO, PROJECT_KIND_LABELS, VERDICT_LABELS,
  type FcpReport, type ProjectKind, type Usefulness, type Verdict,
} from '@skvault/shared';
import { useState } from 'react';
import api, { formatBytes } from '@/lib/api';

interface Reclaimable { useless: number; regenerable: number; conditional: number }
interface ProjectRow {
  id: string; kind: ProjectKind; name: string; relPath: string; size: number | null; fileCount: number | null; mtime: string | null;
  verdict: Verdict | null; warnings: number; reclaimable: Reclaimable;
  volume: { id: string; label: string; host: string; physicalLocation: string | null };
}
interface ProjectDetail extends Omit<ProjectRow, 'warnings' | 'reclaimable'> {
  report: FcpReport | null; volume: ProjectRow['volume'] & { rootPath: string };
}

const VERDICT_COLOR: Record<Verdict, string> = { complete: 'teal', to_check: 'orange', incomplete: 'red' };
const USEFULNESS: Record<Usefulness, { label: string; color: string }> = {
  essential: { label: 'Indispensable', color: 'teal' },
  regenerable: { label: 'Régénérable', color: 'yellow' },
  conditional: { label: 'Conditionnel', color: 'orange' },
  useless: { label: 'Inutile', color: 'gray' },
  unknown: { label: 'À juger', color: 'blue' },
};

export default function ProjetsPage() {
  const [q, setQ] = useState('');
  const [verdict, setVerdict] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dq] = useDebouncedValue(q, 300);

  const params = { q: dq || undefined, verdict: verdict ?? undefined, kind: kind ?? undefined, page };
  const list = useQuery<{ total: number; pageSize: number; items: ProjectRow[] }>({
    queryKey: ['projects', params], queryFn: () => api.get('/projects', { params }).then((r) => r.data), placeholderData: (p) => p,
  });
  const reset = (fn: () => void) => { fn(); setPage(1); };

  return (
    <Stack>
      <Title order={2}>Projets et archives</Title>
      <Text size="sm" c="dimmed">
        Une ligne par projet, sans lister ses fichiers : où il est rangé, sa taille, et s&apos;il est complet pour une restauration.
        Le verdict est <b>structurel</b> (Final Cut seul peut garantir l&apos;ouverture) : bibliothèque, événements, médias, liens.
      </Text>
      <Group align="flex-end">
        <TextInput label="Nom ou chemin" placeholder="Spectacle…" style={{ flex: 1, minWidth: 200 }} value={q} onChange={(e) => reset(() => setQ(e.currentTarget.value))} />
        <Select label="Verdict" clearable placeholder="Tous" w={160} value={verdict} onChange={(v) => reset(() => setVerdict(v))}
          data={Object.entries(VERDICT_LABELS).map(([value, label]) => ({ value, label }))} />
        <Select label="Type" clearable placeholder="Tous" w={230} value={kind} onChange={(v) => reset(() => setKind(v))}
          data={Object.entries(PROJECT_KIND_LABELS).map(([value, label]) => ({ value, label }))} />
      </Group>
      {list.isLoading && <Loader />}
      {list.data?.items.length === 0 && (
        <Text c="dimmed">Aucun projet. Lancez un scan « Archive de projets Final Cut » sur un disque d&apos;archive (onglet Scans).</Text>
      )}
      <Table.ScrollContainer minWidth={820}>
        <Table striped highlightOnHover>
          <Table.Thead><Table.Tr><Table.Th>Projet</Table.Th><Table.Th>Disque</Table.Th><Table.Th>Taille</Table.Th><Table.Th>Modifié</Table.Th><Table.Th>Verdict</Table.Th><Table.Th>Récupérable</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {list.data?.items.map((p) => (
              <Table.Tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => setOpenId(p.id)}>
                <Table.Td><Text fw={500}>{p.name}</Text><Text size="xs" c="dimmed">{PROJECT_KIND_LABELS[p.kind]} · {p.relPath || '(racine du disque)'}</Text></Table.Td>
                <Table.Td><Text>{p.volume.host} · {p.volume.label}</Text>{p.volume.physicalLocation && <Text size="xs" c="teal">📍 {p.volume.physicalLocation}</Text>}</Table.Td>
                <Table.Td>{p.size != null ? formatBytes(p.size) : '—'}{p.fileCount != null && <Text size="xs" c="dimmed">{p.fileCount.toLocaleString('fr-FR')} fichiers</Text>}</Table.Td>
                <Table.Td>{p.mtime ? new Date(p.mtime).toLocaleDateString('fr-FR') : '—'}</Table.Td>
                <Table.Td>
                  {p.verdict ? <Badge color={VERDICT_COLOR[p.verdict]}>{VERDICT_LABELS[p.verdict]}</Badge> : <Badge variant="outline" color="gray">non évalué</Badge>}
                  {p.warnings > 0 && <Text size="xs" c="dimmed">{p.warnings} point(s) à voir</Text>}
                </Table.Td>
                <Table.Td>
                  {p.kind === 'fcp_library' ? <>
                    <Text size="sm">{formatBytes(p.reclaimable.useless + p.reclaimable.regenerable)}</Text>
                    {p.reclaimable.conditional > 0 && <Text size="xs" c="dimmed">+ {formatBytes(p.reclaimable.conditional)} sous condition</Text>}
                  </> : '—'}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {list.data && list.data.total > list.data.pageSize && (
        <Pagination value={page} onChange={setPage} total={Math.ceil(list.data.total / list.data.pageSize)} />
      )}
      <Drawer opened={!!openId} onClose={() => setOpenId(null)} position="right" size="xl" title="Détail du projet">
        {openId && <ProjectDetailView id={openId} />}
      </Drawer>
    </Stack>
  );
}

function ProjectDetailView({ id }: { id: string }) {
  const { data: p, isLoading } = useQuery<ProjectDetail>({ queryKey: ['project', id], queryFn: () => api.get(`/projects/${id}`).then((r) => r.data) });
  if (isLoading || !p) return <Loader />;
  const r = p.report;
  const total = r?.totalBytes ?? 0;
  const lvl = { error: { color: 'red', icon: <IconXboxX size={16} /> }, warn: { color: 'orange', icon: <IconAlertTriangle size={16} /> }, info: { color: 'blue', icon: <IconInfoCircle size={16} /> } };

  return (
    <Stack>
      <Group justify="space-between" wrap="nowrap">
        <div>
          <Title order={3}>{p.name}</Title>
          <Text size="sm" c="dimmed">{p.volume.host} · {p.volume.label} — {p.volume.rootPath}{p.relPath ? '/' + p.relPath : ''}</Text>
          {p.volume.physicalLocation && <Text size="sm" c="teal">📍 {p.volume.physicalLocation}</Text>}
        </div>
        {p.verdict && <Badge size="lg" color={VERDICT_COLOR[p.verdict]} leftSection={p.verdict === 'complete' ? <IconCircleCheck size={14} /> : undefined}>{VERDICT_LABELS[p.verdict]}</Badge>}
      </Group>

      {!r ? (
        <Alert color="blue" variant="light">
          {p.kind === 'photo_library' ? 'Photothèque repérée : son contenu n\'est volontairement pas scanné (le même fichier peut y exister plusieurs fois). Elle fera l\'objet d\'un traitement à part.' : 'Pas de rapport.'}
        </Alert>
      ) : (<>
        <Stack gap={6}>
          <Text fw={600}>Points relevés</Text>
          {r.warnings.length === 0 && <Alert color="teal" variant="light" icon={<IconCircleCheck size={16} />}>Aucun point à signaler.</Alert>}
          {r.warnings.map((w, i) => <Alert key={i} color={lvl[w.level].color} variant="light" icon={lvl[w.level].icon} py={6}>{w.message}</Alert>)}
          <Text size="xs" c="dimmed">« Complet » signifie : structure correcte, aucun lien cassé, aucun média vide. Seule l&apos;ouverture dans Final Cut garantit la restauration ; les plugins tiers et polices ne sont pas dans la bibliothèque.</Text>
        </Stack>

        <div>
          <Text fw={600} mb={4}>Contenu et fichiers inutiles</Text>
          <Table withTableBorder>
            <Table.Thead><Table.Tr><Table.Th>Catégorie</Table.Th><Table.Th>Utilité</Table.Th><Table.Th ta="right">Fichiers</Table.Th><Table.Th ta="right">Taille</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {FCP_CATEGORIES.filter((c) => r.categories[c].files > 0).map((c) => {
                const info = FCP_CATEGORY_INFO[c]; const u = USEFULNESS[info.usefulness];
                return (
                  <Table.Tr key={c}>
                    <Table.Td><Text size="sm">{info.label}</Text><Text size="xs" c="dimmed">{info.hint}</Text></Table.Td>
                    <Table.Td><Badge color={u.color} variant="light">{u.label}</Badge></Table.Td>
                    <Table.Td ta="right">{r.categories[c].files.toLocaleString('fr-FR')}</Table.Td>
                    <Table.Td ta="right">{formatBytes(r.categories[c].bytes)}{total > 0 && <Text size="xs" c="dimmed">{Math.round((r.categories[c].bytes / total) * 100)} %</Text>}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
          <Text size="xs" c="dimmed" mt={4}>SkVault ne supprime jamais rien : ces chiffres sont indicatifs. Les médias transcodés ne sont régénérables que si les originaux sont présents.</Text>
        </div>

        {r.events.length > 0 && (
          <div>
            <Text fw={600} mb={4}>Événements ({r.events.length})</Text>
            <Table withTableBorder>
              <Table.Thead><Table.Tr><Table.Th>Événement</Table.Th><Table.Th>Base</Table.Th><Table.Th ta="right">Médias dans la bibliothèque</Table.Th><Table.Th ta="right">Médias en lien</Table.Th><Table.Th>Transcodés</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {r.events.map((e) => (
                  <Table.Tr key={e.name}>
                    <Table.Td>{e.name}</Table.Td>
                    <Table.Td>{e.hasEventDb ? <Badge color="teal" variant="light">présente</Badge> : <Badge color="red" variant="light">absente</Badge>}</Table.Td>
                    <Table.Td ta="right">{e.originalFiles} · {formatBytes(e.originalBytes)}</Table.Td>
                    <Table.Td ta="right">{e.linkedFiles ?? 0}</Table.Td>
                    <Table.Td>{e.hasTranscoded ? 'oui' : 'non'}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}

        {(r.dependencies?.length ?? 0) > 0 && (
          <div>
            <Text fw={600} mb={4}>Médias situés hors de la bibliothèque</Text>
            <Text size="xs" c="dimmed" mb={6}>
              Final Cut a laissé ces fichiers « sur place » au lieu de les copier dans la bibliothèque. Pour restaurer le projet en entier,
              il faut aussi retrouver ces sources (état vérifié depuis la machine qui a scanné ce disque).
            </Text>
            <Table withTableBorder>
              <Table.Thead><Table.Tr><Table.Th>Source</Table.Th><Table.Th ta="right">Médias</Table.Th><Table.Th ta="right">Accessibles</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {r.dependencies.map((d) => (
                  <Table.Tr key={d.source}>
                    <Table.Td style={{ wordBreak: 'break-all' }}>{d.source}</Table.Td>
                    <Table.Td ta="right">{d.links.toLocaleString('fr-FR')}</Table.Td>
                    <Table.Td ta="right"><Badge variant="light" color={d.reachable === d.links ? 'teal' : d.reachable === 0 ? 'red' : 'orange'}>{d.reachable} / {d.links}</Badge></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {r.symlinks.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer' }}><Text span size="sm">Exemples de liens ({Math.min(r.symlinks.length, 20)} sur {r.dependencies.reduce((n, d) => n + d.links, 0)})</Text></summary>
                {r.symlinks.slice(0, 20).map((l, i) => (
                  <Text key={i} size="xs" style={{ wordBreak: 'break-all' }}>
                    <Badge size="xs" color={l.broken ? 'red' : 'teal'} mr={6}>{l.broken ? 'absent' : 'présent'}</Badge>{l.path} → {l.target}
                  </Text>
                ))}
              </details>
            )}
          </div>
        )}
      </>)}
    </Stack>
  );
}
