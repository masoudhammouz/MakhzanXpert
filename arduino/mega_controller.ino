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

#define IR_START_PIN 40
#define IR_END_PIN 25
#define IR_DETECTED_STATE LOW

bool beltRunning = false;
bool autoMode = false;

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

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);

  pinMode(PIR_PIN, INPUT);
  dht.begin();

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);

  pinMode(IR_START_PIN, INPUT_PULLUP);
  pinMode(IR_END_PIN, INPUT_PULLUP);

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

  Serial.println("READY");
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
  }

  else if (cmd == "AUTO") {
    autoMode = true;
    Serial.println("OK AUTO STARTED");
  }

  else if (cmd == "STOP") {
    autoMode = false;
    Serial.println("OK AUTO STOPPED");
  }

  else if (cmd == "HOME" || cmd == "H") {
    autoMode = false;
    homeAll();
    Serial.println("OK HOME");
  }

  else if (cmd == "START" || cmd == "S") {
    goStartingPoint();
    Serial.println("OK STARTING POINT");
  }

  else if (cmd == "BELT_START" || cmd == "BON") {
    beltToggle();
    Serial.println("OK BELT_START TOGGLE");
  }

  else if (cmd == "BELT_STOP" || cmd == "BOFF") {
    beltToggle();
    Serial.println("OK BELT_STOP TOGGLE");
  }

  else if (cmd == "BELT" || cmd == "B") {
    beltToggle();
    Serial.println("OK BELT TOGGLE");
  }

  else if (cmd == "DISPENSE" || cmd == "D") {
    dispenseOne();
    Serial.println("OK DISPENSE");
  }

  else if (cmd == "SCAN" || cmd == "CAMERA") {
    sendCameraScan();
    Serial.println("OK CAMERA SCAN");
  }

  else if (cmd == "STATUS") {
    printStatus();
  }

  else if (cmd == "TESTIR") {
    testIRs();
  }

  else if (cmd == "TESTLIM") {
    testLimits();
  }

  else if (cmd == "ULTRA") {
    Serial.print("ULTRA = ");
    Serial.print(readAverageDistanceCM());
    Serial.println(" cm");
  }

  else if (cmd.startsWith("GO ")) {
    int n = cmd.substring(3).toInt();

    if (n >= 1 && n <= 18) {
      goPosition(n);
      Serial.print("OK GO ");
      Serial.println(n);
    } else {
      Serial.println("ERROR BAD POSITION");
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

      Serial.print("OK SITE ");
      Serial.println(site);
    } else {
      Serial.println("ERROR BAD SITE");
    }
  }

  else {
    int n = cmd.toInt();

    if (n >= 1 && n <= 18) {
      goPosition(n);
    } else {
      Serial.println("ERROR UNKNOWN COMMAND");
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
  data += "\"x\":" + String(currentX) + ",";
  data += "\"y\":" + String(currentY) + ",";
  data += "\"z\":" + String(currentZ);
  data += "}";

  Serial.println(data);
  Serial1.println(data);
}

// ================= AUTO SEQUENCE =================

void runAutoCycle() {
  Serial.println("AUTO: DISPENSE");
  dispenseOne();

  Serial.println("AUTO: BELT TOGGLE ON");
  beltToggle();

  while (!irStartDetected()) {
    updateSensors();
    readCommandFrom(Serial);
    readCommandFrom(Serial1);
    if (!autoMode) return;
  }

  Serial.println("AUTO: START IR DETECTED");

  while (!irEndDetected()) {
    updateSensors();
    readCommandFrom(Serial);
    readCommandFrom(Serial1);
    if (!autoMode) return;
  }

  Serial.println("AUTO: END IR DETECTED");

  Serial.println("AUTO: BELT TOGGLE OFF");
  beltToggle();

  sendCameraScan();

  Serial.println("AUTO: WAITING RPI RESULT");
  Serial.println("RPI SEND: SITE 1 TO SITE 9");

  autoMode = false;
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
}

bool irStartDetected() {
  return digitalRead(IR_START_PIN) == IR_DETECTED_STATE;
}

bool irEndDetected() {
  return digitalRead(IR_END_PIN) == IR_DETECTED_STATE;
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
  Serial.println("CAMERA_SCAN");
}

// ================= LOCATION IR MUX =================

bool readLocationIR(byte channel) {
  if (channel > 3) return false;

  digitalWrite(LOC_SEL0, channel & 1);
  digitalWrite(LOC_SEL1, (channel >> 1) & 1);

  delayMicroseconds(50);

  return digitalRead(LOC_MUX_OUT) == IR_DETECTED_STATE;
}

void printLocationIRs() {
  Serial.print("LOC IR 1 CH0 = ");
  Serial.println(readLocationIR(0) ? "DETECTED" : "CLEAR");

  Serial.print("LOC IR 2 CH1 = ");
  Serial.println(readLocationIR(1) ? "DETECTED" : "CLEAR");

  Serial.print("LOC IR 3 CH2 = ");
  Serial.println(readLocationIR(2) ? "DETECTED" : "CLEAR");

  Serial.print("LOC IR CH3 EMPTY = ");
  Serial.println(readLocationIR(3) ? "DETECTED" : "CLEAR");
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

  Serial.print("IR START D40 = ");
  Serial.println(irStartDetected() ? "DETECTED" : "CLEAR");

  Serial.print("IR END D25 = ");
  Serial.println(irEndDetected() ? "DETECTED" : "CLEAR");

  printLocationIRs();
  printCurrent();
}

void testIRs() {
  Serial.print("IR START D40 = ");
  Serial.println(digitalRead(IR_START_PIN));

  Serial.print("IR END D25 = ");
  Serial.println(digitalRead(IR_END_PIN));

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
  Serial.println("AUTO");
  Serial.println("STOP");
  Serial.println("HOME / H");
  Serial.println("START / S");
  Serial.println("BELT_START / BON = TOGGLE");
  Serial.println("BELT_STOP / BOFF = TOGGLE");
  Serial.println("BELT / B = TOGGLE");
  Serial.println("DISPENSE / D");
  Serial.println("CAMERA / SCAN");
  Serial.println("SITE 1 to SITE 9");
  Serial.println("GO 1 to GO 18");
  Serial.println("STATUS");
  Serial.println("TESTIR");
  Serial.println("TESTLIM");
  Serial.println("ULTRA");
}