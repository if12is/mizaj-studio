# Real-Piper smoke test (windows-e2e.yml, job piper-smoke): downloads the pinned engine + voice from
# backend/app/resources/catalog.json (single source of truth), verifies size and sha256, checks that
# every redirect host is on the app's download allowlist (backend/app/resources/net.py), synthesizes
# a diacritized Arabic sentence and validates the WAV. Never prints the text of any user document.
param([string]$Work = (Join-Path $env:RUNNER_TEMP 'piper-smoke'), [string]$Cache = '')
$ErrorActionPreference = 'Stop'
try {
  $root = Resolve-Path (Join-Path $PSScriptRoot '../../..')
  $cat = (Get-Content -Raw -Encoding UTF8 (Join-Path $root 'backend/app/resources/catalog.json') | ConvertFrom-Json).resources
  $engine = $cat | Where-Object id -eq 'piper-engine-win'
  $voice = $cat | Where-Object id -eq 'piper-voice-ar-jo-kareem-medium'
  if (-not $engine -or -not $voice) { throw 'catalog entries missing' }

  $netPy = Get-Content -Raw (Join-Path $root 'backend/app/resources/net.py')
  $block = [regex]::Match($netPy, 'ALLOWED_HOSTS: set\[str\] = \{(.*?)\}', 'Singleline').Groups[1].Value
  $allowed = [regex]::Matches($block, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
  Write-Host "allowlist: $($allowed -join ', ')"

  New-Item -ItemType Directory -Force $Work | Out-Null
  if ($Cache) { New-Item -ItemType Directory -Force $Cache | Out-Null } else { $Cache = $Work }

  Add-Type -AssemblyName System.Net.Http
  function Get-Pinned($item, $dest) {
    if ((Test-Path $dest) -and ((Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() -eq $item.sha256)) {
      Write-Host "cache hit: $($item.filename)"; return
    }
    # follow redirects by hand so each hop's host can be checked against the app's allowlist
    $h = [System.Net.Http.HttpClientHandler]::new(); $h.AllowAutoRedirect = $false
    $c = [System.Net.Http.HttpClient]::new($h); $c.Timeout = [TimeSpan]::FromMinutes(20)
    $url = $item.url
    for ($i = 0; $i -lt 6; $i++) {
      $u = [Uri]$url
      if ($u.Scheme -ne 'https') { throw "non-https hop: $url" }
      if ($allowed -notcontains $u.Host) { throw "redirect host NOT on the app allowlist: $($u.Host)" }
      Write-Host "GET host=$($u.Host)"
      $r = $c.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
      if ([int]$r.StatusCode -ge 300 -and [int]$r.StatusCode -lt 400) { $url = [Uri]::new($u, $r.Headers.Location).AbsoluteUri; continue }
      if (-not $r.IsSuccessStatusCode) { throw "HTTP $([int]$r.StatusCode) for $($item.filename)" }
      $fs = [IO.File]::Create($dest)
      try { $r.Content.CopyToAsync($fs).GetAwaiter().GetResult() } finally { $fs.Dispose() }
      break
    }
    $f = Get-Item $dest
    if ($item.size -and $f.Length -ne $item.size) { throw "size mismatch for $($item.filename): $($f.Length) != $($item.size)" }
    $hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $item.sha256) { throw "sha256 mismatch for $($item.filename): $hash" }
    Write-Host "verified $($item.filename) size=$($f.Length) sha256=$hash"
  }

  $zip = Join-Path $Cache $engine.filename
  $onnx = Join-Path $Cache $voice.filename
  Get-Pinned $engine $zip
  Get-Pinned $voice $onnx
  $cfgItem = $voice.extra_files[0]
  $cfg = Join-Path $Cache $cfgItem.filename
  Get-Pinned $cfgItem $cfg

  $exeDir = Join-Path $Work 'piper'
  if (Test-Path $exeDir) { Remove-Item -Recurse -Force $exeDir }
  Expand-Archive -Path $zip -DestinationPath $Work -Force
  $exe = Join-Path $exeDir 'piper.exe'
  if (-not (Test-Path $exe)) { throw 'piper.exe missing after extraction' }

  # text goes through STDIN from a UTF-8 (no BOM) file, never argv
  $txt = Join-Path $Work 'in.txt'
  [IO.File]::WriteAllText($txt, "قَوْسُ قُزَحٍ ظَاهِرَةٌ طَبِيعِيَّةٌ`n", [Text.UTF8Encoding]::new($false))
  $wav = Join-Path $Work 'out.wav'
  Remove-Item $wav -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $exe -ArgumentList @('--model', $onnx, '--config', $cfg, '--output_file', $wav, '--length_scale', '1.0') `
    -RedirectStandardInput $txt -RedirectStandardOutput (Join-Path $Work 'o.txt') -RedirectStandardError (Join-Path $Work 'e.txt') `
    -WorkingDirectory $exeDir -NoNewWindow -PassThru
  if (-not $p.WaitForExit(120000)) { $p.Kill(); throw 'piper timed out' }
  if ($p.ExitCode -ne 0) { Get-Content (Join-Path $Work 'e.txt') -Tail 20; throw "piper exit code $($p.ExitCode)" }

  if (-not (Test-Path $wav)) { throw 'no WAV produced' }
  $b = [IO.File]::ReadAllBytes($wav)
  if ($b.Length -le 44) { throw "WAV too small: $($b.Length)" }
  if ([Text.Encoding]::ASCII.GetString($b, 0, 4) -ne 'RIFF' -or [Text.Encoding]::ASCII.GetString($b, 8, 4) -ne 'WAVE') { throw 'not a RIFF/WAVE file' }
  $fmt = [BitConverter]::ToUInt16($b, 20); $ch = [BitConverter]::ToUInt16($b, 22); $rate = [BitConverter]::ToUInt32($b, 24); $bits = [BitConverter]::ToUInt16($b, 34)
  $voiceRate = (Get-Content -Raw -Encoding UTF8 $cfg | ConvertFrom-Json).audio.sample_rate
  if ($fmt -ne 1 -or $bits -ne 16) { throw "unexpected WAV format fmt=$fmt bits=$bits" }
  if ($rate -ne $voiceRate) { throw "sample rate $rate != voice config $voiceRate" }
  $seconds = ($b.Length - 44) / ($rate * $ch * ($bits / 8))
  if ($seconds -lt 0.8) { throw "WAV too short: $seconds s" }
  $nonzero = 0; for ($i = 44; $i -lt $b.Length - 1; $i += 2) { if ($b[$i] -ne 0 -or $b[$i + 1] -ne 0) { $nonzero++ } }
  if ($nonzero -lt 1000) { throw 'WAV is silent' }
  Write-Host "OK piper WAV: $($b.Length) bytes, $([math]::Round($seconds,2)) s, $rate Hz, non-silent samples=$nonzero"
  "- piper smoke OK: $($b.Length) bytes WAV, $([math]::Round($seconds,2)) s, $rate Hz" | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY
}
catch {
  $err = Join-Path $Work 'e.txt'
  $tail = if (Test-Path $err) { (Get-Content $err -Tail 15) -join ' | ' } else { '' }
  $msg = "$($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber). piper stderr: $tail"
  Write-Host "::error title=Piper smoke::$($msg.Replace('%','%25').Replace("`r",'').Replace("`n",' '))"
  exit 1
}
