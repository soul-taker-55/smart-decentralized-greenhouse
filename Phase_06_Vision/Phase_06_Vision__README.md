# The Camera — A Plain-Language Guide

This explains what the camera does, how it was built, and — just as
importantly — what it deliberately cannot do.

If you read only one section, read the first.

---

## First, the most important thing

**The camera cannot control anything.**

It photographs the inside of the greenhouse. That is all it does. It cannot
turn on a fan, open the shade canopy, run the pump, or change a setting. If
someone replaced every photograph with a picture of a dying plant, nothing in
the greenhouse would move in response.

This is not an accident or a limitation to be fixed later. It is the design.

The reason is that the greenhouse's central promise is that the plants survive
without the server. The control system is deliberately simple, deterministic
and local: thresholds on the controller, running whether or not anything else
in the world is reachable. A camera is the opposite kind of component — it
depends on the network, its output needs interpretation, and interpretation can
be wrong. Letting it act would put an unreliable, network-dependent,
sometimes-wrong component into the path that keeps plants alive.

So the camera **observes and reports. A human decides.**

---

## What it actually is

A second, separate microcontroller — an ESP32-CAM — with its own WiFi
connection. It shares exactly one thing with the greenhouse's main controller:
the 5-volt power supply. No data connection, no shared pins, no shared network
account.

It takes one photograph per day, plus any extra ones a person requests, and
uploads them to the server. The dashboard shows them grouped by day.

---

## Question 1 — "What is the source code?"

### `Phase_06_Vision/6a_cam_firmware/cam_bringup/cam_bringup.ino` — the device

The camera's own program. It starts the camera, joins WiFi, syncs its clock,
then loops: take a photograph, compress it, send it.

### `5a_web/db/010_camera.sql` — where records are kept

Two tables. `camera_images` holds one row per photograph — when it was taken,
how big it is, where the file lives, and what the greenhouse's shade canopy and
grow light were doing at the time. `camera_pending` is a single row holding
whether someone has asked for an extra photograph.

The photographs themselves are **not** stored in the database. They live as
ordinary files on disk, and the database holds the path to each one. Putting
image data in the same table the dashboard queries constantly would make every
unrelated question slower.

### `5a_web/backend/src/services/camera-service.js` — receiving and filing

Writes the file, records the row, groups the history by day.

### `5a_web/backend/src/device-auth.js` — proving which camera

Twelve lines that check one thing: does this upload carry the right password?
Deliberately kept separate from the file that handles human logins, for a
reason explained below.

### `5a_web/backend/src/camera-routes.js` — the endpoints

Five addresses the camera and the dashboard talk to.

### `5a_web/frontend/src/components/ActivityPage.jsx` — the panel

The Camera page: the current photograph large, a list of days, and a strip of
thumbnails for the selected day.

---

## Question 2 — "How does it work?"

### Taking the picture

The camera chip on this board turned out not to be the one the board is
labelled with. The advertised sensor compresses images in hardware; the one
actually fitted does not.

The uncompressed photograph is about 150 kilobytes. Sending one of those every
day would be wasteful, and sending them more often would be worse. So the
compression is done in software instead — the microcontroller does the work the
missing hardware would have done.

It costs about a tenth of a second per photograph and shrinks each one to
roughly 7 kilobytes — about twenty times smaller. For something that takes one
picture a day, a tenth of a second is nothing.

This is worth being straight about: it is a workaround for hardware that was
not what it claimed to be. But after measuring it, the workaround costs almost
nothing, and replacing the sensor would not meaningfully improve the result.

### Sending it

The camera sends each photograph to the server over an encrypted connection,
along with a password that identifies it as the greenhouse's camera and not
some stranger's.

### Why the "Request snapshot" button does not take a picture immediately

This surprises people, so it is worth explaining properly.

**The server cannot contact the camera.** The camera sits on a home network,
behind a router, with no public address. Nothing on the internet can start a
conversation with it — the same reason your laptop is not reachable from the
open internet by default.

So the conversation only ever goes one way. The camera asks the server: "has
anyone requested a photograph?" It asks every ten seconds. When the answer is
yes, it takes one and uploads it.

The button does not send a command to the camera. It writes a note that the
camera will find next time it asks. That is why the page says *"Requested —
waiting for the camera to poll"* rather than showing a loading spinner. A
spinner would be a small lie: it would suggest something is on its way to the
camera, when in truth nothing can be.

### Why the camera has its own password, separate from human logins

People who use this system log in with a username and password and get a role —
administrator, engineer, or farmer — which decides what they can do.

The camera has none of that. It is not a person, it has no role, and it can do
exactly two things: upload a photograph, and ask whether one has been
requested. Its password proves *which camera*, and nothing more.

The code that checks the camera's password is kept in a completely separate
file from the code that checks human logins. If they shared a file, it would be
easy — over months of changes — for the camera to accidentally acquire
human-shaped permissions, or for a human route to accept a camera's password.
Separating them makes that mistake difficult rather than merely unlikely.

---

## Question 3 — "What is stored?"

For each photograph:

- the picture itself, as an ordinary JPEG file
- when it was taken, according to the camera's own clock
- when the server received it
- how large it is
- whether it was the daily scheduled photograph or one someone requested
- who requested it, if anyone
- what the shade canopy position and grow light state were at that moment

That last item exists so a photograph can be understood in context — a picture
taken with the shade closed looks different from one taken with it open, and
that difference should not be mistaken for the plants changing.

**One honest caveat.** Those canopy and light values currently come from a
simulator, not the real greenhouse hardware, because the main controller's
firmware has not been written yet. The values are recorded correctly and mean
nothing yet. They will start meaning something the moment the real controller
runs, with no changes needed here.

---

## What this proves, and what it does not

### It proves

- A photograph reaching the server was uploaded by something holding the
  camera's password.
- The photograph has not been altered since it was written to disk.
- The record of when the server received it is accurate.

### It does not prove

- **That the camera's own clock was right.** The camera reports when it took
  each picture, and the server has no way to check. If the camera's clock is
  wrong, the recorded capture time is wrong. This is the same limitation the
  audit ledger documents elsewhere in this project, in miniature.
- **That the photograph shows what it appears to show.** Nothing verifies that
  the camera is pointed at the greenhouse.
- **Anything about the plants.** No analysis is performed. There is no
  measurement of growth, leaf area or health. Those would be built on top of
  this; they do not exist yet.

---

## What is not finished

- **Requested snapshots are built but not yet confirmed working.** The button
  and the server side are tested. The camera's side of it has not been observed
  working end to end.
- **The connection is encrypted but the server's identity is not verified.**
  The camera accepts whatever certificate it is offered. Since the only thing
  at risk is a photograph, this was judged acceptable for now and recorded
  rather than hidden.
- **No analysis of the images.** As above.

---

## In one paragraph

A second small computer photographs the greenhouse once a day, compresses each
picture in software because the camera chip it shipped with cannot do it in
hardware, and uploads it to the server with a password that identifies it as
this greenhouse's camera. The server files the picture, records when it was
taken and what the shade and lighting were doing at the time, and the dashboard
presents the collection day by day. The camera can be asked for an extra
picture, but only by leaving a note it will find the next time it checks —
because nothing can reach it directly. And whatever it sees, it cannot act on:
the camera observes, and a person decides.
