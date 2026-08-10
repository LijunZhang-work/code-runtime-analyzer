Option Explicit

Dim shell, fileSystem, root, choice, statusText, resultText, logPath
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
logPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\CodeRuntimeAnalyzer\backend.log"

Function RunLauncher(action)
  Dim command, process, output, parts
  command = Chr(34) & root & "\runtime\node.exe" & Chr(34) & " " & _
    Chr(34) & root & "\backend\src\launcher.mjs" & Chr(34) & " " & action & " --control"
  Set process = shell.Exec(command)
  Do While process.Status = 0
    WScript.Sleep 100
  Loop
  output = Trim(process.StdOut.ReadAll)
  If process.ExitCode <> 0 Then
    RunLauncher = "操作失败。请打开后台日志查看具体原因：" & vbCrLf & logPath
    Exit Function
  End If
  parts = Split(output, "|")
  If action = "status" Then
    If parts(0) = "running" Then
      RunLauncher = "后台状态：正在运行" & vbCrLf & _
        "版本：" & parts(1) & vbCrLf & _
        "服务地址：" & parts(2) & vbCrLf & _
        "进程号：" & parts(3) & vbCrLf & _
        "启动时间：" & parts(4) & vbCrLf & _
        "日志：" & logPath
    Else
      RunLauncher = "后台状态：未运行" & vbCrLf & _
        "预定服务地址：" & parts(1) & vbCrLf & _
        "日志：" & logPath
    End If
  ElseIf action = "start" Then
    If parts(0) = "already-running" Then
      RunLauncher = "后台原本就在运行。" & vbCrLf & "服务地址：" & parts(1)
    Else
      RunLauncher = "后台已经启动。" & vbCrLf & "服务地址：" & parts(1)
    End If
  ElseIf action = "restart" Then
    RunLauncher = "后台已经重新启动。" & vbCrLf & "服务地址：" & parts(1)
  ElseIf action = "stop" Then
    If parts(0) = "not-running" Then
      RunLauncher = "后台原本就没有运行。"
    Else
      RunLauncher = "后台已经停止。"
    End If
  Else
    RunLauncher = output
  End If
End Function

' 命令行模式供安装检查和管理员排障使用；不传参数时打开交互控制中心。
If WScript.Arguments.Count > 0 Then
  WScript.Echo RunLauncher(WScript.Arguments(0))
  WScript.Quit 0
End If

Do
  statusText = RunLauncher("status")
  choice = InputBox( _
    statusText & vbCrLf & vbCrLf & _
    "请输入数字选择操作：" & vbCrLf & _
    "1  打开 Web 工作台" & vbCrLf & _
    "2  启动后台" & vbCrLf & _
    "3  停止后台" & vbCrLf & _
    "4  重新启动后台" & vbCrLf & _
    "5  打开后台日志" & vbCrLf & _
    "6  打开安装目录" & vbCrLf & _
    "取消  关闭控制中心", _
    "Code Runtime Analyzer 后台控制中心")

  If choice = "" Then Exit Do

  Select Case Trim(choice)
    Case "1"
      resultText = RunLauncher("open")
    Case "2"
      resultText = RunLauncher("start")
      MsgBox resultText, vbInformation, "后台控制中心"
    Case "3"
      resultText = RunLauncher("stop")
      MsgBox resultText, vbInformation, "后台控制中心"
    Case "4"
      resultText = RunLauncher("restart")
      MsgBox resultText, vbInformation, "后台控制中心"
    Case "5"
      If fileSystem.FileExists(logPath) Then
        shell.Run "notepad.exe " & Chr(34) & logPath & Chr(34), 1, False
      Else
        MsgBox "暂时还没有后台日志。", vbInformation, "后台控制中心"
      End If
    Case "6"
      shell.Run "explorer.exe " & Chr(34) & root & Chr(34), 1, False
    Case Else
      MsgBox "请输入 1 到 6。", vbExclamation, "后台控制中心"
  End Select
Loop
