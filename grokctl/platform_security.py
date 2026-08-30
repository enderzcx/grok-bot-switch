"""Private storage and nonblocking locks, using DACLs on Windows, modes on Unix."""

from __future__ import annotations

import os
import errno
import stat
from pathlib import Path

IS_WINDOWS = os.name == "nt"
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
BINARY = getattr(os, "O_BINARY", 0)


def reject_links(path: Path) -> None:
    # Windows junctions are not symlinks. Inspect every existing component,
    # without resolve(), which would erase the evidence of redirection.
    path = Path(os.path.abspath(path))
    targets = [*reversed(path.parents), path] if IS_WINDOWS else [path]
    for target in targets:
        try:
            info = target.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise OSError(errno.ELOOP, "unsafe symbolic link or reparse point")


def _windows_acl(path: Path, *, set_private: bool = False, fd: int | None = None) -> None:
    """Fail closed unless owner and every granting ACE belong to TokenUser.

    No shell/locale parsing, pywin32 dependency, or chmod-as-ACL approximation.
    Windows API allocations are freed even when validation fails.
    """
    import ctypes as c
    from ctypes import wintypes as w

    adv = c.WinDLL("advapi32", use_last_error=True)
    kernel = c.WinDLL("kernel32", use_last_error=True)
    ptr = c.c_void_p
    pp = c.POINTER(ptr)

    def api(dll, name, args, result=w.BOOL):
        fn = getattr(dll, name)
        fn.argtypes, fn.restype = args, result
        return fn

    close = api(kernel, "CloseHandle", [w.HANDLE])
    free = api(kernel, "LocalFree", [ptr], ptr)
    process = api(kernel, "GetCurrentProcess", [], w.HANDLE)
    token_open = api(adv, "OpenProcessToken", [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)])
    token_info = api(adv, "GetTokenInformation", [w.HANDLE, c.c_int, ptr, w.DWORD, c.POINTER(w.DWORD)])
    to_sid = api(adv, "ConvertSidToStringSidW", [ptr, c.POINTER(w.LPWSTR)])
    to_sd = api(adv, "ConvertStringSecurityDescriptorToSecurityDescriptorW", [w.LPCWSTR, w.DWORD, pp, ptr])
    get_dacl = api(adv, "GetSecurityDescriptorDacl", [ptr, c.POINTER(w.BOOL), pp, c.POINTER(w.BOOL)])
    named_get = api(adv, "GetNamedSecurityInfoW", [w.LPWSTR, c.c_int, w.DWORD, pp, pp, pp, pp, pp], w.DWORD)
    handle_get = api(adv, "GetSecurityInfo", [w.HANDLE, c.c_int, w.DWORD, pp, pp, pp, pp, pp], w.DWORD)
    named_set = api(adv, "SetNamedSecurityInfoW", [w.LPWSTR, c.c_int, w.DWORD, ptr, ptr, ptr, ptr], w.DWORD)
    equal = api(adv, "EqualSid", [ptr, ptr])
    ace_get = api(adv, "GetAce", [ptr, w.DWORD, pp])

    def check(ok):
        if not ok:
            raise OSError("Windows private ACL operation failed")

    token, sid_text, descriptor, actual = w.HANDLE(), w.LPWSTR(), ptr(), ptr()
    try:
        check(token_open(process(), 0x8, c.byref(token)))  # TOKEN_QUERY
        size = w.DWORD()
        token_info(token, 1, None, 0, c.byref(size))  # TokenUser
        check(size.value > 0)
        user = c.create_string_buffer(size.value)
        check(token_info(token, 1, user, size, c.byref(size)))
        sid = c.cast(user, pp).contents
        if set_private:
            check(to_sid(sid, c.byref(sid_text)))
            check(to_sd(f"D:P(A;OICI;FA;;;{sid_text.value})", 1, c.byref(descriptor), None))
            present, defaulted, dacl = w.BOOL(), w.BOOL(), ptr()
            check(get_dacl(descriptor, c.byref(present), c.byref(dacl), c.byref(defaulted)))
            check(present.value and dacl.value)
            # Protect from inherited grants; newly created children inherit only
            # this user's full-control ACE. Set owner explicitly for elevated users.
            check(named_set(str(path), 1, 0x80000005, sid, None, dacl, None) == 0)
        owner, dacl = ptr(), ptr()
        args = (1, 5, c.byref(owner), None, c.byref(dacl), None, c.byref(actual))
        if fd is None:
            check(named_get(str(path), *args) == 0)
        else:
            import msvcrt
            check(handle_get(msvcrt.get_osfhandle(fd), *args) == 0)
        check(owner.value and equal(owner, sid) and dacl.value)
        # ACL header: BYTE revision, BYTE reserved, WORD size, WORD AceCount.
        count = c.c_ushort.from_address(dacl.value + 4).value
        check(count > 0)
        for index in range(count):
            ace = ptr()
            check(ace_get(dacl, index, c.byref(ace)))
            # Accept only ordinary allow ACEs for the current user; reject
            # unknown/object/callback ACEs rather than guessing their effect.
            check(c.c_ubyte.from_address(ace.value).value == 0)
            check(not c.c_ubyte.from_address(ace.value + 1).value & 0x8)  # INHERIT_ONLY
            check(equal(ptr(ace.value + 8), sid))
    finally:
        if actual.value:
            free(actual)
        if descriptor.value:
            free(descriptor)
        if sid_text:
            free(c.cast(sid_text, ptr))
        if token.value:
            close(token)


