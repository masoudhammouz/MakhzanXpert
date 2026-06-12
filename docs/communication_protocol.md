# Communication Protocol

## Universal Movement Rule

Use only `GO 1` through `GO 18` for movement.

Do not use:

- `P X`
- `SITE X`
- a physical location number as the movement command

Physical locations are 1-9. Movement positions are 1-18.

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

## Runtime Flow

```text
OCR scan -> Raspberry SQLite -> store_queue -> ESP32 /go -> Arduino
Pick request -> Firebase -> Raspberry SQLite -> pick_queue -> ESP32 /go -> Arduino
Manual command -> Firebase commands -> Raspberry -> ESP32 /go -> Arduino
```

OCR can continue scanning while queue tasks wait. The lifter executes only one task at a time.

## Raspberry To ESP32

Endpoint:

```text
GET http://<esp32-ip>/go?position=X&source=raspberry&queueId=Y
```

Rules:

- `position` must be 1-18.
- ESP32 sends `GO X` over Serial2.
- ESP32 returns success only after Arduino returns `DONE` or `DONE:X`.

Success:

```json
{"ok": true, "position": 9}
```

Error:

```json
{"ok": false, "error": "Arduino timeout waiting for DONE"}
```

## Arduino Serial Protocol

Accepted movement command:

```text
GO X
```

Where `X` is 1-18.

Successful response:

```text
DONE
DONE:X
```

Failure response:

```text
ERROR:message
```

## Firebase Documents

`settings/system`:

```js
{
  sortingMode,
  automationEnabled,
  autoConveyor,
  autoOCR,
  autoPositionSelection,
  autoInventoryUpdate,
  requireIRVerification,
  firebaseLogging
}
```

`locations/1` through `locations/9`:

```js
{
  status: "empty" | "reserved" | "full",
  brand,
  model,
  color,
  size,
  boxId,
  updatedAt
}
```

`scans`:

```js
{
  boxId,
  brand,
  model,
  color,
  size,
  selectedLocation,
  goPosition,
  status,
  createdAt
}
```

`pickRequests`:

```js
{
  requestType: "single" | "size" | "model" | "brand",
  queryValue,
  status: "waiting" | "queued" | "error",
  createdAt,
  updatedAt
}
```

`commands` remains available for manual `GO 1` through `GO 18` testing. Raspberry polls pending GO commands and executes them through ESP32 `/go`.
