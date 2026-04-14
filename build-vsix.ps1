param(
    [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

# Read version from package.json
$pkg = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
if (-not $OutFile) { $OutFile = "rgd-suite-$version.vsix" }
$TempDir = Join-Path $env:TEMP "rgd-suite-vsix-$(Get-Random)"
$ExtDir = Join-Path $TempDir "extension"

Write-Host "Building VSIX: $OutFile"
Write-Host "Temp: $TempDir"

# Clean up temp
if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
New-Item -ItemType Directory -Path $ExtDir | Out-Null

# --- Files to include (mirrors .vscodeignore logic) ---
$include = @(
    "out\extension.js",
    "package.json",
    "README.md",
    "language-configuration.json"
)

# Folders to include recursively
$includeDirs = @("media", "syntaxes", "dictionaries", "workers", "bundled")

foreach ($f in $include) {
    $src = Join-Path $Root $f
    $dst = Join-Path $ExtDir $f
    if (!(Test-Path $src)) { Write-Warning "Missing: $f"; continue }
    $dstDir = Split-Path $dst -Parent
    if (!(Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    Copy-Item $src $dst -Force
}

foreach ($d in $includeDirs) {
    $src = Join-Path $Root $d
    if (!(Test-Path $src)) { Write-Warning "Missing dir: $d"; continue }
    $dst = Join-Path $ExtDir $d
    Copy-Item $src $dst -Recurse -Force
}

# --- Read package.json metadata ---
$pkg = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$publisher = $pkg.publisher
$name      = $pkg.name
$version   = $pkg.version
$displayName = $pkg.displayName
$description = $pkg.description

# --- Write [Content_Types].xml ---
$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json"    ContentType="application/json"/>
  <Default Extension="js"      ContentType="application/javascript"/>
  <Default Extension="css"     ContentType="text/css"/>
  <Default Extension="txt"     ContentType="text/plain"/>
  <Default Extension="md"      ContentType="text/markdown"/>
  <Default Extension="png"     ContentType="image/png"/>
  <Default Extension="svg"     ContentType="image/svg+xml"/>
  <Default Extension="vsixmanifest" ContentType="text/xml"/>
  <Default Extension="map"     ContentType="application/json"/>
  <Default Extension="ts"      ContentType="text/plain"/>
  <Default Extension="d.ts"    ContentType="text/plain"/>
</Types>
'@
[System.IO.File]::WriteAllText((Join-Path $TempDir "[Content_Types].xml"), $contentTypes, [System.Text.Encoding]::UTF8)

# --- Write extension.vsixmanifest ---
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0"
  xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"
  xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US"
      Id="$name"
      Version="$version"
      Publisher="$publisher" />
    <DisplayName>$displayName</DisplayName>
    <Description xml:space="preserve">$description</Description>
    <Tags>rgd,relic,dawn of war,company of heroes,lua,modding</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <License>LICENSE</License>
    <Icon>icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest"
      Path="extension/package.json"
      Addressable="true"/>
  </Assets>
</PackageManifest>
"@
[System.IO.File]::WriteAllText((Join-Path $TempDir "extension.vsixmanifest"), $manifest, [System.Text.Encoding]::UTF8)

# Remove <Icon> line if no icon.png present
if (!(Test-Path (Join-Path $ExtDir "icon.png"))) {
    $mPath = Join-Path $TempDir "extension.vsixmanifest"
    $lines = (Get-Content $mPath) | Where-Object { $_ -notmatch '<Icon>' }
    [System.IO.File]::WriteAllLines($mPath, $lines, [System.Text.Encoding]::UTF8)
}
# Remove <License> line if no LICENSE file present
if (!(Test-Path (Join-Path $ExtDir "LICENSE"))) {
    $mPath = Join-Path $TempDir "extension.vsixmanifest"
    $lines = (Get-Content $mPath) | Where-Object { $_ -notmatch '<License>' }
    [System.IO.File]::WriteAllLines($mPath, $lines, [System.Text.Encoding]::UTF8)
}

# --- Zip everything up ---
$OutPath = Join-Path $Root $OutFile
if (Test-Path $OutPath) { Remove-Item $OutPath -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($TempDir, $OutPath)

# Clean up
Remove-Item $TempDir -Recurse -Force

$size = (Get-Item $OutPath).Length / 1KB
Write-Host ""
Write-Host "Done! $OutFile ($([math]::Round($size, 1)) KB)" -ForegroundColor Green
Write-Host "Install with: code --install-extension `"$OutFile`""
