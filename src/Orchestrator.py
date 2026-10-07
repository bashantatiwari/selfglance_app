import time
import requests
import json
from datetime import datetime
from pathlib import Path

# Local modules
from CaptureScreenshot import CaptureScreenshot
from CaptureTab import ActiveWindow
from testWordExtractor import SmartOCR
from SentenceGenerator import SentenceFormation

# API Configuration
API_BASE_URL = "http://127.0.0.1:8000/api/v1"
SESSION_API = f"{API_BASE_URL}/sessions/active/"
LOG_API = f"{API_BASE_URL}/logs/"

class ProductivityOrchestrator:
    def __init__(self):
        print("Initializing SelfGlance Orchestrator...")
        self.screenshot_tool = CaptureScreenshot()
        self.window_tool = ActiveWindow()
        self.ocr_tool = SmartOCR(gpu=False)  # Set gpu=True if you have CUDA
        self.llm_tool = SentenceFormation()
        self.last_goal = None

    def get_active_session(self):
        try:
            response = requests.get(SESSION_API)
            if response.status_code == 200 and response.json():
                return response.json()
        except Exception as e:
            print(f"API Error: {e}")
        return None

    def log_activity(self, session_id, screenshot_path, text, summary, is_productive):
        data = {
            "session": session_id,
            "screenshot_path": screenshot_path,
            "ocr_text": text[:5000], # Trucate to avoid huge payloads
            "llm_summary": summary,
            "is_productive": is_productive
        }
        try:
            requests.post(LOG_API, json=data)
            print(f"Logged: {'✅ Productive' if is_productive else '❌ Distracted'} - {summary}")
        except Exception as e:
            print(f"Failed to push log: {e}")

    def run_cycle(self):
        # 1. Check if user has started a session
        session = self.get_active_session()
        if not session:
            print("No active session. Sleeping...")
            return

        goal = session['goal']
        print(f"\n--- Monitoring Session: '{goal}' ---")

        # 2. Capture Context
        window_info = self.window_tool.CaptureTab()
        window_title = window_info.get('window_title', '').lower()
        process_name = window_info.get('process_name', '').lower()

        # 3. Fast Pass: Obvious Distractions
        distraction_keywords = ['youtube', 'netflix', 'facebook', 'instagram', 'tiktok']
        if any(keyword in window_title for keyword in distraction_keywords):
            print(f"Fast detection: {window_title} is a distraction.")
            self.log_activity(session['id'], "SKIPPED_OBVIOUS", f"Window: {window_title}", f"User is on {window_title}", False)
            return

        # 4. Deep Analysis: Screenshot + OCR + LLM
        screenshot_filename = self.screenshot_tool.capture()
        full_path = str(Path("screenshots") / screenshot_filename)
        
        # OCR
        text = self.ocr_tool.get_clean_text_for_llm(full_path)
        
        # LLM Summary
        summary = self.llm_tool.summarize(text)
        
        # LLM Productivity Check
        check = self.llm_tool.check_productivity(goal, text)
        is_productive = check['is_productive']
        reason = check['reason']

        # 5. Log it
        final_summary = f"{summary} ({reason})"
        self.log_activity(session['id'], screenshot_filename, text, final_summary, is_productive)

    def loop(self):
        print("Orchestrator Started. Waiting for sessions...")
        while True:
            self.run_cycle()
            time.sleep(30) # Check every 30 seconds

if __name__ == "__main__":
    bot = ProductivityOrchestrator()
    bot.loop()
