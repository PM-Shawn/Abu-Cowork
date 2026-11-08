param([Parameter(Mandatory = $true)][ValidateSet('Check', 'Stop')][string]$Action)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-InstallProcesses {
  $snapshot = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
  $excluded = [Collections.Generic.HashSet[int]]::new()
  $null = $excluded.Add($PID)
  $installerId = [int]$env:ABU_INSTALLER_PROCESS_ID
  $null = $excluded.Add($installerId)
  $ancestorId = $installerId
  $visited = [Collections.Generic.HashSet[int]]::new()
  while ($ancestorId -gt 0 -and $visited.Add($ancestorId)) {
    $ancestor = $snapshot | Where-Object { $_.ProcessId -eq $ancestorId } | Select-Object -First 1
    if (-not $ancestor) { break }
    # The launching app can be an ancestor and must remain a blocker.
    if ($ancestor.ExecutablePath -and [string]::Equals($ancestor.ExecutablePath, $env:ABU_INSTALLER_SOURCE, [StringComparison]::OrdinalIgnoreCase)) {
      $null = $excluded.Add([int]$ancestor.ProcessId)
    }
    $ancestorId = [int]$ancestor.ParentProcessId
  }
  @($snapshot | Where-Object {
    $_.ExecutablePath -and
    $_.ExecutablePath.StartsWith($script:installRoot, [StringComparison]::OrdinalIgnoreCase) -and
    -not $excluded.Contains([int]$_.ProcessId)
  })
}

try {
  $directory = $env:ABU_INSTALLER_DIRECTORY
  if (-not $directory -or -not [IO.Path]::IsPathRooted($directory)) { throw 'An absolute installation directory is required.' }
  $script:installRoot = [IO.Path]::GetFullPath($directory).TrimEnd('\') + '\'
  if ($script:installRoot -eq [IO.Path]::GetPathRoot($script:installRoot)) { throw 'A drive root cannot be an installation directory.' }
  $targets = @(Get-InstallProcesses)
  if ($Action -eq 'Check') {
    if ($targets.Count -gt 0) { exit 4 }
    exit 0
  }

  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $timer = [Diagnostics.Stopwatch]::StartNew()
  foreach ($target in $targets) {
    if ($timer.ElapsedMilliseconds -ge 10000) { throw 'Timed out closing application processes.' }
    try { $process = [Diagnostics.Process]::GetProcessById([int]$target.ProcessId) }
    catch [ArgumentException] { continue }
    try {
      # Keep this handle open through identity verification and termination.
      $null = $process.Handle
      if ($process.HasExited) { continue }
      $started = $process.StartTime.ToUniversalTime().Ticks
      $created = $target.CreationDate.ToUniversalTime().Ticks
      # CIM timestamps have microsecond precision; Process retains 100ns ticks.
      if (($started - ($started % 10)) -ne $created) { throw 'The application process identity changed.' }
      if ($target.SessionId -ne $sessionId) { throw 'An application process belongs to another session.' }
      $owner = Invoke-CimMethod -InputObject $target -MethodName GetOwnerSid -OperationTimeoutSec 5
      if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $ownerSid) { throw 'The application process owner could not be verified.' }
      $process.Kill()
      $remaining = [Math]::Max(0, 10000 - [int]$timer.ElapsedMilliseconds)
      if (-not $process.WaitForExit($remaining)) { throw 'The application process did not exit.' }
    } catch {
      if (-not $process.HasExited) { throw }
    } finally { $process.Dispose() }
  }
  if (@(Get-InstallProcesses).Count -gt 0) { exit 4 }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
