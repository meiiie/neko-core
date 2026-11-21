export function windowsZipExtractCommand(source: string, destination: string): string {
  return `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${source.replaceAll("'", "''")}', '${destination.replaceAll("'", "''")}')`;
}
