<#
.SYNOPSIS
  AI Agent Onboarding Scaffolder - Windows / PowerShell

.DESCRIPTION
  Reads onboard.manifest.json and:
    1. Creates the directory structure
    2. Copies template files (never overwrites existing files unless --force)
    3. Checks which skills are missing across 4 locations
    4. With -InstallSkills: installs missing skills via npx skills add
    5. With -UpdateSkills: updates already-installed skills via npx skills update
    6. Merges MCP server config (non-destructive) for the target agent
    7. With -ConfigOnly: skips templates, only configures skills + MCP (for existing projects)
    8. Prints a summary report
    9. Registers the project + records .agents/onboarding-state.json (best-effort, needs node)

.PARAMETER Target
  Target directory to scaffold into. Defaults to current directory.

.PARAMETER Agent
  Which agent profile to use (from manifest agentProfiles).
  Determines MCP config path, instructions file, and skill dirs.
  Default: devin. Options: devin, hermes, opencode, claude-code, cursor, windsurf, omp

.PARAMETER InstallSkills
  Install missing required skills via npx skills add.

.PARAMETER UpdateSkills
  Update already-installed skills via npx skills update.

.PARAMETER ConfigOnly
  Skip template scaffolding. Only configure skills + MCP for the target agent.
  Use this when onboarding an additional agent to an existing project.

.PARAMETER Force
  Overwrite existing template files.

.PARAMETER ManifestPath
  Path to the manifest file. Defaults to ./onboard.manifest.json next to this script.

.EXAMPLE
  .\scaffold.ps1 -Target C:\Users\me\projects\my-new-project
  .\scaffold.ps1 -Target . -InstallSkills
  .\scaffold.ps1 -Target . -Agent hermes -ConfigOnly
  .\scaffold.ps1 -Target . -Agent devin -ConfigOnly -InstallSkills
#>
param(
    [string]$Target = (Get-Location).Path,
    [string]$Agent = "devin",
    [switch]$InstallSkills,
    [switch]$UpdateSkills,
    [switch]$ConfigOnly,
    [switch]$Force,
    [switch]$DryRun,
    [string]$OnlyFile = "",
    [string]$ManifestPath = ""
)

$ErrorActionPreference = "Stop"

# --- dry-run / --only machinery ---
# Dry run performs all reads (existence + skill detection) so rows reflect
# reality, but every mutation is replaced by a fact row. Write-Host goes to
# the console (not stdout), so the JSON array at the end is clean output.
$script:rows = [System.Collections.ArrayList]::new()
function Add-Row {
    param([string]$Artifact, [string]$Action, [string]$Detail = "", [bool]$Global = $false)
    $row = [ordered]@{ artifact = $Artifact; action = $Action }
    if ($Detail) { $row.detail = $Detail }
    if ($Global) { $row.global = $true }
    [void]$script:rows.Add([PSCustomObject]$row)
}
function Test-Allowed {
    param([string]$Artifact)
    if (-not $OnlyFile -or -not (Test-Path $OnlyFile)) { return $true }
    $listed = Get-Content $OnlyFile | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    $norm = $Artifact -replace '\\', '/'
    if ($listed -contains $norm) { return $true }
    $parent = Split-Path -Parent $norm
    if ($parent -and ($listed -contains $parent)) { return $true }
    return $false
}

$ErrorActionPreference = "Stop"

# Resolve manifest path
if (-not $ManifestPath) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ManifestPath = Join-Path $ScriptDir "onboard.manifest.json"
}

if (-not (Test-Path $ManifestPath)) {
    Write-Error "Manifest not found: $ManifestPath"
    exit 1
}

$manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
$TemplateRoot = Split-Path -Parent $ManifestPath

# UTF-8 without BOM: PS 5.1's `-Encoding UTF8` prepends a BOM that breaks
# JSON.parse in bin/lib/* (sync then reports the file as invalid).
function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

