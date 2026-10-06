# Installation de l'agent SkVault sur cette machine Windows — généré par le serveur SkVault (valable 1 h).
#   Installer / mettre à jour : curl.exe -fsSk "__ORIGIN__/api/agent-install/__CODE__/install.ps1" -o "$env:TEMP\skvault-install.ps1"; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\skvault-install.ps1"
#   Désinstaller              : ... -File "$env:TEMP\skvault-install.ps1" uninstall
# Aucun droit administrateur requis. L'agent est en lecture seule : il ne modifie jamais vos fichiers et n'ouvre aucun port.
param([string]$Action = "install")
$ErrorActionPreference = "Stop"

$Origin   = "__ORIGIN__"
$Code     = "__CODE__"
$Token    = "__TOKEN__"
$HostName = "__HOST_NAME__"
$HasCa    = "__HAS_CA__"

$Dir      = Join-Path $env:USERPROFILE ".skvault-agent"
$RunKey   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunName  = "SkVaultAgent"
$Launcher = Join-Path $Dir "start-agent.ps1"
$Dry      = $env:SKVAULT_INSTALL_DRY_RUN

function Say($m)  { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Fail($m) { Write-Host ""; Write-Host "X $m" -ForegroundColor Red; exit 1 }
# En mode essai (SKVAULT_INSTALL_DRY_RUN=1) : affiche les actions sans rien installer ni démarrer.
function Act($desc, [scriptblock]$sb) { if ($Dry) { Write-Host "[essai] $desc" } else { & $sb } }
function Fetch($name, $dest) {
    & curl.exe -fsSk --retry 2 "$Origin/api/agent-install/$Code/$name" -o $dest
    if ($LASTEXITCODE -ne 0) { Fail "Téléchargement impossible ($name) : le code a-t-il expiré ? Regénérez-le dans SkVault." }
}
# Arrête l'agent s'il tourne déjà (lanceur + node), sans toucher aux autres processus.
function Stop-Agent {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and ($_.CommandLine -like "*.skvault-agent*start-agent.ps1*" -or $_.CommandLine -like "*.skvault-agent*agent.js*") } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Action -eq "uninstall") {
    Say "Désinstallation de l'agent SkVault"
    Act "arrêt de l'agent" { Stop-Agent }
    Act "suppression du démarrage automatique" { Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue }
    Act "suppression de $Dir" { Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue }
    Write-Host "Agent désinstallé. (La machine reste listée dans SkVault ; ses volumes restent dans le catalogue.)"
    exit 0
}

Say "Installation de l'agent SkVault sur $env:COMPUTERNAME"

# 1. Node.js >= 20
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { Fail "Node.js est introuvable. Installez Node 20 ou plus (winget install OpenJS.NodeJS.LTS, ou https://nodejs.org), rouvrez PowerShell, puis relancez cette commande." }
$Major = [int](& $Node -p "process.versions.node.split('.')[0]")
if ($Major -lt 20) { Fail "Node $Major est trop ancien : Node 20 minimum est requis (winget install OpenJS.NodeJS.LTS)." }
Write-Host "OK Node $(& $Node -v) ($Node)"

# 2. Fichiers de l'agent
Act "création de $Dir" { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }
if ($Dry) { Write-Host "[essai] téléchargement de l'agent dans $Dir\agent.js" }
else { Stop-Agent; Fetch "agent.js" (Join-Path $Dir "agent.js"); Write-Host "OK Agent téléchargé" }

$CaPath = ""
if ($HasCa -eq "1") {
    $CaPath = Join-Path $Dir "rootCA.pem"
    if ($Dry) { Write-Host "[essai] téléchargement du certificat de l'autorité locale" } else { Fetch "rootCA.pem" $CaPath }
    Write-Host "OK Certificat de l'autorité locale installé (HTTPS vérifié)"
}

# 3. Lanceur : variables d'environnement + redémarrage automatique en cas d'arrêt de l'agent
$AgentArgs = "run"
if ($HostName) { $AgentArgs = "run --host $HostName" }
$LauncherText = @"
`$env:SKVAULT_URL = '$Origin/api'
`$env:SKVAULT_AGENT_TOKEN = '$Token'
if ('$CaPath') { `$env:NODE_EXTRA_CA_CERTS = '$CaPath' }
`$log = Join-Path '$Dir' 'agent.log'
while (`$true) {
    if ((Test-Path `$log) -and ((Get-Item `$log).Length -gt 5MB)) { Remove-Item `$log -Force }
    & '$Node' (Join-Path '$Dir' 'agent.js') $AgentArgs *>> `$log
    Start-Sleep -Seconds 10
}
"@
if ($Dry) {
    Write-Host "[essai] écriture de $Launcher (jeton protégé par les droits NTFS de votre profil)"
} else {
    Set-Content -Path $Launcher -Value $LauncherText -Encoding UTF8
    # Seul votre compte peut lire ce dossier (il contient le jeton)
    & icacls.exe $Dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
}

# 4. Démarrage automatique à l'ouverture de session (clé Run de l'utilisateur, sans droits administrateur)
$Cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`""
Act "ajout du démarrage automatique ($RunName)" { Set-ItemProperty -Path $RunKey -Name $RunName -Value $Cmd }
Act "démarrage de l'agent" {
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$Launcher`""
}
Write-Host "OK Agent démarré et lancé automatiquement à chaque ouverture de session"
Write-Host "   Journal : $Dir\agent.log"
Write-Host "   Remarque : l'agent tourne tant que votre session est ouverte ; il voit les lecteurs et lecteurs réseau mappés de cette session."

Say "Terminé"
$Shown = if ($HostName) { $HostName } else { $env:COMPUTERNAME }
Write-Host "La machine « $Shown » doit apparaître « en ligne » dans l'onglet Scans de SkVault d'ici quelques secondes."
