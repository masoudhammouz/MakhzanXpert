//arduino
#include <DHT.h>

// ================= SENSORS =================
#define PIR_PIN 32
#define DHT_PIN 33
#define MQ3_PIN A0
#define MQ135_PIN A1
#define WATER_SENSOR A2

#define DHTTYPE DHT22
DHT dht(DHT_PIN, DHTTYPE);

int waterThreshold = 300;

#define MOTION_ALARM_HOLD 10000
unsigned long lastMotionTime = 0;
bool motionAlarm = false;
int lastMotionState = LOW;

unsigned long lastSensorSend = 0;
#define SENSOR_INTERVAL 3000

// ================= BELT RELAY =================
#define RELAY_PIN 13

// ================= BELT IR =================
#define IRFIRST 40
#define IRLAST 25

bool beltRunning = false;
bool autoMode = false;
bool waitingForWebsiteDecision = false;
bool movingToIRLast = false;

// ================= LOCATION IR MUX =================
#define LOC_MUX_OUT 41
#define LOC_SEL0 44
#define LOC_SEL1 45

// ================= DISPENSER STEPPER =================
#define DISP_PUL 50
#define DISP_DIR 51
#define DISP_ENA 52

#define DISP_DELAY 700
#define DISP_STEPS_ONE_SHOE 800
#define DISP_DIRECTION HIGH

// ================= ULTRASONIC =================
#define TRIG_PIN 27
#define ECHO_PIN 28

// ================= X =================
#define X_PUL 2
#define X_DIR 3
#define X_ENA 4
#define X_LIM 22

// ================= Y =================
#define Y_PUL 5
#define Y_DIR 6
#define Y_ENA 7
#define Y_LIM 24

// ================= Z =================
#define Z_PUL 8
#define Z_DIR 9
#define Z_ENA 10
#define Z_LIM_SAFE 26

#define X_DELAY 600
#define Y_DELAY 500
#define Z_DELAY 700

#define MAX_X_STEPS 2500
#define MAX_Y_STEPS 2700
#define MAX_Z_STEPS 2500

long currentX = 0;
long currentY = 0;
long currentZ = 0;

int currentPositionIndex = 0;
String input = "";

struct Position {
  long x;
  long y;
  long z;
};

Position STARTING_POINT = {26, 317, 171};

Position positions[18] = {
  {53, 125, 1846},    {53, 0, 1846},
  {1230, 133, 1846},  {1230, 0, 1846},
  {2400, 161, 1846},  {2400, 0, 1846},

  {12, 1313, 1846},   {12, 1025, 1846},
  {1234, 1273, 1846}, {1234, 1121, 1846},
  {2406, 1317, 1846}, {2406, 1069, 1846},

  {0, 2521, 1846},    {0, 2285, 1846},
  {1178, 2501, 1846}, {1178, 2305, 1846},
  {2402, 2525, 1846}, {2402, 2257, 1846}
};

// ================= REPLY TO PC + ESP =================

void reply(String msg) {
  Serial.println(msg);
  Serial1.println(msg);
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);

  pinMode(PIR_PIN, INPUT);
  dht.begin();

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  beltRunning = false;

  pinMode(IRFIRST, INPUT_PULLUP);
  pinMode(IRLAST, INPUT_PULLUP);

  pinMode(LOC_MUX_OUT, INPUT_PULLUP);
  pinMode(LOC_SEL0, OUTPUT);
  pinMode(LOC_SEL1, OUTPUT);

  pinMode(DISP_PUL, OUTPUT);
  pinMode(DISP_DIR, OUTPUT);
  pinMode(DISP_ENA, OUTPUT);
  digitalWrite(DISP_ENA, LOW);
  digitalWrite(DISP_DIR, DISP_DIRECTION);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  pinMode(X_PUL, OUTPUT);
  pinMode(X_DIR, OUTPUT);
  pinMode(X_ENA, OUTPUT);
  pinMode(X_LIM, INPUT_PULLUP);

  pinMode(Y_PUL, OUTPUT);
  pinMode(Y_DIR, OUTPUT);
  pinMode(Y_ENA, OUTPUT);
  pinMode(Y_LIM, INPUT_PULLUP);

  pinMode(Z_PUL, OUTPUT);
  pinMode(Z_DIR, OUTPUT);
  pinMode(Z_ENA, OUTPUT);
  pinMode(Z_LIM_SAFE, INPUT_PULLUP);

  enableDrivers();

  Serial.println("System Starting...");
  delay(6000);

  lastMotionState = digitalRead(PIR_PIN);

  Serial.println("START HOMING...");
  homeAll();

  Serial.println("GO STARTING POINT...");
  goStartingPoint();

  reply("READY");
  printHelp();
}

