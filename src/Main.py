from WordExtractor import WordExtractor
from SentenceGenerator import SentenceFormation
from pathlib import Path

'''
1. Things to need to be work on like if the active tab has like youtube as a windo title then you no need to capture screenshot okay cause we can easily get information that what user is been working on lately.



'''


if __name__ == "__main__":
    base_dir = Path(__file__).parent
    screenshot_dir = base_dir / "screenshots"

    extractor = WordExtractor()
    generator = SentenceFormation()  # Loads model ONCE

    for img_path in screenshot_dir.glob("*.png"):
        print(f"\nProcessing: {img_path}")

        try:
            final_words = extractor.extract(str(img_path))
            print("Extracted OCR words:", final_words)

            # Generate sentence
            sentence = generator.sentenceGeneration(final_words)
            print("Generated Sentence:", sentence)

        except Exception as e:
            print(f"Error processing {img_path}: {e}")



