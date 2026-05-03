$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$release = Join-Path $root "release"
$exe = Get-ChildItem -Path $release -Filter "*.exe" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $exe) {
  Write-Host "No exe found in release folder."
  Read-Host "Press Enter to close"
  exit 1
}

Start-Process -FilePath $exe.FullName
