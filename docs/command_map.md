# Command Map

## Final Command Language

The unified Arduino movement language is:

```text
GO 1
GO 2
GO 3
GO 4
GO 5
GO 6
GO 7
GO 8
GO 9
GO 10
GO 11
GO 12
GO 13
GO 14
GO 15
GO 16
GO 17
GO 18
```

These are 18 movement points, not 18 physical storage locations.

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

## Current Website Command Sources

### Manual Admin Commands

File:

```text
website/src/pages/admin/AdminCommands.jsx
```

Creates:

```js
{
  type: "GO",
  position: position,
  arduinoCommand: `GO ${position}`,
  status: "pending",
  source: "website",
  deviceId: "esp-main-01",
  createdAt: serverTimestamp()
}
```

Positions:

```text
1 through 18
```

### Order Preparation Commands

File:

```text
website/src/pages/admin/AdminOrders.jsx
```

Finds matching full physical warehouse location by product fields:

- `brand`
- `model`
- `color`
- `size`

Creates:

```js
{
  type: "GO",
  position: position,
  arduinoCommand: `GO ${position}`,
  status: "pending",
  source: "website",
  deviceId: "esp-main-01",
  brand: item.brand,
  model: item.model,
  color: item.color,
  size: item.size,
  createdAt: serverTimestamp()
}
```

For order retrieval, `position` should be the OUT movement point for the matched physical location. Example: physical `locations/5` creates `position: 10` and `arduinoCommand: "GO 10"`.

## Current Raspberry Command Source

File:

```text
raspberry/raspberry_ocr_firebase.py
```

Raspberry Pi no longer creates Firestore command documents and no longer chooses a position. After OCR confirms a label, it posts label data directly to ESP32:

```json
{
  "brand": "NIKE",
  "model": "AIR MAX",
  "color": "WHITE",
  "size": "42",
  "source": "raspberry"
}
```

ESP32 reads Firebase settings/locations, chooses a free position, creates/updates command/activity status, and converts the selected position to:

```text
GO 1
```

For OCR placement, ESP32 chooses a free physical location and uses that location's IN movement point. Example: physical `locations/5` creates `position: 9` and `arduinoCommand: "GO 9"`.

## Current Command Status Handling

Website displays command status classes for:

```text
pending
sent_to_arduino
done
executed
error
failed
```

Recommended canonical statuses:

```text
pending
sent_to_arduino
done
error
executed
```

`failed` exists only as a legacy UI fallback.

## Deprecated Command Names

These names were previously found in the project or live data and should not be used going forward:

```text
CONVEYOR_START
CONVEYOR_STOP
CAMERA_START
CAMERA_STOP
SCAN_LABEL
STORAGE_START
STORAGE_STOP
RETRIEVE_PRODUCT
EMERGENCY_STOP
SITE 1
SITE 2
...
SITE 9
P 1
P1 IN
P1 OUT
```

## Current JSON Structures Exchanged

### Command

Website Firestore command:

```js
{
  type: "GO",
  position: 1,
  arduinoCommand: "GO 1",
  status: "pending",
  source: "website",
  deviceId: "esp-main-01",
  brand: "",
  model: "",
  color: "",
  size: "",
  createdAt: timestamp
}
```

### Raspberry ESP32 Request

```json
{
  "brand": "",
  "model": "",
  "color": "",
  "size": "",
  "source": "raspberry"
}
```

### Physical Location

```js
{
  status: "empty",
  position: 1,
  brand: "",
  model: "",
  color: "",
  size: "",
  updatedAt: timestamp
}
```

### Settings

```js
{
  sortingMode: "brand",
  priority: ["brand"],
  totalLocations: 9,
  totalPositions: 18,
  commandType: "GO"
}
```

### Sensor Reading

```js
{
  deviceId: "esp-main-01",
  deviceName: "ESP Main Controller",
  temperature: 20.6,
  humidity: 49.4,
  mq3: 144,
  mq135: 156,
  waterValue: 9,
  waterDetected: false,
  waterStatus: "dry",
  motion: 0,
  motionStatus: "no_motion",
  gasStatus: "normal",
  environmentStatus: "safe",
  dhtOk: true,
  createdAt: timestamp
}
```

### Device

```js
{
  deviceId: "esp-main-01",
  deviceName: "ESP Main Controller",
  deviceType: "ESP32",
  status: "online",
  currentTask: "waiting",
  lastSeen: timestamp
}
```

### Order

Created by checkout:

```js
{
  orderId: "ORD-...",
  customerName: "...",
  customerPhone: "...",
  customerAddress: "...",
  items: [
    {
      productId: "...",
      brand: "...",
      model: "...",
      size: "...",
      color: "...",
      price: 0,
      quantity: 1
    }
  ],
  totalPrice: 0,
  status: "pending",
  createdAt: timestamp,
  updatedAt: timestamp
}
```

## Duplicated Logic

- Command status class logic exists in both `AdminCommands.jsx` and `AdminDashboard.jsx`.
- Date formatting helpers are duplicated across admin pages.
- Product title/availability helpers are duplicated across product/customer/admin components.
- Location/position compatibility logic still tolerates legacy `isOccupied` fields.

## Naming Conflicts

- The UI and CSS still use some `location` names for warehouse positions, although the command protocol now uses `position`.
- `systemActivity` is used by the website, while `activityLog` was referenced in earlier requirements.
- Existing live Firestore data may still have old command fields such as `command`, `targetDevice`, or `commandType`.
- Product catalog has a `location` field unrelated to warehouse command `position`.

## Communication Bottlenecks

- `AdminSensors.jsx` polls `sensorReadings` and `devices` every 5 seconds using `getDocs`.
- `AdminCommands.jsx` listens to the latest 50 commands without filtering by device/type.
- ESP32 should avoid repeatedly scanning all commands; it should query only pending GO commands for its device.
- Raspberry Pi HTTP requests block while ESP32 waits for Arduino `DONE:X`, so the Raspberry request timeout must be long enough for real movement.
- ESP32 performs the Raspberry position selection from Firestore, so Raspberry must not keep local warehouse position state.
- Prototype IR verification currently applies only to physical locations 7, 8, and 9.
- ESP32 updates physical warehouse locations after placement/retrieval, but does not currently update matching product stock/quantity in `products`.
- Belt hardware command is currently `BELT` toggle. `BELT_START` and `BELT_STOP` are labels until deterministic state control is implemented.

## Recommended Unified Protocol

Website command producers should use this Firestore schema:

```js
{
  type: "GO",
  position: 1,
  arduinoCommand: "GO 1",
  status: "pending",
  source: "website",
  deviceId: "esp-main-01",
  brand: "",
  model: "",
  color: "",
  size: "",
  createdAt: timestamp
}
```

ESP32 should be the only component that sends serial commands to Arduino Mega.

Raspberry should use `POST /raspberry-label` on ESP32 and send only OCR label fields plus `source: "raspberry"`.

Arduino Mega should only need to parse:

```text
GO X
```

with `X` from `1` to `18`.
