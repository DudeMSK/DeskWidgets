# Диагностика окон DeskWidgets: размер, позиция, видимость, Z-порядок, стили и (опционально) снимок содержимого.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\winprobe.ps1 [-Shot out.png]
# Снимок делается через PrintWindow, поэтому работает, даже если виджет закрыт другими окнами.
param(
    [string]$Shot   # куда сохранить снимок(и) окон виджетов; к имени добавляется номер окна
)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class Win {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    // Окна верхнего уровня, принадлежащие процессам
    public static List<IntPtr> Of(HashSet<uint> pids) {
        var res = new List<IntPtr>();
        EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (pids.Contains(p)) res.Add(h); return true; }, IntPtr.Zero);
        return res;
    }
    // Номер окна в Z-порядке сверху вниз среди видимых окон верхнего уровня (0 — самое верхнее)
    public static int ZIndex(IntPtr target) {
        int i = 0;
        for (IntPtr h = GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = GetWindow(h, 2)) {
            if (h == target) return i;
            if (IsWindowVisible(h)) i++;
        }
        return -1;
    }
}
'@

[void][Win]::SetProcessDPIAware()

$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
# electron.exe — запуск из исходников (npm start), DeskWidgets.exe — собранное приложение
Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='DeskWidgets.exe'" | ForEach-Object { [void]$pids.Add([uint32]$_.ProcessId) }

$n = 0
foreach ($h in [Win]::Of($pids)) {
    $r = New-Object Win+RECT
    [void][Win]::GetWindowRect($h, [ref]$r)
    $w = $r.R - $r.L; $ht = $r.B - $r.T
    if ($w -lt 50 -or $ht -lt 50) { continue }
    $cls = New-Object System.Text.StringBuilder 64
    [void][Win]::GetClassName($h, $cls, 64)
    $ex = [Win]::GetWindowLong($h, -20)
    # Слой desktop: владелец окна (GWLP_HWNDPARENT = -8) — Progman
    $owner = [Win]::GetWindowLongPtr($h, -8).ToInt64()
    # [NullString]::Value, а не $null: PowerShell превращает $null в пустую строку, и FindWindow ничего не находит
    $ownedByDesktop = $owner -ne 0 -and $owner -eq ([Win]::FindWindow('Progman', [NullString]::Value)).ToInt64()
    '{0}  {1}x{2} at ({3},{4})  visible={5} iconic={6} z={7} toolwindow={8} noactivate={9} topmost={10} ownerIsDesktop={11}' -f `
        $cls, $w, $ht, $r.L, $r.T, [Win]::IsWindowVisible($h), [Win]::IsIconic($h), [Win]::ZIndex($h), `
        (($ex -band 0x80) -ne 0), (($ex -band 0x08000000) -ne 0), (($ex -band 0x8) -ne 0), $ownedByDesktop

    if ($Shot -and [Win]::IsWindowVisible($h)) {
        $n++
        $bmp = New-Object System.Drawing.Bitmap $w, $ht
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        [void][Win]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
        $g.ReleaseHdc($hdc); $g.Dispose()
        $path = [IO.Path]::ChangeExtension($Shot, "$n.png")
        $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        "  -> снимок: $path"
    }
}
