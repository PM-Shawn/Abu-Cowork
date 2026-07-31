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
$updaterRelaunchVerified = $false
$upgradeFixtureName = "ci-electron-transition-$PID"
$tauriFixture = Join-Path $env:APPDATA "com.abu.app\conversations\$upgradeFixtureName"
$electronFixture = Join-Path $env:APPDATA "com.abu.app.electron\conversations\$upgradeFixtureName"
$migrationBackupRoot = Join-Path $env:APPDATA "com.abu.app.electron-backups"
$migrationDiagnostics = Join-Path $env:RUNNER_TEMP `
  "abu-electron-migration-$upgradeFixtureName.json"
$expectMigration = $env:ABU_EXPECT_TAURI_MIGRATION -eq "true"
$tauriInstallRoot = Join-Path $env:LOCALAPPDATA "Abu"
$tauriRollbackMarker = Join-Path $tauriInstallRoot "$upgradeFixtureName.rollback"
$tauriLegacyExe = Join-Path $tauriInstallRoot "abu.exe"
$tauriLegacyUninstaller = Join-Path $tauriInstallRoot "uninstall.exe"
$tauriLegacyUninstallKey = `
  "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Abu"
$tauriTransitionHiddenMarker = "AbuElectronTransitionHidden"
$createdLegacyUninstallFixture = $false

