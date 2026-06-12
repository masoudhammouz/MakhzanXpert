import argparse
import os
import re
import shutil
import sqlite3
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

DEFAULT_ESP32_BASE_URL = "http://192.168.1.50"
DEFAULT_CAMERA_INDEX = 0
DEFAULT_DB_PATH = "makhzanxpert_pi.sqlite3"

FIREBASE_API_KEY = os.getenv("MAKHZAN_FIREBASE_API_KEY", "AIzaSyBVgBcp5ouNM_ycz0A5dxHlySN_IuZ2CJo")
FIREBASE_PROJECT_ID = os.getenv("MAKHZAN_FIREBASE_PROJECT_ID", "makhzanxpert")
FIRESTORE_BASE_URL = (
    f"https://firestore.googleapis.com/v1/projects/{FIREBASE_PROJECT_ID}"
    f"/databases/(default)/documents"
)

TESSERACT_CMD = ""  # On Raspberry Pi keep empty if tesseract is in PATH.
OCR_EVERY_N_FRAMES = 8
MIN_SHARPNESS = 50.0
UPSCALE_FACTOR = 1.5
LOGO_FOLDER = "logos"
STABLE_N = 3
SAME_LABEL_SUPPRESS_SECONDS = 15

SYSTEM_SETTING_KEYS = [
    "sortingMode",
    "automationEnabled",
    "autoConveyor",
    "autoOCR",
    "autoPositionSelection",
    "autoInventoryUpdate",
    "requireIRVerification",
    "firebaseLogging",
]

DEFAULT_SETTINGS = {
    "sortingMode": "brand",
    "automationEnabled": "false",
    "autoConveyor": "true",
    "autoOCR": "true",
    "autoPositionSelection": "true",
    "autoInventoryUpdate": "true",
    "requireIRVerification": "false",
    "firebaseLogging": "true",
}

NEIGHBORS = {
    1: [2, 4],
    2: [1, 3, 5],
    3: [2, 6],
    4: [1, 5, 7],
    5: [2, 4, 6, 8],
    6: [3, 5, 9],
    7: [4, 8],
    8: [5, 7, 9],
    9: [6, 8],
}


@dataclass
class OCRResult:
    text: str
    confidence: float
    fields: Dict[str, str]
    debug_name: str


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def location_to_go_in(location_id: int) -> int:
    return location_id * 2 - 1


def location_to_go_out(location_id: int) -> int:
    return location_id * 2


# ================= FIREBASE REST =================

class FirebaseClient:
    def __init__(self, api_key: str, enabled: bool = True):
        self.api_key = api_key
        self.enabled = enabled and bool(api_key)

    def _url(self, path: str) -> str:
        return f"{FIRESTORE_BASE_URL}/{path.lstrip('/')}?key={self.api_key}"

    def _documents_url(self) -> str:
        return f"{FIRESTORE_BASE_URL}:runQuery?key={self.api_key}"

    def _commit_url(self) -> str:
        return f"{FIRESTORE_BASE_URL}:commit?key={self.api_key}"

    def _begin_transaction_url(self) -> str:
        return f"{FIRESTORE_BASE_URL}:beginTransaction?key={self.api_key}"

    def _full_doc_name(self, path: str) -> str:
        return f"projects/{FIREBASE_PROJECT_ID}/databases/(default)/documents/{path.lstrip('/')}"

    def get_doc(self, path: str) -> Optional[dict]:
        if not self.enabled:
            return None
        response = requests.get(self._url(path), timeout=15)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return firestore_to_plain(response.json().get("fields", {}))

    def get_doc_raw(self, path: str, transaction: Optional[str] = None) -> Optional[dict]:
        if not self.enabled:
            return None
        url = self._url(path)
        if transaction:
            url += f"&transaction={transaction}"
        response = requests.get(url, timeout=15)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    def begin_transaction(self) -> Optional[str]:
        if not self.enabled:
            return None
        response = requests.post(self._begin_transaction_url(), json={"options": {"readWrite": {}}}, timeout=15)
        response.raise_for_status()
        return response.json().get("transaction")

    def commit_writes(self, writes: list[dict], transaction: Optional[str] = None) -> None:
        if not self.enabled:
            return
        body = {"writes": writes}
        if transaction:
            body["transaction"] = transaction
        response = requests.post(self._commit_url(), json=body, timeout=20)
        response.raise_for_status()

    def set_doc(self, path: str, data: dict, merge: bool = True) -> None:
        if not self.enabled:
            return
        fields = plain_to_firestore(data)
        mask = ""
        if merge:
            mask = "".join(f"&updateMask.fieldPaths={key}" for key in data.keys())
        response = requests.patch(self._url(path) + mask, json={"fields": fields}, timeout=15)
        response.raise_for_status()

    def add_doc(self, collection_name: str, data: dict) -> Optional[str]:
        if not self.enabled:
            return None
        response = requests.post(self._url(collection_name), json={"fields": plain_to_firestore(data)}, timeout=15)
        response.raise_for_status()
        return response.json().get("name")

    def query(self, collection_name: str, filters: dict, order_field: str = "createdAt", limit_count: int = 20) -> list[dict]:
        if not self.enabled:
            return []

        query_filters = []
        for key, value in filters.items():
            query_filters.append({
                "fieldFilter": {
                    "field": {"fieldPath": key},
                    "op": "EQUAL",
                    "value": plain_value_to_firestore(value),
                }
            })

        body = {
            "structuredQuery": {
                "from": [{"collectionId": collection_name}],
                "where": {
                    "compositeFilter": {
                        "op": "AND",
                        "filters": query_filters,
                    }
                } if len(query_filters) > 1 else query_filters[0],
                "orderBy": [{"field": {"fieldPath": order_field}, "direction": "ASCENDING"}],
                "limit": limit_count,
            }
        }

        response = requests.post(self._documents_url(), json=body, timeout=20)
        response.raise_for_status()

        results = []
        for item in response.json():
            document = item.get("document")
            if not document:
                continue
            plain = firestore_to_plain(document.get("fields", {}))
            plain["_name"] = document.get("name", "")
            plain["_id"] = plain["_name"].split("/")[-1]
            results.append(plain)
        return results


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
    return {"stringValue": str(value)}