void loop() {
  updateSensors();

  readCommandFrom(Serial);
  readCommandFrom(Serial1);

  if (autoMode) {
    runAutoCycle();
  }
}

// ================= READ COMMAND =================

void readCommandFrom(Stream &port) {
  if (port.available()) {
    input = port.readStringUntil('\n');
    input.trim();
    input.toUpperCase();

    if (input.length() > 0) {
      handleCommand(input);
    }
  }
}

// ================= COMMANDS =================

void handleCommand(String cmd) {
  if (cmd == "HELP") {
    printHelp();
    reply("DONE:HELP");
  }

  else if (cmd == "AUTO" || cmd == "START_AUTOMATION") {
    // STEP 1:
    // Start conveyor and stop exactly at IRFIRST.
    // Raspberry reads OCR while the box is stopped at camera.
    autoMode = true;
    waitingForWebsiteDecision = false;
    movingToIRLast = false;

    if (!beltRunning) {
      beltToggle();
    }

    reply("OK AUTO STARTED - BELT ON UNTIL IRFIRST");
  }

  else if (cmd == "STOP" || cmd == "STOP_AUTOMATION") {
    autoMode = false;
    waitingForWebsiteDecision = false;
    movingToIRLast = false;

    if (beltRunning) {
      beltToggle();
    }

    reply("OK AUTO STOPPED - BELT OFF");
  }

  else if (cmd == "HOME" || cmd == "H") {
    autoMode = false;
    homeAll();
    reply("DONE:HOME");
  }

  else if (cmd == "START" || cmd == "S") {
    goStartingPoint();
    reply("DONE:START");
  }

  else if (cmd == "BELT_START" || cmd == "BON") {
    if (!beltRunning) {
      beltToggle();
    }
    reply("DONE:BELT_START");
  }

  else if (cmd == "BELT_STOP" || cmd == "BOFF") {
    if (beltRunning) {
      beltToggle();
    }
    reply("DONE:BELT_STOP");
  }

  else if (
    cmd == "BELT_RUN_UNTIL_IR_LAST" ||
    cmd == "BELT_RUN_UNTIL_IRLAST" ||
    cmd == "BELT_RUN_UNTIL_LAST" ||
    cmd == "MOVE_TO_IRLAST" ||
    cmd == "MOVE_TO_IR_LAST" ||
    cmd == "BELT_RUN_UNTIL_IR_LIFTER" ||
    cmd == "BELT_RUN_UNTIL_IRLIFTER"
  ) {
    // STEP 2:
    // Website sends this only after Raspberry confirms OCR and website decides/starts processing.
    // Continue conveyor from IRFIRST area until IRLAST, then stop.
    runBeltUntilIRLast(45000);
  }

  else if (cmd == "BELT" || cmd == "B") {
    beltToggle();
    reply("DONE:BELT");
  }

  else if (cmd.startsWith("BELT_RUN_MS")) {
    int ms = cmd.substring(11).toInt();
    if (ms <= 0) ms = 3000;

    if (!beltRunning) beltToggle();
    delay(ms);
    if (beltRunning) beltToggle();

    reply("DONE:BELT_RUN_MS");
  }

  else if (cmd == "DROP_TO_LIFTER") {
    if (!beltRunning) beltToggle();
    delay(3000);
    if (beltRunning) beltToggle();

    reply("DONE:DROP_TO_LIFTER");
  }

  else if (cmd == "DISPENSE" || cmd == "D") {
    dispenseOne();
    reply("DONE:DISPENSE");
  }

  else if (cmd == "SCAN" || cmd == "CAMERA") {
    sendCameraScan();
    reply("DONE:SCAN");
  }

  else if (cmd == "STATUS") {
    printStatus();
    reply("DONE:STATUS");
  }

  else if (cmd == "TESTIR") {
    testIRs();
    reply("DONE:TESTIR");
  }

  else if (cmd == "TESTLIM") {
    testLimits();
    reply("DONE:TESTLIM");
  }

  else if (cmd == "ULTRA") {
    float d = readAverageDistanceCM();
    Serial.print("ULTRA = ");
    Serial.print(d);
    Serial.println(" cm");

    Serial1.print("ULTRA = ");
    Serial1.print(d);
    Serial1.println(" cm");

    reply("DONE:ULTRA");
  }

  else if (cmd.startsWith("VERIFY_LOCATION ")) {
    int id = cmd.substring(16).toInt();
    bool detected = false;

    if (id == 9) detected = readLocationIR(0);
    else if (id == 8) detected = readLocationIR(1);
    else if (id == 7) detected = readLocationIR(2);
    else detected = true;

    if (detected) {
      reply("DONE:VERIFY_LOCATION DETECTED");
    } else {
      reply("DONE:VERIFY_LOCATION CLEAR");
    }
  }

  else if (cmd.startsWith("GO ")) {
    int n = cmd.substring(3).toInt();

    if (n >= 1 && n <= 18) {
      goPosition(n);
      reply("DONE:" + String(n));
    } else {
      reply("ERROR:BAD_POSITION");
    }
  }

  else if (cmd.startsWith("SITE ")) {
    int site = cmd.substring(5).toInt();

    if (site >= 1 && site <= 9) {
      int inPos = site * 2 - 1;
      int outPos = site * 2;

      goPosition(inPos);
      goPosition(outPos);
      goStartingPoint();

      reply("DONE:SITE " + String(site));
    } else {
      reply("ERROR:BAD_SITE");
    }
  }

  else {
    int n = cmd.toInt();

    if (n >= 1 && n <= 18) {
      goPosition(n);
      reply("DONE:" + String(n));
    } else {
      reply("ERROR:UNKNOWN_COMMAND");
    }
  }
}

