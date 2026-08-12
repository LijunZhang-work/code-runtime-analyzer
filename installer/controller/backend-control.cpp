#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <commctrl.h>

#include <algorithm>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr wchar_t kWindowClass[] = L"CodeRuntimeAnalyzerControlCenter";
constexpr wchar_t kWindowTitle[] = L"Code Runtime Analyzer 后台控制中心";
constexpr UINT kCommandFinished = WM_APP + 1;
constexpr UINT kTrayMessage = WM_APP + 2;
constexpr UINT_PTR kRefreshTimer = 1;
constexpr UINT kTrayId = 1;

enum ControlId {
  StatusLabel = 101,
  DetailLabel,
  RefreshButton,
  StartButton,
  StopButton,
  RestartButton,
  OpenWebButton,
  ExportButton,
  OpenLogButton,
  OpenFolderButton
};

struct CommandResult {
  std::wstring action;
  std::wstring output;
  DWORD exitCode = 1;
};

HWND gWindow = nullptr;
HWND gStatus = nullptr;
HWND gDetails = nullptr;
HFONT gTitleFont = nullptr;
HFONT gBodyFont = nullptr;
HBRUSH gBackgroundBrush = nullptr;
HBRUSH gStatusBrush = nullptr;
COLORREF gStatusColor = RGB(110, 118, 129);
bool gBusy = false;
std::wstring gInstallRoot;

void runAsync(const std::wstring& action);

std::wstring trim(std::wstring value) {
  const auto first = value.find_first_not_of(L" \t\r\n");
  if (first == std::wstring::npos) return L"";
  const auto last = value.find_last_not_of(L" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::vector<std::wstring> split(const std::wstring& value, wchar_t separator) {
  std::vector<std::wstring> parts;
  size_t start = 0;
  while (start <= value.size()) {
    const auto end = value.find(separator, start);
    parts.push_back(value.substr(start, end == std::wstring::npos ? value.size() - start : end - start));
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  return parts;
}

std::wstring executableDirectory() {
  std::wstring buffer(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  buffer.resize(length);
  const auto slash = buffer.find_last_of(L"\\/");
  return slash == std::wstring::npos ? L"." : buffer.substr(0, slash);
}

std::wstring quote(const std::wstring& value) {
  return L"\"" + value + L"\"";
}

std::wstring expandEnvironment(const wchar_t* value) {
  const DWORD count = ExpandEnvironmentStringsW(value, nullptr, 0);
  if (count == 0) return value;
  std::wstring result(count, L'\0');
  ExpandEnvironmentStringsW(value, result.data(), count);
  if (!result.empty() && result.back() == L'\0') result.pop_back();
  return result;
}

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) return L"";
  const int count = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (count <= 0) return L"";
  std::wstring result(count, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), count);
  return result;
}

CommandResult runLauncher(const std::wstring& action) {
  CommandResult result;
  result.action = action;
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE readPipe = nullptr;
  HANDLE writePipe = nullptr;
  if (!CreatePipe(&readPipe, &writePipe, &attributes, 0)) return result;
  SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);

  const std::wstring node = gInstallRoot + L"\\runtime\\node.exe";
  const std::wstring launcher = gInstallRoot + L"\\backend\\src\\launcher.mjs";
  std::wstring command = quote(node) + L" " + quote(launcher) + L" " + action + L" --control";
  std::vector<wchar_t> commandBuffer(command.begin(), command.end());
  commandBuffer.push_back(L'\0');

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = writePipe;
  startup.hStdError = writePipe;
  PROCESS_INFORMATION process{};
  const BOOL created = CreateProcessW(
    node.c_str(), commandBuffer.data(), nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW, nullptr, gInstallRoot.c_str(), &startup, &process);
  CloseHandle(writePipe);
  if (!created) {
    CloseHandle(readPipe);
    result.output = L"无法启动后台运行环境，Windows 错误码：" + std::to_wstring(GetLastError());
    return result;
  }

  std::string bytes;
  char buffer[4096];
  DWORD read = 0;
  while (ReadFile(readPipe, buffer, sizeof(buffer), &read, nullptr) && read > 0) {
    bytes.append(buffer, buffer + read);
  }
  WaitForSingleObject(process.hProcess, 30000);
  GetExitCodeProcess(process.hProcess, &result.exitCode);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  CloseHandle(readPipe);
  result.output = trim(utf8ToWide(bytes));
  return result;
}

