import easyocr
from PIL import Image
class WordExtractor:
  def __init__(self):
    self.reader = easyocr.Reader(lang_list=['en'])

  def _is_junk(self,word):
    return False
  
  def extractor(self,img_path):
    results = self.reader.readtext(img_path,detail=1)
    #It provides lots of information basically where the word lies in the image like the cordinate of the plane when use detail=1
    #specific_word_result = self.reader.readtext(img_path,detail=0)
    #When use detail=0 it will provide the extracted words
    # print(specific_word_result)
    
    img = Image.open(img_path)
    width,height = img.size
    print(width,height)
    # print(results)


words = WordExtractor()
print(words.extractor("screenshots/2025-11-11_19-52-20.png"))