import win32gui
import win32process
import psutil
from typing import Dict
import time
class ActiveWindow:
    
    def __init__(self):
        print("Capturing Active Window......")

    def CaptureTab(self) -> Dict[str, str]:

        try:
            hwnd = win32gui.GetForegroundWindow()
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            process = psutil.Process(pid)
            process_name = process.name().lower()        
            window_title = win32gui.GetWindowText(hwnd)
            
            return {
                "process_name": process_name,
                "window_title": window_title.strip()
            }
            
        except (psutil.NoSuchProcess, psutil.AccessDenied, Exception) as e:
            return {
                "process_name": "unknown",
                "window_title": "unknown or protected window"
            }
        

tab = ActiveWindow()

while(True):
    val = tab.CaptureTab()
    print(val)
    time.sleep(5)

'''

Things need to be consider: For the further update of the project-work.

I need to work on like if the window title recieves youtube  then there is no need to do capture cause that is not worthit but you need to start a timer and keep yourself updated if the user is still in the youtube or not
'''
