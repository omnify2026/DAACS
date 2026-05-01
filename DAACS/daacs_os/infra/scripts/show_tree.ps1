$base = "C:\Users\Admin\Desktop\DAACS\DAACS_OS"
$dirs = Get-ChildItem -Path $base -Directory -Recurse | Sort-Object FullName
foreach ($d in $dirs) {
    $rel = $d.FullName.Substring($base.Length + 1)
    $depth = ($rel.Split('\').Length - 1)
    $indent = "  " * $depth
    $name = $d.Name + "/"
    Write-Host "$indent$name"
}
Write-Host "`n--- Files ---"
$files = Get-ChildItem -Path $base -File -Recurse | Where-Object { $_.DirectoryName -eq $base -or $_.Directory.FullName.Substring($base.Length + 1).Split('\').Length -le 3 }
foreach ($f in $files) {
    $rel = $f.FullName.Substring($base.Length + 1)
    Write-Host $rel
}
