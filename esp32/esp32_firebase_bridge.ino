#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <time.h>

// =====================================================
// MakhzanXpert - ESP32 HTTP Bridge
// Website/Raspberry -> ESP32 -> Arduino Mega
// Arduino Mega -> ESP32 -> Website/Raspberry
// =====================================================

// ===================== WIFI =====================
const char* ssid = "GP";
const char* password = "123456789";

// ===================== FIRESTORE REST =====================
const char* FIREBASE_API_KEY = "AIzaSyBVgBcp5ouNM_ycz0A5dxHlySN_IuZ2CJo";
const char* FIREBASE_PROJECT_ID = "makhzanxpert";
const char* DEVICE_ID = "esp-main-01";

#define FIRESTORE_DEVICE_INTERVAL_MS 5000
#define FIRESTORE_SENSOR_SNAPSHOT_INTERVAL_MS 30000
#define FIRESTORE_ACTIVITY_MIN_INTERVAL_MS 1500
#define FIRESTORE_COMMAND_POLL_INTERVAL_MS 2000

// ===================== SERIAL TO ARDUINO MEGA =====================
#define RXD2 4
#define TXD2 17
#define ARDUINO_BAUD 9600

// ===================== SERVER =====================
WebServer server(80);

// ===================== STATE =====================
String lastArduinoLine = "";
String lastJsonLine = "";
String lastDoneLine = "";
String lastErrorLine = "";

unsigned long lastArduinoSeenAt = 0;
unsigned long commandCounter = 0;
unsigned long lastFirestoreDeviceAt = 0;
unsigned long lastFirestoreSnapshotAt = 0;
unsigned long lastFirestoreActivityAt = 0;
unsigned long lastFirestoreCommandPollAt = 0;
bool firestoreCommandBusy = false;

StaticJsonDocument<1024> latestStatus;
bool latestStatusValid = false;

// =====================================================
// HELPERS
// =====================================================

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi Connected!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

String getTimestamp() {
  struct tm timeinfo;
  if (!getLocalTime(&timeinfo, 1000)) return "1970-01-01T00:00:00Z";
  char buffer[25];
  strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
  return String(buffer);
}

bool waitForTimeSync(unsigned long timeoutMs = 8000) {
  unsigned long start = millis();
  struct tm timeinfo;
  while (millis() - start < timeoutMs) {
    if (getLocalTime(&timeinfo, 1000) && timeinfo.tm_year >= 120) return true;
    delay(250);
  }
  return false;
}

void addCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void sendJson(int code, const String& json) {
  addCors();
  server.send(code, "application/json", json);
}

String jsonEscape(String s) {
  s.replace("\\", "\\\\");
  s.replace("\"", "\\\"");
  s.replace("\n", "\\n");
  s.replace("\r", "");
  return s;
}

String firestoreUrl(String path) {
  return "https://firestore.googleapis.com/v1/projects/" + String(FIREBASE_PROJECT_ID) +
    "/databases/(default)/documents/" + path + "?key=" + String(FIREBASE_API_KEY);
}

String firestoreStringValue(String value) { return "{\"stringValue\":\"" + jsonEscape(value) + "\"}"; }
String firestoreTimestampValue(String value) { return "{\"timestampValue\":\"" + value + "\"}"; }
String firestoreBoolValue(bool value) { return String("{\"booleanValue\":") + (value ? "true" : "false") + "}"; }
String firestoreIntValue(long value) { return "{\"integerValue\":\"" + String(value) + "\"}"; }
String firestoreDoubleValue(double value) { return "{\"doubleValue\":" + String(value, 3) + "}"; }

String firestoreJsonValue(JsonVariant value) {
  if (value.is<bool>()) return firestoreBoolValue(value.as<bool>());
  if (value.is<int>()) return firestoreIntValue(value.as<int>());
  if (value.is<long>()) return firestoreIntValue(value.as<long>());
  if (value.is<float>()) return firestoreDoubleValue(value.as<float>());
  if (value.is<double>()) return firestoreDoubleValue(value.as<double>());
  return firestoreStringValue(value.as<String>());
}

void appendFirestoreField(String& fields, bool& first, String name, String encodedValue) {
  if (!first) fields += ",";
  first = false;
  fields += "\"" + name + "\":" + encodedValue;
}

bool firestoreSend(String method, String url, String body, int* statusCode = nullptr) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");

  int code = -1;
  if (method == "PATCH") code = http.PATCH(body);
  else if (method == "POST") code = http.POST(body);
  else code = http.GET();

  if (statusCode) *statusCode = code;
  if (code < 200 || code >= 300) {
    Serial.print("[FIRESTORE_UPDATE] FAILED ");
    Serial.print(code);
    Serial.print(" ");
    Serial.println(http.getString());
    http.end();
    return false;
  }

  http.end();
  return true;
}

String fireStatusFromLatest() {
  int mq3 = latestStatus["mq3"] | 0;
  int mq135 = latestStatus["mq135"] | 0;
  float temperature = latestStatus["temperature"] | -1.0;
  bool gasWarning = mq3 >= 1500 || mq135 >= 1500;
  bool gasAlert = mq3 >= 2500 || mq135 >= 2500;
  bool highTemperature = temperature >= 45.0;

  if (gasAlert || (gasWarning && highTemperature)) return "Fire Alert";
  if (gasWarning || highTemperature) return "Warning";
  return "Normal";
}

