'use client';

import {
  Alert, Badge, Button, Drawer, Group, Loader, Pagination, Select, Stack, Table, Tabs, Text, TextInput, Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconRefresh, IconXboxX } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FCP_CATEGORIES, FCP_CATEGORY_INFO, PROJECT_KIND_LABELS, VERDICT_LABELS,
  type FcpReport, type ProjectKind, type Usefulness, type Verdict,
} from '@skvault/shared';
import { useState } from 'react';
import api, { formatBytes } from '@/lib/api';

interface Reclaimable { useless: number; regenerable: number; conditional: number }
type Originals = NonNullable<FcpReport['originals']>;
interface ProjectRow {
  id: string; kind: ProjectKind; name: string; relPath: string; size: number | null; fileCount: number | null; mtime: string | null;
  verdict: Verdict | null; effectiveVerdict: Verdict | null; warnings: number; reclaimable: Reclaimable;
  originals: Originals | null; lastEditMs: number | null; foundElsewhere: number;
  volume: { id: string; label: string; host: string; physicalLocation: string | null };
}
interface Resolution {
  checkedAt: string; absent: number; foundExact: number; foundName: number; stillMissing: number;
  byVolume: { host: string; label: string; count: number }[]; stillMissingSources: { source: string; count: number }[]; sample: string[];
}
interface Related {
  projectId: string; name: string; relPath: string; volume: { label: string; host: string }; verdict: Verdict | null;
  kind: 'replica' | 'contained' | 'overlap' | 'complement'; inter: number; coverMe: number; coverOther: number; jaccard: number;
  container?: 'me' | 'other'; newer: 'me' | 'other' | null; lastEditMs: number | null; sameFolder: boolean;
}
interface ProjectDetail extends Omit<ProjectRow, 'warnings' | 'reclaimable' | 'originals' | 'lastEditMs' | 'foundElsewhere'> {
  report: FcpReport | null; resolution: Resolution | null; relations: Related[]; volume: ProjectRow['volume'] & { rootPath: string };
}
interface Pair {
  a: { id: string; name: string; volume: string; lastEditMs: number | null; keys: number };
  b: { id: string; name: string; volume: string; lastEditMs: number | null; keys: number };
  kind: string; container?: 'a' | 'b'; newer: 'a' | 'b' | null; inter: number; coverA: number; coverB: number; sameFolder: boolean;
}

const VERDICT_COLOR: Record<Verdict, string> = { complete: 'teal', to_check: 'orange', incomplete: 'red' };
const USEFULNESS: Record<Usefulness, { label: string; color: string }> = {
  essential: { label: 'Indispensable', color: 'teal' },
  regenerable: { label: 'Régénérable', color: 'yellow' },
  conditional: { label: 'Conditionnel', color: 'orange' },
  useless: { label: 'Inutile', color: 'gray' },
  unknown: { label: 'À juger', color: 'blue' },
};
const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString('fr-FR') : '—');
const pct = (x: number) => `${Math.round(x * 100)} %`;

function VerdictBadge({ verdict, effective }: { verdict: Verdict | null; effective: Verdict | null }) {
  if (!verdict) return <Badge variant="outline" color="gray">non évalué</Badge>;
  const e = effective ?? verdict;
  return (
    <>
      <Badge color={VERDICT_COLOR[e]}>{VERDICT_LABELS[e]}</Badge>
      {e !== verdict && <Text size="xs" c="dimmed">initialement « {VERDICT_LABELS[verdict].toLowerCase()} »</Text>}
    </>
  );
}

