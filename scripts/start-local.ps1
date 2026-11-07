$ErrorActionPreference = 'Stop'
$paperBridgeRoot = Split-Path -Parent $PSScriptRoot
$paperBridgePort = 3001
$listener = Get-NetTCPConnection -LocalPort $paperBridgePort -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output 'Port 3001 is already in use. The existing service was left running.'
    exit 0
}
$env:PORT = '3001'
$env:HOST = '127.0.0.1'
$env:BASE_PATH = '/metahackathon'
$env:APP_URL = 'http://localhost:3001/metahackathon'
$logDirectory = Join-Path $paperBridgeRoot 'output/local'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$paperBridgeProcess = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList '--env-file-if-exists=.env', 'server/index.mjs' `
    -WorkingDirectory $paperBridgeRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDirectory 'server.log') `
    -RedirectStandardError (Join-Path $logDirectory 'server-error.log')
Write-Output "PaperBridge started on http://localhost:3001/metahackathon/ (process $($paperBridgeProcess.Id))."
