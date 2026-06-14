import argparse
import difflib
import os
import queue
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Dict, Optional

import cv2
import numpy as np
import pytesseract
import requests


# ================= SETTINGS =================

DEFAULT_ESP32_BASE_URL = "http://172.23.250.165"
DEFAULT_CAMERA_INDEX = 0

FIREBASE_API_KEY = os.getenv("MAKHZAN_FIREBASE_API_KEY", "AIzaSyBVgBcp5ouNM_ycz0A5dxHlySN_IuZ2CJo")
FIREBASE_PROJECT_ID = os.getenv("MAKHZAN_FIREBASE_PROJECT_ID", "makhzanxpert")
FIRESTORE_BASE_URL = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
    f"/databases/(default)/documents"
)

TESSERACT_CMD = ""
OCR_TEST_MODE = False

OCR_EVERY_N_FRAMES = 8
MIN_SHARPNESS = 50.0
UPSCALE_FACTOR = 1.3

ROI_X = 0.125
ROI_Y = 0.075
ROI_W = 0.75
ROI_H = 0.85

STABLE_N = 3
SAME_LABEL_SUPPRESS_SECONDS = 0

# TEST MODE BEHAVIOR:
# After one confirmed scan is posted to Firebase, stop OCR and run the belt until IRLAST.
SCAN_ONCE_AND_STOP = True
RUN_BELT_UNTIL_IR_LAST_AFTER_SCAN = True
BELT_UNTIL_IR_LAST_TIMEOUT_SECONDS = 70

AUTOMATION_STATUS_PATH = "automation/status"
STATUS_UPDATE_MIN_INTERVAL_SECONDS = 2.0
STATUS_STATS_INTERVAL_SECONDS = 3.0
ESP_STATUS_POLL_SECONDS = 0.35

STATE_WAIT_FOR_AUTOMATION = "WAIT_FOR_AUTOMATION"
STATE_WAIT_BOX_AT_CAMERA = "WAIT_BOX_AT_CAMERA"
STATE_CAMERA_READING = "CAMERA_READING"
STATE_SCAN_CONFIRMED = "SCAN_CONFIRMED"
STATE_ERROR = "ERROR"

VALID_SORTING_STRATEGIES = {
    "brand",
    "size",
    "color",
    "model",
    "brand_size",
    "color_size",
    "model_size",
}

PRODUCT_OPTIONS = [
    ("NIKE", "AIR FORCE", "WHITE", "40"),
    ("NIKE", "AIR FORCE", "WHITE", "42"),
    ("NIKE", "AIR MAX", "BLACK", "42"),
    ("NIKE", "DUNK LOW", "GREEN", "40"),

    ("ADIDAS", "SAMBA", "WHITE", "38"),
    ("ADIDAS", "SAMBA", "WHITE", "40"),
    ("ADIDAS", "GAZELLE", "GREEN", "41"),
    ("ADIDAS", "CAMPUS", "BLACK", "39"),

    ("PUMA", "SUEDE CLASSIC", "RED", "38"),
    ("PUMA", "SUEDE CLASSIC", "RED", "40"),
    ("PUMA", "RS", "BLACK", "41"),
    ("PUMA", "CALI", "WHITE", "39"),

    ("SKECHERS", "GO WALK", "NAVY", "39"),
    ("SKECHERS", "GO WALK", "NAVY", "41"),
    ("SKECHERS", "ARCH FIT", "NAVY", "42"),
    ("SKECHERS", "UNO", "RED", "43"),
]


@dataclass
class OCRResult:
    text: str
    confidence: float
    fields: Dict[str, str]
    debug_name: str
    match_score: float = 0.0


# ================= TIME / FIRESTORE HELPERS =================

def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def timestamp(value: Optional[str] = None) -> dict:
    return {"__timestamp__": True, "value": value or utc_now()}


def plain_value_to_firestore(value):
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [plain_value_to_firestore(item) for item in value]}}
    if isinstance(value, dict) and value.get("__timestamp__"):
        return {"timestampValue": value["value"]}
    if isinstance(value, dict):
        return {"mapValue": {"fields": plain_to_firestore(value)}}
    return {"stringValue": str(value)}


def plain_to_firestore(data: dict) -> dict:
    return {key: plain_value_to_firestore(value) for key, value in data.items()}


