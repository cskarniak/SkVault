#!/bin/bash
# Monte le NAS QNAP (SMB, lecture seule) sur skbox-mini et installe l'agent SkVault qui le scanne.
# À lancer sur skbox-mini, avec le mot de passe sudo :
#   ssh -t skbox-mini 'bash ~/apps/SkVault/deploy/nas/setup-nas-scan.sh'
# Prérequis : /etc/skvault-nas.cred créé par vos soins (voir ci-dessous) — le script ne lit ni n'affiche jamais ce fichier.
# Idempotent.
set -euo pipefail

NAS_HOST="${NAS_HOST:-192.168.1.3}"
SHARES="${SHARES:-photo_bbl photos_a_classer}"   # noms des partages SMB (= noms des volumes sur le Mac)
MNT=/mnt/nas
CRED=/etc/skvault-nas.cred
APP=/home/christian/apps/SkVault

if ! sudo test -f "$CRED"; then
  cat <<MSG
Identifiants du NAS manquants. Créez-les VOUS-MÊME (compte QNAP en lecture seule de préférence) :

  sudo install -m 0600 /dev/null $CRED
  sudo nano $CRED        # deux lignes :  username=VOTRE_COMPTE   puis   password=VOTRE_MOT_DE_PASSE

puis relancez ce script.
MSG
  exit 1
fi

echo "1. Paquet cifs-utils"
dpkg -s cifs-utils >/dev/null 2>&1 || sudo apt-get install -y cifs-utils

echo "2. Points de montage + fstab (lecture seule, montage à la demande)"
for s in $SHARES; do
  sudo mkdir -p "$MNT/$s"
  LINE="//$NAS_HOST/$s $MNT/$s cifs ro,credentials=$CRED,uid=$(id -u christian),gid=$(id -g christian),iocharset=utf8,nofail,_netdev,x-systemd.automount,x-systemd.idle-timeout=600 0 0"
  grep -qF "//$NAS_HOST/$s $MNT/$s " /etc/fstab || echo "$LINE" | sudo tee -a /etc/fstab >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl restart local-fs.target 2>/dev/null || true

echo "3. Test de lecture"
for s in $SHARES; do
  if ls "$MNT/$s" >/dev/null 2>&1; then echo "   ✓ $s : $(ls "$MNT/$s" | wc -l) éléments à la racine"; else echo "   ✗ $s : montage impossible (nom du partage ? identifiants ?)"; fi
done

echo "4. Service agent + sudoers"
sudo install -m 0644 "$APP/deploy/skvault-agent.service" /etc/systemd/system/skvault-agent.service
sudo install -m 0440 "$APP/deploy/skvault-sudoers" /etc/sudoers.d/skvault.new
sudo visudo -cf /etc/sudoers.d/skvault.new
sudo mv /etc/sudoers.d/skvault.new /etc/sudoers.d/skvault
sudo systemctl daemon-reload
sudo systemctl enable --now skvault-agent
sleep 3; systemctl is-active skvault-agent
echo "OK — l'agent « skbox-mini » doit apparaître en ligne dans l'onglet Scans."