// ================= SENSORS =================

void updateSensors() {
  if (millis() - lastSensorSend < SENSOR_INTERVAL) return;
  lastSensorSend = millis();

  int pirRaw = digitalRead(PIR_PIN);

  if (pirRaw == HIGH) {
    lastMotionTime = millis();
    motionAlarm = true;

    if (lastMotionState == LOW) {
      Serial.println("Motion Detected!");
    }

    lastMotionState = HIGH;
  }

  if (millis() - lastMotionTime > MOTION_ALARM_HOLD) {
    if (lastMotionState == HIGH) {
      Serial.println("No Motion");
    }

    motionAlarm = false;
    lastMotionState = LOW;
  }

  int motionState = motionAlarm ? HIGH : LOW;

  int waterValue = analogRead(WATER_SENSOR);
  int mq3Value = analogRead(MQ3_PIN);
  int mq135Value = analogRead(MQ135_PIN);

  float temp = dht.readTemperature();
  float humidity = dht.readHumidity();

  bool dhtOk = !(isnan(temp) || isnan(humidity));

  if (!dhtOk) {
    temp = -1;
    humidity = -1;
  }

  float ultraCm = readAverageDistanceCM();
  bool ultrasonicReady = ultraCm > 0 && ultraCm <= 18.0;

  String data = "{";
  data += "\"motion\":" + String(motionState == HIGH ? 1 : 0) + ",";
  data += "\"waterValue\":" + String(waterValue) + ",";
  data += "\"waterDetected\":" + String(waterValue > waterThreshold ? "true" : "false") + ",";
  data += "\"mq3\":" + String(mq3Value) + ",";
  data += "\"mq135\":" + String(mq135Value) + ",";
  data += "\"temperature\":" + String(temp, 2) + ",";
  data += "\"humidity\":" + String(humidity, 2) + ",";
  data += "\"dhtOk\":" + String(dhtOk ? "true" : "false") + ",";
  data += "\"belt\":" + String(beltRunning ? 1 : 0) + ",";
  data += "\"irFirst\":" + String(readIRFIRST()) + ",";
  data += "\"irLast\":" + String(readIRLAST()) + ",";
  data += "\"irCamera\":" + String(readIRFIRST() ? "true" : "false") + ",";
  data += "\"irLifter\":" + String(readIRLAST() ? "true" : "false") + ",";
  data += "\"loc7Detected\":" + String(readLocationIR(2) ? "true" : "false") + ",";
  data += "\"loc8Detected\":" + String(readLocationIR(1) ? "true" : "false") + ",";
  data += "\"loc9Detected\":" + String(readLocationIR(0) ? "true" : "false") + ",";
  data += "\"atStartingPoint\":" + String(currentPositionIndex == -1 ? "true" : "false") + ",";
  data += "\"ultrasonicCm\":" + String(ultraCm, 2) + ",";
  data += "\"ultrasonicReady\":" + String(ultrasonicReady ? "true" : "false") + ",";
  data += "\"x\":" + String(currentX) + ",";
  data += "\"y\":" + String(currentY) + ",";
  data += "\"z\":" + String(currentZ);
  data += "}";

  Serial.println(data);
  Serial1.println(data);
}

