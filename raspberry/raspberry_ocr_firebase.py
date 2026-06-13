import argparse
import json
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

DEFAULT_ESP32_BASE_URL = "http://172.23.250.165"
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
CAMERA_ALIGN_DELAY_MS = 1200
DROP_TO_LIFTER_DELAY_MS = 3000
AUTOMATION_STATUS_PATH = "automation/status"
VALID_SORTING_STRATEGIES = {
    "brand",
    "size",
    "color",
    "model",
    "brand_size",
    "color_size",
    "model_size",
}

STATE_WAIT_FOR_AUTOMATION = "WAIT_FOR_AUTOMATION"
STATE_WAIT_BOX_AT_CAMERA = "WAIT_BOX_AT_CAMERA"
STATE_CAMERA_ALIGNING = "CAMERA_ALIGNING"
STATE_CAMERA_READING = "CAMERA_READING"
STATE_MOVE_BOX_TO_LIFTER_IR = "MOVE_BOX_TO_LIFTER_IR"
STATE_CHECK_LIFTER_READY = "CHECK_LIFTER_READY"
STATE_DROP_BOX_TO_LIFTER = "DROP_BOX_TO_LIFTER"
STATE_LIFTER_DELIVERY = "LIFTER_DELIVERY"
STATE_PROCESS_ORDERS = "PROCESS_ORDERS"
STATE_RETURN_TO_START = "RETURN_TO_START"
STATE_STOPPED = "STOPPED"
STATE_ERROR = "ERROR"

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
    "sortingMode": "",
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

INTERNAL_PRODUCT_CATALOG = [
    {"brand": "NIKE", "model": "AIR FORCE", "color": "WHITE", "size": "40", "price": 120.0},
    {"brand": "NIKE", "model": "AIR FORCE", "color": "WHITE", "size": "42", "price": 120.0},
    {"brand": "NIKE", "model": "AIR MAX", "color": "BLACK", "size": "42", "price": 150.0},
    {"brand": "NIKE", "model": "DUNK LOW", "color": "GREEN", "size": "40", "price": 115.0},
    {"brand": "ADIDAS", "model": "SAMBA", "color": "WHITE", "size": "38", "price": 100.0},
    {"brand": "ADIDAS", "model": "SAMBA", "color": "WHITE", "size": "40", "price": 100.0},
    {"brand": "ADIDAS", "model": "GAZELLE", "color": "GREEN", "size": "41", "price": 105.0},
    {"brand": "ADIDAS", "model": "CAMPUS", "color": "BLACK", "size": "39", "price": 105.0},
    {"brand": "PUMA", "model": "SUEDE CLASSIC", "color": "RED", "size": "38", "price": 90.0},
    {"brand": "PUMA", "model": "SUEDE CLASSIC", "color": "RED", "size": "40", "price": 90.0},
    {"brand": "PUMA", "model": "RS", "color": "BLACK", "size": "41", "price": 125.0},
    {"brand": "PUMA", "model": "CALI", "color": "WHITE", "size": "39", "price": 95.0},
    {"brand": "SKECHERS", "model": "GO WALK", "color": "NAVY", "size": "39", "price": 80.0},
    {"brand": "SKECHERS", "model": "GO WALK", "color": "NAVY", "size": "41", "price": 80.0},
    {"brand": "SKECHERS", "model": "ARCH FIT", "color": "NAVY", "size": "42", "price": 90.0},
    {"brand": "SKECHERS", "model": "UNO", "color": "RED", "size": "43", "price": 85.0},
]


@dataclass
class OCRResult:
    text: str
    confidence: float
    fields: Dict[str, str]
    debug_name: str


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def get_in_position(location_id: int) -> int:
    return location_id * 2 - 1


def get_out_position(location_id: int) -> int:
    return location_id * 2


def location_to_go_in(location_id: int) -> int:
    return get_in_position(location_id)


def location_to_go_out(location_id: int) -> int:
    return get_out_position(location_id)


# ================= FIREBASE REST =================

class FirebaseClient:
    def __init__(self, api_key: str, enabled: bool = True):
        self.api_key = api_key
        self.enabled = enabled and bool(api_key)

    def _url(self, path: str) -> str:
        return f"{FIRESTORE_BASE_URL}/{path.lstrip('/')}?key={self.api_key}"

    def _documents_url(self) -> str:
        return f"{FIRESTORE_BASE_URL}:runQuery?key={self.api_key}"

    def _full_doc_name(self, path: str) -> str:
        return f"projects/{FIREBASE_PROJECT_ID}/databases/(default)/documents/{path.lstrip('/')}"

    def _path_from_name(self, name: str) -> str:
        marker = "/documents/"
        if marker in name:
            return name.split(marker, 1)[1]
        return name.lstrip("/")

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
        fields = plain_to_firestore(data)
        mask = ""
        if merge:
            mask = "".join(f"&updateMask.fieldPaths={key}" for key in data.keys())
        response = requests.patch(self._url(path) + mask, json={"fields": fields}, timeout=15)
        response.raise_for_status()

    def increment_doc_fields(self, path: str, data: dict, increments: dict[str, int]) -> None:
        if not self.enabled:
            return
        current = self.get_doc(path) or {}
        updated = dict(data)
        for field, amount in increments.items():
            updated[field] = int(current.get(field) or 0) + amount
        self.set_doc(path, updated, merge=True)

    def delete_doc(self, path_or_name: str) -> None:
        if not self.enabled:
            return
        response = requests.delete(self._url(self._path_from_name(path_or_name)), timeout=15)
        if response.status_code == 404:
            return
        response.raise_for_status()

    def list_docs(self, collection_path: str, page_size: int = 100) -> list[dict]:
        if not self.enabled:
            return []

        docs = []
        page_token = ""
        while True:
            params = {"pageSize": page_size}
            if page_token:
                params["pageToken"] = page_token
            response = requests.get(self._url(collection_path), params=params, timeout=20)
            if response.status_code == 404:
                return docs
            response.raise_for_status()
            payload = response.json()
            docs.extend(payload.get("documents", []))
            page_token = payload.get("nextPageToken", "")
            if not page_token:
                return docs

    def add_doc(self, collection_name: str, data: dict) -> Optional[str]:
        if not self.enabled:
            return None
        response = requests.post(self._url(collection_name), json={"fields": plain_to_firestore(data)}, timeout=15)
        response.raise_for_status()
        return response.json().get("name")

    def query(self, collection_name: str, filters: dict, order_field: Optional[str] = None, limit_count: int = 20) -> list[dict]:
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

        structured_query = {
            "from": [{"collectionId": collection_name}],
            "limit": limit_count,
        }
        if query_filters:
            structured_query["where"] = {
                "compositeFilter": {
                    "op": "AND",
                    "filters": query_filters,
                }
            } if len(query_filters) > 1 else query_filters[0]
        if order_field:
            structured_query["orderBy"] = [{"field": {"fieldPath": order_field}, "direction": "ASCENDING"}]

        body = {
            "structuredQuery": {
                **structured_query,
            }
        }

        print("RUNQUERY_BODY", json.dumps(body))
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


def timestamp(value: Optional[str] = None) -> dict:
    return {"__timestamp__": True, "value": value or utc_now()}


def print_firestore_error(prefix: str, exc: Exception) -> None:
    print(prefix)
    print(str(exc))
    response = getattr(exc, "response", None)
    if response is not None:
        print(f"{prefix}_STATUS = {response.status_code}")
        print(f"{prefix}_RESPONSE = {response.text}")


def esp_url(esp_base_url: str, path: str) -> str:
    return f"{esp_base_url.rstrip('/')}/{path.lstrip('/')}"


