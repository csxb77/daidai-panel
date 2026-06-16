param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "[FAIL] $Message" -ForegroundColor Red
    exit 1
}

function Assert-FileContains {
    param(
        [string]$Path,
        [string]$Pattern,
        [string]$Description
    )

    $text = Get-Content -Path $Path -Raw -Encoding UTF8
    if ($text -notmatch $Pattern) {
        Fail-Step "$Description not synced: $Path"
    }
}

function Assert-FileTextContains {
    param(
        [string]$Path,
        [string]$Text,
        [string]$Description
    )

    $content = Get-Content -Path $Path -Raw -Encoding UTF8
    if (-not $content.Contains($Text)) {
        Fail-Step "$Description not synced: $Path"
    }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$normalizedVersion = $Version.Trim()
if ($normalizedVersion -notmatch '^\d+\.\d+\.\d+$') {
    Fail-Step "Version must use X.Y.Z format, for example 2.2.20"
}

$tagVersion = "v$normalizedVersion"
$versionCode = $null
try {
    $parts = $normalizedVersion.Split(".")
    $versionCode = ([int]$parts[0] * 10000) + ([int]$parts[1] * 100) + ([int]$parts[2])
} catch {
    Fail-Step "Unable to compute versionCode for $normalizedVersion"
}

Set-Location $repoRoot

Write-Step "Check git worktree"
$status = git status --short
if ($status) {
    Fail-Step "Worktree is dirty. Commit or clean changes before release.`n$status"
}

Write-Step "Check version file sync"
$releaseNotePath = Join-Path $repoRoot "docs\release-notes\$tagVersion.md"
if (-not (Test-Path $releaseNotePath)) {
    Fail-Step "Missing release notes file: $releaseNotePath"
}

Assert-FileContains -Path $releaseNotePath -Pattern '<!--\s*release-title:\s*.+?\s*-->' -Description "release notes title marker"
Assert-FileContains -Path (Join-Path $repoRoot "README.md") -Pattern ([regex]::Escape("最新稳定版：") + '.*' + [regex]::Escape($tagVersion)) -Description "README latest version"
Assert-FileTextContains -Path (Join-Path $repoRoot "README.md") -Text "./docs/release-notes/$tagVersion.md" -Description "README release notes link"
Assert-FileContains -Path (Join-Path $repoRoot "Magisk\module.prop") -Pattern "^version=$([regex]::Escape($tagVersion))$" -Description "Magisk module.prop version"
Assert-FileContains -Path (Join-Path $repoRoot "Magisk\module.prop") -Pattern "^versionCode=$versionCode$" -Description "Magisk module.prop versionCode"
Assert-FileContains -Path (Join-Path $repoRoot "Magisk\update.json") -Pattern [regex]::Escape('"version": "' + $tagVersion + '"') -Description "Magisk update.json version"
Assert-FileContains -Path (Join-Path $repoRoot "Magisk\update.json") -Pattern [regex]::Escape('"versionCode": ' + $versionCode) -Description "Magisk update.json versionCode"
Assert-FileContains -Path (Join-Path $repoRoot "Magisk\update.json") -Pattern [regex]::Escape("/releases/download/$tagVersion/daidai-panel-magisk-$tagVersion.zip") -Description "Magisk update.json zipUrl"
Assert-FileContains -Path (Join-Path $repoRoot "Magisk\update.json") -Pattern [regex]::Escape("/docs/release-notes/$tagVersion.md") -Description "Magisk update.json changelog"

Write-Step "Run backend tests"
Push-Location (Join-Path $repoRoot "server")
try {
    go test ./...
} finally {
    Pop-Location
}

Write-Step "Run frontend build"
Push-Location (Join-Path $repoRoot "web")
try {
    npm run build
} finally {
    Pop-Location
}

Write-Step "Check release workflow YAML"
$workflowPath = Join-Path $repoRoot ".github\workflows\release.yml"
if (-not (Test-Path $workflowPath)) {
    Fail-Step "Missing release workflow: $workflowPath"
}

$actionlint = Get-Command actionlint -ErrorAction SilentlyContinue
if ($actionlint) {
    & $actionlint.Source $workflowPath
} else {
    Write-Host "[WARN] actionlint not found, skip local workflow lint." -ForegroundColor Yellow
}

Write-Step "Check remote tag conflict"
git fetch origin --tags | Out-Null
$remoteTagExists = git ls-remote --tags origin $tagVersion
if ($remoteTagExists) {
    Fail-Step "Remote tag already exists: $tagVersion. Confirm whether you really want to re-release."
}

Write-Step "Check branch status"
$currentBranch = git branch --show-current
if ($currentBranch -ne "main") {
    Write-Host "[WARN] Current branch is $currentBranch, not main." -ForegroundColor Yellow
}

$aheadBehind = git rev-list --left-right --count origin/main...HEAD
Write-Host "origin/main...HEAD = $aheadBehind"

Write-Host ""
Write-Host "[OK] Release preflight passed: $tagVersion" -ForegroundColor Green
