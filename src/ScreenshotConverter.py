import os
import time
import imagehash
from PIL import Image
import json

screenshot_dir = "screenshots"
hash_file = "hashes.json"
similarity_threshold = 5

# Load existing hashes
def load_hashes():
    if os.path.exists(hash_file):
        with open(hash_file, "r") as f:
            return json.load(f)
    return {}

# Save updated hashes
def save_hashes(data):
    with open(hash_file, "w") as f:
        json.dump(data, f, indent=4)

def read_image():
    files = os.listdir(screenshot_dir)
    if not files:
        print("No Screenshot found")
        return None

    stored_hashes = load_hashes()

    for file in files:
        img_path = os.path.join(screenshot_dir, file)
        img = Image.open(img_path)
        new_hash = imagehash.dhash(img)

        # Compare with old hashes
        for old_path, old_hash in stored_hashes.items():
            diff = new_hash - imagehash.hex_to_hash(old_hash)

            if diff <= similarity_threshold:
                print("Duplicate found, deleting:", img_path)
                os.remove(img_path)

                del stored_hashes[old_path]
                save_hashes(stored_hashes)

                return old_path  # return original for OCR

        # If unique, save hash
        stored_hashes[img_path] = str(new_hash)
        save_hashes(stored_hashes)
        print("New image stored:", img_path)
        return img_path

while True:
    read_image()
    time.sleep(5)