def esp_get_json(esp_base_url: str, path: str, params: Optional[dict] = None, timeout: int = 30) -> dict:
    response = requests.get(esp_url(esp_base_url, path), params=params or {}, timeout=timeout)
    response.raise_for_status()
    data = response.json()
    if data.get("ok") is False:
        raise RuntimeError(data.get("error") or f"ESP request failed: {path}")
    return data


def get_esp_status(esp_base_url: str) -> dict:
    data = esp_get_json(esp_base_url, "/status", timeout=10)
    return data.get("status") or data


def bool_status(status: dict, key: str) -> bool:
    return bool(status.get(key))


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
    data = {"updatedAt": timestamp(), **updates}
    firebase.set_doc(AUTOMATION_STATUS_PATH, data, merge=True)


def ensure_automation_status(firebase: FirebaseClient) -> None:
    if not firebase.enabled:
        return
    if firebase.get_doc(AUTOMATION_STATUS_PATH):
        return
    firebase.set_doc(AUTOMATION_STATUS_PATH, automation_status_defaults(), merge=False)


def automation_ready(firebase: FirebaseClient) -> tuple[bool, dict, str]:
    status = get_automation_status(firebase)
    strategy = status.get("sortingStrategy") or status.get("sortingMode")
    if not valid_sorting_strategy(strategy):
        return False, status, "Waiting for sorting strategy"
    if not bool(status.get("automationStarted")):
        return False, status, "Waiting for Start Automation"
    return True, status, ""


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
    model_aliases = {
        "AIR FORCE 1": "AIR FORCE",
        "AIRFORCE": "AIR FORCE",
        "DUNK": "DUNK LOW",
        "RS-X": "RS",
        "RS X": "RS",
        "SUEDE": "SUEDE CLASSIC",
    }
    normalized["model"] = model_aliases.get(normalized["model"], normalized["model"])
    if "price" in label:
        normalized["price"] = label["price"]
    return normalized


def product_key(label: dict) -> str:
    normalized = normalize_label(label)
    return "|".join(normalized.get(key, "") for key in ("brand", "model", "color", "size"))


def build_normalized_sku(label: dict) -> str:
    label = normalize_label(label)
    return "_".join(
        normalize_sku_part(label.get(key, ""))
        for key in ("brand", "model", "color", "size")
    )


def normalize_slug_part(value: str) -> str:
    normalized = str(value or "").strip().lower()
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized)
    normalized = re.sub(r"-+", "-", normalized)
    return normalized.strip("-") or "unknown"


def build_product_slug(label: dict) -> str:
    label = normalize_label(label)
    return "-".join(
        normalize_slug_part(label.get(key, ""))
        for key in ("brand", "model", "color", "size")
    )


def build_product_name(label: dict) -> str:
    return product_key(label)


def catalog_product_data(label: dict) -> dict:
    label = normalize_label(label)
    now = utc_now()
    sku = build_normalized_sku(label)
    key = product_key(label)
    return {
        "id": sku,
        "normalizedSku": sku,
        "productKey": key,
        "slug": build_product_slug(label),
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "name": build_product_name(label),
        "category": "Shoes",
        "status": "active",
        "needsDetails": False,
        "isAvailable": True,
        "price": float(label.get("price", 99.0)),
        "quantity": 0,
        "stock": 0,
        "inventoryCount": 0,
        "availableStock": 0,
        "images": [],
        "imageUrl": "",
        "description": "",
        "createdAt": timestamp(now),
        "updatedAt": timestamp(now),
    }


def ensure_internal_product_catalog(firebase: FirebaseClient, log_ready: bool = True) -> None:
    if not firebase.enabled:
        return

    created_count = 0
    for product in INTERNAL_PRODUCT_CATALOG:
        sku = build_normalized_sku(product)
        path = f"products/{sku}"
        existing = firebase.get_doc(path)
        if existing:
            continue
        firebase.set_doc(path, catalog_product_data(product), merge=False)
        created_count += 1

    print(f"PRODUCT_CATALOG_READY count={len(INTERNAL_PRODUCT_CATALOG)} created={created_count}")
    if log_ready:
        log_activity(firebase, "PRODUCT_CATALOG_READY", f"{len(INTERNAL_PRODUCT_CATALOG)} predefined products ready.", "raspberry")


def delete_all_collection_docs(firebase: FirebaseClient, collection_path: str) -> int:
    deleted = 0
    while True:
        docs = firebase.list_docs(collection_path)
        if not docs:
            return deleted
        for document in docs:
            firebase.delete_doc(document["name"])
            deleted += 1


def recreate_empty_locations(firebase: FirebaseClient) -> None:
    now = utc_now()
    for location_id in range(1, 10):
        firebase.set_doc(f"locations/{location_id}", {
            "id": location_id,
            "status": "empty",
            "normalizedSku": "",
            "productId": "",
            "productKey": "",
            "boxId": "",
            "brand": "",
            "model": "",
            "color": "",
            "size": "",
            "updatedAt": timestamp(now),
        }, merge=False)


def cleanup_firebase_runtime_data(firebase: FirebaseClient) -> None:
    if not firebase.enabled:
        print("CLEANUP_FAILED Firebase client is disabled.")
        return

    collections_to_clear = [
        "locations",
        "scans",
        "storeQueue",
        "pickQueue",
        "pickRequests",
        "scanQueue",
        "processedScans",
        "commands",
        "activityLog",
        "systemActivity",
        "products",
        "boxes",
    ]

    print("CLEANUP_START")
    for collection_path in collections_to_clear:
        deleted = delete_all_collection_docs(firebase, collection_path)
        print(f"CLEANUP_DELETED {collection_path} = {deleted}")

    recreate_empty_locations(firebase)
    ensure_internal_product_catalog(firebase, log_ready=False)
    firebase.set_doc(AUTOMATION_STATUS_PATH, automation_status_defaults(), merge=False)
    log_activity(firebase, "CLEANUP_DONE", "Firebase runtime data cleaned; locations and products rebuilt.", "raspberry")

    verification = {
        "locations": len(firebase.list_docs("locations")),
        "products": len(firebase.list_docs("products")),
        "scans": len(firebase.list_docs("scans")),
        "storeQueue": len(firebase.list_docs("storeQueue")),
        "pickQueue": len(firebase.list_docs("pickQueue")),
        "pickRequests": len(firebase.list_docs("pickRequests")),
        "scanQueue": len(firebase.list_docs("scanQueue")),
        "processedScans": len(firebase.list_docs("processedScans")),
        "boxes": len(firebase.list_docs("boxes")),
        "activityLog": len(firebase.list_docs("activityLog")),
        "systemActivity": len(firebase.list_docs("systemActivity")),
    }
    product_ids = [document["name"].split("/")[-1] for document in firebase.list_docs("products")]
    expected_product_ids = {build_normalized_sku(product) for product in INTERNAL_PRODUCT_CATALOG}
    random_product_ids = sorted(set(product_ids) - expected_product_ids)
    duplicate_product_ids = len(product_ids) != len(set(product_ids))

    print("CLEANUP_VERIFY")
    for key, count in verification.items():
        print(f"{key} = {count}")
    print(f"duplicateProducts = {str(duplicate_product_ids).lower()}")
    print(f"randomProductIds = {random_product_ids}")

    if (
        verification["locations"] == 9
        and verification["products"] == len(INTERNAL_PRODUCT_CATALOG)
        and verification["scans"] == 0
        and verification["storeQueue"] == 0
        and verification["pickQueue"] == 0
        and verification["pickRequests"] == 0
        and verification["scanQueue"] == 0
        and verification["processedScans"] == 0
        and verification["boxes"] == 0
        and verification["activityLog"] <= 1
        and verification["systemActivity"] <= 1
        and not duplicate_product_ids
        and not random_product_ids
    ):
        print("CLEANUP_OK")
    else:
        print("CLEANUP_VERIFY_FAILED")


