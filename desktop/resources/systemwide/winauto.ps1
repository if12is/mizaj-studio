# Mizaj Studio - Windows automation helper for "Mizaj in any program" (system-wide feature).
#
# Run by the app with execFile (never through a shell):
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File winauto.ps1 -Request <req.json> -Response <resp.json>
#
# Privacy: the user's text is NEVER passed on the command line. It travels only through files inside
# a private per-job folder under <userData>/systemwide-tmp, which the app deletes right after the call.
# This script contains no Arabic literals (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).
#
# Commands (field "cmd" of the request):
#   info     foreground window: handle, process, elevated?
#   capture  copy the selection of the foreground program (Ctrl+C) with the full clipboard saved and
#            restored; the rich content is written to a container file. Word is reported, not copied.
#   paste    put a container's content on the clipboard, send Ctrl+V, restore the previous clipboard.
#   focus    bring a window to the foreground.
#   clipboard-roundtrip   (CI smoke test) snapshot -> clear -> restore, no keystrokes.
#   clip-set / clip-dump / ctrl-key   (CI smoke test helpers) set the clipboard from a container,
#            save it to a container, press Ctrl+<letter> in the foreground program.
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

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Diagnostics;

public class MzFg {
  public long Hwnd; public uint Pid; public string Exe = ""; public bool Elevated; public bool SelfElevated;
}

