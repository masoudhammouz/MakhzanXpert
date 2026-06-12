# System Architecture

## Overview

MakhzanXpert now uses the Raspberry Pi as the local controller and source of truth for placement, retrieval, and queues.

```text
Website -> Firebase Firestore -> Raspberry Pi
                                  |
                                  v
                              ESP32 /go
                                  |
                                  v
                         Arduino Mega over UART
```

Return/status path:

```text
Arduino Mega -> ESP32 -> Raspberry Pi -> SQLite/Firebase -> Website
Arduino sensor JSON -> ESP32 -> Firebase -> Website
```

## Responsibilities

### Website / Firebase

- Admin settings and monitoring.
- Inventory and physical location display.
- Manual GO command history.
- Pick request creation.
- Queue/status/activity visibility.

Important collections/documents:

- `settings/system`
- `locations/1` through `locations/9`
- `scans`
- `storeQueue`
- `pickQueue`
- `pickRequests`
- `commands`
- `activityLog`
- `systemActivity`
- `sensorReadings`
- `devices`

### Raspberry Pi

The Raspberry Pi is the main brain of the warehouse system.

- Runs camera OCR with the existing quality pipeline.
- Keeps SQLite as the local source of truth.
- Initializes 9 physical locations.
- Reads `settings/system` from Firebase on startup.
- Selects only empty storage locations and reserves them immediately.
- Converts physical locations to movement positions:
  - IN: `location_id * 2 - 1`
  - OUT: `location_id * 2`
- Manages `store_queue` and `pick_queue`.
- Sends `GET http://<esp32-ip>/go?position=X&source=raspberry&queueId=Y`.
- Syncs scans, queue status, inventory boxes, and locations to Firebase.
- Polls `pickRequests` and turns matching boxes into pick tasks.
- Polls manual `commands` documents so the Commands page can still test `GO 1` through `GO 18`.

SQLite tables:

- `locations`
- `boxes`
- `store_queue`
- `pick_queue`
- `settings`

### ESP32

The ESP32 is now a local HTTP-to-Serial bridge.

- Exposes `GET /go?position=X&source=raspberry&queueId=Y`.
- Validates `position` is 1-18.
- Sends `GO X` to Arduino Mega over `Serial2`.
- Waits for `DONE`, `DONE:X`, or `ERROR:message`.
- Returns JSON to Raspberry:
  - `{"ok":true,"position":X}`
  - `{"ok":false,"error":"message"}`
- Writes device status and activity logs to Firebase when available.
- Uploads Arduino sensor JSON to `sensorReadings`.

The ESP32 no longer selects locations and no longer treats labels as placement requests.

### Arduino Mega

The Arduino Mega is mechanical control only.

Accepted commands:

```text
GO 1
GO 2
...
GO 18
HOME
STATUS
B
```

Movement responses:

```text
DONE:X
ERROR:message
```

## Physical Model

There are 9 real storage locations and 18 movement positions.

```text
Location 1: GO 1 = IN,  GO 2 = OUT
Location 2: GO 3 = IN,  GO 4 = OUT
Location 3: GO 5 = IN,  GO 6 = OUT
Location 4: GO 7 = IN,  GO 8 = OUT
Location 5: GO 9 = IN,  GO 10 = OUT
Location 6: GO 11 = IN, GO 12 = OUT
Location 7: GO 13 = IN, GO 14 = OUT
Location 8: GO 15 = IN, GO 16 = OUT
Location 9: GO 17 = IN, GO 18 = OUT
```

Warehouse layout:

```text
9 8 7
6 5 4
3 2 1
```

Neighbor map:

```text
1: [2,4]
2: [1,3,5]
3: [2,6]
4: [1,5,7]
5: [2,4,6,8]
6: [3,5,9]
7: [4,8]
8: [5,7,9]
9: [6,8]
```

`GO 1` through `GO 18` are movement positions, not warehouse locations.
