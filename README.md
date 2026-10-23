# Tuya Door Camera for GNOME

A GNOME Shell panel indicator for Tuya / Smart Life **battery door cameras** (peephole / "cateye" viewers):

- **Last motion** time ("01:05 (35 min ago)")
- **Battery** level and online state
- **Latest motion snapshot** as a thumbnail (click to open it full size)
- **Today's events** (time and type) – click one to open its snapshot
- **Live view** button – wakes the camera and opens the stream in `ffplay`

It talks to the Tuya cloud through your own (free) Tuya IoT developer project via a small Python helper, `doorcam`.

Tested with a generic Tuya peephole camera (category `sp`, product name `cateye`) on GNOME Shell 46 / Ubuntu.

## Requirements

- GNOME Shell 46
- Python ≥ 3.10, [pipx](https://pipx.pypa.io/)
- `ffplay` (from the `ffmpeg` package)
- A Tuya IoT developer account linked to your Smart Life / Tuya Smart app

## 1. Tuya developer project

1. Sign up at [iot.tuya.com](https://iot.tuya.com) and create a **Cloud → Development** project
   in the data center of your app account (e.g. *Central Europe* for EU accounts).
2. **Devices → Link App Account → Add App Account**, scan the QR code with the app
   (Me → scan icon). Check that your camera appears under *All Devices*.
3. **Service API**: make sure these are authorized for the project (free trials):
   *IoT Core*, *Authorization Token Management*, *IoT Video Live Stream*.
4. Note the **Access ID** and **Access Secret** from the project *Overview*,
   and the camera's **Device ID** from the device list.

The IoT Core trial runs for one month; extend it (free, up to 6 months at a time) under
**Cloud → Cloud Services → IoT Core** before it expires.

## 2. Helper

```sh
git clone https://github.com/laroy-sh/tuya-doorcam.git
cd tuya-doorcam
pipx install .

mkdir -p ~/.config/tuya-doorcam
cp config.example.json ~/.config/tuya-doorcam/config.json
chmod 600 ~/.config/tuya-doorcam/config.json
$EDITOR ~/.config/tuya-doorcam/config.json   # api_key, api_secret, region (eu/us/cn/in), device_id

doorcam status    # {"name": ..., "online": true, "battery": 82, "last_motion": 1792710300}
doorcam live      # opens the live stream
```

## 3. Extension

```sh
ln -s "$PWD/tuya-doorcam@laroy-sh.github.com" ~/.local/share/gnome-shell/extensions/
# log out and back in (Wayland), then:
gnome-extensions enable tuya-doorcam@laroy-sh.github.com
```

## Notes

- **Battery:** every live view wakes the camera; close the window to let it sleep again.
  Status checks don't wake it.
- **API usage:** the extension refreshes every 10 minutes and when the menu is opened
  (at most once a minute), 2 calls each – roughly 3,000 calls a month – plus one call per new
  motion event to fetch its snapshot, and two per event you open from *Today* (pictures are cached in
  `~/.cache/tuya-doorcam` for 7 days, so reopening one is free).
- **mpv:** the snap build of mpv fails with `401 Unauthorized` on Tuya's `rtsps://` URLs, so `ffplay` is used.
- **Motion snapshots:** the menu thumbnail and `doorcam snapshots [dir]` (downloads and decrypts the
  camera's cloud snapshots from the last ~7 days) need `GET /v1.0/devices/{id}/movement-configs`, which Tuya
  currently only enables on request – if you get `28841106 ... API is not subscribed`,
  [open a ticket](https://support.tuya.com/en/help/_detail/Kbfus79b0gcpi) asking for it.
  Without it the menu simply shows no thumbnail.
- Snapshots shown in the app are cloud copies kept for about a week; recordings on the
  camera's SD card are only reachable through the app's playback screen.

## License

MIT
