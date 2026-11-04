# Rebuild the bot folder from the zip and start it.  Run inside D:\vanilla-node:
#   powershell -ExecutionPolicy Bypass -File .\fix.ps1
param([string]$Zip = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (-not $Zip) {
  $cand = @(Get-ChildItem -Force -Filter 'mc-node-bot*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  if (-not $cand.Count) { throw 'No mc-node-bot*.zip in this folder. Download it here first.' }
  $Zip = $cand[0].FullName
}
"using $Zip"
$a = [IO.Compression.ZipFile]::OpenRead($Zip)
$root = $a.Entries | Where-Object { $_.FullName -eq 'server.js' }
if (-not $root) { $a.Dispose(); throw "That zip has no server.js at its root - the download is stale. Get a fresh mc-node-bot-f.zip." }
"server.js in zip: $($root.Length) bytes"
$n = 0
foreach ($e in $a.Entries) {
  if ($e.FullName.StartsWith('node_modules/')) { continue }
  $dest = Join-Path (Get-Location) $e.FullName
  if ($e.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $dest | Out-Null; continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
  $n++
}
$a.Dispose()
"extracted $n files"
''
# Defender likes to eat this file; say so instead of failing silently again
if (Test-Path .\server.js) { 'server.js present: ' + (Get-Item .\server.js).Length + ' bytes' }
else { '*** server.js is missing right after extraction - Windows Defender is probably quarantining it. See Windows Security > Protection history, then: Unblock-File .\*' ; exit 1 }
if (-not (Test-Path .\node_modules)) { 'installing dependencies...'; npm.cmd install }
'starting the bot - web console on http://localhost:8080'
npm.cmd start
