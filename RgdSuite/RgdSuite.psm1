#Requires -Version 5.1
<#
.SYNOPSIS
    RGD Suite PowerShell module — thin wrappers around the bundled Node.js CLI.

.DESCRIPTION
    Provides PowerShell cmdlets and aliases for every RGD Suite operation so
    you can run conversions, parity checks, and extractions from a terminal
    without opening VS Code.

    The module auto-discovers the Node.js CLI shipped with the VS Code extension:
      1.  $env:RGD_SUITE_HOME (override)
      2.  Extension install under $env:USERPROFILE\.vscode\extensions\CannibalToast.rgd-suite-*
      3.  Extension install under $env:VSCODE_PORTABLE\extensions\CannibalToast.rgd-suite-*

    If the CLI cannot be found, Import-Module will write a warning.

.EXAMPLE
    PS> ConvertTo-RgdLua -Path "data\attrib\ebps\guard\guard_infantry.rgd"
    Writes guard_infantry.lua next to the source file.

.EXAMPLE
    PS> Get-RgdInfo -Path "guard_infantry.rgd" | Select-Object version, totalEntries
    Shows version and entry count as a structured object.

.EXAMPLE
    PS> rgd-toLua  data/attrib/**/*.rgd
    Alias form — shell globbing handled by your terminal.
#>

# ── Private helpers ────────────────────────────────────────────────────────

$script:CliPath = $null

function _FindCli {
    if ($env:RGD_SUITE_HOME) {
        $c = Join-Path $env:RGD_SUITE_HOME 'cli' 'rgd-cli.js'
        if (Test-Path $c) { return $c }
    }

    # Standard VS Code user extensions
    $userExt = Join-Path $env:USERPROFILE '.vscode' 'extensions'
    if (Test-Path $userExt) {
        $dir = Get-ChildItem -Path $userExt -Directory -Filter 'CannibalToast.rgd-suite-*' |
               Sort-Object Name -Descending | Select-Object -First 1
        if ($dir) {
            $c = Join-Path $dir.FullName 'cli' 'rgd-cli.js'
            if (Test-Path $c) { return $c }
        }
    }

    # Portable VS Code
    if ($env:VSCODE_PORTABLE) {
        $portableExt = Join-Path $env:VSCODE_PORTABLE 'extensions'
        if (Test-Path $portableExt) {
            $dir = Get-ChildItem -Path $portableExt -Directory -Filter 'CannibalToast.rgd-suite-*' |
                   Sort-Object Name -Descending | Select-Object -First 1
            if ($dir) {
                $c = Join-Path $dir.FullName 'cli' 'rgd-cli.js'
                if (Test-Path $c) { return $c }
            }
        }
    }

    # Development / repo checkout (cwd is the repo root)
    $dev = Join-Path $PSScriptRoot '..' 'cli' 'rgd-cli.js' | Resolve-Path -ErrorAction SilentlyContinue
    if ($dev -and (Test-Path $dev)) { return $dev }

    return $null
}

function _InvokeRgd {
    param([string[]] $CliArgs)
    if (-not $script:CliPath) {
        $script:CliPath = _FindCli
        if (-not $script:CliPath) {
            throw 'RGD Suite CLI not found. Install the VS Code extension or set $env:RGD_SUITE_HOME.'
        }
    }

    $node = Get-Command 'node' -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js not found in PATH. Install Node.js or use VS Code.' }

    $nodeExe = if ($node -is [string]) { $node } else { $node.Source }
    & $nodeExe $script:CliPath @CliArgs
    if ($LASTEXITCODE -ne 0) { throw "rgd $($CliArgs[0]) failed (exit $LASTEXITCODE)." }
}

# ── Cmdlets ────────────────────────────────────────────────────────────────

function ConvertTo-RgdText {
    <#
    .SYNOPSIS
        Convert a binary RGD file to human-readable text format.
    .PARAMETER Path
        Path to the .rgd file.
    .PARAMETER OutputPath
        Destination path. Defaults to <input>.rgd.txt.
    .PARAMETER DictionaryPath
        Colon-separated dictionary file paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path,
        [string] $OutputPath,
        [string] $DictionaryPath = $env:RGD_SUITE_DICT
    )
    process {
        $Path = Convert-Path $Path
        $cliArgs = @('to-text', $Path)
        if ($OutputPath)  { $cliArgs += '-o', $OutputPath }
        if ($DictionaryPath) { $cliArgs += '-d', $DictionaryPath }
        _InvokeRgd @cliArgs
    }
}

