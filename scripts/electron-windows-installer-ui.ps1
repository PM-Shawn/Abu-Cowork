param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
$env:TEMP = Join-Path (Resolve-Path .agent).Path 'build-temp'
$env:TMP = $env:TEMP
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AbuInstallerTestWindows {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, string lparam);
  [DllImport("user32.dll")]
  public static extern IntPtr PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@

$agentDir = (Resolve-Path .agent).Path
$destination = Join-Path $agentDir "acceptance\阿布 O'Brien Install"
$occupied = Join-Path $agentDir 'acceptance\occupied'
$registry = 'HKCU:\Software\89f944a7-c4f6-5020-b650-13bcfb65019c'
$existing = Get-ItemProperty $registry -ErrorAction SilentlyContinue
if ($existing -and $existing.InstallLocation -ne $destination) {
  throw "The test identity is already installed at $($existing.InstallLocation)."
}
if ([IO.Path]::GetFileName($Installer) -ne 'AbuInstallerTest-0.60.0-windows-x64-setup.exe') {
  throw 'Use the isolated AbuInstallerTest installer.'
}
New-Item -ItemType Directory -Force -Path $occupied | Out-Null
[IO.File]::WriteAllText((Join-Path $occupied 'document.txt'), 'keep this document')
$process = Start-Process -FilePath $Installer -PassThru

function Find-Control([string]$name, [int]$seconds = 60) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  do {
    $process.Refresh()
    if ($process.MainWindowHandle -ne 0) {
      $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $name)
      $control = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
      if ($control -and -not $control.Current.IsOffscreen) { return $control }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Control not found: $name"
}