export default function ProjetsPage() {
  const qc = useQueryClient();
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
  const relations = useQuery<Pair[]>({ queryKey: ['projects-relations'], queryFn: () => api.get('/projects-relations').then((r) => r.data) });
  const recheck = useMutation({
    mutationFn: () => api.post<{ checked: number }>('/projects/recheck').then((r) => r.data),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project'] });
      notifications.show({ message: `${d.checked} projet(s) recoupé(s) avec le catalogue`, color: 'teal' });
    },
  });
  const reset = (fn: () => void) => { fn(); setPage(1); };

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Projets et archives</Title>
          <Text size="sm" c="dimmed" maw={760}>
            Une ligne par projet, sans lister ses fichiers : où il est rangé, sa taille, et s&apos;il est complet pour une restauration.
            Le verdict est <b>structurel</b> (Final Cut seul peut garantir l&apos;ouverture) et ne porte que sur les <b>médias originaux</b> :
            les proxys et caches sont régénérables.
          </Text>
        </div>
        <Button variant="light" leftSection={<IconRefresh size={16} />} loading={recheck.isPending} onClick={() => recheck.mutate()}
          title="Cherche les originaux introuvables dans le catalogue de vos autres disques (aussi fait après chaque scan)">Recouper avec le catalogue</Button>
      </Group>

      <Tabs defaultValue="projets">
        <Tabs.List>
          <Tabs.Tab value="projets">Projets</Tabs.Tab>
          <Tabs.Tab value="relations" rightSection={relations.data?.length ? <Badge size="xs" circle>{relations.data.length}</Badge> : undefined}>Relations entre bibliothèques</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="projets" pt="md">
          <Group align="flex-end" mb="sm">
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
          <Table.ScrollContainer minWidth={920}>
            <Table striped highlightOnHover>
              <Table.Thead><Table.Tr><Table.Th>Projet</Table.Th><Table.Th>Disque</Table.Th><Table.Th>Taille</Table.Th><Table.Th>Dernière édition</Table.Th><Table.Th>Originaux</Table.Th><Table.Th>Verdict</Table.Th><Table.Th>Récupérable</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {list.data?.items.map((p) => (
                  <Table.Tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => setOpenId(p.id)}>
                    <Table.Td><Text fw={500}>{p.name}</Text><Text size="xs" c="dimmed">{PROJECT_KIND_LABELS[p.kind]} · {p.relPath || '(racine du disque)'}</Text></Table.Td>
                    <Table.Td><Text>{p.volume.host} · {p.volume.label}</Text>{p.volume.physicalLocation && <Text size="xs" c="teal">📍 {p.volume.physicalLocation}</Text>}</Table.Td>
                    <Table.Td>{p.size != null ? formatBytes(p.size) : '—'}{p.fileCount != null && <Text size="xs" c="dimmed">{p.fileCount.toLocaleString('fr-FR')} fichiers</Text>}</Table.Td>
                    <Table.Td>{p.kind === 'fcp_library' ? fmtDate(p.lastEditMs) : p.mtime ? new Date(p.mtime).toLocaleDateString('fr-FR') : '—'}</Table.Td>
                    <Table.Td>
                      {p.originals ? (<>
                        <Text size="sm">{(p.originals.total - p.originals.absent).toLocaleString('fr-FR')} / {p.originals.total.toLocaleString('fr-FR')} présents</Text>
                        {p.originals.absent > 0 && <Text size="xs" c={p.foundElsewhere >= p.originals.absent ? 'orange' : 'red'}>
                          {p.originals.absent} absent(s){p.foundElsewhere > 0 ? ` · ${p.foundElsewhere} retrouvé(s) sur d'autres disques` : ''}
                        </Text>}
                      </>) : '—'}
                    </Table.Td>
                    <Table.Td>
                      <VerdictBadge verdict={p.verdict} effective={p.effectiveVerdict} />
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
            <Pagination mt="md" value={page} onChange={setPage} total={Math.ceil(list.data.total / list.data.pageSize)} />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="relations" pt="md">
          <Text size="sm" c="dimmed" mb="sm" maw={760}>
            Bibliothèques dont les médias originaux se recoupent. <b>Réplique</b> : mêmes médias (≥ 95 % de chaque côté). <b>Version contenue</b> :
            tout une bibliothèque se retrouve dans l&apos;autre, qui en contient davantage. <b>Complément</b> : même dossier de projet, médias différents.
            La plus récente se juge à la date de dernière modification des bases de données de la bibliothèque.
          </Text>
          {relations.isLoading && <Loader />}
          {relations.data?.length === 0 && <Text c="dimmed">Aucune relation détectée entre les bibliothèques inspectées.</Text>}
          <Table.ScrollContainer minWidth={820}>
            <Table striped>
              <Table.Thead><Table.Tr><Table.Th>Bibliothèque A</Table.Th><Table.Th>Relation</Table.Th><Table.Th>Bibliothèque B</Table.Th><Table.Th>Plus récente</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {relations.data?.map((r, i) => (
                  <Table.Tr key={i}>
                    <Table.Td style={{ cursor: 'pointer' }} onClick={() => setOpenId(r.a.id)}><Text fw={500}>{r.a.name}</Text><Text size="xs" c="dimmed">{r.a.volume} · {r.a.keys} médias · {fmtDate(r.a.lastEditMs)}</Text></Table.Td>
                    <Table.Td><RelationLabel kind={r.kind} container={r.container} coverA={r.coverA} coverB={r.coverB} /></Table.Td>
                    <Table.Td style={{ cursor: 'pointer' }} onClick={() => setOpenId(r.b.id)}><Text fw={500}>{r.b.name}</Text><Text size="xs" c="dimmed">{r.b.volume} · {r.b.keys} médias · {fmtDate(r.b.lastEditMs)}</Text></Table.Td>
                    <Table.Td>{r.newer ? <Badge color="teal" variant="light">{r.newer === 'a' ? r.a.name : r.b.name}</Badge> : <Text size="sm" c="dimmed">indéterminé</Text>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Tabs.Panel>
      </Tabs>

      <Drawer opened={!!openId} onClose={() => setOpenId(null)} position="right" size="xl" title="Détail du projet">
        {openId && <ProjectDetailView id={openId} onOpen={setOpenId} />}
      </Drawer>
    </Stack>
  );
}

function RelationLabel({ kind, container, coverA, coverB }: { kind: string; container?: 'a' | 'b'; coverA: number; coverB: number }) {
  if (kind === 'replica') return <><Badge color="blue">Réplique</Badge><Text size="xs" c="dimmed">mêmes médias ({pct(coverA)} / {pct(coverB)})</Text></>;
  if (kind === 'contained') {
    return <><Badge color="grape">Version contenue</Badge><Text size="xs" c="dimmed">{container === 'b' ? 'A est contenue dans B' : 'B est contenue dans A'} ({pct(container === 'b' ? coverA : coverB)} de la plus petite)</Text></>;
  }
  if (kind === 'overlap') return <><Badge color="yellow">Se recoupent</Badge><Text size="xs" c="dimmed">{pct(coverA)} de A · {pct(coverB)} de B en commun</Text></>;
  return <><Badge color="gray">Complément</Badge><Text size="xs" c="dimmed">même dossier, médias différents</Text></>;
}

function ProjectDetailView({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const { data: p, isLoading } = useQuery<ProjectDetail>({ queryKey: ['project', id], queryFn: () => api.get(`/projects/${id}`).then((r) => r.data) });
  if (isLoading || !p) return <Loader />;
  const r = p.report;
  const total = r?.totalBytes ?? 0;
  const res = p.resolution;
  const o = r?.originals;
  const lvl = { error: { color: 'red', icon: <IconXboxX size={16} /> }, warn: { color: 'orange', icon: <IconAlertTriangle size={16} /> }, info: { color: 'blue', icon: <IconInfoCircle size={16} /> } };

  return (
    <Stack>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div>
          <Title order={3}>{p.name}</Title>
          <Text size="sm" c="dimmed">{p.volume.host} · {p.volume.label} — {p.volume.rootPath}{p.relPath ? '/' + p.relPath : ''}</Text>
          {r?.projectFolder && <Text size="xs" c="dimmed">Dossier du projet : {r.projectFolder}</Text>}
          {p.volume.physicalLocation && <Text size="sm" c="teal">📍 {p.volume.physicalLocation}</Text>}
          {r?.lastEditMs && <Text size="xs" c="dimmed">Dernière modification des bases : {new Date(r.lastEditMs).toLocaleString('fr-FR')}</Text>}
        </div>
        <div style={{ textAlign: 'right' }}><VerdictBadge verdict={p.verdict} effective={p.effectiveVerdict} /></div>
      </Group>

      {!r ? (
        <Alert color="blue" variant="light">
          {p.kind === 'photo_library' ? 'Photothèque repérée : son contenu n\'est volontairement pas scanné (le même fichier peut y exister plusieurs fois). Elle fera l\'objet d\'un traitement à part.' : 'Pas de rapport.'}
        </Alert>
      ) : (<>
        {p.effectiveVerdict && p.verdict && p.effectiveVerdict !== p.verdict && (
          <Alert color="orange" variant="light" icon={<IconInfoCircle size={16} />}>
            Le scan a jugé ce projet « {VERDICT_LABELS[p.verdict].toLowerCase()} » parce que des originaux manquent à côté de la bibliothèque, mais le catalogue les
            retrouve tous sur d&apos;autres disques : le projet est <b>dispersé</b>, pas perdu. Gardez ces disques avec lui.
          </Alert>
        )}

        {o && (
          <div>
            <Text fw={600} mb={4}>Médias originaux ({o.total.toLocaleString('fr-FR')})</Text>
            <Table withTableBorder>
              <Table.Tbody>
                <OrigRow label="Dans la bibliothèque" n={o.internal} color="teal" />
                <OrigRow label="Retrouvés dans le dossier du projet (chemin identique)" n={o.neighborExact} color="teal" />
                <OrigRow label="Retrouvés dans le dossier du projet (même nom seulement)" n={o.neighborName} color="orange" hint="source d'origine absente : taille non vérifiable" />
                <OrigRow label="Accessibles ici, hors de la bibliothèque" n={o.reachable} color="orange" hint="à sauvegarder avec le projet" />
                <OrigRow label="Introuvables dans le dossier du projet" n={o.absent} color={o.absent ? 'red' : 'teal'} />
                {res && o.absent > 0 && (<>
                  <OrigRow label="… dont retrouvés dans le catalogue (même chemin)" n={res.foundExact} color="teal" indent />
                  <OrigRow label="… dont retrouvés dans le catalogue (même nom)" n={res.foundName} color="orange" indent />
                  <OrigRow label="… toujours introuvables" n={res.stillMissing} color={res.stillMissing ? 'red' : 'teal'} indent />
                </>)}
              </Table.Tbody>
            </Table>
            {res && res.byVolume.length > 0 && (
              <Text size="sm" mt={6}>Retrouvés sur : {res.byVolume.map((v) => `${v.host} · ${v.label} (${v.count})`).join(', ')}</Text>
            )}
            {res && res.stillMissingSources.length > 0 && (
              <Text size="sm" mt={4} c="red">Toujours à retrouver : {res.stillMissingSources.map((s) => `${s.source} (${s.count})`).join(', ')}</Text>
            )}
            {!res && o.absent > 0 && <Text size="xs" c="dimmed" mt={6}>Pas encore recoupé avec le catalogue : bouton « Recouper avec le catalogue ».</Text>}
            {r.proxies && r.proxies.total > 0 && (
              <Text size="xs" c="dimmed" mt={6}>Proxys / médias optimisés : {r.proxies.total} ({r.proxies.found} retrouvés, {r.proxies.absent} absents) — régénérables, hors verdict.</Text>
            )}
          </div>
        )}

        {p.relations.length > 0 && (
          <div>
            <Text fw={600} mb={4}>Bibliothèques liées</Text>
            <Stack gap={6}>
              {p.relations.map((x) => (
                <Alert key={x.projectId} color="gray" variant="light" py={8} style={{ cursor: 'pointer' }} onClick={() => onOpen(x.projectId)}>
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    <div>
                      <Text fw={500}>{x.name} <Text span size="xs" c="dimmed">({x.volume.host} · {x.volume.label})</Text></Text>
                      <Text size="sm">
                        {x.kind === 'replica' && 'Réplique : mêmes médias originaux.'}
                        {x.kind === 'contained' && (x.container === 'other' ? `Cette bibliothèque est contenue dans « ${x.name} » (${pct(x.coverMe)} de ses médias s'y retrouvent).` : `Contient « ${x.name} » (${pct(x.coverOther)} de ses médias sont ici) et davantage.`)}
                        {x.kind === 'overlap' && `Se recoupent : ${pct(x.coverMe)} de cette bibliothèque, ${pct(x.coverOther)} de l'autre.`}
                        {x.kind === 'complement' && 'Complément : même dossier de projet, médias différents.'}
                      </Text>
                    </div>
                    <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {x.newer ? <Badge color="teal" variant="light">{x.newer === 'other' ? `« ${x.name} » est plus récente` : 'Celle-ci est plus récente'}</Badge> : <Text size="xs" c="dimmed">dates indéterminées</Text>}
                      <Text size="xs" c="dimmed">{fmtDate(x.lastEditMs)}</Text>
                    </div>
                  </Group>
                </Alert>
              ))}
            </Stack>
          </div>
        )}

        <Stack gap={6}>
          <Text fw={600}>Points relevés</Text>
          {r.warnings.length === 0 && <Alert color="teal" variant="light" icon={<IconCircleCheck size={16} />}>Aucun point à signaler.</Alert>}
          {r.warnings.map((w, i) => <Alert key={i} color={lvl[w.level].color} variant="light" icon={lvl[w.level].icon} py={6}>{w.message}</Alert>)}
          <Text size="xs" c="dimmed">« Complet » signifie : structure correcte, aucun lien cassé, tous les originaux retrouvés. Seule l&apos;ouverture dans Final Cut garantit la restauration ; les plugins tiers et polices ne sont pas dans la bibliothèque.</Text>
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
            <Text fw={600} mb={4}>Sources des originaux hors de la bibliothèque</Text>
            <Text size="xs" c="dimmed" mb={6}>
              Final Cut a laissé ces fichiers « sur place » au lieu de les copier dans la bibliothèque. État vérifié depuis la machine qui a scanné ce disque.
            </Text>
            <Table withTableBorder>
              <Table.Thead><Table.Tr><Table.Th>Source</Table.Th><Table.Th ta="right">Médias</Table.Th><Table.Th ta="right">Accessibles ici</Table.Th></Table.Tr></Table.Thead>
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
          </div>
        )}
      </>)}
    </Stack>
  );
}

function OrigRow({ label, n, color, hint, indent }: { label: string; n: number; color: string; hint?: string; indent?: boolean }) {
  return (
    <Table.Tr>
      <Table.Td pl={indent ? 28 : undefined}><Text size="sm" c={indent ? 'dimmed' : undefined}>{label}</Text>{hint && <Text size="xs" c="dimmed">{hint}</Text>}</Table.Td>
      <Table.Td ta="right" w={90}><Badge color={n === 0 ? 'gray' : color} variant="light">{n.toLocaleString('fr-FR')}</Badge></Table.Td>
    </Table.Tr>
  );
}