def product_is_draft(product: Optional[dict]) -> bool:
    if not product:
        return True
    return bool(product.get("needsDetails")) or product.get("status") in ("draft", "pending_details")


def sync_product_from_label(
    firebase: FirebaseClient,
    label: dict,
    scan_id: str,
    box_id: str,
    location_id: int,
    in_position: int,
    out_position: int,
    max_retries: int = 3,
) -> tuple[str, str]:
    label = normalize_label(label)
    sku = build_normalized_sku(label)
    slug = build_product_slug(label)
    key = product_key(label)
    product_path = f"products/{sku}"

    print("BEFORE_SYNC_PRODUCT")
    print(f"NORMALIZED_SKU = {sku}")
    print(f"PRODUCT_PATH = {product_path}")
    print(f"FIREBASE_ENABLED = {firebase.enabled}")
    print(f"FIREBASE_PROJECT_ID = {FIREBASE_PROJECT_ID}")
    print(f"FIREBASE_API_KEY_SET = {bool(FIREBASE_API_KEY)}")

    if not firebase.enabled:
        print("PRODUCT_SYNC_FAILED Firebase client is disabled.")
        return sku, "error"

    for attempt in range(max_retries):
        try:
            processed = firebase.get_doc(f"processedScans/{scan_id}")
            if processed:
                print("DUPLICATE_SCAN_IGNORED")
                print(f"SCAN_ID = {scan_id}")
                log_activity(firebase, "DUPLICATE_SCAN_IGNORED", f"{scan_id} already processed; no queue or inventory increment.", "raspberry")
                return sku, "duplicate_scan"

            product = firebase.get_doc(product_path)
            product_exists = bool(product)
            print(f"PRODUCT_EXISTS = {'true' if product_exists else 'false'}")
            now = utc_now()

            processed_data = {
                "scanId": scan_id,
                "boxId": box_id,
                "normalizedSku": sku,
                "productKey": key,
                "slug": slug,
                "brand": label["brand"],
                "model": label["model"],
                "color": label["color"],
                "size": label["size"],
                "locationId": location_id,
                "inPosition": in_position,
                "outPosition": out_position,
                "inventoryApplied": True,
                "availableStockPosted": False,
                "status": "label_confirmed",
                "createdAt": timestamp(now),
                "updatedAt": timestamp(now),
            }

            if not product_exists:
                processed_data["inventoryApplied"] = False
                processed_data["status"] = "unknown_label_rejected"
                firebase.set_doc(f"processedScans/{scan_id}", processed_data, merge=False)
                print("UNKNOWN_LABEL_REJECTED")
                log_activity(firebase, "UNKNOWN_LABEL_REJECTED", f"{sku} is not in predefined products; no queue, location, or inventory change.", "raspberry")
                return sku, "unknown"

            product_update = {
                "id": product.get("id") or sku,
                "normalizedSku": sku,
                "productKey": product.get("productKey") or key,
                "slug": product.get("slug") or slug,
                "brand": product.get("brand") or label["brand"],
                "model": product.get("model") or label["model"],
                "color": product.get("color") or label["color"],
                "size": product.get("size") or label["size"],
                "name": product.get("name") or build_product_name(label),
                "status": product.get("status") or "active",
                "needsDetails": bool(product.get("needsDetails", False)),
                "isAvailable": bool(product.get("isAvailable", True)),
                "lastLabelScanId": scan_id,
                "lastBoxId": box_id,
                "lastAssignedLocationId": location_id,
                "lastInPosition": in_position,
                "lastOutPosition": out_position,
                "updatedAt": timestamp(now),
            }

            firebase.increment_doc_fields(product_path, product_update, {"quantity": 1, "stock": 1, "inventoryCount": 1})
            firebase.set_doc(f"processedScans/{scan_id}", processed_data, merge=False)
            print("PRODUCT_FOUND")
            print("INVENTORY_INCREMENTED")
            log_activity(firebase, "scan_confirmed", f"{scan_id} confirmed as {key}.", "raspberry")
            log_activity(firebase, "PRODUCT_FOUND", f"{sku} found in predefined products.", "raspberry")
            log_activity(firebase, "INVENTORY_INCREMENTED", f"{sku} quantity, stock, and inventoryCount incremented by 1.", "raspberry")
            return sku, "ok"
        except requests.HTTPError as exc:
            print_firestore_error("PRODUCT_SYNC_FAILED", exc)
            log_activity(firebase, "INVENTORY_SYNC_ERROR", f"{sku}: {str(exc)}", "raspberry")
            status_code = exc.response.status_code if exc.response is not None else 0
            if status_code in (409, 412, 429) and attempt < max_retries - 1:
                time.sleep(0.4 * (attempt + 1))
                continue
            raise
        except requests.RequestException as exc:
            print_firestore_error("PRODUCT_SYNC_FAILED", exc)
            log_activity(firebase, "INVENTORY_SYNC_ERROR", f"{sku}: {str(exc)}", "raspberry")
            raise

    return sku, "error"


