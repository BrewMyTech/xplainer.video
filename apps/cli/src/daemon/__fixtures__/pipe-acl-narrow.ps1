# The exact PowerShell `restrictPipeToOwnerScript()` emits for the pipe
# \\.\pipe\xplainer-0123456789abcdef at the default connect timeout, captured 2026-09-08.
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
  Write-Output ('xplainer-pipe-acl applied to xplainer-0123456789abcdef for ' + $me.Value)
} finally {
  $client.Dispose()
}
