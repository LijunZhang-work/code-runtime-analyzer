Option Explicit

Dim shell, fileSystem, root, command, action
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
action = "start"
If WScript.Arguments.Count > 0 Then action = WScript.Arguments(0)
command = Chr(34) & root & "\runtime\node.exe" & Chr(34) & " " & Chr(34) & root & "\backend\src\launcher.mjs" & Chr(34) & " " & action
shell.Run command, 0, False
