# CI fixture for the Word part of the system-wide smoke test (Windows runners that have Word only).
#   powershell.exe -NoProfile -File word-fixture.ps1 -Request req.json -Response resp.json
# Commands: create | inspect | undo | close
param(
  [Parameter(Mandatory = $true)][string]$Request,
  [Parameter(Mandatory = $true)][string]$Response
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Result($obj) {
  [System.IO.File]::WriteAllText($Response, ($obj | ConvertTo-Json -Compress -Depth 6), $utf8)
}
function Describe-Range($r) {
  return @{
    text = [string]$r.Text; bold = [int]$r.Font.Bold; color = [int]$r.Font.Color
    size = [double]$r.Font.Size; font = [string]$r.Font.Name
  }
}
try {
  $req = [System.IO.File]::ReadAllText($Request, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  switch ($req.cmd) {
    'create' {
      $word = New-Object -ComObject Word.Application
      $word.Visible = $true
      $doc = $word.Documents.Add()
      # two runs with different formatting: first word bold red 20pt, the rest normal Arial 12pt
      $doc.Content.Text = [string]$req.text
      $all = $doc.Content
      $all.Font.Name = 'Arial'; $all.Font.Size = 12; $all.Font.Bold = 0; $all.Font.Color = 0
      $first = $doc.Range(0, [int]$req.firstLength)
      $first.Font.Bold = 1; $first.Font.Color = 255; $first.Font.Size = 20
      $doc.Range(0, [int]$req.text.Length).Select()
      $word.Activate()
      Write-Result @{ ok = $true; hwnd = [int64]$word.ActiveWindow.Hwnd }
    }
    'inspect' {
      $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
      $doc = $word.ActiveDocument
      $n = [int]$req.firstLength
      # the formatting of the FIRST character and of the LAST character, wherever they ended up
      $len = $doc.Content.End - 1
      Write-Result @{
        ok = $true; text = [string]$doc.Range(0, $len).Text
        first = (Describe-Range $doc.Range(0, 1)); last = (Describe-Range $doc.Range($len - 1, $len))
      }
    }
    'undo' {
      $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
      $doc = $word.ActiveDocument
      [void]$doc.Undo(1)
      $len = $doc.Content.End - 1
      Write-Result @{ ok = $true; text = [string]$doc.Range(0, $len).Text }
    }
    'close' {
      try {
        $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
        $word.DisplayAlerts = 0
        foreach ($d in @($word.Documents)) { $d.Close(0) }
        $word.Quit(0)
      } catch { }
      Write-Result @{ ok = $true }
    }
    default { Write-Result @{ ok = $false; error = 'bad_command' } }
  }
}
catch {
  Write-Result @{ ok = $false; error = 'failed'; detail = [string]$_.Exception.Message }
}