# Resolve agent profile
$profile = $null
if ($manifest.agentProfiles.PSObject.Properties.Name -contains $Agent) {
    $profile = $manifest.agentProfiles.$Agent
} else {
    Write-Error "Agent profile '$Agent' not found in manifest. Available: $($manifest.agentProfiles.PSObject.Properties.Name -join ', ')"
    exit 1
}

Write-Host "`n=== AI Agent Onboarding Scaffolder ===" -ForegroundColor Cyan
Write-Host "Target:        $Target"
Write-Host "Agent:         $Agent"
Write-Host "Manifest:      $ManifestPath"
Write-Host "Config only:   $ConfigOnly"
Write-Host "Install skills: $InstallSkills"
Write-Host "Update skills:  $UpdateSkills`n"

# --- 1. Create directories ---
if (-not $ConfigOnly) {
    Write-Host "--- Directories ---" -ForegroundColor Yellow
    foreach ($dir in $manifest.directories) {
        $destDir = Join-Path $Target $dir
        if (-not (Test-Allowed $dir)) { continue }
        if (Test-Path $destDir) {
            Write-Host "  [exists]  $dir"
            Add-Row $dir "exists-skip" "directory exists"
        } elseif ($DryRun) {
            Write-Host "  [would create] $dir"
            Add-Row $dir "create" "create directory"
        } else {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
            Write-Host "  [created] $dir" -ForegroundColor Green
        }
    }

    # --- 2. Copy templates ---
    Write-Host "`n--- Templates ---" -ForegroundColor Yellow
    $createdCount = 0
    $skippedCount = 0
    foreach ($tmpl in $manifest.templates) {
        $srcPath = Join-Path $TemplateRoot $tmpl.src
        $destPath = Join-Path $Target $tmpl.dest
        $destDir = Split-Path -Parent $destPath

        if (-not (Test-Path $srcPath)) {
            Write-Host "  [missing source] $($tmpl.src)" -ForegroundColor Red
            continue
        }

        $shouldOverwrite = $Force -or $tmpl.overwrite
        $existedBefore = Test-Path $destPath
        if ((-not $shouldOverwrite) -and $existedBefore) {
            Write-Host "  [skip exists] $($tmpl.dest)"
            Add-Row $tmpl.dest "exists-skip" "file exists; kit never overwrites it"
            $skippedCount++
            continue
        }
        if (-not (Test-Allowed $tmpl.dest)) { continue }
        if ($DryRun) {
            Write-Host "  [would create] $($tmpl.dest)"
            Add-Row $tmpl.dest "create" "install template"
            $createdCount++
            continue
        }

        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }

        $srcText = Get-Content $srcPath -Raw
        if ($srcText -match '\{\{KIT_REGION\}\}') {
            # Expand the kit-region directive: block file content lands
            # between the markers the template already ships.
            $regionSrc = $manifest.managedRegions | Select-Object -First 1 | ForEach-Object { $_.src }
            $regionPath = if ($regionSrc) { Join-Path $TemplateRoot $regionSrc } else { $null }
            if ($regionPath -and (Test-Path $regionPath)) {
                $block = (Get-Content $regionPath -Raw) -replace "`r?`n$", ''
                $srcText = $srcText -replace [regex]::Escape('{{KIT_REGION}}'), [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $block }
            }
        }
        Write-Utf8NoBom -Path $destPath -Text $srcText
        $action = if ($existedBefore) { "overwritten" } else { "created" }
        Write-Host "  [$action] $($tmpl.dest)" -ForegroundColor Green
        $createdCount++
    }
} else {
    Write-Host "--- Config-only mode: skipping templates ---" -ForegroundColor DarkGray
    $createdCount = 0
    $skippedCount = 0
}

# --- 3. Check skills ---
Write-Host "`n--- Skills ---" -ForegroundColor Yellow

$HomeAgents = Join-Path $env:USERPROFILE ".agents\skills"
$installedSkills = @()
$missingSkills = @()
$lockCache = $null

