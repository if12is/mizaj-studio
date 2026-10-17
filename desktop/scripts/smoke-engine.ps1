<#
 Smoke-test the frozen engine (PyInstaller onedir) the way Electron launches it:
   mizaj-engine.exe --host 127.0.0.1 --port 0 --data-dir <tmp>
 reads MIZAJ_PORT from stdout, GET /health, POST /api/tashkeel (accurate), then kills it.
#>
param(
  [string]$Engine = (Join-Path $PSScriptRoot '..\..\backend\dist\mizaj-engine\mizaj-engine.exe'),
  [string]$DataDir = (Join-Path ([IO.Path]::GetTempPath()) 'mizaj-smoke'),
  [string]$ModelsDir = (Join-Path $PSScriptRoot '..\..\backend\models\catt_eo'),
  [int]$TimeoutSec = 90
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Engine)) { throw "Engine not found: $Engine" }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$out = Join-Path $DataDir 'engine.out.txt'
$err = Join-Path $DataDir 'engine.err.txt'
Remove-Item $out, $err -ErrorAction SilentlyContinue
$env:MIZAJ_MODELS_DIR = $ModelsDir
Remove-Item Env:MIZAJ_ENGINE_MODE -ErrorAction SilentlyContinue   # real engine, not mock
$p = Start-Process -FilePath $Engine -PassThru -WindowStyle Hidden `
  -ArgumentList @('--host', '127.0.0.1', '--port', '0', '--data-dir', $DataDir) `
  -RedirectStandardOutput $out -RedirectStandardError $err
try {
  $port = $null
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) { throw "Engine exited early with code $($p.ExitCode)`n$(Get-Content $err -Raw)" }
    if (Test-Path $out) {
      $txt = Get-Content $out -Raw
      if ($txt -match 'MIZAJ_PORT=(\d+)' -and $txt -match 'MIZAJ_STATUS=READY') { $port = $Matches[1]; break }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $port) { throw "Timed out after ${TimeoutSec}s waiting for MIZAJ_PORT/READY`n$(Get-Content $err -Raw)" }
  $base = "http://127.0.0.1:$port"
  $health = Invoke-RestMethod "$base/health"
  if ($health.status -ne 'ok') { throw "Unexpected /health: $($health | ConvertTo-Json)" }
  Write-Host "health ok: engine_mode=$($health.engine_mode) port=$port"
  $body = [Text.Encoding]::UTF8.GetBytes((@{ text = 'كتاب جميل'; mode = 'accurate' } | ConvertTo-Json))
  $r = Invoke-RestMethod "$base/api/tashkeel" -Method Post -ContentType 'application/json; charset=utf-8' -Body $body
  Write-Host "tashkeel -> $($r.text) (engine=$($r.engine))"
  if ($r.text -notmatch '[ً-ْ]') { throw "No diacritics in output: $($r.text)" }
  Write-Host 'frozen engine smoke test PASSED'
}
finally {
  if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force }
}