def post_available_stock_after_store(
    firebase: FirebaseClient,
    scan_id: str,
    sku: str,
    key: str,
    box_id: str,
    location_id: int,
    in_position: int,
    out_position: int,
    max_retries: int = 3,
) -> None:
    if not firebase.enabled or not scan_id or not sku:
        return

    for attempt in range(max_retries):
        try:
            processed = firebase.get_doc(f"processedScans/{scan_id}") or {}
            if processed.get("availableStockPosted"):
                print(f"Scan {scan_id} already posted to availableStock; ignored.")
                return

            now = utc_now()
            firebase.increment_doc_fields(f"products/{sku}", {
                "lastStoredBoxId": box_id,
                "lastLocationId": location_id,
                "locationId": location_id,
                "location": str(location_id),
                "productKey": key,
                "isAvailable": True,
                "status": "active",
                "needsDetails": False,
                "lastInPosition": in_position,
                "lastOutPosition": out_position,
                "updatedAt": timestamp(now),
            }, {"availableStock": 1})
            firebase.set_doc(f"processedScans/{scan_id}", {
                "availableStockPosted": True,
                "status": "stored",
                "storedAt": timestamp(now),
                "updatedAt": timestamp(now),
            }, merge=True)
            print("AVAILABLE_STOCK_INCREMENTED")
            log_activity(firebase, "AVAILABLE_STOCK_INCREMENTED", f"{sku} availableStock incremented after storage DONE.", "raspberry")
            return
        except requests.HTTPError as exc:
            print_firestore_error("PRODUCT_SYNC_FAILED", exc)
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
            product_key TEXT,
            box_id TEXT,
            updated_at TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS boxes (
            box_id TEXT PRIMARY KEY,
            scan_id TEXT,
            product_sku TEXT,
            product_key TEXT,
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
            product_key TEXT,
            box_id TEXT,
            operation TEXT DEFAULT 'put',
            location_id INTEGER,
            go_position INTEGER,
            in_position INTEGER,
            out_position INTEGER,
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
            product_key TEXT,
            order_id TEXT,
            pick_request_id TEXT,
            order_item_key TEXT,
            box_id TEXT,
            operation TEXT DEFAULT 'get',
            location_id INTEGER,
            go_position INTEGER,
            in_position INTEGER,
            out_position INTEGER,
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
    ensure_column(cur, "boxes", "product_key", "TEXT")
    ensure_column(cur, "boxes", "inventory_counted", "INTEGER DEFAULT 0")
    ensure_column(cur, "locations", "product_key", "TEXT")
    ensure_column(cur, "store_queue", "scan_id", "TEXT")
    ensure_column(cur, "store_queue", "product_sku", "TEXT")
    ensure_column(cur, "store_queue", "product_key", "TEXT")
    ensure_column(cur, "store_queue", "operation", "TEXT DEFAULT 'put'")
    ensure_column(cur, "store_queue", "in_position", "INTEGER")
    ensure_column(cur, "store_queue", "out_position", "INTEGER")
    ensure_column(cur, "store_queue", "available_stock_posted", "INTEGER DEFAULT 0")
    ensure_column(cur, "pick_queue", "product_key", "TEXT")
    ensure_column(cur, "pick_queue", "order_id", "TEXT")
    ensure_column(cur, "pick_queue", "pick_request_id", "TEXT")
    ensure_column(cur, "pick_queue", "order_item_key", "TEXT")
    ensure_column(cur, "pick_queue", "operation", "TEXT DEFAULT 'get'")
    ensure_column(cur, "pick_queue", "in_position", "INTEGER")
    ensure_column(cur, "pick_queue", "out_position", "INTEGER")

    for location_id in range(1, 10):
        cur.execute(
            """
            INSERT OR IGNORE INTO locations
              (id, status, brand, model, color, size, product_key, box_id, updated_at)
            VALUES (?, 'empty', '', '', '', '', '', '', ?)
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
    label = normalize_label(label)
    key = product_key(label)
    cursor = conn.execute(
        """
        UPDATE locations
        SET status = 'reserved', brand = ?, model = ?, color = ?, size = ?, product_key = ?, box_id = ?, updated_at = ?
        WHERE id = ? AND status = 'empty'
        """,
        (label["brand"], label["model"], label["color"], label["size"], key, box_id, utc_now(), location_id),
    )
    if cursor.rowcount == 0:
        raise RuntimeError(f"Location {location_id} is no longer empty.")


def choose_storage_location(conn: sqlite3.Connection, label: dict) -> Optional[int]:
    rows = conn.execute("SELECT * FROM locations WHERE status = 'empty' ORDER BY id").fetchall()
    if not rows:
        return None

    sorting_mode = get_setting(conn, "sortingMode", "")
    if not valid_sorting_strategy(sorting_mode):
        return None
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
    label = normalize_label(label)
    now = utc_now()
    scan_id = f"SCAN-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6].upper()}"
    box_id = f"BOX-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6].upper()}"
    product_sku = build_normalized_sku(label)
    key = product_key(label)
    product_slug = build_product_slug(label)

    conn = connect_db(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        automation_status = get_automation_status(firebase)
        sorting_strategy = str(automation_status.get("sortingStrategy") or "").strip()
        if not valid_sorting_strategy(sorting_strategy):
            conn.rollback()
            set_automation_status(firebase, {
                "currentState": STATE_WAIT_FOR_AUTOMATION,
                "lastError": "Waiting for sorting strategy",
                "beltBlocked": True,
            })
            return None
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('sortingMode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (sorting_strategy,),
        )
        location_id = choose_storage_location(conn, label)
        if not location_id:
            conn.rollback()
            log_activity(firebase, "store_queue_error", "No empty storage location available.", "raspberry")
            return None

        in_position = get_in_position(location_id)
        out_position = get_out_position(location_id)

        print("CALLING_SYNC_PRODUCT_FROM_LABEL")
        product_sku, sync_status = sync_product_from_label(
            firebase,
            label,
            scan_id,
            box_id,
            location_id,
            in_position,
            out_position,
        )
        if sync_status != "ok":
            conn.rollback()
            return None

        conn.execute(
            """
            INSERT INTO boxes
              (box_id, scan_id, product_sku, product_key, brand, model, color, size, location_id, status, inventory_counted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)
            """,
            (box_id, scan_id, product_sku, key, label["brand"], label["model"], label["color"], label["size"], location_id, now, now),
        )
        reserve_location(conn, location_id, label, box_id)
        conn.execute(
            """
            INSERT INTO store_queue
              (scan_id, product_sku, product_key, box_id, operation, location_id, go_position, in_position, out_position, status, available_stock_posted, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'put', ?, ?, ?, ?, 'waiting', 0, ?, ?)
            """,
            (scan_id, product_sku, key, box_id, location_id, in_position, in_position, out_position, now, now),
        )
        queue_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    scan_data = {
        "scanId": scan_id,
        "boxId": box_id,
        "normalizedSku": product_sku,
        "productKey": key,
        "slug": product_slug,
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "selectedLocation": location_id,
        "inPosition": in_position,
        "outPosition": out_position,
        "status": "queued",
        "createdAt": timestamp(now),
    }
    firebase.add_doc("scans", scan_data)
    firebase.set_doc(f"locations/{location_id}", {
        "status": "reserved",
        "productId": product_sku,
        "normalizedSku": product_sku,
        "productKey": key,
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "boxId": box_id,
        "updatedAt": timestamp(now),
    })
    firebase.set_doc(f"boxes/{box_id}", {
        "boxId": box_id,
        "scanId": scan_id,
        "normalizedSku": product_sku,
        "productKey": key,
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "locationId": location_id,
        "status": "queued",
        "updatedAt": timestamp(now),
    }, merge=False)
    firebase.add_doc("storeQueue", {
        "queueId": queue_id,
        "operation": "put",
        "scanId": scan_id,
        "normalizedSku": product_sku,
        "productKey": key,
        "slug": product_slug,
        "boxId": box_id,
        "locationId": location_id,
        "inPosition": in_position,
        "outPosition": out_position,
        "status": "waiting",
        "createdAt": timestamp(now),
        "updatedAt": timestamp(now),
    })
    firebase.set_doc(f"scanQueue/{scan_id}", {
        "scanId": scan_id,
        "boxId": box_id,
        "normalizedSku": product_sku,
        "productKey": key,
        "brand": label["brand"],
        "model": label["model"],
        "color": label["color"],
        "size": label["size"],
        "targetLocation": location_id,
        "status": "WAITING_LIFTER",
        "createdAt": timestamp(now),
        "updatedAt": timestamp(now),
    }, merge=False)
    print("STORE_QUEUE_CREATED")
    log_activity(firebase, "LOCATION_RESERVED", f"{product_sku} reserved location {location_id}.", "raspberry")
    log_activity(firebase, "store_queued", f"{box_id} queued for location {location_id}: GO {in_position} then GO {out_position}.", "raspberry")
    log_activity(firebase, "scan_queued", f"{box_id} queued for location {location_id}: IN {in_position}, OUT {out_position}.", "raspberry")
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


def update_order_retrieval_progress(firebase: FirebaseClient, order_id: str, box_id: str, task_status: str) -> None:
    if not firebase.enabled or not order_id:
        return

    order = firebase.get_doc(f"orders/{order_id}") or {}
    assigned_boxes = order.get("assignedBoxes") or []
    if not isinstance(assigned_boxes, list):
        assigned_boxes = []

    updated_boxes = []
    for item in assigned_boxes:
        if isinstance(item, dict) and item.get("boxId") == box_id:
            updated = dict(item)
            updated["status"] = task_status
            updated["retrievedAt"] = utc_now() if task_status == "done" else updated.get("retrievedAt", "")
            updated_boxes.append(updated)
        else:
            updated_boxes.append(item)

    if updated_boxes:
        done_count = sum(1 for item in updated_boxes if isinstance(item, dict) and item.get("status") == "done")
        total_count = len(updated_boxes)
    else:
        done_count = int(order.get("retrievalDone") or 0) + (1 if task_status == "done" else 0)
        total_count = int(order.get("retrievalTotal") or done_count)

    next_status = "ready" if total_count > 0 and done_count >= total_count else order.get("status", "retrieving")
    firebase.set_doc(f"orders/{order_id}", {
        "assignedBoxes": updated_boxes,
        "retrievalDone": done_count,
        "retrievalTotal": total_count,
        "retrievalProgressLabel": f"{done_count} / {total_count} Retrieved",
        "status": next_status,
        "readyAt": timestamp() if next_status == "ready" else order.get("readyAt"),
        "updatedAt": timestamp(),
    }, merge=True)


# ================= QUEUES =================

class QueueWorker(threading.Thread):
    def __init__(self, db_path: str, esp_base_url: str, firebase: FirebaseClient, poll_commands: bool):
        super().__init__(daemon=True)
        self.db_path = db_path
        self.esp_base_url = esp_base_url.rstrip("/")
        self.firebase = firebase
        self.poll_commands = poll_commands
        self.stop_event = threading.Event()
        self.lifter_busy = False
        self.at_starting_point = False

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                ready, _, _ = automation_ready(self.firebase)
                if ready and self.process_next_task():
                    continue
                if self.poll_commands and not self.lifter_busy and self.process_manual_command():
                    continue
                if ready:
                    self.return_to_start_if_idle()
            except Exception as exc:
                print("Queue worker error:", exc)
                set_automation_status(self.firebase, {
                    "currentState": "ERROR",
                    "lastError": str(exc),
                    "beltBlocked": True,
                    "lifterBusy": self.lifter_busy,
                })
                log_activity(self.firebase, "error", str(exc), "raspberry")
            time.sleep(1.0)

    def send_go(self, position: int, source: str, queue_id: str | int) -> dict:
        ready, _, reason = automation_ready(self.firebase)
        if not ready:
            raise RuntimeError(reason)
        set_automation_status(self.firebase, {
            "currentState": STATE_LIFTER_DELIVERY,
            "lifterBusy": True,
            "beltBlocked": True,
            "currentOperation": f"GO {position}",
            "lastError": None,
        })
        log_activity(self.firebase, "go_sent", f"GO {position} sent for {queue_id}.", source)
        response = requests.get(
            f"{self.esp_base_url}/go",
            params={"position": position, "source": source, "queueId": queue_id},
            timeout=140,
        )
        response.raise_for_status()
        result = response.json()
        if not result.get("ok"):
            raise RuntimeError(result.get("error") or f"GO {position} failed")
        log_activity(self.firebase, "go_done", f"GO {position} done for {queue_id}.", source)
        self.at_starting_point = False
        return result

    def call_esp_go(self, position: int, source: str, queue_id: str | int) -> dict:
        return self.send_go(position, source, queue_id)

    def call_esp_command(self, command: str, source: str, queue_id: str | int) -> dict:
        response = requests.get(
            f"{self.esp_base_url}/command",
            params={"command": command, "source": source, "queueId": queue_id},
            timeout=140,
        )
        response.raise_for_status()
        result = response.json()
        if not result.get("ok"):
            raise RuntimeError(result.get("error") or f"{command} failed")
        return result

    def get_status(self) -> dict:
        return get_esp_status(self.esp_base_url)

    def belt_stop(self) -> None:
        esp_get_json(self.esp_base_url, "/belt/stop", timeout=20)
        set_automation_status(self.firebase, {"beltRunning": False, "beltBlocked": True})

    def belt_run_ms(self, duration_ms: int) -> None:
        status = get_automation_status(self.firebase)
        if status.get("cameraBusy"):
            raise RuntimeError("Camera is busy; belt movement is blocked.")
        esp_get_json(self.esp_base_url, "/belt/run", params={"ms": duration_ms}, timeout=max(20, duration_ms // 1000 + 10))

    def drop_to_lifter(self) -> None:
        status = get_automation_status(self.firebase)
        if status.get("cameraBusy"):
            raise RuntimeError("Camera is busy; drop is blocked.")
        esp_get_json(self.esp_base_url, "/drop", timeout=30)

    def read_ultra(self) -> dict:
        data = esp_get_json(self.esp_base_url, "/ultra", timeout=20)
        return data.get("ultra") or data

    def verify_location(self, location_id: int) -> bool:
        data = esp_get_json(self.esp_base_url, "/verify-location", params={"id": location_id}, timeout=20)
        verification = data.get("verification") or data
        return bool(verification.get("detected"))

    def wait_for_lifter_ir(self, timeout_seconds: int = 30) -> None:
        set_automation_status(self.firebase, {
            "currentState": STATE_MOVE_BOX_TO_LIFTER_IR,
            "beltRunning": True,
            "beltBlocked": False,
            "currentOperation": "Move box to lifter IR",
            "lastError": None,
        })
        esp_get_json(self.esp_base_url, "/belt/start", timeout=20)
        started_at = time.time()
        while time.time() - started_at < timeout_seconds:
            status = self.get_status()
            if bool_status(status, "irLifter"):
                self.belt_stop()
                set_automation_status(self.firebase, {
                    "currentState": STATE_CHECK_LIFTER_READY,
                    "beltRunning": False,
                    "beltBlocked": True,
                    "currentOperation": "Check lifter ready",
                })
                return
            time.sleep(0.2)
        self.belt_stop()
        raise RuntimeError("IR_LIFTER_DETECT timeout.")

    def ensure_lifter_ready(self) -> None:
        set_automation_status(self.firebase, {
            "currentState": STATE_CHECK_LIFTER_READY,
            "beltRunning": False,
            "beltBlocked": True,
            "currentOperation": "Check START + ultrasonic",
        })
        status = self.get_status()
        if not bool_status(status, "atStartingPoint"):
            self.send_start()
            status = self.get_status()
        ultra = self.read_ultra()
        if not bool_status(status, "atStartingPoint"):
            raise RuntimeError("Lifter is not at STARTING_POINT.")
        if not bool_status(ultra, "ultrasonicReady"):
            raise RuntimeError("Lifter ultrasonic check failed.")

    def prepare_box_on_lifter(self, task_id: int | str) -> None:
        self.wait_for_lifter_ir()
        self.ensure_lifter_ready()
        set_automation_status(self.firebase, {
            "currentState": STATE_DROP_BOX_TO_LIFTER,
            "beltRunning": True,
            "beltBlocked": True,
            "currentOperation": "DROP_TO_LIFTER",
        })
        log_activity(self.firebase, "drop_to_lifter_started", f"{task_id} drop to lifter.", "raspberry")
        self.drop_to_lifter()
        set_automation_status(self.firebase, {
            "currentState": STATE_LIFTER_DELIVERY,
            "beltRunning": False,
            "beltBlocked": True,
            "currentOperation": "Lifter delivery",
        })

    def send_start(self) -> bool:
        ready, _, reason = automation_ready(self.firebase)
        if not ready:
            raise RuntimeError(reason)
        set_automation_status(self.firebase, {
            "currentState": "RETURNING_TO_START",
            "lifterBusy": True,
            "beltBlocked": True,
            "currentOperation": "START",
        })
        response = requests.get(
            f"{self.esp_base_url}/start",
            params={"source": "raspberry", "queueId": "idle-start"},
            timeout=140,
        )
        response.raise_for_status()
        result = response.json()
        if not result.get("ok"):
            raise RuntimeError(result.get("error") or "START failed")
        self.at_starting_point = True
        set_automation_status(self.firebase, {
            "currentState": STATE_WAIT_BOX_AT_CAMERA,
            "lifterBusy": False,
            "currentOperation": "",
            "beltBlocked": False,
        })
        log_activity(self.firebase, "returned_to_start", "Lifter returned to starting point.", "raspberry")
        return True

    def process_next_task(self) -> bool:
        if self.lifter_busy:
            return False
        if self.process_pick_task():
            return True
        return self.process_store_task()

    def return_to_start_if_idle(self) -> None:
        if self.lifter_busy or self.at_starting_point:
            return
        conn = connect_db(self.db_path)
        try:
            waiting = conn.execute(
                """
                SELECT
                  (SELECT COUNT(*) FROM pick_queue WHERE status = 'waiting') +
                  (SELECT COUNT(*) FROM store_queue WHERE status = 'waiting') AS waiting_count
                """
            ).fetchone()["waiting_count"]
        finally:
            conn.close()
        if waiting == 0:
            try:
                self.send_start()
            except requests.RequestException as exc:
                print("Return to start failed:", exc)
                log_activity(self.firebase, "error", f"Return to START failed: {exc}", "raspberry")

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

        self.lifter_busy = True
        set_automation_status(self.firebase, {
            "currentState": STATE_LIFTER_DELIVERY,
            "lifterBusy": True,
            "beltBlocked": True,
            "currentOperation": f"PUT Location {task['location_id']}",
            "lastError": None,
        })
        in_position = int(task["in_position"] or get_in_position(int(task["location_id"])))
        out_position = int(task["out_position"] or get_out_position(int(task["location_id"])))
        product_sku = task["product_sku"]
        key = task["product_key"] or ""
        queue_ref = f"store-{task['id']}"
        log_activity(self.firebase, "put_started", f"{task['box_id']} put started: GO {in_position}, GO {out_position}.", "raspberry")

        try:
            self.prepare_box_on_lifter(queue_ref)
            self.firebase.set_doc(f"scanQueue/{task['scan_id']}", {
                "status": "DELIVERING",
                "updatedAt": timestamp(),
            }, merge=True)
            self.put(task, in_position, out_position)
            if int(task["location_id"]) in (8, 9) and not self.verify_location(int(task["location_id"])):
                raise RuntimeError(f"Location {task['location_id']} placement verification failed")
            ok = True
            status = "done"
        except Exception as exc:
            ok = False
            status = "error"
            print("Store task failed:", exc)
            set_automation_status(self.firebase, {
                "currentState": "ERROR",
                "lastError": str(exc),
                "beltBlocked": True,
                "lifterBusy": False,
                "currentOperation": "",
            })
            log_activity(self.firebase, "error", f"{queue_ref}: {exc}", "raspberry")
        finally:
            self.lifter_busy = False

        conn = connect_db(self.db_path)
        now = utc_now()
        box = conn.execute("SELECT * FROM boxes WHERE box_id = ?", (task["box_id"],)).fetchone()
        if ok:
            conn.execute("UPDATE store_queue SET status = 'done', updated_at = ? WHERE id = ?", (now, task["id"]))
            conn.execute("UPDATE boxes SET status = 'stored', updated_at = ? WHERE box_id = ?", (now, task["box_id"]))
            conn.execute("UPDATE locations SET status = 'full', updated_at = ? WHERE id = ?", (now, task["location_id"]))
            log_activity(self.firebase, "put_done", f"{task['box_id']} stored at location {task['location_id']}.", "raspberry")
            try:
                post_available_stock_after_store(
                    self.firebase,
                    task["scan_id"],
                    product_sku,
                    key,
                    task["box_id"],
                    task["location_id"],
                    in_position,
                    out_position,
                )
                conn.execute("UPDATE store_queue SET available_stock_posted = 1, updated_at = ? WHERE id = ?", (now, task["id"]))
            except requests.RequestException as exc:
                print("Available stock update failed:", exc)
                log_activity(self.firebase, "INVENTORY_AVAILABLE_STOCK_ERROR", str(exc), "raspberry")
        else:
            conn.execute("UPDATE store_queue SET status = 'error', updated_at = ? WHERE id = ?", (now, task["id"]))
            conn.execute("UPDATE boxes SET status = 'error', updated_at = ? WHERE box_id = ?", (now, task["box_id"]))
            status = "error"
            self.firebase.set_doc(f"scanQueue/{task['scan_id']}", {
                "status": "ERROR",
                "errorMessage": "Store task failed.",
                "updatedAt": timestamp(now),
            }, merge=True)
            log_activity(self.firebase, "store_error", "Store task failed.", "raspberry")
        conn.commit()
        conn.close()

        if box:
            self.firebase.set_doc(f"locations/{task['location_id']}", {
                "status": "full" if ok else "reserved",
                "productId": product_sku,
                "normalizedSku": product_sku,
                "productKey": key,
                "brand": box["brand"],
                "model": box["model"],
                "color": box["color"],
                "size": box["size"],
                "boxId": task["box_id"],
                "updatedAt": timestamp(now),
            })
            self.firebase.set_doc(f"boxes/{task['box_id']}", {
                "boxId": task["box_id"],
                "scanId": task["scan_id"],
                "normalizedSku": product_sku,
                "productKey": key,
                "brand": box["brand"],
                "model": box["model"],
                "color": box["color"],
                "size": box["size"],
                "locationId": task["location_id"],
                "status": "stored" if ok else "error",
                "updatedAt": timestamp(now),
            }, merge=True)
            if ok:
                self.firebase.set_doc(f"scanQueue/{task['scan_id']}", {
                    "status": "DONE",
                    "updatedAt": timestamp(now),
                }, merge=True)
                log_activity(self.firebase, "LOCATION_FILLED", f"{product_sku} stored in location {task['location_id']}.", "raspberry")
        self.firebase.add_doc("storeQueue", {
            "queueId": task["id"],
            "operation": "put",
            "scanId": task["scan_id"],
            "normalizedSku": product_sku,
            "productKey": key,
            "boxId": task["box_id"],
            "locationId": task["location_id"],
            "inPosition": in_position,
            "outPosition": out_position,
            "status": status,
            "updatedAt": timestamp(now),
        })
        if ok:
            set_automation_status(self.firebase, {
                "currentState": STATE_WAIT_BOX_AT_CAMERA,
                "lifterBusy": False,
                "currentOperation": "",
                "beltBlocked": False,
                "lastError": None,
            })
        return True

    def put(self, task: sqlite3.Row, in_position: int, out_position: int) -> None:
        self.send_go(in_position, "raspberry-put", f"store-{task['id']}-in")
        self.send_go(out_position, "raspberry-put", f"store-{task['id']}-out")

    def process_pick_task(self) -> bool:
        conn = connect_db(self.db_path)
        task = conn.execute("SELECT * FROM pick_queue WHERE status = 'waiting' ORDER BY id LIMIT 1").fetchone()
        if not task:
            conn.close()
            return False

        order_id = task["order_id"] or ""
        if order_id:
            order = self.firebase.get_doc(f"orders/{order_id}") or {}
            if order.get("status") == "cancelled" or order.get("cancelRemainingPickTasks"):
                now = utc_now()
                conn.execute("UPDATE pick_queue SET status = 'cancelled', updated_at = ? WHERE id = ?", (now, task["id"]))
                conn.commit()
                conn.close()
                if task["pick_request_id"]:
                    self.firebase.set_doc(f"pickRequests/{task['pick_request_id']}", {
                        "status": "cancelled",
                        "updatedAt": timestamp(now),
                    }, merge=True)
                log_activity(self.firebase, "pick_cancelled", f"{task['box_id']} skipped because order {order_id} was cancelled.", "raspberry")
                return True

        now = utc_now()
        conn.execute("UPDATE pick_queue SET status = 'running', updated_at = ? WHERE id = ?", (now, task["id"]))
        conn.commit()
        conn.close()

        self.lifter_busy = True
        set_automation_status(self.firebase, {
            "currentState": STATE_LIFTER_DELIVERY,
            "lifterBusy": True,
            "beltBlocked": True,
            "currentOperation": f"GET Location {task['location_id']}",
            "lastError": None,
        })
        in_position = int(task["in_position"] or get_in_position(int(task["location_id"])))
        out_position = int(task["out_position"] or get_out_position(int(task["location_id"])))
        key = task["product_key"] or ""
        log_activity(self.firebase, "get_started", f"{task['box_id']} get started: GO {out_position}, GO {in_position}.", "raspberry")

        try:
            self.get(task, out_position, in_position)
            ok = True
            status = "done"
        except Exception as exc:
            ok = False
            status = "error"
            print("Pick task failed:", exc)
            set_automation_status(self.firebase, {
                "currentState": "ERROR",
                "lastError": str(exc),
                "beltBlocked": True,
                "lifterBusy": False,
                "currentOperation": "",
            })
            log_activity(self.firebase, "error", f"pick-{task['id']}: {exc}", "raspberry")
        finally:
            self.lifter_busy = False

        conn = connect_db(self.db_path)
        now = utc_now()
        box = conn.execute("SELECT * FROM boxes WHERE box_id = ?", (task["box_id"],)).fetchone()
        if ok:
            conn.execute("UPDATE pick_queue SET status = 'done', updated_at = ? WHERE id = ?", (now, task["id"]))
            conn.execute("UPDATE boxes SET status = 'picked', updated_at = ? WHERE box_id = ?", (now, task["box_id"]))
            conn.execute(
                "UPDATE locations SET status = 'empty', brand = '', model = '', color = '', size = '', product_key = '', box_id = '', updated_at = ? WHERE id = ?",
                (now, task["location_id"]),
            )
            log_activity(self.firebase, "get_done", f"{task['box_id']} picked from location {task['location_id']}.", "raspberry")
        else:
            conn.execute("UPDATE pick_queue SET status = 'error', updated_at = ? WHERE id = ?", (now, task["id"]))
            conn.execute("UPDATE boxes SET status = 'error', updated_at = ? WHERE box_id = ?", (now, task["box_id"]))
        conn.commit()
        conn.close()

        location_data = {
            "status": "empty" if ok else "full",
            "productId": "" if ok else (box["product_sku"] if box else ""),
            "normalizedSku": "" if ok else (box["product_sku"] if box else ""),
            "productKey": "" if ok else key,
            "brand": "" if ok else (box["brand"] if box else ""),
            "model": "" if ok else (box["model"] if box else ""),
            "color": "" if ok else (box["color"] if box else ""),
            "size": "" if ok else (box["size"] if box else ""),
            "boxId": "" if ok else task["box_id"],
            "updatedAt": timestamp(now),
        }
        self.firebase.set_doc(f"locations/{task['location_id']}", location_data)
        if box:
            self.firebase.set_doc(f"boxes/{task['box_id']}", {
                "boxId": task["box_id"],
                "normalizedSku": box["product_sku"],
                "productKey": key,
                "brand": box["brand"],
                "model": box["model"],
                "color": box["color"],
                "size": box["size"],
                "locationId": task["location_id"],
                "status": "picked" if ok else "error",
                "updatedAt": timestamp(now),
            }, merge=True)
        self.firebase.add_doc("pickQueue", {
            "queueId": task["id"],
            "operation": "get",
            "requestType": task["request_type"],
            "queryValue": task["query_value"],
            "orderId": order_id,
            "pickRequestId": task["pick_request_id"] or "",
            "orderItemKey": task["order_item_key"] or "",
            "productKey": key,
            "boxId": task["box_id"],
            "locationId": task["location_id"],
            "outPosition": out_position,
            "inPosition": in_position,
            "status": status,
            "updatedAt": timestamp(now),
        })
        if task["pick_request_id"]:
            self.firebase.set_doc(f"pickRequests/{task['pick_request_id']}", {
                "status": "done" if ok else "error",
                "updatedAt": timestamp(now),
            }, merge=True)
        if order_id:
            update_order_retrieval_progress(self.firebase, order_id, task["box_id"], "done" if ok else "error")
        if ok:
            set_automation_status(self.firebase, {
                "currentState": STATE_WAIT_BOX_AT_CAMERA,
                "lifterBusy": False,
                "currentOperation": "",
                "beltBlocked": False,
                "lastError": None,
            })
        return True

    def get(self, task: sqlite3.Row, out_position: int, in_position: int) -> None:
        self.send_go(out_position, "raspberry-get", f"pick-{task['id']}-out")
        self.send_go(in_position, "raspberry-get", f"pick-{task['id']}-in")

    def process_manual_command(self) -> bool:
        try:
            commands = self.firebase.query("commands", {"status": "pending"}, limit_count=1)
        except requests.RequestException as exc:
            print("Manual command poll failed:", exc)
            return False
        if not commands:
            return False

        command = commands[0]
        command_type = str(command.get("type") or "GO").strip().upper()
        if command_type == "COMMAND":
            raw_command = str(command.get("command") or command.get("arduinoCommand") or "").strip().upper()
            if raw_command not in ("STOP", "STATUS", "TESTIR", "ULTRA", "CAMERA", "SCAN", "DISPENSE", "D", "HOME", "START", "BELT"):
                self.firebase.set_doc(f"commands/{command['_id']}", {
                    "status": "error",
                    "errorMessage": f"Invalid command {raw_command}",
                    "updatedAt": timestamp(),
                })
                return True

            self.firebase.set_doc(f"commands/{command['_id']}", {
                "status": "sent_to_arduino",
                "sentAt": timestamp(),
            })
            try:
                result = self.call_esp_command(raw_command, "website", command["_id"])
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

        ready, _, reason = automation_ready(self.firebase)
        if not ready:
            self.firebase.set_doc(f"commands/{command['_id']}", {
                "status": "error",
                "errorMessage": reason,
                "updatedAt": timestamp(),
            })
            return True

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
            task_count = enqueue_pick_request(self.db_path, self.firebase, request)
            self.firebase.set_doc(f"pickRequests/{request['_id']}", {
                "status": "queued" if task_count else "error",
                "queuedCount": task_count,
                "updatedAt": timestamp(),
            })
            self.seen_request_ids.add(request["_id"])


def enqueue_pick_request(db_path: str, firebase: FirebaseClient, request: dict) -> int:
    request_type = (request.get("requestType") or request.get("request_type") or "single").strip()
    query_value = str(request.get("queryValue") or request.get("query_value") or "").strip()
    if request.get("status") == "cancelled":
        return 0
    if not query_value:
        return 0

    conn = connect_db(db_path)
    normalized_query = query_value.upper().strip()
    if request_type in ("single", "box_id"):
        rows = conn.execute(
            "SELECT * FROM boxes WHERE box_id = ? AND status = 'stored'",
            (query_value,),
        ).fetchall()
    elif request_type == "location":
        try:
            requested_location_id = int(request.get("locationId") or query_value)
        except ValueError:
            rows = []
        else:
            rows = conn.execute(
                "SELECT * FROM boxes WHERE location_id = ? AND status = 'stored' ORDER BY created_at LIMIT 1",
                (requested_location_id,),
            ).fetchall()
    elif request_type in ("productKey", "product_key"):
        rows = conn.execute(
            "SELECT * FROM boxes WHERE product_key = ? AND status = 'stored' ORDER BY created_at",
            (normalized_query,),
        ).fetchall()
    elif request_type in ("size", "model", "brand", "color"):
        rows = conn.execute(
            f"SELECT * FROM boxes WHERE {request_type} = ? AND status = 'stored' ORDER BY created_at",
            (normalized_query,),
        ).fetchall()
    else:
        rows = []

    now = utc_now()
    count = 0
    for box in rows:
        location_id = int(box["location_id"])
        in_position = get_in_position(location_id)
        out_position = get_out_position(location_id)
        key = box["product_key"] or product_key(box)
        order_id = str(request.get("orderId") or "")
        pick_request_id = str(request.get("_id") or "")
        order_item_key = str(request.get("orderItemKey") or "")
        conn.execute(
            """
            INSERT INTO pick_queue
              (request_type, query_value, product_key, order_id, pick_request_id, order_item_key, box_id, operation, location_id, go_position, in_position, out_position, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'get', ?, ?, ?, ?, 'waiting', ?, ?)
            """,
            (request_type, query_value, key, order_id, pick_request_id, order_item_key, box["box_id"], location_id, out_position, in_position, out_position, now, now),
        )
        queue_id = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
        conn.execute("UPDATE boxes SET status = 'queued_for_pick', updated_at = ? WHERE box_id = ?", (now, box["box_id"]))
        firebase.add_doc("pickQueue", {
            "queueId": queue_id,
            "operation": "get",
            "requestType": request_type,
            "queryValue": query_value,
            "orderId": order_id,
            "pickRequestId": pick_request_id,
            "orderItemKey": order_item_key,
            "productKey": key,
            "boxId": box["box_id"],
            "locationId": location_id,
            "outPosition": out_position,
            "inPosition": in_position,
            "status": "waiting",
            "createdAt": timestamp(now),
            "updatedAt": timestamp(now),
        })
        firebase.set_doc(f"boxes/{box['box_id']}", {
            "status": "queued_for_pick",
            "updatedAt": timestamp(now),
        }, merge=True)
        log_activity(firebase, "pick_queued", f"{box['box_id']} queued for pick from location {location_id}: GO {out_position} then GO {in_position}.", "raspberry")
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
    parser.add_argument("--init-catalog-only", action="store_true")
    parser.add_argument("--cleanup-firebase-runtime", action="store_true")
    return parser.parse_args()


# ================= MAIN =================

def main():
    args = parse_args()
    firebase = FirebaseClient(FIREBASE_API_KEY, enabled=not args.no_firebase)

    if args.cleanup_firebase_runtime:
        try:
            cleanup_firebase_runtime_data(firebase)
        except requests.RequestException as exc:
            print_firestore_error("CLEANUP_FAILED", exc)
        return

    ensure_automation_status(firebase)
    init_sqlite(args.db)
    try:
        sync_settings_from_firebase(args.db, firebase)
    except requests.RequestException as exc:
        print("Firebase settings sync failed, using local defaults:", exc)

    try:
        ensure_internal_product_catalog(firebase)
    except requests.RequestException as exc:
        print_firestore_error("PRODUCT_SYNC_FAILED", exc)
        log_activity(firebase, "INVENTORY_SYNC_ERROR", str(exc), "raspberry")
        if args.init_catalog_only:
            return

    if args.init_catalog_only:
        return

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
    last_automation_status_sync = 0.0
    camera_aligned_for_current_box = False
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
            ready, automation_status, wait_reason = automation_ready(firebase)
            now_seconds = time.time()
            if not ready:
                camera_aligned_for_current_box = False
                if now_seconds - last_automation_status_sync > 2.0:
                    set_automation_status(firebase, {
                        "currentState": STATE_WAIT_FOR_AUTOMATION if not automation_status.get("automationStarted") else STATE_STOPPED,
                        "cameraBusy": False,
                        "beltRunning": False,
                        "beltBlocked": True,
                        "lifterBusy": False,
                        "currentOperation": "",
                        "lastError": wait_reason,
                    })
                    last_automation_status_sync = now_seconds
                last_status = wait_reason
                frame_counter += 1
                output = draw_overlay(frame, roi_rect, last_result, fps if "fps" in locals() else 0.0, sharpness, last_status, last_logo_score)
                cv2.imshow("MakhzanXpert OCR Queue Controller", output)
                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    break
                if key == ord("r"):
                    print("RESET FOR NEW LABEL")
                    reset_stability()
                    last_status = "reset"
                continue

            try:
                esp_status = get_esp_status(args.esp_url)
            except requests.RequestException as exc:
                print("ESP status failed:", exc)
                set_automation_status(firebase, {
                    "currentState": STATE_ERROR,
                    "beltBlocked": True,
                    "beltRunning": False,
                    "lastError": f"ESP status failed: {exc}",
                })
                last_status = "esp status error"
                frame_counter += 1
                output = draw_overlay(frame, roi_rect, last_result, fps if "fps" in locals() else 0.0, sharpness, last_status, last_logo_score)
                cv2.imshow("MakhzanXpert OCR Queue Controller", output)
                key = cv2.waitKey(1) & 0xFF
                if key == ord("q"):
                    break
                continue

            if not bool_status(esp_status, "irCamera"):
                camera_aligned_for_current_box = False
                set_automation_status(firebase, {
                    "currentState": STATE_WAIT_BOX_AT_CAMERA,
                    "cameraBusy": False,
                    "beltRunning": False,
                    "beltBlocked": False,
                    "lastError": None,
                })
                last_status = "waiting for IR_CAMERA"
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
                continue

            if not camera_aligned_for_current_box:
                try:
                    set_automation_status(firebase, {
                        "currentState": STATE_CAMERA_ALIGNING,
                        "cameraBusy": False,
                        "beltRunning": True,
                        "beltBlocked": True,
                        "currentOperation": "Align box at camera",
                        "lastError": None,
                    })
                    esp_get_json(args.esp_url, "/belt/run", params={"ms": CAMERA_ALIGN_DELAY_MS}, timeout=20)
                    esp_get_json(args.esp_url, "/belt/stop", timeout=20)
                    camera_aligned_for_current_box = True
                except Exception as exc:
                    print("Camera alignment failed:", exc)
                    set_automation_status(firebase, {
                        "currentState": STATE_ERROR,
                        "beltRunning": False,
                        "beltBlocked": True,
                        "lastError": f"Camera alignment failed: {exc}",
                    })
                    last_status = "camera align error"
                    continue

            if frame_counter % OCR_EVERY_N_FRAMES == 0:
                if sharpness >= MIN_SHARPNESS:
                    set_automation_status(firebase, {
                        "currentState": STATE_CAMERA_READING,
                        "cameraBusy": True,
                        "beltBlocked": True,
                        "beltRunning": False,
                        "lastError": None,
                    })
                    try:
                        last_result, _, last_logo_score = best_ocr_result(roi, templates)
                        confirmed_label = update_field_stability(last_result.fields)
                    finally:
                        set_automation_status(firebase, {
                            "currentState": STATE_WAIT_BOX_AT_CAMERA,
                            "cameraBusy": False,
                            "beltBlocked": False,
                            "beltRunning": False,
                        })
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
                        camera_aligned_for_current_box = False
                    elif confirmed_label:
                        print("DUPLICATE_LABEL_SUPPRESSED")
                        log_activity(firebase, "DUPLICATE_LABEL_SUPPRESSED", label_signature(confirmed_label), "raspberry")
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