void setBusy(bool busy, const wchar_t* message = nullptr) {
  gBusy = busy;
  for (int id : {RefreshButton, StartButton, StopButton, RestartButton, OpenWebButton, ExportButton}) {
    EnableWindow(GetDlgItem(gWindow, id), !busy);
  }
  if (message) SetWindowTextW(gStatus, message);
}

void setStatusVisual(bool running) {
  gStatusColor = running ? RGB(25, 135, 84) : RGB(176, 60, 60);
  DeleteObject(gStatusBrush);
  gStatusBrush = CreateSolidBrush(RGB(250, 250, 248));
  InvalidateRect(gStatus, nullptr, TRUE);
}

void showWindowFromTray() {
  ShowWindow(gWindow, SW_RESTORE);
  SetForegroundWindow(gWindow);
  if (!gBusy) runAsync(L"status");
}

void addTrayIcon() {
  NOTIFYICONDATAW data{};
  data.cbSize = sizeof(data);
  data.hWnd = gWindow;
  data.uID = kTrayId;
  data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  data.uCallbackMessage = kTrayMessage;
  data.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  wcscpy_s(data.szTip, kWindowTitle);
  Shell_NotifyIconW(NIM_ADD, &data);
}

void removeTrayIcon() {
  NOTIFYICONDATAW data{};
  data.cbSize = sizeof(data);
  data.hWnd = gWindow;
  data.uID = kTrayId;
  Shell_NotifyIconW(NIM_DELETE, &data);
}

void runAsync(const std::wstring& action) {
  if (gBusy) return;
  setBusy(true, L"● 正在处理，请稍候……");
  SetWindowTextW(gDetails, L"后台操作正在执行。窗口仍然可以移动，不会卡住。 ");
  std::thread([action] {
    auto result = std::make_unique<CommandResult>(runLauncher(action));
    PostMessageW(gWindow, kCommandFinished, 0, reinterpret_cast<LPARAM>(result.release()));
  }).detach();
}

void openPath(const std::wstring& path) {
  ShellExecuteW(gWindow, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

void handleResult(std::unique_ptr<CommandResult> result) {
  setBusy(false);
  if (result->exitCode != 0) {
    setStatusVisual(false);
    SetWindowTextW(gStatus, L"● 操作没有成功");
    const std::wstring explanation = result->output.empty()
      ? L"后台没有返回详细信息。请点击“打开日志”查看原因。"
      : result->output;
    SetWindowTextW(gDetails, explanation.c_str());
    MessageBoxW(gWindow, explanation.c_str(), L"后台操作失败", MB_OK | MB_ICONERROR);
    return;
  }

  const auto parts = split(result->output, L'|');
  const bool running = !parts.empty() && (parts[0] == L"running" || parts[0] == L"started" || parts[0] == L"already-running" || parts[0] == L"opened");
  if (result->action == L"status") {
    setStatusVisual(running);
    if (running && parts.size() >= 5) {
      SetWindowTextW(gStatus, L"● 后台正在运行");
      const std::wstring details = L"版本：" + parts[1] + L"\r\n服务地址：" + parts[2]
        + L"\r\n进程号：" + parts[3] + L"\r\n启动时间：" + parts[4];
      SetWindowTextW(gDetails, details.c_str());
    } else {
      SetWindowTextW(gStatus, L"● 后台没有运行");
      const std::wstring address = parts.size() > 1 ? parts[1] : L"未知";
      const std::wstring details = L"预定服务地址：" + address + L"\r\n点击“启动后台”即可恢复。";
      SetWindowTextW(gDetails, details.c_str());
    }
    return;
  }

  if (result->action == L"export-diagnostics" && parts.size() >= 2) {
    const std::wstring message = L"诊断报告已经生成：\r\n" + parts[1];
    MessageBoxW(gWindow, message.c_str(), L"诊断报告", MB_OK | MB_ICONINFORMATION);
    std::wstring parameters = L"/select," + quote(parts[1]);
    ShellExecuteW(gWindow, L"open", L"explorer.exe", parameters.c_str(), nullptr, SW_SHOWNORMAL);
  }
  runAsync(L"status");
}

HWND makeControl(const wchar_t* kind, const wchar_t* text, DWORD style,
                 int x, int y, int width, int height, int id) {
  HWND control = CreateWindowExW(0, kind, text, WS_CHILD | WS_VISIBLE | style,
    x, y, width, height, gWindow, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)),
    GetModuleHandleW(nullptr), nullptr);
  SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(gBodyFont), TRUE);
  return control;
}

