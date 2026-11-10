Option Explicit
Dim sh, fso, project, electron
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
project = fso.GetParentFolderName(WScript.ScriptFullName)
electron = project & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electron) Then
  MsgBox "找不到 Electron 运行时。请确认未移动或删除本文件夹中的 node_modules。", 16, "Hongfa Desktop Pet"
  WScript.Quit 1
End If
sh.CurrentDirectory = project
sh.Run """" & electron & """ """ & project & """", 0, False