public static class MzWin {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern bool EmptyClipboard();
  [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint fmt);
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint fmt);
  [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint fmt, IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClipboardFormatName(uint fmt, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] static extern int CountClipboardFormats();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr size);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder sb, ref uint size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int len, out int ret);

  const long MaxBytes = 96L * 1024 * 1024;

  // ---- foreground window -------------------------------------------------------------------
  public static bool IsSelfElevated() {
    try { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
    catch { return false; }
  }

  public static MzFg Foreground() {
    var r = new MzFg();
    IntPtr h = GetForegroundWindow();
    r.Hwnd = h.ToInt64();
    r.SelfElevated = IsSelfElevated();
    if (h == IntPtr.Zero) return r;
    uint pid; GetWindowThreadProcessId(h, out pid);
    r.Pid = pid;
    // A process we cannot open or read the token of is treated as elevated (UIPI would block us anyway).
    bool elevated = true;
    IntPtr p = OpenProcess(0x1000, false, pid);              // PROCESS_QUERY_LIMITED_INFORMATION
    if (p != IntPtr.Zero) {
      try {
        var sb = new StringBuilder(1024); uint n = 1024;
        if (QueryFullProcessImageName(p, 0, sb, ref n)) r.Exe = Path.GetFileName(sb.ToString());
        IntPtr tok;
        if (OpenProcessToken(p, 0x0008, out tok)) {           // TOKEN_QUERY
          try {
            int info; int ret;
            if (GetTokenInformation(tok, 20, out info, 4, out ret)) elevated = info != 0;   // TokenElevation
          } finally { CloseHandle(tok); }
        }
      } finally { CloseHandle(p); }
    }
    r.Elevated = elevated;
    return r;
  }

  public static bool Focus(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    if (IsIconic(h)) ShowWindow(h, 9);                        // SW_RESTORE
    uint pid; uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != me) attached = AttachThreadInput(me, fgThread, true);
    try { SetForegroundWindow(h); } finally { if (attached) AttachThreadInput(me, fgThread, false); }
    for (int i = 0; i < 10; i++) { if (GetForegroundWindow() == h) return true; Thread.Sleep(30); }
    return GetForegroundWindow() == h;
  }

  // ---- keyboard ------------------------------------------------------------------------------
  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  /// <summary>Wait until Shift/Ctrl/Alt/Win are physically released (the user is still holding the shortcut).</summary>
  public static bool WaitModifiersUp(int timeoutMs) {
    var sw = Stopwatch.StartNew();
    int[] mods = { 0x10, 0x11, 0x12, 0x5B, 0x5C };
    while (sw.ElapsedMilliseconds < timeoutMs) {
      bool any = false;
      foreach (int m in mods) if (Down(m)) { any = true; break; }
      if (!any) { Thread.Sleep(30); return true; }
      Thread.Sleep(15);
    }
    return false;
  }

  static INPUT Key(ushort vk, bool up) {
    var i = new INPUT(); i.type = 1;
    i.u.ki.wVk = vk; i.u.ki.dwFlags = up ? 2u : 0u;
    return i;
  }

  /// <summary>Ctrl + key (key = 0x43 for C, 0x56 for V) through SendInput.</summary>
  public static bool CtrlCombo(ushort key) {
    INPUT[] inp = { Key(0x11, false), Key(key, false), Key(key, true), Key(0x11, true) };
    return SendInput((uint)inp.Length, inp, Marshal.SizeOf(typeof(INPUT))) == (uint)inp.Length;
  }

  // ---- clipboard -----------------------------------------------------------------------------
  public static uint Seq() { return GetClipboardSequenceNumber(); }
  public static bool HasData() { return CountClipboardFormats() > 0; }

  static bool OpenClip() {
    for (int i = 0; i < 40; i++) { if (OpenClipboard(IntPtr.Zero)) return true; Thread.Sleep(25); }
    return false;
  }

  public static void Clear() {
    if (!OpenClip()) throw new Exception("clipboard_busy");
    try { EmptyClipboard(); } finally { CloseClipboard(); }
  }

  /// <summary>Save every memory based clipboard format (GDI handle formats are re-created by Windows from DIB data).</summary>
  public static int Snapshot(string path) {
    if (!OpenClip()) throw new Exception("clipboard_busy");
    int skipped = 0;
    byte[] bytes;
    try {
      var fmts = new List<uint>();
      uint f = 0;
      while ((f = EnumClipboardFormats(f)) != 0) fmts.Add(f);
      bool hasUni = fmts.Contains(13);
      var ms = new MemoryStream();
      var w = new BinaryWriter(ms);
      w.Write(Encoding.ASCII.GetBytes("MZC1"));
      w.Write((uint)0);
      uint count = 0; long total = 0;
      foreach (uint fmt in fmts) {
        if (fmt == 2 || fmt == 3 || fmt == 9 || fmt == 14) continue;          // bitmap, metafile, palette, enhanced metafile
        if (fmt >= 0x80 && fmt <= 0x8E) continue;                              // owner-display / DSP formats
        if (fmt >= 0x300 && fmt <= 0x3FF) continue;                            // GDI object range
        if (hasUni && (fmt == 1 || fmt == 7)) continue;                        // synthesized text variants
        string name = "";
        if (fmt >= 0xC000) {
          var sb = new StringBuilder(256);
          if (GetClipboardFormatName(fmt, sb, 256) <= 0) { skipped++; continue; }
          name = sb.ToString();
        }
        IntPtr h = GetClipboardData(fmt);
        if (h == IntPtr.Zero) { skipped++; continue; }
        long size = (long)GlobalSize(h).ToUInt64();
        if (size <= 0) continue;
        if (total + size > MaxBytes) { skipped++; continue; }
        IntPtr p = GlobalLock(h);
        if (p == IntPtr.Zero) { skipped++; continue; }
        byte[] data = new byte[size];
        try { Marshal.Copy(p, data, 0, (int)size); } finally { GlobalUnlock(h); }
        total += size;
        byte[] nb = Encoding.UTF8.GetBytes(name);
        w.Write(name.Length > 0 ? 0 : (int)fmt);
        w.Write((ushort)nb.Length);
        w.Write(nb);
        w.Write((uint)data.Length);
        w.Write(data);
        count++;
      }
      w.Flush();
      bytes = ms.ToArray();
      byte[] c = BitConverter.GetBytes(count);
      Array.Copy(c, 0, bytes, 4, 4);
    } finally { CloseClipboard(); }
    File.WriteAllBytes(path, bytes);
    return skipped;
  }

  /// <summary>Replace the clipboard with the entries of a container file (an empty container empties it).</summary>
  public static void Restore(string path) {
    byte[] b = File.ReadAllBytes(path);
    if (b.Length < 8 || b[0] != (byte)'M' || b[1] != (byte)'Z' || b[2] != (byte)'C' || b[3] != (byte)'1') throw new Exception("bad_container");
    uint count = BitConverter.ToUInt32(b, 4);
    int pos = 8;
    var items = new List<KeyValuePair<uint, byte[]>>();
    for (uint i = 0; i < count; i++) {
      int id = BitConverter.ToInt32(b, pos); pos += 4;
      int nl = BitConverter.ToUInt16(b, pos); pos += 2;
      string name = Encoding.UTF8.GetString(b, pos, nl); pos += nl;
      int dl = (int)BitConverter.ToUInt32(b, pos); pos += 4;
      byte[] d = new byte[dl]; Array.Copy(b, pos, d, 0, dl); pos += dl;
      uint fmt = name.Length > 0 ? RegisterClipboardFormat(name) : (uint)id;
      if (fmt != 0) items.Add(new KeyValuePair<uint, byte[]>(fmt, d));
    }
    if (!OpenClip()) throw new Exception("clipboard_busy");
    try {
      EmptyClipboard();
      foreach (var it in items) {
        IntPtr h = GlobalAlloc(0x0002, new UIntPtr((uint)it.Value.Length));   // GMEM_MOVEABLE
        if (h == IntPtr.Zero) continue;
        IntPtr p = GlobalLock(h);
        if (p == IntPtr.Zero) { GlobalFree(h); continue; }
        Marshal.Copy(it.Value, 0, p, it.Value.Length);
        GlobalUnlock(h);
        if (SetClipboardData(it.Key, h) == IntPtr.Zero) GlobalFree(h);
      }
    } finally { CloseClipboard(); }
  }

  /// <summary>Ctrl+C in the foreground program. 1 = copied, 0 = nothing was copied, -1 = modifier keys still held.</summary>
  public static int CopySelection(string origPath, string newPath, int timeoutMs, out int skipped) {
    skipped = Snapshot(origPath);
    Clear();
    if (!WaitModifiersUp(2500)) { Restore(origPath); return -1; }
    uint seq0 = Seq();
    CtrlCombo(0x43);
    var sw = Stopwatch.StartNew();
    bool changed = false;
    while (sw.ElapsedMilliseconds < timeoutMs) {
      if (Seq() != seq0 && HasData()) { changed = true; break; }
      Thread.Sleep(25);
    }
    if (!changed) { Restore(origPath); return 0; }
    // let the program finish writing all of its formats
    uint last = Seq(); var quiet = Stopwatch.StartNew(); var cap = Stopwatch.StartNew();
    while (quiet.ElapsedMilliseconds < 80 && cap.ElapsedMilliseconds < 600) {
      Thread.Sleep(15);
      uint now = Seq();
      if (now != last) { last = now; quiet.Restart(); }
    }
    try { Snapshot(newPath); } finally { Restore(origPath); }
    return 1;
  }
}
'@

