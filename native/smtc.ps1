# Помощник SMTC (System Media Transport Controls): отдаёт состояние всех медиа-сессий Windows
# построчным JSON в stdout и принимает команды построчным JSON из stdin.
#
#   stdout: {"type":"state","current":"<id>","sessions":[{...}]}
#           {"type":"thumb","key":"<key>","data":"data:image/...;base64,..."}
#   stdin:  {"cmd":"playpause|play|pause|next|prev","session":"<id>"}
#
# Работает на Windows PowerShell 5.1 без установки компиляторов и SDK.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# UTF-8 без BOM, чтобы кириллица в названиях треков не ломалась
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding $false))
$stdout.AutoFlush = $true
$stdout.NewLine = "`n"

[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamReference, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, [Type]$type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    [void]$task.Wait(-1)
    $task.Result
}

function AwaitAction($op) {
    $task = [System.WindowsRuntimeSystemExtensions]::AsTask($op)
    [void]$task.Wait(-1)
}

function Send($obj) {
    $stdout.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$manager = Await ($managerType::RequestAsync()) $managerType

# Команды читаем в фоновом потоке, чтобы основной цикл не блокировался на ReadLine
$commands = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$input_ = [hashtable]::Synchronized(@{ closed = $false })   # stdin закрыт — родитель завершился
$reader = [powershell]::Create()
$reader.Runspace = [runspacefactory]::CreateRunspace()
$reader.Runspace.Open()
$reader.Runspace.SessionStateProxy.SetVariable('commands', $commands)
$reader.Runspace.SessionStateProxy.SetVariable('input_', $input_)
[void]$reader.AddScript({
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        $commands.Enqueue($line)
    }
    $input_.closed = $true
}).BeginInvoke()

$thumbCache = @{}   # session id -> ключ трека, для которого миниатюра уже отправлена
$lastJson = ''

[void][Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
# PowerShell не видит WinRT-поток как IInputStream, поэтому AsStreamForRead вызываем через рефлексию
$asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IInputStream'
} | Select-Object -First 1

function Get-Thumbnail($props) {
    try {
        if ($null -eq $props.Thumbnail) { return $null }
        $ras = Await ($props.Thumbnail.OpenReadAsync()) $streamType
        $net = $asStreamForRead.Invoke($null, @($ras))
        $ms = New-Object System.IO.MemoryStream
        $net.CopyTo($ms)
        $bytes = $ms.ToArray()
        if ($bytes.Length -lt 8) { return $null }
        # ContentType у потока недоступен, определяем формат по сигнатуре
        $mime = if ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { 'image/jpeg' }
                elseif ($bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49) { 'image/webp' }
                else { 'image/png' }
        "data:$mime;base64," + [Convert]::ToBase64String($bytes)
    } catch { $null }
}

function Run-Command($line) {
    try {
        $c = $line | ConvertFrom-Json
        $session = $manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -eq $c.session } | Select-Object -First 1
        if ($null -eq $session) { $session = $manager.GetCurrentSession() }
        if ($null -eq $session) { return }
        $op = switch ($c.cmd) {
            'playpause' { $session.TryTogglePlayPauseAsync() }
            'play'      { $session.TryPlayAsync() }
            'pause'     { $session.TryPauseAsync() }
            'next'      { $session.TrySkipNextAsync() }
            'prev'      { $session.TrySkipPreviousAsync() }
        }
        if ($op) { [void](Await $op ([bool])) }
    } catch { }
}

while (-not $input_.closed) {
    $line = $null
    while ($commands.TryDequeue([ref]$line)) { Run-Command $line }

    $list = @()
    $current = $manager.GetCurrentSession()
    $currentId = if ($current) { $current.SourceAppUserModelId } else { $null }

    foreach ($s in $manager.GetSessions()) {
        try {
            $id = $s.SourceAppUserModelId
            $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $info = $s.GetPlaybackInfo()
            $tl = $s.GetTimelineProperties()
            $status = $info.PlaybackStatus.ToString()

            # Позиция «на сейчас»: LastUpdatedTime фиксирует момент, когда плеер сообщил Position
            $pos = $tl.Position.TotalSeconds
            if ($status -eq 'Playing') {
                $rate = if ($info.PlaybackRate) { [double]$info.PlaybackRate } else { 1.0 }
                $pos += ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds * $rate
            }
            $dur = ($tl.EndTime - $tl.StartTime).TotalSeconds
            if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
            if ($pos -lt 0) { $pos = 0 }

            $trackKey = "$id|$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
            if ($thumbCache[$id] -ne $trackKey) {
                $thumbCache[$id] = $trackKey
                $data = Get-Thumbnail $props
                if ($data) { Send @{ type = 'thumb'; key = $trackKey; data = $data } }
            }

            $list += @{
                id = $id; app = $id; status = $status
                title = $props.Title; artist = $props.Artist; album = $props.AlbumTitle
                pos = [math]::Round($pos, 1); dur = [math]::Round($dur, 1)
                thumbKey = $trackKey
                canPlayPause = $info.Controls.IsPlayPauseToggleEnabled
                canNext = $info.Controls.IsNextEnabled
                canPrev = $info.Controls.IsPreviousEnabled
            }
        } catch { }
    }

    $state = @{ type = 'state'; current = $currentId; sessions = $list }
    # Позиция меняется каждую секунду, пока играет трек; в паузе шлём только реальные изменения
    $json = $state | ConvertTo-Json -Compress -Depth 6
    $anyPlaying = @($list | Where-Object { $_.status -eq 'Playing' }).Count -gt 0
    if ($anyPlaying -or $json -ne $lastJson) {
        $stdout.WriteLine($json)
        $lastJson = $json
    }

    Start-Sleep -Milliseconds 1000
}
