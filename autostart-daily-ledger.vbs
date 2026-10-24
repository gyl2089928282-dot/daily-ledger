' autostart-daily-ledger.vbs - login autostart (no window, no mojibake)
' install-autostart.bat copies this file into the Windows Startup folder, so on login
' wscript runs it silently:  wait 20s (for network) -> start launch.js + watchdog
' healthcheck --daemon in background. No window ever appears.
' Log written to autostart.log inside the project folder.
'
' PORTABLE: the project folder is found in this order:
'   a) a sibling file <this script>.path whose first line is the folder
'      (install-autostart.bat writes it when it copies the stub to Startup)
'   b) otherwise: the folder this script lives in
' node.exe is looked up exactly like start-silent.vbs does.
Option Explicit

Dim shell, fso, root, node, logFile, pathFile, tf, s
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)

pathFile = WScript.ScriptFullName & ".path"
If fso.FileExists(pathFile) Then
  s = ""
  On Error Resume Next
  Set tf = fso.OpenTextFile(pathFile, 1, False)
  If Not tf.AtEndOfStream Then s = Trim(tf.ReadLine)
  tf.Close
  On Error GoTo 0
  s = Replace(s, """", "")
  If s <> "" And fso.FolderExists(s) Then root = s
End If

logFile = root & "\autostart.log"

LogLine "autostart fired (root=" & root & ")"

WScript.Sleep 20000

If Not fso.FileExists(root & "\launch.js") Then
  LogLine "launch.js missing, aborted"
  WScript.Quit 1
End If

' Respect the paused state: if the user stopped it last time (paused.flag exists),
' do NOT auto-resume on this boot. Wait for the user to double-click start.bat.
If fso.FileExists(root & "\private\paused.flag") Then
  LogLine "paused.flag exists, skip autostart (user paused)"
  WScript.Quit 0
End If

node = FindNode()
If node = "" Then
  LogLine "node.exe not found, aborted"
  WScript.Quit 1
End If

' 0 = hidden window, False = don't wait
shell.Run """" & node & """ """ & root & "\launch.js""", 0, False
LogLine "launch.js started (hidden)"

shell.Run """" & node & """ """ & root & "\healthcheck.js"" --daemon", 0, False
LogLine "health daemon started (hidden)"

Sub LogLine(msg)
  On Error Resume Next
  Dim f
  Set f = fso.OpenTextFile(logFile, 8, True)
  f.WriteLine "[" & Now & "] " & msg
  f.Close
  On Error GoTo 0
End Sub

Function FindNode()
  Dim p, tmp, tfx, line
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
    Set tfx = fso.OpenTextFile(tmp, 1, False)
    Do While Not tfx.AtEndOfStream
      line = Trim(tfx.ReadLine)
      If line <> "" And fso.FileExists(line) Then
        tfx.Close
        On Error Resume Next
        fso.DeleteFile tmp, True
        On Error GoTo 0
        FindNode = line
        Exit Function
      End If
    Loop
    tfx.Close
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
