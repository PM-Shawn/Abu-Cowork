param([Parameter(Mandatory = $true)][string]$Application)

$ErrorActionPreference = 'Stop'
$root = Join-Path (Resolve-Path .agent).Path ('transaction-acceptance-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$env:TEMP = Join-Path $root 'temp'
$env:TMP = $env:TEMP
$null = New-Item -ItemType Directory -Path $env:TEMP
$env:ABU_INSTALLER_DIRECTORY = Join-Path $root "阿布 O'Brien"
$env:ABU_INSTALLER_ID = 'abu-transaction-acceptance'
$env:ABU_INSTALLER_EXE = 'AbuInstallerTest.exe'
$env:ABU_INSTALLER_UNINSTALLER = 'Uninstall AbuInstallerTest.exe'
$env:ABU_INSTALLER_VERSION = '0.60.0'
$env:ABU_INSTALLER_REGISTRY = 'Software\AbuInstallerTransactionAcceptance'
$env:ABU_INSTALLER_UNINSTALL_KEY = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\AbuInstallerTransactionAcceptance'
$env:ABU_INSTALLER_LINKS = '[]'
$helper = Join-Path (Get-Location) 'build\abu-installer-transaction.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$registry = 'HKCU:\' + $env:ABU_INSTALLER_REGISTRY
$uninstall = 'HKCU:\' + $env:ABU_INSTALLER_UNINSTALL_KEY

function Invoke-Transaction([string]$action, [int]$expected = 0) {
  & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action $action
  if ($LASTEXITCODE -ne $expected) { throw "$action returned $LASTEXITCODE; expected $expected." }
}

function Copy-Application([string]$destination, [string]$source = $Application) {
  & robocopy.exe $source $destination /E /R:0 /W:0 /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Application copy failed: $LASTEXITCODE" }
  # Use the real signed/unsigned test uninstaller produced by NSIS.
  Copy-Item -LiteralPath $env:ABU_TEST_UNINSTALLER -Destination (Join-Path $destination $env:ABU_INSTALLER_UNINSTALLER)
}

if (-not (Test-Path -LiteralPath $env:ABU_TEST_UNINSTALLER)) { throw 'ABU_TEST_UNINSTALLER must identify the isolated test uninstaller.' }
Copy-Application $env:ABU_INSTALLER_DIRECTORY (Resolve-Path '.agent\installer-baseline\win-unpacked').Path
$null = New-Item -Path $registry -Force
$null = New-Item -Path $uninstall -Force
Set-ItemProperty -Path $registry -Name InstallLocation -Value $env:ABU_INSTALLER_DIRECTORY
Set-ItemProperty -Path $uninstall -Name DisplayVersion -Value 'previous-version'
$oldHash = (Get-FileHash -LiteralPath (Join-Path $env:ABU_INSTALLER_DIRECTORY 'resources\app.asar')).Hash

try {
  Invoke-Transaction Begin
  $stage = $env:ABU_INSTALLER_DIRECTORY + '.abu-update\new'
  Copy-Application $stage
  if ((Get-FileHash -LiteralPath (Join-Path $stage 'resources\app.asar')).Hash -eq $oldHash) { throw 'The acceptance packages must contain different application versions.' }
  Invoke-Transaction Promote
  Set-ItemProperty -Path $uninstall -Name DisplayVersion -Value $env:ABU_INSTALLER_VERSION
  # Ending after Promote exercises the same persisted state as an interrupted installer.
  Invoke-Transaction Recover
  if ((Get-ItemProperty $uninstall).DisplayVersion -ne 'previous-version') { throw 'Recovery did not restore registration.' }
  if ((Get-FileHash -LiteralPath (Join-Path $env:ABU_INSTALLER_DIRECTORY 'resources\app.asar')).Hash -ne $oldHash) { throw 'Recovery changed the old application.' }
  if (Test-Path -LiteralPath ($env:ABU_INSTALLER_DIRECTORY + '.abu-update')) { throw 'Recovery left an unfinished transaction.' }
  Invoke-Transaction Begin
  Copy-Application $stage
  $locked = [IO.File]::Open((Join-Path $env:ABU_INSTALLER_DIRECTORY $env:ABU_INSTALLER_EXE), 'Open', 'Read', 'None')
  try { Invoke-Transaction Promote 21 } finally { $locked.Dispose() }
  Invoke-Transaction Recover
  if (-not (Test-Path -LiteralPath (Join-Path $env:ABU_INSTALLER_DIRECTORY $env:ABU_INSTALLER_EXE))) { throw 'A locked file removed the old application.' }
  Invoke-Transaction Begin
  Copy-Application $stage
  $directoryLock = Start-Process -FilePath $powershell -WorkingDirectory $stage -ArgumentList '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru
  try {
    Invoke-Transaction Promote 21
    if (-not (Test-Path -LiteralPath ($env:ABU_INSTALLER_DIRECTORY + '.abu-update\old'))) { throw 'The switch-failure test did not reach the backup step.' }
  } finally { if (-not $directoryLock.HasExited) { Stop-Process -Id $directoryLock.Id }; $null = $directoryLock.WaitForExit(10000) }
  Invoke-Transaction Recover
  if ((Get-FileHash -LiteralPath (Join-Path $env:ABU_INSTALLER_DIRECTORY 'resources\app.asar')).Hash -ne $oldHash) { throw 'A failed directory switch did not restore the old version.' }
  Invoke-Transaction Begin
  Copy-Application $stage
  Remove-Item -LiteralPath (Join-Path $stage 'icudtl.dat')
  Invoke-Transaction Promote 20
  Invoke-Transaction Recover
  Invoke-Transaction Begin
  Copy-Application $stage
  Invoke-Transaction Promote
  Set-ItemProperty -Path $uninstall -Name DisplayVersion -Value $env:ABU_INSTALLER_VERSION
  Set-ItemProperty -Path $uninstall -Name UninstallString -Value ('"' + (Join-Path $env:ABU_INSTALLER_DIRECTORY $env:ABU_INSTALLER_UNINSTALLER) + '" /currentuser')
  Invoke-Transaction Commit
  Invoke-Transaction Recover
  if ((Get-ItemProperty $uninstall).DisplayVersion -ne $env:ABU_INSTALLER_VERSION) { throw 'Recovery reverted a committed installation.' }
  Write-Output 'Directory recovery, registration recovery, locked-file failure and committed update passed.'
} finally {
  Remove-Item -LiteralPath $registry -Recurse -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $uninstall -Recurse -ErrorAction SilentlyContinue
}
