# -*- coding: utf-8 -*-
"""
全局划词探针（Windows）

职责：监听全局鼠标，一旦检测到「拖拽选中」就取出选中文本，以 JSON 行输出到 stdout。
主进程（Electron）负责展示工具栏、调用 AI；这里不做任何 UI。

为什么用「模拟 Ctrl+C + 剪贴板」而不是 UI Automation：
  UIA 的 TextPattern 在 Python 里需要 comtypes/pywin32，且各应用支持度参差；
  Ctrl+C 是唯一能覆盖浏览器 / Office / 编辑器 的通用手段。
  代价是剪贴板会被短暂占用，所以这里做了「读之前先存、读之后还原」。

协议（stdout，每行一个 JSON，ensure_ascii 保证纯 ASCII）：
  {"t":"ready"}
  {"t":"down","x":..,"y":..}                     左键按下（主进程用来收起悬浮层）
  {"t":"sel","text":"...","x":..,"y":..,"hwnd":..,"cls":"...","pid":..}
  {"t":"none","x":..,"y":..,"hwnd":..}           拖拽了但没取到文本

退出：父进程消失后自动退出（看门狗线程）。

🔴 关于自家窗口（--owner-pid）：
  便签/便签中心里本来就有页面内划词工具条，全局划词对它们是多余的。
  更重要的是：一旦对自家窗口也走「模拟 Ctrl+C + 读剪贴板」，
  探针会在这两件事之间**独占剪贴板**（OpenClipboard 是全局独占的），
  用户此时自己按 Ctrl+C 就会因为剪贴板被占用而复制失败（表现为「Ctrl+C 时不时失效」）。
  所以必须在**注入按键之前**就跳过自家进程，owner_pid 就是 Electron 主进程的 pid。
"""
import ctypes
import ctypes.wintypes as w
import json
import os
import sys
import threading
import time

user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

# ---------------------------------------------------------------- 常量
WH_MOUSE_LL = 14
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
VK_CONTROL = 0x11
VK_C = 0x43
SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

# 这些窗口里模拟 Ctrl+C 会造成副作用（中断进程 / 粘贴控制字符 / 复制的是屏幕文本）
SKIP_CLASSES = {
    'ConsoleWindowClass',
    'CASCADIA_HOSTING_WINDOW_CLASS',
    'mintty',
    'PuTTY',
    'VirtualConsoleClass',
    'ApplicationFrameWindow',   # 部分 UWP 容器：Ctrl+C 会冒泡到别的控件
}

DRAG_THRESHOLD = 6          # 按下到抬起的位移超过这个值才算「拖拽选中」
COPY_DELAY = 0.12           # 抬起后等应用真正完成选区
CLIPBOARD_TIMEOUT = 0.5     # 等剪贴板内容更新
MIN_TEXT = 2

_out_lock = threading.Lock()

# Electron 主进程 pid：自家窗口（便签/便签中心）要跳过，不能模拟 Ctrl+C
owner_pid = 0


def emit(obj):
    line = json.dumps(obj, ensure_ascii=True)
    with _out_lock:
        try:
            sys.stdout.write(line + '\n')
            sys.stdout.flush()
        except Exception:
            os._exit(0)


# ---------------------------------------------------------------- 结构体
class POINT(ctypes.Structure):
    _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ('pt', POINT),
        ('mouseData', w.DWORD),
        ('flags', w.DWORD),
        ('time', w.DWORD),
        ('dwExtraInfo', ctypes.c_size_t),
    ]


class RECT(ctypes.Structure):
    _fields_ = [('left', ctypes.c_long), ('top', ctypes.c_long),
                ('right', ctypes.c_long), ('bottom', ctypes.c_long)]


# ---------------------------------------------------------------- Win32 签名
user32.SetWindowsHookExW.restype = ctypes.c_void_p
user32.SetWindowsHookExW.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, w.DWORD]
user32.CallNextHookEx.restype = ctypes.c_ssize_t
user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, w.WPARAM, w.LPARAM]
user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]
user32.GetForegroundWindow.restype = w.HWND
user32.GetClassNameW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
user32.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(RECT)]
user32.GetClipboardSequenceNumber.restype = w.DWORD
user32.OpenClipboard.argtypes = [w.HWND]
user32.SendInput.argtypes = [w.UINT, ctypes.c_void_p, ctypes.c_int]
user32.GetClipboardData.restype = ctypes.c_void_p
user32.SetClipboardData.restype = ctypes.c_void_p
user32.SetClipboardData.argtypes = [w.UINT, ctypes.c_void_p]

kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
kernel32.GlobalAlloc.restype = ctypes.c_void_p
kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
kernel32.OpenProcess.restype = ctypes.c_void_p
kernel32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, w.DWORD]

HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, w.WPARAM, w.LPARAM)


# ---------------------------------------------------------------- 剪贴板
# 🔴 OpenClipboard 是**全局独占**的：探针打开剪贴板期间，
#    别的进程（用户自己的 Ctrl+C、其它软件）会拿不到剪贴板 → 复制失败。
#    所以这里的原则是：
#      1) 每次 OpenClipboard 只做一件事，尽快 CloseClipboard；
#      2) 打不开就快速重试几次，抢不到就直接放弃这次取词，不长时间纠缠；
#      3) 尽量减少打开剪贴板的总次数。

CLIPBOARD_RETRY = 3


def clipboard_get_text():
    for _ in range(CLIPBOARD_RETRY):
        if user32.OpenClipboard(None):
            try:
                h = user32.GetClipboardData(CF_UNICODETEXT)
                if not h:
                    return None
                p = kernel32.GlobalLock(h)
                if not p:
                    return None
                try:
                    return ctypes.wstring_at(p)
                finally:
                    kernel32.GlobalUnlock(h)
            finally:
                user32.CloseClipboard()
        time.sleep(0.01)
    return None


def clipboard_set_text(text):
    data = text.encode('utf-16-le') + b'\x00\x00'
    for _ in range(CLIPBOARD_RETRY):
        if user32.OpenClipboard(None):
            try:
                user32.EmptyClipboard()
                h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
                if not h:
                    return False
                p = kernel32.GlobalLock(h)
                ctypes.memmove(p, data, len(data))
                kernel32.GlobalUnlock(h)
                user32.SetClipboardData(CF_UNICODETEXT, h)   # 所有权交给系统，不要再 free
                return True
            finally:
                user32.CloseClipboard()
        time.sleep(0.01)
    return False


def clipboard_has_text():
    return bool(user32.IsClipboardFormatAvailable(CF_UNICODETEXT))