String fireRiskFromStatus(String fireStatus) {
  if (fireStatus == "Fire Alert") return "High";
  if (fireStatus == "Warning") return "Medium";
  return "Low";
}

void publishSystemActivity(String activityType, String message, bool throttle = true);
void publishHardwareStatus(bool forceDevice = false, bool forceSnapshot = false);

String buildHardwareFields(String timestampValue, bool includeCreatedAt) {
  String fields = "";
  bool first = true;

  appendFirestoreField(fields, first, "deviceId", firestoreStringValue(DEVICE_ID));
  appendFirestoreField(fields, first, "source", firestoreStringValue("esp32"));
  appendFirestoreField(fields, first, "sourceDevice", firestoreStringValue("esp32"));
  appendFirestoreField(fields, first, "espIp", firestoreStringValue(WiFi.localIP().toString()));
  appendFirestoreField(fields, first, "wifiRssi", firestoreIntValue(WiFi.RSSI()));
  appendFirestoreField(fields, first, "arduinoOnline", firestoreBoolValue((millis() - lastArduinoSeenAt) < 5000));
  appendFirestoreField(fields, first, "arduinoSeenMsAgo", firestoreIntValue(millis() - lastArduinoSeenAt));
  appendFirestoreField(fields, first, "lastArduinoLine", firestoreStringValue(lastArduinoLine));
  appendFirestoreField(fields, first, "lastDoneLine", firestoreStringValue(lastDoneLine));
  appendFirestoreField(fields, first, "lastErrorLine", firestoreStringValue(lastErrorLine));

  if (latestStatusValid) {
    for (JsonPair kv : latestStatus.as<JsonObject>()) {
      appendFirestoreField(fields, first, String(kv.key().c_str()), firestoreJsonValue(kv.value()));
    }
  }

  if (!latestStatus.containsKey("beltRunning") && latestStatus.containsKey("belt")) {
    appendFirestoreField(fields, first, "beltRunning", firestoreBoolValue((int)(latestStatus["belt"] | 0) == 1));
  }
  if (!latestStatus.containsKey("lifterBusy") && latestStatus.containsKey("busy")) {
    appendFirestoreField(fields, first, "lifterBusy", firestoreBoolValue((bool)(latestStatus["busy"] | false)));
  }
  if (!latestStatus.containsKey("loc7Detected")) appendFirestoreField(fields, first, "loc7Detected", firestoreBoolValue(false));
  if (!latestStatus.containsKey("loc8Detected")) appendFirestoreField(fields, first, "loc8Detected", firestoreBoolValue(false));
  if (!latestStatus.containsKey("loc9Detected")) appendFirestoreField(fields, first, "loc9Detected", firestoreBoolValue(false));

  String fireStatus = fireStatusFromLatest();
  appendFirestoreField(fields, first, "fireStatus", firestoreStringValue(fireStatus));
  appendFirestoreField(fields, first, "fireRisk", firestoreStringValue(fireRiskFromStatus(fireStatus)));
  appendFirestoreField(fields, first, "gasStatus", firestoreStringValue(fireStatus));
  appendFirestoreField(fields, first, "environmentStatus", firestoreStringValue("Online"));
  appendFirestoreField(fields, first, "status", firestoreStringValue("online"));
  appendFirestoreField(fields, first, "lastSeen", firestoreTimestampValue(timestampValue));
  appendFirestoreField(fields, first, "updatedAt", firestoreTimestampValue(timestampValue));
  if (includeCreatedAt) appendFirestoreField(fields, first, "createdAt", firestoreTimestampValue(timestampValue));

  return fields;
}

void publishSystemActivity(String activityType, String message, bool throttle) {
  if (throttle && millis() - lastFirestoreActivityAt < FIRESTORE_ACTIVITY_MIN_INTERVAL_MS) return;
  lastFirestoreActivityAt = millis();

  String ts = getTimestamp();
  String fields = "";
  bool first = true;
  appendFirestoreField(fields, first, "type", firestoreStringValue(activityType));
  appendFirestoreField(fields, first, "activityType", firestoreStringValue(activityType));
  appendFirestoreField(fields, first, "message", firestoreStringValue(message));
  appendFirestoreField(fields, first, "source", firestoreStringValue("esp32"));
  appendFirestoreField(fields, first, "sourceDevice", firestoreStringValue("esp32"));
  appendFirestoreField(fields, first, "deviceId", firestoreStringValue(DEVICE_ID));
  appendFirestoreField(fields, first, "status", firestoreStringValue("info"));
  appendFirestoreField(fields, first, "createdAt", firestoreTimestampValue(ts));

  String body = "{\"fields\":{" + fields + "}}";
  if (firestoreSend("POST", firestoreUrl("systemActivity"), body)) {
    Serial.println("[FIRESTORE_UPDATE] systemActivity");
  }
}

