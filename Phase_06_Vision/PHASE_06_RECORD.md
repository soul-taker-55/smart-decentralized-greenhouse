# PHASE 06 RECORD — Vision Node (ESP32-CAM)

**Status:** device firmware live, server tier deployed to `greenhouse.progrex.tech`,
scheduled upload path verified end to end on real hardware. One path — the
manual snapshot request — is **built but not yet confirmed working**.
**Commits:** `e10f429` … `3a696ea` (20 commits, 3–4 September 2026). Base: `77988d4`.
**Hardware:** AI-Thinker ESP32-CAM, MAC `B4:BF:E9:34:4C:18`, 4 MB flash, PSRAM present.

This record states what was decided, what was found, what was wrong, and what
was observed — in that order.

---

## 1. What Phase 06 contributes — stated narrowly

A camera that photographs the enclosure on a schedule, uploads over HTTPS, and
presents its history in the dashboard.

It contributes **nothing to control**. The vision node cannot move an actuator,
cannot approve a config, and holds no role in the RBAC matrix. If it fails
entirely, the greenhouse is unaffected. That isolation is the point, and it is
enforced structurally rather than by convention: `camera_images` has no
relationship to `config_profiles` or `commands`, and the device's credential
(`device-auth.js`) is checked by a module that imports nothing from `auth.js`
and exports nothing to it.

What it does not yet contribute: any analysis. Green coverage, leaf area and
growth measurement are **not built**. This phase produces the dataset those
would need; it does not consume it.

---

## 2. The hardware is not what it was sold as

**The board is labelled ESP32-CAM with an OV2640. The sensor is not an OV2640.**

Sensor PID reads `0x2145` — OV7670-class. The distinguishing property, and the
one that mattered: **it has no hardware JPEG encoder.**

This was discovered the hard way. `esp_camera_init()` failed with `0x106` and
the driver's own message was misleading:

```
E (1958) camera: JPEG format is not supported on this sensor
[CAM] init FAILED 0x106
```

Read carelessly, "not supported on this sensor" suggests a misidentified or
faulty sensor. It means exactly what it says: the sensor was identified
correctly and cannot produce JPEG. The fix was a format change
(`PIXFORMAT_JPEG` → `PIXFORMAT_RGB565`), not a hardware change.

The diagnostic that settled it was a controlled comparison, not reasoning:

| camera connected | camera physically removed |
|---|---|
| `JPEG format is not supported on this sensor` | `Detected camera not supported` |

Two different messages means the driver was reading the sensor successfully in
one case and not at all in the other. That distinction is what ruled out a
connection fault.

### The consequence, measured

Raw RGB565 at QVGA is 153,600 bytes per frame — too large to upload at any
useful interval. Software encoding via `frame2jpg()` was chosen over buying a
genuine OV2640, because a replacement part was not available.

Measured on the device:

```
[JPG] #1  raw 153600 B -> jpg 7160 B  (21.5x)  104 ms  heap 173216
[JPG] #2  raw 153600 B -> jpg 7338 B  (20.9x)  103 ms  heap 172952
[JPG] #3  raw 153600 B -> jpg 7299 B  (21.0x)  101 ms  heap 172952
[JPG] #4  raw 153600 B -> jpg 7250 B  (21.2x)  100 ms  heap 172952
```

**~7 KB per frame, ~100 ms encode, heap flat across frames.** At one frame per
day that is roughly 2.5 MB a year.

This is worth stating plainly for the thesis: the workaround is not a
compromise in outcome. The bandwidth objection to a JPEG-less sensor
disappeared once the numbers were measured. It cost ~100 ms of CPU on a device
with no latency requirement. **The case for replacing the sensor is weaker
after measurement than it was before it** — which is the opposite of what was
assumed when the mismatch was found.

---

## 3. Two hardware faults that were not code faults

Both cost significant time and both were diagnosed wrongly at first. Recording
them because the wrong diagnoses are as instructive as the right ones.

### 3.1 The flash failure was a 5 V/3.3 V miswiring

Symptom: `esptool` connected, identified the chip, wrote the bootloader, then
failed verification with the **same MD5 every time**:

```
Input MD5: 42863d8b59e70f04bf1f3b0d5aae512e
Flash MD5: 7122cb1ef38a66d8813a9f9913af4682
```

Four theories were proposed and all four were wrong: serial noise, baud rate,
flash write-protection, and a counterfeit flash die. Each was ruled out by
evidence — the status register read `0x0000` (no protection), the failure
persisted at 115200 as well as 460800 (not baud), and the identical MD5 across
attempts ruled out random noise.

