<#
.SYNOPSIS
  Replaces the icon of a Windows PE executable.

.DESCRIPTION
  The single-file build starts life as a copy of node.exe, so without this step
  the packaged app wears Node's icon in Explorer, the taskbar and Alt-Tab.

  Swapping it needs a PE resource edit, and the Win32 resource-update API is
  the only way to do that without adding a build dependency that ships a
  prebuilt native binary — which is not a reasonable thing to ask of a tool
  whose whole premise is that it reads private logs and has no dependencies.

  An .ico file and the RT_GROUP_ICON resource hold the same directory in two
  slightly different shapes: the file entry ends with a 4-byte offset into the
  file, the resource entry ends with a 2-byte resource id. Everything before
  that is identical, which is why the conversion below is a straight copy plus
  a swapped tail.
#>
param(
  [Parameter(Mandatory = $true)][string] $Exe,
  [Parameter(Mandatory = $true)][string] $Ico
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace AgentSessionObserver -Name NativeResources -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr BeginUpdateResourceW(string fileName, bool deleteExistingResources);

[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);

[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool EndUpdateResourceW(IntPtr update, bool discard);
'@

$RT_ICON = [IntPtr]3
$RT_GROUP_ICON = [IntPtr]14
# 1033 = en-US. Node's own icon lives here too, so writing the same language is
# what actually replaces it rather than adding a second candidate beside it.
$LANG = [uint16]1033
# The group icon id an executable's shell icon is taken from is the numerically
# lowest one, and node.exe uses 1.
$GROUP_ID = [IntPtr]1

$bytes = [System.IO.File]::ReadAllBytes($Ico)
if ($bytes.Length -lt 6 -or [BitConverter]::ToUInt16($bytes, 2) -ne 1) {
  throw "$Ico is not an icon file"
}
$count = [BitConverter]::ToUInt16($bytes, 4)
if ($count -lt 1) { throw "$Ico contains no images" }

$group = New-Object byte[] (6 + 14 * $count)
[Array]::Copy($bytes, 0, $group, 0, 6)

$images = New-Object 'System.Collections.Generic.List[byte[]]'
for ($i = 0; $i -lt $count; $i++) {
  $src = 6 + $i * 16
  $dst = 6 + $i * 14
  # bWidth, bHeight, bColorCount, bReserved, wPlanes, wBitCount, dwBytesInRes
  [Array]::Copy($bytes, $src, $group, $dst, 12)
  [Array]::Copy([BitConverter]::GetBytes([uint16]($i + 1)), 0, $group, $dst + 12, 2)

  $size = [BitConverter]::ToUInt32($bytes, $src + 8)
  $offset = [BitConverter]::ToUInt32($bytes, $src + 12)
  $image = New-Object byte[] $size
  [Array]::Copy($bytes, $offset, $image, 0, $size)
  $images.Add($image)
}

$handle = [AgentSessionObserver.NativeResources]::BeginUpdateResourceW($Exe, $false)
if ($handle -eq [IntPtr]::Zero) {
  throw "BeginUpdateResource failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

try {
  for ($i = 0; $i -lt $count; $i++) {
    $image = $images[$i]
    $ok = [AgentSessionObserver.NativeResources]::UpdateResourceW(
      $handle, $RT_ICON, [IntPtr]($i + 1), $LANG, $image, [uint32]$image.Length)
    if (-not $ok) {
      throw "UpdateResource failed for icon $($i + 1) (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
  }

  $ok = [AgentSessionObserver.NativeResources]::UpdateResourceW(
    $handle, $RT_GROUP_ICON, $GROUP_ID, $LANG, $group, [uint32]$group.Length)
  if (-not $ok) {
    throw "UpdateResource failed for the icon group (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
  }
} catch {
  [void][AgentSessionObserver.NativeResources]::EndUpdateResourceW($handle, $true)
  throw
}

if (-not [AgentSessionObserver.NativeResources]::EndUpdateResourceW($handle, $false)) {
  throw "EndUpdateResource failed (error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
}

Write-Output "$count icon size(s) written"