void publishAutomationStatus(bool started) {
  String ts = getTimestamp();
  String url = firestoreUrl("automation/status") +
    "&updateMask.fieldPaths=automationStarted" +
    "&updateMask.fieldPaths=currentState" +
    "&updateMask.fieldPaths=cameraBusy" +
    "&updateMask.fieldPaths=beltRunning" +
    "&updateMask.fieldPaths=beltBlocked" +
    "&updateMask.fieldPaths=lifterBusy" +
    "&updateMask.fieldPaths=currentOperation" +
    "&updateMask.fieldPaths=source" +
    "&updateMask.fieldPaths=sourceDevice" +
    "&updateMask.fieldPaths=updatedAt";

  String fields = "";
  bool first = true;
  appendFirestoreField(fields, first, "automationStarted", firestoreBoolValue(started));
  appendFirestoreField(fields, first, "currentState", firestoreStringValue(started ? "WAIT_BOX_AT_CAMERA" : "STOPPED"));
  appendFirestoreField(fields, first, "cameraBusy", firestoreBoolValue(false));
  appendFirestoreField(fields, first, "beltRunning", firestoreBoolValue(started));
  appendFirestoreField(fields, first, "beltBlocked", firestoreBoolValue(!started));
  appendFirestoreField(fields, first, "lifterBusy", firestoreBoolValue(false));
  appendFirestoreField(fields, first, "currentOperation", firestoreStringValue(""));
  appendFirestoreField(fields, first, "source", firestoreStringValue("esp32"));
  appendFirestoreField(fields, first, "sourceDevice", firestoreStringValue("esp32"));
  appendFirestoreField(fields, first, "updatedAt", firestoreTimestampValue(ts));

  String body = "{\"fields\":{" + fields + "}}";
  if (firestoreSend("PATCH", url, body)) {
    Serial.println(started ? "[FIRESTORE_UPDATE] automation started" : "[FIRESTORE_UPDATE] automation stopped");
  }
}

void publishHardwareStatus(bool forceDevice, bool forceSnapshot) {
  bool deviceDue = forceDevice || millis() - lastFirestoreDeviceAt >= FIRESTORE_DEVICE_INTERVAL_MS;
  bool snapshotDue = forceSnapshot || millis() - lastFirestoreSnapshotAt >= FIRESTORE_SENSOR_SNAPSHOT_INTERVAL_MS;
  if (!deviceDue && !snapshotDue) return;

  String ts = getTimestamp();
  bool sensorOk = false;
  bool latestOk = false;
  bool deviceOk = false;

  if (snapshotDue) {
    lastFirestoreSnapshotAt = millis();
    String snapshotFields = buildHardwareFields(ts, true);
    String sensorBody = "{\"fields\":{" + snapshotFields + "}}";
    sensorOk = firestoreSend("POST", firestoreUrl("sensorReadings"), sensorBody);
  }

  if (deviceDue) {
    lastFirestoreDeviceAt = millis();
    String latestFields = buildHardwareFields(ts, true);
    String deviceFields = buildHardwareFields(ts, false);
    String latestBody = "{\"fields\":{" + latestFields + "}}";
    String deviceBody = "{\"fields\":{" + deviceFields + "}}";
    latestOk = firestoreSend("PATCH", firestoreUrl("sensorReadings/latest"), latestBody);
    deviceOk = firestoreSend("PATCH", firestoreUrl("devices/" + String(DEVICE_ID)), deviceBody);
  }

  if (sensorOk || latestOk || deviceOk) {
    Serial.print("[FIRESTORE_UPDATE] ");
    Serial.print(deviceDue ? "devices/latest" : "");
    Serial.println(snapshotDue ? " sensorReadings" : "");
  }
}

bool isJsonLine(const String& line) { return line.startsWith("{") && line.endsWith("}"); }

void updateLatestStatusFromJson(String line) {
  StaticJsonDocument<512> incoming;
  DeserializationError err = deserializeJson(incoming, line);
  if (err) {
    Serial.print("Arduino JSON parse error: ");
    Serial.println(err.c_str());
    return;
  }

  for (JsonPair kv : incoming.as<JsonObject>()) {
    latestStatus[kv.key()] = kv.value();
  }
  latestStatusValid = true;
  lastJsonLine = line;
  publishHardwareStatus(false);
}

void readArduinoSerial() {
  while (Serial2.available()) {
    String line = Serial2.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    lastArduinoLine = line;
    lastArduinoSeenAt = millis();

    Serial.print("From Arduino: ");
    Serial.println(line);

    if (isJsonLine(line)) {
      updateLatestStatusFromJson(line);
    } else if (line.startsWith("DONE:")) {
      Serial.print("[ARDUINO_RESPONSE] ");
      Serial.println(line);
      lastDoneLine = line;
      publishSystemActivity("ARDUINO_RESPONSE", line, false);
      publishHardwareStatus(true);
    } else if (line.startsWith("ERROR:")) {
      Serial.print("[ARDUINO_RESPONSE] ");
      Serial.println(line);
      lastErrorLine = line;
      publishSystemActivity("ARDUINO_RESPONSE", line, false);
      publishHardwareStatus(true);
    }
  }
}

void sendToArduino(String command) {
  command.trim();
  Serial.print("[COMMAND_FORWARDED] ");
  Serial.println(command);
  publishSystemActivity("COMMAND_FORWARDED", command, false);
  Serial.print("Sending to Arduino: ");
  Serial.println(command);
  Serial2.print(command);
  Serial2.print('\n');
}

bool waitForDone(String expectedDone, unsigned long timeoutMs, String& matchedLine) {
  unsigned long start = millis();
  matchedLine = "";

  while (millis() - start < timeoutMs) {
    readArduinoSerial();
    if (lastDoneLine.length() > 0) {
      if (expectedDone.length() == 0 || lastDoneLine == expectedDone || lastDoneLine.startsWith(expectedDone)) {
        matchedLine = lastDoneLine;
        return true;
      }
    }
    delay(10);
  }
  return false;
}