def firestore_increment(amount: int = 1) -> dict:
    return {"integerValue": str(amount)}


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
    return output


def timestamp(value: Optional[str] = None) -> dict:
    return {"__timestamp__": True, "value": value or utc_now()}


def normalize_sku_part(value: str) -> str:
    normalized = str(value or "").strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized)
    return normalized.strip("_") or "unknown"


def build_normalized_sku(label: dict) -> str:
    return "_".join(
        normalize_sku_part(label.get(key, ""))
        for key in ("brand", "model", "color", "size")
    )


def product_is_draft(product: Optional[dict]) -> bool:
    if not product:
        return True
    return bool(product.get("needsDetails")) or product.get("status") in ("draft", "pending_details")


def make_update_write(firebase: FirebaseClient, path: str, data: dict, exists: Optional[bool] = None) -> dict:
    write = {
        "update": {
            "name": firebase._full_doc_name(path),
            "fields": plain_to_firestore(data),
        }
    }
    if exists is not None:
        write["currentDocument"] = {"exists": exists}
    return write


def make_merge_write(firebase: FirebaseClient, path: str, data: dict) -> dict:
    write = make_update_write(firebase, path, data)
    write["updateMask"] = {"fieldPaths": list(data.keys())}
    return write


def make_transform_write(firebase: FirebaseClient, path: str, transforms: dict[str, int]) -> dict:
    return {
        "transform": {
            "document": firebase._full_doc_name(path),
            "fieldTransforms": [
                {
                    "fieldPath": field,
                    "increment": firestore_increment(amount),
                }
                for field, amount in transforms.items()
            ],
        }
    }


def make_merge_increment_write(firebase: FirebaseClient, path: str, data: dict, transforms: dict[str, int]) -> dict:
    write = make_merge_write(firebase, path, data)
    write["updateTransforms"] = [
        {
            "fieldPath": field,
            "increment": firestore_increment(amount),
        }
        for field, amount in transforms.items()
    ]
    return write


