# Regenerates bridge.bat as GBK + CRLF from the UTF-8 source (bridge.utf8.txt).
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'bridge.utf8.txt'
$dst = Join-Path $PSScriptRoot 'bridge.bat'
$c = Get-Content -Raw -Encoding UTF8 $src
$c = $c -replace "`n", "`r`n"
[IO.File]::WriteAllText($dst, $c, [Text.Encoding]::GetEncoding(936))
Write-Output "written $dst (GBK + CRLF)"