bool sendCommandAndWait(String command, String expectedDone, unsigned long timeoutMs, String& doneLine) {
  lastDoneLine = "";
  lastErrorLine = "";
  sendToArduino(command);
  return waitForDone(expectedDone, timeoutMs, doneLine);
}

String statusJsonResponse() {
  StaticJsonDocument<1536> doc;
  doc["ok"] = true;
  doc["espIp"] = WiFi.localIP().toString();
  doc["wifiRssi"] = WiFi.RSSI();
  doc["arduinoOnline"] = (millis() - lastArduinoSeenAt) < 5000;
  doc["arduinoSeenMsAgo"] = millis() - lastArduinoSeenAt;
  doc["lastArduinoLine"] = lastArduinoLine;
  doc["lastDoneLine"] = lastDoneLine;
  doc["lastErrorLine"] = lastErrorLine;

  JsonObject status = doc.createNestedObject("status");
  if (latestStatusValid) {
    for (JsonPair kv : latestStatus.as<JsonObject>()) status[kv.key()] = kv.value();
  }

  if (!status.containsKey("beltRunning") && status.containsKey("belt")) status["beltRunning"] = (int)(status["belt"] | 0) == 1;
  if (!status.containsKey("lifterBusy") && status.containsKey("busy")) status["lifterBusy"] = (bool)(status["busy"] | false);
  if (!status.containsKey("irCamera")) status["irCamera"] = false;
  if (!status.containsKey("irLifter")) status["irLifter"] = false;
  if (!status.containsKey("irFirst")) status["irFirst"] = false;
  if (!status.containsKey("irLast")) status["irLast"] = false;
  if (!status.containsKey("beltRunning")) status["beltRunning"] = false;
  if (!status.containsKey("lifterBusy")) status["lifterBusy"] = false;
  if (!status.containsKey("atStartingPoint")) status["atStartingPoint"] = false;
  if (!status.containsKey("ultrasonicReady")) status["ultrasonicReady"] = false;
  if (!status.containsKey("loc7Detected")) status["loc7Detected"] = false;
  if (!status.containsKey("loc8Detected")) status["loc8Detected"] = false;
  if (!status.containsKey("loc9Detected")) status["loc9Detected"] = false;

  String out;
  serializeJson(doc, out);
  return out;
}

// =====================================================
// FIRESTORE COMMAND POLLER
// =====================================================

bool firestoreRequest(String method, String url, String body, String& response, int* statusCode = nullptr) {
  response = "";
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, url)) return false;
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");

  int code = -1;
  if (method == "PATCH") code = http.PATCH(body);
  else if (method == "POST") code = http.POST(body);
  else code = http.GET();

  response = http.getString();
  if (statusCode) *statusCode = code;
  http.end();
  return code >= 200 && code < 300;
}

String getFirestoreStringField(JsonObject fields, String key) {
  if (!fields.containsKey(key)) return "";
  JsonObject f = fields[key];
  if (f.containsKey("stringValue")) return f["stringValue"].as<String>();
  return "";
}

String normalizeFirestoreCommand(String raw) {
  raw.trim();
  raw.toUpperCase();

  if (raw.startsWith("GO ")) return raw;
  if (raw.startsWith("GO")) {
    String n = raw.substring(2);
    n.trim();
    if (n.length() > 0) return "GO " + n;
  }

  if (raw.startsWith("PICK_LOCATION ")) return raw;
  if (raw.startsWith("PICK ")) {
    String n = raw.substring(5);
    n.trim();
    if (n.length() > 0) return "PICK_LOCATION " + n;
  }
  if (raw.startsWith("PICK_LOCATION")) {
    String n = raw.substring(13);
    n.trim();
    if (n.length() > 0) return "PICK_LOCATION " + n;
  }

  if (raw == "START_AUTOMATION") return "START_AUTOMATION";
  if (raw == "AUTO") return "START_AUTOMATION";
  if (raw == "AUTOMATION_START") return "START_AUTOMATION";
  if (raw == "STOP_AUTOMATION") return "STOP_AUTOMATION";
  if (raw == "AUTOMATION_STOP") return "STOP_AUTOMATION";

  if (raw == "HOME_LIFTER") return "HOME";
  if (raw == "RESET_SYSTEM") return "HOME";

  if (raw == "STOP") return "BELT_STOP";
  if (raw == "BELT") return "BELT_START";
  if (raw == "BELT_START") return "BELT_START";
  if (raw == "BELT_STOP") return "BELT_STOP";
  if (raw == "BELT_RUN_UNTIL_IR_LAST") return "BELT_RUN_UNTIL_IR_LAST";
  if (raw == "BELT_UNTIL_IR_LAST") return "BELT_RUN_UNTIL_IR_LAST";
  if (raw == "MOVE_TO_IR_LAST") return "BELT_RUN_UNTIL_IR_LAST";

  if (raw == "CAMERA" || raw == "CAMERA_SCAN") return "SCAN";
  if (raw == "D") return "DISPENSE";

  return raw;
}

