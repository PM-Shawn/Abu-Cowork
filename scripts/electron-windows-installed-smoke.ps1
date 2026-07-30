param(
  [string]$OutputDirectory = "release-electron"
)

$ErrorActionPreference = "Stop"

if ($env:CI -ne "true") {
  throw "This installer smoke mutates the current user's installed applications and is CI-only."
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputRoot = Join-Path $repositoryRoot $OutputDirectory
$installer = Get-ChildItem -Path $outputRoot -Filter "Abu-*-windows-x64-setup.exe" -File |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if (-not $installer) {
  throw "Windows x64 NSIS installer not found under $outputRoot"
}

$signature = Get-AuthenticodeSignature -FilePath $installer.FullName
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned) {
  throw "Baseline installer must be unsigned; Authenticode status was $($signature.Status)"
}

$programsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Programs"))
$beforePids = @(Get-Process -Name "Abu" -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$installerProcess = $null
$installedProcess = $null
$installedProcesses = @()
$uninstaller = $null
$upgradeFixtureName = "ci-electron-transition-$PID"
$tauriFixture = Join-Path $env:APPDATA "com.abu.app\conversations\$upgradeFixtureName"
$electronFixture = Join-Path $env:APPDATA "com.abu.app.electron\conversations\$upgradeFixtureName"
$migrationBackupRoot = Join-Path $env:APPDATA "com.abu.app.electron-backups"
$migrationDiagnostics = Join-Path $env:RUNNER_TEMP `
  "abu-electron-migration-$upgradeFixtureName.json"
$expectMigration = $env:ABU_EXPECT_TAURI_MIGRATION -eq "true"
$tauriInstallRoot = Join-Path $env:LOCALAPPDATA "Abu"
$tauriRollbackMarker = Join-Path $tauriInstallRoot "$upgradeFixtureName.rollback"

try {
  if ($expectMigration) {
    New-Item -ItemType Directory -Path $tauriFixture -Force | Out-Null
    Set-Content -Path (Join-Path $tauriFixture "messages.jsonl") `
      -Value '{"role":"user","content":"upgrade-fixture"}' -NoNewline
    New-Item -ItemType Directory -Path $electronFixture -Force | Out-Null
    Set-Content -Path (Join-Path $electronFixture "messages.jsonl") `
      -Value '{"role":"user","content":"preexisting-electron-fixture"}' -NoNewline
    Set-Content -Path (Join-Path $electronFixture "electron-only.txt") `
      -Value "electron-only" -NoNewline
    New-Item -ItemType Directory -Path $tauriInstallRoot -Force | Out-Null
    Set-Content -Path $tauriRollbackMarker -Value "tauri-rollback" -NoNewline
    # The actual app normally requires the user to click “Start safe upgrade”.
    # This CI-only triple gate lets the unattended installed smoke take that
    # exact code path without weakening normal packaged launches.
    $env:ABU_PACKAGED_E2E = "1"
    $env:ABU_E2E_AUTO_CONFIRM_TRANSITION = "1"
    $env:ABU_E2E_MIGRATION_DIAGNOSTICS_PATH = $migrationDiagnostics
  }

  $installerArguments = if ($expectMigration) {
    # Exact argument family used by tauri-plugin-updater on Windows.
    @("/P", "/R", "/UPDATE", "/ARGS")
  } else {
    @("/S")
  }
  $installerProcess = Start-Process -FilePath $installer.FullName `
    -ArgumentList $installerArguments -PassThru
  if (-not $installerProcess.WaitForExit(120000)) {
    $installerProcess.Kill()
    throw "NSIS installer did not finish within 120 seconds"
  }
  if ($installerProcess.ExitCode -ne 0) {
    throw "NSIS installer exited with $($installerProcess.ExitCode)"
  }

  $installedExe = Get-ChildItem -Path $programsRoot -Filter "Abu.exe" -File -Recurse |
    Where-Object { $_.FullName -notlike "*\release-electron\*" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (-not $installedExe) {
    throw "Installed Abu.exe was not found under the current user's Programs directory"
  }
  $installedPath = [System.IO.Path]::GetFullPath($installedExe.FullName)
  if (-not $installedPath.StartsWith($programsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Installer escaped the current-user Programs directory: $installedPath"
  }
  if ($expectMigration -and -not (Test-Path $tauriRollbackMarker)) {
    throw "Transition installer modified the old Tauri install; rollback marker is missing"
  }
  $startMenuShortcut = Join-Path $env:APPDATA `
    "Microsoft\Windows\Start Menu\Programs\Abu.lnk"
  if (-not (Test-Path $startMenuShortcut)) {
    throw "Current-user Start menu shortcut was not created"
  }
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($startMenuShortcut)
  $shortcutTarget = [System.IO.Path]::GetFullPath($shortcut.TargetPath)
  if (-not $shortcutTarget.Equals($installedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Start menu shortcut does not target the installed Electron app: $shortcutTarget"
  }

  if (-not $expectMigration) {
    $installedProcess = Start-Process -FilePath $installedPath -PassThru
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  $windowReady = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $installedProcesses = @(
      Get-Process -Name "Abu" -ErrorAction SilentlyContinue |
        Where-Object { $beforePids -notcontains $_.Id }
    )
    if ($installedProcesses | Where-Object { $_.MainWindowHandle -ne 0 }) {
      $windowReady = $true
      break
    }
    if ($installedProcess -and $installedProcess.HasExited) {
      throw "Installed Abu exited before opening its main window (exit $($installedProcess.ExitCode))"
    }
  }
  if (-not $windowReady) {
    throw "Installed Abu did not open a main window within 45 seconds"
  }
  if ($expectMigration) {
    $migratedFile = Join-Path $electronFixture "messages.jsonl"
    $migrationDeadline = [DateTime]::UtcNow.AddSeconds(45)
    while (
      [DateTime]::UtcNow -lt $migrationDeadline -and
      (
        -not (Test-Path $migratedFile) -or
        (Get-Content $migratedFile -Raw) -ne '{"role":"user","content":"upgrade-fixture"}'
      )
    ) {
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path $migratedFile)) {
      throw "Installed transition build did not copy the Tauri conversation fixture"
    }
    if ((Get-Content $migratedFile -Raw) -ne '{"role":"user","content":"upgrade-fixture"}') {
      $sentinel = Join-Path (Split-Path (Split-Path $electronFixture -Parent) -Parent) `
        "tauri-migration.json"
      $sentinelState = if (Test-Path $sentinel) {
        Get-Content $sentinel -Raw
      } else {
        "missing"
      }
      $diagnosticsState = if (Test-Path $migrationDiagnostics) {
        Get-Content $migrationDiagnostics -Raw
      } else {
        "missing"
      }
      throw "Tauri source did not win the migration conflict; sentinel=$sentinelState; diagnostics=$diagnosticsState"
    }
    if ((Get-Content (Join-Path $tauriFixture "messages.jsonl") -Raw) -ne '{"role":"user","content":"upgrade-fixture"}') {
      throw "Migration modified the original Tauri conversation"
    }
    if ((Get-Content (Join-Path $electronFixture "electron-only.txt") -Raw) -ne "electron-only") {
      throw "Migration did not retain Electron-only data"
    }
    $recoveredElectronFiles = @(
      Get-ChildItem -Path $migrationBackupRoot -Filter "messages.jsonl" -File -Recurse `
        -ErrorAction SilentlyContinue |
        Where-Object {
          $_.FullName -like "*\$upgradeFixtureName\messages.jsonl" -and
          (Get-Content $_.FullName -Raw) -eq '{"role":"user","content":"preexisting-electron-fixture"}'
        }
    )
    if ($recoveredElectronFiles.Count -lt 1) {
      throw "Expected a recovery copy of the preexisting Electron conflict"
    }
  }

  $uninstaller = Get-ChildItem -Path $installedExe.DirectoryName -Filter "Uninstall*.exe" -File |
    Select-Object -First 1
  if (-not $uninstaller) {
    throw "NSIS uninstaller was not created beside the installed application"
  }

  Write-Host "[windows-installed-smoke] PASS"
  Write-Host "installer=$($installer.FullName)"
  Write-Host "installedExe=$installedPath"
  Write-Host "installScope=current-user"
  Write-Host "signature=unsigned"
  Write-Host "tauriMigration=$expectMigration"
  Write-Host "tauriUpdaterArguments=$expectMigration"
  Write-Host "tauriRollbackPreserved=$expectMigration"
}
finally {
  foreach ($process in $installedProcesses) {
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
  if ($uninstaller -and (Test-Path $uninstaller.FullName)) {
    $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -PassThru
    if (-not $uninstallProcess.WaitForExit(120000)) {
      $uninstallProcess.Kill()
      throw "NSIS uninstaller did not finish within 120 seconds"
    }
    if ($uninstallProcess.ExitCode -ne 0) {
      throw "NSIS uninstaller exited with $($uninstallProcess.ExitCode)"
    }
  }
  if ($expectMigration -and -not (Test-Path $tauriRollbackMarker)) {
    throw "Electron uninstall removed the preserved Tauri rollback install"
  }
  Remove-Item $tauriFixture -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $electronFixture -Recurse -Force -ErrorAction SilentlyContinue
  if ($expectMigration -and (Test-Path $migrationBackupRoot)) {
    Get-ChildItem -Path $migrationBackupRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object {
        Test-Path (Join-Path $_.FullName "conversations\$upgradeFixtureName")
      } |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item $tauriRollbackMarker -Force -ErrorAction SilentlyContinue
  Remove-Item Env:ABU_E2E_AUTO_CONFIRM_TRANSITION -ErrorAction SilentlyContinue
  Remove-Item Env:ABU_E2E_MIGRATION_DIAGNOSTICS_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:ABU_PACKAGED_E2E -ErrorAction SilentlyContinue
  Remove-Item $migrationDiagnostics -Force -ErrorAction SilentlyContinue
}