def firestore_to_plain(fields: dict) -> dict:
    output = {}
    for key, value in fields.items():
        if "stringValue" in value:
            output[key] = value["stringValue"]
        elif "integerValue" in value:
            output[key] = int(value["integerValue"])
        elif "doubleValue" in value:
            output[key] = float(value["doubleValue"])
        elif "booleanValue" in value:
            output[key] = bool(value["booleanValue"])
        elif "timestampValue" in value:
            output[key] = value["timestampValue"]
        elif "nullValue" in value:
            output[key] = None
        elif "arrayValue" in value:
            output[key] = [
                firestore_to_plain({"value": item}).get("value")
                for item in value.get("arrayValue", {}).get("values", [])
            ]
        elif "mapValue" in value:
            output[key] = firestore_to_plain(value.get("mapValue", {}).get("fields", {}))
    return output


def print_firestore_error(prefix: str, exc: Exception) -> None:
    print(prefix)
    print(str(exc))
    response = getattr(exc, "response", None)
    if response is not None:
        print(f"{prefix}_STATUS = {response.status_code}")
        print(f"{prefix}_RESPONSE = {response.text}")


class FirebaseClient:
    def __init__(self, api_key: str, enabled: bool = True):
        self.api_key = api_key
        self.enabled = enabled and bool(api_key)

    def _url(self, path: str) -> str:
        return f"{FIRESTORE_BASE_URL}/{path.lstrip('/')}?key={self.api_key}"

    def get_doc(self, path: str) -> Optional[dict]:
        if not self.enabled:
            return None
        response = requests.get(self._url(path), timeout=15)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return firestore_to_plain(response.json().get("fields", {}))

    def set_doc(self, path: str, data: dict, merge: bool = True) -> None:
        if not self.enabled:
            return
        mask = ""
        if merge:
            mask = "".join(f"&updateMask.fieldPaths={key}" for key in data.keys())
        response = requests.patch(self._url(path) + mask, json={"fields": plain_to_firestore(data)}, timeout=15)
        response.raise_for_status()

    def add_doc(self, collection_name: str, data: dict) -> Optional[str]:
        if not self.enabled:
            return None
        response = requests.post(self._url(collection_name), json={"fields": plain_to_firestore(data)}, timeout=15)
        response.raise_for_status()
        return response.json().get("name")


def log_activity(firebase: FirebaseClient, activity_type: str, message: str, source: str = "raspberry") -> None:
    data = {
        "type": activity_type,
        "activityType": activity_type,
        "message": message,
        "source": source,
        "sourceDevice": source,
        "status": "info",
        "createdAt": timestamp(),
    }
    try:
        firebase.add_doc("activityLog", data)
        firebase.add_doc("systemActivity", data)
    except requests.RequestException as exc:
        print("Firebase activity log failed:", exc)


# ================= AUTOMATION STATUS =================

def valid_sorting_strategy(value: Optional[str]) -> bool:
    return str(value or "").strip() in VALID_SORTING_STRATEGIES


def automation_status_defaults() -> dict:
    return {
        "automationStarted": False,
        "sortingStrategy": "",
        "currentState": STATE_WAIT_FOR_AUTOMATION,
        "cameraBusy": False,
        "beltRunning": False,
        "beltBlocked": True,
        "lifterBusy": False,
        "currentOperation": "",
        "lastError": None,
        "updatedAt": timestamp(),
    }


def get_automation_status(firebase: FirebaseClient) -> dict:
    status = firebase.get_doc(AUTOMATION_STATUS_PATH) or {}
    return {**automation_status_defaults(), **status}


def set_automation_status(firebase: FirebaseClient, updates: dict) -> None:
    if not firebase.enabled:
        return
    firebase.set_doc(AUTOMATION_STATUS_PATH, {"updatedAt": timestamp(), **updates}, merge=True)


def truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in ("true", "1", "yes", "on", "started")


def automation_ready(firebase: FirebaseClient) -> tuple[bool, dict, str]:
    status = get_automation_status(firebase)
    system_settings = firebase.get_doc("settings/system") or {}

    strategy = (
        status.get("sortingStrategy")
        or status.get("sortingMode")
        or system_settings.get("sortingMode")
        or ""
    )

    automation_started = truthy(
        status.get("automationStarted")
        or status.get("automationEnabled")
        or system_settings.get("automationEnabled")
    )

    if not valid_sorting_strategy(strategy):
        return False, status, "Waiting for sorting strategy"
    if not automation_started:
        return False, status, "Waiting for Start Automation"
    return True, status, ""