try {
  if ($expectMigration) {
    if (Test-Path $tauriLegacyUninstallKey) {
      throw "CI runner already has a legacy Abu uninstall entry; refusing to overwrite it"
    }
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
    Set-Content -Path $tauriLegacyExe -Value "ci-tauri-exe-fixture" -NoNewline
    Set-Content -Path $tauriLegacyUninstaller -Value "ci-tauri-uninstaller-fixture" -NoNewline
    New-Item -Path $tauriLegacyUninstallKey -Force | Out-Null
    $createdLegacyUninstallFixture = $true
    New-ItemProperty -Path $tauriLegacyUninstallKey -Name "DisplayName" `
      -Value "Abu" -PropertyType String | Out-Null
    New-ItemProperty -Path $tauriLegacyUninstallKey -Name "DisplayVersion" `
      -Value "0.33.0" -PropertyType String | Out-Null
    New-ItemProperty -Path $tauriLegacyUninstallKey -Name "InstallLocation" `
      -Value "`"$tauriInstallRoot`"" -PropertyType String | Out-Null
    New-ItemProperty -Path $tauriLegacyUninstallKey -Name "UninstallString" `
      -Value "`"$tauriLegacyUninstaller`"" -PropertyType String | Out-Null
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

  if ($expectMigration) {
    # The Tauri updater argument family asks NSIS to relaunch the installed
    # application through the Windows shell. That shell launch intentionally
    # does not inherit this PowerShell process's CI-only environment variables,
    # so the real application must stop at its user confirmation dialog. Verify
    # that updater handoff first, then close it and perform a second explicit
    # launch that inherits the triple-gated unattended migration controls.
    $updaterLaunchDeadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $updaterLaunchDeadline) {
      Start-Sleep -Milliseconds 500
      $installedProcesses = @(
        Get-Process -Name "Abu" -ErrorAction SilentlyContinue |
          Where-Object {
            $beforePids -notcontains $_.Id -and
            $_.Path -and
            [System.IO.Path]::GetFullPath($_.Path).Equals(
              $installedPath,
              [System.StringComparison]::OrdinalIgnoreCase
            )
          }
      )
      if ($installedProcesses | Where-Object { $_.MainWindowHandle -ne 0 }) {
        $updaterRelaunchVerified = $true
        break
      }
    }
    if (-not $updaterRelaunchVerified) {
      throw "Tauri updater arguments did not relaunch the installed Electron app"
    }
    foreach ($process in $installedProcesses) {
      if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      }
    }
    $shutdownDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $installedProcesses = @(
        Get-Process -Name "Abu" -ErrorAction SilentlyContinue |
          Where-Object {
            $beforePids -notcontains $_.Id -and
            $_.Path -and
            [System.IO.Path]::GetFullPath($_.Path).Equals(
              $installedPath,
              [System.StringComparison]::OrdinalIgnoreCase
            )
          }
      )
    } while ($installedProcesses.Count -gt 0 -and [DateTime]::UtcNow -lt $shutdownDeadline)
    if ($installedProcesses.Count -gt 0) {
      throw "Updater-relaunched Electron app did not stop before migration smoke"
    }
  }
  $installedProcess = Start-Process -FilePath $installedPath -PassThru
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
    $legacyConvergenceDeadline = [DateTime]::UtcNow.AddSeconds(15)
    $legacySystemComponent = $null
    while ([DateTime]::UtcNow -lt $legacyConvergenceDeadline) {
      # The value is intentionally absent until the migrated main window is
      # ready. Get-ItemPropertyValue treats that normal transient state as an
      # error under PowerShell 7, so inspect the optional property instead of
      # aborting the convergence poll on its first iteration.
      $legacyEntry = Get-ItemProperty -Path $tauriLegacyUninstallKey -ErrorAction Stop
      $legacySystemComponent = $legacyEntry.SystemComponent
      if ($legacySystemComponent -eq 1) {
        break
      }
      Start-Sleep -Milliseconds 250
    }
    if ($legacySystemComponent -ne 1) {
      throw "Electron did not hide the recognized legacy Tauri uninstall entry"
    }
    $legacyTransitionMarker = Get-ItemPropertyValue -Path $tauriLegacyUninstallKey `
      -Name $tauriTransitionHiddenMarker -ErrorAction SilentlyContinue
    if ($legacyTransitionMarker -ne 1) {
      throw "Electron did not record how to restore the legacy Tauri uninstall entry"
    }
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
  if ($createdLegacyUninstallFixture) {
    if (-not (Test-Path $tauriLegacyUninstallKey)) {
      throw "Electron uninstall deleted the legacy Tauri uninstall entry"
    }
    $restoredLegacyEntry = Get-ItemProperty -Path $tauriLegacyUninstallKey
    $expectedLegacyInstallLocation = "`"$tauriInstallRoot`""
    $expectedLegacyUninstallString = "`"$tauriLegacyUninstaller`""
    if (
      $restoredLegacyEntry.DisplayName -ne "Abu" -or
      $restoredLegacyEntry.DisplayVersion -ne "0.33.0" -or
      $restoredLegacyEntry.InstallLocation -ne $expectedLegacyInstallLocation -or
      $restoredLegacyEntry.UninstallString -ne $expectedLegacyUninstallString
    ) {
      throw "Electron uninstall corrupted the legacy Tauri uninstall entry"
    }
    if ($restoredLegacyEntry.SystemComponent -eq 1) {
      throw "Electron uninstall did not restore the legacy Tauri uninstall entry"
    }
    if ($null -ne $restoredLegacyEntry.$tauriTransitionHiddenMarker) {
      throw "Electron uninstall did not clear the legacy Tauri transition marker"
    }
    if (-not (Test-Path $tauriLegacyExe) -or -not (Test-Path $tauriLegacyUninstaller)) {
      throw "Electron uninstall removed a preserved Tauri rollback executable"
    }
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
  Remove-Item $tauriLegacyExe -Force -ErrorAction SilentlyContinue
  Remove-Item $tauriLegacyUninstaller -Force -ErrorAction SilentlyContinue
  if ($createdLegacyUninstallFixture) {
    Remove-Item $tauriLegacyUninstallKey -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item Env:ABU_E2E_AUTO_CONFIRM_TRANSITION -ErrorAction SilentlyContinue
  Remove-Item Env:ABU_E2E_MIGRATION_DIAGNOSTICS_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:ABU_PACKAGED_E2E -ErrorAction SilentlyContinue
  Remove-Item $migrationDiagnostics -Force -ErrorAction SilentlyContinue
}

Write-Host "[windows-installed-smoke] PASS"
Write-Host "installer=$($installer.FullName)"
Write-Host "installedExe=$installedPath"
Write-Host "installScope=current-user"
Write-Host "signature=unsigned"
Write-Host "tauriMigration=$expectMigration"
Write-Host "tauriUpdaterArguments=$expectMigration"
Write-Host "updaterRelaunchVerified=$updaterRelaunchVerified"
Write-Host "tauriRollbackPreserved=$expectMigration"
