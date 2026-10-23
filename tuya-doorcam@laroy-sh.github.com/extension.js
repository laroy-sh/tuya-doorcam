import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// `doorcam` helper from this repo (pipx install); GNOME Shell's PATH often lacks ~/.local/bin
const HELPER = GLib.find_program_in_path('doorcam') ??
    GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'doorcam']);
const POLL_SECONDS = 600;       // background refresh; each refresh costs 2 Tuya API calls
const MIN_REFRESH_SECONDS = 60; // opening the menu refreshes at most this often
const THUMB_WIDTH = 320;        // snapshots are 640x360
const THUMB_HEIGHT = 180;
const WATCH_RETRY_SECONDS = [30, 60, 300, 900]; // restart delays for `doorcam watch`
const WATCH_LOGIN_NEEDED = 2;                   // its exit code when the push login expired

function formatWhen(epoch) {
    if (!epoch)
        return 'none in the last 7 days';
    const then = GLib.DateTime.new_from_unix_local(epoch);
    const now = GLib.DateTime.new_now_local();
    const mins = Math.floor((now.to_unix() - epoch) / 60);
    let ago;
    if (mins < 1)
        ago = 'just now';
    else if (mins < 60)
        ago = `${mins} min ago`;
    else if (mins < 24 * 60)
        ago = `${Math.floor(mins / 60)} h ago`;
    else
        ago = `${Math.floor(mins / 1440)} d ago`;
    const sameDay = then.format('%F') === now.format('%F');
    return `${then.format(sameDay ? '%H:%M' : '%a %H:%M')} (${ago})`;
}

export default class DoorCamExtension extends Extension {
    enable() {
        this._button = new PanelMenu.Button(0.0, 'Door Camera');
        this._button.add_child(new St.Icon({
            icon_name: 'camera-web-symbolic',
            style_class: 'system-status-icon',
        }));

        const menu = this._button.menu;
        this._motionItem = new PopupMenu.PopupMenuItem('Last motion: …', {reactive: false});
        this._batteryItem = new PopupMenu.PopupMenuItem('Battery: …', {reactive: false});
        menu.addMenuItem(this._motionItem);
        menu.addMenuItem(this._batteryItem);

        // latest motion snapshot; click opens it full size in the default image viewer
        this._snapshotItem = new PopupMenu.PopupBaseMenuItem();
        this._snapshotImage = new St.Widget({width: THUMB_WIDTH, height: THUMB_HEIGHT});
        this._snapshotItem.add_child(this._snapshotImage);
        this._snapshotItem.connect('activate', () => this._openSnapshot());
        this._snapshotItem.hide();
        menu.addMenuItem(this._snapshotItem);

        // today's events; clicking one opens its snapshot (downloaded on first use)
        this._todayItem = new PopupMenu.PopupSubMenuMenuItem('Today: …');
        menu.addMenuItem(this._todayItem);

        // shown only when motion notifications (doorcam watch) are not working
        this._alertsItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._alertsItem.hide();
        menu.addMenuItem(this._alertsItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._liveItem = new PopupMenu.PopupImageMenuItem('Live view', 'media-playback-start-symbolic');
        this._liveItem.connect('activate', () => this._startLive());
        menu.addMenuItem(this._liveItem);

        const refreshItem = new PopupMenu.PopupImageMenuItem('Refresh', 'view-refresh-symbolic');
        refreshItem.connect('activate', () => this._refresh(true));
        menu.addMenuItem(refreshItem);

        this._menuOpenId = menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh(false);
        });

        Main.panel.addToStatusArea(this.uuid, this._button);