_automation_status_cache: dict = {}
_automation_status_lock = threading.Lock()
_status_update_worker = None


class StatusUpdateWorker(threading.Thread):
    def __init__(self, firebase: FirebaseClient):
        super().__init__(daemon=True)
        self.firebase = firebase
        self.queue: queue.Queue = queue.Queue(maxsize=1)
        self.stop_event = threading.Event()
        self.last_sent_at = 0.0
        self.sent_count = 0
        self.skipped_count = 0
        self.last_stats_at = 0.0

    def enqueue(self, updates: dict) -> bool:
        if not self.firebase.enabled:
            self.skipped_count += 1
            return False
        try:
            self.queue.put_nowait(dict(updates))
            return True
        except queue.Full:
            self.skipped_count += 1
            try:
                self.queue.get_nowait()
                self.queue.task_done()
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(dict(updates))
                return True
            except queue.Full:
                return False

    def print_stats(self) -> None:
        now = time.monotonic()
        if now - self.last_stats_at < STATUS_STATS_INTERVAL_SECONDS:
            return
        self.last_stats_at = now
        print(f"STATUS_QUEUE_SIZE {self.queue.qsize()}")
        print(f"STATUS_SENT {self.sent_count}")
        print(f"STATUS_SKIPPED {self.skipped_count}")

    def run(self) -> None:
        while not self.stop_event.is_set():
            self.print_stats()
            try:
                pending = self.queue.get(timeout=0.1)
                self.queue.task_done()
            except queue.Empty:
                continue

            elapsed = time.monotonic() - self.last_sent_at
            if elapsed < STATUS_UPDATE_MIN_INTERVAL_SECONDS:
                self.stop_event.wait(STATUS_UPDATE_MIN_INTERVAL_SECONDS - elapsed)
                if self.stop_event.is_set():
                    break

            try:
                started_at = time.perf_counter()
                set_automation_status(self.firebase, pending)
                self.last_sent_at = time.monotonic()
                self.sent_count += 1
                print(f"FIREBASE_UPDATE_TIME_MS {(time.perf_counter() - started_at) * 1000:.1f}")
            except requests.RequestException as exc:
                self.skipped_count += 1
                print("Firebase status update failed:", exc)


def set_status_update_worker(worker) -> None:
    global _status_update_worker
    _status_update_worker = worker


def set_status_if_changed(firebase: FirebaseClient, updates: dict) -> bool:
    if not firebase.enabled:
        return False

    comparable = {key: value for key, value in updates.items() if key != "updatedAt"}
    with _automation_status_lock:
        unchanged = all(_automation_status_cache.get(key) == value for key, value in comparable.items())
        if unchanged:
            worker = _status_update_worker
            if worker:
                worker.skipped_count += 1
            return False
        _automation_status_cache.update(comparable)

    worker = _status_update_worker
    if worker:
        return worker.enqueue(updates)
    return False


class AutomationReadyPoller(threading.Thread):
    def __init__(self, firebase: FirebaseClient, interval_seconds: float = 2.0):
        super().__init__(daemon=True)
        self.firebase = firebase
        self.interval_seconds = interval_seconds
        self.ready = False
        self.status = automation_status_defaults()
        self.reason = "Waiting for automation"
        self.lock = threading.Lock()
        self.stop_event = threading.Event()

    def snapshot(self) -> tuple[bool, dict, str]:
        with self.lock:
            return self.ready, dict(self.status), self.reason

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                ready, status, reason = automation_ready(self.firebase)
            except requests.RequestException as exc:
                ready = False
                status = automation_status_defaults()
                reason = f"Automation status failed: {exc}"
                print("Automation status failed:", exc)
            with self.lock:
                self.ready = ready
                self.status = status
                self.reason = reason
            self.stop_event.wait(self.interval_seconds)


# ================= ESP STATUS ONLY =================

def esp_url(esp_base_url: str, path: str) -> str:
    return f"{esp_base_url.rstrip('/')}/{path.lstrip('/')}"


def esp_get_json(esp_base_url: str, path: str, params: Optional[dict] = None, timeout: int = 3) -> dict:
    response = requests.get(esp_url(esp_base_url, path), params=params or {}, timeout=timeout)
    response.raise_for_status()
    data = response.json()
    if data.get("ok") is False:
        raise RuntimeError(data.get("error") or f"ESP request failed: {path}")
    return data


