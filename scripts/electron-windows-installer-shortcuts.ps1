param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
$agent = (Resolve-Path .agent).Path
$env:TEMP = Join-Path $agent 'build-temp'
$env:TMP = $env:TEMP
$destination = Join-Path $agent "acceptance\阿布 O'Brien Install"
if ((Get-ItemProperty 'HKCU:\Software\89f944a7-c4f6-5020-b650-13bcfb65019c').InstallLocation -ne $destination -or
    [IO.Path]::GetFileName($Installer) -ne 'AbuInstallerTest-0.60.0-windows-x64-setup.exe') { throw 'Use the isolated installation and installer.' }
$linkPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'AbuInstallerTest.lnk'
$original = [IO.File]::ReadAllBytes($linkPath)
$shell = New-Object -ComObject WScript.Shell
try {
  $link = $shell.CreateShortcut($linkPath)
  $link.WorkingDirectory = ''
  $link.Arguments = '--disable-gpu'
  $link.Save()
  $process = Start-Process -FilePath $Installer -ArgumentList '--updated' -PassThru
  if (-not $process.WaitForExit(240000)) { Stop-Process -Id $process.Id; throw 'The shortcut update test timed out.' }
  if ($process.ExitCode -ne 0) { throw "An update with a customized shortcut failed: $($process.ExitCode)" }
  $link = $shell.CreateShortcut($linkPath)
  if ($link.WorkingDirectory -ne '' -or $link.Arguments -ne '--disable-gpu') { throw 'The update changed user shortcut properties.' }
  Write-Output 'The update preserved the customized shortcut working directory and arguments.'
} finally {
  [IO.File]::WriteAllBytes($linkPath, $original)
}