# Load skill-lock.json once
$lockPath = Join-Path $env:USERPROFILE ".agents\.skill-lock.json"
if (Test-Path $lockPath) {
    $lockCache = Get-Content $lockPath -Raw | ConvertFrom-Json
}

# Build skill search paths from agent profile + defaults
$skillSearchDirs = @($HomeAgents)
if ($profile.skillDirs) {
    foreach ($dir in $profile.skillDirs) {
        $expanded = $dir -replace "^~", $env:USERPROFILE
        if ($expanded -ne $HomeAgents -and -not ($skillSearchDirs -contains $expanded)) {
            $skillSearchDirs += $expanded
        }
    }
}
# Add project-level skill dirs
$skillSearchDirs += (Join-Path $Target ".windsurf\skills")
$skillSearchDirs += (Join-Path $Target ".agents\skills")

foreach ($skill in $manifest.skills) {
    $skillName = $skill.name
    $found = $false

    # Check all skill search dirs
    foreach ($searchDir in $skillSearchDirs) {
        $skillPath = Join-Path $searchDir "$skillName\SKILL.md"
        if (Test-Path $skillPath) { $found = $true; break }
    }

    # Check skill-lock.json
    if (-not $found -and $lockCache) {
        if ($lockCache.skills.PSObject.Properties.Name -contains $skillName) { $found = $true }
    }

    $tag = if ($skill.required) { "required" } else { "optional" }
    if ($found) {
        Write-Host "  [installed] $skillName ($tag)" -ForegroundColor DarkGray
        Add-Row $skillName "exists-skip" "skill already installed ($tag)" $true
        $installedSkills += $skill
    } else {
        $color = if ($skill.required) { "Red" } else { "DarkYellow" }
        Write-Host "  [missing]   $skillName ($tag)" -ForegroundColor $color
        $missingSkills += $skill
        Add-Row $skillName "missing-skill" "not installed ($tag): npx skills add $($skill.source)@$($skill.skill) -g -y" $true
    }
}

# --- 4a. Install missing skills ---
if ($InstallSkills -and $missingSkills.Count -gt 0) {
    Write-Host "`n--- Installing Missing Skills ---" -ForegroundColor Yellow
    foreach ($skill in $missingSkills) {
        $cmd = "npx skills add $($skill.source)@$($skill.skill) -g -y"
        Write-Host "  [installing] $cmd" -ForegroundColor Cyan
        if (-not (Test-Allowed $skill.name)) { continue }
        if ($DryRun) {
            Write-Host "  [would install] $cmd" -ForegroundColor Cyan
            Add-Row $skill.name "install-skill" "would run: $cmd" $true
            continue
        }
        Invoke-Expression $cmd
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [done] $($skill.name)" -ForegroundColor Green
        } else {
            Write-Host "  [failed] $($skill.name) - exit code $LASTEXITCODE" -ForegroundColor Red
        }
    }
}

# --- 4b. Update installed skills ---
if ($UpdateSkills -and $installedSkills.Count -gt 0) {
    Write-Host "`n--- Updating Installed Skills ---" -ForegroundColor Yellow
    foreach ($skill in $installedSkills) {
        $cmd = "npx skills update $($skill.source)@$($skill.skill) -g -y"
        Write-Host "  [updating] $($skill.name)" -ForegroundColor Cyan
        if (-not (Test-Allowed $skill.name)) { continue }
        if ($DryRun) {
            Write-Host "  [would update] $cmd" -ForegroundColor Cyan
            Add-Row $skill.name "update-skill" "would run: $cmd" $true
            continue
        }
        Invoke-Expression $cmd
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [done] $($skill.name)" -ForegroundColor Green
        } else {
            Write-Host "  [skipped] $($skill.name) - already up to date or failed" -ForegroundColor DarkGray
        }
    }
}

