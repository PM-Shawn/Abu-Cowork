$ErrorActionPreference = 'Stop'
$agent = (Resolve-Path .agent).Path
$root = Join-Path $agent "process-helper\阿布 O'Brien"
$sibling = "${root}Sibling"
$null = New-Item -ItemType Directory -Force -Path $root, $sibling
$env:TEMP = Join-Path $agent 'temp'
$env:TMP = $env:TEMP
$shell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$helper = (Resolve-Path 'build\abu-installer-processes.ps1').Path
$node = (Resolve-Path 'electron\.runtime\node-runtime\node.exe').Path
$targetExe = Join-Path $root 'AbuProcessTest.exe'
$siblingExe = Join-Path $sibling 'AbuProcessTest.exe'
Copy-Item -LiteralPath $node -Destination $targetExe
Copy-Item -LiteralPath $node -Destination $siblingExe
$env:ABU_INSTALLER_DIRECTORY = $root
$env:ABU_INSTALLER_SOURCE = $shell
$env:ABU_INSTALLER_PROCESS_ID = "$PID"

function Assert-Helper([string]$action, [int]$expected) {
  & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action $action
  if ($LASTEXITCODE -ne $expected) { throw "$action returned $LASTEXITCODE; expected $expected." }
}

$target = Start-Process -FilePath $targetExe -ArgumentList '-e', 'setInterval(()=>{},1000)' -WindowStyle Hidden -PassThru
$unrelated = Start-Process -FilePath $siblingExe -ArgumentList '-e', 'setInterval(()=>{},1000)' -WindowStyle Hidden -PassThru
try {
  Assert-Helper Check 4
  $target.Refresh()
  if ($target.HasExited) { throw 'Check terminated the target.' }
  Assert-Helper Stop 0
  if (-not $target.WaitForExit(1000)) { throw 'Stop did not end the target.' }
  $unrelated.Refresh()
  if ($unrelated.HasExited) { throw 'The sibling process was terminated.' }
  Assert-Helper Check 0
  Assert-Helper Stop 0
  $env:ABU_INSTALLER_DIRECTORY = [IO.Path]::GetPathRoot($root)
  Assert-Helper Stop 2
  $env:ABU_INSTALLER_DIRECTORY = 'relative-path'
  Assert-Helper Stop 2
  Write-Output 'PASS: read-only detection, confirmed termination, sibling identity, repeated exit, invalid roots.'
} finally {
  foreach ($owned in @($target, $unrelated)) {
    $owned.Refresh()
    if (-not $owned.HasExited) { $owned.Kill(); $null = $owned.WaitForExit(5000) }
    $owned.Dispose()
  }
}