        this._lastRefresh = 0;
        this._status = null;
        this._refresh(true);
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh(true);
            return GLib.SOURCE_CONTINUE;
        });

        // stays enabled on the lock screen (session-modes) so alerts keep coming; hide the button there
        this._sessionId = Main.sessionMode.connect('updated', () => this._updateLocked());
        this._updateLocked();

        this._watchFailures = 0;
        this._startWatch();
    }

    disable() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = null;
        }
        this._stopWatch();
        this._notifySource?.destroy();
        this._notifySource = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._button?.destroy();
        this._button = null;
        this._motionItem = this._batteryItem = this._liveItem = null;
        this._snapshotItem = this._snapshotImage = this._todayItem = this._alertsItem = null;
    }

    _updateLocked() {
        const locked = Main.sessionMode.isLocked;
        if (locked)
            this._button.menu.close();
        this._button.visible = !locked;
    }

    // `doorcam watch` prints one JSON line per motion event pushed by the camera
    _startWatch() {
        this._watchRetryId = null;
        this._watchCancellable = new Gio.Cancellable();
        const cancellable = this._watchCancellable;
        const started = GLib.get_monotonic_time();
        let lastError = '';
        try {
            this._watchProc = Gio.Subprocess.new([HELPER, 'watch'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._watchEnded(-1, e.message, 0);
            return;
        }
        const proc = this._watchProc;
        this._readLines(proc.get_stdout_pipe(), cancellable, line => {
            try {
                this._onMotion(JSON.parse(line));
            } catch (e) {
                console.warn(`doorcam watch: ${e.message}`);
            }
        });
        this._readLines(proc.get_stderr_pipe(), cancellable, line => {
            lastError = line;
        });
        proc.wait_async(cancellable, (p, res) => {
            try {
                p.wait_finish(res);
            } catch {
                return; // cancelled by disable()
            }
            const status = p.get_if_exited() ? p.get_exit_status() : -1;
            this._watchEnded(status, lastError, (GLib.get_monotonic_time() - started) / 1e6);
        });
    }

    _readLines(pipe, cancellable, onLine) {
        const stream = new Gio.DataInputStream({base_stream: pipe, close_base_stream: true});
        const next = () => stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            let line;
            try {
                [line] = s.read_line_finish_utf8(res);
            } catch {
                return;
            }
            if (line === null)
                return; // EOF
            if (line.trim())
                onLine(line.trim());
            next();
        });
        next();
    }

    _watchEnded(status, error, ranSeconds) {
        this._watchProc = null;
        if (ranSeconds > 600)
            this._watchFailures = 0;
        let delay = WATCH_RETRY_SECONDS[Math.min(this._watchFailures++, WATCH_RETRY_SECONDS.length - 1)];
        if (status === WATCH_LOGIN_NEEDED) {
            // picks the new token up by itself once the user has run `doorcam login`
            this._alertsItem.label.text = 'Motion alerts off: run `doorcam login`';
            this._alertsItem.show();
            delay = WATCH_RETRY_SECONDS.at(-1);
        } else if (this._watchFailures > 1 && error) {
            this._alertsItem.label.text = `Motion alerts: ${error}`.slice(0, 80);
            this._alertsItem.show();
        }
        this._watchRetryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._startWatch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopWatch() {
        if (this._watchRetryId) {
            GLib.source_remove(this._watchRetryId);
            this._watchRetryId = null;
        }
        this._watchCancellable?.cancel();
        this._watchCancellable = null;
        this._watchProc?.force_exit();
        this._watchProc = null;
    }

    _onMotion(event) {
        this._watchFailures = 0;
        this._alertsItem.hide();
        if (!this._notifySource) {
            this._notifySource = new MessageTray.Source({
                title: 'Door camera',
                iconName: 'camera-web-symbolic',
            });
            this._notifySource.connect('destroy', () => {
                this._notifySource = null;
            });
            Main.messageTray.add(this._notifySource);
        }
        const when = GLib.DateTime.new_from_unix_local(event.time).format('%H:%M:%S');
        const notification = new MessageTray.Notification({
            source: this._notifySource,
            title: event.kind === 'person' ? 'Person at the door' : 'Motion at the door',
            body: event.snapshot ? `${when} – click to open the snapshot` : when,
            gicon: event.snapshot ? Gio.FileIcon.new(Gio.File.new_for_path(event.snapshot)) : null,
            // GNOME only queues normal banners while a window is fullscreen or Do Not Disturb is
            // on; "feedback" ones still pop up (and auto-hide as usual)
            forFeedback: true,
        });
        if (event.snapshot)
            notification.connect('activated', () => this._openFile(event.snapshot));
        this._notifySource.addNotification(notification);
        this._refresh(true);
    }

    _refresh(force) {
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._cancellable || (!force && now - this._lastRefresh < MIN_REFRESH_SECONDS)) {
            this._render();
            return;
        }
        this._lastRefresh = now;
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        const proc = Gio.Subprocess.new([HELPER, 'status'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            if (cancellable.is_cancelled())
                return;
            this._cancellable = null;
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                this._status = stdout?.trim() ? JSON.parse(stdout) : {error: stderr?.trim() || 'no output'};
            } catch (e) {
                this._status = {error: e.message};
            }
            this._render();
        });
    }

    _render() {
        if (!this._button || !this._status)
            return;
        const s = this._status;
        if (s.error) {
            this._motionItem.label.text = `Error: ${s.error}`.slice(0, 80);
            this._batteryItem.label.text = 'Battery: ?';
            this._snapshotItem.hide();
            this._todayItem.hide();
            return;
        }
        this._motionItem.label.text = `Last motion: ${formatWhen(s.last_motion)}`;
        const online = s.online ? '' : ' (offline)';
        this._batteryItem.label.text = `Battery: ${s.battery ?? '?'}%${online}`;

        // the file name changes with every new event, so St's texture cache never shows a stale image
        if (s.snapshot) {
            this._snapshotImage.style = `background-image: url("file://${s.snapshot}");` +
                ' background-size: contain; border-radius: 6px;';
            this._snapshotItem.show();
        } else {
            this._snapshotItem.hide();
        }
        this._renderToday(s.today ?? []);
    }

    _renderToday(events) {
        const n = events.length;
        this._todayItem.label.text = `Today: ${n === 0 ? 'no' : n} event${n === 1 ? '' : 's'}`;
        this._todayItem.show();
        const sub = this._todayItem.menu;
        sub.removeAll();
        for (const e of events) {
            const when = GLib.DateTime.new_from_unix_local(e.time).format('%H:%M');
            const item = new PopupMenu.PopupImageMenuItem(`${when}  ${e.kind}`,
                e.has_snapshot ? 'image-x-generic-symbolic' : 'action-unavailable-symbolic');
            if (e.has_snapshot)
                item.connect('activate', () => this._openEventSnapshot(e.id));
            else
                item.setSensitive(false);
            sub.addMenuItem(item);
        }
    }

    _openEventSnapshot(id) {
        try {
            const proc = Gio.Subprocess.new([HELPER, 'snapshot', String(id)],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    if (!p.get_successful())
                        throw new Error(stderr?.trim().split('\n').pop() || 'no snapshot');
                    this._openFile(stdout.trim());
                } catch (e) {
                    Main.notify('Door camera', `Cannot open snapshot: ${e.message}`);
                }
            });
        } catch (e) {
            Main.notify('Door camera', `Cannot open snapshot: ${e.message}`);
        }
    }

    _openSnapshot() {
        if (this._status?.snapshot)
            this._openFile(this._status.snapshot);
    }

    _openFile(path) {
        try {
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(path).get_uri(), null);
        } catch (e) {
            Main.notify('Door camera', `Cannot open snapshot: ${e.message}`);
        }
    }

    _startLive() {
        try {
            const proc = Gio.Subprocess.new([HELPER, 'live'], Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                const [, , stderr] = p.communicate_utf8_finish(res);
                if (!p.get_successful() && stderr?.trim())
                    Main.notify('Door camera', stderr.trim().split('\n').pop());
            });
            Main.notify('Door camera', 'Waking camera, live view opens in a few seconds…');
        } catch (e) {
            Main.notify('Door camera', `Live view failed: ${e.message}`);
        }
    }
}
