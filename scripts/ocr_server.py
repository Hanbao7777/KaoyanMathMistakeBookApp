"""PaddleOCR JSON-lines server for Electron app communication via stdin/stdout.

Protocol (each line is a JSON object):
  Input:  {"id": 1, "image_path": "D:/path/to/image.png"}
  Output: {"id": 1, "text": "...", "confidence": 95.2, "error": null}
  Signal: {"action": "shutdown"}

Install dependencies before use:
  pip install paddlepaddle paddleocr
"""

import json
import sys
import traceback


def main():
    try:
        from paddleocr import PaddleOCR
    except ImportError:
        print(json.dumps({"type": "init_error", "message": "PaddleOCR not installed. Run: pip install paddlepaddle paddleocr"}))
        sys.stdout.flush()
        sys.exit(1)

    try:
        import os as _os
        _os.environ['GLOG_minloglevel'] = '3'
        ocr = PaddleOCR(lang='ch', use_angle_cls=True, show_log=False)
    except Exception as e:
        print(json.dumps({"type": "init_error", "message": f"PaddleOCR init failed: {e}"}))
        sys.stdout.flush()
        sys.exit(1)

    print(json.dumps({"type": "ready"}))
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        if msg.get("action") == "shutdown":
            break

        request_id = msg.get("id", 0)
        image_path = msg.get("image_path", "")

        try:
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
                avg_conf = (total_conf / count) if count > 0 else 0
                print(json.dumps({"id": request_id, "text": combined_text, "confidence": round(avg_conf, 1), "error": None}))
            else:
                print(json.dumps({"id": request_id, "text": "", "confidence": 0, "error": None}))
        except Exception as e:
            print(json.dumps({"id": request_id, "text": "", "confidence": 0, "error": str(e)}))

        sys.stdout.flush()

    sys.exit(0)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({"type": "fatal", "message": traceback.format_exc()}))
        sys.stdout.flush()
        sys.exit(1)
