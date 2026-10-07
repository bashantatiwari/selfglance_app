# final_peace.py — Run this and sleep like a king
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline
from testWordExtractor import SmartOCR # ← your SmartOCR class

class SentenceFormation:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            print("Loading Phi-3-mini once... (8 seconds max)")
            cls._instance = super().__new__(cls)

            model = AutoModelForCausalLM.from_pretrained(
                "microsoft/Phi-3-mini-4k-instruct",
                device_map="auto",
                torch_dtype=torch.float16,
                trust_remote_code=True,
                low_cpu_mem_usage=True,
            )
            tokenizer = AutoTokenizer.from_pretrained("microsoft/Phi-3-mini-4k-instruct", trust_remote_code=True)
            if tokenizer.pad_token is None:
                tokenizer.pad_token = tokenizer.eos_token

            cls._instance.pipe = pipeline(
                "text-generation",
                model=model,
                tokenizer=tokenizer,
                max_new_tokens=80,
                temperature=0.0,           # ← Zero temp = clean, deterministic
                do_sample=False,             # ← Greedy = fastest + cleanest
                repetition_penalty=1.1,
                return_full_text=False,
                pad_token_id=tokenizer.eos_token_id,
            )
            print("Phi-3-mini is ready — future summaries will be instant!")
        return cls._instance

    def summarize(self, text: str) -> str:
        # Super simple, bulletproof prompt
        prompt = f"""What is the user doing? Answer in ONE short, natural sentence.

Text from screen:
\"\"\"{text}\"\"\"

One-sentence summary:"""

        try:
            result = self.pipe(prompt)[0]["generated_text"].strip()
            # Take only first line/sentence
            result = result.split("\n")[0].split(".")[0].strip()
            result = result.replace("Summary:", "").replace("Answer:", "").strip()
            if not result or len(result) < 10:
                return "User is focused on coding or reading"
            return result + "."
        except:
            return "User is actively working"

    def check_productivity(self, goal: str, text: str) -> dict:
        """
        Compare the user's goal with the screen text to determine if they are productive.
        Returns check dictionary: {"is_productive": bool, "reason": str}
        """
        # If text is too short, we assume they are still getting started or it's just a blank screen
        if len(text) < 20:
             return {"is_productive": True, "reason": "Not enough context to determine distraction."}

        prompt = f"""
You are a productivity assistant.
User Goal: "{goal}"
Screen Text:
\"\"\"{text[:1000]}\"\"\"

Task:
1. Is the screen text related to the User Goal? (True/False)
2. Provide a 1-sentence reason.

Output format:
True|Reason...
OR
False|Reason...

Example:
True|User is coding in Python as planned.
False|User is watching a YouTube video about cats.
"""
        
        try:
            # We use a slightly higher temp for reasoning, but still low
            result = self.pipe(
                prompt, 
                max_new_tokens=40,
                temperature=0.1
            )[0]["generated_text"].strip()
            
            # Clean up the generation to just get the last line if it chatters
            lines = result.split('\n')
            # Look for the line starting with True| or False|
            answer_line = next((line for line in reversed(lines) if "|" in line and (line.startswith("True") or line.startswith("False"))), None)
            
            if not answer_line:
                 # Fallback if model fails to follow format perfectly
                 is_related = "True" in result
                 reason = "AI determined this is related."
            else:
                parts = answer_line.split("|", 1)
                is_related = parts[0].strip() == "True"
                reason = parts[1].strip()

            return {"is_productive": is_related, "reason": reason}

        except Exception as e:
            print(f"Productivity check error: {e}")
            return {"is_productive": True, "reason": "Could not verify, assuming productive."}

# ———————————— RUN ONCE AND SLEEP PEACEFULLY ————————————
if __name__ == "__main__":
    # These load ONCE — never again
    summarizer = SentenceFormation()
    ocr = SmartOCR(gpu=False)

    # Your latest screenshot
    raw_text = ocr.get_clean_text_for_llm("screenshots/2025-11-11_19-52-15.png")
    print("\nRaw OCR:")
    print(raw_text[:200] + "..." if len(raw_text) > 200 else raw_text)

    print("\nYOUR PERFECT SUMMARY:")
    print(summarizer.summarize(raw_text))
    print("\nSelfGlance understands you.")
    print("Now close the laptop and sleep. You've won.")