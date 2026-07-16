# miura loader — downloads latest Windows build from GitHub Releases
# Requires: Windows PowerShell 5+ / PowerShell 7+, network

param(
  [string]$Owner = 'wwrmwrm',
  [string]$Repo = 'miura',
  [string]$InstallDir = '',
  [switch]$PortablePrefer
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Api = "https://api.github.com/repos/$Owner/$Repo/releases/latest"
$UserAgent = 'miura-loader/1.0'
if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA 'miura'
}

function Write-UiLog([string]$text) {
  if ($script:logBox -and -not $script:logBox.IsDisposed) {
    $script:logBox.AppendText(("[{0}] {1}`r`n" -f (Get-Date -Format 'HH:mm:ss'), $text))
    $script:logBox.SelectionStart = $script:logBox.Text.Length
    $script:logBox.ScrollToCaret()
  }
}

function Get-LatestRelease {
  Write-UiLog "Checking GitHub: $Owner/$Repo …"
  $headers = @{
    'User-Agent' = $UserAgent
    'Accept'     = 'application/vnd.github+json'
  }
  $rel = Invoke-RestMethod -Uri $Api -Headers $headers -TimeoutSec 60
  if (-not $rel) { throw 'Empty release response' }
  return $rel
}

function Pick-Asset($release) {
  $assets = @($release.assets)
  if (-not $assets.Count) { throw 'No assets in latest release. Publish a Windows build first.' }

  $nsis = $assets | Where-Object {
    $_.name -match 'miura.*\.(exe)$' -and $_.name -notmatch 'portable'
  } | Select-Object -First 1

  $portable = $assets | Where-Object {
    $_.name -match 'portable' -and $_.name -match '\.exe$'
  } | Select-Object -First 1

  if ($PortablePrefer -and $portable) { return $portable }
  if ($nsis) { return $nsis }
  if ($portable) { return $portable }

  $anyExe = $assets | Where-Object { $_.name -match '\.exe$' } | Select-Object -First 1
  if ($anyExe) { return $anyExe }
  throw "No .exe asset found. Assets: $(($assets | ForEach-Object name) -join ', ')"
}

function Download-File([string]$Url, [string]$OutPath) {
  $dir = Split-Path -Parent $OutPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  Write-UiLog "Downloading → $OutPath"
  $script:progress.Value = 0
  $script:status.Text = 'Downloading…'

  # WebClient for progress events
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('User-Agent', $UserAgent)
  $handler = [System.Net.DownloadProgressChangedEventHandler] {
    param($s, $e)
    if ($script:progress -and -not $script:progress.IsDisposed) {
      $script:progress.Value = [Math]::Min(100, [int]$e.ProgressPercentage)
      $script:status.Text = ("Downloading… {0}%" -f $e.ProgressPercentage)
    }
    [System.Windows.Forms.Application]::DoEvents()
  }
  $wc.add_DownloadProgressChanged($handler)
  try {
    $wc.DownloadFile($Url, $OutPath)
  } finally {
    $wc.remove_DownloadProgressChanged($handler)
    $wc.Dispose()
  }
  $script:progress.Value = 100
  Write-UiLog 'Download complete.'
}

function Run-Downloaded([string]$Path, [bool]$IsPortable) {
  if ($IsPortable) {
    Write-UiLog 'Launching portable build…'
    $script:status.Text = 'Starting miura…'
    Start-Process -FilePath $Path
  } else {
    Write-UiLog 'Starting installer…'
    $script:status.Text = 'Running installer…'
    Start-Process -FilePath $Path -Wait
  }
}

# ── UI ──────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text = 'miura · loader'
$form.Size = New-Object System.Drawing.Size(520, 420)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 16, 15)
$form.ForeColor = [System.Drawing.Color]::FromArgb(247, 242, 236)
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'miura'
$title.Font = New-Object System.Drawing.Font('Georgia', 22, [System.Drawing.FontStyle]::Regular)
$title.ForeColor = [System.Drawing.Color]::FromArgb(247, 242, 236)
$title.Location = New-Object System.Drawing.Point(28, 22)
$title.AutoSize = $true
$form.Controls.Add($title)

$kicker = New-Object System.Windows.Forms.Label
$kicker.Text = '音 の 余 白  ·  installer'
$kicker.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$kicker.ForeColor = [System.Drawing.Color]::FromArgb(143, 134, 128)
$kicker.Location = New-Object System.Drawing.Point(32, 58)
$kicker.AutoSize = $true
$form.Controls.Add($kicker)

