import os
import sys

from paddleocr import PaddleOCR

PDF = r"C:\Users\akshi\OneDrive\Desktop\New folder (3)\FX_Options_SSIReport_260526.pdf"
OUT = r"C:\Users\akshi\OneDrive\Desktop\New folder (3)\ocr_output"
os.makedirs(OUT, exist_ok=True)

# Plain text OCR: disable the heavier doc-orientation / unwarp stages for speed.
ocr = PaddleOCR(
    lang="en",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
)

results = ocr.predict(input=PDF)

all_text = []
for i, res in enumerate(results):
    page_no = i + 1
    print(f"\n===== PAGE {page_no} =====", flush=True)
    try:
        texts = res["rec_texts"]
        scores = res.get("rec_scores", [None] * len(texts))
    except Exception:
        # fallback: dump whatever the result exposes
        texts = getattr(res, "rec_texts", []) or []
        scores = getattr(res, "rec_scores", [None] * len(texts))

    page_lines = []
    for t, s in zip(texts, scores):
        line = t if s is None else f"{t}"
        print(line, flush=True)
        page_lines.append(t)

    all_text.append(f"===== PAGE {page_no} =====\n" + "\n".join(page_lines))

    # Save structured JSON + annotated image per page
    try:
        res.save_to_json(OUT)
        res.save_to_img(OUT)
    except Exception as e:
        print(f"(could not save artifacts for page {page_no}: {e})", flush=True)

# Write a single consolidated text file
txt_path = os.path.join(OUT, "extracted_text.txt")
with open(txt_path, "w", encoding="utf-8") as f:
    f.write("\n\n".join(all_text))

print(f"\n[done] pages={len(results)}  text saved to: {txt_path}", flush=True)