# --- 4c. Template skills (kit-bundled skills copied to ~/.agents/skills/) ---
# These are skills that ship with the kit (e.g. ui-design-orchestrator) and are
# installed by copying the template dir, NOT via `npx skills add`. They are global
# (shared by all agents) so this runs regardless of ConfigOnly.
$templateSkillsCopied = 0
$templateSkillsSkipped = 0
$templateSkillsMissing = @()
if ($manifest.templateSkills -and $manifest.templateSkills.Count -gt 0) {
    Write-Host "`n--- Template Skills (kit-bundled, global) ---" -ForegroundColor Yellow

    foreach ($tskill in $manifest.templateSkills) {
        $srcPath = Join-Path $TemplateRoot $tskill.src
        $destDir = Join-Path $HomeAgents $tskill.dest
        $destSkillMd = Join-Path $destDir "SKILL.md"

        if (-not (Test-Path $srcPath)) {
            Write-Host "  [missing source] $($tskill.src)" -ForegroundColor Red
            $templateSkillsMissing += $tskill
            continue
        }

        if (Test-Path $destSkillMd) {
            Write-Host "  [exists] $($tskill.dest)" -ForegroundColor DarkGray
            Add-Row $tskill.dest "exists-skip" "template skill already installed" $true
            $templateSkillsSkipped++
            continue
        }

        if (-not (Test-Allowed $tskill.dest)) { continue }
        if ($DryRun) {
            Write-Host "  [would copy] $($tskill.dest) -> ~/.agents/skills/$($tskill.dest)" -ForegroundColor Green
            Add-Row $tskill.dest "copy-skill" "copy kit-bundled skill to ~/.agents/skills/" $true
            $templateSkillsCopied++
            continue
        }
        if (-not (Test-Path $HomeAgents)) {
            New-Item -ItemType Directory -Path $HomeAgents -Force | Out-Null
        }
        # Copy the whole skill directory recursively
        Copy-Item $srcPath $destDir -Recurse -Force
        Write-Host "  [created] $($tskill.dest)" -ForegroundColor Green
        $templateSkillsCopied++
    }
}

# --- 4d. CLI tools (non-skill binaries, e.g. skillui) ---
# Detection only by default; installed with -InstallSkills using each entry's
# "install" command. Not updated by -UpdateSkills (package managers own that).
$cliToolsPresent = 0
$cliToolsMissing = @()
if ($manifest.cliTools -and $manifest.cliTools.Count -gt 0) {
    Write-Host "`n--- CLI Tools ---" -ForegroundColor Yellow
    foreach ($tool in $manifest.cliTools) {
        $found = $false
        if ($tool.check) {
            try {
                Invoke-Expression $tool.check *> $null
                if ($LASTEXITCODE -eq 0) { $found = $true }
            } catch {
                $found = $false
            }
        } elseif (Get-Command $tool.name -ErrorAction SilentlyContinue) {
            $found = $true
        }
        if ($found) {
            Write-Host "  [present] $($tool.name)" -ForegroundColor DarkGray
            $cliToolsPresent++
        } else {
            $tag = if ($tool.required) { "required" } else { "optional" }
            Write-Host "  [missing] $($tool.name) ($tag) - $($tool.install)" -ForegroundColor DarkYellow
            Add-Row $tool.name "missing-skill" "CLI tool missing ($tag): $($tool.install)" $true
            $cliToolsMissing += $tool
        }
    }
    if ($InstallSkills -and $cliToolsMissing.Count -gt 0) {
        foreach ($tool in $cliToolsMissing) {
            Write-Host "  [installing] $($tool.install)" -ForegroundColor Cyan
            Invoke-Expression $tool.install
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  [done] $($tool.name)" -ForegroundColor Green
            } else {
                Write-Host "  [failed] $($tool.name) - exit code $LASTEXITCODE" -ForegroundColor Red
            }
        }
    }
}

# --- 5. MCP server config (non-destructive merge) ---
Write-Host "`n--- MCP Servers (agent: $Agent) ---" -ForegroundColor Yellow

