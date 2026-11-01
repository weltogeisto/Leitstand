"""Trusted WSL supervisor. Workers see a new filesystem and PID namespace."""
import fcntl, json, os, pathlib, pwd, re, shutil, signal, subprocess, sys, threading, time

ROOT = pathlib.Path('/var/lib/leitstand-worker/jobs')
ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
ROOT.chmod(0o711)  # runuser must traverse to its mount source; listing stays private.
ACCOUNT = pwd.getpwnam('leitstand-worker')

def start_time(pid):
    try: return pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except FileNotFoundError: return None

def stop_job(job):
    (ROOT / (job + '.cancel')).touch(mode=0o600)
    lock = (ROOT / (job + '.lock')).open('a+')
    with lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = ROOT / (job + '.json')
        if record.exists():
            data = json.loads(record.read_text())
            if start_time(data['pid']) == data['start']:
                try: os.killpg(data['pid'], signal.SIGKILL)
                except ProcessLookupError: pass
                deadline = time.monotonic() + 5
                while start_time(data['pid']) == data['start'] and time.monotonic() < deadline:
                    # A zombie leader has no executing descendants after the PID namespace dies.
                    try: state = pathlib.Path(f"/proc/{data['pid']}/stat").read_text().rsplit(')', 1)[1].split()[0]
                    except FileNotFoundError: break
                    if state == 'Z': break
                    time.sleep(.05)
                else:
                    if start_time(data['pid']) == data['start']:
                        raise RuntimeError('Worker process did not terminate')
            record.unlink(missing_ok=True)
        # Windows may terminate the WSL bridge before the supervisor's finally
        # block runs. The explicit stop path also removes the private credentials.
        private = ROOT / (job + '.private')
        if private.exists():
            if not shutil.rmtree.avoids_symlink_attacks: raise RuntimeError('Safe cleanup unavailable')
            shutil.rmtree(private)

def checked_path(value, parent):
    path = pathlib.Path(value).resolve()
    if not path.is_relative_to(parent) or path == parent: raise ValueError('Path is outside the permitted workspace')
    return path

def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(path.parent, ACCOUNT.pw_uid, ACCOUNT.pw_gid)
    path.write_text(json.dumps(value))
    os.chmod(path, 0o600); os.chown(path, ACCOUNT.pw_uid, ACCOUNT.pw_gid)

