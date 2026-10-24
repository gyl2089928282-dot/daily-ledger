' start-silent.vbs - start daily-ledger completely windowless
' Double-click it: the service runs in background, no black box appears on desktop.
' Check status via the web admin page (link on the main page), or stop-silent.vbs to stop.
'
' PORTABLE: no username, no hardcoded drive. The project folder = the folder this
' script lives in, so you can copy the whole folder to any machine / any path.
' node.exe is looked up in this order:
'   1) <root>\runtime\node.exe     bundled portable runtime (recipient needs no Node install)
'   2) whatever "where node" says  Node installed normally
'   3) %ProgramFiles%\nodejs\node.exe
Option Explicit

Dim shell, fso, root, node, launch, health, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
launch = root & "\launch.js"
health = root & "\healthcheck.js"

If Not fso.FileExists(launch) Then
  MsgBox "launch.js not found next to this script:" & vbCrLf & root & vbCrLf & vbCrLf & _
         "Keep start-silent.vbs inside the daily-ledger folder.", vbExclamation, "daily-ledger"
  WScript.Quit 1
End If

node = FindNode()
If node = "" Then
  MsgBox "node.exe not found on this machine." & vbCrLf & vbCrLf & _
         "Option 1 - install Node.js 18+ from https://nodejs.org" & vbCrLf & _
         "Option 2 - copy a node.exe into:" & vbCrLf & _
         "           " & root & "\runtime\node.exe" & vbCrLf & _
         "           (running make-portable.bat does it for you)", vbCritical, "daily-ledger"
  WScript.Quit 1
End If

' Clear the pause flag first, otherwise the watchdog refuses to keep the service alive.
On Error Resume Next
If fso.FileExists(root & "\private\paused.flag") Then
  fso.DeleteFile root & "\private\paused.flag", True
End If
On Error GoTo 0

' 0 = hidden window, False = don't wait for it
rc = shell.Run("""" & node & """ """ & launch & """", 0, False)

' start the watchdog silently too
rc = shell.Run("""" & node & """ """ & health & """ --daemon", 0, False)

Function FindNode()
  Dim p, tmp, tf, s
  FindNode = ""

  ' 1) bundled portable runtime
  p = root & "\runtime\node.exe"
  If fso.FileExists(p) Then
    FindNode = p
    Exit Function
  End If

  ' 2) ask Windows where node lives (hidden cmd, result written to a temp file)
  tmp = fso.GetSpecialFolder(2) & "\daily-ledger-node.txt"
  On Error Resume Next
  If fso.FileExists(tmp) Then fso.DeleteFile tmp, True
  shell.Run "cmd.exe /c where node 1> """ & tmp & """ 2>nul", 0, True
  If fso.FileExists(tmp) Then
    Set tf = fso.OpenTextFile(tmp, 1, False)
    Do While Not tf.AtEndOfStream
      s = Trim(tf.ReadLine)
      If s <> "" And fso.FileExists(s) Then
        tf.Close
        On Error Resume Next
        fso.DeleteFile tmp, True
        On Error GoTo 0
        FindNode = s
        Exit Function
      End If
    Loop
    tf.Close
    fso.DeleteFile tmp, True
  End If
  On Error GoTo 0

  ' 3) the default install location
  p = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
  If fso.FileExists(p) Then
    FindNode = p
    Exit Function
  End If
End Function
