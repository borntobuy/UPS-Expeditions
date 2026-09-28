' UPS Expéditions : lance l'application sans fenêtre et ouvre l'interface.
' Argument /demo : mode démo (fausses commandes, port suivant).
Option Explicit
Dim sh, fso, dir, demo, port, url, logName, i, lnk, sc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
demo = False
If WScript.Arguments.Count > 0 Then demo = (LCase(WScript.Arguments(0)) = "/demo")

If sh.Run("cmd /c where node", 0, True) <> 0 Then
  MsgBox "Node.js n'est pas installé : https://nodejs.org (version LTS).", vbCritical, "UPS Expéditions"
  WScript.Quit
End If

If Not demo And Not fso.FileExists(dir & "\.env") Then
  fso.CopyFile dir & "\.env.example", dir & "\.env"
  MsgBox "Premier lancement : le fichier de configuration va s'ouvrir." & vbCrLf & _
         "Remplissez-le, enregistrez-le, puis relancez UPS Expéditions.", vbInformation, "UPS Expéditions"
  sh.Run "notepad """ & dir & "\.env""", 1, False
  WScript.Quit
End If

' Raccourci sur le Bureau (créé une seule fois)
If Not demo Then
  lnk = sh.SpecialFolders("Desktop") & "\UPS Expéditions.lnk"
  If Not fso.FileExists(lnk) Then
    Set sc = sh.CreateShortcut(lnk)
    sc.TargetPath = "wscript.exe"
    sc.Arguments = """" & WScript.ScriptFullName & """"
    sc.WorkingDirectory = dir
    sc.Description = "UPS Expéditions"
    sc.Save
  End If
End If

port = ReadPort()
If demo Then port = port + 1
url = "http://localhost:" & port & "/"

' Déjà lancée : on ouvre simplement l'interface
If Not IsUp(url) Then
  If Not fso.FolderExists(dir & "\node_modules") Then
    sh.Popup "Premier lancement : installation des composants (environ une minute)...", 3, "UPS Expéditions", vbInformation
    sh.Run "cmd /c npm install --omit=dev > install.log 2>&1", 0, True
  End If
  If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder dir & "\data"
  If demo Then
    logName = "data\server-demo.log"
    sh.Run "cmd /c node src\server.js --demo > " & logName & " 2>&1", 0, False
  Else
    logName = "data\server.log"
    sh.Run "cmd /c node src\server.js > " & logName & " 2>&1", 0, False
  End If
  For i = 1 To 40
    WScript.Sleep 500
    If IsUp(url) Then Exit For
  Next
  If Not IsUp(url) Then
    MsgBox "L'application n'a pas démarré." & vbCrLf & "Détail dans : " & dir & "\" & logName, vbCritical, "UPS Expéditions"
    WScript.Quit
  End If
End If
sh.Run url

Function IsUp(u)
  Dim x
  IsUp = False
  On Error Resume Next
  Set x = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  x.setTimeouts 1000, 1000, 1000, 1000
  x.Open "GET", u & "api/status", False
  x.Send
  If Err.Number = 0 Then IsUp = (x.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function

Function ReadPort()
  Dim f, l, v
  ReadPort = 3000
  If Not fso.FileExists(dir & "\.env") Then Exit Function
  Set f = fso.OpenTextFile(dir & "\.env", 1)
  Do Until f.AtEndOfStream
    l = Trim(f.ReadLine)
    If UCase(Left(l, 5)) = "PORT=" Then
      v = Trim(Mid(l, 6))
      If IsNumeric(v) And v <> "" Then ReadPort = CLng(v)
    End If
  Loop
  f.Close
End Function
