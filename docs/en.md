# Modern Forms

Brings **Modern Forms** and **WAC** smart ceiling fans (generations 1, 2 and 3)
into Gladys through their local HTTP API: no account, no cloud.

> Never tested with a real device: it was built from the WAC reference of the
> API and the aiomodernforms library (used by Home Assistant). Tell us on the
> forum how it goes with your fan. Not affiliated with WAC Lighting nor Modern
> Forms.

## What you get

One device per fan, named as in the Modern Forms app, with:

- **Fan speed (0 = off)**: 0 stops the fan, 1 to 6 starts it at that speed;
- **Direction**: forward (summer) or reverse (winter);
- **Breeze mode** (generation 3 fans): off or breeze;
- **Light** and **Brightness** (fans with a light kit): brightness 0 turns the
  light off, 1 to 100 % turns it on at that brightness.

None of them is a switch: "turn every switch on" never starts a fan. The light
is a light, so it follows "turn the lights off" like any other light.

Not handled: the sleep timers, the schedule, the away mode, the adaptive
learning, pairing, reboot and reset (use the app), and **generation 4** fans
(another API; the status says "no /mf API (HTTP 404)").

## Configuration

1. Set up the fan with the Modern Forms or WAC app, then give it a fixed
   address in your router (it shows as `MF_Fan_XXXXXX` or `WAC_Fan_XXXXXX`).
2. In **Addresses of the fans**, type the address of each fan, separated by
   commas (up to 8), with `:port` only if it is not 80.
3. Save, then add the fans from the **Discovery** tab.

The status says which fans were read, which address does not answer (and when
it is tried again), an address where the same fan was typed twice, a device
that answers without saying which fan it is, and the Offs not seen applied.

**Test the connection** reads each fan, or shows its last read if it was read
less than an interval ago (never faster than the interval).

## Which fan a device drives

A device is tied to its fan by the `clientId` the fan gives in every answer
(the MAC address of the fan), not by its address. If the fan moves to another
address, type the new one: the device follows it.

- A start, a speed, a direction, the breeze, the light on or a brightness:
  the fan is read first, and the command is written only if that read shows
  the fan of the device, at an address of the configuration.
- An Off goes to the address the fan was last read at (or kept in /data, or
  saved with the device, or the only address typed), even if nothing was read
  yet. It is **refused** only when:
  - the address of the fan is not known: never read, nothing kept, no address
    on the device and several addresses typed;
  - another fan answered last at that address. Until a read shows it, a fan
    swapped with another one at the same address is not seen: an Off sent
    then may stop the other fan (its answer says so, and nothing is kept);
  - a newer command on the same part (another Off) took its place before it
    left.

## The Offs (fan speed 0, light off, brightness 0)

An Off needs no option and goes first: it does not wait for a read, a command
in progress, a pause after failed reads, the configuration of Gladys (when the
address is known) nor the first read after a restart. It cancels the commands
of the same part still waiting, and cuts the request in flight to that fan.

If it cannot be sent at once (the fan does not answer), it is tried for 250 ms,
then **kept** (in /data, and in memory if /data cannot be written) and tried
again every 10 s, whatever the pause of the reads: it leaves within about 10 s
of the fan answering again (also after a 429 or 503 answer, or a send left
without answer). Once it was answered, a read that still shows the part on
sends it again, at most once per read interval and 3 times at most, counted
only when it really left: an Off that never left is never given up. Only the
reads judge an Off, each on its own part (the answer of the Off of the light
never sends the Off of the fan again). The status tells where each Off stands.

A kept Off ends when a newer command starting the same part has left (one the
fan refused does not count), when the device is deleted, or, after a read
showed it applied, when the part is read on twice in a row (started from the
remote or the app: the integration never stops it again). Never by the time.

## Reads and pauses

Each fan is polled every interval (10 s by default, 5 s at least), never sooner,
even after a restart or a reconnection (a command adds its own reads: the one
before it, and those 5 s and 20 s after). A fan that does not answer is tried
again after 10 s, 30 s, 1, 2 then 5 minutes (a minute at least when it asks to
wait); its commands are refused meanwhile, but not its Offs. A command is
confirmed by the state the fan answers (the commands of a scene on one fan go
together: one read, one write): "sent, without confirmation" when no
answer came, "does not show it yet" when the answer shows the old value; the
fan is then read again 5 s and 20 s later.

## Privacy

The information the fan gives also holds the e-mail of the app account: it is
never used, logged nor kept. /data keeps only the addresses, the ids of the
fans, the times of the reads, the pauses and the Offs to send.