function ConvertFrom-RgdText {
    <#
    .SYNOPSIS
        Convert a text-format .rgd.txt back to binary RGD.
    .PARAMETER Path
        Path to the .rgd.txt file.
    .PARAMETER OutputPath
        Destination path. Defaults to stripping .txt extension.
    .PARAMETER Version
        RGD version (1 or 3). Defaults to value stored in the text file.
    .PARAMETER DictionaryPath
        Colon-separated dictionary file paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path,
        [string] $OutputPath,
        [ValidateSet(1,3)]
        [int] $Version,
        [string] $DictionaryPath = $env:RGD_SUITE_DICT
    )
    process {
        $Path = Convert-Path $Path
        $cliArgs = @('from-text', $Path)
        if ($OutputPath)  { $cliArgs += '-o', $OutputPath }
        if ($Version)     { $cliArgs += '--version', $Version }
        if ($DictionaryPath) { $cliArgs += '-d', $DictionaryPath }
        _InvokeRgd @cliArgs
    }
}

function ConvertTo-RgdLua {
    <#
    .SYNOPSIS
        Convert a binary RGD file to Corsix-style differential Lua.
    .PARAMETER Path
        Path to the .rgd file.
    .PARAMETER OutputPath
        Destination path. Defaults to <input>.lua.
    .PARAMETER AttribBase
        Attrib root for parent resolution. Auto-detected if omitted.
    .PARAMETER DictionaryPath
        Colon-separated dictionary file paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path,
        [string] $OutputPath,
        [string] $AttribBase,
        [string] $DictionaryPath = $env:RGD_SUITE_DICT
    )
    process {
        $Path = Convert-Path $Path
        $cliArgs = @('to-lua', $Path)
        if ($OutputPath)  { $cliArgs += '-o', $OutputPath }
        if ($AttribBase)  { $cliArgs += '-a', $AttribBase }
        if ($DictionaryPath) { $cliArgs += '-d', $DictionaryPath }
        _InvokeRgd @cliArgs
    }
}

function ConvertFrom-RgdLua {
    <#
    .SYNOPSIS
        Convert a Lua file back to binary RGD (resolves Inherit/Reference).
    .PARAMETER Path
        Path to the .lua file.
    .PARAMETER OutputPath
        Destination path. Defaults to <input>.rgd.
    .PARAMETER AttribBase
        Attrib root for parent resolution. Auto-detected if omitted.
    .PARAMETER Version
        RGD version (1 or 3). Defaults to value detected in Lua.
    .PARAMETER DictionaryPath
        Colon-separated dictionary file paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path,
        [string] $OutputPath,
        [string] $AttribBase,
        [ValidateSet(1,3)]
        [int] $Version,
        [string] $DictionaryPath = $env:RGD_SUITE_DICT
    )
    process {
        $Path = Convert-Path $Path
        $cliArgs = @('from-lua', $Path)
        if ($OutputPath)  { $cliArgs += '-o', $OutputPath }
        if ($AttribBase)  { $cliArgs += '-a', $AttribBase }
        if ($Version)     { $args += '--version', $Version }
        if ($DictionaryPath) { $cliArgs += '-d', $DictionaryPath }
        _InvokeRgd @cliArgs
    }
}

function Get-RgdInfo {
    <#
    .SYNOPSIS
        Return structured info about an RGD file (size, version, entry counts).
    .PARAMETER Path
        Path to the .rgd file.
    .PARAMETER DictionaryPath
        Colon-separated dictionary file paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, ValueFromPipeline, ValueFromPipelineByPropertyName)]
        [Alias('FullName')]
        [string] $Path,
        [string] $DictionaryPath = $env:RGD_SUITE_DICT
    )
    process {
        $Path = Convert-Path $Path
        $cliArgs = @('info', $Path)
        if ($DictionaryPath) { $cliArgs += '-d', $DictionaryPath }
        $json = _InvokeRgd @cliArgs | Out-String
        $json | ConvertFrom-Json
    }
}

function Get-RgdHash {
    <#
    .SYNOPSIS
        Calculate the Relic-style hash for a string.
    .PARAMETER String
        The string to hash.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $String
    )
    $json = _InvokeRgd @('hash', $String) | Out-String
    $json | ConvertFrom-Json
}

