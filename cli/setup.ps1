# RGD Suite — PowerShell setup (dot-source this file)
# Usage: . "C:\path\to\rgd-suite\cli\setup.ps1"
#        . ./cli/setup.ps1                    # from repo root

$script:ErrorActionPreference = 'Stop'

function global:_rgdFindHome {
    # 1. Explicit override
    if ($env:RGD_SUITE_HOME -and (Test-Path "$env:RGD_SUITE_HOME\cli\rgd-cli.js")) {
        return (Resolve-Path $env:RGD_SUITE_HOME).Path
    }

    # 2. Same directory as this script (dev checkout / unzip)
    # $PSScriptRoot is the cli/ folder; parent is the repo root
    $here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $dev = Join-Path (Split-Path $here -Parent) 'cli' 'rgd-cli.js'
    if (Test-Path $dev) {
        return (Split-Path $here -Parent)
    }

    # 3. Scan known extension directories (VS Code, Windsurf, Cursor, etc.)
    $candidates = @(
        (Join-Path $env:USERPROFILE '.vscode'          'extensions')
        (Join-Path $env:USERPROFILE '.windsurf'        'extensions')
        (Join-Path $env:USERPROFILE '.cursor'          'extensions')
        (Join-Path $env:USERPROFILE '.codeium'         'extensions')
        (Join-Path $env:USERPROFILE '.vscode-oss'      'extensions')
        (Join-Path $env:USERPROFILE '.vscodium'        'extensions')
        (Join-Path $env:USERPROFILE '.vscode-insiders' 'extensions')
    )
    if ($env:VSCODE_PORTABLE) {
        $candidates += (Join-Path $env:VSCODE_PORTABLE 'extensions')
    }

    foreach ($base in $candidates) {
        if (-not (Test-Path $base)) { continue }
        $dir = Get-ChildItem -Path $base -Directory -Filter 'CannibalToast.rgd-suite-*' -ErrorAction SilentlyContinue |
               Sort-Object Name -Descending | Select-Object -First 1
        if ($dir -and (Test-Path (Join-Path $dir.FullName 'cli' 'rgd-cli.js'))) {
            return $dir.FullName
        }
    }

    return $null
}

$global:RgdSuiteHome = _rgdFindHome
if (-not $global:RgdSuiteHome) {
    Write-Warning "RGD Suite CLI not found.``nSet `$env:RGD_SUITE_HOME to the extension / repo root and re-run."
    return
}

$env:RGD_SUITE_HOME = $global:RgdSuiteHome
$global:RgdCli = Join-Path $global:RgdSuiteHome 'cli' 'rgd-cli.js'

# ── Wrapper functions ────────────────────────────────────────────────────

function global:rgd { & node $global:RgdCli @args }

function global:rgd-toText {
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path,
        [string] $Out
    )
    process {
        $a = @('to-text', $Path); if ($Out) { $a += '-o', $Out }
        rgd @a
    }
}

function global:rgd-fromText {
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path,
        [string] $Out,
        [ValidateSet(1,3)] [int] $Version
    )
    process {
        $a = @('from-text', $Path)
        if ($Out)     { $a += '-o', $Out }
        if ($Version) { $a += '--version', $Version }
        rgd @a
    }
}

function global:rgd-toLua {
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path,
        [string] $Out,
        [string] $Attrib
    )
    process {
        $a = @('to-lua', $Path)
        if ($Out)    { $a += '-o', $Out }
        if ($Attrib) { $a += '-a', $Attrib }
        rgd @a
    }
}

function global:rgd-fromLua {
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path,
        [string] $Out,
        [string] $Attrib,
        [ValidateSet(1,3)] [int] $Version
    )
    process {
        $a = @('from-lua', $Path)
        if ($Out)     { $a += '-o', $Out }
        if ($Attrib)  { $a += '-a', $Attrib }
        if ($Version) { $a += '--version', $Version }
        rgd @a
    }
}

function global:rgd-info {
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path
    )
    process { rgd info $Path | ConvertFrom-Json }
}

function global:rgd-hash {
    param(
        [Parameter(Mandatory, ValueFromPipeline)]
        [string] $String
    )
    process { rgd hash $String | ConvertFrom-Json }
}

Write-Host "RGD Suite ready: $global:RgdSuiteHome" -ForegroundColor Green
Write-Host "Commands: rgd, rgd-toText, rgd-fromText, rgd-toLua, rgd-fromLua, rgd-info, rgd-hash" -ForegroundColor DarkGray
