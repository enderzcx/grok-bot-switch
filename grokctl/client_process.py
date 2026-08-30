"""Windows-only proof that the paired PID owns the exact loopback listener."""
from __future__ import annotations

from contextlib import contextmanager
import ntpath
import socket
import struct
import sys


class ReceiverError(RuntimeError):
    def __init__(self):
        super().__init__("receiver-unverified")


def _owns_tcp_table(raw: bytes, pid: int, port: int) -> bool:
    if len(raw) < 4:
        raise ReceiverError()
    count, = struct.unpack_from("<I", raw)
    if count > (len(raw) - 4) // 24:
        raise ReceiverError()
    owners = []
    for offset in range(4, 4 + count * 24, 24):
        state, address, encoded_port, _, _, owner = struct.unpack_from("<6I", raw, offset)
        if state == 2 and socket.ntohs(encoded_port & 0xffff) == port and address in (0x0100007f, 0):
            # An unexpected wildcard or second owner cannot prove this receiver.
            if address != 0x0100007f:
                return False
            owners.append(owner)
    return bool(owners) and all(owner == pid for owner in owners)


class _WindowsAPI:
    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        self.c, self.w = c, w
        kernel = c.WinDLL("kernel32", use_last_error=True)
        iphlp = c.WinDLL("iphlpapi", use_last_error=True)
        def api(dll, name, args, result):
            fn = getattr(dll, name)
            fn.argtypes, fn.restype = args, result
            return fn
        self.open = api(kernel, "OpenProcess", [w.DWORD, w.BOOL, w.DWORD], w.HANDLE)
        self.close = api(kernel, "CloseHandle", [w.HANDLE], w.BOOL)
        self.wait = api(kernel, "WaitForSingleObject", [w.HANDLE, w.DWORD], w.DWORD)
        self.query = api(kernel, "QueryFullProcessImageNameW", [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)], w.BOOL)
        self.table = api(iphlp, "GetExtendedTcpTable", [c.c_void_p, c.POINTER(w.DWORD), w.BOOL, w.DWORD, c.c_int, w.DWORD], w.DWORD)

    def image(self, handle):
        size = self.w.DWORD(32768)
        buffer = self.c.create_unicode_buffer(size.value)
        if not self.query(handle, 0, buffer, self.c.byref(size)):
            raise ReceiverError()
        return buffer.value

    def owns_listener(self, pid, port):
        size = self.w.DWORD()
        result = self.table(None, self.c.byref(size), False, 2, 3, 0)  # AF_INET, OWNER_PID_LISTENER
        for _ in range(3):
            if result != 122 or not 4 <= size.value <= 2 * 1024 * 1024:
                raise ReceiverError()
            buffer = self.c.create_string_buffer(size.value)
            result = self.table(buffer, self.c.byref(size), False, 2, 3, 0)
            if result == 0:
                return _owns_tcp_table(buffer.raw[:size.value], pid, port)
        raise ReceiverError()


class _Receiver:
    def __init__(self, api, handle, pid, executable, port):
        self.api, self.handle, self.pid, self.executable, self.port = api, handle, pid, executable, port

    def recheck(self):
        # Keeping the process handle open also pins its identity through preflight.
        if self.api.wait(self.handle, 0) != 0x102:  # WAIT_TIMEOUT: still alive
            raise ReceiverError()
        image = self.api.image(self.handle)
        if ntpath.normcase(ntpath.normpath(image)) != ntpath.normcase(ntpath.normpath(self.executable)):
            raise ReceiverError()
        if not self.api.owns_listener(self.pid, self.port):
            raise ReceiverError()


@contextmanager
def verified_receiver(pid: int, executable: str, port: int):
    """Hold a live process handle; never bypass proof on another platform."""
    if sys.platform != "win32" or type(pid) is not int or not 0 < pid <= 0xffffffff or type(port) is not int or not 1 <= port <= 65535:
        raise ReceiverError()
    if not isinstance(executable, str) or not ntpath.isabs(executable):
        raise ReceiverError()
    api, handle = None, None
    try:
        api = _WindowsAPI()
        handle = api.open(0x1000 | 0x100000, False, pid)  # QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        if not handle:
            raise ReceiverError()
        receiver = _Receiver(api, handle, pid, executable, port)
        receiver.recheck()
        yield receiver
    finally:
        if api is not None and handle:
            api.close(handle)