void createControls() {
  auto title = makeControl(L"STATIC", L"后台系统", SS_LEFT, 36, 28, 620, 38, 0);
  SendMessageW(title, WM_SETFONT, reinterpret_cast<WPARAM>(gTitleFont), TRUE);
  makeControl(L"STATIC", L"这里负责 Web 工作台、编辑器扩展和 OpenCode 共用的数据服务。", SS_LEFT,
    37, 72, 640, 24, 0);
  gStatus = makeControl(L"STATIC", L"● 正在检查后台状态……", SS_LEFT, 38, 116, 630, 32, StatusLabel);
  gDetails = makeControl(L"STATIC", L"", SS_LEFT, 38, 157, 630, 92, DetailLabel);

  makeControl(L"BUTTON", L"刷新状态", BS_PUSHBUTTON, 38, 270, 130, 38, RefreshButton);
  makeControl(L"BUTTON", L"启动后台", BS_PUSHBUTTON, 180, 270, 130, 38, StartButton);
  makeControl(L"BUTTON", L"停止后台", BS_PUSHBUTTON, 322, 270, 130, 38, StopButton);
  makeControl(L"BUTTON", L"重新启动", BS_PUSHBUTTON, 464, 270, 130, 38, RestartButton);
  makeControl(L"BUTTON", L"打开 Web 工作台", BS_DEFPUSHBUTTON, 38, 324, 188, 42, OpenWebButton);
  makeControl(L"BUTTON", L"导出诊断报告", BS_PUSHBUTTON, 238, 324, 174, 42, ExportButton);
  makeControl(L"BUTTON", L"打开日志", BS_PUSHBUTTON, 424, 324, 118, 42, OpenLogButton);
  makeControl(L"BUTTON", L"安装目录", BS_PUSHBUTTON, 554, 324, 112, 42, OpenFolderButton);
  makeControl(L"STATIC", L"最小化窗口后仍可从右下角托盘图标重新打开。", SS_LEFT,
    38, 390, 620, 22, 0);
}

LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_CREATE:
      gWindow = window;
      gInstallRoot = executableDirectory();
      gBackgroundBrush = CreateSolidBrush(RGB(250, 250, 248));
      gStatusBrush = CreateSolidBrush(RGB(250, 250, 248));
      gTitleFont = CreateFontW(-27, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
      gBodyFont = CreateFontW(-17, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
      createControls();
      addTrayIcon();
      SetTimer(window, kRefreshTimer, 10000, nullptr);
      runAsync(L"status");
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wParam)) {
        case RefreshButton: runAsync(L"status"); break;
        case StartButton: runAsync(L"start"); break;
        case StopButton: runAsync(L"stop"); break;
        case RestartButton: runAsync(L"restart"); break;
        case OpenWebButton: runAsync(L"open"); break;
        case ExportButton: runAsync(L"export-diagnostics"); break;
        case OpenLogButton: {
          const std::wstring log = expandEnvironment(L"%LOCALAPPDATA%\\CodeRuntimeAnalyzer\\backend.log");
          if (GetFileAttributesW(log.c_str()) != INVALID_FILE_ATTRIBUTES) openPath(log);
          else openPath(expandEnvironment(L"%LOCALAPPDATA%\\CodeRuntimeAnalyzer"));
          break;
        }
        case OpenFolderButton: openPath(gInstallRoot); break;
      }
      return 0;
    case WM_TIMER:
      if (wParam == kRefreshTimer && !gBusy && IsWindowVisible(window)) runAsync(L"status");
      return 0;
    case kCommandFinished:
      handleResult(std::unique_ptr<CommandResult>(reinterpret_cast<CommandResult*>(lParam)));
      return 0;
    case kTrayMessage:
      if (lParam == WM_LBUTTONDBLCLK) showWindowFromTray();
      if (lParam == WM_RBUTTONUP) {
        POINT point{};
        GetCursorPos(&point);
        HMENU menu = CreatePopupMenu();
        AppendMenuW(menu, MF_STRING, 1, L"打开后台控制中心");
        AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        AppendMenuW(menu, MF_STRING, 2, L"退出控制中心");
        SetForegroundWindow(window);
        const int selected = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON,
          point.x, point.y, 0, window, nullptr);
        DestroyMenu(menu);
        if (selected == 1) showWindowFromTray();
        if (selected == 2) DestroyWindow(window);
      }
      return 0;
    case WM_SIZE:
      if (wParam == SIZE_MINIMIZED) ShowWindow(window, SW_HIDE);
      return 0;
    case WM_CTLCOLORSTATIC: {
      HDC context = reinterpret_cast<HDC>(wParam);
      SetBkColor(context, RGB(250, 250, 248));
      if (reinterpret_cast<HWND>(lParam) == gStatus) SetTextColor(context, gStatusColor);
      else SetTextColor(context, RGB(39, 43, 48));
      return reinterpret_cast<LRESULT>(gBackgroundBrush);
    }
    case WM_CLOSE:
      DestroyWindow(window);
      return 0;
    case WM_DESTROY:
      KillTimer(window, kRefreshTimer);
      removeTrayIcon();
      DeleteObject(gTitleFont);
      DeleteObject(gBodyFont);
      DeleteObject(gBackgroundBrush);
      DeleteObject(gStatusBrush);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
  SetProcessDPIAware();
  int argumentCount = 0;
  LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
  if (argumentCount > 1 && std::wstring(arguments[1]) == L"--self-test") {
    gInstallRoot = executableDirectory();
    const CommandResult result = runLauncher(L"status");
    LocalFree(arguments);
    return result.exitCode == 0 && result.output.rfind(L"running|", 0) == 0 ? 0 : 5;
  }
  if (arguments) LocalFree(arguments);
  INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_STANDARD_CLASSES};
  InitCommonControlsEx(&controls);

  HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\CodeRuntimeAnalyzerControlCenter");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    if (HWND existing = FindWindowW(kWindowClass, nullptr)) {
      ShowWindow(existing, SW_RESTORE);
      SetForegroundWindow(existing);
    }
    CloseHandle(mutex);
    return 0;
  }

  WNDCLASSEXW windowClass{};
  windowClass.cbSize = sizeof(windowClass);
  windowClass.hInstance = instance;
  windowClass.lpfnWndProc = windowProcedure;
  windowClass.lpszClassName = kWindowClass;
  windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  windowClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  windowClass.hIconSm = LoadIconW(nullptr, IDI_APPLICATION);
  windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
  RegisterClassExW(&windowClass);

  const int width = 720;
  const int height = 490;
  const int x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
  const int y = (GetSystemMetrics(SM_CYSCREEN) - height) / 2;
  HWND window = CreateWindowExW(0, kWindowClass, kWindowTitle,
    WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
    x, y, width, height, nullptr, nullptr, instance, nullptr);
  if (!window) {
    CloseHandle(mutex);
    return 1;
  }
  ShowWindow(window, showCommand);
  UpdateWindow(window);

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  CloseHandle(mutex);
  return static_cast<int>(message.wParam);
}
