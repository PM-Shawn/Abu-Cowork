param([Parameter(Mandatory = $true)][ValidateSet('Begin', 'Extract', 'Promote', 'Commit', 'Recover')][string]$Action)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -Force
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1') -Force
Import-Module (Join-Path $PSHOME 'Modules\CimCmdlets\CimCmdlets.psd1') -Force
$target = [IO.Path]::GetFullPath($env:ABU_INSTALLER_DIRECTORY).TrimEnd('\')
$transaction = $target + '.abu-update'
$stage = Join-Path $transaction 'new'
$backup = Join-Path $transaction 'old'
$failed = Join-Path $transaction 'failed'
$recordPath = Join-Path $transaction 'record.json'
$identity = $env:ABU_INSTALLER_ID
$executable = $env:ABU_INSTALLER_EXE
$uninstaller = $env:ABU_INSTALLER_UNINSTALLER
$registryPaths = @($env:ABU_INSTALLER_REGISTRY, $env:ABU_INSTALLER_UNINSTALL_KEY)
$lock = $null
$committedThisRun = $false
$failureCode = 2

function Assert-Path([string]$path) {
  $cursor = [IO.Path]::GetFullPath($path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -Force -LiteralPath $cursor
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked path: $cursor" }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}

function Assert-Tree([string]$path) {
  Assert-Path $path
  if (-not [IO.Directory]::Exists($path)) { return }
  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($path)
  while ($pending.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked entry: $($item.FullName)" }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
}

function Write-Record([string]$path, $value) {
  Assert-Path $path
  Assert-Path ($path + '.pending')
  $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 15 -Compress))
  $stream = [IO.FileStream]::new($path + '.pending', [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  [IO.File]::Move($path + '.pending', $path)
}

function Read-Record([string]$path) {
  Assert-Path $path
  return [IO.File]::ReadAllText($path) | ConvertFrom-Json
}

function Get-ApplicationHashes([string]$directory) {
  $hashes = @{}
  foreach ($relative in @($executable, 'resources\app.asar', $uninstaller)) {
    $path = Join-Path $directory $relative
    Assert-Path $path
    if (-not [IO.File]::Exists($path) -or (Get-Item -LiteralPath $path).Length -eq 0) { throw "Incomplete application: $path" }
    $stream = [IO.File]::OpenRead($path)
    try {
      $algorithm = [Security.Cryptography.SHA256]::Create()
      try { $hashes[$relative] = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
      finally { $algorithm.Dispose() }
    } finally { $stream.Dispose() }
  }
  return $hashes
}

function Assert-Application([string]$directory, $hashes) {
  $actual = Get-ApplicationHashes $directory
  foreach ($relative in @($executable, 'resources\app.asar', $uninstaller)) {
    if ($actual[$relative] -ne $hashes.$relative) { throw "Application changed: $directory\$relative" }
  }
}

function Assert-PreparedApplication {
  $manifest = Read-Record (Join-Path $stage 'resources\abu-install-manifest.json')
  if ($manifest.schema -ne 1 -or @($manifest.files).Count -eq 0) { throw 'Invalid application file list.' }
  foreach ($file in $manifest.files) {
    if ([IO.Path]::IsPathRooted($file.path) -or $file.path -match '(^|[/\\])\.\.([/\\]|$)' -or $file.path.Contains(':')) { throw 'Invalid application file path.' }
    $path = [IO.Path]::GetFullPath((Join-Path $stage $file.path))
    if (-not $path.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Application file is outside its directory.' }
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer -or ($file.signed -and $item.Length -eq 0) -or
        (-not $file.signed -and $item.Length -ne $file.size)) { throw "Incomplete application file: $($file.path)" }
  }
}

function Invoke-Archive([string]$arguments) {
  $start = [Diagnostics.ProcessStartInfo]::new($env:ABU_INSTALLER_EXTRACTOR)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Arguments = $arguments
  $process = [Diagnostics.Process]::Start($start)
  try {
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [IO.File]::AppendAllText((Join-Path $transaction 'extract.log'), $output.GetAwaiter().GetResult() + $errors.GetAwaiter().GetResult())
    return $process.ExitCode
  } finally { $process.Dispose() }
}

function Assert-Stopped {
  foreach ($process in Get-CimInstance -ClassName Win32_Process) {
    if ($process.ExecutablePath -and
        ($process.ExecutablePath.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or
         $process.ExecutablePath.StartsWith($transaction + '\', [StringComparison]::OrdinalIgnoreCase))) {
      throw "Application is running: $($process.ProcessId)"
    }
  }
}

function Assert-FreeSpace {
  $required = @{}
  $allocations = @(@{ Path = $target; Bytes = ([long]$env:ABU_INSTALLER_UNPACKED_KB * 1024 + 64MB) })
  if ($env:ABU_INSTALLER_SOURCE) {
    $size = (Get-Item -LiteralPath $env:ABU_INSTALLER_SOURCE).Length
    $allocations += @{ Path = $PSScriptRoot; Bytes = $size }
    $allocations += @{ Path = $env:ABU_INSTALLER_CACHE; Bytes = $size }
  }
  foreach ($allocation in $allocations) {
    $drive = [IO.Path]::GetPathRoot($allocation.Path)
    if (-not $required.ContainsKey($drive)) { $required[$drive] = [long]0 }
    $required[$drive] += $allocation.Bytes
  }
  foreach ($drive in $required.Keys) {
    if ([IO.DriveInfo]::new($drive).AvailableFreeSpace -lt $required[$drive]) { throw "Not enough free space on $drive" }
  }
}

function Get-RegistrySnapshot([string]$path) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
  $values = @()
  if ($key) {
    try {
      foreach ($name in $key.GetValueNames()) {
        $values += @{ Name = $name; Kind = $key.GetValueKind($name).ToString(); Value = $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames') }
      }
    } finally { $key.Dispose() }
  }
  return @{ Path = $path; Exists = ($null -ne $key); Values = $values }
}

function Assert-Link([string]$path) {
  Assert-Path $path
  $full = [IO.Path]::GetFullPath($path)
  if ([IO.Path]::GetExtension($full) -ne '.lnk') { throw "Invalid shortcut: $path" }
  foreach ($folder in @('DesktopDirectory', 'Programs')) {
    $root = [Environment]::GetFolderPath($folder).TrimEnd('\') + '\'
    if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return }
  }
  throw "Shortcut outside the current user's folders: $path"
}

function Restore-Metadata($record) {
  foreach ($snapshot in $record.Registry) {
    if ($snapshot.Path -notin $registryPaths) { throw 'Unexpected registration in update record.' }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($snapshot.Path)
    try {
      foreach ($name in $key.GetValueNames()) { $key.DeleteValue($name) }
      foreach ($value in $snapshot.Values) {
        $data = $value.Value
        switch ($value.Kind) {
          'DWord' { $data = [int]$data }
          'QWord' { $data = [long]$data }
          'Binary' { $data = [byte[]]$data }
          'MultiString' { $data = [string[]]$data }
        }
        $key.SetValue($value.Name, $data, [Microsoft.Win32.RegistryValueKind]$value.Kind)
      }
      $key.Flush()
    } finally { $key.Dispose() }
    if (-not $snapshot.Exists) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($snapshot.Path, $false) }
  }
  foreach ($link in $record.Links) {
    Assert-Link $link.Path
    if ($link.Exists) {
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($link.Path)) | Out-Null
      [IO.File]::WriteAllBytes($link.Path, [Convert]::FromBase64String($link.Content))
    } elseif ([IO.File]::Exists($link.Path)) {
      [IO.File]::Delete($link.Path)
    }
  }
}

function Get-CachePaths($record) {
  if (-not $record.Cache) { return $null }
  if ($record.Transaction -notmatch '^[a-f0-9]{32}$') { throw 'Invalid update identifier.' }
  $path = $record.Cache.Path
  if ($path -ne $env:ABU_INSTALLER_CACHE -or [IO.Path]::GetFileName($path) -ne 'installer.exe' -or
      -not $path.StartsWith([Environment]::GetFolderPath('LocalApplicationData') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installer cache location.' }
  $prefix = Join-Path ([IO.Path]::GetDirectoryName($path)) ('.abu-' + $record.Transaction)
  $paths = @{ Current = $path; New = $prefix + '.new'; Old = $prefix + '.old'; Blockmap = Join-Path ([IO.Path]::GetDirectoryName($path)) 'current.blockmap' }
  $cacheDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path))
  foreach ($entry in $paths.Values) {
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($entry)) -ne $cacheDirectory) { throw 'Update cache file is outside its directory.' }
    Assert-Path $entry
  }
  return $paths
}

function Restore-Cache($record) {
  $paths = Get-CachePaths $record
  if (-not $paths) { return }
  if ([IO.File]::Exists($paths.Old)) {
    if ((Get-FileHash -LiteralPath $paths.Old).Hash -ne $record.Cache.OldHash) { throw 'The previous installer cache changed.' }
    if ([IO.File]::Exists($paths.Current)) {
      if ((Get-FileHash -LiteralPath $paths.Current).Hash -ne $record.Cache.NewHash) { throw 'The installer cache contains an unknown file.' }
      [IO.File]::Delete($paths.Current)
    }
    [IO.File]::Move($paths.Old, $paths.Current)
  } elseif ($record.Cache.HadOld) {
    if (-not [IO.File]::Exists($paths.Current) -or (Get-FileHash -LiteralPath $paths.Current).Hash -ne $record.Cache.OldHash) { throw 'The previous installer cache cannot be restored.' }
  } elseif ([IO.File]::Exists($paths.Current)) {
    if ((Get-FileHash -LiteralPath $paths.Current).Hash -ne $record.Cache.NewHash) { throw 'The installer cache contains an unknown file.' }
    [IO.File]::Delete($paths.Current)
  }
  [IO.File]::Delete($paths.New)
  # electron-updater may have copied the new blockmap before starting this installer.
  [IO.File]::Delete($paths.Blockmap)
}

function Remove-CacheBackup($record) {
  $paths = Get-CachePaths $record
  if (-not $paths) { return }
  [IO.File]::Delete($paths.Old)
  [IO.File]::Delete($paths.New)
}

function Remove-Transaction {
  Assert-Tree $transaction
  foreach ($directory in @($backup, $stage, $failed)) {
    if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory, $true) }
  }
  # The durable record survives interrupted cleanup until all application copies are handled.
  foreach ($name in @('extract.log', 'ready.json', 'ready.json.pending', 'committed.json.pending', 'record.json.pending')) {
    [IO.File]::Delete((Join-Path $transaction $name))
  }
  [IO.File]::Delete($recordPath)
  [IO.File]::Delete((Join-Path $transaction 'committed.json'))
  [IO.Directory]::Delete($transaction, $false)
}

function Read-Transaction {
  $record = Read-Record $recordPath
  if ($record.Schema -ne 1 -or $record.Target -ne $target -or $record.Identity -ne $identity -or
      $record.Transaction -notmatch '^[a-f0-9]{32}$' -or
      $record.Executable -ne $executable -or $record.Uninstaller -ne $uninstaller) { throw 'Update record does not match this installation.' }
  if (@($record.Registry).Count -ne 2 -or $record.Registry[0].Path -ne $registryPaths[0] -or
      $record.Registry[1].Path -ne $registryPaths[1]) { throw 'Update registration does not match this installation.' }
  foreach ($link in $record.Links) { Assert-Link $link.Path }
  return $record
}

function Recover-Installation {
  if (-not [IO.Directory]::Exists($transaction)) { return }
  Assert-Tree $transaction
  $committed = Join-Path $transaction 'committed.json'
  if (-not [IO.File]::Exists($recordPath)) {
    if ([IO.Directory]::GetFileSystemEntries($transaction).Count -eq 0) { [IO.Directory]::Delete($transaction); return }
    # Cleanup can be interrupted after removing the record; no application copies may remain.
    if ([IO.Directory]::GetFileSystemEntries($transaction).Count -eq 1 -and [IO.File]::Exists($committed)) {
      $proof = Read-Record $committed
      if ($proof.Identity -ne $identity -or $proof.Target -ne $target) { throw 'Unrecognized completed update.' }
      Assert-Application $target $proof.Hashes
      [IO.File]::Delete($committed)
      [IO.Directory]::Delete($transaction)
      return
    }
    throw 'An incomplete update record requires manual inspection.'
  }
  $record = Read-Transaction
  Assert-Stopped
  if ([IO.File]::Exists($committed)) {
    $proof = Read-Record $committed
    if ($proof.Identity -ne $identity -or $proof.Target -ne $target) { throw 'Invalid completed update record.' }
    Assert-Application $target $proof.Hashes
    Remove-CacheBackup $record
    Remove-Transaction
    return
  }
  if ($record.HadOld) {
    if ([IO.Directory]::Exists($backup)) {
      Assert-Application $backup $record.OldHashes
      if ([IO.Directory]::Exists($target)) {
        if ([IO.Directory]::GetFileSystemEntries($target).Count -eq 0) { [IO.Directory]::Delete($target) }
        else {
          $marker = Read-Record (Join-Path $target '.abu-installation.json')
          if ($marker.Transaction -ne $record.Transaction) { throw 'The destination contains unrecognized files.' }
          [IO.Directory]::Move($target, $failed)
        }
      }
      [IO.Directory]::Move($backup, $target)
    }
    Assert-Application $target $record.OldHashes
  } elseif ([IO.Directory]::Exists($target) -and [IO.Directory]::GetFileSystemEntries($target).Count -gt 0) {
    $marker = Read-Record (Join-Path $target '.abu-installation.json')
    if ($marker.Transaction -ne $record.Transaction) { throw 'The destination contains unrecognized files.' }
    [IO.Directory]::Move($target, $failed)
  }
  Restore-Metadata $record
  Restore-Cache $record
  Remove-Transaction
}

try {
  if (-not $env:ABU_INSTALLER_DIRECTORY -or $target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\') -or
      $target -notmatch '^[A-Za-z]:\\' -or $identity -notmatch '^[A-Za-z0-9.{}-]+$' -or
      [IO.Path]::GetFileName($executable) -ne $executable -or [IO.Path]::GetFileName($uninstaller) -ne $uninstaller -or
      $registryPaths[0] -notmatch '^Software\\[^\\]+$' -or
      $registryPaths[1] -notmatch '^Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^\\]+$') { throw 'Invalid installer identity or location.' }
  Assert-Path $target
  Assert-Path $transaction
  Assert-Path ($target + '.abu-update.lock')
  Assert-Path ($target + '.abu-install.log')
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
  $lock = [IO.File]::Open($target + '.abu-update.lock', 'OpenOrCreate', 'ReadWrite', 'None')
  Set-Location ([IO.Path]::GetDirectoryName($target))
  if ($Action -eq 'Recover') { Recover-Installation; exit 0 }
  if ($Action -eq 'Begin') {
    Recover-Installation
    Assert-Stopped
    Assert-FreeSpace
    $registered = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPaths[0])
    $previous = $null
    if ($registered) { try { $previous = $registered.GetValue('InstallLocation') } finally { $registered.Dispose() } }
    if ($previous -and [IO.Path]::GetFullPath($previous).TrimEnd('\') -ne $target) { throw 'Updates must use the registered installation location.' }
    $hadOld = [IO.File]::Exists((Join-Path $target $executable))
    if ($hadOld -and -not $previous) { throw 'The existing application is not registered.' }
    if (-not $hadOld -and [IO.Directory]::Exists($target) -and [IO.Directory]::GetFileSystemEntries($target).Count) { throw 'The installation directory is not empty.' }
    Assert-Tree $target
    $oldHashes = if ($hadOld) { Get-ApplicationHashes $target } else { $null }
    $links = @()
    $linkPaths = @($env:ABU_INSTALLER_LINKS | ConvertFrom-Json)
    foreach ($index in 0..3) { $linkPaths += [Environment]::GetEnvironmentVariable("ABU_INSTALLER_LINK_$index") }
    foreach ($path in $linkPaths | Select-Object -Unique) {
      if (-not $path) { continue }
      Assert-Link $path
      $exists = [IO.File]::Exists($path)
      $links += @{ Path = $path; Exists = $exists; Content = $(if ($exists) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) } else { '' }) }
    }
    $cache = $null
    if ($env:ABU_INSTALLER_CACHE) {
      Assert-Path $env:ABU_INSTALLER_CACHE
      $cacheExists = [IO.File]::Exists($env:ABU_INSTALLER_CACHE)
      $cache = @{ Path = $env:ABU_INSTALLER_CACHE; HadOld = $cacheExists;
        OldHash = $(if ($cacheExists) { (Get-FileHash -LiteralPath $env:ABU_INSTALLER_CACHE).Hash } else { '' });
        NewHash = (Get-FileHash -LiteralPath $env:ABU_INSTALLER_SOURCE).Hash }
    }
    $record = @{ Schema = 1; Identity = $identity; Target = $target; Executable = $executable; Uninstaller = $uninstaller;
      Transaction = [guid]::NewGuid().ToString('N'); HadOld = $hadOld; OldHashes = $oldHashes;
      Registry = @((Get-RegistrySnapshot $registryPaths[0]), (Get-RegistrySnapshot $registryPaths[1])); Links = $links; Cache = $cache }
    $null = Get-CachePaths ([pscustomobject]$record)
    [IO.Directory]::CreateDirectory($transaction) | Out-Null
    Write-Record $recordPath $record
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    Write-Record (Join-Path $stage '.abu-installation.json') @{ Identity = $identity; Transaction = $record.Transaction }
    exit 0
  }
  $record = Read-Transaction
  if ($Action -eq 'Extract') {
    Add-Type -Path (Join-Path $PSScriptRoot 'abu-installer-job.cs') -ReferencedAssemblies ([ComponentModel.Win32Exception].Assembly.Location)
    [AbuInstallerJob]::ProtectExtraction()
    Assert-Tree $stage
    $paths = Get-CachePaths $record
    if ($paths) {
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($paths.New)) | Out-Null
      [IO.File]::Copy($env:ABU_INSTALLER_SOURCE, $paths.New, $false)
      if ((Get-FileHash -LiteralPath $paths.New).Hash -ne $record.Cache.NewHash) { throw 'The installer cache copy could not be verified.' }
    }
    $archive = $env:ABU_INSTALLER_ARCHIVE
    $readable = [IO.File]::OpenRead($archive)
    $readable.Dispose()
    $archiveResult = Invoke-Archive ('t -bd -- "' + $archive + '"')
    if ($archiveResult -ne 0) {
      if ($archiveResult -eq 2) { $failureCode = 20 }
      throw "Archive verification failed with exit code $archiveResult."
    }
    $archiveResult = Invoke-Archive ('x -y -bd -o"' + $stage + '" -- "' + $archive + '"')
    [AbuInstallerJob]::CompleteExtraction()
    if ($archiveResult -ne 0) {
      throw "Archive extraction failed with exit code $archiveResult."
    }
    Assert-Tree $stage
    exit 0
  }
  Assert-Stopped
  if ($Action -eq 'Promote') {
    Assert-Tree $stage
    Assert-Tree $target
    $failureCode = 20
    Assert-PreparedApplication
    $failureCode = 2
    $hashes = Get-ApplicationHashes $stage
    $marker = Read-Record (Join-Path $stage '.abu-installation.json')
    if ($marker.Transaction -ne $record.Transaction) { throw 'The prepared directory does not belong to this update.' }
    Write-Record (Join-Path $transaction 'ready.json') $hashes
    if ($record.HadOld) {
      Assert-Application $target $record.OldHashes
      [IO.Directory]::Move($target, $backup)
    } elseif ([IO.Directory]::Exists($target)) {
      [IO.Directory]::Delete($target, $false)
    }
    [IO.Directory]::Move($stage, $target)
    Assert-Application $target ([pscustomobject]$hashes)
    exit 0
  }
  if ($Action -eq 'Commit') {
    $hashes = Read-Record (Join-Path $transaction 'ready.json')
    Assert-Application $target $hashes
    $installKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPaths[0])
    $uninstallKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($registryPaths[1])
    try {
      if (-not $installKey -or -not $uninstallKey -or $installKey.GetValue('InstallLocation') -ne $target -or
          $uninstallKey.GetValue('DisplayVersion') -ne $env:ABU_INSTALLER_VERSION -or
          $uninstallKey.GetValue('UninstallString') -ne ('"' + (Join-Path $target $uninstaller) + '" /currentuser')) { throw 'Installation registration could not be verified.' }
      $installKey.Flush(); $uninstallKey.Flush()
    } finally {
      if ($installKey) { $installKey.Dispose() }
      if ($uninstallKey) { $uninstallKey.Dispose() }
    }
    $shell = New-Object -ComObject WScript.Shell
    foreach ($index in 0..1) {
      if ($index -eq 1 -and $env:ABU_INSTALLER_NO_DESKTOP -eq 'true') { continue }
      $path = [Environment]::GetEnvironmentVariable("ABU_INSTALLER_LINK_$index")
      if (-not $path) { continue }
      $oldPath = [Environment]::GetEnvironmentVariable('ABU_INSTALLER_LINK_' + ($index + 2))
      $previousLinks = @($record.Links | Where-Object { $_.Path -eq $path -or $_.Path -eq $oldPath })
      Assert-Link $path
      if (-not [IO.File]::Exists($path)) {
        if ($env:ABU_INSTALLER_KEEP_SHORTCUTS -ne 'true' -or @($previousLinks | Where-Object { $_.Exists }).Count -gt 0) { throw "Shortcut was not created: $path" }
        continue
      }
      # Existing shortcuts retain user-selected arguments, targets and working directories.
      if ($env:ABU_INSTALLER_KEEP_SHORTCUTS -eq 'true' -and @($previousLinks | Where-Object { $_.Exists }).Count -gt 0) { continue }
      $shortcut = $shell.CreateShortcut($path)
      if ($shortcut.TargetPath -ne (Join-Path $target $executable) -or $shortcut.WorkingDirectory -ne $target) { throw "Shortcut target could not be verified: $path" }
    }
    $paths = Get-CachePaths $record
    if ($paths) {
      if ((Get-FileHash -LiteralPath $paths.New).Hash -ne $record.Cache.NewHash) { throw 'The prepared installer cache changed.' }
      if ($record.Cache.HadOld) {
        if ((Get-FileHash -LiteralPath $paths.Current).Hash -ne $record.Cache.OldHash) { throw 'The previous installer cache changed.' }
        [IO.File]::Move($paths.Current, $paths.Old)
      }
      [IO.File]::Move($paths.New, $paths.Current)
    }
    Write-Record (Join-Path $transaction 'committed.json') @{ Identity = $identity; Target = $target; Hashes = $hashes }
    $committedThisRun = $true
    Remove-CacheBackup $record
    Remove-Transaction
  }
  exit 0
} catch {
  $nativeError = $_.Exception.GetBaseException().HResult -band 0xFFFF
  if ($nativeError -in @(32, 33)) { $failureCode = 21 }
  $message = "$Action failed: $($_.Exception.Message)"
  [Console]::Error.WriteLine($message)
  # Keep the complete transaction for Recover; a failed restore must never erase its backup.
  try {
    Assert-Path ($target + '.abu-install.log')
    [IO.File]::AppendAllText($target + '.abu-install.log', $message + [Environment]::NewLine, [Text.Encoding]::UTF8)
  } catch { [Console]::Error.WriteLine('The installation log could not be written.') }
  if ($committedThisRun) { exit 3 }
  exit $failureCode
} finally {
  if ($lock) { $lock.Dispose() }
}
