param([Parameter(Mandatory = $true)][string]$Installer)

$ErrorActionPreference = 'Stop'
$agent = (Resolve-Path .agent).Path
$env:TEMP = Join-Path $agent 'build-temp'
$env:TMP = $env:TEMP
$destination = Join-Path $agent "acceptance\阿布 O'Brien Install"
if ((Get-ItemProperty 'HKCU:\Software\89f944a7-c4f6-5020-b650-13bcfb65019c').InstallLocation -ne $destination) { throw 'Unexpected test installation.' }
if ([IO.Path]::GetFileName($Installer) -ne 'AbuInstallerTest-0.60.0-windows-x64-setup.exe') { throw 'Use the isolated installer.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AbuFailureUi {
  [StructLayout(LayoutKind.Sequential)] public struct GuiThreadInfo {
    public uint Size, Flags;
    public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
    public int Left, Top, Right, Bottom;
  }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
  [DllImport("user32.dll")]
  public static extern IntPtr PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
}
'@
$file = [IO.File]::Open((Join-Path $destination 'icudtl.dat'), 'Open', 'Read', 'None')
$process = Start-Process -FilePath $Installer -PassThru

function Find-Control([string]$name, [string]$className = '') {
  $deadline = [DateTime]::UtcNow.AddSeconds(240)
  do {
    $process.Refresh()
    if ($process.HasExited) { throw "Installer exited before showing $name." }
    if ($process.MainWindowHandle -ne 0) {
      $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
      $controls = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
      foreach ($control in $controls) {
        if (-not $control.Current.IsOffscreen -and (-not $className -or $control.Current.ClassName -eq $className)) { return $control }
      }
    }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Control not found: $name"
}

try {
  $button = Find-Control '立即更新' 'Button'
  [AbuFailureUi]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  $null = Find-Control '更新未能完成'
  $null = Find-Control '当前版本已保留，你可以继续使用阿布。'
  $details = Find-Control '查看详情' 'Button'
  $secondary = Find-Control '继续使用当前版本' 'Button'
  $retry = Find-Control '重试更新' 'Button'
  $thread = [AbuFailureUi]::GetWindowThreadProcessId($process.MainWindowHandle, [IntPtr]::Zero)
  $focusDeadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $focus = [AbuFailureUi+GuiThreadInfo]::new()
    $focus.Size = [Runtime.InteropServices.Marshal]::SizeOf($focus)
    if (-not [AbuFailureUi]::GetGUIThreadInfo($thread, [ref]$focus)) { throw 'Cannot read the installer keyboard focus.' }
    if ($focus.Focus -eq [IntPtr]$retry.Current.NativeWindowHandle) { break }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $focusDeadline)
  if ($focus.Focus -ne [IntPtr]$retry.Current.NativeWindowHandle) { throw 'Keyboard focus did not reach the visible primary action.' }
  $gap = $retry.Current.BoundingRectangle.Left - $secondary.Current.BoundingRectangle.Right
  if ($gap -lt 7 -or $gap -gt 17 -or $retry.Current.BoundingRectangle.Top -ne $secondary.Current.BoundingRectangle.Top) { throw 'Failure actions are not grouped together.' }
  if ($details.Current.BoundingRectangle.Bottom -ge $retry.Current.BoundingRectangle.Top) { throw 'Details must sit beside the explanation.' }
  [AbuFailureUi]::PostMessage([IntPtr]$details.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  $null = Find-Control '查看日志'
  $file.Dispose()
  $parentId = $process.Id
  [AbuFailureUi]::PostMessage([IntPtr]$retry.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  $completed = $process.WaitForExit(10000)
  if (-not $completed -or $process.ExitCode -ne 2) { throw "Retry did not exit the failed installer: exited=$completed, code=$($process.ExitCode)." }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $child = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Installer -and $_.CommandLine -like "*/ABURETRYPID=$parentId *" })
    if ($child.Count) { break }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($child.Count -ne 1) { throw 'The retry installer was not started exactly once.' }
  $process = [Diagnostics.Process]::GetProcessById($child[0].ProcessId)
  $null = $process.Handle
  $null = Find-Control '更新完成'
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  $visible = @($window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { -not $_.Current.IsOffscreen })
  if ($visible | Where-Object { $_.Current.Name -eq $destination -or $_.Current.ClassName -eq 'Edit' }) { throw 'Update completion exposed an installation location.' }
  $close = Find-Control '关闭安装程序'
  [AbuFailureUi]::PostMessage([IntPtr]$close.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  $completed = $process.WaitForExit(10000)
  if (-not $completed -or $process.ExitCode -ne 0) { throw "The retried update did not finish successfully: exited=$completed, code=$($process.ExitCode)." }
  Write-Output 'Failure details, grouped actions, verified recovery, retry process handoff and successful update passed.'
} finally {
  $file.Dispose()
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
}
