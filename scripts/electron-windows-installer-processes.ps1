param([Parameter(Mandatory = $true)][string]$Installer, [switch]$SkipSilent)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AbuProcessUi {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int size);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, byte[] descriptor);
}
'@
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
if (-not $SkipSilent) {
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

}

function Find-InstallerControl($process, [string]$name, [int]$seconds = 90) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  do {
    $process.Refresh()
    if ($process.HasExited) { throw "Installer exited with $($process.ExitCode) while waiting for $name." }
    if ($process.MainWindowHandle -ne 0) {
      $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
      $control = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
      if ($control -and -not $control.Current.IsOffscreen) { return $control }
    }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Installer control not found: $name"
}

function Press-InstallerControl($process, [string]$name) {
  $control = Find-InstallerControl $process $name
  $null = [AbuProcessUi]::PostMessage([IntPtr]$control.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
}

$node = (Resolve-Path 'electron\.runtime\node-runtime\node.exe').Path
$backgroundExe = Join-Path $location 'AbuBackgroundAcceptance.exe'
$unrelatedExe = Join-Path $sibling 'AbuBackgroundAcceptance.exe'
Copy-Item -LiteralPath $node -Destination $backgroundExe
Copy-Item -LiteralPath $node -Destination $unrelatedExe
$background = Start-Process -FilePath $backgroundExe -ArgumentList '-e', 'setInterval(()=>{},1000)' -WindowStyle Hidden -PassThru
$unrelated = Start-Process -FilePath $unrelatedExe -ArgumentList '-e', 'setInterval(()=>{},1000)' -WindowStyle Hidden -PassThru
$installerProcess = $null
$originalHash = (Get-FileHash -LiteralPath (Join-Path $location 'resources\app.asar')).Hash
try {
  foreach ($cancel in @('取消更新', '关闭安装程序')) {
    $installerProcess = Start-Process -FilePath $Installer -PassThru
    Press-InstallerControl $installerProcess '立即更新'
    $null = Find-InstallerControl $installerProcess '更新需要关闭阿布'
    $cancelButton = Find-InstallerControl $installerProcess '取消更新'
    $confirmButton = Find-InstallerControl $installerProcess '关闭并更新'
    $scale = [AbuProcessUi]::GetDpiForWindow($installerProcess.MainWindowHandle) / 96
    if ([Math]::Abs(($confirmButton.Current.BoundingRectangle.Left - $cancelButton.Current.BoundingRectangle.Right) - 8 * $scale) -gt 1) {
      throw 'The confirmation actions are not grouped with an 8px gap.'
    }
    if (-not $cancelButton.Current.HasKeyboardFocus) { throw 'Cancellation is not initially focused.' }
    Press-InstallerControl $installerProcess $cancel
    if (-not $installerProcess.WaitForExit(10000) -or $installerProcess.ExitCode -ne 1) { throw 'Cancel did not exit with code 1.' }
    $background.Refresh()
    if ($background.HasExited) { throw 'Cancel terminated the background app.' }
    if ((Get-FileHash -LiteralPath (Join-Path $location 'resources\app.asar')).Hash -ne $originalHash) { throw 'Cancel changed the application.' }
    Write-Output "Confirmed $cancel preserves the running app and installed files."
  }
  $knownHelpers = @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'abu-installer-processes.ps1' -Recurse | ForEach-Object FullName)
  $installerProcess = Start-Process -FilePath $Installer -PassThru
  $null = Find-InstallerControl $installerProcess '立即更新'
  $newHelpers = @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'abu-installer-processes.ps1' -Recurse | Where-Object { $_.FullName -notin $knownHelpers })
  if ($newHelpers.Count -ne 1) { throw 'Cannot identify the extracted test helper.' }
  $helperPath = $newHelpers[0].FullName
  if (-not $helperPath.StartsWith($env:TEMP.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected helper location.' }
  $heldHelper = "$helperPath.held"
  Move-Item -LiteralPath $helperPath -Destination $heldHelper
  try {
    Press-InstallerControl $installerProcess '立即更新'
    $null = Find-InstallerControl $installerProcess '无法检查阿布是否运行，请重试。'
    Move-Item -LiteralPath $heldHelper -Destination $helperPath
    Press-InstallerControl $installerProcess '重试'
    $null = Find-InstallerControl $installerProcess '更新需要关闭阿布'
    $cancelButton = Find-InstallerControl $installerProcess '取消更新'
    if (-not $cancelButton.Current.HasKeyboardFocus) { throw 'Retry did not focus cancellation for the new confirmation.' }
    $background.Refresh()
    if ($background.HasExited) { throw 'Retry terminated the app without confirmation.' }
    Press-InstallerControl $installerProcess '取消更新'
    if (-not $installerProcess.WaitForExit(10000) -or $installerProcess.ExitCode -ne 1) { throw 'Check retry cancellation failed.' }
    Write-Output 'Check failure and retry require a separate close confirmation with cancellation focused.'
  } finally {
    if (Test-Path -LiteralPath $heldHelper) { Move-Item -LiteralPath $heldHelper -Destination $helperPath }
  }
  $knownHelpers = @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'abu-installer-processes.ps1' -Recurse | ForEach-Object FullName)
  $installerProcess = Start-Process -FilePath $Installer -PassThru
  Press-InstallerControl $installerProcess '立即更新'
  $null = Find-InstallerControl $installerProcess '更新需要关闭阿布'
  $newHelpers = @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'abu-installer-processes.ps1' -Recurse | Where-Object { $_.FullName -notin $knownHelpers })
  if ($newHelpers.Count -ne 1) { throw 'Cannot identify the final-check helper.' }
  $helperPath = $newHelpers[0].FullName
  if (-not $helperPath.StartsWith($env:TEMP.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected helper location.' }
  $heldHelper = "$helperPath.held"
  Press-InstallerControl $installerProcess '关闭并更新'
  if (-not $background.WaitForExit(15000)) { throw 'The confirmed process did not exit.' }
  Move-Item -LiteralPath $helperPath -Destination $heldHelper
  try {
    $null = Find-InstallerControl $installerProcess '无法检查阿布是否运行，请重试。'
    $null = Find-InstallerControl $installerProcess '更新未能完成'
    if ((Get-FileHash -LiteralPath (Join-Path $location 'resources\app.asar')).Hash -ne $originalHash) { throw 'Final check failure changed the application.' }
    Move-Item -LiteralPath $heldHelper -Destination $helperPath
    Press-InstallerControl $installerProcess '关闭安装程序'
    if (-not $installerProcess.WaitForExit(10000) -or $installerProcess.ExitCode -ne 2) { throw 'Final check failure did not exit with code 2.' }
    Write-Output 'Final check failure reports a check error after the app has exited and preserves the installation.'
  } finally {
    if (Test-Path -LiteralPath $heldHelper) { Move-Item -LiteralPath $heldHelper -Destination $helperPath }
  }
  $background.Dispose()
  $background = Start-Process -FilePath $backgroundExe -ArgumentList '-e', 'setInterval(()=>{},1000)' -WindowStyle Hidden -PassThru
  $installerProcess = Start-Process -FilePath $Installer -PassThru
  Press-InstallerControl $installerProcess '立即更新'
  $null = Find-InstallerControl $installerProcess '更新需要关闭阿布'
  $retainedHandle = $background.Handle
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $denied = [Security.AccessControl.RawSecurityDescriptor]::new("D:(D;;0x0001;;;$sid)(A;;GA;;;$sid)")
  $descriptor = [byte[]]::new($denied.BinaryLength)
  $denied.GetBinaryForm($descriptor, 0)
  if (-not [AbuProcessUi]::SetKernelObjectSecurity($retainedHandle, 4, $descriptor)) { throw 'Cannot protect the test process.' }
  Press-InstallerControl $installerProcess '关闭并更新'
  $null = Find-InstallerControl $installerProcess '暂时无法关闭阿布'
  $background.Refresh()
  if ($background.HasExited) { throw 'A protected process was terminated.' }
  if ((Get-FileHash -LiteralPath (Join-Path $location 'resources\app.asar')).Hash -ne $originalHash) { throw 'Failure changed the application.' }
  Write-Output 'Access denial shows a retry action and preserves the process and installed files.'
  $allowed = [Security.AccessControl.RawSecurityDescriptor]::new("D:(A;;GA;;;$sid)")
  $descriptor = [byte[]]::new($allowed.BinaryLength)
  $allowed.GetBinaryForm($descriptor, 0)
  if (-not [AbuProcessUi]::SetKernelObjectSecurity($retainedHandle, 4, $descriptor)) { throw 'Cannot release the test process.' }
  $failureCopy = Find-InstallerControl $installerProcess '请退出阿布后重试。当前版本未更改。'
  $failureTitle = Find-InstallerControl $installerProcess '暂时无法关闭阿布'
  $titleHandle = [IntPtr]$failureTitle.Current.NativeWindowHandle
  $copyHandle = [IntPtr]$failureCopy.Current.NativeWindowHandle
  Press-InstallerControl $installerProcess '重试关闭'
  $text = [Text.StringBuilder]::new(512)
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $null = [AbuProcessUi]::GetWindowText($titleHandle, $text, $text.Capacity)
    if ($text.ToString() -eq '正在关闭阿布…') { break }
    Start-Sleep -Milliseconds 10
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($text.ToString() -ne '正在关闭阿布…') { throw 'The closing state was not observed.' }
  $null = [AbuProcessUi]::GetWindowText($copyHandle, $text, $text.Capacity)
  if ($text.Length -ne 0) { throw 'Retry still displays the previous failure instructions.' }
  Write-Output 'Retry closing clears the previous failure instructions while the operation is running.'
  $null = Find-InstallerControl $installerProcess '更新完成' 180
  if (-not $background.WaitForExit(1000)) { throw 'The confirmed background process is still running.' }
  $unrelated.Refresh()
  if ($unrelated.HasExited) { throw 'The unrelated same-name process was terminated.' }
  Press-InstallerControl $installerProcess '关闭安装程序'
  if (-not $installerProcess.WaitForExit(10000) -or $installerProcess.ExitCode -ne 0) { throw 'Confirmed update did not finish successfully.' }
  Write-Output 'Confirmed close automatically completed the update and preserved the unrelated same-name process.'
} finally {
  foreach ($owned in @($installerProcess, $background, $unrelated)) {
    if ($owned) {
      $owned.Refresh()
      if (-not $owned.HasExited) { $owned.Kill(); $null = $owned.WaitForExit(5000) }
      $owned.Dispose()
    }
  }
}