$mcpConfigPath = $profile.mcpConfigPath
if ($mcpConfigPath.StartsWith("~")) {
    $mcpConfigPath = $mcpConfigPath -replace "^~", $env:USERPROFILE
} elseif ($mcpConfigPath.StartsWith(".")) {
    $mcpConfigPath = Join-Path $Target $mcpConfigPath
} else {
    $mcpConfigPath = Join-Path $Target $mcpConfigPath
}
$mcpConfigDir = Split-Path -Parent $mcpConfigPath

# Load existing MCP config or start empty
$configExisted = Test-Path $mcpConfigPath
if ($configExisted) {
    $existingJson = Get-Content $mcpConfigPath -Raw
    Write-Host "  [exists] $($profile.mcpConfigPath)" -ForegroundColor DarkGray
} else {
    $existingJson = '{"mcpServers":{}}'
    Write-Host "  [new] $($profile.mcpConfigPath)" -ForegroundColor Green
}

# Parse existing server names
$existingObj = $existingJson | ConvertFrom-Json
$existingNames = @()
if ($existingObj.mcpServers) {
    $existingNames = $existingObj.mcpServers.PSObject.Properties.Name
}

$mcpAdded = 0
$mcpExists = 0
$mcpMissing = @()
$serversToAdd = @()

foreach ($mcp in $manifest.mcpServers) {
    if ($mcp.tier -eq 'specialist') { continue }  # specialist servers go to profile destinations only
    $mcpName = $mcp.name
    if ($existingNames -contains $mcpName) {
        Write-Host "  [exists]   $mcpName" -ForegroundColor DarkGray
        $mcpExists++
    } else {
        $serversToAdd += $mcp
        $mcpAdded++
        $tag = if ($mcp.required) { "required" } else { "optional" }
        Write-Host "  [added]    $mcpName ($tag)" -ForegroundColor Green
    }
}

# Write MCP config if we added anything or the file didn't exist
if ($DryRun -and ($mcpAdded -gt 0 -or -not $configExisted)) {
    Write-Host "  [would write] $mcpConfigPath" -ForegroundColor Green
    Add-Row $profile.mcpConfigPath "merge-keys" "add $mcpAdded server(s): $(($serversToAdd | ForEach-Object { $_.name }) -join ', ')"
} elseif (($mcpAdded -gt 0 -or -not $configExisted) -and (Test-Allowed $profile.mcpConfigPath)) {
    if (-not (Test-Path $mcpConfigDir)) {
        New-Item -ItemType Directory -Path $mcpConfigDir -Force | Out-Null
    }

    # Build new config by merging: start from existing, add new servers
    $configObj = $existingJson | ConvertFrom-Json
    if (-not $configObj.mcpServers) {
        $configObj | Add-Member -NotePropertyName mcpServers -NotePropertyValue (New-Object PSObject)
    }

    foreach ($mcp in $serversToAdd) {
        $serverObj = [PSCustomObject]@{
            command = $mcp.config.command
            args    = $mcp.config.args
            env     = $mcp.config.env
        }
        $configObj.mcpServers | Add-Member -NotePropertyName $mcp.name -NotePropertyValue $serverObj
    }

    Write-Utf8NoBom -Path $mcpConfigPath -Text ($configObj | ConvertTo-Json -Depth 10)
    Write-Host "  [written]  $mcpConfigPath" -ForegroundColor Green
}

