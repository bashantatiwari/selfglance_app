import mss
import os
import time
from datetime import datetime
sct = mss.mss()
folder = "screenshots"
os.makedirs(folder, exist_ok=True)
while True:
  time_stamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
  path = f"{folder}/{time_stamp}.png"
  scrn_shot = sct.grab(sct.monitors[1])
  mss.tools.to_png(scrn_shot.rgb, scrn_shot.size, output=path)
  print("Saved:",path)
  time.sleep(5)
  