def get_esp_status(esp_base_url: str) -> dict:
    data = esp_get_json(esp_base_url, "/status", timeout=3)
    return data.get("status") or data


def run_belt_until_ir_last(esp_base_url: str) -> bool:
    print("SENDING_BELT_RUN_UNTIL_IR_LAST")
    data = esp_get_json(
        esp_base_url,
        "/belt/until-ir-last",
        timeout=BELT_UNTIL_IR_LAST_TIMEOUT_SECONDS,
    )
    print("BELT_RUN_UNTIL_IR_LAST_RESPONSE =", data)
    print("BELT_RUN_UNTIL_IR_LAST_DONE")
    return True


def bool_status(status: dict, key: str) -> bool:
    return bool(status.get(key))


class EspStatusPoller(threading.Thread):
    def __init__(self, esp_base_url: str, interval_seconds: float = ESP_STATUS_POLL_SECONDS):
        super().__init__(daemon=True)
        self.esp_base_url = esp_base_url
        self.interval_seconds = interval_seconds
        self.status: dict = {}
        self.error = ""
        self.lock = threading.Lock()
        self.stop_event = threading.Event()

    def snapshot(self) -> tuple[dict, str]:
        with self.lock:
            return dict(self.status), self.error

    def run(self) -> None:
        while not self.stop_event.is_set():
            started_at = time.perf_counter()
            try:
                status = get_esp_status(self.esp_base_url)
                elapsed_ms = (time.perf_counter() - started_at) * 1000
                with self.lock:
                    self.status = status
                    self.error = ""
                print(f"ESP_STATUS_TIME_MS {elapsed_ms:.1f}")
            except requests.RequestException as exc:
                with self.lock:
                    self.error = str(exc)
            self.stop_event.wait(self.interval_seconds)


# ================= PRODUCT / OCR MATCHING =================

def normalize_sku_part(value: str) -> str:
    normalized = str(value or "").strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized)
    return normalized.strip("_") or "unknown"


def normalize_label(label: dict) -> dict:
    normalized = {}
    for key in ("brand", "model", "color", "size"):
        value = str(label.get(key, "") or "").strip().upper()
        normalized[key] = re.sub(r"\s+", " ", value)
    aliases = {
        "AIR FORCE 1": "AIR FORCE",
        "AIRFORCE": "AIR FORCE",
        "DUNK": "DUNK LOW",
        "RS-X": "RS",
        "RS X": "RS",
        "SUEDE": "SUEDE CLASSIC",
    }
    normalized["model"] = aliases.get(normalized["model"], normalized["model"])
    return normalized


def product_key(label: dict) -> str:
    normalized = normalize_label(label)
    return "|".join(normalized.get(key, "") for key in ("brand", "model", "color", "size"))


def build_normalized_sku(label: dict) -> str:
    label = normalize_label(label)
    return "_".join(normalize_sku_part(label.get(key, "")) for key in ("brand", "model", "color", "size"))


def build_product_slug(label: dict) -> str:
    label = normalize_label(label)
    return "-".join(str(label.get(key, "")).lower().replace(" ", "-") for key in ("brand", "model", "color", "size"))


