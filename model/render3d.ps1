# Renders the manual's 3D figures from cfc-chamber-model.html. -Out is required so nothing is overwritten by accident.
param([string[]]$Only, [Parameter(Mandatory)][string]$Out)
$page  = "file:///" + ("$PSScriptRoot\cfc-chamber-model.html" -replace '\\', '/' -replace ' ', '%20')
$edge  = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
New-Item -ItemType Directory -Force $Out | Out-Null

# name = hash parameters
$figs = [ordered]@{
  'cover'      = 'view=iso'
  'overview'   = 'view=iso;labels=all'
  'front'      = 'view=front;labels=all'
  'back'       = 'view=back;labels=all'
  'top'        = 'view=top;zoom=0.85'
  'exploded'   = 'view=iso;labels=all;explode=1;zoom=1.15'
  'p-shell'    = 'view=iso;focus=shell;labels=focus'
  'p-door'     = 'view=isoleft;focus=door;labels=focus'
  'p-lock'     = 'view=iso;focus=lock;labels=focus;fit=1;zoom=1.5'
  'p-hang'     = 'view=front;focus=hang;labels=focus;fit=1;zoom=1.25'
  'p-grill'    = 'view=iso;focus=grill;labels=focus;fit=1;zoom=1.25'
  'p-water'    = 'view=iso;focus=water,grill;labels=focus;fit=1;zoom=1.25'
  'p-pad'      = 'view=above;focus=pad;labels=focus;fit=1;zoom=1.15'
  'p-cup'      = 'view=iso;focus=cup,pad;labels=focus;fit=1;zoom=1.15'
  'p-probe'    = 'view=backlow;focus=probe,pad;labels=focus;fit=1;zoom=1.1'
  'p-legs'     = 'view=low;focus=legs;labels=focus;fit=1;zoom=1.2'
  'p-ctrl'     = 'view=frontlow;focus=ctrl;labels=focus;fit=1;zoom=1.5'
  'p-oled'     = 'view=front;focus=oled,keypad;labels=focus;fit=1;zoom=1.6'
  'p-power'    = 'view=backlow;focus=power;labels=focus;fit=1;zoom=1.8'
}
foreach ($k in $figs.Keys) {
  if ($Only -and $Only -notcontains $k) { continue }
  $file = "$Out\$k.png"
  Remove-Item $file -ErrorAction SilentlyContinue
  $url = "$page#render;$($figs[$k])"
  Start-Process $edge -ArgumentList "--headless=new", "--allow-file-access-from-files", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--hide-scrollbars", "--force-device-scale-factor=2", "--window-size=900,675",
    "--virtual-time-budget=9000", "--screenshot=$file", "`"$url`"" -Wait
  "{0,-10} {1}" -f $k, (Test-Path $file)
}
