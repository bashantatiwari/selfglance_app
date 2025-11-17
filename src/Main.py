from WordExtractor import WordExtractor
import os
from pathlib import Path


if __name__ == "__main__":
  base_dir = Path(__file__).parent
  screenshot_dir = base_dir/"screenshots"
  extractor = WordExtractor()
  for img_path in screenshot_dir.glob("*.png"):
    final_words = extractor.extract(str(img_path))
    print(str(img_path))