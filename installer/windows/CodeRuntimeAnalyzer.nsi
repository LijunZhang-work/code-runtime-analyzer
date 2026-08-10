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

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$WINDIR\System32\wscript.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS '$\"$INSTDIR\backend-control.vbs$\"'
!define MUI_FINISHPAGE_RUN_TEXT "打开后台控制中心"
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

Section "后台核心和 Web（必装）" SEC_CORE
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
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\后台控制中心.lnk" "$WINDIR\System32\wscript.exe" '$\"$INSTDIR\backend-control.vbs$\"' "" 0 SW_SHOWNORMAL "" "查看、启动、停止或重启后台"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\打开网页工作台.lnk" "$WINDIR\System32\wscript.exe" '$\"$INSTDIR\launcher.vbs$\" open' "" 0 SW_SHOWNORMAL "" "打开 ${PRODUCT_NAME} 网页工作台"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\使用说明.lnk" "$INSTDIR\docs\工具使用指南.md"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\字段字典填写说明.lnk" "$INSTDIR\docs\字段字典填写说明.md"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\卸载.lnk" "$INSTDIR\Uninstall.exe"

  nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\backend\src\launcher.mjs" start'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "后台没有正常启动。请在开始菜单打开使用说明，或查看：$LOCALAPPDATA\CodeRuntimeAnalyzer\backend.log"
  ${Else}
    MessageBox MB_ICONINFORMATION|MB_OK "后台已经安装并启动。$\r$\n$\r$\n你可以随时从开始菜单打开“Code Runtime Analyzer → 后台控制中心”，查看状态、启动、停止、重启或打开日志。$\r$\n$\r$\n编辑器扩展和 MCP 都不会由本安装程序自动安装。请分别使用单独发布的 VSIX 和 MCP 包。"
  ${EndIf}
SectionEnd

Section /o "登录 Windows 后自动启动后台" SEC_STARTUP
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_ID}" '$\"$WINDIR\System32\wscript.exe$\" $\"$INSTDIR\launcher.vbs$\" start'
SectionEnd

Section "Uninstall"
  IfFileExists "$INSTDIR\runtime\node.exe" 0 cleanup
  IfFileExists "$INSTDIR\backend\src\launcher.mjs" 0 cleanup
    nsExec::ExecToLog '"$INSTDIR\runtime\node.exe" "$INSTDIR\backend\src\launcher.mjs" stop'

  cleanup:
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_ID}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_ID}"
  DeleteRegKey HKCU "Software\${PRODUCT_ID}"
  RMDir /r "$SMPROGRAMS\${PRODUCT_NAME}"
  RMDir /r "$INSTDIR"

  ; 故意保留 $LOCALAPPDATA\CodeRuntimeAnalyzer：其中可能有用户字典和日志。
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "安装独立后台、后台控制中心、网页工作台、自带运行环境和产品字典；不安装插件或 MCP，也不修改任何编辑器。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_STARTUP} "让后台在登录后静默启动，编辑器、网页和 OpenCode 随时可以连接。"
!insertmacro MUI_FUNCTION_DESCRIPTION_END
