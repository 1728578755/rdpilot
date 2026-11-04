# Windows built-in OCR (Windows.Media.Ocr) -> JSON
#
# PowerShell 5.1 only: WinRT projections need .NET Framework, so ui-to-text.mjs
# spawns powershell.exe (not pwsh) for this helper.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File win-ocr.ps1 -Path in.png -Out out.json
#
# Output (UTF-8 without BOM - the pipe encoding would otherwise mangle CJK):
#   { "w":1440, "h":900, "lang":"zh-Hans-CN", "scale":2,
#     "lines":[ {"x":85,"y":15,"w":60,"h":18,"t":"RDPilot"} ] }
# On failure it still writes { "error":"..." } and exits 0; the caller checks `error`.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI when
# there is no BOM, so any non-ASCII comment or string breaks the parser.

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Lang = '',
  # Upscale before recognition: Windows OCR peaks around 32px glyph height, and
  # 13px UI text produces a lot of wrong characters when fed directly.
  [double]$Scale = 2
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Fail([string]$message) {
  $payload = [pscustomobject]@{ error = $message }
  [System.IO.File]::WriteAllText($Out, ($payload | ConvertTo-Json -Compress), $utf8)
  exit 0
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  function Await($op, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapTransform, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

  $full = (Resolve-Path -LiteralPath $Path).Path
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

  if ($Scale -gt 1) {
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $transform.ScaledWidth = [uint32][math]::Round($decoder.PixelWidth * $Scale)
    $transform.ScaledHeight = [uint32][math]::Round($decoder.PixelHeight * $Scale)
    $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
      )) ([Windows.Graphics.Imaging.SoftwareBitmap])
  }
  else {
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  }

  $engine = $null
  if ($Lang -ne '') {
    $language = New-Object Windows.Globalization.Language($Lang)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  }
  if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  }
  if ($null -eq $engine) {
    Fail 'no-ocr-engine'
  }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = New-Object System.Collections.Generic.List[object]
  foreach ($line in @($result.Lines)) {
    $words = @($line.Words)
    if ($words.Count -eq 0) { continue }
    $x0 = [double]::MaxValue
    $y0 = [double]::MaxValue
    $x1 = 0.0
    $y1 = 0.0
    $wordList = New-Object System.Collections.Generic.List[object]
    foreach ($word in $words) {
      $r = $word.BoundingRect
      if ($r.X -lt $x0) { $x0 = $r.X }
      if ($r.Y -lt $y0) { $y0 = $r.Y }
      if (($r.X + $r.Width) -gt $x1) { $x1 = $r.X + $r.Width }
      if (($r.Y + $r.Height) -gt $y1) { $y1 = $r.Y + $r.Height }
      # Per-word boxes: the renderer puts each word at its real x, so table-like
      # rows keep their column gaps instead of being spread evenly.
      $wordList.Add([pscustomobject]@{
          x = [math]::Round($r.X / $Scale, 1)
          y = [math]::Round($r.Y / $Scale, 1)
          w = [math]::Round($r.Width / $Scale, 1)
          h = [math]::Round($r.Height / $Scale, 1)
          t = $word.Text
        })
    }
    $lines.Add([pscustomobject]@{
        x     = [math]::Round($x0 / $Scale, 1)
        y     = [math]::Round($y0 / $Scale, 1)
        w     = [math]::Round(($x1 - $x0) / $Scale, 1)
        h     = [math]::Round(($y1 - $y0) / $Scale, 1)
        t     = $line.Text
        words = $wordList
      })
  }

  $payload = [pscustomobject]@{
    w     = $decoder.PixelWidth
    h     = $decoder.PixelHeight
    lang  = $engine.RecognizerLanguage.LanguageTag
    scale = $Scale
    lines = $lines
  }
  [System.IO.File]::WriteAllText($Out, ($payload | ConvertTo-Json -Depth 5 -Compress), $utf8)
}
catch {
  Fail ($_.Exception.Message)
}
