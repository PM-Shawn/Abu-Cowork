param([int]$ProcessId, [string]$DialogTitle, [string]$AcceptLabel)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'nativeCaptureApproval.cs')
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
  if ([NativeCaptureApproval]::TryAccept($ProcessId, $DialogTitle, $AcceptLabel)) { exit 0 }
  Start-Sleep -Milliseconds 100
}
throw 'The test-owned screen capture approval did not appear.'
