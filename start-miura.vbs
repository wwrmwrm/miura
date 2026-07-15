' Launch miura (SoundCloud desktop) without a visible console window
Option Explicit

Dim sh, fso, appDir, logFile, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
logFile = appDir & "\miura-start.log"

' Kill previous instance of this project’s electron/vite if needed is left to user.
' Start vite + electron via npm
sh.CurrentDirectory = appDir

' 0 = hidden window, False = don't wait
On Error Resume Next
cmd = "cmd /c npm run dev >> """ & logFile & """ 2>&1"
sh.Run cmd, 0, False

If Err.Number <> 0 Then
  MsgBox "Не удалось запустить miura." & vbCrLf & Err.Description & vbCrLf & vbCrLf & _
         "Проверь, что установлены Node.js и npm, и папка:" & vbCrLf & appDir, _
         vbCritical, "miura"
End If