def sync_product_from_label(
    firebase: FirebaseClient,
    label: dict,
    scan_id: str,
    box_id: str,
    location_id: int,
    go_position: int,
    max_retries: int = 3,
) -> tuple[str, bool]:
    sku = build_normalized_sku(label)
    if not firebase.enabled:
        return sku, False

    for attempt in range(max_retries):
        transaction_id = firebase.begin_transaction()
        processed_raw = firebase.get_doc_raw(f"processedScans/{scan_id}", transaction=transaction_id)
        if processed_raw:
            print(f"Scan {scan_id} already processed; inventory increment ignored.")
            return sku, True

        product_raw = firebase.get_doc_raw(f"products/{sku}", transaction=transaction_id)
        product_exists = bool(product_raw)
        product = firestore_to_plain(product_raw.get("fields", {})) if product_raw else None
        now = utc_now()

        processed_data = {
            "scanId": scan_id,
            "boxId": box_id,
            "normalizedSku": sku,
            "brand": label["brand"],
            "model": label["model"],
            "color": label["color"],
            "size": label["size"],
            "locationId": location_id,
            "goPosition": go_position,
            "inventoryApplied": True,
            "availableStockPosted": False,
            "status": "label_confirmed",
            "createdAt": timestamp(now),
            "updatedAt": timestamp(now),
        }

        if product_exists:
            product_update = {
                "normalizedSku": sku,
                "brand": product.get("brand") or label["brand"],
                "model": product.get("model") or label["model"],
                "color": product.get("color") or label["color"],
                "size": product.get("size") or label["size"],
                "lastLabelScanId": scan_id,
                "lastBoxId": box_id,
                "lastAssignedLocationId": location_id,
                "lastMovementGoPosition": go_position,
                "updatedAt": timestamp(now),
            }
            writes = [
                make_update_write(firebase, f"processedScans/{scan_id}", processed_data, exists=False),
                make_merge_increment_write(firebase, f"products/{sku}", product_update, {"quantity": 1, "stock": 1, "inventoryCount": 1}),
            ]
        else:
            product_data = {
                "normalizedSku": sku,
                "status": "pending_details",
                "needsDetails": True,
                "brand": label["brand"],
                "model": label["model"],
                "color": label["color"],
                "size": label["size"],
                "quantity": 1,
                "stock": 1,
                "inventoryCount": 1,
                "availableStock": 0,
                "price": None,
                "images": [],
                "imageUrl": "",
                "description": "",
                "category": "",
                "isAvailable": False,
                "createdFromLabel": True,
                "lastLabelScanId": scan_id,
                "lastBoxId": box_id,
                "lastAssignedLocationId": location_id,
                "lastMovementGoPosition": go_position,
                "createdAt": timestamp(now),
                "updatedAt": timestamp(now),
            }
            writes = [
                make_update_write(firebase, f"processedScans/{scan_id}", processed_data, exists=False),
                make_update_write(firebase, f"products/{sku}", product_data, exists=False),
            ]

        try:
            firebase.commit_writes(writes, transaction=transaction_id)
            log_activity(firebase, "LABEL_CONFIRMED", f"{scan_id} confirmed as {sku}.", "raspberry")
            if product_exists:
                log_activity(firebase, "INVENTORY_INCREMENTED", f"{sku} quantity incremented by 1.", "raspberry")
            else:
                log_activity(firebase, "PRODUCT_CREATED_FROM_LABEL", f"{sku} created from label scan.", "raspberry")
                log_activity(firebase, "INVENTORY_PENDING_DETAILS", f"{sku} needs price/details before publishing.", "raspberry")
            log_activity(firebase, "LOCATION_ASSIGNED", f"{sku} assigned to location {location_id}, GO {go_position}.", "raspberry")
            return sku, False
        except requests.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else 0
            if status_code in (409, 412, 429) and attempt < max_retries - 1:
                time.sleep(0.4 * (attempt + 1))
                continue
            raise

    return sku, False


def post_available_stock_after_store(
    firebase: FirebaseClient,
    scan_id: str,
    sku: str,
    box_id: str,
    location_id: int,
    go_position: int,
    max_retries: int = 3,
) -> None:
    if not firebase.enabled or not scan_id or not sku:
        return

    for attempt in range(max_retries):
        transaction_id = firebase.begin_transaction()
        processed_raw = firebase.get_doc_raw(f"processedScans/{scan_id}", transaction=transaction_id)
        processed = firestore_to_plain(processed_raw.get("fields", {})) if processed_raw else {}

        if processed.get("availableStockPosted"):
            print(f"Scan {scan_id} already posted to availableStock; ignored.")
            return

        now = utc_now()
        writes = [
            make_merge_write(firebase, f"processedScans/{scan_id}", {
                "availableStockPosted": True,
                "status": "stored",
                "storedAt": timestamp(now),
                "updatedAt": timestamp(now),
            }),
            make_merge_increment_write(firebase, f"products/{sku}", {
                "lastStoredBoxId": box_id,
                "lastLocationId": location_id,
                "locationId": location_id,
                "location": str(location_id),
                "lastMovementGoPosition": go_position,
                "updatedAt": timestamp(now),
            }, {"availableStock": 1}),
        ]

        try:
            firebase.commit_writes(writes, transaction=transaction_id)
            log_activity(firebase, "INVENTORY_INCREMENTED", f"{sku} availableStock incremented after storage DONE.", "raspberry")
            return
        except requests.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else 0
            if status_code in (409, 412, 429) and attempt < max_retries - 1:
                time.sleep(0.4 * (attempt + 1))
                continue
            raise


# ================= SQLITE =================

def connect_db(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_column(cur: sqlite3.Cursor, table_name: str, column_name: str, column_definition: str) -> None:
    columns = [row["name"] for row in cur.execute(f"PRAGMA table_info({table_name})").fetchall()]
    if column_name not in columns:
        cur.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}")


