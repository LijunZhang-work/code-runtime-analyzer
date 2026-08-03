Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.10.0"
!endif
!ifndef SOURCE_ROOT
  !define SOURCE_ROOT "..\..\build\distribution\windows"
!endif
!ifndef OUTPUT_DIR
  !define OUTPUT_DIR "..\..\build\installer"
!endif
!ifndef VSIX_NAME
  !define VSIX_NAME "Code-Runtime-Analyzer-v0.10.0.vsix"
!endif

!define PRODUCT_NAME "Code Runtime Analyzer"
!define PRODUCT_ID "CodeRuntimeAnalyzer"
!define PRODUCT_PUBLISHER "LijunZhang-work"
!define PRODUCT_WEB "https://github.com/LijunZhang-work/code-runtime-analyzer"

Name "${PRODUCT_NAME} ${APP_VERSION}"
OutFile "${OUTPUT_DIR}\Code-Runtime-Analyzer-Setup-v${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\CodeRuntimeAnalyzer"
InstallDirRegKey HKCU "Software\${PRODUCT_ID}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ManifestDPIAware true
BrandingText "${PRODUCT_NAME}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "CompanyName" "${PRODUCT_PUBLISHER}"
VIAddVersionKey "FileDescription" "代码结构、产品模块与历史运行数据分析平台"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright ${PRODUCT_PUBLISHER}"

Var VSCodeCli

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\runtime\node.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS '$\"$INSTDIR\backend\src\launcher.mjs$\" open'
!define MUI_FINISHPAGE_RUN_TEXT "安装完成后打开 Web 工作台"
!define MUI_FINISHPAGE_LINK "查看项目主页"
!define MUI_FINISHPAGE_LINK_LOCATION "${PRODUCT_WEB}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function FindVSCode
  StrCpy $VSCodeCli ""
  IfFileExists "$LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" 0 +2
    StrCpy $VSCodeCli "$LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
  ${If} $VSCodeCli == ""
    IfFileExists "$PROGRAMFILES64\Microsoft VS Code\bin\code.cmd" 0 +2
      StrCpy $VSCodeCli "$PROGRAMFILES64\Microsoft VS Code\bin\code.cmd"
  ${EndIf}
  ${If} $VSCodeCli == ""
    IfFileExists "$PROGRAMFILES\Microsoft VS Code\bin\code.cmd" 0 +2
      StrCpy $VSCodeCli "$PROGRAMFILES\Microsoft VS Code\bin\code.cmd"
  ${EndIf}
FunctionEnd

Function .onInit
  Call FindVSCode
FunctionEnd

Section "核心后台、网页和 MCP（必装）" SEC_CORE
  SectionIn RO

  ; 升级时先停止旧后台，避免覆盖正在使用的文件。
  IfFileExists "$INSTDIR\runtime\node.exe" 0 files
  IfFileExists "$INSTDIR\backend\src\launcher.mjs" 0 files
    nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\backend\src\launcher.mjs" stop'

  files:
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${SOURCE_ROOT}\*.*"

  ; 用户字典是长期资料。升级时只补充缺失的内置字典，绝不覆盖已有文件。
  SetOutPath "$LOCALAPPDATA\CodeRuntimeAnalyzer\dictionaries"
  SetOverwrite off
  File /r "${SOURCE_ROOT}\backend\dictionaries\*.*"
  SetOverwrite on

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\${PRODUCT_ID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}" "URLInfoAbout" "${PRODUCT_WEB}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\打开网页工作台.lnk" "$WINDIR\System32\wscript.exe" '$\"$INSTDIR\launcher.vbs$\" open' "" 0 SW_SHOWNORMAL "" "打开 ${PRODUCT_NAME} 网页工作台"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\使用说明.lnk" "$INSTDIR\docs\工具使用指南.md"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\字段字典填写说明.lnk" "$INSTDIR\docs\字段字典填写说明.md"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\卸载.lnk" "$INSTDIR\Uninstall.exe"

  nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\backend\src\launcher.mjs" start'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "后台没有正常启动。请在开始菜单打开使用说明，或查看：$LOCALAPPDATA\CodeRuntimeAnalyzer\backend.log"
  ${EndIf}
SectionEnd

Section "自动安装 VS Code 扩展" SEC_VSCODE
  ${If} $VSCodeCli == ""
    DetailPrint "未找到 VS Code，跳过扩展安装。以后可从安装目录的 extension 文件夹手动安装 VSIX。"
  ${Else}
    nsExec::ExecToLog '"$SYSDIR\cmd.exe" /d /c ""$VSCodeCli" --install-extension "$INSTDIR\extension\${VSIX_NAME}" --force"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "后台和网页已经安装，但 VS Code 扩展自动安装失败。可以稍后从安装目录的 extension 文件夹手动安装 VSIX。"
    ${EndIf}
  ${EndIf}
SectionEnd

Section "登录 Windows 后自动启动后台" SEC_STARTUP
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_ID}" '$\"$WINDIR\System32\wscript.exe$\" $\"$INSTDIR\launcher.vbs$\" start'
SectionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\runtime\node.exe" 0 extension
  IfFileExists "$INSTDIR\backend\src\launcher.mjs" 0 extension
    nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\backend\src\launcher.mjs" stop'

  extension:
  Call un.FindVSCode
  ${If} $VSCodeCli != ""
    nsExec::ExecToLog '"$SYSDIR\cmd.exe" /d /c ""$VSCodeCli" --uninstall-extension local.cpp-csv-diagnostics"'
  ${EndIf}

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_ID}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}"
  DeleteRegKey HKCU "Software\${PRODUCT_ID}"
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  RMDir /r "$INSTDIR"

  ; 故意保留 $LOCALAPPDATA\CodeRuntimeAnalyzer：其中可能有用户字典和日志。
SectionEnd

Function un.FindVSCode
  StrCpy $VSCodeCli ""
  IfFileExists "$LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" 0 +2
    StrCpy $VSCodeCli "$LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
  ${If} $VSCodeCli == ""
    IfFileExists "$PROGRAMFILES64\Microsoft VS Code\bin\code.cmd" 0 +2
      StrCpy $VSCodeCli "$PROGRAMFILES64\Microsoft VS Code\bin\code.cmd"
  ${EndIf}
  ${If} $VSCodeCli == ""
    IfFileExists "$PROGRAMFILES\Microsoft VS Code\bin\code.cmd" 0 +2
      StrCpy $VSCodeCli "$PROGRAMFILES\Microsoft VS Code\bin\code.cmd"
  ${EndIf}
FunctionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "安装独立后台、网页工作台、OpenCode/AI MCP、自带运行环境和产品字典。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_VSCODE} "检测本机 VS Code 并自动安装扩展。未安装 VS Code 时会安全跳过。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_STARTUP} "让后台在登录后静默启动，VS Code、网页和 OpenCode 随时可以连接。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END
