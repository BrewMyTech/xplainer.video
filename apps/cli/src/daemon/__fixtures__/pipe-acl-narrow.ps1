# The exact PowerShell `restrictPipeToOwnerScript()` emits for the pipe
# \\.\pipe\xplainer-0123456789abcdef at the default connect timeout, captured 2026-09-08 and
# recaptured 2026-09-09 when the success line moved to `[Console]::Out.WriteLine`: PowerShell
# wraps a value it formats at 80 columns with stdout redirected, and this one is a prefix, a
# digest-length pipe name and a SID.
# Lines beginning with `#` are this header and are stripped before the comparison; the script
# itself has none. A change to any line below is a change to the descriptor a Windows daemon's IPC
# endpoint gets, on a platform this suite cannot execute, so it is reviewed as a diff here.
$ErrorActionPreference = 'Stop'
$rights = [System.IO.Pipes.PipeAccessRights]'ReadData,ChangePermissions,ReadPermissions'
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'xplainer-0123456789abcdef', $rights, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::None, [System.IO.HandleInheritability]::None)
try {
  $client.Connect(5000)
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = New-Object System.IO.Pipes.PipeSecurity
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, [System.IO.Pipes.PipeAccessRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))
  $client.SetAccessControl($security)
  [Console]::Out.WriteLine('xplainer-pipe-acl applied to xplainer-0123456789abcdef for ' + $me.Value)
} finally {
  $client.Dispose()
}
