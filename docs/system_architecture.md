# System Architecture

## Overview

MakhzanXpert uses Firebase Firestore as the website command/status bus, and the ESP32 as the hardware bridge.

```text
Website (React + Firebase)
            |
            v
Firebase Firestore
            |
            v
ESP32 bridge
            |
            v
Arduino Mega over UART
```

Additional input path:

```text
Raspberry Pi OCR -> ESP32 HTTP label endpoint -> Firebase/Arduino Mega
```

Return path:

```text
Arduino Mega -> ESP32 -> Firebase Firestore -> Website
```

## Repository Structure

```text
arduino/
  mega_controller.ino

esp32/
  esp32_firebase_bridge.ino

raspberry/
  raspberry_ocr_firebase.py

website/
  React/Vite/Firebase application

docs/
  system documentation
```

The ESP32, Arduino Mega, and Raspberry Pi OCR source files are now included.

## Website Responsibilities

The website is a React/Vite app using Firebase Auth and Firestore.

Primary responsibilities:

- Customer product browsing and checkout.
- Admin authentication.
- Product inventory management.
- Order management.
- Warehouse physical location initialization and display.
- Manual command creation.
- Sensor and device monitoring.
- System activity display.

Important website files:

- `website/src/firebase/firebase.js`: initializes Firebase app, Auth, and Firestore.
- `website/src/firebase/firebaseConfig.js`: Firebase project config for `makhzanxpert`.
- `website/src/pages/admin/AdminCommands.jsx`: creates and displays command documents.
- `website/src/pages/admin/AdminLocations.jsx`: initializes `settings/system` and physical `locations/1` through `locations/9`.
- `website/src/pages/admin/AdminOrders.jsx`: creates warehouse movement commands from orders.
- `website/src/pages/admin/AdminSensors.jsx`: reads `sensorReadings`, `devices`, and `systemActivity`.
- `website/src/pages/admin/AdminDashboard.jsx`: reads latest sensor, activity, and command summaries.
- `website/src/pages/customer/Checkout.jsx`: writes customer `orders`.

## Firebase Responsibilities

Firestore is the shared state and message layer.

Current collections/documents used by website code:

- `commands`
- `locations`
- `settings/system`
- `sensorReadings`
- `devices`
- `systemActivity`
- `orders`
- `products`

Previously observed or requested but not currently used consistently:

- `activityLog`
- `scans`

## ESP32 Responsibilities

The ESP32 implementation in `esp32/esp32_firebase_bridge.ino` currently:

- Queries Firestore for pending commands:

```text
commands where:
  status == "pending"
  deviceId == "esp-main-01"
  type == "GO"
```

- Reads movement `position`.
- Builds UART command `GO X`.
- Sends `GO X` to Arduino Mega over Serial2.
- Marks command `status` as `sent_to_arduino` after sending.
- Waits for Arduino response.
- Marks command `status` as `done` when Arduino returns `DONE` or `DONE:X`.
- Marks command `status` as `error` with `errorMessage` on timeout or Arduino error.
- Updates the matching physical `locations/<1..9>` document after successful completion when the command contains product label data.
- Writes device heartbeat/status into `devices/esp-main-01`.
- Writes sensor readings into `sensorReadings`.
- Exposes `POST /raspberry-label` for Raspberry Pi OCR.
- Receives label data from Raspberry, reads Firestore settings/locations, chooses a free physical location, then converts that location to an IN movement command.

## Location And Movement Model

The physical warehouse has 9 storage locations. Firestore `locations` documents represent these physical locations only:

```text
locations/1
locations/2
...
locations/9
```

Each physical location has two movement points:

```text
Location 1: IN = GO 1,  OUT = GO 2
Location 2: IN = GO 3,  OUT = GO 4
Location 3: IN = GO 5,  OUT = GO 6
Location 4: IN = GO 7,  OUT = GO 8
Location 5: IN = GO 9,  OUT = GO 10
Location 6: IN = GO 11, OUT = GO 12
Location 7: IN = GO 13, OUT = GO 14
Location 8: IN = GO 15, OUT = GO 16
Location 9: IN = GO 17, OUT = GO 18
```

Odd movement positions are IN movements. Even movement positions are OUT movements.

## Arduino Mega Responsibilities

The Arduino Mega implementation in `arduino/mega_controller.ino` currently:

- Receives plain serial commands from ESP32 over `Serial1`.
- Accepts the unified movement command language:

```text
GO 1
GO 2
...
GO 18
```

- Executes the corresponding motor/lifter movement.
- Replies with:

```text
DONE
```

or:

```text
DONE:X
```

or an error response if movement fails.

## Raspberry Pi Responsibilities

The Raspberry Pi implementation in `raspberry/raspberry_ocr_firebase.py` currently:

- Read shoe labels through camera/OCR.
- Determine brand/model/color/size.
- Send only the confirmed OCR label directly to ESP32.
- Never read or write Firebase.
- Never select a target position.
- Never send `GO X` directly.

```json
{
  "brand": "...",
  "model": "...",
  "color": "...",
  "size": "...",
  "source": "raspberry"
}
```

- Append local OCR/scan records into `raspberry_scans.jsonl`.
- Never talk directly to Arduino Mega.

## Sensor Flow

Current website reads:

- `sensorReadings`, ordered by `createdAt` descending.
- `devices`.
- `systemActivity`.

Expected hardware flow:

```text
Arduino sensors or ESP32 sensors
        |
        v
ESP32
        |
        v
Firestore sensorReadings/devices
        |
        v
Website dashboard/sensors page
```

Known `sensorReadings` fields from current website and live inspection:

- `temperature`
- `humidity`
- `mq3`
- `mq135`
- `waterValue`
- `waterDetected`
- `waterStatus`
- `motion`
- `motionStatus`
- `gasStatus`
- `environmentStatus`
- `dhtOk`
- `deviceId`
- `deviceName`
- `createdAt`
- `x`
- `y`
- `z`
- `belt`

## Current Risks

- Raspberry and website now use different upstream paths: website creates Firestore command documents; Raspberry posts label data directly to ESP32.
- Existing live Firestore data may still contain old command documents using older fields/names.
- Activity naming is inconsistent: website uses `systemActivity`, while previous requirements referenced `activityLog`.
- Location naming is partly legacy in UI/CSS (`locations`, `warehouse-location-card`), but Firestore locations now mean physical locations 1-9.
- Sensor page polls `sensorReadings` and `devices` every 5 seconds with `getDocs`, which can become a Firestore read bottleneck.
- Raspberry HTTP requests block while ESP32 waits for Arduino `DONE:X`, so the Raspberry request timeout must cover the real movement duration.
- Prototype IR placement verification only exists for physical locations 7, 8, and 9. Locations 1 through 6 rely on Arduino `DONE:X`.
- ESP32 currently updates warehouse location state after OCR placement, but it does not increase matching `products` stock/quantity. The required stock update should match by `brand + model + color + size`.
- Belt relay behavior is currently toggle-based. `BELT_START` and `BELT_STOP` should remain labels unless deterministic relay state logic is designed.

## Recommended Improvements

- Compile and validate ESP32 and Arduino firmware on their target boards.
- Define one shared protocol document and keep it versioned.
- Add Firestore security rules and indexes documentation.
- Add migration/cleanup script for old `commands` documents.
- Prefer real-time listeners for device/sensor views where practical.
- Add a small shared constants file for website command statuses and Firestore field names.
- Consider moving Raspberry HTTP handling to a non-blocking ESP32 command queue if long hardware movements cause client timeouts.