# --- 5b. Hooks config (non-destructive merge) ---
$hooksAdded = 0
$hooksExists = 0
if ($profile.hooksConfigPath -and $profile.hooksConfigFormat) {
    Write-Host "`n--- Hooks (agent: $Agent) ---" -ForegroundColor Yellow

    $hooksConfigPath = $profile.hooksConfigPath
    if ($hooksConfigPath.StartsWith("~")) {
        $hooksConfigPath = $hooksConfigPath -replace "^~", $env:USERPROFILE
    } else {
        $hooksConfigPath = Join-Path $Target $hooksConfigPath
    }
    $hooksConfigDir = Split-Path -Parent $hooksConfigPath

    $hooksConfigExisted = Test-Path $hooksConfigPath
    if ($hooksConfigExisted) {
        $existingHooksJson = Get-Content $hooksConfigPath -Raw
        Write-Host "  [exists] $($profile.hooksConfigPath)" -ForegroundColor DarkGray
    } else {
        $existingHooksJson = $null
        Write-Host "  [new]    $($profile.hooksConfigPath)" -ForegroundColor Green
    }

    # Parse existing hooks to check which are already present
    $existingHookKeys = @()
    if ($existingHooksJson) {
        $existingHooksObj = $existingHooksJson | ConvertFrom-Json
        # For standalone format, the top-level keys are event names
        # For nested format, the keys are under "hooks"
        $hooksRoot = if ($profile.hooksConfigFormat -eq "nested") { $existingHooksObj.hooks } else { $existingHooksObj }
        if ($hooksRoot) {
            $existingHookKeys = $hooksRoot.PSObject.Properties.Name
        }
    }

    # Group hooks by event
    $hooksByEvent = @{}
    foreach ($hook in $manifest.hooks) {
        if (-not $hooksByEvent.ContainsKey($hook.event)) {
            $hooksByEvent[$hook.event] = @()
        }
        $hooksByEvent[$hook.event] += $hook
    }

    $hooksToAdd = @{}

    foreach ($eventName in $hooksByEvent.Keys) {
        $eventHooks = $hooksByEvent[$eventName]
        if ($existingHookKeys -contains $eventName) {
            Write-Host "  [exists]   $eventName ($($eventHooks.Count) hook(s))" -ForegroundColor DarkGray
            $hooksExists++
        } else {
            $hooksToAdd[$eventName] = $eventHooks
            $hooksAdded++
            Write-Host "  [added]    $eventName ($($eventHooks.Count) hook(s))" -ForegroundColor Green
        }
    }

    # Write hooks config if we added anything or the file didn't exist
    if ($DryRun -and ($hooksAdded -gt 0 -or -not $hooksConfigExisted)) {
        Write-Host "  [would write] $hooksConfigPath" -ForegroundColor Green
        Add-Row $profile.hooksConfigPath "merge-keys" "add $hooksAdded hook event(s): $(($hooksToAdd.Keys) -join ', ')"
    } elseif (($hooksAdded -gt 0 -or -not $hooksConfigExisted) -and (Test-Allowed $profile.hooksConfigPath)) {
        if (-not (Test-Path $hooksConfigDir)) {
            New-Item -ItemType Directory -Path $hooksConfigDir -Force | Out-Null
        }

        # Build hooks object
        $hooksObj = New-Object PSObject

        # Start from existing if present
        if ($existingHooksJson) {
            $existingObj = $existingHooksJson | ConvertFrom-Json
            if ($profile.hooksConfigFormat -eq "nested") {
                if ($existingObj.hooks) {
                    $hooksObj = $existingObj.hooks
                }
                # Also preserve non-hooks keys
                $configWrapper = $existingObj
            } else {
                $hooksObj = $existingObj
                $configWrapper = $null
            }
        } else {
            $configWrapper = $null
        }

        # Add new event hooks
        foreach ($eventName in $hooksToAdd.Keys) {
            $hookEntries = @()
            foreach ($hook in $hooksToAdd[$eventName]) {
                $hookEntry = [PSCustomObject]@{
                    matcher = $hook.matcher
                    hooks   = @(
                        [PSCustomObject]@{
                            type    = $hook.type
                            command = $hook.command
                        }
                    )
                }
                $hookEntries += $hookEntry
            }
            $hooksObj | Add-Member -NotePropertyName $eventName -NotePropertyValue $hookEntries
        }

        # Write in the right format
        if ($profile.hooksConfigFormat -eq "nested") {
            if ($configWrapper) {
                if ($configWrapper.PSObject.Properties.Name -contains "hooks") {
                    $configWrapper.hooks = $hooksObj
                } else {
                    $configWrapper | Add-Member -NotePropertyName hooks -NotePropertyValue $hooksObj
                }
                Write-Utf8NoBom -Path $hooksConfigPath -Text ($configWrapper | ConvertTo-Json -Depth 10)
            } else {
                Write-Utf8NoBom -Path $hooksConfigPath -Text ([PSCustomObject]@{ hooks = $hooksObj } | ConvertTo-Json -Depth 10)
            }
        } else {
            # Standalone: the hooks object IS the entire file
            Write-Utf8NoBom -Path $hooksConfigPath -Text ($hooksObj | ConvertTo-Json -Depth 10)
        }
        Write-Host "  [written]  $hooksConfigPath" -ForegroundColor Green
    }
} else {
    Write-Host "`n--- Hooks: agent '$Agent' does not support hooks ---" -ForegroundColor DarkGray
}