function Foreground-Object($fg) {
  return @{ hwnd = [int64]$fg.Hwnd; pid = [int64]$fg.Pid; exe = [string]$fg.Exe; elevated = [bool]$fg.Elevated; selfElevated = [bool]$fg.SelfElevated }
}

$terminals = @('cmd.exe', 'conhost.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe', 'openconsole.exe')

try {
  $req = [System.IO.File]::ReadAllText($Request, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  Add-Type -TypeDefinition $source -Language CSharp

  switch ($req.cmd) {
    'info' {
      $fg = [MzWin]::Foreground()
      Write-Result @{ ok = $true; fg = (Foreground-Object $fg) }
    }

    'capture' {
      $fg = [MzWin]::Foreground()
      $fo = Foreground-Object $fg
      if ($fg.Hwnd -eq 0) { Write-Result @{ ok = $false; error = 'no_window'; fg = $fo }; break }
      if ($fg.Elevated -and -not $fg.SelfElevated) { Write-Result @{ ok = $false; error = 'elevated'; fg = $fo }; break }
      $exe = $fg.Exe.ToLowerInvariant()
      if ($terminals -contains $exe) { Write-Result @{ ok = $false; error = 'terminal'; fg = $fo }; break }
      if ($exe -eq 'winword.exe' -and -not $req.forceCopy) { Write-Result @{ ok = $true; word = $true; fg = $fo }; break }
      $skipped = 0
      $timeout = [int]$req.timeoutMs
      if ($timeout -lt 300) { $timeout = 1500 }
      $orig = Join-Path $req.dir 'before.bin'
      $r = [MzWin]::CopySelection($orig, $req.outPath, $timeout, [ref]$skipped)
      if ($r -eq -1) { Write-Result @{ ok = $false; error = 'modifiers_held'; fg = $fo }; break }
      if ($r -eq 0) { Write-Result @{ ok = $true; word = $false; copied = $false; fg = $fo }; break }
      Write-Result @{ ok = $true; word = $false; copied = $true; skipped = [int]$skipped; fg = $fo }
    }

    'paste' {
      $fg = [MzWin]::Foreground()
      $before = Join-Path $req.dir 'before-paste.bin'
      [void][MzWin]::Snapshot($before)
      [MzWin]::Restore($req.contentPath)
      $seq = [MzWin]::Seq()
      $ok = $true
      $err = ''
      if ([int64]$req.hwnd -ne 0 -and $fg.Hwnd -ne [int64]$req.hwnd) {
        if (-not [MzWin]::Focus([int64]$req.hwnd)) { $ok = $false; $err = 'focus_lost' }
        else { Start-Sleep -Milliseconds 120 }
      }
      if ($ok) {
        $now = [MzWin]::Foreground()
        if ($now.Elevated -and -not $now.SelfElevated) { $ok = $false; $err = 'elevated' }
      }
      if ($ok -and -not [MzWin]::WaitModifiersUp(2500)) { $ok = $false; $err = 'modifiers_held' }
      if ($ok) {
        if (-not [MzWin]::CtrlCombo(0x56)) { $ok = $false; $err = 'send_failed' }
      }
      $delay = [int]$req.restoreDelayMs
      if ($delay -lt 100) { $delay = 700 }
      if ($ok) { Start-Sleep -Milliseconds $delay }
      # restore the user's clipboard, unless somebody (the user, a clipboard manager) changed it meanwhile
      if ([MzWin]::Seq() -eq $seq -or -not $ok) { [MzWin]::Restore($before) }
      if ($ok) { Write-Result @{ ok = $true } } else { Write-Result @{ ok = $false; error = $err } }
    }

    'focus' {
      $f = [MzWin]::Focus([int64]$req.hwnd)
      Write-Result @{ ok = [bool]$f; error = $(if ($f) { '' } else { 'focus_lost' }) }
    }

    'clipboard-roundtrip' {
      $snap = Join-Path $req.dir 'roundtrip.bin'
      $skipped = [MzWin]::Snapshot($snap)
      [MzWin]::Clear()
      $emptied = -not [MzWin]::HasData()
      [MzWin]::Restore($snap)
      Write-Result @{ ok = $true; skipped = [int]$skipped; emptied = [bool]$emptied; snapshot = $snap }
    }

    'clip-set' {
      [MzWin]::Restore($req.contentPath)
      Write-Result @{ ok = $true }
    }

    'clip-dump' {
      $skipped = [MzWin]::Snapshot($req.outPath)
      Write-Result @{ ok = $true; skipped = [int]$skipped }
    }

    'ctrl-key' {
      $letter = ([string]$req.key).ToUpperInvariant()
      if ($letter.Length -ne 1 -or $letter -notmatch '^[A-Z]$') { Write-Result @{ ok = $false; error = 'bad_command' }; break }
      if (-not [MzWin]::WaitModifiersUp(2500)) { Write-Result @{ ok = $false; error = 'modifiers_held' }; break }
      $sent = [MzWin]::CtrlCombo([uint16][char]$letter)
      Start-Sleep -Milliseconds 150
      Write-Result @{ ok = [bool]$sent; error = $(if ($sent) { '' } else { 'send_failed' }) }
    }

    default { Write-Result @{ ok = $false; error = 'bad_command' } }
  }
}
catch {
  Write-Result @{ ok = $false; error = 'helper_failed'; detail = [string]$_.Exception.Message }
}
