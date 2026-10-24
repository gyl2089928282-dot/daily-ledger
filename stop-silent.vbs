' stop-silent.vbs - stop all daily-ledger node processes (== pause the service)
' Matches node processes by command line keywords only, so other node apps are untouched.
' Writes a pause flag BEFORE killing, so the watchdog (healthcheck --daemon) will NOT auto-revive it.
' To resume: double-click start.bat / start-silent.vbs (it clears the pause flag automatically).
'
' PORTABLE: the project folder = the folder this script lives in.
' Processes are matched by script name and by the project folder itself, so it
' still works after the folder was renamed or moved to another drive.
Option Explicit

Dim shell, wmi, items, it, cmd, fso, root, pauseFile, stopped
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
pauseFile = root & "\private\paused.flag"

' write pause flag first
On Error Resume Next
If Not fso.FolderExists(root & "\private") Then
  fso.CreateFolder root & "\private"
End If
Dim pf
Set pf = fso.CreateTextFile(pauseFile, True)
pf.WriteLine "reason=user-close"
pf.WriteLine "at=" & Now
pf.Close
On Error GoTo 0

Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set items = wmi.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'")

stopped = 0

For Each it In items
  cmd = LCase("" & it.CommandLine)
  If InStr(cmd, "launch.js") > 0 Or _
     InStr(cmd, "healthcheck.js") > 0 Or _
     InStr(cmd, "server.js") > 0 Or _
     InStr(cmd, "notify.js") > 0 Or _
     InStr(cmd, LCase(root)) > 0 Then
    shell.Run "taskkill /PID " & it.ProcessId & " /F", 0, True
    stopped = stopped + 1
  End If
Next

MsgBox "Stopped " & stopped & " daily-ledger process(es)." & vbCrLf & _
       "Service paused. To resume, double-click start.bat.", _
       vbInformation, "daily-ledger"
