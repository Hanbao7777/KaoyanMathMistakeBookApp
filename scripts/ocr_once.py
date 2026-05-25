"""One-shot OCR: takes image path as argument, prints JSON result to stdout."""
import json, sys, os
os.environ['GLOG_minloglevel'] = '3'

image_path = sys.argv[1]

from paddleocr import PaddleOCR
ocr = PaddleOCR(lang='ch', use_angle_cls=True, show_log=False)
result = ocr.ocr(image_path)

if result and result[0]:
    texts = []
    total_conf = 0.0
    count = 0
    for line_info in result[0]:
        text = line_info[1][0]
        conf = line_info[1][1]
        texts.append(text)
        total_conf += conf
        count += 1
    combined_text = '\n'.join(texts)
    avg_conf = round(total_conf / count * 100, 1) if count > 0 else 0
    print(json.dumps({"ok": True, "text": combined_text, "confidence": avg_conf}))
else:
    print(json.dumps({"ok": False, "text": "", "confidence": 0}))