function Press-Control([string]$name) {
  $control = Find-Control $name
  [AbuInstallerTestWindows]::PostMessage([IntPtr]$control.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
}

try {
  $installButton = Find-Control '立即安装'
  $scale = [AbuInstallerTestWindows]::GetDpiForWindow($process.MainWindowHandle) / 96
  if ([Math]::Abs($installButton.Current.BoundingRectangle.Height - 40 * $scale) -gt 1) {
    throw 'The primary action does not use the intended control height.'
  }
  $frame = [AbuInstallerTestWindows+Rect]::new()
  $buttonFrame = [AbuInstallerTestWindows+Rect]::new()
  $null = [AbuInstallerTestWindows]::GetWindowRect($process.MainWindowHandle, [ref]$frame)
  $null = [AbuInstallerTestWindows]::GetWindowRect([IntPtr]$installButton.Current.NativeWindowHandle, [ref]$buttonFrame)
  $bitmap = [Drawing.Bitmap]::new($frame.Right - $frame.Left, $frame.Bottom - $frame.Top)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $dc = $graphics.GetHdc()
  try {
    if (-not [AbuInstallerTestWindows]::PrintWindow($process.MainWindowHandle, $dc, 2)) { throw 'Cannot capture the native installer.' }
  } finally { $graphics.ReleaseHdc($dc); $graphics.Dispose() }
  try {
    foreach ($point in @(@(210, 74), @(270, 74), @(210, 134))) {
      $background = $bitmap.GetPixel([int]($point[0] * $scale), [int]($point[1] * $scale))
      if ($background.R -ne 255 -or $background.G -ne 255 -or $background.B -ne 255) { throw "The icon has a rectangular background: $background" }
    }
    $color = $bitmap.GetPixel([int]($buttonFrame.Left - $frame.Left + 12 * $scale), [int]($buttonFrame.Top - $frame.Top + 20 * $scale))
    $resting = $color.R -eq 29 -and $color.G -eq 29 -and $color.B -eq 31
    $hovered = $color.R -eq 52 -and $color.G -eq 52 -and $color.B -eq 54
    if (-not $resting -and -not $hovered) {
      throw "The primary action did not render the emphasis color: $color"
    }
  } finally { $bitmap.Dispose() }
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  $visible = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { -not $_.Current.IsOffscreen })
  if ($visible | Where-Object { $_.Current.ClassName -eq 'Edit' -or $_.Current.Name -like '*\Programs\AbuInstallerTest*' }) { throw 'The initial page exposes a location before expansion.' }
  Press-Control '选择安装位置'
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Edit')
  $process.Refresh()
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $edit = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if (-not $edit) { Start-Sleep -Milliseconds 100 }
  } while (-not $edit -and [DateTime]::UtcNow -lt $deadline)
  if (-not $edit) { throw 'Installation location input was not found.' }
  $editHandle = [IntPtr]$edit.Current.NativeWindowHandle
  [AbuInstallerTestWindows]::SendMessage($editHandle, 0xC, [IntPtr]::Zero, [IO.Path]::GetPathRoot($destination)) | Out-Null
  Press-Control '立即安装'
  $null = Find-Control '请选择有效的安装位置。' 10
  [AbuInstallerTestWindows]::SendMessage($editHandle, 0xC, [IntPtr]::Zero, $occupied) | Out-Null
  Press-Control '立即安装'
  $null = Find-Control '请选择空文件夹。' 10
  if ([IO.File]::ReadAllText((Join-Path $occupied 'document.txt')) -ne 'keep this document') {
    throw 'An existing document was changed.'
  }
  [AbuInstallerTestWindows]::SendMessage($editHandle, 0xC, [IntPtr]::Zero, ($occupied + [char]1)) | Out-Null
  Press-Control '立即安装'
  $null = Find-Control '请选择有效的安装位置。' 10
  [AbuInstallerTestWindows]::SendMessage($editHandle, 0xC, [IntPtr]::Zero, "${occupied}?") | Out-Null
  Press-Control '立即安装'
  $null = Find-Control '请选择有效的安装位置。' 10
  if ([IO.File]::ReadAllText((Join-Path $occupied 'document.txt')) -ne 'keep this document') {
    throw 'An invalid path changed an existing document.'
  }
  [AbuInstallerTestWindows]::SendMessage($editHandle, 0xC, [IntPtr]::Zero, $destination) | Out-Null
  [AbuInstallerTestWindows]::PostMessage($editHandle, 0x100, [IntPtr]13, [IntPtr]1) | Out-Null
  [AbuInstallerTestWindows]::PostMessage($editHandle, 0x101, [IntPtr]13, [IntPtr]1) | Out-Null
  $null = Find-Control '安装完成' 180
  if (-not (Test-Path -LiteralPath (Join-Path $destination 'AbuInstallerTest.exe'))) {
    throw 'The executable was not installed in the selected directory.'
  }
  $location = (Get-ItemProperty $registry).InstallLocation
  if ($location -ne $destination) { throw "Unexpected registered installation location: $location" }
  Press-Control '关闭安装程序'
  if (-not $process.WaitForExit(30000)) { throw 'Installer did not exit.' }
  if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)." }
  $rejected = Start-Process -FilePath $Installer -ArgumentList '--updated', "/D=$occupied" -PassThru -Wait
  if ($rejected.ExitCode -ne 2) { throw "Expected the occupied directory to be rejected, got $($rejected.ExitCode)." }
  if ([IO.File]::ReadAllText((Join-Path $occupied 'document.txt')) -ne 'keep this document') {
    throw 'Silent installation changed an existing document.'
  }
  $update = Start-Process -FilePath $Installer -ArgumentList '--updated' -PassThru -Wait
  if ($update.ExitCode -ne 0) { throw "Silent update exited with $($update.ExitCode)." }
  $location = (Get-ItemProperty $registry).InstallLocation
  if ($location -ne $destination -or -not (Test-Path -LiteralPath (Join-Path $destination 'AbuInstallerTest.exe'))) {
    throw 'Silent update did not preserve the installation location.'
  }
  Write-Output "Installed in $destination"
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
}