def clean_match_text(text):
    text = str(text or "").upper()
    text = text.replace("\\", " ")
    text = text.replace("/", " ")
    text = text.replace("|", " ")
    text = text.replace("_", " ")
    text = text.replace("-", " ")
    text = text.replace("0", "O")
    text = re.sub(r"[^A-Z0-9 ]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def compact_match_text(value):
    return re.sub(r"[^A-Z0-9]+", "", str(value or "").upper())


def product_match_score(ocr_text, product):
    brand, model, color, size = product
    raw = clean_match_text(ocr_text)
    raw_compact = compact_match_text(raw)
    target = f"{brand} {model} {color} {size}"
    target_compact = compact_match_text(target)

    score = difflib.SequenceMatcher(None, raw_compact, target_compact).ratio()

    for part in product:
        part_compact = compact_match_text(part)
        if part_compact and part_compact in raw_compact:
            score += 0.25

    raw_size_text = raw.replace("O", "0").replace("I", "1").replace("L", "1")
    if re.search(rf"\b{size}\b", raw_size_text):
        score += 0.35

    return score


def best_product_match(ocr_text):
    best_product = None
    best_score = -1.0

    for product in PRODUCT_OPTIONS:
        score = product_match_score(ocr_text, product)
        if score > best_score:
            best_score = score
            best_product = product

    if not best_product or best_score < 0.45:
        return {}, best_score

    return {
        "brand": best_product[0],
        "model": best_product[1],
        "color": best_product[2],
        "size": best_product[3],
    }, best_score


def fix_common_ocr_errors(value):
    value = str(value or "").upper().strip()
    value = value.replace("|", "/")
    value = value.replace("\\", "/")
    value = re.sub(r"\s+", " ", value)
    value = value.replace("WHLTE", "WHITE")
    value = value.replace("WHTE", "WHITE")
    value = value.replace("WH1TE", "WHITE")
    value = value.replace("BLK", "BLACK")
    value = value.replace("BLAK", "BLACK")
    return value.strip()


field_last = {"brand": None, "model": None, "color": None, "size": None}
field_count = {"brand": 0, "model": 0, "color": 0, "size": 0}
stable_fields = {"brand": None, "model": None, "color": None, "size": None}
last_label_signature = ""
last_label_time = 0.0


def reset_stability():
    global field_last, field_count, stable_fields
    field_last = {"brand": None, "model": None, "color": None, "size": None}
    field_count = {"brand": 0, "model": 0, "color": 0, "size": 0}
    stable_fields = {"brand": None, "model": None, "color": None, "size": None}


def label_signature(label: dict) -> str:
    return "|".join(label.get(key, "").strip().upper() for key in ("brand", "model", "color", "size"))


def should_accept_label(label: dict) -> bool:
    global last_label_signature, last_label_time
    signature = label_signature(label)
    now = time.time()
    if signature == last_label_signature and now - last_label_time < SAME_LABEL_SUPPRESS_SECONDS:
        return False
    last_label_signature = signature
    last_label_time = now
    return True


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

    if all(stable_fields[k] is not None for k in ("brand", "model", "color", "size")):
        return {key: stable_fields[key] for key in ("brand", "model", "color", "size")}
    return None


# ================= CAMERA / OCR =================

def configure_tesseract():
    if TESSERACT_CMD and os.path.exists(TESSERACT_CMD):
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
        return
    path_cmd = shutil.which("tesseract")
    if path_cmd:
        pytesseract.pytesseract.tesseract_cmd = path_cmd


def open_camera(camera_index):
    cap = cv2.VideoCapture(camera_index, cv2.CAP_V4L2)
    if not cap.isOpened():
        print("CAP_V4L2 failed, trying normal VideoCapture...")
        cap = cv2.VideoCapture(camera_index)
    return cap


def set_camera_properties(cap):
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)


