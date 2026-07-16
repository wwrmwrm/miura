# Packages the standalone miura loader into release/loader/
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'loader'
$out = Join-Path $root 'release\loader'

if (-not (Test-Path $src)) { throw "Missing loader source: $src" }

New-Item -ItemType Directory -Path $out -Force | Out-Null
Copy-Item (Join-Path $src 'miura-loader.ps1') (Join-Path $out 'miura-loader.ps1') -Force
Copy-Item (Join-Path $src 'miura-loader.bat') (Join-Path $out 'miura-loader.bat') -Force

$readme = @'
# miura loader

Small downloader for the latest Windows build from GitHub Releases.

## Use

Double-click **miura-loader.bat**

- Downloads the latest release of [wwrmwrm/miura](https://github.com/wwrmwrm/miura)
- Prefers the NSIS installer; optional portable mode
- Files land in `%LOCALAPPDATA%\miura\downloads\`

## Notes

- Needs network + PowerShell
- GitHub Releases must contain a Windows `.exe` (run `npm run dist:win` and upload artifacts)
- Buttons / UI are local — no install required for the loader itself

## CLI

```bat
miura-loader.bat
powershell -File miura-loader.ps1 -PortablePrefer
```
'@
Set-Content -Path (Join-Path $out 'README.txt') -Value $readme -Encoding UTF8

Write-Host "[loader] packaged → $out"
Get-ChildItem $out | ForEach-Object { Write-Host ("  {0}  ({1:N0} bytes)" -f $_.Name, $_.Length) }