$desc = New-Object System.Windows.Forms.Label
$desc.Text = "Downloads the latest Windows build from`r`nGitHub: $Owner/$Repo"
$desc.Location = New-Object System.Drawing.Point(32, 90)
$desc.Size = New-Object System.Drawing.Size(450, 40)
$desc.ForeColor = [System.Drawing.Color]::FromArgb(201, 192, 182)
$form.Controls.Add($desc)

$script:status = New-Object System.Windows.Forms.Label
$script:status.Text = 'Ready'
$script:status.Location = New-Object System.Drawing.Point(32, 140)
$script:status.Size = New-Object System.Drawing.Size(450, 22)
$script:status.ForeColor = [System.Drawing.Color]::FromArgb(232, 160, 144)
$form.Controls.Add($script:status)

$script:progress = New-Object System.Windows.Forms.ProgressBar
$script:progress.Location = New-Object System.Drawing.Point(32, 168)
$script:progress.Size = New-Object System.Drawing.Size(440, 18)
$script:progress.Style = 'Continuous'
$form.Controls.Add($script:progress)

$script:logBox = New-Object System.Windows.Forms.TextBox
$script:logBox.Multiline = $true
$script:logBox.ReadOnly = $true
$script:logBox.ScrollBars = 'Vertical'
$script:logBox.Location = New-Object System.Drawing.Point(32, 200)
$script:logBox.Size = New-Object System.Drawing.Size(440, 110)
$script:logBox.BackColor = [System.Drawing.Color]::FromArgb(26, 22, 20)
$script:logBox.ForeColor = [System.Drawing.Color]::FromArgb(201, 192, 182)
$script:logBox.BorderStyle = 'FixedSingle'
$form.Controls.Add($script:logBox)

$chkPortable = New-Object System.Windows.Forms.CheckBox
$chkPortable.Text = 'Prefer portable (.exe without install)'
$chkPortable.Location = New-Object System.Drawing.Point(32, 320)
$chkPortable.Size = New-Object System.Drawing.Size(300, 24)
$chkPortable.ForeColor = [System.Drawing.Color]::FromArgb(201, 192, 182)
$chkPortable.Checked = [bool]$PortablePrefer
$form.Controls.Add($chkPortable)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'Download & install'
$btn.Location = New-Object System.Drawing.Point(300, 348)
$btn.Size = New-Object System.Drawing.Size(172, 34)
$btn.FlatStyle = 'Flat'
$btn.BackColor = [System.Drawing.Color]::FromArgb(194, 58, 43)
$btn.ForeColor = [System.Drawing.Color]::White
$btn.FlatAppearance.BorderSize = 0
$btn.Cursor = [System.Windows.Forms.Cursors]::Hand
$form.Controls.Add($btn)

$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = 'Close'
$btnClose.Location = New-Object System.Drawing.Point(200, 348)
$btnClose.Size = New-Object System.Drawing.Size(88, 34)
$btnClose.FlatStyle = 'Flat'
$btnClose.BackColor = [System.Drawing.Color]::FromArgb(38, 34, 32)
$btnClose.ForeColor = [System.Drawing.Color]::FromArgb(247, 242, 236)
$btnClose.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(70, 62, 58)
$btnClose.Add_Click({ $form.Close() })
$form.Controls.Add($btnClose)

$btn.Add_Click({
  $btn.Enabled = $false
  $chkPortable.Enabled = $false
  try {
    $PortablePrefer = $chkPortable.Checked
    $rel = Get-LatestRelease
    $tag = $rel.tag_name
    Write-UiLog "Latest release: $tag"
    $asset = Pick-Asset $rel
    Write-UiLog ("Asset: {0} ({1:N1} MB)" -f $asset.name, ($asset.size / 1MB))

    $isPortable = $asset.name -match 'portable'
    $outDir = Join-Path $InstallDir 'downloads'
    $outPath = Join-Path $outDir $asset.name

    Download-File -Url $asset.browser_download_url -OutPath $outPath
    Run-Downloaded -Path $outPath -IsPortable:$isPortable

    $script:status.Text = 'Done'
    Write-UiLog 'Finished.'
  } catch {
    $script:status.Text = 'Error'
    Write-UiLog ("ERROR: {0}" -f $_.Exception.Message)
    [System.Windows.Forms.MessageBox]::Show(
      $_.Exception.Message,
      'miura loader',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } finally {
    $btn.Enabled = $true
    $chkPortable.Enabled = $true
  }
})

Write-UiLog "Install cache: $InstallDir"
Write-UiLog 'Press «Download & install» to fetch the latest release.'
[void]$form.ShowDialog()
