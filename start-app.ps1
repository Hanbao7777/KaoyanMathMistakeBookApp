$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = "C:\Program Files\nodejs\node.exe"
$env:Path = "C:\Program Files\nodejs;$root\node_modules\.bin;$env:Path"

Set-Location $root

Start-Process -FilePath $node `
  -ArgumentList @("$root\node_modules\vite\bin\vite.js", "--host", "127.0.0.1", "--configLoader", "native") `
  -WorkingDirectory $root `
  -WindowStyle Hidden

Start-Process -FilePath $node `
  -ArgumentList @("$root\node_modules\typescript\bin\tsc", "-p", "tsconfig.main.json", "--watch") `
  -WorkingDirectory $root `
  -WindowStyle Hidden

Start-Sleep -Seconds 4

Start-Process -FilePath $node `
  -ArgumentList @("$root\node_modules\electron\cli.js", ".") `
  -WorkingDirectory $root
