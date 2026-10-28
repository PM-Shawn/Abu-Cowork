param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
$agent = (Resolve-Path .agent).Path
$env:TEMP = Join-Path $agent 'build-temp'
$env:TMP = $env:TEMP
$destination = Join-Path $agent "acceptance\阿布 O'Brien Install"
$registry = 'HKCU:\Software\89f944a7-c4f6-5020-b650-13bcfb65019c'
if ((Get-ItemProperty $registry).InstallLocation -ne $destination -or
    [IO.Path]::GetFileName($Installer) -ne 'AbuInstallerTest-0.60.0-windows-x64-setup.exe') { throw 'Use the isolated installation and installer.' }
$appFile = Join-Path $destination 'resources\app.asar'
$originalHash = (Get-FileHash -LiteralPath $appFile).Hash

function Wait-Extraction([Diagnostics.Process]$installerProcess) {
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    $helpers = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($installerProcess.Id)" |
      Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*-Action Extract*' })
    foreach ($helper in $helpers) {
      $extractors = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($helper.ProcessId)" | Where-Object { $_.Name -eq '7za.exe' -and $_.CommandLine -match '\sx\s' })
      if ($extractors.Count) { return @{ Helper = [Diagnostics.Process]::GetProcessById($helper.ProcessId); Extractor = [Diagnostics.Process]::GetProcessById($extractors[0].ProcessId) } }
    }
    if ($installerProcess.HasExited) { throw "The installer exited before extraction: $($installerProcess.ExitCode)" }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Extraction did not start.'
}

function Assert-PreviousApplication {
  if ((Get-FileHash -LiteralPath $appFile).Hash -ne $originalHash) { throw 'The interrupted update changed the previous application.' }
  if ((Get-ItemProperty $registry).InstallLocation -ne $destination) { throw 'The interrupted update changed its registration.' }
}

$process = Start-Process -FilePath $Installer -ArgumentList '--updated' -PassThru
try {
  $extraction = Wait-Extraction $process
  Stop-Process -Id $extraction.Helper.Id
  if (-not $extraction.Extractor.WaitForExit(10000)) { throw 'The extraction process survived its owning helper.' }
  if (-not $process.WaitForExit(120000) -or $process.ExitCode -ne 2) { throw 'A terminated extraction did not fail the update.' }
  Assert-PreviousApplication
  if (Test-Path -LiteralPath ($destination + '.abu-update')) { throw 'A failed extraction was not recovered.' }
  Write-Output 'Terminated extraction returned failure and preserved the previous installation.'
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
}

$process = Start-Process -FilePath $Installer -ArgumentList '--updated' -PassThru
try {
  $extraction = Wait-Extraction $process
  Stop-Process -Id $process.Id
  if (-not $extraction.Helper.WaitForExit(120000)) { throw 'The prepared extraction did not finish.' }
  Assert-PreviousApplication
  $retry = Start-Process -FilePath $Installer -ArgumentList '--updated' -PassThru
  if (-not $retry.WaitForExit(240000) -or $retry.ExitCode -ne 0) { throw 'Restarting the interrupted installer did not complete the update.' }
  if (Test-Path -LiteralPath ($destination + '.abu-update')) { throw 'Restarting the installer left an unfinished update.' }
  Write-Output 'Restarting the installer recovered the interrupted update.'
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
}

$env:ABU_INSTALLER_DIRECTORY = $destination
$env:ABU_INSTALLER_ID = '89f944a7-c4f6-5020-b650-13bcfb65019c'
$env:ABU_INSTALLER_EXE = 'AbuInstallerTest.exe'
$env:ABU_INSTALLER_UNINSTALLER = 'Uninstall AbuInstallerTest.exe'
$env:ABU_INSTALLER_VERSION = '0.60.0'
$env:ABU_INSTALLER_REGISTRY = 'Software\89f944a7-c4f6-5020-b650-13bcfb65019c'
$env:ABU_INSTALLER_UNINSTALL_KEY = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\89f944a7-c4f6-5020-b650-13bcfb65019c'
$env:ABU_INSTALLER_LINKS = '[]'
$env:ABU_INSTALLER_SOURCE = $null
$env:ABU_INSTALLER_CACHE = $null
$env:ABU_INSTALLER_EXTRACTOR = Join-Path $agent 'installer-tools\7za.exe'
$env:ABU_INSTALLER_ARCHIVE = Join-Path $agent 'corrupt-application.7z'
Copy-Item -LiteralPath (Join-Path $agent 'isolated-package-cache.7z') -Destination $env:ABU_INSTALLER_ARCHIVE
$archive = [IO.File]::Open($env:ABU_INSTALLER_ARCHIVE, 'Open', 'Write', 'None')
try { $archive.SetLength([long]($archive.Length / 2)) } finally { $archive.Dispose() }
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$helper = (Resolve-Path 'build\abu-installer-transaction.ps1').Path
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action Begin
if ($LASTEXITCODE -ne 0) { throw 'Could not begin the corrupt-archive test.' }
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action Extract
if ($LASTEXITCODE -ne 20) { throw 'A corrupt archive did not report its damaged-package category.' }
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action Recover
if ($LASTEXITCODE -ne 0) { throw 'A corrupt archive could not be recovered.' }
Assert-PreviousApplication
Write-Output 'A corrupt application archive returned failure and preserved the previous installation.'
