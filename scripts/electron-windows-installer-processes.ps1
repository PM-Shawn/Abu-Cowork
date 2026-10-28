param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
$env:TEMP = Join-Path (Resolve-Path .agent).Path 'build-temp'
$env:TMP = $env:TEMP
$location = (Get-ItemProperty 'HKCU:\Software\89f944a7-c4f6-5020-b650-13bcfb65019c').InstallLocation
$expected = Join-Path (Resolve-Path .agent).Path "acceptance\阿布 O'Brien Install"
if ($location -ne $expected) { throw 'Unexpected test installation location.' }
if ([IO.Path]::GetFileName($Installer) -ne 'AbuInstallerTest-0.60.0-windows-x64-setup.exe') {
  throw 'Use the isolated AbuInstallerTest installer.'
}
$sibling = "${location}Sibling"
New-Item -ItemType Directory -Path $sibling -Force | Out-Null
$command = Join-Path $sibling 'cmd.exe'
Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\cmd.exe') -Destination $command
$siblingProcess = Start-Process -FilePath $command -ArgumentList '/c', 'ping -n 180 127.0.0.1 >nul' -WindowStyle Hidden -PassThru
try {
  $update = Start-Process -FilePath $Installer -ArgumentList '--updated' -PassThru -Wait
  if ($update.ExitCode -ne 0) { throw "Update failed with $($update.ExitCode)." }
  $siblingProcess.Refresh()
  if ($siblingProcess.HasExited) { throw 'The unrelated sibling process was terminated.' }
  Write-Output 'Update preserved the unrelated sibling process.'
} finally {
  $siblingProcess.Refresh()
  if (-not $siblingProcess.HasExited) { Stop-Process -Id $siblingProcess.Id }
}

$command = Join-Path $location 'abu-process-check.exe'
Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\cmd.exe') -Destination $command
$appProcess = Start-Process -FilePath $command -ArgumentList '/c', 'ping -n 180 127.0.0.1 >nul' -WindowStyle Hidden -PassThru
try {
  $update = Start-Process -FilePath $Installer -ArgumentList '--updated' -PassThru -Wait
  if ($update.ExitCode -ne 2) { throw "Expected the running process to block the update; got $($update.ExitCode)." }
  $appProcess.Refresh()
  if ($appProcess.HasExited) { throw 'The running process was terminated.' }
  if (-not (Test-Path -LiteralPath (Join-Path $location 'AbuInstallerTest.exe'))) {
    throw 'The installed application was modified while the process was running.'
  }
  Write-Output 'A running process inside the installation prevented the update.'
} finally {
  $appProcess.Refresh()
  if (-not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id }
}
