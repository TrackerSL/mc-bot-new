# One-screen report so we can see why server.js is missing.  Run inside D:\vanilla-node:
#   powershell -ExecutionPolicy Bypass -File .\diagnose.ps1
'--- cwd ---'
(Get-Location).Path
''
'--- top level ---'
Get-ChildItem -Force | Sort-Object Name |
  ForEach-Object { '{0,-26} {1,10} {2}' -f $_.Name, $(if ($_.PSIsContainer) { '<DIR>' } else { $_.Length }), $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm') }
''
'--- any server.js anywhere below? ---'
$s = Get-ChildItem -Recurse -Force -Filter server.js -ErrorAction SilentlyContinue |
     Where-Object { $_.FullName -notmatch '\\node_modules\\' }
if ($s) { $s | ForEach-Object { '  FOUND ' + $_.FullName + '  (' + $_.Length + ' bytes)' } } else { '  none' }
''
'--- zips lying around ---'
$z = Get-ChildItem -Recurse -Force -Filter *.zip -ErrorAction SilentlyContinue | Select-Object -First 5
if ($z) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  foreach ($f in $z) {
    '  ' + $f.FullName + '  (' + $f.Length + ' bytes)'
    try {
      $a = [IO.Compression.ZipFile]::OpenRead($f.FullName)
      $hit = $a.Entries | Where-Object { $_.FullName -eq 'server.js' }
      if ($hit) { '     has server.js at the root, ' + $hit.Length + ' bytes' } else { '     *** no server.js at the root ***' }
      '     entries: ' + $a.Entries.Count
      $a.Dispose()
    } catch { '     cannot read archive: ' + $_.Exception.Message }
  }
} else { '  no zip found here' }
