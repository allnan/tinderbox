param(
    [Parameter(Mandatory)] [string]$BundleDirectory,
    [Parameter(Mandatory)] [string]$InstallDirectory
)

$ErrorActionPreference = 'Stop'
$bundle = (Resolve-Path -LiteralPath $BundleDirectory).Path.TrimEnd('\')
$target = (Resolve-Path -LiteralPath $InstallDirectory).Path.TrimEnd('\')
if ($target -eq $bundle -or $target.Length -le 2) {
    throw '请选择独立的便携应用目录。'
}

$exe = 'endfield_resources_tools.exe'
$targetExe = Join-Path $target $exe
$programFiles = @(
    foreach ($name in $exe,'使用说明.md','换算与记录规则.md') {
        Get-Item -LiteralPath (Join-Path $bundle $name)
    }
    Get-ChildItem -LiteralPath $bundle -Filter '*.dll' -File
    Get-ChildItem -LiteralPath (Join-Path $bundle 'data') -Recurse -File
)
if ($programFiles.Name -notcontains 'flutter_windows.dll' -or $programFiles.Name -match '^endfield_resources\.json(?:$|\.)') {
    throw '发布目录的程序文件不完整，或程序资源目录中包含账本文件。'
}

$lock = [Threading.Mutex]::new($false, 'Local\EndfieldPortableInstall')
$locked = $false
try {
    try { $locked = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw '另一个便携版更新正在进行。' }

    $changes = @(foreach ($file in $programFiles) {
        if (-not $file.FullName.StartsWith("$bundle\", [StringComparison]::OrdinalIgnoreCase)) {
            throw '程序文件不在发布目录内。'
        }
        $relative = $file.FullName.Substring($bundle.Length + 1)
        $destination = [IO.Path]::GetFullPath((Join-Path $target $relative))
        if (-not $destination.StartsWith("$target\", [StringComparison]::OrdinalIgnoreCase)) {
            throw '程序文件路径超出指定便携目录。'
        }
        for ($path = $destination; $path.Length -ge $target.Length; $path = Split-Path -LiteralPath $path) {
            $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "便携目录中的路径为链接：$path"
            }
            if ($item -and $item.PSIsContainer -eq ($path -eq $destination)) {
                throw "便携目录中的文件与目录重名：$path"
            }
        }
        $sourceHash = (Get-FileHash -LiteralPath $file.FullName).Hash
        $exists = Test-Path -LiteralPath $destination -PathType Leaf
        if (-not $exists -or (Get-FileHash -LiteralPath $destination).Hash -ne $sourceHash) {
            [pscustomobject]@{ Source = $file.FullName; Path = $destination; Relative = $relative; Exists = $exists; Hash = $sourceHash }
        }
    })
    if ($changes.Count -eq 0) { Write-Output "便携版已是同一构建：$target"; return }
    if (Get-Process -Name 'endfield_resources_tools' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $targetExe }) {
        throw "请先关闭正在运行的便携账本，再安装：$target"
    }

    # Change this gate only after validating the new reader and migration on copies of older ledgers.
    $historySource = Join-Path $PSScriptRoot '..\lib\resource_history.dart'
    $versionMatch = [regex]::Match((Get-Content -LiteralPath $historySource -Raw), 'static const schemaVersion = (\d+);')
    foreach ($name in 'endfield_resources.json','endfield_resources.json.bak') {
        $path = Join-Path $target $name
        if (-not (Test-Path -LiteralPath $path)) { continue }
        try { $ledger = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch {
            throw "无法读取 $name。请先核对账本备份。"
        }
        if ($versionMatch.Groups[1].Value -ne '2' -or $ledger.schemaVersion -notin 1,2 -or $ledger.records -isnot [array]) {
            throw "账本格式需要先验证迁移：$name。已保留原程序和数据。"
        }
    }

    $temp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd('\')
    $backup = Join-Path $temp ('endfield-update-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup | Out-Null
    $written = [Collections.Generic.List[object]]::new()
    $keepBackup = $false
    try {
        foreach ($change in $changes | Where-Object Exists) {
            $copy = Join-Path $backup $change.Relative
            [IO.Directory]::CreateDirectory((Split-Path -LiteralPath $copy)) | Out-Null
            Copy-Item -LiteralPath $change.Path -Destination $copy
        }
        foreach ($change in $changes | Sort-Object { $_.Relative -eq $exe }) {
            [IO.Directory]::CreateDirectory((Split-Path -LiteralPath $change.Path)) | Out-Null
            $written.Add($change)
            Copy-Item -LiteralPath $change.Source -Destination $change.Path -Force
            if ((Get-FileHash -LiteralPath $change.Path).Hash -ne $change.Hash) { throw "校验失败：$($change.Relative)" }
        }
    } catch {
        try {
            foreach ($change in $written) {
                if ($change.Exists) {
                    Copy-Item -LiteralPath (Join-Path $backup $change.Relative) -Destination $change.Path -Force
                } elseif (Test-Path -LiteralPath $change.Path -PathType Leaf) {
                    Remove-Item -LiteralPath $change.Path -Force
                }
            }
        } catch {
            $keepBackup = $true
            throw "安装回退未完成。原程序文件备份：$backup"
        }
        throw
    } finally {
        $resolved = (Resolve-Path -LiteralPath $backup).Path
        if (-not $keepBackup -and [IO.Path]::GetDirectoryName($resolved) -eq $temp -and
            [IO.Path]::GetFileName($resolved) -match '^endfield-update-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
    Write-Output "Windows 便携版已更新：$target"
} finally {
    if ($locked) { $lock.ReleaseMutex() }
    $lock.Dispose()
}