# --- 5c. Rules (copy rule templates to agent rules dir) ---
$rulesCopied = 0
$rulesSkipped = 0
if ($profile.rulesEnabled -and $profile.rulesDir -and $manifest.rules) {
    Write-Host "`n--- Rules (agent: $Agent) ---" -ForegroundColor Yellow

    $rulesDirPath = $profile.rulesDir
    if ($rulesDirPath.StartsWith("~")) {
        $rulesDirPath = $rulesDirPath -replace "^~", $env:USERPROFILE
    } else {
        $rulesDirPath = Join-Path $Target $rulesDirPath
    }

    if (-not (Test-Path $rulesDirPath)) {
        if (-not $DryRun) { New-Item -ItemType Directory -Path $rulesDirPath -Force | Out-Null }
    }

    foreach ($rule in $manifest.rules) {
        $srcPath = Join-Path $TemplateRoot $rule.src
        $destPath = Join-Path $rulesDirPath $rule.dest

        if (-not (Test-Path $srcPath)) {
            Write-Host "  [missing source] $($rule.src)" -ForegroundColor Red
            continue
        }

        $shouldOverwrite = $Force -or $rule.overwrite
        if ((-not $shouldOverwrite) -and (Test-Path $destPath)) {
            Write-Host "  [skip exists] $($rule.dest)" -ForegroundColor DarkGray
            Add-Row "$($profile.rulesDir)/$($rule.dest)" "exists-skip" "rule file exists; not overwritten"
            $rulesSkipped++
            continue
        }
        if (-not (Test-Allowed "$($profile.rulesDir)/$($rule.dest)")) { continue }
        if ($DryRun) {
            Write-Host "  [would create] $($rule.dest)" -ForegroundColor Green
            Add-Row "$($profile.rulesDir)/$($rule.dest)" "create" "install $Agent rule"
            $rulesCopied++
            continue
        }
        Copy-Item $srcPath $destPath -Force
        Write-Host "  [created] $($rule.dest)" -ForegroundColor Green
        $rulesCopied++
    }
} else {
    Write-Host "`n--- Rules: agent '$Agent' does not support rule directories ---" -ForegroundColor DarkGray
}

# --- 6. Summary ---
Write-Host "`n=== Summary ===" -ForegroundColor Cyan
if (-not $ConfigOnly) {
    Write-Host "  Templates created: $createdCount"
    Write-Host "  Templates skipped: $skippedCount (already exist)"
}
Write-Host "  Skills installed:  $($installedSkills.Count)"
Write-Host "  Skills missing:    $($missingSkills.Count)"
Write-Host "  Template skills created: $templateSkillsCopied"
Write-Host "  Template skills skipped: $templateSkillsSkipped (already exist)"
Write-Host "  MCP servers present: $mcpExists"
Write-Host "  MCP servers added:   $mcpAdded"
Write-Host "  Hooks present:       $hooksExists"
Write-Host "  Hooks added:         $hooksAdded"
Write-Host "  Rules created:       $rulesCopied"
Write-Host "  Rules skipped:       $rulesSkipped"
if ($manifest.cliTools) {
    Write-Host "  CLI tools present:   $cliToolsPresent"
    Write-Host "  CLI tools missing:   $($cliToolsMissing.Count)"
}