bool patchFirestoreCommand(String docName, String status, String sentCommand, String response) {
  String ts = getTimestamp();
  String url = "https://firestore.googleapis.com/v1/" + docName +
    "?key=" + String(FIREBASE_API_KEY) +
    "&updateMask.fieldPaths=status" +
    "&updateMask.fieldPaths=sentCommand" +
    "&updateMask.fieldPaths=response" +
    "&updateMask.fieldPaths=updatedAt";

  String fields = "";
  bool first = true;
  appendFirestoreField(fields, first, "status", firestoreStringValue(status));
  appendFirestoreField(fields, first, "sentCommand", firestoreStringValue(sentCommand));
  appendFirestoreField(fields, first, "response", firestoreStringValue(response));
  appendFirestoreField(fields, first, "updatedAt", firestoreTimestampValue(ts));

  String body = "{\"fields\":{" + fields + "}}";
  String res;
  int code = -1;
  bool ok = firestoreRequest("PATCH", url, body, res, &code);

  Serial.print("COMMAND PATCH CODE: ");
  Serial.println(code);
  Serial.println(ok ? "FIRESTORE UPDATE OK" : "FIRESTORE UPDATE FAILED");
  if (!ok) Serial.println(res);
  return ok;
}

String expectedDoneForFirestoreCommand(String arduinoCommand) {
  if (arduinoCommand.startsWith("GO ")) {
    String n = arduinoCommand.substring(3);
    n.trim();
    return "DONE:" + n;
  }
  if (arduinoCommand.startsWith("PICK_LOCATION ")) {
    String n = arduinoCommand.substring(14);
    n.trim();
    return "DONE:PICK_LOCATION " + n;
  }
  if (arduinoCommand == "HOME") return "DONE:HOME";
  if (arduinoCommand == "BELT_RUN_UNTIL_IR_LAST") return "DONE:BELT_RUN_UNTIL_IR_LAST";
  return "";
}

bool shouldWaitForFirestoreCommand(String rawCommand, String arduinoCommand) {
  rawCommand.trim();
  rawCommand.toUpperCase();
  return arduinoCommand.startsWith("GO ") ||
    arduinoCommand.startsWith("PICK_LOCATION ") ||
    arduinoCommand == "HOME" ||
    arduinoCommand == "BELT_RUN_UNTIL_IR_LAST" ||
    rawCommand == "HOME_LIFTER" ||
    rawCommand == "RESET_SYSTEM";
}

bool waitForFirestoreCommandResult(String expectedDone, unsigned long timeoutMs, String& responseLine, bool& arduinoError) {
  unsigned long start = millis();
  responseLine = "";
  arduinoError = false;

  while (millis() - start < timeoutMs) {
    readArduinoSerial();
    if (lastErrorLine.length() > 0) {
      responseLine = lastErrorLine;
      arduinoError = true;
      return false;
    }
    if (lastDoneLine.length() > 0) {
      if (expectedDone.length() == 0 || lastDoneLine == expectedDone || lastDoneLine.startsWith(expectedDone)) {
        responseLine = lastDoneLine;
        return true;
      }
    }
    delay(10);
  }
  responseLine = "Timeout waiting for " + expectedDone;
  return false;
}

void pollFirestoreCommands() {
  if (firestoreCommandBusy) return;
  if (millis() - lastFirestoreCommandPollAt < FIRESTORE_COMMAND_POLL_INTERVAL_MS) return;
  lastFirestoreCommandPollAt = millis();
  if (WiFi.status() != WL_CONNECTED) return;

  String url = "https://firestore.googleapis.com/v1/projects/" + String(FIREBASE_PROJECT_ID) +
    "/databases/(default)/documents:runQuery?key=" + String(FIREBASE_API_KEY);

  String body =
    "{\"structuredQuery\":{" 
      "\"from\":[{\"collectionId\":\"commands\"}],"
      "\"where\":{\"compositeFilter\":{\"op\":\"AND\",\"filters\":["
        "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"deviceId\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"" + String(DEVICE_ID) + "\"}}},"
        "{\"fieldFilter\":{\"field\":{\"fieldPath\":\"status\"},\"op\":\"EQUAL\",\"value\":{\"stringValue\":\"pending\"}}}"
      "]}},"
      "\"orderBy\":[{\"field\":{\"fieldPath\":\"createdAt\"},\"direction\":\"ASCENDING\"}],"
      "\"limit\":1"
    "}}";

  String res;
  int code = -1;
  bool ok = firestoreRequest("POST", url, body, res, &code);

  Serial.print("COMMAND CHECK CODE: ");
  Serial.println(code);
  if (!ok) {
    Serial.println("COMMAND QUERY FAILED");
    Serial.println(res);
    return;
  }

  DynamicJsonDocument doc(8192);
  DeserializationError err = deserializeJson(doc, res);
  if (err) {
    Serial.print("Firestore command query parse error: ");
    Serial.println(err.c_str());
    return;
  }

  JsonArray arr = doc.as<JsonArray>();
  for (JsonObject item : arr) {
    if (!item.containsKey("document")) continue;

    JsonObject document = item["document"];
    String docName = document["name"].as<String>();
    JsonObject fields = document["fields"];

    String rawCommand = getFirestoreStringField(fields, "arduinoCommand");
    if (rawCommand.length() == 0) rawCommand = getFirestoreStringField(fields, "command");

    String arduinoCommand = normalizeFirestoreCommand(rawCommand);
    if (arduinoCommand.length() == 0) continue;

    firestoreCommandBusy = true;
    Serial.print("COMMAND FOUND ");
    Serial.println(rawCommand);

    lastDoneLine = "";
    lastErrorLine = "";
    sendToArduino(arduinoCommand);
    Serial.print("COMMAND SENT ");
    Serial.println(arduinoCommand);

    if (arduinoCommand == "START_AUTOMATION") publishAutomationStatus(true);
    else if (arduinoCommand == "STOP_AUTOMATION") publishAutomationStatus(false);

    patchFirestoreCommand(docName, "sent_to_arduino", arduinoCommand, "Command sent to Arduino");
    publishSystemActivity("COMMAND_FORWARDED", arduinoCommand, false);
    publishHardwareStatus(true);

    if (shouldWaitForFirestoreCommand(rawCommand, arduinoCommand)) {
      String expectedDone = expectedDoneForFirestoreCommand(arduinoCommand);
      unsigned long timeoutMs = (arduinoCommand == "BELT_RUN_UNTIL_IR_LAST") ? 60000UL : 140000UL;
      if (arduinoCommand.startsWith("PICK_LOCATION ")) timeoutMs = 180000UL;
      String responseLine;
      bool arduinoError = false;
      bool done = waitForFirestoreCommandResult(expectedDone, timeoutMs, responseLine, arduinoError);
      patchFirestoreCommand(docName, done ? "done" : "error", arduinoCommand, responseLine.length() > 0 ? responseLine : String("Command failed"));
      publishHardwareStatus(true);
    }

    firestoreCommandBusy = false;
    break;
  }
}