The actual cause: **the module was wired to 3.3 V instead of 5 V.** Enough to
boot, enough to talk over UART, not enough for the flash die to complete
writes.

The diagnostic signal that should have been weighted higher, and was noticed
but dropped:

```
Erasing flash memory (this may take a while)...
Flash memory erased successfully in 0.0 seconds.
```

A real erase of 4 MB does not complete in 0.0 seconds. That line was visible
from the first failed attempt.

### 3.2 The brownout was FTDI-supplied power

After flashing worked, the first upload succeeded and the second reset the
board:

```
[UP ] OK  status 201  1841 ms  (ok=1 fail=0)
[JPG] #2  7798 B  heap 157472
E BOD: Brownout detector was triggered
```

The upload path draws more current than anything tested before it: capture,
software JPEG encode, TLS handshake and WiFi transmit all inside a few hundred
milliseconds. The FTDI adapter's 5 V pin could not supply the spike.

Moving the CAM's 5 V and GND to the S-25-5 PSU rail resolved it. Uploads have
run without a brownout since.

**This is not a design flaw discovered — it is the documented power constraint
in the Phase 01 wiring doc arriving on schedule.** The CAM's own solid 5 V feed
was specified before any of this was built. The bench setup violated it.

---

## 4. Design decisions

### 4.1 Polling, not push — forced by the network, not chosen

The server cannot open a connection to the camera. The device sits on its own
WiFi network behind NAT with no inbound port. Every exchange is therefore the
camera asking the server.

This is the same shape as the retained-config pattern in Phase 04/05a — state
the device discovers rather than state delivered to it — arrived at
independently, for the same underlying reason.

It has a visible consequence the UI must not hide: **pressing "Request
snapshot" cannot produce an image immediately.** The dashboard says
"Requested — waiting for the camera to poll" rather than showing a spinner that
would imply a request is in flight to a device nothing can contact.

### 4.2 HTTP POST, not MQTT or RTSP

MQTT would mean a 7 KB binary payload through a broker whose contract (v4) has
no topic for it, plus a new account and ACL entry, for a node that is
deliberately outside the control contract. RTSP would mean a continuous stream
from a brownout-sensitive device for a timelapse use case that needs one frame
a day.

### 4.3 Device auth is separate from user auth, deliberately

`device-auth.js` checks a single static bearer token on two routes only:
`POST /api/camera/upload` and `GET /api/camera/pending`. It grants access to
nothing else.

Keeping it out of `auth.js` is not tidiness. The camera is not a user and holds
no role; folding its credential into the module that implements the ADMIN /
ENGINEER / FARMER matrix would create a path for device-shaped and user-shaped
authority to blur over time. The two dashboard-facing camera routes
(`/latest`, `/days`, `/pending-status`) sit behind `CAP.VIEW` — the same
capability that gates sensor readings, because an image is an observation
available to every role, not an actuation.

`GET /api/camera/pending` and `GET /api/camera/pending-status` return the same
data through two routes for exactly this reason: one authenticates a device by
token, the other a human by session. Sharing one route would require either
handing the dashboard a device token or letting a device token satisfy a
user-facing route.

### 4.4 Metadata is copied at upload, not joined at display

`camera_images.canopy_position` and `.photoperiod_active` are read from
`actuator_state` at the moment of upload and stored on the row.

Joining live would mean a later canopy movement retroactively changes what an
already-captured photograph is understood to show. This mirrors the
retrospective e-stop record pattern from Phase 05b: a record of what was true
when the event happened, immune to what happens after.

**Honest limit:** as of this phase those values come from the Phase 04 mock
edge simulator, which publishes static actuator states. The columns are
populated correctly and mean nothing yet. They become meaningful when Phase 02
firmware runs, with no schema or code change required. A reader must not
mistake "populated" for "true".

### 4.5 Stills, not video

Video was considered and rejected. Without a hardware encoder each frame costs
~100 ms to compress, capping the achievable rate around 8–10 fps before network
overhead; and streaming would require holding a connection open, which the NAT
constraint above rules out.

More decisively: plants change over days. One frame per day at known conditions
is more useful for growth tracking than video, and produces a dataset that can
be analysed rather than a stream that must be watched.

---

## 5. Verified live, on the deployed stack

- Migration `010_camera.sql` applied to `sdigf_backend`; both tables present,
  `camera_pending` seeded with one row.
- `POST /api/camera/upload` **without** a token → `401 device_unauthorized`.
- `POST /api/camera/upload` **with** the token → `201`, row inserted.
- File confirmed on the Docker volume with correct ownership:
  ```
  -rw-r--r-- 1 node node 22 Sep 3 22:10 /data/camera-images/2026/09/1788473442950.jpg
  ```
