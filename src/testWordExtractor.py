# smart_ocr.py — THE FINAL VERSION (2025)
import easyocr
from PIL import Image
import re
from typing import List, Optional, Tuple


class SmartOCR:
    """
    The ultimate screen OCR engine.
    Works perfectly on single apps AND dual-app workflows.
    No hardcoding. No active window. Pure visual intelligence.
    """

    def __init__(self, langs=['en'], gpu: bool = False):
        print(f"Loading EasyOCR ({'GPU' if gpu else 'CPU'})...")
        self.reader = easyocr.Reader(langs, gpu=gpu)

    def _is_junk(self, text: str) -> bool:
        w = text.strip()
        if not w or len(w) <= 1:
            return True
        cleaned = re.sub(r'[^\w\s\.\-\'\#\@\+]', '', w)
        if len(cleaned) <= 2:
            return True
        if cleaned.replace('.', '').replace(':', '').replace('-', '').isdigit():
            return True
        if re.search(r'\.(py|js|ts|tsx?|html?|css|json|ya?ml|md|csv|log|env|git|png|jpe?g|pdf)$', cleaned, re.I):
            return True
        if any(sep in cleaned for sep in ['/', '\\', '->', '→', '←']):
            return True
        if cleaned.startswith(('>', '$', '#', 'PS ', '(env)', '(venv)', 'bash', 'zsh', 'cmd')):
            return True
        if re.match(r'^(Ln|Col|Spaces|UTF|CRLF|Go Live|Prettier|GitLens|Problems|Output|Debug|Terminal|Ports)', cleaned, re.I):
            return True
        symbols = sum(1 for c in cleaned if not c.isalnum() and c not in "._'-#@+")
        if symbols > len(cleaned) * 0.6 or len(cleaned) > 80:
            return True
        return False

    def extract_relevant_words(self, img_path: str, min_words: int = 5) -> Tuple[List[str], Optional[List[str]]]:
        results = self.reader.readtext(img_path, detail=1, paragraph=False)
        if not results:
            return [], None

        img = Image.open(img_path)
        w, h = img.size

        # Extract clean words with center points
        cleaned = []
        for (bbox, text, conf) in results:
            if conf < 0.4 or self._is_junk(text):
                continue
            cx = sum(x for x, _ in bbox) / 4
            cy = sum(y for _, y in bbox) / 4
            cleaned.append((text.strip(), cx, cy))

        if len(cleaned) < min_words:
            return [], None

        # === SMART SPATIAL CLUSTERING — THE FINAL SOLUTION ===
        xs = [cx for _, cx, _ in cleaned]
        ys = [cy for _, _, cy in cleaned]

        x_sorted = sorted(set(xs))
        y_sorted = sorted(set(ys))

        # Find biggest horizontal and vertical gaps
        h_gaps = [y_sorted[i+1] - y_sorted[i] for i in range(len(y_sorted)-1)]
        v_gaps = [x_sorted[i+1] - x_sorted[i] for i in range(len(x_sorted)-1)]

        max_h_gap = max(h_gaps, default=0)
        max_v_gap = max(v_gaps, default=0)

        # Decide: is this a horizontal or vertical split?
        if max_v_gap > w * 0.12 and max_v_gap > max_h_gap * 1.5:
            # Vertical split (two apps side-by-side)
            split_x = x_sorted[v_gaps.index(max_v_gap)] + max_v_gap / 2
            left = [w for w, cx, _ in cleaned if cx < split_x]
            right = [w for w, cx, _ in cleaned if cx >= split_x]
            if len(left) >= 4 and len(right) >= 4:
                print(f"Detected DUAL WORKFLOW (side-by-side) → split at x={split_x:.0f}px")
                return left, right

        elif max_h_gap > h * 0.12 and max_h_gap > max_v_gap * 1.5:
            # Horizontal split (code + terminal)
            split_y = y_sorted[h_gaps.index(max_h_gap)] + max_h_gap / 2
            top = [w for w, _, cy in cleaned if cy < split_y]
            bottom = [w for w, _, cy in cleaned if cy >= split_y]
            if len(top) >= 4 and len(bottom) >= 4:
                print(f"Detected HORIZONTAL split (code + terminal) → split at y={split_y:.0f}px")
                return top, bottom

        # Single context
        print("Detected: Single context")
        words = [w for w, _, _ in cleaned]
        return words, None

    def get_clean_text_for_llm(self, img_path: str) -> str:
        words1, words2 = self.extract_relevant_words(img_path, min_words=4)
        if not words1:
            return "No meaningful text found on screen"

        if words2 is None:
            text = " ".join(words1)
        else:
            text = "Context 1: " + " ".join(words1) + " | Context 2: " + " ".join(words2)

        text = re.sub(r'\s+', ' ', text)
        text = re.sub(r'(\w)\s+([\,\.\)\]\}\:])', r'\1\2', text)

        if any(kw in text.lower() for kw in ["import ", "def ", "class ", "from ", "self.", "pip ", "torch", "transformers"]):
            return "Code: " + text.strip()
        return text.strip()


# ———————————— TEST IT ————————————
if __name__ == "__main__":
    ocr = SmartOCR(gpu=True)
    result = ocr.get_clean_text_for_llm("screenshots/2025-11-11_19-52-15.png")
    print("\nLLM-READY TEXT:")
    print(result)