// =====================================================
// ROUTES
// =====================================================

void handleOptions() { addCors(); server.send(204); }
void handleRoot() { sendJson(200, "{\"ok\":true,\"device\":\"MakhzanXpert ESP32 Bridge\"}"); }
void handleStatus() { readArduinoSerial(); sendJson(200, statusJsonResponse()); }

void handleGo() {
  if (!server.hasArg("position")) { sendJson(400, "{\"ok\":false,\"error\":\"Missing position\"}"); return; }
  int position = server.arg("position").toInt();
  if (position < 1 || position > 18) { sendJson(400, "{\"ok\":false,\"error\":\"Invalid position. Use 1..18\"}"); return; }

  commandCounter++;
  String command = "GO " + String(position);
  Serial.print("[COMMAND_RECEIVED] "); Serial.println(command);
  String expected = "DONE:" + String(position);
  String doneLine;
  bool ok = sendCommandAndWait(command, expected, 140000, doneLine);

  StaticJsonDocument<512> doc;
  doc["ok"] = ok;
  doc["commandId"] = commandCounter;
  doc["command"] = command;
  doc["position"] = position;
  doc["doneLine"] = doneLine;
  doc["lastArduinoLine"] = lastArduinoLine;
  doc["lastErrorLine"] = lastErrorLine;
  doc["source"] = server.arg("source");
  doc["queueId"] = server.arg("queueId");
  if (!ok) doc["error"] = "Timeout waiting for " + expected;
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleStart() {
  commandCounter++;
  Serial.println("[COMMAND_RECEIVED] START");
  String doneLine;
  bool ok = sendCommandAndWait("START", "DONE:START", 140000, doneLine);
  StaticJsonDocument<512> doc;
  doc["ok"] = ok;
  doc["commandId"] = commandCounter;
  doc["command"] = "START";
  doc["doneLine"] = doneLine;
  doc["lastArduinoLine"] = lastArduinoLine;
  doc["lastErrorLine"] = lastErrorLine;
  doc["source"] = server.arg("source");
  doc["queueId"] = server.arg("queueId");
  if (!ok) doc["error"] = "Timeout waiting for DONE:START";
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleBeltStart() {
  Serial.println("[COMMAND_RECEIVED] BELT_START");
  String doneLine;
  bool ok = sendCommandAndWait("BELT_START", "DONE:BELT_START", 20000, doneLine);
  StaticJsonDocument<384> doc;
  doc["ok"] = ok;
  doc["command"] = "BELT_START";
  doc["doneLine"] = doneLine;
  doc["lastErrorLine"] = lastErrorLine;
  if (!ok) doc["error"] = "Timeout waiting for DONE:BELT_START";
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleBeltStop() {
  Serial.println("[COMMAND_RECEIVED] BELT_STOP");
  String doneLine;
  bool ok = sendCommandAndWait("BELT_STOP", "DONE:BELT_STOP", 20000, doneLine);
  StaticJsonDocument<384> doc;
  doc["ok"] = ok;
  doc["command"] = "BELT_STOP";
  doc["doneLine"] = doneLine;
  doc["lastErrorLine"] = lastErrorLine;
  if (!ok) doc["error"] = "Timeout waiting for DONE:BELT_STOP";
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleBeltRun() {
  unsigned long ms = server.hasArg("ms") ? server.arg("ms").toInt() : 3000;
  if (ms < 100) ms = 100;
  if (ms > 15000) ms = 15000;
  String command = "BELT_RUN_MS " + String(ms);
  Serial.print("[COMMAND_RECEIVED] "); Serial.println(command);
  String doneLine;
  bool ok = sendCommandAndWait(command, "DONE:BELT_RUN_MS", ms + 15000, doneLine);
  StaticJsonDocument<384> doc;
  doc["ok"] = ok;
  doc["command"] = command;
  doc["ms"] = ms;
  doc["doneLine"] = doneLine;
  doc["lastErrorLine"] = lastErrorLine;
  if (!ok) doc["error"] = "Timeout waiting for DONE:BELT_RUN_MS";
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleBeltUntilIrLast() {
  Serial.println("[COMMAND_RECEIVED] BELT_RUN_UNTIL_IR_LAST");
  String doneLine;
  bool ok = sendCommandAndWait("BELT_RUN_UNTIL_IR_LAST", "DONE:BELT_RUN_UNTIL_IR_LAST", 60000, doneLine);
  StaticJsonDocument<384> doc;
  doc["ok"] = ok;
  doc["command"] = "BELT_RUN_UNTIL_IR_LAST";
  doc["doneLine"] = doneLine;
  doc["lastArduinoLine"] = lastArduinoLine;
  doc["lastErrorLine"] = lastErrorLine;
  if (!ok) doc["error"] = "Timeout waiting for DONE:BELT_RUN_UNTIL_IR_LAST";
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleDrop() {
  Serial.println("[COMMAND_RECEIVED] DROP_TO_LIFTER");
  String doneLine;
  bool ok = sendCommandAndWait("DROP_TO_LIFTER", "DONE:DROP_TO_LIFTER", 30000, doneLine);
  StaticJsonDocument<384> doc;
  doc["ok"] = ok;
  doc["command"] = "DROP_TO_LIFTER";
  doc["doneLine"] = doneLine;
  doc["lastErrorLine"] = lastErrorLine;
  if (!ok) doc["error"] = "Timeout waiting for DONE:DROP_TO_LIFTER";
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleCommand() {
  if (!server.hasArg("command")) { sendJson(400, "{\"ok\":false,\"error\":\"Missing command\"}"); return; }
  String raw = server.arg("command");
  raw.trim(); raw.toUpperCase();
  Serial.print("[COMMAND_RECEIVED] "); Serial.println(raw);
  String arduinoCommand = normalizeFirestoreCommand(raw);

  if (arduinoCommand == "START_AUTOMATION" || arduinoCommand == "STOP_AUTOMATION") {
    sendToArduino(arduinoCommand);
    publishAutomationStatus(arduinoCommand == "START_AUTOMATION");
    StaticJsonDocument<512> doc;
    doc["ok"] = true;
    doc["command"] = arduinoCommand;
    doc["requestedCommand"] = raw;
    doc["message"] = "Automation command sent to Arduino";
    doc["lastArduinoLine"] = lastArduinoLine;
    doc["lastErrorLine"] = lastErrorLine;
    doc["source"] = server.arg("source");
    doc["queueId"] = server.arg("queueId");
    String out; serializeJson(doc, out); sendJson(200, out); return;
  }

  String expectedDone = "DONE:";
  unsigned long timeoutMs = 140000;
  if (arduinoCommand == "BELT_START") expectedDone = "DONE:BELT_START";
  else if (arduinoCommand == "BELT_STOP") expectedDone = "DONE:BELT_STOP";
  else if (arduinoCommand == "BELT_RUN_UNTIL_IR_LAST") { expectedDone = "DONE:BELT_RUN_UNTIL_IR_LAST"; timeoutMs = 60000; }
  else if (arduinoCommand.startsWith("PICK_LOCATION ")) { expectedDone = expectedDoneForFirestoreCommand(arduinoCommand); timeoutMs = 180000; }
  else if (arduinoCommand == "HOME") expectedDone = "DONE:HOME";
  else if (arduinoCommand == "START") expectedDone = "DONE:START";
  else if (arduinoCommand == "ULTRA") expectedDone = "DONE:ULTRA";
  else if (arduinoCommand == "TESTIR") expectedDone = "DONE:TESTIR";
  else if (arduinoCommand == "SCAN") expectedDone = "DONE:SCAN";
  else if (arduinoCommand == "DISPENSE") expectedDone = "DONE:DISPENSE";

  String doneLine;
  bool ok = sendCommandAndWait(arduinoCommand, expectedDone, timeoutMs, doneLine);
  StaticJsonDocument<512> doc;
  doc["ok"] = ok;
  doc["command"] = arduinoCommand;
  doc["requestedCommand"] = raw;
  doc["doneLine"] = doneLine;
  doc["lastArduinoLine"] = lastArduinoLine;
  doc["lastErrorLine"] = lastErrorLine;
  doc["source"] = server.arg("source");
  doc["queueId"] = server.arg("queueId");
  if (!ok) doc["error"] = "Timeout waiting for response";
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleUltra() {
  String doneLine;
  bool ok = sendCommandAndWait("ULTRA", "DONE:ULTRA", 20000, doneLine);
  StaticJsonDocument<512> doc;
  doc["ok"] = ok;
  doc["line"] = doneLine;
  doc["lastArduinoLine"] = lastArduinoLine;
  doc["lastErrorLine"] = lastErrorLine;
  JsonObject ultra = doc.createNestedObject("ultra");
  if (latestStatusValid) {
    ultra["ultrasonicCm"] = latestStatus["ultrasonicCm"] | -1.0;
    ultra["ultrasonicReady"] = latestStatus["ultrasonicReady"] | false;
  }
  if (!ok) doc["error"] = "Timeout waiting for ULTRA";
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleVerifyLocation() {
  if (!server.hasArg("id")) { sendJson(400, "{\"ok\":false,\"error\":\"Missing location id\"}"); return; }
  int id = server.arg("id").toInt();
  if (id < 1 || id > 9) { sendJson(400, "{\"ok\":false,\"error\":\"Invalid location id. Use 1..9\"}"); return; }
  if (id != 7 && id != 8 && id != 9) {
    StaticJsonDocument<256> doc;
    doc["ok"] = true;
    JsonObject verification = doc.createNestedObject("verification");
    verification["locationId"] = id;
    verification["detected"] = true;
    verification["line"] = "PROTOTYPE_BYPASS";
    verification["prototypeBypass"] = true;
    String out; serializeJson(doc, out); sendJson(200, out); return;
  }

  String command = "VERIFY_LOCATION " + String(id);
  Serial.print("[COMMAND_RECEIVED] "); Serial.println(command);
  String doneLine;
  bool ok = sendCommandAndWait(command, "DONE:VERIFY_LOCATION", 20000, doneLine);
  bool detected = true;
  if (latestStatusValid && latestStatus.containsKey("detected")) detected = latestStatus["detected"] | false;
  else detected = doneLine.indexOf("DETECTED") >= 0;
  String locKey = "loc" + String(id) + "Detected";
  latestStatus[locKey] = detected;
  latestStatusValid = true;
  publishHardwareStatus(true);

  StaticJsonDocument<512> doc;
  doc["ok"] = ok;
  JsonObject verification = doc.createNestedObject("verification");
  verification["locationId"] = id;
  verification["detected"] = detected;
  verification["line"] = doneLine;
  verification["prototypeBypass"] = false;
  if (!ok) doc["error"] = "Timeout waiting for VERIFY_LOCATION";
  String out; serializeJson(doc, out); sendJson(ok ? 200 : 504, out);
}

void handleAutomationStart() {
  Serial.println("[COMMAND_RECEIVED] START_AUTOMATION");
  sendToArduino("START_AUTOMATION");
  publishAutomationStatus(true);
  StaticJsonDocument<384> doc;
  doc["ok"] = true;
  doc["command"] = "START_AUTOMATION";
  doc["message"] = "Automation start sent to Arduino";
  doc["lastArduinoLine"] = lastArduinoLine;
  doc["lastErrorLine"] = lastErrorLine;
  String out; serializeJson(doc, out); sendJson(200, out);
}

void handleAutomationStop() {
  Serial.println("[COMMAND_RECEIVED] STOP_AUTOMATION");
  sendToArduino("STOP_AUTOMATION");
  publishAutomationStatus(false);
  StaticJsonDocument<384> doc;
  doc["ok"] = true;
  doc["command"] = "STOP_AUTOMATION";
  doc["message"] = "Automation stop sent to Arduino";
  doc["lastArduinoLine"] = lastArduinoLine;
  doc["lastErrorLine"] = lastErrorLine;
  String out; serializeJson(doc, out); sendJson(200, out);
}

void setupRoutes() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/go", HTTP_GET, handleGo);
  server.on("/start", HTTP_GET, handleStart);
  server.on("/automation/start", HTTP_GET, handleAutomationStart);
  server.on("/automation/stop", HTTP_GET, handleAutomationStop);
  server.on("/belt/start", HTTP_GET, handleBeltStart);
  server.on("/belt/stop", HTTP_GET, handleBeltStop);
  server.on("/belt/run", HTTP_GET, handleBeltRun);
  server.on("/belt/until-ir-last", HTTP_GET, handleBeltUntilIrLast);
  server.on("/drop", HTTP_GET, handleDrop);
  server.on("/command", HTTP_GET, handleCommand);
  server.on("/ultra", HTTP_GET, handleUltra);
  server.on("/verify-location", HTTP_GET, handleVerifyLocation);

  server.onNotFound([]() {
    if (server.method() == HTTP_OPTIONS) { handleOptions(); return; }
    StaticJsonDocument<256> doc;
    doc["ok"] = false;
    doc["error"] = "Route not found";
    doc["uri"] = server.uri();
    String out; serializeJson(doc, out); sendJson(404, out);
  });
}

void setup() {
  Serial.begin(115200);
  Serial2.begin(ARDUINO_BAUD, SERIAL_8N1, RXD2, TXD2);
  connectWiFi();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  if (!waitForTimeSync()) Serial.println("[FIRESTORE_UPDATE] Time sync failed; timestamps will use fallback until NTP syncs.");

  setupRoutes();
  server.begin();
  publishSystemActivity("ESP32_BOOT", "ESP32 bridge online.", false);
  publishHardwareStatus(true, true);

  Serial.println("ESP32 Bridge Ready");
  Serial.println("Routes:");
  Serial.println("GET /status");
  Serial.println("GET /go?position=1..18");
  Serial.println("GET /start");
  Serial.println("GET /automation/start");
  Serial.println("GET /automation/stop");
  Serial.println("GET /belt/start");
  Serial.println("GET /belt/stop");
  Serial.println("GET /belt/run?ms=3000");
  Serial.println("GET /belt/until-ir-last");
  Serial.println("GET /drop");
  Serial.println("GET /command?command=STATUS");
  Serial.println("GET /ultra");
  Serial.println("GET /verify-location?id=8");
}

void loop() {
  server.handleClient();
  readArduinoSerial();
  pollFirestoreCommands();
  publishHardwareStatus(false);

  static unsigned long lastWifiCheck = 0;
  if (millis() - lastWifiCheck > 5000) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi disconnected. Reconnecting...");
      WiFi.disconnect();
      WiFi.begin(ssid, password);
    } else {
      publishHardwareStatus(false);
    }
  }
}
