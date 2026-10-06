# Déploiement SkVault sur skbox-mini

**Pas encore déployé.** Même modèle que SkGest (voir `../../SkGest/deploy/README.md`) :
rsync du code vers `~/apps/SkVault`, build sur place, services systemd `skvault-api` (3011) et `skvault-web` (3010).

## Première installation (à faire une fois, avec accord explicite)

1. Base : `sudo -u postgres createuser skvault -P && sudo -u postgres createdb -O skvault skvault`
2. `.env` distant (jamais écrasé par rsync) : `DATABASE_URL`, `AUTH_SECRET`, `AGENT_TOKEN` (aléatoires),
   `API_PORT=3011`, `API_HOST=127.0.0.1`, `CORS_ORIGIN=https://skvault.home`, `NEXT_PUBLIC_API_URL=https://skvault.home/api`
3. Unités systemd : copier `skvault-api.service` / `skvault-web.service` dans `/etc/systemd/system/`, `enable --now`
4. Sudoers : calquer `SkGest/deploy/skgest-sudoers` pour `skvault-api` et `skvault-web`
5. Config MacMiniApps : `deploy/nginx/skapps.conf`, `deploy/dnsmasq/skapps.conf` et le dashboard
   (procédures dans `../../README.md`) ; **régénérer le certificat `skapps.pem` avec les SAN `skvault.home` et `skvault.lan.home`**.

## rsync

Mêmes exclusions que SkGest (`node_modules/`, `dist/`, `.next/`, `.env`, `*.tsbuildinfo`), destination `skbox-mini:~/apps/SkVault/`.
