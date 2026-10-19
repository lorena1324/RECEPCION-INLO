# Corre los escenarios de integridad en un Edge sin ventana, contra el Firestore falso.
#
#   powershell -NoProfile -File pruebas\integridad\ejecutar.ps1
#
# Imprime el registro de las pruebas. No borra nada: usa una carpeta temporal propia
# para el perfil del navegador y la deja (la limpia el sistema).

$raiz = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$tmp = Join-Path $env:TEMP ("inlo-integridad-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null

$servidor = Start-Process node -ArgumentList ('"' + (Join-Path $PSScriptRoot "servidor-estatico.cjs") + '"'), ('"' + $raiz + '"') -PassThru -WindowStyle Hidden
Start-Sleep 2

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$salida = Join-Path $tmp "dom.txt"
$navegador = Start-Process $edge -ArgumentList '--headless=new', '--disable-gpu', '--no-first-run', "--user-data-dir=$tmp\perfil", '--virtual-time-budget=60000', '--dump-dom', 'http://127.0.0.1:5196/pruebas/integridad/index.html' -RedirectStandardOutput $salida -PassThru -WindowStyle Hidden
$navegador | Wait-Process -Timeout 120 -ErrorAction SilentlyContinue
Start-Sleep 2

# Cerrar solo lo que abrimos (el Edge de esta carpeta temporal y el servidor).
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($tmp) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $servidor.Id -Force -ErrorAction SilentlyContinue

$dom = [IO.File]::ReadAllText($salida)
$registro = [regex]::Match($dom, '(?s)<pre id="log">(.*?)</pre>').Groups[1].Value
$registro -replace '&lt;', '<' -replace '&gt;', '>' -replace '&amp;', '&' -replace '&quot;', '"'