def command(payload, home):
    cwd = checked_path(payload['cwd'], pathlib.Path('/mnt/c/AI/leitstand-worktrees'))
    common = checked_path(payload['git_common'], pathlib.Path('/mnt/c/AI/projects'))
    metadata = checked_path(payload['git_dir'], common / 'worktrees')
    if common.name != '.git': raise ValueError('Unexpected Git common directory')
    pointer = home.parent / 'git-pointer'
    pointer.write_text('gitdir: /git\n')
    common_pointer = home.parent / 'git-common-pointer'
    common_pointer.write_text('/git-common\n')
    for provider, credentials in payload.get('auth', {}).items():
        if provider == 'codex': write_private(home / '.codex/auth.json', credentials)
        elif provider == 'claude': write_private(home / '.claude/.credentials.json', credentials)
        else: raise ValueError('Unknown credential type')
    # No user MCP servers, hooks, plugins or arbitrary host configuration are copied.
    codex_settings = home / '.codex/config.toml'
    codex_settings.parent.mkdir(mode=0o700, exist_ok=True)
    os.chown(codex_settings.parent, ACCOUNT.pw_uid, ACCOUNT.pw_gid)
    settings = ['cli_auth_credentials_store = "file"']
    for name, value in payload.get('codex_settings', {}).items():
        if name in ('model', 'model_reasoning_effort', 'model_reasoning_summary', 'model_verbosity') and isinstance(value, str):
            settings.append(name + ' = ' + json.dumps(value))
    codex_settings.write_text('\n'.join(settings) + '\n')
    os.chown(codex_settings, ACCOUNT.pw_uid, ACCOUNT.pw_gid); codex_settings.chmod(0o600)
    write_private(home / '.claude/settings.json', {
        'permissions': {'deny': ['Read(//home/worker/.claude/.credentials.json)', 'Read(//home/worker/.codex/auth.json)']},
        'sandbox': {'enabled': True, 'failIfUnavailable': True, 'autoAllowBashIfSandboxed': True, 'allowUnsandboxedCommands': False,
                    'filesystem': {'denyRead': ['/home/worker/.claude/.credentials.json', '/home/worker/.codex/auth.json']}}
    })
    args = ['/usr/sbin/runuser', '-u', 'leitstand-worker', '--', '/usr/bin/bwrap',
            '--unshare-all', '--share-net', '--new-session', '--die-with-parent', '--cap-drop', 'ALL',
            '--clearenv', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
            '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
            '--ro-bind', '/opt/leitstand-node', '/opt/node', '--ro-bind', '/opt/leitstand-cli', '/opt/leitstand-cli',
            '--bind', str(home), '/home/worker', '--bind', str(cwd), '/workspace',
            '--ro-bind', str(common), '/git-common', '--ro-bind', str(metadata), '/git',
            '--ro-bind', str(pointer), '/workspace/.git', '--ro-bind', str(common_pointer), '/git/commondir',
            '--chdir', '/workspace']
    for path in ['/etc/ssl', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group']:
        if pathlib.Path(path).exists(): args += ['--ro-bind', path, path]
    env = {'HOME': '/home/worker', 'USER': 'leitstand-worker', 'LOGNAME': 'leitstand-worker',
           'PATH': '/opt/leitstand-cli/node_modules/.bin:/opt/node/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'TMPDIR': '/tmp', 'CODEX_HOME': '/home/worker/.codex', 'CLAUDE_CONFIG_DIR': '/home/worker/.claude',
           'GIT_DIR': '/git', 'GIT_COMMON_DIR': '/git-common', 'GIT_WORK_TREE': '/workspace',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_COUNT': '1',
           'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '/workspace'}
    for key, value in env.items(): args += ['--setenv', key, value]
    platform = payload['platform']
    binary = {'codex': '/opt/leitstand-cli/node_modules/.bin/codex',
              'claude-code': '/opt/leitstand-cli/node_modules/.bin/claude',
              'doctor': '/usr/bin/python3'}[platform]
    return args + ['--', binary, *payload['args']]

def main():
    action, job = sys.argv[1:3]
    if not re.fullmatch('[a-f0-9]{32}', job): raise ValueError('Invalid job identifier')
    if action == 'stop':
        stop_job(job); print(json.dumps({'stopped': True})); return 0
    if action != 'run': raise ValueError('Unknown action')
    line = sys.stdin.readline()
    if not line: return 125
    payload = json.loads(line)
    disconnected = threading.Event()
    def monitor():
        for _ in sys.stdin: pass
        disconnected.set()
    threading.Thread(target=monitor, daemon=True).start()
    proc = None
    private = ROOT / (job + '.private')
    created = False
    try:
        with (ROOT / (job + '.lock')).open('a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if disconnected.is_set() or (ROOT / (job + '.cancel')).exists(): return 125
            # Never let a worker-controlled symlink influence a privileged write.
            # This directory is new, inaccessible to other jobs, and never reused.
            private.mkdir(mode=0o700)
            created = True
            os.chown(private, ACCOUNT.pw_uid, ACCOUNT.pw_gid)
            home = private / 'home'
            home.mkdir(mode=0o700)
            os.chown(home, ACCOUNT.pw_uid, ACCOUNT.pw_gid)
            cmd = command(payload, home)
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, start_new_session=True)
            (ROOT / (job + '.json')).write_text(json.dumps({'pid': proc.pid, 'start': start_time(proc.pid)}))
        deadline = time.monotonic() + 3660
        while proc.poll() is None:
            if disconnected.wait(.1) or time.monotonic() >= deadline:
                stop_job(job); proc.wait(timeout=5); return 124
        return proc.returncode
    finally:
        if created or proc is not None:
            stop_job(job)
        if proc is not None and proc.poll() is None: proc.wait(timeout=5)

if __name__ == '__main__':
    raise SystemExit(main())
