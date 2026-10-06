'use client';

import {
  Alert, Badge, Button, Card, Code, CopyButton, Group, Loader, Modal, NavLink, ScrollArea, Select, SimpleGrid, Stack, Table, Tabs, Text, TextInput, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowUp, IconCheck, IconCopy, IconDeviceDesktopPlus, IconFolder, IconFolderSearch, IconPlayerPlay, IconX } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VOLUME_KINDS, VOLUME_KIND_LABELS, type BrowseResult, type ScanJobStatus, type VolumeKind } from '@skvault/shared';
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

const OS_LABELS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };
const osLabel = (os: string | null) => (os ? OS_LABELS[os] ?? os : '—');

const errorMessage = (e: unknown) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Une erreur est survenue';

function duration(j: Job): string {
  if (!j.startedAt) return '—';
  const s = Math.round(((j.finishedAt ? new Date(j.finishedAt) : new Date()).getTime() - new Date(j.startedAt).getTime()) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function AddMachineModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [hostName, setHostName] = useState('');
  const enroll = useMutation({
    mutationFn: () =>
      api.post<{ code: string; expiresAt: string; bundleAvailable: boolean }>('/agent-enrollments', hostName.trim() ? { hostName: hostName.trim() } : {}).then((r) => r.data),
    onError: (e) => notifications.show({ message: errorMessage(e), color: 'red' }),
  });
  const base = typeof window !== 'undefined' ? window.location.origin : '';
  const url = enroll.data ? `${base}/api/agent-install/${enroll.data.code}/install.sh` : '';
  const install = `curl -fsSk "${url}" | bash`;
  const uninstall = `curl -fsSk "${url}" | bash -s -- uninstall`;
  const winUrl = url.replace('install.sh', 'install.ps1');
  const winFile = '"$env:TEMP\\skvault-install.ps1"';
  const winInstall = `curl.exe -fsSk "${winUrl}" -o ${winFile}; powershell -NoProfile -ExecutionPolicy Bypass -File ${winFile}`;
  const winUninstall = `${winInstall} uninstall`;
  const close = () => { enroll.reset(); setHostName(''); onClose(); };

  return (
    <Modal opened={opened} onClose={close} title="Ajouter une machine" size="lg">
      <Stack>
        <Text size="sm">
          Une page web ne peut pas s&apos;installer toute seule sur une autre machine : SkVault génère une commande à coller
          <b> une fois</b> dans le terminal de la machine à scanner (Mac ou Linux). Elle installe l&apos;agent, le configure et le
          lance automatiquement à chaque démarrage.
        </Text>
        <Text size="sm" c="dimmed">Prérequis sur cette machine : Node.js 20 ou plus. L&apos;agent est en lecture seule et n&apos;ouvre aucun port.</Text>

        {!enroll.data ? (
          <>
            <TextInput label="Nom de la machine (facultatif)" description="Sinon, le nom d'hôte de la machine est utilisé." placeholder="vieux-macbook-2011"
              value={hostName} onChange={(e) => setHostName(e.currentTarget.value)} />
            <Button onClick={() => enroll.mutate()} loading={enroll.isPending}>Générer la commande</Button>
          </>
        ) : (
          <>
            {!enroll.data.bundleAvailable && (
              <Alert color="orange" variant="light">Le fichier de l&apos;agent n&apos;est pas construit sur ce serveur : lancez <code>pnpm --filter agent bundle</code>.</Alert>
            )}
            <Tabs defaultValue="unix" keepMounted={false}>
              <Tabs.List mb="sm">
                <Tabs.Tab value="unix">macOS / Linux</Tabs.Tab>
                <Tabs.Tab value="windows">Windows</Tabs.Tab>
              </Tabs.List>
              {[
                { value: 'unix', where: 'dans le terminal de la machine', cmd: install, un: uninstall, prereq: 'Node.js 20 ou plus.' },
                { value: 'windows', where: 'dans PowerShell (pas dans l\'invite de commandes), sans droits administrateur', cmd: winInstall, un: winUninstall,
                  prereq: 'Windows 10 ou 11 et Node.js 20 ou plus (winget install OpenJS.NodeJS.LTS).' },
              ].map((t) => (
                <Tabs.Panel key={t.value} value={t.value}>
                  <Stack gap="xs">
                    <Text size="sm" fw={600}>Collez ceci {t.where} :</Text>
                    <Group wrap="nowrap" align="flex-start">
                      <Code block style={{ flex: 1, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{t.cmd}</Code>
                      <CopyButton value={t.cmd}>
                        {({ copied, copy }) => (
                          <Button variant="light" color={copied ? 'teal' : 'blue'} onClick={copy} leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}>
                            {copied ? 'Copié' : 'Copier'}
                          </Button>
                        )}
                      </CopyButton>
                    </Group>
                    <Text size="xs" c="dimmed">Prérequis : {t.prereq}</Text>
                    <details>
                      <summary style={{ cursor: 'pointer' }}><Text span size="sm">Désinstaller plus tard</Text></summary>
                      <Code block mt="xs" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{t.un}</Code>
                    </details>
                  </Stack>
                </Tabs.Panel>
              ))}
            </Tabs>
            <Text size="sm" c="dimmed">
              Valable jusqu&apos;à {new Date(enroll.data.expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.
              La machine apparaît « en ligne » dans la liste quelques secondes après l&apos;exécution. Relancer la commande met l&apos;agent à jour.
            </Text>
            <Alert color="yellow" variant="light" title="À savoir">
              Cette commande contient un accès à l&apos;installation : ne la partagez pas. Elle est fournie sur ce réseau avec <code>curl -k</code>
              (certificat local non encore connu de la machine) ; l&apos;agent installé vérifie ensuite normalement le HTTPS.
            </Alert>
          </>
        )}
      </Stack>
    </Modal>
  );
}

/** Sélecteur de dossier : l'agent de la machine liste ses sous-dossiers (jamais les fichiers), dans ses dossiers autorisés. */
function BrowseModal({ host, opened, onClose, onPick }: {
  host: Host | undefined; opened: boolean; onClose: () => void; onPick: (path: string) => void;
}) {
  const [path, setPath] = useState('');
  const hostId = host?.id;
  const listing = useQuery<BrowseResult>({
    queryKey: ['browse', hostId, path],
    queryFn: () => api.post(`/hosts/${hostId}/browse`, { path }).then((r) => r.data),
    enabled: opened && !!hostId,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    placeholderData: (prev) => prev,
  });
  const data = listing.data;
  const windows = host?.os === 'win32';
  const close = () => { setPath(''); onClose(); };

  return (
    <Modal opened={opened} onClose={close} title={`Choisir un dossier — ${host?.name ?? ''}`} size="lg">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text size="sm" c="dimmed" style={{ wordBreak: 'break-all' }}>
            {data?.path ? data.path : 'Emplacements disponibles sur cette machine'}
          </Text>
          {listing.isFetching && <Loader size="xs" />}
        </Group>
        <Group gap="xs">
          <Button size="xs" variant="light" leftSection={<IconArrowUp size={14} />}
            disabled={!data || data.parent === null} onClick={() => setPath(data?.parent ?? '')}>Dossier parent</Button>
          <Button size="xs" variant="subtle" disabled={!data?.path} onClick={() => setPath('')}>Emplacements</Button>
        </Group>

        {listing.isError && (
          <Alert color="red" variant="light">
            {(listing.error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Impossible de lire ce dossier'}
          </Alert>
        )}
        <ScrollArea h={320} type="auto" style={{ border: '1px solid var(--mantine-color-dark-4)', borderRadius: 8 }}>
          {data?.entries.length === 0 && !listing.isError && <Text c="dimmed" size="sm" p="md">Aucun sous-dossier.</Text>}
          {data?.entries.map((e) => (
            <NavLink key={e.path} label={e.name}
              leftSection={<IconFolder size={18} />} onClick={() => setPath(e.path)} />
          ))}
        </ScrollArea>
        {data?.truncated && <Text size="xs" c="orange">Liste tronquée aux 2 000 premiers dossiers.</Text>}

        <Group justify="space-between" mt="xs">
          <Text size="xs" c="dimmed">{windows ? 'Les lecteurs et dossiers de cette machine Windows' : 'Seuls les dossiers autorisés de la machine sont visibles'}</Text>
          <Button disabled={!data?.path} onClick={() => { if (data?.path) { onPick(data.path); close(); } }}>Choisir ce dossier</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export default function ScansPage() {
  const qc = useQueryClient();
  const hosts = useQuery<Host[]>({ queryKey: ['hosts'], queryFn: () => api.get('/hosts').then((r) => r.data), refetchInterval: 5000 });
  const jobs = useQuery<Job[]>({ queryKey: ['scan-jobs'], queryFn: () => api.get('/scan-jobs').then((r) => r.data), refetchInterval: 3000 });
  const volumes = useQuery<{ host: string; rootPath: string; label: string }[]>({
    queryKey: ['volumes'], queryFn: () => api.get('/volumes').then((r) => r.data),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
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
        <Group justify="space-between" mb="xs">
          <Title order={4}>Machines</Title>
          <Button size="xs" variant="light" leftSection={<IconDeviceDesktopPlus size={16} />} onClick={() => setAddOpen(true)}>Ajouter une machine</Button>
        </Group>
        <AddMachineModal opened={addOpen} onClose={() => setAddOpen(false)} />
        {hosts.data?.length === 0 && (
          <Alert color="blue" variant="light">
            Aucune machine connue. Cliquez sur « Ajouter une machine » pour installer l&apos;agent sur une machine à scanner.
          </Alert>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
          {hosts.data?.map((h) => (
            <Card key={h.id} withBorder>
              <Group justify="space-between">
                <Text fw={600}>{h.name}</Text>
                <Badge color={h.online ? 'teal' : 'gray'} variant="dot">{h.online ? 'agent en ligne' : 'hors ligne'}</Badge>
              </Group>
              <Text size="xs" c="dimmed">{osLabel(h.os)} · {h.volumes} volume(s){!h.online && h.lastSeenAt ? ` · vu le ${new Date(h.lastSeenAt).toLocaleString('fr-FR')}` : ''}</Text>
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
            <TextInput label="Dossier sur cette machine" required placeholder={host?.os === 'win32' ? 'D:\\Photos  ou  \\\\NAS\\partage' : '/Volumes/MonDisque'} style={{ flex: 1, minWidth: 240 }}
              list="known-paths" value={rootPath} onChange={(e) => setRootPath(e.currentTarget.value)} />
            <Button variant="light" leftSection={<IconFolderSearch size={16} />} disabled={!host?.online} onClick={() => setBrowseOpen(true)}
              title={!host ? 'Choisissez d\'abord une machine' : host.online ? undefined : 'Agent hors ligne'}>Parcourir…</Button>
            <datalist id="known-paths">{knownPaths.map((p) => <option key={p} value={p} />)}</datalist>
            <TextInput label="Nom affiché" placeholder="(dernier dossier)" w={180} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
            <Select label="Type" w={160} allowDeselect={false} value={kind} onChange={(v) => setKind(v ?? 'other')}
              data={VOLUME_KINDS.map((k) => ({ value: k, label: VOLUME_KIND_LABELS[k as VolumeKind] }))} />
            <Button type="submit" leftSection={<IconPlayerPlay size={16} />} loading={launch.isPending} disabled={!hostId}>Lancer</Button>
          </Group>
        </form>
        {host && !host.online && <Text size="sm" c="yellow" mt="xs">Cet agent est hors ligne : le scan sera exécuté dès qu&apos;il se reconnectera.</Text>}
        <BrowseModal host={host} opened={browseOpen} onClose={() => setBrowseOpen(false)}
          onPick={(p) => { setRootPath(p); if (!label.trim()) setLabel(p.split(/[\\/]/).filter(Boolean).pop() ?? p); }} />
        <Text size="xs" c="dimmed" mt="xs">L&apos;agent ne scanne que sous ses dossiers autorisés (par défaut : dossier personnel et disques ; /Volumes, /mnt, /media sous macOS/Linux, lecteurs sous Windows). Lecture seule.</Text>
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
