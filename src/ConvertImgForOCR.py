from PIL import Image
import imagehash
import os
from typing import Tuple

class ConvertForOcr:
    def __init__(self):
        self.base_dir = os.path.dirname(os.path.abspath(__file__))
        self.screenshots_dir = os.path.join(self.base_dir, "screenshots")
        os.makedirs(self.screenshots_dir, exist_ok=True)

    def _load_and_hash(self, img_path: str) -> imagehash.ImageHash:
        if not os.path.isabs(img_path):
            img_path = os.path.join(self.screenshots_dir, img_path)
        
        if not os.path.exists(img_path):
            raise FileNotFoundError(f"Image not found: {img_path}")

        try:
            with Image.open(img_path) as img:
                img = img.convert('RGB')
                return imagehash.phash(img)
        except Exception as e:
            raise RuntimeError(f"Failed to process image {img_path}: {e}")

    def compare(self, img_path1: str, img_path2: str) -> Tuple[int, imagehash.ImageHash, imagehash.ImageHash]:
        hash1 = self._load_and_hash(img_path1)
        hash2 = self._load_and_hash(img_path2)
        diff = hash1 - hash2        
        return diff