def preprocess_fast(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return cv2.GaussianBlur(gray, (3, 3), 0)


def extract_roi(frame):
    h, w = frame.shape[:2]
    roi_w = int(w * ROI_W)
    roi_h = int(h * ROI_H)
    x = int(w * ROI_X)
    y = int(h * ROI_Y)
    return frame[y:y + roi_h, x:x + roi_w], (x, y, roi_w, roi_h)


def frame_sharpness(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def mean_confidence(data):
    confs = []
    for value in data.get("conf", []):
        try:
            conf = float(value)
        except ValueError:
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


def run_ocr(image, debug_name, psm):
    config = f"--oem 3 --psm {psm}"
    data = pytesseract.image_to_data(image, config=config, output_type=pytesseract.Output.DICT)
    text = pytesseract.image_to_string(image, config=config)
    clean_text = normalize_ocr_text(text)
    fields, match_score = best_product_match(clean_text)

    print("OCR_RAW_TEXT =")
    print(clean_text)
    print("MATCH_SCORE =", round(match_score, 2))
    print("MATCH_FIELDS =", fields)

    return OCRResult(
        text=clean_text,
        confidence=mean_confidence(data),
        fields=fields,
        debug_name=f"{debug_name}_psm{psm}",
        match_score=match_score,
    )


def best_ocr_result(roi):
    gray = preprocess_fast(roi)
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    enlarged = cv2.resize(otsu, None, fx=UPSCALE_FACTOR, fy=UPSCALE_FACTOR, interpolation=cv2.INTER_CUBIC)
    result = run_ocr(enlarged, "matched_catalog", 6)
    return result, enlarged


class OCRWorker(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.jobs: queue.Queue = queue.Queue(maxsize=1)
        self.results: queue.Queue = queue.Queue(maxsize=1)
        self.stop_event = threading.Event()
        self.busy = threading.Event()

    def submit(self, roi, sharpness: float) -> bool:
        if self.busy.is_set() or not self.jobs.empty():
            return False
        try:
            self.jobs.put_nowait((roi.copy(), sharpness, time.time()))
            return True
        except queue.Full:
            return False

    def get_result(self) -> Optional[dict]:
        try:
            return self.results.get_nowait()
        except queue.Empty:
            return None

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                roi, sharpness, submitted_at = self.jobs.get(timeout=0.1)
            except queue.Empty:
                continue

            self.busy.set()
            started_at = time.perf_counter()
            try:
                print("OCR WORKER STARTED")
                result, _ = best_ocr_result(roi)
                elapsed_ms = (time.perf_counter() - started_at) * 1000
                print(f"OCR_TIME_MS {elapsed_ms:.1f}")

                while not self.results.empty():
                    try:
                        self.results.get_nowait()
                    except queue.Empty:
                        break

                self.results.put_nowait({
                    "result": result,
                    "sharpness": sharpness,
                    "submitted_at": submitted_at,
                    "ocr_time_ms": elapsed_ms,
                })
            except Exception as exc:
                print("OCR worker failed:", exc)
            finally:
                self.busy.clear()
                self.jobs.task_done()


# ================= FIREBASE SCAN OUTPUT =================

def post_confirmed_scan(firebase: FirebaseClient, label: dict, raw_text: str, match_score: float, confidence: float) -> Optional[str]:
    label = normalize_label(label)
    now = utc_now()
    scan_id = f"SCAN-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6].upper()}"
    sku = build_normalized_sku(label)
    key = product_key(label)
    slug = build_product_slug(label)

    data = {
        "scanId": scan_id,
        "deviceId": "raspberry-ocr-01",
        "source": "raspberry",
        "status": "CONFIRMED",
        "decisionStatus": "waiting",
        "needsDecision": True,
        "normalizedSku": sku,
        "productKey": key,
        "slug": slug,
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "rawText": raw_text,
        "matchScore": float(match_score),
        "confidence": float(confidence),
        "createdAt": timestamp(now),
        "updatedAt": timestamp(now),
    }

    if not firebase.enabled:
        print("SCAN_NOT_POSTED Firebase disabled")
        return None

    firebase.set_doc(f"scanQueue/{scan_id}", data, merge=False)
    firebase.add_doc("scans", data)
    set_automation_status(firebase, {
        "currentState": STATE_SCAN_CONFIRMED,
        "cameraBusy": False,
        "beltBlocked": False,
        "beltRunning": False,
        "lastScanId": scan_id,
        "lastProductKey": key,
        "lastConfirmedLabel": key,
        "currentOperation": "Scan posted to Firebase for website decision",
        "lastError": None,
    })
    log_activity(firebase, "SCAN_POSTED_FOR_DECISION", f"{scan_id} = {key}", "raspberry")
    print("SCAN_POSTED_FOR_WEBSITE_DECISION =", scan_id)
    print("PRODUCT_KEY =", key)
    return scan_id


# ================= OVERLAY / ARGS =================

def draw_overlay(frame, roi_rect, result, fps, sharpness, status, diagnostics: Optional[dict] = None):
    output = frame.copy()
    x, y, w, h = roi_rect
    cv2.rectangle(output, (x, y), (x + w, y + h), (0, 255, 255), 2)
    diagnostics = diagnostics or {}
    last_text = str(diagnostics.get("last_ocr_text", "") or "")
    if len(last_text) > 34:
        last_text = last_text[:34] + "..."

    overlay_lines = [
        f"FPS: {fps:.1f}",
        f"IR_CAMERA: {diagnostics.get('ir_camera', False)}",
        f"Sharpness: {sharpness:.1f}",
        f"Status: {status}",
        f"OCR Busy: {diagnostics.get('ocr_busy', False)}",
        f"Last OCR ms: {diagnostics.get('last_ocr_time_ms', 0.0):.1f}",
        f"Last OCR text: {last_text}",
        f"Confidence: {result.confidence:.1f}",
        f"Match Score: {result.match_score:.2f}",
        f"BRAND: {stable_fields['brand']} ({field_count['brand']})",
        f"MODEL: {stable_fields['model']} ({field_count['model']})",
        f"COLOR: {stable_fields['color']} ({field_count['color']})",
        f"SIZE: {stable_fields['size']} ({field_count['size']})",
    ]
    for index, line in enumerate(overlay_lines):
        cv2.putText(output, line, (15, 25 + index * 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2, cv2.LINE_AA)
    return output


def parse_args():
    parser = argparse.ArgumentParser(description="MakhzanXpert Raspberry Pi OCR-only scanner.")
    parser.add_argument("--camera", type=int, default=DEFAULT_CAMERA_INDEX)
    parser.add_argument("--esp-url", default=DEFAULT_ESP32_BASE_URL)
    parser.add_argument("--no-firebase", action="store_true")
    parser.add_argument("--no-ir-gate", action="store_true", help="Read continuously after Start Automation without waiting for ESP irCamera.")
    return parser.parse_args()


# ================= MAIN =================

def main():
    args = parse_args()
    firebase = FirebaseClient(FIREBASE_API_KEY, enabled=not args.no_firebase and not OCR_TEST_MODE)

    configure_tesseract()

    status_worker = None
    automation_poller = None
    esp_status_poller = None

    if not OCR_TEST_MODE:
        status_worker = StatusUpdateWorker(firebase)
        set_status_update_worker(status_worker)
        status_worker.start()

        automation_poller = AutomationReadyPoller(firebase)
        automation_poller.start()

        if not args.no_ir_gate:
            esp_status_poller = EspStatusPoller(args.esp_url)
            esp_status_poller.start()

    cap = open_camera(args.camera)
    if not cap.isOpened():
        print(f"Could not open camera index {args.camera}.")
        return

    set_camera_properties(cap)

    ocr_worker = OCRWorker()
    ocr_worker.start()

    tick_freq = cv2.getTickFrequency()
    last_tick = cv2.getTickCount()
    frame_counter = 0

    last_result = OCRResult(text="", confidence=0.0, fields={}, debug_name="waiting", match_score=0.0)
    last_status = "waiting"
    last_ocr_time_ms = 0.0
    last_ocr_text = ""
    ir_camera = False
    fps = 0.0
    last_fps_log = 0.0
    last_ir_log = 0.0
    scan_done = False

    print("MakhzanXpert Raspberry OCR-only scanner")
    print("ESP32 STATUS URL:", f"{args.esp_url.rstrip()}/status")
    print("Press Q to quit.")
    print("Press R to reset OCR stability.")
    print("Camera index:", args.camera)

    try:
        while True:
            ok, frame = cap.read()
            if not ok or frame is None:
                print("Failed to read a frame from the camera.")
                break

            if scan_done and SCAN_ONCE_AND_STOP:
                print("SCAN_DONE_OCR_STOPPED")
                break

            roi, roi_rect = extract_roi(frame)
            sharpness = frame_sharpness(roi)
            now_seconds = time.time()

            if OCR_TEST_MODE:
                automation_ready_cached = True
                automation_status_cached = automation_status_defaults()
                automation_wait_reason = ""
            else:
                automation_ready_cached, automation_status_cached, automation_wait_reason = automation_poller.snapshot()

            ocr_payload = ocr_worker.get_result()
            if ocr_payload:
                last_result = ocr_payload["result"]
                last_ocr_time_ms = float(ocr_payload.get("ocr_time_ms") or 0.0)
                last_ocr_text = last_result.text
                confirmed_label = update_field_stability(last_result.fields)

                set_status_if_changed(firebase, {
                    "currentState": STATE_WAIT_BOX_AT_CAMERA,
                    "cameraBusy": False,
                    "beltBlocked": False,
                    "beltRunning": False,
                    "lastError": None,
                })

                print("FIELDS =", last_result.fields)
                print("COUNTS =", field_count)
                print("STABLE =", stable_fields)

                if confirmed_label and should_accept_label(confirmed_label):
                    print("FINAL CONFIRMED LABEL:", confirmed_label)
                    if OCR_TEST_MODE:
                        last_status = "test label confirmed"
                    else:
                        try:
                            scan_id = post_confirmed_scan(
                                firebase,
                                confirmed_label,
                                last_result.text,
                                last_result.match_score,
                                last_result.confidence,
                            )
                            last_status = f"scan posted {scan_id}" if scan_id else "scan not posted"

                            if scan_id and SCAN_ONCE_AND_STOP:
                                scan_done = True
                                print("SCAN_DONE_STOPPING_OCR")

                                if RUN_BELT_UNTIL_IR_LAST_AFTER_SCAN:
                                    try:
                                        run_belt_until_ir_last(args.esp_url)
                                    except Exception as belt_exc:
                                        print("BELT_RUN_UNTIL_IR_LAST_FAILED =", belt_exc)

                                print("TEST_FLOW_DONE: scan posted; OCR stopped; belt command attempted")
                        except Exception as exc:
                            print("Scan post failed:", exc)
                            set_status_if_changed(firebase, {
                                "currentState": STATE_ERROR,
                                "cameraBusy": False,
                                "beltBlocked": True,
                                "lastError": f"Scan post failed: {exc}",
                            })
                            last_status = "scan post error"

                    reset_stability()
                elif confirmed_label:
                    print("DUPLICATE_LABEL_SUPPRESSED")
                    log_activity(firebase, "DUPLICATE_LABEL_SUPPRESSED", label_signature(confirmed_label), "raspberry")
                    last_status = "duplicate label suppressed"
                    reset_stability()
                else:
                    last_status = "confirming fields"

            if not automation_ready_cached:
                print("OCR SKIPPED = automation not ready")
                reset_stability()
                set_status_if_changed(firebase, {
                    "currentState": STATE_WAIT_FOR_AUTOMATION,
                    "cameraBusy": False,
                    "beltRunning": False,
                    "beltBlocked": True,
                    "lifterBusy": False,
                    "currentOperation": "",
                    "lastError": automation_wait_reason,
                })
                last_status = automation_wait_reason
            else:
                if OCR_TEST_MODE or args.no_ir_gate:
                    ir_camera = True
                    esp_error = ""
                else:
                    esp_status, esp_error = esp_status_poller.snapshot()
                    if esp_error:
                        print("ESP_STATUS_ERROR =", esp_error)
                    ir_camera = bool_status(esp_status, "irCamera")

                if now_seconds - last_ir_log >= 1.0:
                    print(f"IR_CAMERA = {ir_camera}")
                    print(f"SHARPNESS = {sharpness:.1f}")
                    print(f"MIN_SHARPNESS = {MIN_SHARPNESS:.1f}")
                    print(f"SHARPNESS_REJECTED = {sharpness < MIN_SHARPNESS}")
                    last_ir_log = now_seconds

                if not ir_camera:
                    print("OCR SKIPPED = no IR_CAMERA")
                    set_status_if_changed(firebase, {
                        "currentState": STATE_WAIT_BOX_AT_CAMERA,
                        "cameraBusy": False,
                        "beltRunning": False,
                        "beltBlocked": False,
                        "lastError": None,
                    })
                    last_status = "waiting for IR_CAMERA"
                elif frame_counter % OCR_EVERY_N_FRAMES == 0:
                    print("TRYING OCR")
                    print("IR_CAMERA =", ir_camera)
                    print("SHARPNESS =", sharpness)
                    print("FRAME_COUNTER =", frame_counter)

                    if sharpness >= MIN_SHARPNESS:
                        submitted = ocr_worker.submit(roi, sharpness)
                        print("OCR SUBMITTED =", submitted)
                        if submitted:
                            set_status_if_changed(firebase, {
                                "currentState": STATE_CAMERA_READING,
                                "cameraBusy": True,
                                "beltBlocked": True,
                                "beltRunning": False,
                                "lastError": None,
                            })
                            last_status = "ocr reading"
                        elif ocr_worker.busy.is_set():
                            last_status = "ocr busy"
                    else:
                        print("OCR SUBMITTED = False")
                        print("OCR SKIPPED = frame too blurry")
                        last_status = "frame too blurry"

            frame_counter += 1
            current_tick = cv2.getTickCount()
            fps = tick_freq / max(current_tick - last_tick, 1)
            last_tick = current_tick

            if now_seconds - last_fps_log >= 1.0:
                print(f"FPS {fps:.1f}")
                last_fps_log = now_seconds

            diagnostics = {
                "ir_camera": ir_camera,
                "ocr_busy": ocr_worker.busy.is_set(),
                "last_ocr_time_ms": last_ocr_time_ms,
                "last_ocr_text": last_ocr_text,
            }
            output = draw_overlay(frame, roi_rect, last_result, fps, sharpness, last_status, diagnostics)
            cv2.imshow("MakhzanXpert OCR-only Scanner", output)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("r"):
                print("RESET FOR NEW LABEL")
                reset_stability()
                last_status = "reset"

    finally:
        ocr_worker.stop_event.set()
        if esp_status_poller:
            esp_status_poller.stop_event.set()
        if automation_poller:
            automation_poller.stop_event.set()
        if status_worker:
            status_worker.stop_event.set()
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
