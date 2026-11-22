# Starts an agent's provider process in a Landlock jail on a Linux server (see
# src/backend/agent-jail.ts and docs/self-hosted-server.md#agent-jail). Main runs it as
#
#   python3 -I -S agent-jail.py [--read PATH]... [--write PATH]... [--device PATH]... -- COMMAND [ARG]...
#
# It restricts itself and then replaces itself with COMMAND, so the provider process and every
# program it starts (the shell, the MCP servers, the build tools) keep the jail. Nothing inside can
# take it away. A path that is not given is out of reach: a file cannot be read, written, listed or
# run there. `--read` paths can be read and run, `--write` paths can also be changed, and `--device`
# paths can be read, written and given terminal commands, but nothing can be made in them. Landlock
# also keeps the process from reading the memory, the environment or the open files of a process
# outside its jail (another agent's, main's or PID 1's in /proc) and from sending it a signal.
#
# Landlock needs no privilege, no namespace and no change to the container: Docker's own AppArmor
# profile refuses the mounts that bubblewrap needs. `--probe` prints the Landlock version of the
# kernel, or 0. A problem stops the start with exit code 125, so the provider never runs unjailed
# from here. Standard library only.
import ctypes
import os
import stat
import struct
import sys

CREATE_RULESET = 444
ADD_RULE = 445
RESTRICT_SELF = 446
RULE_PATH_BENEATH = 1
CREATE_RULESET_VERSION = 1
PR_SET_NO_NEW_PRIVS = 38

EXECUTE = 1 << 0
WRITE_FILE = 1 << 1
READ_FILE = 1 << 2
READ_DIR = 1 << 3
REFER = 1 << 13
TRUNCATE = 1 << 14
IOCTL_DEV = 1 << 15
SCOPE_SIGNAL = 1 << 1

# The file rights of each version: 1 has bits 0 to 12, 2 adds REFER, 3 TRUNCATE, 5 IOCTL_DEV.
FILE_ONLY = EXECUTE | WRITE_FILE | READ_FILE | TRUNCATE | IOCTL_DEV
FAILED = 125

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def fail(message):
    sys.stderr.write("openbot agent jail: %s\n" % message)
    sys.stderr.flush()
    os._exit(FAILED)


def abi():
    version = libc.syscall(CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(CREATE_RULESET_VERSION))
    return version if version > 0 else 0


def handled_rights(version):
    rights = (1 << 13) - 1
    if version >= 2:
        rights |= REFER
    if version >= 3:
        rights |= TRUNCATE
    if version >= 5:
        rights |= IOCTL_DEV
    return rights


def parse(argv):
    rules = []
    index = 0
    while index < len(argv):
        flag = argv[index]
        if flag == "--":
            return rules, argv[index + 1 :]
        if flag not in ("--read", "--write", "--device") or index + 1 >= len(argv):
            fail("unknown argument %r" % flag)
        rules.append((flag[2:], argv[index + 1]))
        index += 2
    fail("no command after --")


def rights_of(kind, handled):
    read = EXECUTE | READ_FILE | READ_DIR
    if kind == "read":
        return read
    if kind == "device":
        return (read | WRITE_FILE | TRUNCATE | IOCTL_DEV) & handled
    return handled


def main():
    if sys.argv[1:] == ["--probe"]:
        print(abi())
        return
    rules, command = parse(sys.argv[1:])
    if not command:
        fail("no command after --")
    version = abi()
    # Version 3 is the first that controls truncation, without which a file outside the jail could
    # still be emptied.
    if version < 3:
        fail("this kernel has no Landlock, or a version older than 3 (%d)" % version)
    handled = handled_rights(version)
    # Version 6 keeps signals inside the jail. Abstract UNIX sockets stay open: X11 clients reach
    # the agent display through one first and do not fall back to the socket file when refused.
    scoped = SCOPE_SIGNAL if version >= 6 else 0
    size = 24 if version >= 6 else 16 if version >= 4 else 8
    attr = ctypes.create_string_buffer(struct.pack("=QQQ", handled, 0, scoped)[:size], size)
    ruleset = libc.syscall(CREATE_RULESET, attr, ctypes.c_size_t(size), ctypes.c_uint32(0))
    if ruleset < 0:
        fail("cannot make a Landlock ruleset (errno %d)" % ctypes.get_errno())
    for kind, path in rules:
        try:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError:
            # A folder that went away since main planned the jail stays out of reach.
            continue
        allowed = rights_of(kind, handled)
        if not stat.S_ISDIR(os.fstat(fd).st_mode):
            allowed &= FILE_ONLY
        rule = ctypes.create_string_buffer(struct.pack("=Qi", allowed, fd), 12)
        result = libc.syscall(ADD_RULE, ctypes.c_int(ruleset), ctypes.c_int(RULE_PATH_BENEATH), rule, ctypes.c_uint32(0))
        error = ctypes.get_errno()
        os.close(fd)
        if result < 0:
            fail("cannot add %s (errno %d)" % (path, error))
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        fail("cannot set no_new_privs (errno %d)" % ctypes.get_errno())
    if libc.syscall(RESTRICT_SELF, ctypes.c_int(ruleset), ctypes.c_uint32(0)) < 0:
        fail("cannot enter the jail (errno %d)" % ctypes.get_errno())
    os.close(ruleset)
    try:
        os.execv(command[0], command)
    except OSError as error:
        fail("cannot start %s: %s" % (command[0], error.strerror))


main()
