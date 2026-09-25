<#
.SYNOPSIS
  Sync agent-agnostic skills from skills/ into .claude/skills/ so Claude Code
  can discover them.

.DESCRIPTION
  Claude Code only discovers skills from ./.claude/skills/ (project) and
  ~/.claude/skills/ (user) - it has no config for pointing at an arbitrary
  directory. This script copies only each skill's SKILL.md into
  .claude/skills/<name>/SKILL.md, rewriting the {{SKILL_ROOT}} token to a
  relative path back to skills/<name>/. Supporting folders (scripts/,
  references/, etc.) are never duplicated - SKILL.md always points back at
  skills/<name>/ for those, so skills/ stays the single source of truth for
  everything except this one generated, rewritten file.

.PARAMETER Skill
  Sync only the named skill instead of all skills.

.EXAMPLE
  ./adapters/claude-code/sync.ps1

.EXAMPLE
  ./adapters/claude-code/sync.ps1 -Skill file-to-template

.EXAMPLE
  ./adapters/claude-code/sync.ps1 -WhatIf
  # Common parameter from SupportsShouldProcess: preview without copying.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Skill
)

$ErrorActionPreference = 'Stop'

# Repo root is two levels up from this script (adapters/claude-code/sync.ps1).
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$sourceDir = Join-Path $repoRoot 'skills'
$destRoot = Join-Path $repoRoot '.claude\skills'

if (-not (Test-Path $sourceDir)) {
    throw "Source skills directory not found: $sourceDir"
}

if (-not (Test-Path $destRoot)) {
    New-Item -ItemType Directory -Path $destRoot -Force | Out-Null
}

$skillDirs = Get-ChildItem -Path $sourceDir -Directory
if ($Skill) {
    $skillDirs = $skillDirs | Where-Object { $_.Name -eq $Skill }
    if (-not $skillDirs) {
        throw "No skill named '$Skill' found under $sourceDir"
    }
}

if (-not $skillDirs) {
    Write-Warning "No skills found under $sourceDir"
    exit 0
}

foreach ($dir in $skillDirs) {
    $sourceSkillMd = Join-Path $dir.FullName 'SKILL.md'
    if (-not (Test-Path $sourceSkillMd)) {
        Write-Warning "Skipping '$($dir.Name)': no SKILL.md found"
        continue
    }

    $destDir = Join-Path $destRoot $dir.Name
    $destSkillMd = Join-Path $destDir 'SKILL.md'

    # Relative path from .claude/skills/<name>/ back to skills/<name>/, as
    # POSIX-style forward slashes so it reads consistently regardless of
    # platform and works whether the string is used in a shell command or
    # just as a path prefix in prose.
    $skillRoot = "../../../skills/$($dir.Name)"

    if ($PSCmdlet.ShouldProcess($destSkillMd, "Write SKILL.md with {{SKILL_ROOT}} -> $skillRoot")) {
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        $content = Get-Content -Path $sourceSkillMd -Raw -Encoding utf8
        $content = $content.Replace('{{SKILL_ROOT}}', $skillRoot)
        Set-Content -Path $destSkillMd -Value $content -NoNewline -Encoding utf8
        Write-Host "Synced: $($dir.Name) -> .claude/skills/$($dir.Name)/SKILL.md"
    }
}

Write-Host "Done. Only SKILL.md is copied (with {{SKILL_ROOT}} rewritten) - supporting folders stay in skills/*. Re-run after editing any skill's SKILL.md."
