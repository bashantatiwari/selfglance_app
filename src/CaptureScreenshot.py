import mss
import os
from datetime import datetime

class CaptureScreenshot:
    
    def __init__(self):
        self.folder = "screenshots"
        os.makedirs(self.folder, exist_ok=True)
        self.sct = mss.mss()

    def capture(self) -> str:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = f"{timestamp}.png"
        filepath = os.path.join(self.folder, filename)
        img = self.sct.grab(self.sct.monitors[1])  
        mss.tools.to_png(img.rgb, img.size, output=filepath)
        return filename                                          
    