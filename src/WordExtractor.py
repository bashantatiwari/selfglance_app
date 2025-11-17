import easyocr

class WordExtractor:
  def __init__(self, lang_list=['en']):
    self.ocr = easyocr.Reader(lang_list,gpu=False)

  def extract(self, img_path):
    results = self.ocr.readtext(img_path,detail=0)
    words = [text for text in results]
    return words

