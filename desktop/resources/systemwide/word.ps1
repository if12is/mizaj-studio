# Mizaj Studio - Microsoft Word (COM) helper for "Mizaj in any program".
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File word.ps1 -Request <req.json> -Response <resp.json>
#
# The user's text is never passed on the command line: the request and response are UTF-8 JSON files
# in a private per-job folder that the app deletes right after the call. No Arabic literals in this
# script (the undo-record name comes from the request).
#
#   read   : the active selection (Range.Text, Start, End) and whether Range offsets and Text indices agree.
#   apply  : minimal edits applied from the END backwards on Range objects, so every untouched character keeps
#            its font, size, colour and paragraph style, and inserted marks inherit the preceding character's
#            formatting. One Undo record: a single Ctrl+Z reverts everything.
param(
  [Parameter(Mandatory = $true)][string]$Request,
  [Parameter(Mandatory = $true)][string]$Response
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [System.IO.File]::WriteAllText($Response, $json, $utf8)
}

function Same([string]$a, [string]$b) {
  return [string]::Equals($a, $b, [System.StringComparison]::Ordinal)
}

# Characters that are structure, not text: paragraph / cell / line / page / section marks and field markers.
function Has-Structure([string]$s) {
  return $s -match '[\u0000-\u0008\u000B-\u001F]' -or $s.Contains("`r") -or $s.Contains([string][char]7)
}

try {
  $req = [System.IO.File]::ReadAllText($Request, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

  try {
    $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
  }
  catch {
    Write-Result @{ ok = $false; error = 'word_unavailable' }
    exit 0
  }

  try { $doc = $word.ActiveDocument } catch { $doc = $null }
  if ($null -eq $doc) { Write-Result @{ ok = $false; error = 'word_no_document' }; exit 0 }   # e.g. Protected View
  if ($doc.ProtectionType -ne -1) { Write-Result @{ ok = $false; error = 'word_protected' }; exit 0 }

  switch ($req.cmd) {
    'read' {
      $sel = $word.Selection
      $rng = $sel.Range
      $start = [int]$rng.Start
      $end = [int]$rng.End
      if ($end -le $start) { Write-Result @{ ok = $true; empty = $true }; break }
      $text = [string]$rng.Text
      # Range offsets count field codes, table cell marks, inline shapes... Text indices do not.
      $reasons = @()
      if ($text.Length -ne ($end - $start)) { $reasons += 'length' }
      if ($rng.Fields.Count -gt 0) { $reasons += 'fields' }
      if ($rng.Tables.Count -gt 0) { $reasons += 'tables' }
      if ($rng.InlineShapes.Count -gt 0) { $reasons += 'shapes' }
      try { if ($rng.ContentControls.Count -gt 0) { $reasons += 'content_controls' } } catch { }
      try { if ($rng.Footnotes.Count -gt 0 -or $rng.Endnotes.Count -gt 0) { $reasons += 'notes' } } catch { }
      try { if ($rng.Revisions.Count -gt 0) { $reasons += 'revisions' } } catch { }
      Write-Result @{
        ok = $true; empty = $false; text = $text; start = $start; end = $end
        consistent = ($reasons.Count -eq 0); reasons = @($reasons)
      }
    }

    'apply' {
      $start = [int]$req.start
      $end = [int]$req.end
      $expected = [string]$req.expected
      $edits = @($req.edits)

      $cur = $doc.Range($start, $end)
      if (-not (Same ([string]$cur.Text) $expected) -or ($cur.End - $cur.Start) -ne $expected.Length) {
        Write-Result @{ ok = $false; error = 'changed' }
        break
      }
      # first pass, nothing modified yet: every replaced / deleted span must still read exactly as expected
      foreach ($e in $edits) {
        $s = [int]$e.s; $t = [int]$e.e
        if ($t -gt $s) {
          $old = $expected.Substring($s, $t - $s)
          if ((Has-Structure $old) -or (Has-Structure ([string]$e.ins))) { Write-Result @{ ok = $false; error = 'mismatch' }; exit 0 }
          $r = $doc.Range($start + $s, $start + $t)
          if (-not (Same ([string]$r.Text) $old)) { Write-Result @{ ok = $false; error = 'mismatch' }; exit 0 }
        }
        elseif (Has-Structure ([string]$e.ins)) { Write-Result @{ ok = $false; error = 'mismatch' }; exit 0 }
      }

      $undo = $null
      try { $undo = $word.UndoRecord; $undo.StartCustomRecord([string]$req.undoName) } catch { $undo = $null }
      $failed = $null
      try {
        for ($i = $edits.Count - 1; $i -ge 0; $i--) {
          $e = $edits[$i]
          $s = [int]$e.s; $t = [int]$e.e; $ins = [string]$e.ins
          if ($t -eq $s) {
            # insertion: extend the PRECEDING character so the new text takes its formatting
            $done = $false
            if ($s -gt 0) {
              $prevCh = $expected[$s - 1]
              if ($prevCh -ne "`r" -and $prevCh -ne [char]7 -and $prevCh -ne [char]12) {
                $prev = $doc.Range($start + $s - 1, $start + $s)
                $prev.InsertAfter($ins)
                $done = $true
              }
            }
            if (-not $done) { $doc.Range($start + $s, $start + $s).InsertAfter($ins) }
          }
          elseif ($ins.Length -eq 0) {
            [void]$doc.Range($start + $s, $start + $t).Delete()
          }
          else {
            $doc.Range($start + $s, $start + $t).Text = $ins
          }
        }
      }
      catch { $failed = $_.Exception.Message }
      finally { if ($null -ne $undo) { try { $undo.EndCustomRecord() } catch { } } }

      if ($null -ne $failed) {
        # undo the partial batch (it is a single custom record) so the document is never left half edited
        try { [void]$doc.Undo(1) } catch { }
        Write-Result @{ ok = $false; error = 'word_failed'; detail = [string]$failed }
        break
      }
      try { $word.Selection.SetRange($start, $start + [int]$req.newLength) } catch { }
      Write-Result @{ ok = $true }
    }

    default { Write-Result @{ ok = $false; error = 'bad_command' } }
  }
}
catch {
  Write-Result @{ ok = $false; error = 'word_failed'; detail = [string]$_.Exception.Message }
}