// ================= IR READINGS =================

int readIRFIRST() {
  if (digitalRead(IRFIRST) == LOW) return 1;
  return 0;
}

int readIRLAST() {
  if (digitalRead(IRLAST) == LOW) return 1;
  return 0;
}

bool irFirstDetected() {
  return readIRFIRST() == 1;
}

bool irLastDetected() {
  return readIRLAST() == 1;
}


// ================= BELT RUN UNTIL LAST IR =================

bool readStopCommandDuringBeltWait(Stream &port) {
  if (!port.available()) return false;

  String tempCmd = port.readStringUntil('\n');
  tempCmd.trim();
  tempCmd.toUpperCase();

  return (
    tempCmd == "STOP" ||
    tempCmd == "STOP_AUTOMATION" ||
    tempCmd == "BELT_STOP" ||
    tempCmd == "BOFF"
  );
}

void runBeltUntilIRLast(unsigned long timeoutMs) {
  autoMode = false;
  waitingForWebsiteDecision = false;
  movingToIRLast = true;

  reply("BELT_RUN_UNTIL_IR_LAST_STARTED");

  if (irLastDetected()) {
    if (beltRunning) {
      beltToggle();
    }
    movingToIRLast = false;
    reply("DONE:BELT_RUN_UNTIL_IR_LAST");
    return;
  }

  if (!beltRunning) {
    beltToggle();
  }

  unsigned long startedAt = millis();

  while (!irLastDetected()) {
    updateSensors();

    if (readStopCommandDuringBeltWait(Serial) || readStopCommandDuringBeltWait(Serial1)) {
      if (beltRunning) {
        beltToggle();
      }
      movingToIRLast = false;
      reply("ERROR:BELT_RUN_UNTIL_IR_LAST_STOPPED");
      return;
    }

    if (millis() - startedAt > timeoutMs) {
      if (beltRunning) {
        beltToggle();
      }
      movingToIRLast = false;
      reply("ERROR:BELT_RUN_UNTIL_IR_LAST_TIMEOUT");
      return;
    }

    delay(20);
  }

  if (beltRunning) {
    beltToggle();
  }

  movingToIRLast = false;
  reply("DONE:BELT_RUN_UNTIL_IR_LAST");
}


