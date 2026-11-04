# Verify the unpacked bot folder before starting it.
#   PS> .\check.ps1
$need = @('server.js','page.html','package.json','items1204.json','item_tex.json','protocol.json','block_names.json','blocks1204.json','block_shapes.json')
$bad = 0
foreach ($f in $need) {
  if (Test-Path -LiteralPath $f) { '{0,-20} OK    {1,10:N0} bytes' -f $f, (Get-Item -LiteralPath $f).Length }
  else { '{0,-20} MISSING' -f $f; $bad++ }
}
if (Test-Path textures) { '{0,-20} {1,10:N0} files' -f 'textures/', (Get-ChildItem textures -Recurse -File).Count }
else { '{0,-20} MISSING' -f 'textures/'; $bad++ }
if (Test-Path node_modules) { '{0,-20} present' -f 'node_modules/' } else { '{0,-20} missing  ->  npm install' -f 'node_modules/' }
''
if ($bad) {
  "$bad required file(s) missing. Re-extract everything with:"
  ''
  '  Expand-Archive -Path .\mc-node-bot.zip -DestinationPath . -Force'
  ''
  'or pull just one file out of the zip:'
  ''
  '  Add-Type -AssemblyName System.IO.Compression.FileSystem'
  '  $z = [IO.Compression.ZipFile]::OpenRead(".\mc-node-bot.zip")'
  '  $z.Entries | Where-Object { $_.FullName -eq "server.js" } | ForEach-Object { [IO.Compression.ZipFileExtensions]::ExtractToFile($_, ".\server.js", $true) }'
  '  $z.Dispose()'
} else { 'All good - start the bot with:  npm start' }