def init_sqlite(db_path: str) -> None:
    conn = connect_db(db_path)
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 9),
            status TEXT,
            brand TEXT,
            model TEXT,
            color TEXT,
            size TEXT,
            box_id TEXT,
            updated_at TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS boxes (
            box_id TEXT PRIMARY KEY,
            scan_id TEXT,
            product_sku TEXT,
            brand TEXT,
            model TEXT,
            color TEXT,
            size TEXT,
            location_id INTEGER,
            status TEXT,
            inventory_counted INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS store_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scan_id TEXT,
            product_sku TEXT,
            box_id TEXT,
            location_id INTEGER,
            go_position INTEGER,
            status TEXT,
            available_stock_posted INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS pick_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_type TEXT,
            query_value TEXT,
            box_id TEXT,
            location_id INTEGER,
            go_position INTEGER,
            status TEXT,
            created_at TEXT,
            updated_at TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    ensure_column(cur, "boxes", "scan_id", "TEXT")
    ensure_column(cur, "boxes", "product_sku", "TEXT")
    ensure_column(cur, "boxes", "inventory_counted", "INTEGER DEFAULT 0")
    ensure_column(cur, "store_queue", "scan_id", "TEXT")
    ensure_column(cur, "store_queue", "product_sku", "TEXT")
    ensure_column(cur, "store_queue", "available_stock_posted", "INTEGER DEFAULT 0")

    for location_id in range(1, 10):
        cur.execute(
            """
            INSERT OR IGNORE INTO locations
              (id, status, brand, model, color, size, box_id, updated_at)
            VALUES (?, 'empty', '', '', '', '', '', ?)
            """,
            (location_id, utc_now()),
        )

    for key, value in DEFAULT_SETTINGS.items():
        cur.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))

    conn.commit()
    conn.close()


def sync_settings_from_firebase(db_path: str, firebase: FirebaseClient) -> None:
    settings = firebase.get_doc("settings/system") or {}
    conn = connect_db(db_path)
    cur = conn.cursor()
    for key in SYSTEM_SETTING_KEYS:
        value = settings.get(key, DEFAULT_SETTINGS.get(key, ""))
        cur.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value).lower() if isinstance(value, bool) else str(value)),
        )
    conn.commit()
    conn.close()


def get_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def reserve_location(conn: sqlite3.Connection, location_id: int, label: dict, box_id: str) -> None:
    cursor = conn.execute(
        """
        UPDATE locations
        SET status = 'reserved', brand = ?, model = ?, color = ?, size = ?, box_id = ?, updated_at = ?
        WHERE id = ? AND status = 'empty'
        """,
        (label["brand"], label["model"], label["color"], label["size"], box_id, utc_now(), location_id),
    )
    if cursor.rowcount == 0:
        raise RuntimeError(f"Location {location_id} is no longer empty.")


def choose_storage_location(conn: sqlite3.Connection, label: dict) -> Optional[int]:
    rows = conn.execute("SELECT * FROM locations WHERE status = 'empty' ORDER BY id").fetchall()
    if not rows:
        return None

    sorting_mode = get_setting(conn, "sortingMode", "brand")
    if sorting_mode == "nearest_empty":
        return rows[0]["id"]
    if sorting_mode == "most_requested":
        return rows[0]["id"]

    best_id = rows[0]["id"]
    best_score = -1
    for row in rows:
        score = 0
        for neighbor_id in NEIGHBORS[row["id"]]:
            neighbor = conn.execute("SELECT * FROM locations WHERE id = ?", (neighbor_id,)).fetchone()
            if not neighbor or neighbor["status"] != "full":
                continue
            score += score_neighbor(label, neighbor, sorting_mode)
        if score > best_score:
            best_id = row["id"]
            best_score = score
    return best_id


def score_neighbor(label: dict, location: sqlite3.Row, sorting_mode: str) -> int:
    def same(field: str) -> bool:
        return str(label.get(field, "")).strip().upper() == str(location[field] or "").strip().upper()

    if sorting_mode == "brand":
        return 10 if same("brand") else 0
    if sorting_mode == "model":
        return 10 if same("model") else 0
    if sorting_mode == "size":
        return 10 if same("size") else 0
    if sorting_mode == "color":
        return 10 if same("color") else 0
    if sorting_mode == "brand_size":
        return (10 if same("brand") else 0) + (7 if same("size") else 0)
    if sorting_mode == "model_size":
        return (10 if same("model") else 0) + (7 if same("size") else 0)
    if sorting_mode == "color_size":
        return (10 if same("color") else 0) + (7 if same("size") else 0)
    if sorting_mode == "custom":
        priority = ["brand", "model", "color", "size"]
        return sum((len(priority) - index) * 4 for index, field in enumerate(priority) if same(field))
    return 0


