# Windows PowerShell MathJax Offline Downloader
$targetDir = Join-Path $PSScriptRoot "..\public\mathjax"
if (!(Test-Path $targetDir)) {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
}

$urls = @{
    "tex-svg.js" = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"
    "tex-chtml.js" = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"
}

Write-Host ">>> [MathJax Offline Downloader] Downloading MathJax bundles..." -ForegroundColor Cyan

foreach ($name in $urls.Keys) {
    $dest = Join-Path $targetDir $name
    $url = $urls[$name]
    Write-Host "Downloading $name ..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        $size = (Get-Item $dest).Length
        Write-Host "✓ Successfully downloaded $name ($size bytes)" -ForegroundColor Green
    } catch {
        Write-Host "✗ Error downloading $name : $_" -ForegroundColor Red
    }
}

Write-Host ">>> Done! MathJax offline bundle is ready in public\mathjax" -ForegroundColor Green