$missingRequired = $missingSkills | Where-Object { $_.required }
if ($missingRequired.Count -gt 0) {
    Write-Host "`n  Missing REQUIRED skills:" -ForegroundColor Red
    foreach ($s in $missingRequired) {
        Write-Host "    - $($s.name): npx skills add $($s.source)@$($s.skill) -g -y"
    }
    if (-not $InstallSkills) {
        Write-Host "`n  Re-run with -InstallSkills to install them." -ForegroundColor Yellow
    }
}

$missingOptional = $missingSkills | Where-Object { -not $_.required }
if ($missingOptional.Count -gt 0) {
    Write-Host "`n  Missing OPTIONAL skills (install on demand):" -ForegroundColor DarkYellow
    foreach ($s in $missingOptional) {
        Write-Host "    - $($s.name): npx skills add $($s.source)@$($s.skill) -g -y"
    }
}

# --- 7. Next steps ---
Write-Host "`n=== Next Steps ===" -ForegroundColor Cyan
if ($ConfigOnly) {
    Write-Host "  Agent '$Agent' configured for this project."
    Write-Host "  Skills are shared globally via ~/.agents/skills/"
    Write-Host "  MCP config written to: $($profile.mcpConfigPath)"
} else {
    Write-Host "  1. Fill {{placeholders}} in generated files (or invoke prompts/onboard-fill.md with your agent runner)"
    Write-Host '  2. Run: npx skills add <source>@<skill> -g -y  for any missing skills'
    Write-Host "  3. Commit the scaffolded files to your repo"
}
if ($manifest.agentProfiles.PSObject.Properties.Name -contains $Agent) {
    $otherAgents = $manifest.agentProfiles.PSObject.Properties.Name | Where-Object { $_ -ne $Agent }
    Write-Host "`n  To onboard additional agents to this project:"
    foreach ($a in $otherAgents) {
        Write-Host "    .\scaffold.ps1 -Target `"$Target`" -Agent $a -ConfigOnly -InstallSkills"
    }
}
Write-Host ""

# --- 8. Onboarding registry + state (best-effort, requires Node.js) ---
# Never fails the scaffold: warns and continues when node or the CLI is missing.
$onboardCli = Join-Path $TemplateRoot "bin\onboard.mjs"
if ((Test-Path $onboardCli) -and -not $DryRun) {
    $nodeExe = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeExe) {
        try {
            $resolvedTarget = (Resolve-Path $Target).Path
            $projectName = Split-Path -Leaf $resolvedTarget
            # Foreign instructions files gain the kit region via node
            # (shared marker-injection implementation with sync). Runs
            # before record-state so the region is recorded too.
            & node $onboardCli inject-regions --path $resolvedTarget --manifest $ManifestPath --agents $Agent | Write-Host
            & node $onboardCli register --name $projectName --path $resolvedTarget --agents $Agent | Write-Host
            if ($LASTEXITCODE -ne 0) { throw "onboard.mjs register exited $LASTEXITCODE" }
            & node $onboardCli record-state --path $resolvedTarget --manifest $ManifestPath | Write-Host
            if ($LASTEXITCODE -ne 0) { throw "onboard.mjs record-state exited $LASTEXITCODE" }
        } catch {
            Write-Host "WARNING: onboarding registry/state recording failed (non-fatal): $_" -ForegroundColor DarkYellow
        }
    } else {
        Write-Host "WARNING: node not found - skipping onboarding registry/state recording." -ForegroundColor DarkYellow
    }
}
elseif ($DryRun) {
    Write-Host "  [would run] inject-regions + register + record-state" -ForegroundColor DarkGray
    Add-Row "(project)" "register" "register project in kit registry (node preview owns the diff)"
}

# --- dry-run plan JSON (stdout; Write-Host output goes to the console on
# PS5 but can leak into stdout - the @@PLAN_JSON@@ sentinel marks where
# the real payload begins so node callers can split on it) ---
if ($DryRun) {
    "@@PLAN_JSON@@" | Write-Output
    $script:rows | ConvertTo-Json -Depth 5 | Write-Output
}