def create_store_task(db_path: str, firebase: FirebaseClient, label: dict) -> Optional[str]:
    conn = connect_db(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        location_id = choose_storage_location(conn, label)
        if not location_id:
            conn.rollback()
            log_activity(firebase, "store_queue_error", "No empty storage location available.", "raspberry")
            return None

        now = utc_now()
        scan_id = f"SCAN-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6].upper()}"
        box_id = f"BOX-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6].upper()}"
        product_sku = build_normalized_sku(label)
        go_position = location_to_go_in(location_id)

        conn.execute(
            """
            INSERT INTO boxes
              (box_id, scan_id, product_sku, brand, model, color, size, location_id, status, inventory_counted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
            """,
            (box_id, scan_id, product_sku, label["brand"], label["model"], label["color"], label["size"], location_id, now, now),
        )
        reserve_location(conn, location_id, label, box_id)
        conn.execute(
            """
            INSERT INTO store_queue (scan_id, product_sku, box_id, location_id, go_position, status, available_stock_posted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'waiting', 0, ?, ?)
            """,
            (scan_id, product_sku, box_id, location_id, go_position, now, now),
        )
        queue_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    try:
        product_sku, already_processed = sync_product_from_label(
            firebase,
            label,
            scan_id,
            box_id,
            location_id,
            go_position,
        )
        if not already_processed:
            conn = connect_db(db_path)
            conn.execute("UPDATE boxes SET product_sku = ?, inventory_counted = 1, updated_at = ? WHERE box_id = ?", (product_sku, utc_now(), box_id))
            conn.execute("UPDATE store_queue SET product_sku = ?, updated_at = ? WHERE id = ?", (product_sku, utc_now(), queue_id))
            conn.commit()
            conn.close()
    except requests.RequestException as exc:
        print("Product inventory sync failed:", exc)
        log_activity(firebase, "INVENTORY_SYNC_ERROR", str(exc), "raspberry")

    scan_data = {
        "scanId": scan_id,
        "boxId": box_id,
        "normalizedSku": product_sku,
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "selectedLocation": location_id,
        "goPosition": go_position,
        "status": "queued",
        "createdAt": timestamp(now),
    }
    firebase.add_doc("scans", scan_data)
    firebase.set_doc(f"locations/{location_id}", {
        "status": "reserved",
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "boxId": box_id,
        "updatedAt": timestamp(now),
    })
    firebase.add_doc("storeQueue", {
        "queueId": queue_id,
        "scanId": scan_id,
        "normalizedSku": product_sku,
        "boxId": box_id,
        "locationId": location_id,
        "goPosition": go_position,
        "status": "waiting",
        "createdAt": timestamp(now),
        "updatedAt": timestamp(now),
    })
    log_activity(firebase, "scan_queued", f"{box_id} queued for location {location_id} with GO {go_position}.", "raspberry")
    return box_id


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


# ================= QUEUES =================

class QueueWorker(threading.Thread):
    def __init__(self, db_path: str, esp_base_url: str, firebase: FirebaseClient, poll_commands: bool):
        super().__init__(daemon=True)
        self.db_path = db_path
        self.esp_base_url = esp_base_url.rstrip("/")
        self.firebase = firebase
        self.poll_commands = poll_commands
        self.stop_event = threading.Event()

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                if self.process_store_task():
                    continue
                if self.process_pick_task():
                    continue
                if self.poll_commands and self.process_manual_command():
                    continue
            except Exception as exc:
                print("Queue worker error:", exc)
                log_activity(self.firebase, "queue_worker_error", str(exc), "raspberry")
            time.sleep(1.0)

    def call_esp_go(self, position: int, source: str, queue_id: str | int) -> dict:
        response = requests.get(
            f"{self.esp_base_url}/go",
            params={"position": position, "source": source, "queueId": queue_id},
            timeout=140,
        )
        response.raise_for_status()
        return response.json()

    def process_store_task(self) -> bool:
        conn = connect_db(self.db_path)
        task = conn.execute("SELECT * FROM store_queue WHERE status = 'waiting' ORDER BY id LIMIT 1").fetchone()
        if not task:
            conn.close()
            return False

        now = utc_now()
        conn.execute("UPDATE store_queue SET status = 'running', updated_at = ? WHERE id = ?", (now, task["id"]))
        conn.commit()
        conn.close()

        try:
            result = self.call_esp_go(task["go_position"], "raspberry", f"store-{task['id']}")
            ok = bool(result.get("ok"))
        except Exception as exc:
            result = {"ok": False, "error": str(exc)}
            ok = False

        conn = connect_db(self.db_path)
        now = utc_now()
        box = conn.execute("SELECT * FROM boxes WHERE box_id = ?", (task["box_id"],)).fetchone()
        if ok:
            conn.execute("UPDATE store_queue SET status = 'done', updated_at = ? WHERE id = ?", (now, task["id"]))
            conn.execute("UPDATE boxes SET status = 'stored', updated_at = ? WHERE box_id = ?", (now, task["box_id"]))
            conn.execute("UPDATE locations SET status = 'full', updated_at = ? WHERE id = ?", (now, task["location_id"]))
            status = "done"
            log_activity(self.firebase, "store_done", f"{task['box_id']} stored at location {task['location_id']}.", "raspberry")
            try:
                post_available_stock_after_store(
                    self.firebase,
                    task["scan_id"],
                    task["product_sku"],
                    task["box_id"],
                    task["location_id"],
                    task["go_position"],
                )
                conn.execute("UPDATE store_queue SET available_stock_posted = 1, updated_at = ? WHERE id = ?", (now, task["id"]))
            except requests.RequestException as exc:
                print("Available stock update failed:", exc)
                log_activity(self.firebase, "INVENTORY_AVAILABLE_STOCK_ERROR", str(exc), "raspberry")
        else:
            conn.execute("UPDATE store_queue SET status = 'error', updated_at = ? WHERE id = ?", (now, task["id"]))
            conn.execute("UPDATE boxes SET status = 'error', updated_at = ? WHERE box_id = ?", (now, task["box_id"]))
            status = "error"
            log_activity(self.firebase, "store_error", result.get("error", "Store task failed."), "raspberry")
        conn.commit()
        conn.close()

        if box:
            self.firebase.set_doc(f"locations/{task['location_id']}", {
                "status": "full" if ok else "reserved",
                "brand": box["brand"],
                "model": box["model"],
                "color": box["color"],
                "size": box["size"],
                "boxId": task["box_id"],
                "updatedAt": timestamp(now),
            })
            self.firebase.set_doc(f"inventory/boxes/{task['box_id']}", {
                "boxId": task["box_id"],
                "scanId": task["scan_id"],
                "normalizedSku": task["product_sku"],
                "brand": box["brand"],
                "model": box["model"],
                "color": box["color"],
                "size": box["size"],
                "locationId": task["location_id"],
                "status": "stored" if ok else "error",
                "updatedAt": timestamp(now),
            })
        self.firebase.add_doc("storeQueue", {
            "queueId": task["id"],
            "scanId": task["scan_id"],
            "normalizedSku": task["product_sku"],
            "boxId": task["box_id"],
            "locationId": task["location_id"],
            "goPosition": task["go_position"],
            "status": status,
            "updatedAt": timestamp(now),
        })
        return True

    def process_pick_task(self) -> bool:
        conn = connect_db(self.db_path)
        task = conn.execute("SELECT * FROM pick_queue WHERE status = 'waiting' ORDER BY id LIMIT 1").fetchone()
        if not task:
            conn.close()
            return False

        now = utc_now()
        conn.execute("UPDATE pick_queue SET status = 'running', updated_at = ? WHERE id = ?", (now, task["id"]))
        conn.commit()
        conn.close()

        try:
            result = self.call_esp_go(task["go_position"], "raspberry-pick", f"pick-{task['id']}")
            ok = bool(result.get("ok"))
        except Exception as exc:
            result = {"ok": False, "error": str(exc)}
            ok = False

        conn = connect_db(self.db_path)
        now = utc_now()
        if ok:
            conn.execute("UPDATE pick_queue SET status = 'done', updated_at = ? WHERE id = ?", (now, task["id"]))
            conn.execute("UPDATE boxes SET status = 'picked', updated_at = ? WHERE box_id = ?", (now, task["box_id"]))
            conn.execute(
                "UPDATE locations SET status = 'empty', brand = '', model = '', color = '', size = '', box_id = '', updated_at = ? WHERE id = ?",
                (now, task["location_id"]),
            )
            status = "done"
            log_activity(self.firebase, "pick_done", f"{task['box_id']} picked from location {task['location_id']}.", "raspberry")
        else:
            conn.execute("UPDATE pick_queue SET status = 'error', updated_at = ? WHERE id = ?", (now, task["id"]))
            conn.execute("UPDATE boxes SET status = 'error', updated_at = ? WHERE box_id = ?", (now, task["box_id"]))
            status = "error"
            log_activity(self.firebase, "pick_error", result.get("error", "Pick task failed."), "raspberry")
        conn.commit()
        conn.close()

        self.firebase.set_doc(f"locations/{task['location_id']}", {
            "status": "empty" if ok else "full",
            "brand": "",
            "model": "",
            "color": "",
            "size": "",
            "boxId": "",
            "updatedAt": timestamp(now),
        })
        self.firebase.set_doc(f"inventory/boxes/{task['box_id']}", {
            "boxId": task["box_id"],
            "locationId": task["location_id"],
            "status": "picked" if ok else "error",
            "updatedAt": timestamp(now),
        })
        self.firebase.add_doc("pickQueue", {
            "queueId": task["id"],
            "requestType": task["request_type"],
            "queryValue": task["query_value"],
            "boxId": task["box_id"],
            "locationId": task["location_id"],
            "goPosition": task["go_position"],
            "status": status,
            "updatedAt": timestamp(now),
        })
        return True

    def process_manual_command(self) -> bool:
        try:
            commands = self.firebase.query("commands", {"status": "pending", "type": "GO"}, limit_count=1)
        except requests.RequestException as exc:
            print("Manual command poll failed:", exc)
            return False
        if not commands:
            return False

        command = commands[0]
        position = int(command.get("position") or 0)
        if position < 1 or position > 18:
            self.firebase.set_doc(f"commands/{command['_id']}", {
                "status": "error",
                "errorMessage": f"Invalid position {position}",
                "updatedAt": timestamp(),
            })
            return True

        self.firebase.set_doc(f"commands/{command['_id']}", {
            "status": "sent_to_arduino",
            "sentAt": timestamp(),
        })
        try:
            result = self.call_esp_go(position, "website", command["_id"])
            ok = bool(result.get("ok"))
        except Exception as exc:
            result = {"ok": False, "error": str(exc)}
            ok = False

        self.firebase.set_doc(f"commands/{command['_id']}", {
            "status": "done" if ok else "error",
            "errorMessage": "" if ok else result.get("error", "Manual command failed."),
            "doneAt": timestamp() if ok else timestamp(),
            "updatedAt": timestamp(),
        })
        return True


class PickRequestPoller(threading.Thread):
    def __init__(self, db_path: str, firebase: FirebaseClient):
        super().__init__(daemon=True)
        self.db_path = db_path
        self.firebase = firebase
        self.stop_event = threading.Event()
        self.seen_request_ids: set[str] = set()

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.poll_once()
            except Exception as exc:
                print("Pick request poll error:", exc)
            time.sleep(5)

    def poll_once(self) -> None:
        requests_waiting = self.firebase.query("pickRequests", {"status": "waiting"}, limit_count=10)
        for request in requests_waiting:
            if request["_id"] in self.seen_request_ids:
                continue
            task_count = enqueue_pick_request(self.db_path, request)
            self.firebase.set_doc(f"pickRequests/{request['_id']}", {
                "status": "queued" if task_count else "error",
                "queuedCount": task_count,
                "updatedAt": timestamp(),
            })
            self.seen_request_ids.add(request["_id"])


def enqueue_pick_request(db_path: str, request: dict) -> int:
    request_type = (request.get("requestType") or request.get("request_type") or "single").strip()
    query_value = str(request.get("queryValue") or request.get("query_value") or "").strip()
    if not query_value:
        return 0

    conn = connect_db(db_path)
    if request_type in ("single", "box_id"):
        rows = conn.execute(
            "SELECT * FROM boxes WHERE box_id = ? AND status = 'stored'",
            (query_value,),
        ).fetchall()
    elif request_type in ("size", "model", "brand"):
        rows = conn.execute(
            f"SELECT * FROM boxes WHERE {request_type} = ? AND status = 'stored' ORDER BY created_at",
            (query_value,),
        ).fetchall()
    else:
        rows = []

    now = utc_now()
    count = 0
    for box in rows:
        location_id = int(box["location_id"])
        conn.execute(
            """
            INSERT INTO pick_queue
              (request_type, query_value, box_id, location_id, go_position, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)
            """,
            (request_type, query_value, box["box_id"], location_id, location_to_go_out(location_id), now, now),
        )
        count += 1
    conn.commit()
    conn.close()
    return count


# ================= STABILITY =================

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
        return {key: stable_fields[key] for key in ("brand", "model", "color", "size")}
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
    h, _ = roi.shape[:2]
    header = roi[0:int(h * 0.40), :]
    gray_header = cv2.cvtColor(header, cv2.COLOR_BGR2GRAY)
    _, gray_header = cv2.threshold(gray_header, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    best_brand = "--"
    best_score = -1.0
    for brand, template in templates.items():
        template_resized = cv2.resize(template, (gray_header.shape[1], gray_header.shape[0]), interpolation=cv2.INTER_AREA)
        score = cv2.matchTemplate(gray_header, template_resized, cv2.TM_CCOEFF_NORMED)[0][0]
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


def set_camera_properties(_cap):
    pass


def open_camera(camera_index):
    cap = cv2.VideoCapture(camera_index, cv2.CAP_V4L2)
    if not cap.isOpened():
        print("CAP_V4L2 failed, trying normal VideoCapture...")
        cap = cv2.VideoCapture(camera_index)
    return cap


def preprocess_fast(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return cv2.GaussianBlur(gray, (3, 3), 0)


def extract_roi(frame):
    h, w = frame.shape[:2]
    roi_w = int(w * 0.75)
    roi_h = int(h * 0.85)
    x = int(w * 0.125)
    y = int(h * 0.075)
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
            fields[key] = clean_value(match.group(1).split("\n")[0])
    return fields


def run_ocr(image, debug_name, psm):
    config = f"--oem 3 --psm {psm}"
    data = pytesseract.image_to_data(image, config=config, output_type=pytesseract.Output.DICT)
    text = pytesseract.image_to_string(image, config=config)
    clean_text = normalize_ocr_text(text)
    return OCRResult(text=clean_text, confidence=mean_confidence(data), fields=parse_fields(clean_text), debug_name=f"{debug_name}_psm{psm}")


def best_ocr_result(roi, templates):
    gray = preprocess_fast(roi)
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    enlarged = cv2.resize(otsu, None, fx=UPSCALE_FACTOR, fy=UPSCALE_FACTOR, interpolation=cv2.INTER_CUBIC)
    best_result = run_ocr(enlarged, "otsu", 6)
    logo_score = 0.0
    brand_text = brand_from_ocr_text(best_result.text)
    if brand_text != "--":
        best_result.fields["brand"] = brand_text
    else:
        brand_logo, logo_score = detect_brand_by_logo(roi, templates)
        best_result.fields["brand"] = brand_logo if brand_logo != "--" else brand_from_model_text(best_result.text)
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
        cv2.putText(output, line, (15, 25 + index * 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2, cv2.LINE_AA)
    return output


def parse_args():
    parser = argparse.ArgumentParser(description="MakhzanXpert Raspberry Pi OCR, SQLite, and queue controller.")
    parser.add_argument("--camera", type=int, default=DEFAULT_CAMERA_INDEX)
    parser.add_argument("--db", default=DEFAULT_DB_PATH)
    parser.add_argument("--esp-url", default=DEFAULT_ESP32_BASE_URL)
    parser.add_argument("--no-firebase", action="store_true")
    parser.add_argument("--no-command-poll", action="store_true")
    return parser.parse_args()


# ================= MAIN =================

def main():
    args = parse_args()
    firebase = FirebaseClient(FIREBASE_API_KEY, enabled=not args.no_firebase)

    init_sqlite(args.db)
    try:
        sync_settings_from_firebase(args.db, firebase)
    except requests.RequestException as exc:
        print("Firebase settings sync failed, using local defaults:", exc)

    configure_tesseract()
    templates = load_logo_templates()

    worker = QueueWorker(args.db, args.esp_url, firebase, poll_commands=not args.no_command_poll)
    worker.start()
    pick_poller = PickRequestPoller(args.db, firebase)
    pick_poller.start()

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

    print("ESP32 GO URL:", f"{args.esp_url.rstrip()}/go")
    print("SQLite DB:", args.db)
    print("Press Q to quit.")
    print("Press R to reset OCR stability.")
    print("Camera index:", args.camera)

    try:
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
                    confirmed_label = update_field_stability(last_result.fields)
                    print("\n========== FIELDS ==========")
                    print(last_result.fields)
                    print("Counts:", field_count)
                    print("Stable:", stable_fields)

                    if confirmed_label and should_accept_label(confirmed_label):
                        print("FINAL CONFIRMED LABEL:", confirmed_label)
                        try:
                            box_id = create_store_task(args.db, firebase, confirmed_label)
                            last_status = f"queued {box_id}" if box_id else "no empty location"
                        except Exception as exc:
                            print("Queue creation failed:", exc)
                            last_status = "queue error"
                        reset_stability()
                    elif confirmed_label:
                        last_status = "duplicate label suppressed"
                    else:
                        last_status = "confirming fields"
                else:
                    last_status = "frame too blurry"

            frame_counter += 1
            current_tick = cv2.getTickCount()
            fps = tick_freq / max(current_tick - last_tick, 1)
            last_tick = current_tick

            output = draw_overlay(frame, roi_rect, last_result, fps, sharpness, last_status, last_logo_score)
            cv2.imshow("MakhzanXpert OCR Queue Controller", output)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            if key == ord("r"):
                print("RESET FOR NEW LABEL")
                reset_stability()
                last_status = "reset"
    finally:
        worker.stop_event.set()
        pick_poller.stop_event.set()
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