# ---------------------------------------------------------------- 输入模拟
class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', w.WORD), ('wScan', w.WORD), ('dwFlags', w.DWORD),
                ('time', w.DWORD), ('dwExtraInfo', ctypes.c_size_t)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [('ki', KEYBDINPUT), ('pad', ctypes.c_byte * 32)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', w.DWORD), ('u', _INPUTUNION)]


def _key(vk, up=False):
    inp = INPUT()
    inp.type = 1                      # INPUT_KEYBOARD
    inp.u.ki = KEYBDINPUT(vk, 0, 0x0002 if up else 0, 0, 0)
    user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


def send_copy():
    # 必须用 SendInput：keybd_event 在这类环境里注入的按键到不了目标窗口
    _key(VK_CONTROL)
    _key(VK_C)
    time.sleep(0.012)
    _key(VK_C, True)
    _key(VK_CONTROL, True)


# ---------------------------------------------------------------- 取词
def foreground_info():
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None, '', 0
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    pid = w.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(hwnd), buf.value, int(pid.value)


def inside_window(hwnd, x, y):
    r = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return True
    return r.left <= x <= r.right and r.top <= y <= r.bottom


def grab_selection(x, y, x0, y0):
    hwnd, cls, pid = foreground_info()
    if not hwnd:
        return
    # 🔴 自家窗口必须在注入按键之前就跳过：一旦注入，探针会独占剪贴板，
    #    用户随后自己按 Ctrl+C 就会失败（Clipboard 被 OpenClipboard 独占）。
    if owner_pid and pid == owner_pid:
        emit({'t': 'skip-own', 'x': x, 'y': y, 'hwnd': hwnd, 'pid': pid})
        return
    if cls in SKIP_CLASSES:
        emit({'t': 'none', 'x': x, 'y': y, 'hwnd': hwnd, 'why': 'skip-class'})
        return
    if not inside_window(hwnd, x, y):
        emit({'t': 'none', 'x': x, 'y': y, 'hwnd': hwnd, 'why': 'outside'})
        return

    time.sleep(COPY_DELAY)

    before_text = clipboard_get_text() if clipboard_has_text() else None
    seq0 = user32.GetClipboardSequenceNumber()
    send_copy()

    seq = seq0
    deadline = time.time() + CLIPBOARD_TIMEOUT
    while time.time() < deadline:
        seq = user32.GetClipboardSequenceNumber()
        if seq != seq0:
            break
        time.sleep(0.02)

    if seq == seq0:                       # 没选中，或者应用不支持 Ctrl+C
        emit({'t': 'none', 'x': x, 'y': y, 'hwnd': hwnd, 'why': 'no-copy'})
        return

    text = clipboard_get_text() or ''
    # 还原用户原来的剪贴板（只还原文本；原本是图片时会丢失，这是模拟复制法的固有代价）
    if before_text is not None and text != before_text:
        clipboard_set_text(before_text)

    text = text.replace('\u00a0', ' ').strip()
    if len(text) < MIN_TEXT:
        emit({'t': 'none', 'x': x, 'y': y, 'hwnd': hwnd, 'why': 'empty'})
        return

    emit({
        't': 'sel',
        'text': text[:6000],
        'x': x, 'y': y,
        'x0': x0, 'y0': y0,          # 按下点：和抬起点一起框出选区的大致范围
        'hwnd': hwnd, 'cls': cls, 'pid': pid,
    })


# ---------------------------------------------------------------- 钩子
_state = {'down_x': 0, 'down_y': 0, 'pressed': False}
_hook_handle = None
_hook_cb = None      # 必须持有引用：被 GC 后钩子回调地址失效，下一次鼠标事件直接崩进程


def _hook_proc(nCode, wParam, lParam):
    try:
        if nCode == 0:
            info = ctypes.cast(lParam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
            if wParam == WM_LBUTTONDOWN:
                _state['pressed'] = True
                _state['down_x'] = info.pt.x
                _state['down_y'] = info.pt.y
                emit({'t': 'down', 'x': info.pt.x, 'y': info.pt.y})
            elif wParam == WM_LBUTTONUP:
                x, y = info.pt.x, info.pt.y
                dx = abs(x - _state['down_x'])
                dy = abs(y - _state['down_y'])
                pressed = _state['pressed']
                _state['pressed'] = False
                # 只有「拖拽」才当成划词：单击不触发，避免每次点击都动剪贴板
                if pressed and (dx > DRAG_THRESHOLD or dy > DRAG_THRESHOLD):
                    threading.Thread(target=grab_selection,
                                     args=(x, y, _state['down_x'], _state['down_y']),
                                     daemon=True).start()
    except Exception as e:
        emit({'t': 'error', 'msg': str(e)})
    return user32.CallNextHookEx(None, nCode, wParam, lParam)


def install_hook():
    global _hook_handle, _hook_cb
    _hook_cb = HOOKPROC(_hook_proc)
    _hook_handle = user32.SetWindowsHookExW(WH_MOUSE_LL, _hook_cb, None, 0)
    if not _hook_handle:
        emit({'t': 'fatal', 'msg': 'SetWindowsHookEx failed: %d' % ctypes.get_last_error()})
        os._exit(1)
    return _hook_cb


def pump_messages():
    msg = w.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


def watch_parent(pid):
    if not pid:
        return
    h = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if not h:
        return
    kernel32.WaitForSingleObject(h, 0xFFFFFFFF)
    os._exit(0)


def main():
    # 高 DPI：不做这一步，钩子拿到的坐标会被系统按 125% 虚拟化，悬浮层就会偏
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))   # PER_MONITOR_AWARE_V2
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass

    parent = 0
    if '--parent-pid' in sys.argv:
        try:
            parent = int(sys.argv[sys.argv.index('--parent-pid') + 1])
        except Exception:
            parent = 0

    global owner_pid
    if '--owner-pid' in sys.argv:
        try:
            owner_pid = int(sys.argv[sys.argv.index('--owner-pid') + 1])
        except Exception:
            owner_pid = 0

    threading.Thread(target=watch_parent, args=(parent,), daemon=True).start()

    install_hook()
    emit({'t': 'ready', 'pid': os.getpid()})
    pump_messages()


if __name__ == '__main__':
    main()
