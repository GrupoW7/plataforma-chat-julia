$root = (Resolve-Path $PSScriptRoot).Path
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, 3000)
$listener.Start()

$contentTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".css" = "text/css; charset=utf-8"
  ".js" = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".png" = "image/png"
  ".jpg" = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".svg" = "image/svg+xml"
}

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
    $requestLine = $reader.ReadLine()

    while ($reader.Peek() -ge 0) {
      $line = $reader.ReadLine()
      if ([string]::IsNullOrEmpty($line)) {
        break
      }
    }

    $path = "index.html"
    if ($requestLine -match "^[A-Z]+\s+([^?\s]+)") {
      $path = [Uri]::UnescapeDataString($Matches[1].TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($path)) {
        $path = "index.html"
      }
    }

    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $root $path))
    $status = "200 OK"

    if (-not $fullPath.StartsWith($root) -or -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      $status = "404 Not Found"
      $body = [System.Text.Encoding]::UTF8.GetBytes("Not found")
      $contentType = "text/plain; charset=utf-8"
    } else {
      $extension = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
      if ($contentTypes.ContainsKey($extension)) {
        $contentType = $contentTypes[$extension]
      } else {
        $contentType = "application/octet-stream"
      }
      $body = [System.IO.File]::ReadAllBytes($fullPath)
    }

    $header = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    $stream.Write($body, 0, $body.Length)
  } finally {
    $client.Close()
  }
}
