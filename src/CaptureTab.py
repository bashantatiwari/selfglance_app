import win32gui
import win32process
import psutil
import time


def capture_active_window():
    hwnd = win32gui.GetForegroundWindow()
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    process = psutil.Process(pid)

    return {
        "process_name": process.name().lower(),  # lowercase for safe comparison
        "window_title": win32gui.GetWindowText(hwnd)
    }


while True:
    try:
        active = capture_active_window()
        print(active)
        
    except Exception as e:
        print("Error fetching window info:", e)

    time.sleep(2) 