function Expand-RgdSga {
    <#
    .SYNOPSIS
        Extract RGD files from an SGA archive.
    .PARAMETER Path
        Path to the .sga archive.
    .PARAMETER OutputDirectory
        Folder to extract into.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path,
        [Parameter(Mandatory)]
        [string] $OutputDirectory
    )
    $Path = Convert-Path $Path
    $OutputDirectory = Convert-Path $OutputDirectory
    _InvokeRgd @('extract-sga', $Path, $OutputDirectory)
}

function Invoke-RgdBatchToLua {
    <#
    .SYNOPSIS
        Batch-convert every .rgd under a folder to .lua.
    .PARAMETER Folder
        Root folder to walk.
    .PARAMETER AttribBase
        Attrib root for parent resolution.
    .PARAMETER DictionaryPath
        Colon-separated dictionary file paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Folder,
        [string] $AttribBase,
        [string] $DictionaryPath = $env:RGD_SUITE_DICT
    )
    $Folder = Convert-Path $Folder
    $cliArgs = @('batch-to-lua', $Folder)
    if ($AttribBase)  { $cliArgs += '-a', $AttribBase }
    if ($DictionaryPath) { $cliArgs += '-d', $DictionaryPath }
    _InvokeRgd @cliArgs
}

function Invoke-RgdBatchToRgd {
    <#
    .SYNOPSIS
        Batch-compile every .lua under a folder to .rgd.
    .PARAMETER Folder
        Root folder to walk.
    .PARAMETER AttribBase
        Attrib root for parent resolution.
    .PARAMETER DictionaryPath
        Colon-separated dictionary file paths.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Folder,
        [string] $AttribBase,
        [string] $DictionaryPath = $env:RGD_SUITE_DICT
    )
    $Folder = Convert-Path $Folder
    $cliArgs = @('batch-to-rgd', $Folder)
    if ($AttribBase)  { $cliArgs += '-a', $AttribBase }
    if ($DictionaryPath) { $cliArgs += '-d', $DictionaryPath }
    _InvokeRgd @cliArgs
}

# ── Aliases ────────────────────────────────────────────────────────────────

New-Alias -Name 'rgd-toText'   -Value 'ConvertTo-RgdText'      -Force -Scope Global
New-Alias -Name 'rgd-fromText' -Value 'ConvertFrom-RgdText'    -Force -Scope Global
New-Alias -Name 'rgd-toLua'    -Value 'ConvertTo-RgdLua'       -Force -Scope Global
New-Alias -Name 'rgd-fromLua'  -Value 'ConvertFrom-RgdLua'     -Force -Scope Global
New-Alias -Name 'rgd-info'     -Value 'Get-RgdInfo'            -Force -Scope Global
New-Alias -Name 'rgd-hash'     -Value 'Get-RgdHash'            -Force -Scope Global
New-Alias -Name 'rgd-extract'  -Value 'Expand-RgdSga'         -Force -Scope Global
New-Alias -Name 'rgd-batchLua' -Value 'Invoke-RgdBatchToLua'   -Force -Scope Global
New-Alias -Name 'rgd-batchRgd' -Value 'Invoke-RgdBatchToRgd'   -Force -Scope Global

# ── Module init ───────────────────────────────────────────────────────────

$script:CliPath = _FindCli
if (-not $script:CliPath) {
    Write-Warning @"
RGD Suite CLI not found. The module will still load, but cmdlets will fail
until the VS Code extension is installed or `$env:RGD_SUITE_HOME` is set.

To install the extension:
  code --install-extension CannibalToast.rgd-suite

To point at a dev checkout:
  `$env:RGD_SUITE_HOME = 'C:ull
epo
gd-suite'
"@
}

Export-ModuleMember -Function @(
    'ConvertTo-RgdText', 'ConvertFrom-RgdText',
    'ConvertTo-RgdLua',  'ConvertFrom-RgdLua',
    'Get-RgdInfo', 'Get-RgdHash',
    'Expand-RgdSga',
    'Invoke-RgdBatchToLua', 'Invoke-RgdBatchToRgd'
) -Alias @(
    'rgd-toText', 'rgd-fromText',
    'rgd-toLua',  'rgd-fromLua',
    'rgd-info',   'rgd-hash',
    'rgd-extract','rgd-batchLua',
    'rgd-batchRgd'
)
