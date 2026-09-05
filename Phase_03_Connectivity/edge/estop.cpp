#include <Arduino.h>
#include <Preferences.h>
#include "estop.h"
#include "pins.h"

static EstopState st;
static Preferences prefs;

void estopInit() {
  digitalWrite(PIN_ESTOP_LED, LOW);
  pinMode(PIN_ESTOP_LED, OUTPUT);

  st = { false, ORIGIN_REMOTE, 0, 0, false };

  // Namespace "estop", read-only open. If the namespace has never been
  // written, open() returns false — that is the "absent" case.
  if (prefs.begin("estop", true)) {
    if (prefs.isKey("active")) {
      st.active    = prefs.getBool("active", false);
      // Absent origin key with active=true is the corrupt case → stays REMOTE.
      st.origin    = prefs.isKey("origin")
                     ? (EstopOrigin)prefs.getUChar("origin", ORIGIN_REMOTE)
                     : ORIGIN_REMOTE;
      st.since     = prefs.getULong("since", 0);
      st.seq       = prefs.getULong("seq", 0);
      st.nvs_valid = prefs.isKey("origin");
    }
    prefs.end();
  }

  estopDriveLed();
}

const EstopState& estopGet() { return st; }

void estopDriveLed() {
  digitalWrite(PIN_ESTOP_LED, st.active ? HIGH : LOW);
}