// ================= AUTO SEQUENCE =================

void runAutoCycle() {
  if (!beltRunning) {
    beltToggle();
  }

  Serial.println("AUTO: BELT RUNNING UNTIL IRFIRST");

  while (!irFirstDetected()) {
    updateSensors();
    readCommandFrom(Serial);
    readCommandFrom(Serial1);

    if (!autoMode) {
      if (beltRunning) {
        beltToggle();
      }
      return;
    }
  }

  Serial.println("AUTO: IRFIRST DETECTED - STOP BELT");

  if (beltRunning) {
    beltToggle();
  }

  autoMode = false;
  waitingForWebsiteDecision = true;
  movingToIRLast = false;

  // Now Raspberry should read OCR and website should send BELT_RUN_UNTIL_IR_LAST.
  reply("OK AUTO STEP 1 DONE IRFIRST");
}

// ================= BELT =================

void relayPulse() {
  digitalWrite(RELAY_PIN, HIGH);
  delay(500);
  digitalWrite(RELAY_PIN, LOW);
}

void beltToggle() {
  relayPulse();
  beltRunning = !beltRunning;
  Serial.println(beltRunning ? "BELT STATE = ON" : "BELT STATE = OFF");
  Serial1.println(beltRunning ? "BELT STATE = ON" : "BELT STATE = OFF");
}

// ================= DISPENSER =================

void dispenseOne() {
  digitalWrite(DISP_ENA, LOW);
  digitalWrite(DISP_DIR, DISP_DIRECTION);

  for (long i = 0; i < DISP_STEPS_ONE_SHOE; i++) {
    pulse(DISP_PUL, DISP_DELAY);
  }
}

// ================= CAMERA =================

void sendCameraScan() {
  reply("CAMERA_SCAN");
}

// ================= LOCATION IR MUX =================

bool readLocationIR(byte channel) {
  if (channel > 2) return false;

  digitalWrite(LOC_SEL0, channel & 1);
  digitalWrite(LOC_SEL1, (channel >> 1) & 1);

  delay(5);

  int detectedCount = 0;

  for (int i = 0; i < 7; i++) {
    if (digitalRead(LOC_MUX_OUT) == LOW) {
      detectedCount++;
    }
    delay(2);
  }

  return detectedCount >= 5;
}

void printLocationIRs() {
  Serial.print("LOCATION 9 IR = ");
  Serial.println(readLocationIR(0) ? "DETECTED" : "CLEAR");

  Serial.print("LOCATION 8 IR = ");
  Serial.println(readLocationIR(1) ? "DETECTED" : "CLEAR");

  Serial.print("LOCATION 7 IR = ");
  Serial.println(readLocationIR(2) ? "DETECTED" : "CLEAR");
}

// ================= POSITIONS =================

void goStartingPoint() {
  Serial.println("GO STARTING POINT");

  moveToXYZ(
    STARTING_POINT.x,
    STARTING_POINT.y,
    STARTING_POINT.z
  );

  currentPositionIndex = -1;
  Serial.println("DONE STARTING POINT");
}

void goPosition(int n) {
  Serial.print("GO POSITION ");
  Serial.println(n);

  if (isSamePairInOut(currentPositionIndex, n)) {
    Serial.println("SAME SITE IN/OUT - NO Z HOME");

    moveDirectXYThenZ(
      positions[n - 1].x,
      positions[n - 1].y,
      positions[n - 1].z
    );
  } else {
    moveToXYZ(
      positions[n - 1].x,
      positions[n - 1].y,
      positions[n - 1].z
    );
  }

  currentPositionIndex = n;

  Serial.print("DONE POSITION ");
  Serial.println(n);
}

bool isSamePairInOut(int currentPos, int targetPos) {
  if (currentPos < 1 || currentPos > 18) return false;
  if (targetPos < 1 || targetPos > 18) return false;

  int currentPair = (currentPos + 1) / 2;
  int targetPair = (targetPos + 1) / 2;

  return currentPair == targetPair && currentPos != targetPos;
}