def private_permissions(path: Path, info=None, *, fd: int | None = None) -> bool:
    if IS_WINDOWS:
        try:
            reject_links(path)
            _windows_acl(path, fd=fd)
        except OSError:
            return False
        return True
    info = info or (os.fstat(fd) if fd is not None else path.lstat())
    return not bool(info.st_mode & 0o077)


def set_private_permissions(path: Path, mode: int = 0o600, *, fd: int | None = None) -> None:
    if IS_WINDOWS:
        reject_links(path)
        _windows_acl(path, set_private=True, fd=fd)
    elif fd is not None:
        os.fchmod(fd, mode)
    else:
        os.chmod(path, mode)


def open_nofollow(path: Path, flags: int, mode: int = 0o600) -> int:
    reject_links(path)
    if not IS_WINDOWS:
        return os.open(str(path), flags | NOFOLLOW | BINARY, mode)
    import ctypes as c
    from ctypes import wintypes as w
    import msvcrt

    kernel = c.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.c_void_p, w.DWORD, w.DWORD, w.HANDLE]
    create.restype = w.HANDLE
    close = kernel.CloseHandle
    close.argtypes, close.restype = [w.HANDLE], w.BOOL
    inspect = kernel.GetFileInformationByHandle
    inspect.argtypes, inspect.restype = [w.HANDLE, c.c_void_p], w.BOOL
    access = 0xC0000000 if flags & os.O_RDWR else (0x40000000 if flags & os.O_WRONLY else 0x80000000)
    creation = (1 if flags & os.O_EXCL else 4) if flags & os.O_CREAT else 3
    # OPEN_REPARSE_POINT opens the link itself, never its destination.
    handle = create(str(path), access, 7, None, creation, 0x00200000, None)
    if handle == w.HANDLE(-1).value:
        error = c.get_last_error()
        if error in (80, 183):
            raise FileExistsError(errno.EEXIST, "file exists")
        raise OSError("Windows secure file open failed")
    try:
        info = c.create_string_buffer(64)
        if not inspect(handle, info) or c.c_uint32.from_buffer(info).value & 0x410:
            raise OSError("file is not a direct regular file")
        fd = msvcrt.open_osfhandle(handle, (flags & os.O_APPEND) | BINARY)
        handle = None  # the CRT now owns the handle
        return fd
    finally:
        if handle is not None:
            close(handle)


def lock_exclusive(fd: int) -> None:
    if IS_WINDOWS:
        import msvcrt
        os.lseek(fd, 0, os.SEEK_SET)
        # Windows permits locking a byte beyond EOF; no pre-lock write needed.
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def unlock(fd: int) -> None:
    if IS_WINDOWS:
        import msvcrt
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(fd, fcntl.LOCK_UN)
