import argparse
import os
import re
import shutil
import time
from dataclasses import dataclass
from typing import Dict

import cv2
import numpy as np
import pytesseract
import requests


# ================= SETTINGS =================

ESP32_URL = "http://192.168.1.50/raspberry-label"
SCAN_LOG_FILE = "raspberry_scans.jsonl"

TESSERACT_CMD = ""   # On Raspberry Pi keep this empty if tesseract is in PATH.
DEFAULT_CAMERA_INDEX = 0

OCR_EVERY_N_FRAMES = 8
MIN_SHARPNESS = 50.0
UPSCALE_FACTOR = 1.5

LOGO_FOLDER = "logos"
STABLE_N = 3


@dataclass
class OCRResult:
    text: str
    confidence: float
    fields: Dict[str, str]
    debug_name: str


# ================= ESP32 HTTP =================

def append_scan_log(label, status, esp_response=None):
    import json

    entry = {
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "status": status,
        "espResponse": esp_response,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }

    with open(SCAN_LOG_FILE, "a", encoding="utf-8") as file:
        file.write(json.dumps(entry) + "\n")


def send_label_to_esp(label, esp_url):
    payload = {
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "source": "raspberry"
    }

    print("Sending to ESP32:", payload)
    response = requests.post(esp_url, json=payload, timeout=120)
    response.raise_for_status()

    data = response.json() if response.text else {"status": "done"}
    print("ESP32 response:", data)
    return data


# ================= STABILITY =================

field_last = {
    "brand": None,
    "model": None,
    "color": None,
    "size": None
}

field_count = {
    "brand": 0,
    "model": 0,
    "color": 0,
    "size": 0
}

stable_fields = {
    "brand": None,
    "model": None,
    "color": None,
    "size": None
}

sent_once = False


def reset_stability():
    global field_last, field_count, stable_fields, sent_once

    field_last = {
        "brand": None,
        "model": None,
        "color": None,
        "size": None
    }

    field_count = {
        "brand": 0,
        "model": 0,
        "color": 0,
        "size": 0
    }

    stable_fields = {
        "brand": None,
        "model": None,
        "color": None,
        "size": None
    }

    sent_once = False


def fix_common_ocr_errors(value):
    value = value.upper().strip()
    value = value.replace("|", "/")
    value = value.replace("\\", "/")
    value = re.sub(r"\s+", " ", value)

    value = value.replace("WHLTE", "WHITE")
    value = value.replace("WHlTE", "WHITE")
    value = value.replace("WHTE", "WHITE")
    value = value.replace("WH1TE", "WHITE")
    value = value.replace("BLK", "BLACK")
    value = value.replace("BLAK", "BLACK")

    return value.strip()


def update_field_stability(fields):
    global field_last, field_count, stable_fields

    for key in ("brand", "model", "color", "size"):
        value = fields.get(key)

        if not value or value == "--":
            continue

        value = fix_common_ocr_errors(value)

        if value == field_last[key]:
            field_count[key] += 1
        else:
            field_last[key] = value
            field_count[key] = 1

        if field_count[key] >= STABLE_N:
            stable_fields[key] = value

    ready = all(stable_fields[k] is not None for k in ("brand", "model", "color", "size"))

    if ready:
        return {
            "brand": stable_fields["brand"],
            "model": stable_fields["model"],
            "color": stable_fields["color"],
            "size": stable_fields["size"]
        }

    return None


# ================= OCR =================

def configure_tesseract():
    if TESSERACT_CMD and os.path.exists(TESSERACT_CMD):
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
        return

    path_cmd = shutil.which("tesseract")

    if path_cmd:
        pytesseract.pytesseract.tesseract_cmd = path_cmd


def load_logo_templates():
    templates = {}

    logo_files = {
        "NIKE": "nike.png",
        "ADIDAS": "adidas.png",
        "PUMA": "puma.png",
        "SKECHERS": "skechers.png",
    }

    for brand, filename in logo_files.items():
        path = os.path.join(LOGO_FOLDER, filename)
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)

        if img is not None:
            _, img = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            templates[brand] = img
            print(f"Loaded logo: {brand}")
        else:
            print(f"Logo not found: {path}")

    return templates