// ================= MOVE LOGIC =================

void moveToXYZ(long targetX, long targetY, long targetZ) {
  targetX = constrain(targetX, 0, MAX_X_STEPS);
  targetY = constrain(targetY, 0, MAX_Y_STEPS);
  targetZ = constrain(targetZ, 0, MAX_Z_STEPS);

  moveZToSafeHome();

  moveAxisTo('X', targetX);
  moveAxisTo('Y', targetY);
  moveAxisTo('Z', targetZ);

  printCurrent();
}

void moveDirectXYThenZ(long targetX, long targetY, long targetZ) {
  targetX = constrain(targetX, 0, MAX_X_STEPS);
  targetY = constrain(targetY, 0, MAX_Y_STEPS);
  targetZ = constrain(targetZ, 0, MAX_Z_STEPS);

  moveAxisTo('X', targetX);
  moveAxisTo('Y', targetY);
  moveAxisTo('Z', targetZ);

  printCurrent();
}

void moveZToSafeHome() {
  Serial.println("Z SAFE HOME D26...");

  digitalWrite(Z_DIR, HIGH);

  while (!zSafeLimitPressed()) {
    updateSensors();
    pulse(Z_PUL, Z_DELAY);
  }

  currentZ = 0;
  Serial.println("Z SAFE DONE");
}

void moveAxisTo(char axis, long target) {
  long *current;
  int pulPin;
  int delayTime;

  if (axis == 'X') {
    current = &currentX;
    pulPin = X_PUL;
    delayTime = X_DELAY;
    digitalWrite(X_DIR, target > currentX ? LOW : HIGH);
  }

  else if (axis == 'Y') {
    current = &currentY;
    pulPin = Y_PUL;
    delayTime = Y_DELAY;
    digitalWrite(Y_DIR, target > currentY ? LOW : HIGH);
  }

  else if (axis == 'Z') {
    current = &currentZ;
    pulPin = Z_PUL;
    delayTime = Z_DELAY;
    digitalWrite(Z_DIR, target > currentZ ? LOW : HIGH);
  }

  else {
    return;
  }

  while (*current != target) {
    updateSensors();

    if (*current < target) {
      pulse(pulPin, delayTime);
      (*current)++;
    } else {
      if (axis == 'X' && xLimitPressed()) {
        currentX = 0;
        return;
      }

      if (axis == 'Y' && yLimitPressed()) {
        currentY = 0;
        return;
      }

      if (axis == 'Z' && zSafeLimitPressed()) {
        currentZ = 0;
        return;
      }

      pulse(pulPin, delayTime);
      (*current)--;
    }
  }
}

// ================= HOMING =================

void homeAll() {
  homeZ();
  homeX();
  homeY();
  printCurrent();
}

void homeZ() {
  Serial.println("HOMING Z D26...");

  digitalWrite(Z_DIR, HIGH);

  while (!zSafeLimitPressed()) {
    updateSensors();
    pulse(Z_PUL, Z_DELAY);
  }

  currentZ = 0;
  Serial.println("Z HOME DONE");
}

void homeX() {
  Serial.println("HOMING X...");

  digitalWrite(X_DIR, HIGH);

  while (!xLimitPressed()) {
    updateSensors();
    pulse(X_PUL, X_DELAY);
  }

  currentX = 0;
  Serial.println("X HOME DONE");
}

void homeY() {
  Serial.println("HOMING Y...");

  digitalWrite(Y_DIR, HIGH);

  while (!yLimitPressed()) {
    updateSensors();
    pulse(Y_PUL, Y_DELAY);
  }

  currentY = 0;
  Serial.println("Y HOME DONE");
}

// ================= LIMITS =================

bool xLimitPressed() {
  return digitalRead(X_LIM) == HIGH;
}

bool yLimitPressed() {
  return digitalRead(Y_LIM) == HIGH;
}

