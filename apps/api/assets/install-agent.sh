#!/usr/bin/env bash
# Installation de l'agent SkVault sur cette machine — généré par le serveur SkVault (valable 1 h).
#   Installer / mettre à jour : curl -fsSk "__ORIGIN__/api/agent-install/__CODE__/install.sh" | bash
#   Désinstaller              : curl -fsSk "__ORIGIN__/api/agent-install/__CODE__/install.sh" | bash -s -- uninstall
# L'agent est en lecture seule : il ne modifie jamais vos fichiers et n'ouvre aucun port.
set -euo pipefail

ORIGIN="__ORIGIN__"
CODE="__CODE__"
TOKEN="__TOKEN__"
HOST_NAME="__HOST_NAME__"
HAS_CA="__HAS_CA__"

DIR="$HOME/.skvault-agent"
LABEL="com.skvault.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT="$HOME/.config/systemd/user/skvault-agent.service"
DRY="${SKVAULT_INSTALL_DRY_RUN:-}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
# En mode essai (SKVAULT_INSTALL_DRY_RUN=1) : affiche les actions sans rien installer ni démarrer.
act()  { if [ -n "$DRY" ]; then echo "[essai] $*"; else "$@"; fi; }
fetch() { curl -fsSk --retry 2 "$ORIGIN/api/agent-install/$CODE/$1" -o "$2" || fail "Téléchargement impossible ($1) : le code a-t-il expiré ? Regénérez-le dans SkVault."; }

OS="$(uname -s)"

if [ "${1:-}" = "uninstall" ]; then
  say "Désinstallation de l'agent SkVault"
  if [ "$OS" = "Darwin" ]; then
    act launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    act rm -f "$PLIST"
  else
    act systemctl --user disable --now skvault-agent 2>/dev/null || true
    act rm -f "$UNIT"
    act systemctl --user daemon-reload 2>/dev/null || true
  fi
  act rm -rf "$DIR"
  echo "Agent désinstallé. (La machine reste listée dans SkVault ; ses volumes restent dans le catalogue.)"
  exit 0
fi

say "Installation de l'agent SkVault sur $(hostname)"

# 1. Node.js ≥ 20
NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node.js est introuvable. Installez Node 20 ou plus (macOS : brew install node ; Linux : https://nodejs.org ou nvm), puis relancez cette commande."
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 20 ] || fail "Node $MAJOR est trop ancien : Node 20 minimum est requis."
echo "✓ Node $("$NODE" -v) ($NODE)"

# 2. Fichiers de l'agent
act mkdir -p "$DIR"
act chmod 700 "$DIR"
if [ -n "$DRY" ]; then
  echo "[essai] téléchargement de l'agent dans $DIR/agent.js"
else
  fetch agent.js "$DIR/agent.js"
  echo "✓ Agent téléchargé"
fi

ENV_CA=""
if [ "$HAS_CA" = "1" ]; then
  if [ -n "$DRY" ]; then echo "[essai] téléchargement du certificat de l'autorité locale"; else fetch rootCA.pem "$DIR/rootCA.pem"; fi
  ENV_CA="$DIR/rootCA.pem"
  echo "✓ Certificat de l'autorité locale installé (HTTPS vérifié)"
fi

ENV_CA_PLIST=""
[ -n "$ENV_CA" ] && ENV_CA_PLIST="<key>NODE_EXTRA_CA_CERTS</key><string>$ENV_CA</string>"

ARGS_PLIST="<string>run</string>"
ARGS_UNIT="run"
if [ -n "$HOST_NAME" ]; then
  ARGS_PLIST="<string>run</string><string>--host</string><string>$HOST_NAME</string>"
  ARGS_UNIT="run --host $HOST_NAME"
fi

# 3. Démarrage automatique
if [ "$OS" = "Darwin" ]; then
  if [ -n "$DRY" ]; then
    echo "[essai] écriture de $PLIST puis launchctl bootstrap"
  else
    mkdir -p "$HOME/Library/LaunchAgents"
    umask 077
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/agent.js</string>$ARGS_PLIST</array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SKVAULT_URL</key><string>$ORIGIN/api</string>
    <key>SKVAULT_AGENT_TOKEN</key><string>$TOKEN</string>
    $ENV_CA_PLIST
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$DIR/agent.log</string>
</dict>
</plist>
PLISTEOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
  echo "✓ Agent démarré et lancé automatiquement à chaque ouverture de session"
  echo "  Journal : $DIR/agent.log"
  echo "  Note macOS : au premier scan d'un disque externe ou d'un dossier protégé, macOS peut demander l'autorisation d'accès."
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  if [ -n "$DRY" ]; then
    echo "[essai] écriture de $UNIT puis systemctl --user enable --now"
  else
    umask 077
    {
      echo "SKVAULT_URL=$ORIGIN/api"
      echo "SKVAULT_AGENT_TOKEN=$TOKEN"
      [ -n "$ENV_CA" ] && echo "NODE_EXTRA_CA_CERTS=$ENV_CA"
    } > "$DIR/env"
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UNITEOF
[Unit]
Description=Agent de scan SkVault
After=network-online.target

[Service]
EnvironmentFile=$DIR/env
ExecStart=$NODE $DIR/agent.js $ARGS_UNIT
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNITEOF
    systemctl --user daemon-reload
    systemctl --user enable --now skvault-agent
    systemctl --user restart skvault-agent
  fi
  echo "✓ Agent démarré (service systemd utilisateur)"
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
    act loginctl enable-linger "$USER" 2>/dev/null \
      || echo "  Pour qu'il tourne aussi sans session ouverte : sudo loginctl enable-linger $USER"
  fi
  echo "  Journal : journalctl --user -u skvault-agent -f"
else
  fail "Pas de systemd utilisateur disponible. Lancez l'agent à la main :
  SKVAULT_URL=$ORIGIN/api SKVAULT_AGENT_TOKEN=… $NODE $DIR/agent.js run"
fi

say "Terminé"
echo "La machine « ${HOST_NAME:-$(hostname)} » doit apparaître « en ligne » dans l'onglet Scans de SkVault d'ici quelques secondes."
