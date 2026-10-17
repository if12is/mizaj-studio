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
      # Capture the port first: a second -match would overwrite $Matches.
      $m = [regex]::Match($txt, 'MIZAJ_PORT=(\d+)')
      if ($m.Success -and $txt.Contains('MIZAJ_STATUS=READY')) { $port = $m.Groups[1].Value; break }
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $port) { throw "Timed out after ${TimeoutSec}s waiting for MIZAJ_PORT/READY`n$(Get-Content $err -Raw)" }
  $base = "http://127.0.0.1:$port"
  $health = Invoke-RestMethod "$base/health"
  if ($health.status -ne 'ok') { throw "Unexpected /health: $($health | ConvertTo-Json)" }
  Write-Host "health ok: engine_mode=$($health.engine_mode) port=$port"
  # Arabic built from code points so the script is safe regardless of how the file is decoded.
  $sample = -join ([char[]](0x0643, 0x062A, 0x0627, 0x0628, 0x0020, 0x062C, 0x0645, 0x064A, 0x0644))
  $body = [Text.Encoding]::UTF8.GetBytes((@{ text = $sample; mode = 'accurate' } | ConvertTo-Json))
  $r = Invoke-RestMethod "$base/api/tashkeel" -Method Post -ContentType 'application/json; charset=utf-8' -Body $body
  Write-Host "tashkeel -> $($r.text) (engine=$($r.engine))"
  if ($r.text -notmatch '[\u064B-\u0652]') { throw "No diacritics in output: $($r.text)" }
  Write-Host 'frozen engine smoke test PASSED'
}
catch {
  Write-Host '--- engine stdout ---'; if (Test-Path $out) { Get-Content $out | Write-Host }
  Write-Host '--- engine stderr ---'; if (Test-Path $err) { Get-Content $err | Write-Host }
  throw
}
finally {
  if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force }
}