bool zSafeLimitPressed() {
  return digitalRead(Z_LIM_SAFE) == HIGH;
}

// ================= ULTRASONIC =================

float readAverageDistanceCM() {
  float sum = 0;
  int count = 0;

  for (int i = 0; i < 7; i++) {
    float d = readUltrasonicCM();

    if (d > 0) {
      sum += d;
      count++;
    }

    delay(40);
  }

  if (count == 0) return -1;

  return sum / count;
}

float readUltrasonicCM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000);

  if (duration == 0) return -1;

  return duration * 0.0343 / 2.0;
}

// ================= HELPERS =================

void pulse(int pin, int d) {
  digitalWrite(pin, HIGH);
  delayMicroseconds(d);
  digitalWrite(pin, LOW);
  delayMicroseconds(d);
}

void enableDrivers() {
  digitalWrite(X_ENA, LOW);
  digitalWrite(Y_ENA, LOW);
  digitalWrite(Z_ENA, LOW);
}

void printCurrent() {
  Serial.print("POS X=");
  Serial.print(currentX);
  Serial.print(" Y=");
  Serial.print(currentY);
  Serial.print(" Z=");
  Serial.println(currentZ);
}

void printStatus() {
  Serial.println("===== STATUS =====");

  Serial.print("AUTO = ");
  Serial.println(autoMode ? "ON" : "OFF");

  Serial.print("BELT TRACKED STATE = ");
  Serial.println(beltRunning ? "ON" : "OFF");

  Serial.print("WAITING WEBSITE DECISION = ");
  Serial.println(waitingForWebsiteDecision ? "YES" : "NO");

  Serial.print("MOVING TO IRLAST = ");
  Serial.println(movingToIRLast ? "YES" : "NO");

  Serial.print("IRFIRST = ");
  Serial.println(readIRFIRST() == 1 ? "DETECTED" : "CLEAR");

  Serial.print("IRLAST = ");
  Serial.println(readIRLAST() == 1 ? "DETECTED" : "CLEAR");

  printLocationIRs();
  printCurrent();
}

void testIRs() {
  Serial.print("IRFIRST = ");
  Serial.println(readIRFIRST() == 1 ? "DETECTED" : "CLEAR");

  Serial.print("IRLAST = ");
  Serial.println(readIRLAST() == 1 ? "DETECTED" : "CLEAR");

  printLocationIRs();
}

void testLimits() {
  Serial.print("X LIM D22 = ");
  Serial.println(digitalRead(X_LIM));

  Serial.print("Y LIM D24 = ");
  Serial.println(digitalRead(Y_LIM));

  Serial.print("Z SAFE D26 = ");
  Serial.println(digitalRead(Z_LIM_SAFE));

  testIRs();

  Serial.print("ULTRA = ");
  Serial.print(readAverageDistanceCM());
  Serial.println(" cm");
}

void printHelp() {
  Serial.println("Commands:");
  Serial.println("AUTO / START_AUTOMATION = run belt until IRFIRST, then stop for OCR");
  Serial.println("STOP / STOP_AUTOMATION");
  Serial.println("HOME / H");
  Serial.println("START / S");
  Serial.println("BELT_START / BON");
  Serial.println("BELT_STOP / BOFF");
  Serial.println("BELT / B = TOGGLE");
  Serial.println("BELT_RUN_MS 3000");
  Serial.println("BELT_RUN_UNTIL_IR_LAST = continue belt from IRFIRST to IRLAST, then stop");
  Serial.println("DROP_TO_LIFTER");
  Serial.println("DISPENSE / D");
  Serial.println("CAMERA / SCAN");
  Serial.println("SITE 1 to SITE 9");
  Serial.println("GO 1 to GO 18");
  Serial.println("STATUS");
  Serial.println("TESTIR");
  Serial.println("TESTLIM");
  Serial.println("ULTRA");
  Serial.println("VERIFY_LOCATION 7/8/9");
}
