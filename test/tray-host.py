#!/usr/bin/env python3
"""Test helper: a stand-in for a desktop's system tray, for a private D-Bus session.

  dbus-run-session -- sh -c 'python3 test/tray-host.py <log> <control file> & <start the app>'

Logs what the app's tray icon offers. Writing "activate", or the label of a menu entry,
to the control file then presses it the way a desktop would.
"""
import json
import os
import sys

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

WATCHER = '''<node><interface name="org.kde.StatusNotifierWatcher">
<method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
<method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
<property name="RegisteredStatusNotifierItems" type="as" access="read"/>
<property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
<property name="ProtocolVersion" type="i" access="read"/>
<signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
<signal name="StatusNotifierHostRegistered"/>
</interface></node>'''

log_path, control = sys.argv[1:3]
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
items = []
item = {}


def log(**entry):
    with open(log_path, 'a', encoding='utf8') as out:
        out.write(json.dumps(entry, ensure_ascii=False) + '\n')


def call(name, path, interface, method, args=None, reply=None):
    return bus.call_sync(name, path, interface, method, args, reply, Gio.DBusCallFlags.NONE, 5000, None).unpack()


def prop(name):
    return call(item['service'], item['path'], 'org.freedesktop.DBus.Properties', 'Get',
                GLib.Variant('(ss)', ('org.kde.StatusNotifierItem', name)))[0]


def menu_entries():
    layout = call(item['service'], item['menu'], 'com.canonical.dbusmenu', 'GetLayout',
                  GLib.Variant('(iias)', (0, -1, [])))[1]
    return [(child[0], child[1]) for child in layout[2]]


def inspect():
    item['menu'] = prop('Menu')
    theme, name = prop('IconThemePath'), prop('IconName')
    log(event='item', tooltip=prop('ToolTip')[2], status=prop('Status'),
        icon_file=os.path.isfile(os.path.join(theme, name + '.png')),
        menu=[entry.get('label', entry.get('type')) for _, entry in menu_entries()])
    return False


def register(_conn, sender, _path, _interface, method, params, invocation):
    if method == 'RegisterStatusNotifierItem':
        service = params.unpack()[0]
        item['service'] = service if not service.startswith('/') else sender
        item['path'] = service if service.startswith('/') else '/StatusNotifierItem'
        items.append(service)
        log(event='registered', service=service.split('-')[0])
        invocation.return_value(None)
        bus.emit_signal(None, '/StatusNotifierWatcher', 'org.kde.StatusNotifierWatcher',
                        'StatusNotifierItemRegistered', GLib.Variant('(s)', (service,)))
        GLib.timeout_add(800, inspect)
    else:
        invocation.return_value(None)


def get(_conn, _sender, _path, _interface, name):
    if name == 'RegisteredStatusNotifierItems':
        return GLib.Variant('as', items)
    if name == 'IsStatusNotifierHostRegistered':
        return GLib.Variant('b', True)
    return GLib.Variant('i', 0)


def poll():
    if not os.path.exists(control):
        return True
    with open(control, encoding='utf8') as source:
        command = source.read().strip()
    os.unlink(control)
    try:
        if command == 'activate':
            call(item['service'], item['path'], 'org.kde.StatusNotifierItem', 'Activate', GLib.Variant('(ii)', (0, 0)))
        else:
            target = next(i for i, entry in menu_entries() if entry.get('label') == command)
            call(item['service'], item['menu'], 'com.canonical.dbusmenu', 'Event',
                 GLib.Variant('(isvu)', (target, 'clicked', GLib.Variant('i', 0), 0)))
        log(event='pressed', what=command)
    except Exception as error:  # A failed press is a result the test wants to read.
        log(event='failed', what=command, error=str(error))
    return True


bus.register_object('/StatusNotifierWatcher', Gio.DBusNodeInfo.new_for_xml(WATCHER).interfaces[0], register, get, None)
call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
     GLib.Variant('(su)', ('org.kde.StatusNotifierWatcher', 0)))
log(event='host-ready')
GLib.timeout_add(300, poll)
GLib.MainLoop().run()