- Row and file agree on size; `canopy_position` and `photoperiod_active`
  populated from telemetry (`0`, `f`).
- **Real device upload from the ESP32-CAM: `201`, image visible in the
  dashboard.** Full path proven — capture, software encode, HTTPS with device
  token, volume write, database row, rendered page.
- NTP sync working; `x-captured-at` carries a real device timestamp.
- Day-grouped history renders correctly: 9 images across 2 days, Today /
  Yesterday grouping, thumbnail strip, selection.

### A deployment bug found by the first real upload

The first authenticated upload failed:

```
EACCES: permission denied, mkdir '/data/camera-images/2026'
```

The Dockerfile ends with `USER node`, and Docker seeds a new named volume's
ownership from whatever exists at the mount point — which was nothing, so the
volume arrived owned by root. Fixed by creating and chowning the directory in
the image before dropping privileges (`dcdd2d7`).

Note the fix required **deleting the existing volume**, not just redeploying:
Docker only sets ownership when initialising an empty volume.

---

## 6. Open items

### 6.1 The manual snapshot path is unconfirmed

`POST /api/camera/request-snapshot` sets the flag. The firmware polls
`GET /api/camera/pending` every 10 s and should capture with
`x-trigger: manual` on a positive result, which the server clears on receipt.

**Server side is tested. The device-side poll has not been observed working.**
At the time of writing the dashboard shows the flag set and every uploaded
frame marked `schedule`. Either the device is running an older sketch or the
poll is failing — both produce the same visible symptom and neither has been
distinguished, because serial output is currently unreadable (see 6.2).

Do not describe this path as working until a frame with `trigger = 'manual'`
appears in `camera_images`.

### 6.2 Serial monitoring is not connected

Once the CAM was moved to PSU power, the FTDI's ground was left disconnected,
so the serial line has no shared voltage reference and returns garbage. One
wire fixes it — FTDI GND to CAM GND, with the PSU ground also connected.

Consequence while it stays broken: a brownout-and-recover cycle is
indistinguishable from a merely late image, and `[PLL]` diagnostics for 6.1 are
invisible.

### 6.3 TLS certificate validation is off

`WiFiClientSecure::setInsecure()`. The endpoint accepts image uploads gated by
a bearer token; an attacker positioned to intercept could see or drop a JPEG,
not reach any control-path route. Certificate pinning against
`greenhouse.progrex.tech` is future work. Stated in the sketch header rather
than silently skipped.

### 6.4 The device token has been exposed in a chat transcript

It must be rotated: regenerate with `openssl rand -hex 32`, update in Dokploy
and in `secrets.h` together, redeploy.

### 6.5 No retention policy

At one frame a day this is not urgent — a year is a few hundred files and a
few megabytes. It becomes a question if the interval is ever shortened.

### 6.6 No analysis

Green coverage, leaf area, canopy coverage: not built. This phase produces the
dataset; consuming it is separate work and should not be claimed as part of
Phase 06.

---

## 7. Methodology notes

**The board's label was wrong and the driver's error message was misleading.**
The sensor identity was settled by a controlled comparison (camera connected vs
removed), not by trusting either.

**Three diagnostic tools proposed in this phase were themselves wrong**, and
each was withdrawn once its evidence failed to distinguish anything: an SCCB
bus probe that ran after `esp_camera_init` had already powered the sensor down
and therefore reported "no response" in every case; a baud-rate theory
contradicted by the failure persisting at 115200; a write-protection theory
contradicted by a status register reading `0x0000`. A diagnostic that returns
the same answer whether or not the fault is present measures nothing.

**A schema assumption was caught by reading the schema.** The first draft of
`camera-service.js` queried `actuator_state` for a JSONB `state` column on the
backend connection pool. The real table lives in `sdigf_db` (requiring the
read-only `queryTelemetry` pool), stores one row per actuator, and uses
`greenhouse_id`/`time` rather than `gh_id`/`recorded_at`. Every one of those
would have failed at runtime. Corrected before delivery by reading
`sdigf-db-schema-v2.sql` rather than reasoning from the code.

**Two frontend helpers were invented rather than looked up** — `fmtWhen()` for
a function actually named `when()`, and a CSS class `err` that does not exist
where the codebase uses `fielderr`. Both would have failed at build time. Both
were caught by grepping the files before delivery.

**`git add .` was run once during this phase.** It staged nothing dangerous —
`secrets.h` was already protected by a `.gitignore` written before the file
existed, and `git check-ignore -v` confirmed the rule matched on the bare
filename. The staging was reset. The protection held precisely because the
ignore rule preceded the secret.
