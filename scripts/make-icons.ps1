# Generates PWA icons (192/512) with MK branding using System.Drawing
Add-Type -AssemblyName System.Drawing

function New-Icon {
  param([int]$Size, [string]$Path)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  # Background: dark navy like the app
  $g.Clear([System.Drawing.Color]::FromArgb(19, 24, 36))

  # Accent gradient bar at the bottom third
  $rect = New-Object System.Drawing.Rectangle(0, ($Size - [int]($Size * 0.18)), $Size, [int]($Size * 0.18))
  $barBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    [System.Drawing.Color]::FromArgb(108, 140, 255),
    [System.Drawing.Color]::FromArgb(143, 108, 255), 0)
  $g.FillRectangle($barBrush, $rect)

  # "MK" text centered
  $textBrush = [System.Drawing.Brushes]::White
  $fontSize = [float]($Size * 0.40)
  $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $textRect = New-Object System.Drawing.RectangleF(0, ($Size * -0.06), $Size, $Size)
  $g.DrawString("MK", $font, $textBrush, $textRect, $sf)

  $dir = Split-Path $Path
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "icon: $Path ($Size px)"
}

New-Icon 192 "E:\my web code\own downloader\web\icons\icon-192.png"
New-Icon 512 "E:\my web code\own downloader\web\icons\icon-512.png"