def detect_brand_by_logo(roi, templates):
    if not templates:
        return "--", 0.0

    h, w = roi.shape[:2]
    header = roi[0:int(h * 0.40), :]

    gray_header = cv2.cvtColor(header, cv2.COLOR_BGR2GRAY)
    _, gray_header = cv2.threshold(gray_header, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    best_brand = "--"
    best_score = -1.0

    for brand, template in templates.items():
        template_resized = cv2.resize(
            template,
            (gray_header.shape[1], gray_header.shape[0]),
            interpolation=cv2.INTER_AREA
        )

        score = cv2.matchTemplate(
            gray_header,
            template_resized,
            cv2.TM_CCOEFF_NORMED
        )[0][0]

        if score > best_score:
            best_score = score
            best_brand = brand

    if best_score > 0.55:
        return best_brand, best_score

    return "--", best_score


def brand_from_ocr_text(text):
    upper = text.upper()

    if "NIKE" in upper:
        return "NIKE"

    if "ADIDAS" in upper:
        return "ADIDAS"

    if "PUMA" in upper:
        return "PUMA"

    if "SKECHERS" in upper or "SKECHER" in upper or "SKETCHERS" in upper or "SHECHERS" in upper:
        return "SKECHERS"

    return "--"


def brand_from_model_text(text):
    upper = text.upper()

    if "AIR MAX" in upper or "AIR FORCE" in upper or "DUNK" in upper:
        return "NIKE"

    if "ULTRABOOST" in upper or "SAMBA" in upper or "GAZELLE" in upper:
        return "ADIDAS"

    if "PALERMO" in upper or "RS-X" in upper or "SUEDE" in upper:
        return "PUMA"

    if "UNO" in upper or "D'LITES" in upper or "GO WALK" in upper:
        return "SKECHERS"

    return "--"


def set_camera_properties(cap):
    pass


def open_camera(camera_index):
    cap = cv2.VideoCapture(camera_index, cv2.CAP_V4L2)

    if not cap.isOpened():
        print("CAP_V4L2 failed, trying normal VideoCapture...")
        cap = cv2.VideoCapture(camera_index)

    return cap


def preprocess_fast(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    return gray


def extract_roi(frame):
    h, w = frame.shape[:2]

    roi_w = int(w * 0.75)
    roi_h = int(h * 0.85)

    x = int(w * 0.125)
    y = int(h * 0.075)

    roi = frame[y:y + roi_h, x:x + roi_w]
    return roi, (x, y, roi_w, roi_h)


def frame_sharpness(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def mean_confidence(data):
    confs = []

    for value in data.get("conf", []):
        try:
            conf = float(value)
        except:
            continue

        if conf >= 0:
            confs.append(conf)

    return float(np.mean(confs)) if confs else 0.0


def normalize_ocr_text(text):
    text = text.replace("|", "/")
    text = text.replace("\x0c", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\r", "\n", text)
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()


def clean_value(value):
    value = value.strip(" -:_")
    value = value.replace("|", "/")
    value = re.sub(r"\s{2,}", " ", value)
    return value.strip()


def parse_fields(text):
    clean_text = normalize_ocr_text(text)
    upper_text = clean_text.upper()
    fields = {}

    patterns = {
        "model": r"MODEL\s*[:\-]?\s*([A-Z0-9 .'\/\-]+)",
        "color": r"COLOR\s*[:\-]?\s*([A-Z0-9 \/&\-]+)",
        "size": r"SIZE\s*[:\-]?\s*(\d{2})",
    }

    for key, pattern in patterns.items():
        match = re.search(pattern, upper_text, flags=re.IGNORECASE)

        if match:
            value = match.group(1).split("\n")[0]
            fields[key] = clean_value(value)

    return fields


def run_ocr(image, debug_name, psm):
    config = f"--oem 3 --psm {psm}"

    data = pytesseract.image_to_data(
        image,
        config=config,
        output_type=pytesseract.Output.DICT,
    )

    text = pytesseract.image_to_string(image, config=config)
    clean_text = normalize_ocr_text(text)
    fields = parse_fields(clean_text)
    confidence = mean_confidence(data)

    return OCRResult(
        text=clean_text,
        confidence=confidence,
        fields=fields,
        debug_name=f"{debug_name}_psm{psm}"
    )


def best_ocr_result(roi, templates):
    gray = preprocess_fast(roi)

    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    enlarged = cv2.resize(
        otsu,
        None,
        fx=UPSCALE_FACTOR,
        fy=UPSCALE_FACTOR,
        interpolation=cv2.INTER_CUBIC
    )

    best_result = run_ocr(enlarged, "otsu", 6)
    logo_score = 0.0

    brand_text = brand_from_ocr_text(best_result.text)

    if brand_text != "--":
        best_result.fields["brand"] = brand_text
    else:
        brand_logo, logo_score = detect_brand_by_logo(roi, templates)

        if brand_logo != "--":
            best_result.fields["brand"] = brand_logo
        else:
            brand_model = brand_from_model_text(best_result.text)
            best_result.fields["brand"] = brand_model

    return best_result, enlarged, logo_score


def draw_overlay(frame, roi_rect, result, fps, sharpness, status, logo_score):
    output = frame.copy()
    x, y, w, h = roi_rect

    cv2.rectangle(output, (x, y), (x + w, y + h), (0, 255, 255), 2)

    overlay_lines = [
        f"FPS: {fps:.1f}",
        f"Sharpness: {sharpness:.1f}",
        f"Status: {status}",
        f"Confidence: {result.confidence:.1f}",
        f"Logo Score: {logo_score:.2f}",
        f"BRAND: {stable_fields['brand']} ({field_count['brand']})",
        f"MODEL: {stable_fields['model']} ({field_count['model']})",
        f"COLOR: {stable_fields['color']} ({field_count['color']})",
        f"SIZE: {stable_fields['size']} ({field_count['size']})",
    ]

    for index, line in enumerate(overlay_lines):
        y_pos = 25 + index * 24
        cv2.putText(
            output,
            line,
            (15, y_pos),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (0, 255, 0),
            2,
            cv2.LINE_AA
        )

    return output


def parse_args():
    parser = argparse.ArgumentParser(description="Live OCR direct ESP32 GO 1-18.")
    parser.add_argument("--camera", type=int, default=DEFAULT_CAMERA_INDEX)
    parser.add_argument("--esp-url", default=ESP32_URL)
    return parser.parse_args()


# ================= MAIN =================

def main():
    global sent_once

    args = parse_args()

    configure_tesseract()
    templates = load_logo_templates()

    cap = open_camera(args.camera)

    if not cap.isOpened():
        print(f"Could not open camera index {args.camera}.")
        return

    set_camera_properties(cap)

    tick_freq = cv2.getTickFrequency()
    last_tick = cv2.getTickCount()
    frame_counter = 0

    last_result = OCRResult(text="", confidence=0.0, fields={}, debug_name="waiting")
    last_status = "waiting"
    last_logo_score = 0.0

    print("ESP32 URL:", args.esp_url)
    print("Press Q to quit.")
    print("Press R to reset for new label.")
    print("Camera index:", args.camera)

    while True:
        ok, frame = cap.read()

        if not ok or frame is None:
            print("Failed to read a frame from the camera.")
            break

        roi, roi_rect = extract_roi(frame)
        sharpness = frame_sharpness(roi)

        if frame_counter % OCR_EVERY_N_FRAMES == 0:
            if sharpness >= MIN_SHARPNESS:
                last_result, _, last_logo_score = best_ocr_result(roi, templates)

                print("\n========== FIELDS ==========")
                print(last_result.fields)

                confirmed_label = update_field_stability(last_result.fields)

                print("Counts:", field_count)
                print("Stable:", stable_fields)

                if confirmed_label and not sent_once:
                    print("FINAL CONFIRMED LABEL:", confirmed_label)

                    try:
                        esp_response = send_label_to_esp(
                            confirmed_label,
                            args.esp_url
                        )

                        append_scan_log(
                            confirmed_label,
                            esp_response.get("status", "esp_response"),
                            esp_response
                        )

                        if esp_response.get("status") == "done":
                            selected_position = esp_response.get("position", "--")
                            last_status = f"ESP GO {selected_position} done"
                        else:
                            last_status = "ESP label error"

                    except requests.RequestException as exc:
                        print("ESP32 request failed:", exc)
                        append_scan_log(
                            confirmed_label,
                            "esp_error",
                            {"error": str(exc)}
                        )
                        last_status = "ESP request error"

                    sent_once = True

                elif sent_once:
                    last_status = "sent, press R for new label"

                else:
                    last_status = "confirming fields"

            else:
                last_status = "frame too blurry"

        frame_counter += 1

        current_tick = cv2.getTickCount()
        fps = tick_freq / max(current_tick - last_tick, 1)
        last_tick = current_tick

        output = draw_overlay(
            frame,
            roi_rect,
            last_result,
            fps,
            sharpness,
            last_status,
            last_logo_score
        )

        cv2.imshow("Live Shoe OCR ESP32 GO", output)

        key = cv2.waitKey(1) & 0xFF

        if key == ord("q"):
            break

        if key == ord("r"):
            print("RESET FOR NEW LABEL")
            reset_stability()
            last_status = "reset"

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
